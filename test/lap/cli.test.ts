/**
 * The lap, end to end, driven by CLI verbs and nothing else.
 *
 * **This file is step 8's acceptance criterion, stated as a test.** The step's
 * own wording is "a lap can be driven end to end by CLI verbs plus an operator
 * ... no hand-written TypeScript program", and the only way to hold a build to
 * that is to write a case whose whole body is `continuo db create`,
 * `continuo run admit` and `continuo lap perform`. Every path through
 * `src/lap/root.ts` is exercised here *through the verb*, because a case that
 * called `performLap` directly would be the hand-written program the step
 * exists to make unnecessary, and would stay green on a build whose CLI had
 * never mounted the subtree.
 *
 * **Target-only.** No parity ledger claims this file, on the same ground as
 * `test/workspace/materializer.test.ts` and `test/session/terminal-report.test.ts`:
 * interlock has no composition root to port from -- the module that was one had
 * no tests and was therefore never inventoried
 * (`docs/design/minimal-operating-loop.md` section 1). Rule 10 of
 * `docs/test-translation-conventions.md` applies.
 *
 * **These cases drive real git and start a real child**, so this file is listed
 * in `SPAWNING_TESTS` in `scripts/run-suite.mjs` and runs on the Windows serial
 * pass (`D-0048`). Both are load-bearing rather than incidental: a double for
 * git would be a double for the worktree the fence is established over, and a
 * double for the child would be a double for the one thing the fence exists to
 * constrain. The child is `test/session/helpers/fake-claude.mjs` -- the same
 * fake the session belt's 65 cases run against, so the worker in this lap is
 * configured exactly the way that belt configures it and no second fake can
 * drift from it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";
import { helpStrings } from "../../src/cli/parser.js";
import { buildParser, main, mainAsync } from "../../src/cli.js";
import { dbCliSeams } from "../../src/control_plane/cli.js";
import { NOTIFY_RECIPIENT } from "../../src/control_plane/handlers.js";
import { acquire as acquireLease } from "../../src/control_plane/lease.js";
import { openProductionControlPlane } from "../../src/control_plane/migrator.js";
import {
  WORKER_ESCALATION_EVENT_TYPE,
  WORKER_ESCALATION_GATE_TYPE,
} from "../../src/control_plane/report_ingress.js";
import { RUN_DELEGATION_RECORDED_EVENT_TYPE } from "../../src/control_plane/run_admission.js";
import { runCliSeams } from "../../src/control_plane/run_cli.js";
import { EVENT_ADMITTED } from "../../src/fencing/spawn.js";
import { lapCliSeams } from "../../src/lap/cli.js";
import { type GitOptions, runGitChecked } from "../../src/workspace/git.js";
import {
  FENCE_FILENAME,
  FENCE_LEDGER_FILENAME,
  MCP_CONFIG_FILENAME,
  WORKSPACE_MATERIALIZED_EVENT_TYPE,
} from "../../src/workspace/materializer.js";
import { fakeCli, fakeEnv, fakeMode } from "../session/helpers/fake-cli.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeams } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const BASE_BRANCH = "main";
const TOPIC_BRANCH = "feat/topic";
const ROLE = "worker";
const RUN_ID = "run-lap-1";
const HOLDER = "operator-1";
const SETTINGS_FILENAME = "settings.local.json";

/** What the worker says when its turn ends, and what the gate is opened over. */
const REPORT_TEXT = "The fence refuses the push. May I publish?";

/**
 * A repository with one commit on {@link BASE_BRANCH}.
 *
 * The same shape `test/workspace/materializer.test.ts` builds and deliberately
 * not shared with it: that file's fixture is part of what its own cases assert
 * about git, and a helper serving both would make a change made for one file's
 * cases silently change the other's premise.
 */
function initRepository(root: string): GitOptions {
  mkdirSync(root, { recursive: true });
  const git: GitOptions = { cwd: root, timeoutMs: 60_000 };
  runGitChecked(["init", `--initial-branch=${BASE_BRANCH}`, "."], git);
  runGitChecked(["config", "user.name", "continuo test"], git);
  runGitChecked(["config", "user.email", "continuo@example.invalid"], git);
  runGitChecked(["config", "commit.gpgsign", "false"], git);
  writeFileSync(join(root, "README.md"), "seed\n", "utf8");
  runGitChecked(["add", "README.md"], git);
  runGitChecked(["commit", "-m", "seed"], git);
  return git;
}

