/**
 * The two-phase barrier protocol itself, and the process hygiene around it.
 *
 * Ported from interlock `tests/fault_injection/test_protocol.py` at `65f36c5`.
 *
 * Design sections 3 and 8.2. These are the portable-lane tests: no case matrix,
 * no component behaviour, just the machinery the whole harness rests on. They
 * run on every OS because a barrier that only works on Linux is a harness that
 * only works on Linux.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { skipIf } from "../testkit/marks.js";
import { syntheticCase } from "./conformance.js";
import * as contract from "./contract.js";
import {
  ArmedAnchor,
  ContractViolation,
  type FaultCase,
  Handshake,
  PROTOCOL_VERSION,
} from "./contract.js";
import { BarrierTimeout, Controller, epochRegressions } from "./controller.js";
import {
  installSuiteBudget,
  manifest,
  profile,
  RUNNER_BUDGET_CEILING_S,
  scaledBudgetS,
} from "./policy.js";
import { SPIKE_ADAPTER } from "./spike_driver.js";

const BUDGET_PROFILE = profile(manifest());

const POSIX = process.platform !== "win32";

// The suite budget (design 9). Installed per file rather than per package --
// see `installSuiteBudget` for why, and for what that narrowing does and does
// not catch.
installSuiteBudget(BUDGET_PROFILE);

/** `SIGKILL`'s number, which a killed process reports as a negative status. */
const SIGKILL_NUMBER = 9;

function makeController(
  root: string,
  faultCase: FaultCase,
  options: { barrierTimeoutS?: number; caseTimeoutS?: number } = {},
): Controller {
  return new Controller({
    workdir: root,
    adapter: SPIKE_ADAPTER,
    case: faultCase,
    suiteSeed: 1,
    // The source's own constants, scaled for this port's runners (D-0602). The
    // 60s in particular is exactly Vitest's `testTimeout`, so unscaled it would
    // lose the race the harness must win -- the same defect the gate found in
    // `conformance.ts`, in a second file.
    barrierTimeoutS: options.barrierTimeoutS ?? scaledBudgetS(15.0),
    caseTimeoutS: options.caseTimeoutS ?? RUNNER_BUDGET_CEILING_S,
  });
}

// ---------------------------------------------------------------------------
// arming vocabulary
// ---------------------------------------------------------------------------