/** Everything one case needs, plus what the verbs wrote while it ran. */
interface Lap {
  readonly root: string;
  readonly repository: string;
  readonly databasePath: string;
  readonly workspace: string;
  readonly artifactDir: string;
  readonly stateRoot: string;
  readonly out: string[];
  readonly err: string[];
  /** The `lap perform` command line, so a case can dispatch it either way. */
  argv(overrides?: Readonly<Record<string, string>>): string[];
  /** `continuo lap perform`, with `overrides` replacing the defaults by flag. */
  perform(overrides?: Readonly<Record<string, string>>): Promise<number>;
}

/**
 * A control plane, a repository and an admitted run -- all three through the
 * CLI, because that is what the acceptance says.
 *
 * `runId` is a parameter because the artifact directory is derived from it
 * (`D-0061`), so a case that wants to see the derivation has to be able to
 * choose one.
 */
function lap(label: string, runId = RUN_ID): Lap {
  const root = caseRoot(label);
  const repository = join(root, "repo");
  initRepository(repository);

  const databasePath = join(root, "production.sqlite3");
  const workspace = join(root, "worktree");
  const artifactRoot = join(root, "artifacts");
  const stateRoot = join(root, "state");
  const destinationDir = join(root, "destination");

  const out: string[] = [];
  const err: string[] = [];
  // The two setup verbs write through their own records, so their lines are
  // captured here rather than reaching the runner's stdout -- and capturing
  // them is also what makes the exit-code assertions below diagnosable when one
  // of them refuses.
  patchSeams(dbCliSeams, {
    write: (text: string) => {
      out.push(text);
    },
    writeError: (text: string) => {
      err.push(text);
    },
  });
  patchSeams(runCliSeams, {
    write: (text: string) => {
      out.push(text);
    },
    writeError: (text: string) => {
      err.push(text);
    },
  });
  patchSeams(lapCliSeams, {
    nowMs: () => T0,
    write: (text: string) => {
      out.push(text);
    },
    writeError: (text: string) => {
      err.push(text);
    },
  });

  // The fake worker, and the one thing it is told to say. Without a body the
  // real CLI's `result` line carries none either, and the provider reports the
  // turn as a definite nothing -- which is the refusal case further down.
  const command = fakeCli(root);
  fakeEnv("FAKE_RESULT_TEXT", REPORT_TEXT);

  expect(main(["db", "create", "--db", databasePath, "--now-ms", String(T0)])).toBe(0);
  expect(
    main([
      "run",
      "admit",
      "--db",
      databasePath,
      "--run-id",
      runId,
      "--lease-claimant-id",
      HOLDER,
      "--workspace",
      workspace,
      "--role",
      ROLE,
      "--base-branch",
      BASE_BRANCH,
      "--topic-branch",
      TOPIC_BRANCH,
      "--prompt",
      "do the work",
      "--now-ms",
      String(T0),
    ]),
  ).toBe(0);

  const flags: Record<string, string> = {
    "--db": databasePath,
    "--run-id": runId,
    "--repository": repository,
    "--artifact-root": artifactRoot,
    "--state-root": stateRoot,
    "--endpoint-epoch": "1",
    "--endpoint-recipient": NOTIFY_RECIPIENT,
    "--endpoint-destination-dir": destinationDir,
    // A path rather than the built module: nothing here starts an endpoint, and
    // what is under test is the configuration the worker is handed.
    "--endpoint-module": join(root, "endpoint.js"),
    "--node": process.execPath,
    "--interlock-root": root,
    "--claude-org-path": join(root, "claude-org"),
    // Short, because the fake child writes its terminal line immediately and a
    // second of dead time per case is a second nobody gets back.
    "--poll-interval-ms": "10",
    "--turn-timeout-ms": "60000",
    "--git-timeout-ms": "60000",
  };

  return {
    root,
    repository,
    databasePath,
    workspace,
    artifactDir: join(artifactRoot, runId),
    stateRoot,
    out,
    err,
    argv(overrides = {}) {
      const argv = ["lap", "perform"];
      for (const [flag, value] of Object.entries({ ...flags, ...overrides })) {
        argv.push(flag, value);
      }
      // The command prefix, repeated: the provider takes a prefix so a test can
      // supply `[execPath, script]` without pretending a script is directly
      // executable on every platform.
      for (const token of command) {
        argv.push("--claude-command", token);
      }
      return argv;
    },
    perform(overrides = {}) {
      return mainAsync(this.argv(overrides));
    },
  };
}

/** The control plane, opened for inspection and closed when the case ends. */
function inspect(path: string): SqliteDatabase {
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

function eventTypes(connection: SqliteDatabase): string[] {
  return (
    connection.prepare("SELECT event_type FROM event ORDER BY seq").all() as {
      event_type: string;
    }[]
  ).map((row) => row.event_type);
}

// --------------------------------------------------------------------------

describe("the acceptance: a lap from CLI verbs alone", () => {
  test("admit, perform, and a human is now being asked something", async () => {
    const f = lap("lap-e2e");

    expect(await f.perform(), f.err.join("")).toBe(0);

    // 1. The workspace is a real checkout of the topic branch, cut from the
    //    base branch that admission fixed.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
    const branch = runGitChecked(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: f.workspace,
      timeoutMs: 60_000,
    }).stdout;
    expect(branch).toBe(TOPIC_BRANCH);

    // 2. The artifacts are outside it, in the directory D-0061 derives.
    for (const name of [FENCE_FILENAME, SETTINGS_FILENAME, MCP_CONFIG_FILENAME]) {
      expect(existsSync(join(f.artifactDir, name)), name).toBe(true);
    }
    expect(existsSync(join(f.workspace, FENCE_FILENAME))).toBe(false);

    // 3. The spine carries the whole lap, in order.
    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).toEqual([
      "run_created",
      RUN_DELEGATION_RECORDED_EVENT_TYPE,
      WORKSPACE_MATERIALIZED_EVENT_TYPE,
      WORKER_ESCALATION_EVENT_TYPE,
    ]);

    // 4. A gate stands over the escalation, and it carries the worker's own
    //    words. This is the property section 2 calls the largest correctness
    //    gain available and describes as "currently unreachable".
    const gate = connection
      .prepare("SELECT gate_id, gate_type, stage, rationale, origin_event_seq FROM gate")
      .all() as {
      gate_id: string;
      gate_type: string;
      stage: string;
      rationale: string;
      origin_event_seq: number;
    }[];
    expect(gate).toHaveLength(1);
    expect(gate[0]?.gate_type).toBe(WORKER_ESCALATION_GATE_TYPE);
    expect(gate[0]?.stage).toBe("received");
    expect(gate[0]?.rationale).toContain(REPORT_TEXT);

    const escalation = connection
      .prepare("SELECT seq FROM event WHERE event_type = :type")
      .get({ type: WORKER_ESCALATION_EVENT_TYPE }) as { seq: number };
    expect(gate[0]?.origin_event_seq).toBe(escalation.seq);

    // 5. The one line an operator reads names the gate they now have to answer.
    expect(f.out.join("")).toContain(gate[0]?.gate_id ?? "");
    expect(f.err.join("")).toBe("");
  });

  test("the child was started under the fence that was admitted", async () => {
    // The property section 4.5 says the whole step exists for: "if the lap
    // spawns through the provider directly, the worker's fence was never
    // admitted ... and the human gate becomes advisory". A lap that materialised
    // a fence and then spawned around it would pass every assertion in the case
    // above, so this one reads the child's own recorded argv and the admission
    // ledger.
    const f = lap("lap-fenced");
    expect(await f.perform(), f.err.join("")).toBe(0);

    // The ledger says a fence was admitted, and `execute` spends the admission
    // exactly once.
    const ledger = readFileSync(join(f.artifactDir, FENCE_LEDGER_FILENAME), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const admitted = ledger.filter((entry) => entry["event"] === EVENT_ADMITTED);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.["settings_path"]).toBe(join(f.artifactDir, SETTINGS_FILENAME));

    // And the child was actually launched with it. `record.json` is the
    // provider's durable record of the argv it spawned, so this is the child's
    // own command line rather than a restatement of the plan.
    const record = JSON.parse(readFileSync(recordPath(f.stateRoot), "utf8")) as {
      argv: string[];
      workspace: string;
    };
    const settingsIndex = record.argv.indexOf("--settings");
    expect(settingsIndex, JSON.stringify(record.argv)).toBeGreaterThanOrEqual(0);
    expect(record.argv[settingsIndex + 1]).toBe(join(f.artifactDir, SETTINGS_FILENAME));
    expect(record.argv).toContain("--permission-mode");
    expect(record.argv).toContain("--mcp-config");
    // The child's cwd is the worktree git made, not a directory the provider
    // created for it.
    expect(record.workspace).toBe(f.workspace);
  });
});