describe("the arming vocabulary", () => {
  test("an armed anchor round trips through its wire form", () => {
    // Operation, anchor and occurrence survive the CLI, because all three
    // matter. A loop passes the same point repeatedly, so the occurrence index
    // is part of the arming rather than an afterthought (design 3.1).
    const anchor = new ArmedAnchor({
      anchor: contract.CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
      occurrence: 3,
      operation: contract.OPERATION_ATTEMPT,
    });
    expect(anchor.wire()).toBe("attempt@after_effect_before_record:3");
    // The source compares dataclass instances, which is a value comparison; the
    // port keeps that with an explicit `equals` rather than letting two distinct
    // objects satisfy an identity check.
    expect(ArmedAnchor.parse(anchor.wire()).equals(anchor)).toBe(true);
    expect(
      ArmedAnchor.parse("lease-acquired").equals(
        new ArmedAnchor({ anchor: contract.SYNC_LEASE_ACQUIRED }),
      ),
    ).toBe(true);
  });

  test("an anchor outside the contract is refused", () => {
    expectRefusal(
      () => new ArmedAnchor({ anchor: "somewhere_near_the_write" }),
      ContractViolation,
      "not an armable anchor",
    );
    expectRefusal(
      () => new ArmedAnchor({ anchor: contract.SYNC_LEASE_ACQUIRED, occurrence: 0 }),
      ContractViolation,
      "1-based",
    );
  });

  test("target-only -- a malformed occurrence index is refused at parse, not at a timeout", () => {
    // TARGET-ONLY. The source needs no counterpart: its `int(occurrence)` raises
    // on anything that is not a whole number, so the property is free there.
    //
    // `Number.parseInt` has neither half of it. It accepts a PREFIX, so
    // "...:2junk" silently becomes occurrence 2 -- arming a different pass
    // through the loop than the case declared. And it returns `NaN` for
    // "...:abc", which slips straight through an `occurrence < 1` guard because
    // every comparison with `NaN` is false; the anchor then matches no
    // occurrence at all, the barrier is never reached, and the case dies as a CI
    // TIMEOUT.
    //
    // That last outcome is exactly what design section 3.1 exists to prevent --
    // "a barrier that cannot be reached is a manifest error, not a CI timeout"
    // -- so a parse that can produce it has lost the property the eager parse is
    // for. Pinned because both failures are silent at the call site.
    //
    // Raised by the review gate on this change.
    const wire = `${contract.OPERATION_ATTEMPT}@${contract.CHECKPOINT_BEFORE_DURABLE_WRITE}`;
    for (const bad of ["2junk", "abc", " 2", "2.0", "-1", "0x2", "1e3"]) {
      expectRefusal(() => ArmedAnchor.parse(`${wire}:${bad}`), ContractViolation, "occurrence");
    }
    // A well-formed one still round trips, so the guard did not close the door.
    expect(ArmedAnchor.parse(`${wire}:3`).occurrence).toBe(3);
    // And an EMPTY suffix is not malformed -- it is the source's documented
    // default. `int(occurrence) if occurrence else 1` treats a bare anchor and a
    // trailing colon alike, and `ArmedAnchor.parse("lease-acquired")` relies on
    // it. Pinned alongside the refusals so a stricter guard cannot quietly take
    // it away.
    expect(ArmedAnchor.parse(`${wire}:`).occurrence).toBe(1);
    expect(ArmedAnchor.parse(contract.SYNC_LEASE_ACQUIRED).occurrence).toBe(1);
  });

  test("the handshake refuses a version mismatch", () => {
    // Controller and driver refuse a mismatch rather than guessing (design 6.2).
    const good = new Handshake({
      protocolVersion: PROTOCOL_VERSION,
      contractVersion: contract.FAULT_RUNNER_CONTRACT_VERSION,
      role: contract.ROLE_DISPATCHER,
      caseId: "c",
      restartGeneration: 0,
    });
    good.check();
    expectRefusal(
      () =>
        new Handshake({
          protocolVersion: PROTOCOL_VERSION + 1,
          contractVersion: contract.FAULT_RUNNER_CONTRACT_VERSION,
          role: contract.ROLE_DISPATCHER,
          caseId: "c",
          restartGeneration: 0,
        }).check(),
      ContractViolation,
      "protocol",
    );
    expectRefusal(
      () =>
        new Handshake({
          protocolVersion: PROTOCOL_VERSION,
          contractVersion: contract.FAULT_RUNNER_CONTRACT_VERSION + 1,
          role: contract.ROLE_DISPATCHER,
          caseId: "c",
          restartGeneration: 0,
        }).check(),
      ContractViolation,
      "fault-runner contract",
    );
  });

  test("the handshake refuses a driver that is not the one that was spawned", () => {
    // Valid-but-different is the dangerous answer, not invalid.
    //
    // Every event after the handshake is correlated by the process slot, not by
    // what the driver says it is. A driver answering as another role, another
    // case or generation 0 when a restart was asked for would therefore be
    // driven as the requested one and reported as the requested one -- a
    // recovery that never happened, passing.
    const good = new Handshake({
      protocolVersion: PROTOCOL_VERSION,
      contractVersion: contract.FAULT_RUNNER_CONTRACT_VERSION,
      role: contract.ROLE_DISPATCHER,
      caseId: "c",
      restartGeneration: 1,
    });
    good.check({
      expectRole: contract.ROLE_DISPATCHER,
      expectCaseId: "c",
      expectGeneration: 1,
    });
    expectRefusal(
      () => good.check({ expectRole: contract.ROLE_SECRETARY }),
      ContractViolation,
      "spawned as",
    );
    expectRefusal(() => good.check({ expectCaseId: "other" }), ContractViolation, "spawned for");
    expectRefusal(
      () => good.check({ expectGeneration: 0 }),
      ContractViolation,
      "recovery that never happened",
    );
  });
});

// ---------------------------------------------------------------------------
// the barrier
// ---------------------------------------------------------------------------