describe("the help text and the implementation say the same thing", () => {
  // The tripwire that was missing. `--turn-timeout-ms`'s help described the
  // child as left running for a whole round after `performLap` started stopping
  // it, and nothing caught it: `verify` type-checks and runs cases, and neither
  // reads a help string against the behaviour it describes. These two cases are
  // the same claim asserted from both sides, so the pair fails when either
  // moves.
  const timeoutHelp = (): string => {
    const help = helpStrings(buildParser()).join("\n");
    const marker = "milliseconds to wait for the turn's terminal report";
    const at = help.indexOf(marker);
    expect(
      at,
      "the --turn-timeout-ms help is no longer findable by its opening words",
    ).toBeGreaterThanOrEqual(0);
    return help.slice(at, at + 400);
  };

  test("--help says the session is stopped and the workspace kept", () => {
    const text = timeoutHelp();
    expect(text).toContain("stopped");
    expect(text).toContain("workspace and the fence are left as they are");
  });

  test("the refusal an operator actually receives says the same", async () => {
    const f = lap("lap-timeout-wording");
    patchSeams(lapCliSeams, { nowMs: () => Date.now() });
    fakeMode("events-then-hang");
    fakeEnv("FAKE_SLEEP", "120");

    expect(await f.perform({ "--turn-timeout-ms": "300", "--poll-interval-ms": "50" })).toBe(2);
    const written = f.err.join("");
    expect(written).toContain("did not finish its turn");
    expect(written).toContain("session is stopped");
    expect(written).toContain("workspace and the fence are left exactly as they are");
  });
});

describe("D-0065: an expired deadline costs the deadline, never the report", () => {
  test("the gate opens without it, and the operator is told which one lapsed", async () => {
    // The worker's turn outrunning the operator's deadline used to be fatal in
    // the worst possible place: `gate.deadline_at_ms > created_at_ms` is a DDL
    // CHECK, so the ingest raised a raw SQLite error AFTER the whole lap had
    // run -- and because the event and the gate are one transaction, the
    // worker's report rolled back with it. Everything was done and nothing was
    // recorded, on a run that could not be materialised again.
    //
    // The clock has to MOVE for this state to exist at all: the deadline must
    // be in the future when the lap starts (or the prologue refuses it up
    // front, which is the case above) and in the past when the gate is created.
    // So the fixture's frozen clock is replaced by one that jumps exactly once,
    // on its first read -- deterministic, and it puts the whole of the lap on
    // the far side of the deadline without depending on how long anything took.
    const f = lap("lap-deadline-lapsed");
    let reads = 0;
    patchSeams(lapCliSeams, {
      nowMs: () => {
        reads += 1;
        return reads === 1 ? T0 : T0 + 10_000;
      },
    });
    const deadline = T0 + 5_000;

    expect(await f.perform({ "--gate-deadline-at-ms": String(deadline) }), f.err.join("")).toBe(0);

    const connection = inspect(f.databasePath);
    const gate = connection.prepare("SELECT gate_id, deadline_at_ms FROM gate").all() as {
      gate_id: string;
      deadline_at_ms: number | null;
    }[];
    // The gate exists -- which is the whole point -- and carries no deadline.
    expect(gate).toHaveLength(1);
    expect(gate[0]?.deadline_at_ms).toBeNull();
    // And the report reached the spine rather than rolling back with it.
    expect(eventTypes(connection)).toContain(WORKER_ESCALATION_EVENT_TYPE);

    // The operator is told, and told WHICH deadline, so they can tell "my
    // deadline was too tight" from "the worker ran long".
    const written = f.out.join("");
    expect(written).toContain(String(deadline));
    expect(written).toContain("opened without one");
  });

  test("a deadline the lap does honour is written through unchanged", async () => {
    // The anti-vacuity half: without it, an implementation that dropped every
    // deadline would satisfy the case above.
    const f = lap("lap-deadline-kept");
    const future = T0 + 3_600_000;
    expect(await f.perform({ "--gate-deadline-at-ms": String(future) }), f.err.join("")).toBe(0);

    const connection = inspect(f.databasePath);
    const gate = connection.prepare("SELECT deadline_at_ms FROM gate").get() as {
      deadline_at_ms: number | null;
    };
    expect(gate.deadline_at_ms).toBe(future);
    expect(f.out.join("")).not.toContain("opened without one");
  });
});