describe("the harness's own budgets", () => {
  test("target-only -- no controller is given a budget the runner would win", () => {
    // TARGET-ONLY, and structural rather than behavioural, because CI found the
    // same defect TWICE in two different files and I fixed it once each time
    // instead of closing the class. This is the guard that makes a third
    // instance a red test here rather than a red cell on a Windows runner
    // twenty minutes later.
    //
    // The rule is D-0602's: the harness's own watchdog must fire before the
    // runner's, because the two failures are not equivalent. A `CaseTimeout`
    // names the case, carries the `S9-REPRO` line and runs the teardown ladder;
    // Vitest's says a test took too long and cuts off the `finally` that would
    // have reaped the role processes.
    //
    // So no `caseTimeoutS:` anywhere in the belt may be a literal at or above
    // the ceiling. A scaled expression is fine -- `scaledBudgetS` already caps
    // itself -- and this only refuses a hard-coded number that would lose the
    // race.
    const root = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const file of readdirSync(root)
      .filter((name) => name.endsWith(".ts"))
      .sort()) {
      const source = readFileSync(join(root, file), "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        const match = /caseTimeoutS:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line);
        if (match !== null && Number(match[1]) >= RUNNER_BUDGET_CEILING_S) {
          offenders.push(`${file}:${index + 1} -> ${match[1]}s`);
        }
      }
    }
    expect(
      offenders,
      `a controller is given a hard-coded case budget at or above the runner ceiling ` +
        `(${RUNNER_BUDGET_CEILING_S}s): ${JSON.stringify(offenders)}. Vitest's testTimeout would ` +
        "fire first and the failure would name a slow test instead of a wedged case (D-0602)",
    ).toEqual([]);
  });
});

describe("the barrier", () => {
  test("an unarmed checkpoint costs no round trip", async () => {
    // A case perturbs the timing of nothing it is not about (design 3.1).
    // Determinism comes from the barrier, not from timing -- so the windows a
    // case does not name must be free, and the way to see that is that a run
    // with nothing armed emits no checkpoint event at all while still doing the
    // work.
    const faultCase = syntheticCase({
      caseId: "protocol-unarmed",
      role: contract.ROLE_DISPATCHER,
      arms: {},
    });
    const controller = makeController(caseRoot("fi-protocol-unarmed"), faultCase);
    let trace: readonly Record<string, unknown>[];
    try {
      controller.bootstrap();
      await controller.spawn(contract.ROLE_DISPATCHER, { armed: [] });
      await controller.runToCompletion(contract.ROLE_DISPATCHER);
      trace = controller.traces()[contract.ROLE_DISPATCHER] ?? [];
    } finally {
      await controller.teardown();
    }

    const kinds = trace.map((event) => event["event"]);
    expect(kinds).not.toContain(contract.EVENT_CHECKPOINT);
    expect(kinds).not.toContain(contract.EVENT_SYNC);
    expect(kinds).toContain(contract.EVENT_DONE);
    expect(trace.some((event) => event["operation"] === contract.OPERATION_ATTEMPT)).toBe(true);
  });

  test("an armed checkpoint holds the process until it is released", async () => {
    // The hook writes one line and blocks reading one. It never raises.
    //
    // A `checkpoint` callable designed to raise would be fine for a unit test
    // and disqualifying here: an exception unwinds the stack, runs `finally`
    // clauses and closes the SQLite connection in an orderly way. None of that
    // happens in a crash.
    const wire = `${contract.OPERATION_ATTEMPT}@${contract.CHECKPOINT_BEFORE_DURABLE_WRITE}:1`;
    const faultCase = syntheticCase({
      caseId: "protocol-armed",
      role: contract.ROLE_DISPATCHER,
      arms: { [contract.ROLE_DISPATCHER]: [wire] },
    });
    const controller = makeController(caseRoot("fi-protocol-armed"), faultCase);
    try {
      controller.bootstrap();
      const roleProcess = await controller.spawn(contract.ROLE_DISPATCHER, {
        armed: [ArmedAnchor.parse(wire)],
      });
      const event = await controller.waitAtAnchor(contract.ROLE_DISPATCHER);
      expect(event["name"]).toBe(contract.CHECKPOINT_BEFORE_DURABLE_WRITE);
      expect(event["occurrence"]).toBe(1);

      // Still alive, and still inside the window, a moment later.
      await delay(200);
      expect(roleProcess.exited).toBe(false);

      controller.release(contract.ROLE_DISPATCHER);
      await controller.runToCompletion(contract.ROLE_DISPATCHER);
    } finally {
      await controller.teardown();
    }
  });

  test("the occurrence index selects which pass through the loop", async () => {
    // The second delivery, not the first: a loop needs the index to be exact.
    const wire = `${contract.OPERATION_ATTEMPT}@${contract.CHECKPOINT_BEFORE_DURABLE_WRITE}:2`;
    const faultCase = syntheticCase({
      caseId: "protocol-occurrence",
      role: contract.ROLE_DISPATCHER,
      arms: { [contract.ROLE_DISPATCHER]: [wire] },
      messages: 2,
    });
    const controller = makeController(caseRoot("fi-protocol-occurrence"), faultCase);
    try {
      controller.bootstrap();
      await controller.spawn(contract.ROLE_DISPATCHER, { armed: [ArmedAnchor.parse(wire)] });
      const event = await controller.waitAtAnchor(contract.ROLE_DISPATCHER);
      expect(event["occurrence"]).toBe(2);
      // The first message is already delivered when the second stops.
      const earlier = (controller.traces()[contract.ROLE_DISPATCHER] ?? []).filter(
        (item) =>
          item["event"] === contract.EVENT_STEP && item["operation"] === contract.OPERATION_ATTEMPT,
      );
      expect(earlier.length).toBe(1);
      controller.release(contract.ROLE_DISPATCHER);
      await controller.runToCompletion(contract.ROLE_DISPATCHER);
    } finally {
      await controller.teardown();
    }
  });

  test("a barrier that is never reached becomes an attributable failure", async () => {
    // A CI hang is converted into a named failure, never a wedged job
    // (design 8.2).
    const wire = `${contract.OPERATION_ATTEMPT}@${contract.CHECKPOINT_BEFORE_DURABLE_WRITE}:9`;
    const faultCase = syntheticCase({
      caseId: "protocol-timeout",
      role: contract.ROLE_DISPATCHER,
      arms: { [contract.ROLE_DISPATCHER]: [wire] },
    });
    const controller = makeController(caseRoot("fi-protocol-timeout"), faultCase, {
      // The barrier budget is the SUBJECT of this case and stays small: it is a
      // wait for an event that never arrives, so no machine is too slow for it.
      barrierTimeoutS: 2.0,
      // The case budget is only a bound against a wedge, and at 10s it was
      // preempting the very timeout under test -- on a slow Windows runner
      // `bootstrap()` alone spent it, and CI reported `CaseTimeout` where the
      // case asserts `BarrierTimeout`. Held at the runner ceiling so the
      // subject fires first on any machine.
      caseTimeoutS: RUNNER_BUDGET_CEILING_S,
    });
    try {
      controller.bootstrap();
      await controller.spawn(contract.ROLE_DISPATCHER, { armed: [ArmedAnchor.parse(wire)] });
      await expect(controller.waitAtAnchor(contract.ROLE_DISPATCHER)).rejects.toBeInstanceOf(
        BarrierTimeout,
      );
    } finally {
      await controller.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// process hygiene -- design 8.2
// ---------------------------------------------------------------------------

/**
 * The process group id of `pid`, as the OS reports it.
 *
 * `os.getpgid` has no Node equivalent, so the answer is read from the OS the way
 * each platform exposes it: `/proc/<pid>/stat` field 5 on Linux, and `ps` on the
 * other POSIX hosts. Reading it out of process is the point -- the source is
 * asserting what the kernel believes, not what the harness recorded.
 */
function processGroupId(pid: number): number {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command field may contain spaces and parentheses, so the fields after
    // it are counted from the last ')'.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number.parseInt(after[2] as string, 10);
  }
  const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  return Number.parseInt(out.trim(), 10);
}

describe("process hygiene", () => {
  skipIf(!POSIX, "POSIX sessions and process groups")(
    "every role process gets its own session and group",
    async () => {
      // So a stray shell cannot be confused with it and the group signals as a
      // unit.
      const faultCase = syntheticCase({
        caseId: "protocol-session",
        role: contract.ROLE_DISPATCHER,
        arms: {},
      });
      const controller = makeController(caseRoot("fi-protocol-session"), faultCase);
      try {
        controller.bootstrap();
        const roleProcess = await controller.spawn(contract.ROLE_DISPATCHER, { armed: [] });
        expect(processGroupId(roleProcess.pid)).toBe(roleProcess.pid);
        expect(roleProcess.pgid).toBe(roleProcess.pid);
        await controller.runToCompletion(contract.ROLE_DISPATCHER);
      } finally {
        await controller.teardown();
      }
    },
  );

  test("teardown runs on the unhappy path and leaves nothing behind", async () => {
    // Unconditional, layered, and reaps last: pass, fail and error alike.
    //
    // The source wraps the controller in a `with` and asserts the exception
    // escapes while teardown still ran. TypeScript has no context manager, so
    // the same two facts are asserted directly: the error propagates out of the
    // `try`, and the `finally` that ran teardown left the process reaped.
    const wire = `${contract.OPERATION_ATTEMPT}@${contract.CHECKPOINT_BEFORE_DURABLE_WRITE}:1`;
    const faultCase = syntheticCase({
      caseId: "protocol-teardown",
      role: contract.ROLE_DISPATCHER,
      arms: { [contract.ROLE_DISPATCHER]: [wire] },
    });
    const controller = makeController(caseRoot("fi-protocol-teardown"), faultCase);
    let roleProcess: Awaited<ReturnType<Controller["spawn"]>> | undefined;
    let raised: unknown;
    try {
      controller.bootstrap();
      roleProcess = await controller.spawn(contract.ROLE_DISPATCHER, {
        armed: [ArmedAnchor.parse(wire)],
      });
      await controller.waitAtAnchor(contract.ROLE_DISPATCHER);
      throw new Error("the case blew up while a role was at a barrier");
    } catch (error) {
      raised = error;
    } finally {
      await controller.teardown();
    }

    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toContain("blew up while a role was at a barrier");
    expect(roleProcess?.reaped).toBe(true);
    expect(roleProcess?.exited).toBe(true);
  });

  skipIf(!POSIX, "SIGKILL exit status is POSIX-only")(
    "a kill is a signal and the exit status says so",
    async () => {
      // A role process that exited any other way fails the case as a harness
      // error.
      const wire = `${contract.OPERATION_ATTEMPT}@${contract.CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT}:1`;
      const faultCase = syntheticCase({
        caseId: "protocol-kill",
        role: contract.ROLE_DISPATCHER,
        arms: { [contract.ROLE_DISPATCHER]: [wire] },
      });
      const controller = makeController(caseRoot("fi-protocol-kill"), faultCase);
      let status: number | null;
      try {
        controller.bootstrap();
        await controller.spawn(contract.ROLE_DISPATCHER, { armed: [ArmedAnchor.parse(wire)] });
        await controller.waitAtAnchor(contract.ROLE_DISPATCHER);
        status = await controller.kill(contract.ROLE_DISPATCHER, { assertExitStatus: true });
      } finally {
        await controller.teardown();
      }
      expect(status).toBe(-SIGKILL_NUMBER);
    },
  );

  skipIf(!POSIX, "SIGKILL exit status is POSIX-only")(
    "a process that was not killed fails the case as a harness error",
    async () => {
      // The exit-status check has to be able to fire, or it is decoration.
      //
      // This is the check that stands between "the case injected a crash" and
      // "the case ran a process that finished normally and reported PASS". It is
      // asserted here against a process that really did exit 0, because a check
      // nobody has ever seen fail is indistinguishable from one that cannot.
      const faultCase = syntheticCase({
        caseId: "protocol-not-killed",
        role: contract.ROLE_DISPATCHER,
        arms: {},
      });
      const controller = makeController(caseRoot("fi-protocol-not-killed"), faultCase);
      try {
        controller.bootstrap();
        await controller.spawn(contract.ROLE_DISPATCHER, { armed: [] });
        await controller.runToCompletion(contract.ROLE_DISPATCHER);
        await expect(
          controller.kill(contract.ROLE_DISPATCHER, { assertExitStatus: true }),
        ).rejects.toThrow(/not -SIGKILL/);
      } finally {
        await controller.teardown();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// the linear-history reader
// ---------------------------------------------------------------------------

describe("the linear-history reader", () => {
  test("the epoch regression reader ignores refusals and reads insertion order", () => {
    // A refusal is evidence the fence held, not evidence that it did not.
    const history = [
      { status: "applied", writer_epoch: 1 },
      { status: "refused", writer_epoch: 1 },
      { status: "applied", writer_epoch: 2 },
    ];
    expect(epochRegressions(history)).toEqual([]);

    const interleaved = [
      { status: "applied", writer_epoch: 2 },
      { status: "applied", writer_epoch: 1 },
    ];
    expect(epochRegressions(interleaved).length).toBe(1);
  });
});