describe("what the verb refuses, and what it leaves behind", () => {
  test("a run that was never admitted is a refusal, not a stack trace", async () => {
    const f = lap("lap-unadmitted");
    expect(await f.perform({ "--run-id": "no-such-run" })).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);
    expect(f.err.join("")).toContain("run_delegation_recorded");
    // Nothing was built for a run that does not exist.
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a turn that said nothing opens no gate", async () => {
    // `D-0060`'s other half: a `result` line with no body is a finished turn
    // with nothing to escalate, and polling will not change it. Without the
    // refusal the lap would spend its whole budget and report a timeout, which
    // names the wrong problem to the operator.
    const f = lap("lap-silent");
    fakeEnv("FAKE_RESULT_TEXT", "");

    expect(await f.perform()).toBe(2);
    expect(f.err.join("")).toContain("without a report to escalate");

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
    // The workspace and the fence are left exactly as they were: the refusal is
    // about the turn, and rolling back a checkout the worker may have written
    // into would destroy the evidence of what it did.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
    expect(existsSync(join(f.artifactDir, FENCE_FILENAME))).toBe(true);
  });

  test("a synchronous dispatch refuses before the lap has begun", () => {
    // `main` cannot settle a promise, and this verb's handler does its work
    // before returning one -- it materialises a worktree, publishes a fence and
    // starts a child. So the shape has to be discovered from the parser's own
    // declaration and refused BEFORE the handler is called; discovering it from
    // the returned value would mean discovering it after a child was running
    // that nobody was going to observe.
    const f = lap("lap-sync-dispatch");
    expect(() => main(f.argv())).toThrow(/asynchronous/);
    expect(existsSync(f.workspace)).toBe(false);
    expect(existsSync(f.artifactDir)).toBe(false);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKSPACE_MATERIALIZED_EVENT_TYPE);
  });

  test("a run someone else holds the lease on is a refusal, not a stack trace", async () => {
    // `SessionOrchestrator.start()` takes the run's lease and raises `LeaseHeld`
    // -- a `LeaseRefusal`, which is neither a `ControlPlaneRefusal` nor one of
    // `src/workspace/`'s. So does `OrchestrationRefused` when the walk stops for
    // its own reasons. Both are ordinary outcomes of a command an operator
    // typed, and without them on this verb's classification the operator gets an
    // unhandled stack trace and exit 1 where every other verb gives one line and
    // exit 2.
    const f = lap("lap-lease-held");
    const held = openProductionControlPlane(f.databasePath);
    onTestFinished(() => {
      held.close();
    });
    acquireLease(held, {
      resource: `session-run:${RUN_ID}`,
      holder: "someone-else",
      nowMs: T0,
      ttlMs: 600_000,
    });

    expect(await f.perform()).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
  });

  test("an unadmitted run id cannot forge a second line of output", async () => {
    // This refusal path is the only one in the module that names an identifier
    // nothing has validated: it fires precisely because the id matched no row,
    // so `LapRunIntent`'s printable-ASCII rule never saw it. A raw
    // interpolation would let `--run-id $'x\nerror: approved'` write a second
    // line that reads like continuo's own.
    const f = lap("lap-forged-line");
    expect(await f.perform({ "--run-id": "x\nerror: approved" })).toBe(2);
    const written = f.err.join("");
    // One line, and the newline is escaped inside the quoted value rather than
    // ending it.
    expect(written.trimEnd().split("\n")).toHaveLength(1);
    expect(written).toContain("\\n");
  });

  test("a timed-out turn refuses and the verb still returns", async () => {
    // The bound has to be a bound. The provider holds a referenced child
    // handle, so a lap that printed a timeout and left the child running would
    // keep this process's event loop alive and the command would not exit until
    // the child felt like it -- a `--turn-timeout-ms` in the help text and
    // nowhere else. `performLap` stops the session on every path out for that
    // reason, and this case is green only if the verb actually returns.
    const f = lap("lap-timeout");
    // A real clock, replacing the fixture's frozen one: a budget is measured
    // against a clock that moves, and every other case wants a fixed instant.
    patchSeams(lapCliSeams, { nowMs: () => Date.now() });
    // A child that emits its events and then hangs for far longer than the
    // budget: there is no terminal line to read, so the poll runs out of time
    // rather than finding anything, and the child is still alive when it does.
    fakeMode("events-then-hang");
    fakeEnv("FAKE_SLEEP", "120");

    expect(await f.perform({ "--turn-timeout-ms": "300", "--poll-interval-ms": "50" })).toBe(2);
    expect(f.err.join("")).toContain("did not finish its turn within 300ms");

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    // The workspace and the fence stay: the refusal is about the turn, and
    // deleting a checkout the worker may have written into is not a rollback.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
  });

  test("a walk that fails after spawning still stops its child", async () => {
    // `orchestrator.start()` can spawn and then reject -- the identity never
    // reads back, the post-spawn validation refuses -- and the provider says in
    // as many words that a Failure does not prove no process was created. The
    // session id lives inside that rejected call, so a teardown that read it off
    // the outcome would have no outcome to read and would leave a fenced worker
    // running with its handle holding this process open. The child here would
    // sleep two minutes; the case is green only because the verb returns.
    const f = lap("lap-walk-fails");
    fakeMode("events-then-hang");
    fakeEnv("FAKE_SLEEP", "120");
    // The child never names itself, so the identity cannot be read back and the
    // walk refuses after the spawn rather than before it.
    fakeEnv("FAKE_OMIT_IDENTITY", "1");

    expect(await f.perform()).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
  });

  test("an operator's own bad values are refusals, not stack traces", async () => {
    // The parser types `--turn-timeout-ms` as an integer, which admits `-1`, and
    // `--artifact-root` as a string, which admits a relative path. Both reach a
    // *usage error* class at runtime -- `LapUsageError` and
    // `WorkspaceMaterializationUsageError` -- and the reflex is to leave those
    // uncaught because a usage error is a defect in a caller. Here the caller is
    // the operator, so leaving them out means a typo arrives as a stack trace and
    // exit 1 where every other verb in this CLI gives one line and exit 2.
    const negative = lap("lap-negative-timeout");
    expect(await negative.perform({ "--turn-timeout-ms": "-1" })).toBe(2);
    expect(negative.err.join("")).toMatch(/^error: /);
    expect(negative.err.join("")).toContain("timeout_ms");
    // **And nothing was built.** This half was missing when this case was first
    // written, which meant it pinned the exit code while quietly accepting that
    // a typo materialised a worktree, published a fence and started a child --
    // and `D-0057` refuses a second materialisation of one run, so that typo
    // cost the run identifier itself. Asserting the exit code alone is what
    // made the bad behaviour look settled.
    expect(existsSync(negative.workspace)).toBe(false);
    expect(existsSync(negative.artifactDir)).toBe(false);

    const relative = lap("lap-relative-artifacts");
    expect(await relative.perform({ "--artifact-root": "relative/dir" })).toBe(2);
    expect(relative.err.join("")).toMatch(/^error: /);
    // Refused before anything is created: a malformed request costs no worktree.
    expect(existsSync(relative.workspace)).toBe(false);
  });

  test("a gate deadline already in the past is refused before anything is built", async () => {
    // A stale value pasted from an earlier command, or a mistyped digit. The
    // operator hears about it while a corrected retry is still free -- which it
    // only is if nothing has been materialised yet.
    const f = lap("lap-stale-deadline");
    expect(await f.perform({ "--gate-deadline-at-ms": String(T0 - 1) })).toBe(2);
    expect(f.err.join("")).toContain("already in the past");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a worker that called its own turn a failure opens no gate", async () => {
    // `D-0056` decides that a turn marked `is_error` is an execution failure and
    // not an escalation, so the ingress refuses it and no gate is opened. The
    // behaviour was already right -- `ReportIngressUsageError` is a
    // `ControlPlaneRefusal`, so it reaches the operator as one line and exit 2
    // rather than as a stack trace -- and it had no case, which is how a review
    // came to read it as a defect. This is that case: what is pinned is that the
    // classification holds through the whole lap, not merely that the class
    // extends the right base.
    const f = lap("lap-worker-failed");
    fakeEnv("FAKE_IS_ERROR", "1");

    expect(await f.perform()).toBe(2);
    const written = f.err.join("");
    expect(written).toMatch(/^error: /);
    expect(written).toContain("is marked is_error");
    expect(written).toContain("no gate is opened");
    // One line, not a stack: a stack trace would arrive over several.
    expect(written.trimEnd().split("\n")).toHaveLength(1);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
    // The workspace and the fence stay: the worker's failure is evidence, and
    // deleting the checkout it failed in would destroy it.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
  });

  test("a worker CLI that will not start is a refusal, not a stack trace", async () => {
    // `SessionProvider.start` runs the spawn precondition before anything is
    // spawned, and raises `SpawnRefused` when the CLI is absent, its capability
    // probe fails, or it lacks a flag the fence needs. The commonest of those --
    // `claude` not installed -- was arriving as an unhandled stack trace and
    // exit 1, after the worktree had already been materialised, where every
    // other verb in this CLI gives one line and exit 2.
    const f = lap("lap-no-cli");
    expect(await f.perform({ "--claude-command": join(f.root, "not-a-real-cli") })).toBe(2);
    const written = f.err.join("");
    expect(written).toMatch(/^error: /);
    // One line, not a stack.
    expect(written.trimEnd().split("\n")).toHaveLength(1);

    const connection = inspect(f.databasePath);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
  });

  test("a second perform of one run is refused rather than re-run", async () => {
    // The materialiser refuses a run it has already materialised (`D-0057`),
    // and this is the case that says the CLI surfaces that as a refusal rather
    // than as an unhandled error -- and that it does not start a second child
    // under a fence the first lap already spent.
    const f = lap("lap-twice");
    expect(await f.perform(), f.err.join("")).toBe(0);
    f.err.length = 0;

    expect(await f.perform()).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);

    const connection = inspect(f.databasePath);
    expect(
      eventTypes(connection).filter((type) => type === WORKSPACE_MATERIALIZED_EVENT_TYPE),
    ).toHaveLength(1);
  });
});

/**
 * The one `record.json` under a state root.
 *
 * Found rather than named, because the session id is a UUID this test does not
 * choose -- the verb mints it. There is exactly one session per lap, so an
 * expectation of one directory is a check as well as a lookup.
 */
function recordPath(stateRoot: string): string {
  // Filtered on `record.json` rather than taking the only entry: the provider
  // also writes `probe-evidence.txt` into the state root, so "the only child of
  // this directory" is not the same statement as "the only session".
  const sessions = readdirSync(stateRoot).filter((entry) =>
    existsSync(join(stateRoot, entry, "record.json")),
  );
  expect(sessions, `expected one session under ${stateRoot}`).toHaveLength(1);
  return join(stateRoot, sessions[0] as string, "record.json");
}
