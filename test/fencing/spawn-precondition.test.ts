import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  BatteryReport,
  ProbeResult,
  ProbeSynthesisError,
  runBattery,
} from "../../src/fencing/battery.js";
import { pyJsonDumps, pyJsonLoads } from "../../src/fencing/pyjson.js";
import * as semantics from "../../src/fencing/pysemantics.js";
import { pyDict, pyIterate, pyTypeName, pyTypeNameOf } from "../../src/fencing/pysemantics.js";
import {
  type FenceContext,
  loadDocument,
  RefusalReason,
  type RoleDocument,
} from "../../src/fencing/renderer.js";
import { makeDecision } from "../../src/fencing/rules.js";
import {
  EVENT_ADMITTED,
  FencedSpawner,
  FenceLedger,
  REASON_BATTERY_INCOMPLETE,
  REASON_PROBE_UNSYNTHESIZABLE,
  type SpawnOutcome,
  spawnSeams,
} from "../../src/fencing/spawn.js";
import * as api from "../../src/index.js";
import { patchSeam } from "../testkit/seams.js";
import {
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  fenceLedger,
  mutate,
  type RecordingSpawner,
  recordingSpawner,
  replaceFenceContext,
} from "./helpers/fence-cases.js";

/**
 * Interlock's fail-closed spawn precondition.
 *
 * Ported from interlock `tests/fencing/test_spawn_precondition.py` at
 * `65f36c5`. Every case here maps to one source node id; the mapping and the
 * two target-only groups at the end are recorded in this lane's parity ledger.
 *
 * The source's module docstring states the criterion (interlock issue #9's
 * third) and the three assertions each broken case makes, and it names which of
 * the three carries the weight:
 *
 * > 1. the outcome is a refusal with a named reason,
 * > 2. **the spawner was never invoked** -- not invoked with a narrowed fence,
 * >    not invoked with a warning logged; not invoked,
 * > 3. the refusal is on disk, flushed, before the caller was told anything.
 *
 * (2) is the one a translation loses by accident. `spawner.calls == []` appears
 * seven times in this file, and every one of them survives here as
 * `expect(spawner.calls).toEqual([])`. It is not interchangeable with
 * `outcome.admitted === false`: a **downgraded** spawn -- a best-effort
 * renderer handing the spawner a fence with the broken part dropped -- also
 * reports not-admitted from some paths and would satisfy every other assertion
 * in the file. Only the call count says the child never started. D-0205 records
 * this as continuo's expression of interlock#71's canary acceptance
 * (interlock#74 AC4), so weakening any of the seven is a ledger event, not an
 * editorial choice.
 *
 * D-0206 is the one place the port's behaviour differs from the source's here:
 * continuo's ledger takes no cross-process lock and creates no `.lock` sibling.
 * No case in this file asserts on the ledger DIRECTORY's contents -- the
 * closest, `the ledger is append only`, reads the ledger FILE by text -- so the
 * difference is invisible to this suite. It is noted rather than left for a
 * later reader to rediscover while wondering why nothing broke.
 */

/**
 * The four fixtures every case in the source composes, as one per-test call.
 *
 * `ctx` and `ledger` both hang off the SAME `tmp_path` in the source, so they
 * are built from one `fenceCaseRoot()` here. Two roots would be two directories
 * and the cases that assert nothing was published at `ctx.fencePath` would be
 * asserting about a directory the ledger never touches -- true for a reason
 * that has nothing to do with the refusal.
 *
 * Function scope in the source, function scope here (rulebook rule 8): the
 * root registers its own removal at acquisition, so one call per test is one
 * cleanup per test.
 */
function fixtures(): {
  root: string;
  ctx: FenceContext;
  document: RoleDocument;
  ledger: FenceLedger;
} {
  const root = fenceCaseRoot();
  return {
    root,
    ctx: fenceContext(root),
    document: fenceDocument(),
    // The source's `ledger` fixture in THIS file is
    // `FenceLedger(tmp_path / "fence-ledger.jsonl")`. The name is carried
    // rather than defaulted: two cases below read the ledger back by path.
    ledger: fenceLedger(root, "fence-ledger.jsonl"),
  };
}

/**
 * `TestBrokenConfigurationsRefuse._refuse`: spawn, and hand back both halves.
 *
 * Returning the spawner alongside the outcome is the source's shape and is the
 * point of the helper -- a version that returned only the outcome would make
 * the call-count assertion unwritable at the call site, which is how this
 * file's central property gets dropped by a well-meaning cleanup.
 */
function refuse(
  ledger: FenceLedger,
  document: RoleDocument,
  ctx: FenceContext,
  role = "worker",
): { outcome: SpawnOutcome; spawner: RecordingSpawner } {
  const spawner = recordingSpawner();
  const outcome = new FencedSpawner({ ledger, document }).spawn(role, ctx, spawner);
  return { outcome, spawner };
}

/**
 * `OSError("...")`, as `spawn.ts` classifies one -- ADAPTED, and narrowly.
 *
 * The source raises a bare `OSError` from the patched `_write_settings`, and
 * `_admit` catches `except OSError`. Node has no `OSError` type: the only
 * classification a filesystem failure carries is a string `code` on an
 * ordinary `Error`, and `isOSError` in `spawn.ts` tests exactly that. So a
 * plain `new Error("no space left on device")` would NOT be caught, would
 * escape `#admit`, and the two publication cases would fail with the thrown
 * error instead of asserting the rollback.
 *
 * The message is the source's verbatim, because it is what `describe(exc)`
 * interpolates into the recorded refusal detail; the `code` is the addition,
 * and it is the errno CPython would have raised the source's message with.
 */
function osError(message: string, code = "ENOSPC"): Error {
  return Object.assign(new Error(message), { code });
}

/** `Path.is_file()`. */
function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

describe("a sound fence spawns", () => {
  test("a good configuration admits", () => {
    const { ctx, document, ledger } = fixtures();
    const spawner = recordingSpawner();
    const outcome = new FencedSpawner({ ledger, document }).spawn("worker", ctx, spawner);
    expect(outcome.admitted).toBe(true);
    expect(spawner.calls.length).toBe(1);
    expect(outcome.result).toEqual({ pid: 4242 });
    expect(
      ledger.events().filter((event) => event["event"] === EVENT_ADMITTED).length,
    ).toBeGreaterThan(0);
  });

  test("the plan publishes the fence the hook will read", () => {
    const { ctx, document, ledger } = fixtures();
    const outcome = new FencedSpawner({ ledger, document }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    const plan = outcome.plan;
    expect(plan).not.toBeNull();
    if (plan === null) {
      return;
    }
    expect(isFile(plan.fencePath)).toBe(true);
    expect(isFile(plan.settingsPath)).toBe(true);
    const published = pyJsonLoads(readFileSync(plan.fencePath, "utf8")) as Record<string, unknown>;
    // `assert published["rules"]` -- truthy, i.e. a NON-EMPTY rule list. A
    // published fence with an empty `rules` array is a fence that denies
    // nothing, which is the shape a downgraded publication produces.
    expect(Array.isArray(published["rules"])).toBe(true);
    expect((published["rules"] as unknown[]).length).toBeGreaterThan(0);
    expect(pyJsonLoads(readFileSync(plan.settingsPath, "utf8"))).toEqual(outcome.fence?.settings);
  });

  test("the cli args pass permission mode explicitly", () => {
    // i01 section 3.9: `permissionMode` is the one part of the fence the
    // provider reads back, so it is the one part a restart can be checked
    // against directly. It is passed as a flag rather than left implicit.
    const { ctx, document, ledger } = fixtures();
    const outcome = new FencedSpawner({ ledger, document }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    const args = outcome.plan?.cliArgs() ?? [];
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(outcome.fence?.permissionMode);
    expect(args).toContain("--settings");
  });
});

describe("broken configurations refuse", () => {
  // The three classes issue #9 names, each asserted the same way.

  test("config deleted", () => {
    const { ctx, ledger } = fixtures();
    const { outcome, spawner } = refuse(ledger, { roles: {} }, ctx);
    expect(outcome.admitted).toBe(false);
    expect(spawner.calls).toEqual([]);
    expect(outcome.codes).toContain(RefusalReason.ROLE_ABSENT);
  });

  test("hook path unresolvable", () => {
    const { root, ctx, document, ledger } = fixtures();
    // `dataclasses.replace(ctx, hook_script=tmp_path / "vanished.py")`. The
    // `.py` suffix is load-bearing: the renderer only demands existence for a
    // token that ends in a script suffix, so a name without one would resolve
    // and the case would stop reaching `hook-unresolvable`.
    const brokenCtx = replaceFenceContext(ctx, { hookScript: join(root, "vanished.py") });
    const { outcome, spawner } = refuse(ledger, document, brokenCtx);
    expect(outcome.admitted).toBe(false);
    expect(spawner.calls).toEqual([]);
    expect(outcome.codes).toContain(RefusalReason.HOOK_UNRESOLVABLE);
  });

  test("sandbox profile absent", () => {
    const { ctx, document, ledger } = fixtures();
    const { outcome, spawner } = refuse(ledger, mutate(document, "worker", { sandbox: null }), ctx);
    expect(outcome.admitted).toBe(false);
    expect(spawner.calls).toEqual([]);
    expect(outcome.codes).toContain(RefusalReason.SANDBOX_PROFILE_ABSENT);
  });

  test("a refusal is never a narrowed spawn", () => {
    // The negative that the whole criterion turns on.
    //
    // A "best effort" renderer would hand the spawner a fence with the broken
    // part dropped. Nothing may reach the spawner at all -- and the two
    // assertions after the call count say the outcome carries no fence and no
    // plan either, so there is nothing a caller could spawn with by hand.
    const { ctx, document, ledger } = fixtures();
    const { outcome, spawner } = refuse(ledger, mutate(document, "worker", { sandbox: null }), ctx);
    expect(spawner.calls).toEqual([]);
    expect(outcome.fence).toBeNull();
    expect(outcome.plan).toBeNull();
  });

  test("no fence or settings file is published on a refusal", () => {
    // A published fence from a refused spawn would be picked up by a hook on
    // the next start and enforced as though it had been approved.
    const { ctx, document, ledger } = fixtures();
    refuse(ledger, mutate(document, "worker", { sandbox: null }), ctx);
    expect(existsSync(ctx.fencePath)).toBe(false);
    // `ctx.fence_path.parent / "settings.local.json"`, joined rather than
    // spelled with a `/`: an asserted path built by hand would be a path that
    // does not exist on Windows for a reason unrelated to the refusal.
    expect(existsSync(join(dirname(ctx.fencePath), "settings.local.json"))).toBe(false);
  });
});

describe("the child starts outside the ledger lock", () => {
  test("the ledger is not held while the child runs", () => {
    // A synchronous spawner must not serialize every other role behind it.
    //
    // `spawner` for a real `claude -p` session is a blocking `subprocess.run`.
    // Holding the cross-process ledger lock for its whole duration would block
    // every other role -- including one trying to record a REFUSAL, which is
    // the one thing that must never wait on a long-running success.
    //
    // Under D-0206 continuo takes no cross-process lock at all, so the property
    // this case pins is the weaker but still load-bearing half interlock's
    // Windows path also has: the second `FencedSpawner` runs, and records, from
    // INSIDE the first one's spawner callback. If `#admit` ever grew a
    // re-entrant in-process lock -- or if the child were moved inside the
    // transaction -- this deadlocks or refuses to record, exactly as it would
    // in the source.
    const { ctx, document, ledger } = fixtures();
    const observed: { outcome?: SpawnOutcome } = {};
    const spawner = (): unknown => {
      // Inside the spawner, another FencedSpawner must be able to take the
      // lock and record its own refusal.
      const other = new FencedSpawner({
        ledger,
        document: mutate(document, "curator", { sandbox: null }),
      });
      observed.outcome = other.spawn("curator", ctx, recordingSpawner());
      return { pid: 7 };
    };
    const outcome = new FencedSpawner({ ledger, document }).spawn("worker", ctx, spawner);
    expect(outcome.admitted).toBe(true);
    expect(observed.outcome?.admitted).toBe(false);
    expect(ledger.refusals().length).toBeGreaterThan(0);
  });

  test("the admission is recorded before the child starts", () => {
    const { ctx, document, ledger } = fixtures();
    const seen: { events?: unknown[] } = {};
    const spawner = (): unknown => {
      seen.events = ledger.events().map((event) => event["event"]);
      return null;
    };
    new FencedSpawner({ ledger, document }).spawn("worker", ctx, spawner);
    expect(seen.events).toContain(EVENT_ADMITTED);
  });
});

describe("publication is all or nothing", () => {
  test("a failed settings write leaves no fence behind", () => {
    // Half a publication is not "nothing published".
    //
    // A fence left on disk by a spawn that was then refused would be read by
    // the hook on the next start and enforced as though it had been admitted --
    // the refusal invariant would be satisfied in the ledger and violated on
    // the filesystem.
    const { ctx, document, ledger } = fixtures();
    const spawner = recordingSpawner();
    const fenced = new FencedSpawner({ ledger, document });
    // `monkeypatch.setattr(FencedSpawner, "_write_settings", ...)`: patched on
    // the CLASS, so the instance built above is affected too -- which is the
    // source's ordering and is kept. `writeSettings` is exported `@internal`
    // for exactly this (D-0101); `patchSeam` gives it monkeypatch's snapshot-
    // at-patch and LIFO restore rather than a file-level undo.
    patchSeam(FencedSpawner.prototype, "writeSettings", () => {
      throw osError("no space left on device");
    });
    const outcome = fenced.spawn("worker", ctx, spawner);
    expect(outcome.admitted).toBe(false);
    expect(spawner.calls).toEqual([]);
    expect(existsSync(ctx.fencePath)).toBe(false);
    expect(ledger.refusals().length).toBeGreaterThan(0);
  });

  test("a failed republish restores the previous fence", () => {
    // A refused respawn must not disarm the session that is already live.
    //
    // Unlinking the replacement would leave the running session with no fence
    // at all, and every hook call denying, until the next successful
    // publication -- a refusal that breaks more than it prevents.
    const { ctx, document, ledger } = fixtures();
    const first = new FencedSpawner({ ledger, document }).spawn("worker", ctx, recordingSpawner());
    expect(first.admitted).toBe(true);
    // `read_bytes()`: the assertion below is on BYTES, not on a parsed
    // document. A rollback that re-rendered equivalent JSON with a different
    // key order or indentation would be a different file arriving at a live
    // session, and the source does not accept it either.
    const original = readFileSync(ctx.fencePath);

    patchSeam(FencedSpawner.prototype, "writeSettings", () => {
      throw osError("disk full");
    });
    const outcome = new FencedSpawner({ ledger, document }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    expect(outcome.admitted).toBe(false);
    expect(readFileSync(ctx.fencePath)).toEqual(original);
  });
});

describe("the refusal is recorded durably", () => {
  test("the refusal is on disk with its reasons", () => {
    const { ctx, document, ledger } = fixtures();
    new FencedSpawner({ ledger, document }).spawn("worker", ctx, recordingSpawner());
    new FencedSpawner({
      ledger,
      document: mutate(document, "worker", { sandbox: null }),
    }).spawn("worker", ctx, recordingSpawner());
    const refusals = ledger.refusals();
    // Exactly one: the admitted spawn above must not have recorded a refusal
    // of its own, and the refused one must not have recorded two.
    expect(refusals.length).toBe(1);
    const reasons = refusals[0]?.["reasons"] as { code: string }[];
    expect(new Set(reasons.map((reason) => reason.code))).toContain(
      RefusalReason.SANDBOX_PROFILE_ABSENT,
    );
    expect(refusals[0]?.["role"]).toBe("worker");
  });

  test("the record survives a fresh reader", () => {
    // "Recorded durably" is taken literally: a refusal lost on crash is a
    // refusal that was not recorded, and the crash is exactly when it is
    // wanted. The second `FenceLedger` on the same path is the fresh reader --
    // it shares no in-memory state with the first, so anything it can see was
    // on disk.
    const { root, ctx, document } = fixtures();
    const path = join(root, "ledger.jsonl");
    new FencedSpawner({
      ledger: fenceLedger(root),
      document: mutate(document, "worker", { hooks: null }),
    }).spawn("worker", ctx, recordingSpawner());
    expect(fenceLedger(root).refusals().length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
  });

  test("every refusal is recorded not just the first", () => {
    const { ctx, document, ledger } = fixtures();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      new FencedSpawner({
        ledger,
        document: mutate(document, "worker", { sandbox: null }),
      }).spawn("worker", ctx, recordingSpawner());
    }
    expect(ledger.refusals().length).toBe(3);
  });

  test("the ledger is append only", () => {
    const { ctx, document, ledger } = fixtures();
    new FencedSpawner({ ledger, document }).spawn("worker", ctx, recordingSpawner());
    const first = readFileSync(ledger.path, "utf8");
    new FencedSpawner({ ledger, document }).spawn("curator", ctx, recordingSpawner());
    // `startswith`, not "contains" and not "is longer than": a rewrite that
    // preserved every line but reordered them, or that rewrote an earlier
    // line's payload, is not an append.
    expect(readFileSync(ledger.path, "utf8").startsWith(first)).toBe(true);
  });
});

describe("the spawner self checks", () => {
  test("a rule whose probe cannot be synthesized refuses and is recorded", () => {
    // A rule the battery cannot aim at is a rule nothing observes.
    //
    // Letting the synthesis error escape would skip the durable record
    // entirely -- a spawn that neither happened nor was written down.
    const { ctx, document, ledger } = fixtures();
    // `monkeypatch.setattr(spawn_module, "run_battery", boom)`. ESM cannot
    // rebind an imported binding, so `spawn.ts` routes every internal call
    // through `spawnSeams` (D-0014) and the patch replaces the record entry.
    patchSeam(spawnSeams, "runBattery", () => {
      throw new ProbeSynthesisError("no witness for this rule");
    });
    const spawner = recordingSpawner();
    const outcome = new FencedSpawner({ ledger, document }).spawn("worker", ctx, spawner);
    expect(outcome.admitted).toBe(false);
    expect(spawner.calls).toEqual([]);
    expect(outcome.codes).toContain(REASON_PROBE_UNSYNTHESIZABLE);
    expect(ledger.refusals().length).toBeGreaterThan(0);
  });

  test("a fence that fails its own battery refuses the spawn", () => {
    // Shipping a fence Interlock cannot itself prove is the same class of
    // error as shipping no fence.
    const { ctx, document, ledger } = fixtures();
    const real = spawnSeams.runBattery;
    patchSeam(spawnSeams, "runBattery", (fence, options) => {
      const report = real(fence, options);
      const firstResult = report.results[0];
      if (firstResult === undefined) {
        throw new Error("the battery reported no probes to sabotage");
      }
      // The source replaces result[0]'s decision with `Decision(denied=False)`
      // and leaves the probe -- so the report still COVERS every rule and
      // fails only on denial. A sabotage that dropped the result instead would
      // be caught by a coverage check rather than by the denial check, and the
      // case would go green through a path it is not about.
      const broken = new ProbeResult(firstResult.probe, makeDecision({ denied: false }));
      return new BatteryReport(report.role, [broken, ...report.results.slice(1)]);
    });
    const spawner = recordingSpawner();
    const outcome = new FencedSpawner({ ledger, document }).spawn("worker", ctx, spawner);
    expect(outcome.admitted).toBe(false);
    expect(spawner.calls).toEqual([]);
    expect(outcome.codes).toContain(REASON_BATTERY_INCOMPLETE);
    expect(ledger.refusals().length).toBeGreaterThan(0);
  });
});

describe("seam liveness (target-only)", () => {
  test("FencedSpawner.spawn calls runBattery through the seam record", () => {
    // The rulebook's rule 5, last paragraph: "a seam can rot into a
    // decoration". If a refactor made `#admit` call the imported `runBattery`
    // directly, BOTH cases above would still pass -- the patch would install,
    // never be reached, and the real battery would run. Their assertions are
    // about refusals, and a refusal for the wrong reason still contains the
    // right code only by luck; worse, the two seam cases would then be
    // asserting nothing at all while reading as the file's self-check.
    //
    // So this counts the calls through the record on a spawn that ADMITS: it
    // fails the moment production stops routing through `spawnSeams`.
    const { ctx, document, ledger } = fixtures();
    const real = spawnSeams.runBattery;
    let calls = 0;
    patchSeam(spawnSeams, "runBattery", (fence, options) => {
      calls += 1;
      return real(fence, options);
    });
    const outcome = new FencedSpawner({ ledger, document }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    expect(outcome.admitted).toBe(true);
    expect(calls).toBe(1);
  });

  test("FencedSpawner.writeSettings is reached as a prototype method", () => {
    // The other patch point the two publication cases depend on. It is not a
    // seam record but it has the same rot mode: an inlined settings write, or
    // a copy captured into the constructor, would leave both rollback cases
    // green while the real write kept happening.
    const { ctx, document, ledger } = fixtures();
    const real = FencedSpawner.prototype.writeSettings;
    let calls = 0;
    patchSeam(
      FencedSpawner.prototype,
      "writeSettings",
      function patched(this: FencedSpawner, fence, context) {
        calls += 1;
        return real.call(this, fence, context);
      },
    );
    const outcome = new FencedSpawner({ ledger, document }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    expect(outcome.admitted).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("the canary acceptance is wired, not merely implemented (target-only)", () => {
  // D-0205, interlock#74 AC4. Interlock's obligation -- that the precondition
  // is WIRED into the production spawn path, not merely present -- is carried
  // in Python by the module docstring and by review: `FencedSpawner.spawn`
  // calls `self._admit(...)` and no other code path reaches the spawner. That
  // is a property of the module, not an assertion in the suite, so it has to be
  // re-expressed rather than translated. Two halves, per the decision.

  test("no brokenness class reaches the spawner through the production entry point", () => {
    // The behavioural half. It drives the PRODUCTION entry point --
    // `FencedSpawner.spawn`, the only exported way to reach the injected
    // spawner -- with each of the four brokenness classes `spawn.ts` enumerates
    // in turn, and asserts call count exactly zero on every one. A test that
    // called `#admit` directly would be green in a world where nothing calls
    // it, which is the world interlock#71 asked about.
    const { root, ctx, document, ledger } = fixtures();

    // 1. config deleted
    const deleted = refuse(ledger, { roles: {} }, ctx);
    expect(deleted.spawner.calls.length).toBe(0);
    expect(deleted.outcome.codes).toContain(RefusalReason.ROLE_ABSENT);

    // 2. hook path unresolvable
    const unresolvable = refuse(
      ledger,
      document,
      replaceFenceContext(ctx, { hookScript: join(root, "absent.mjs") }),
    );
    expect(unresolvable.spawner.calls.length).toBe(0);
    expect(unresolvable.outcome.codes).toContain(RefusalReason.HOOK_UNRESOLVABLE);

    // 3. sandbox profile absent
    const noSandbox = refuse(ledger, mutate(document, "worker", { sandbox: null }), ctx);
    expect(noSandbox.spawner.calls.length).toBe(0);
    expect(noSandbox.outcome.codes).toContain(RefusalReason.SANDBOX_PROFILE_ABSENT);

    // 4. a fence whose own breach battery fails to deny every rule. Patched
    // LAST, so the three classes above ran against the real battery: a patch
    // installed first would have made every one of them refuse for this reason
    // instead of its own, and the enumeration would collapse into one case
    // asserted four times.
    patchSeam(
      spawnSeams,
      "runBattery",
      (fence) =>
        // Every probe kept, every decision flipped to "not denied": coverage is
        // intact and only the denial claim fails, which is the state `#admit`
        // turns into `battery-incomplete`.
        new BatteryReport(
          fence.role,
          runBattery(fence).results.map(
            (result) => new ProbeResult(result.probe, makeDecision({ denied: false })),
          ),
        ),
    );
    const unproven = refuse(ledger, document, ctx);
    expect(unproven.spawner.calls.length).toBe(0);
    expect(unproven.outcome.codes).toContain(REASON_BATTERY_INCOMPLETE);
  });

  test("the spawn module imports the renderer and the battery as values", () => {
    // The static half. Without it, deleting the call and satisfying the
    // behavioural assertion some other way -- an early return, a duplicated
    // inline check -- is not caught. This asserts the dependency is in the
    // import graph and is a VALUE import: `import type` erases at compile time,
    // so a spawn module that imported only the renderer's types would compile,
    // pass a shallow "does it mention the renderer" check, and reach no
    // precondition at runtime.
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "fencing", "spawn.ts"),
      "utf8",
    );
    expect(valueImportsOf(source, "./renderer.js")).toContain("renderFence");
    expect(valueImportsOf(source, "./battery.js")).toContain("runBattery");
    // And the precondition is reached from the spawn path through the seam
    // record, which is what the liveness case above proves is live.
    expect(source).toContain("spawnSeams.runBattery(");
  });
});

describe("a document's number spelling reaches settings.local.json (target-only, D-0211)", () => {
  // The hole this closes was invisible to every other case in the suite, and
  // that is the point of the case rather than an aside. D-0210 records a JSON
  // number's Python spelling on its CONTAINER SLOT, so every rebuild of a
  // container has to carry the record across. Three of the four rebuild sites
  // did; `deepSortKeys` did not -- and `settingsPayload` calls it as its LAST
  // step, so the repair stopped one call short of `fence.settings`, which is
  // exactly the payload that becomes `settings.local.json` and the persisted
  // fence. The readback half was sound the whole time. Only the RENDER half
  // diverged, which is the direction that writes a wrong file.
  //
  // Nothing pinned it because a spelling cannot be written in TypeScript: the
  // JavaScript literal `1.0` IS `1`, so a case that built the role body in code
  // would have carried no spelling into the document and would have passed
  // against the broken renderer. The value has to arrive as DOCUMENT TEXT,
  // which is why the body below is serialised, patched as text, and read back
  // through `loadDocument` -- the production read path -- rather than assembled
  // as an object.

  /**
   * The shipped document with `worker.env` carrying two numbers a JavaScript
   * literal cannot express, written as source text.
   *
   * The sentinel-and-replace is not a shortcut around building the object: it
   * is the only way to get a `1.0` and an exact `9007199254740993` INTO a
   * document from a test written in TypeScript. `JSON.parse` -- and every
   * object literal -- has already collapsed both by the time any assembled
   * value exists.
   */
  function documentWithNumericEnv(root: string): RoleDocument {
    const authored = mutate(fenceDocument(), "worker", {
      env: {
        // An integral float. CPython's `json.dumps` writes `1.0`; a port that
        // lost the spelling writes `1`.
        CONTINUO_INTEGRAL_FLOAT: "<<1.0>>",
        // 2**53 + 1, the smallest integer a double cannot hold. CPython writes
        // the digits back; a port that kept only the parsed value writes
        // `9007199254740992`.
        CONTINUO_BIG_INT: "<<9007199254740993>>",
      },
    });
    const text = pyJsonDumps(authored, { indent: 2 }).replaceAll(
      /"<<([^"]+)>>"/g,
      (_whole, literal: string) => literal,
    );
    const path = join(root, "roles-with-numeric-env.json");
    writeFileSync(path, text, "utf8");
    return loadDocument(path);
  }

  test("an integral float and an exact big integer survive to the written settings file", () => {
    const { root, ctx, ledger } = fixtures();
    const document = documentWithNumericEnv(root);
    const outcome = new FencedSpawner({ ledger, document }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    expect(outcome.admitted, JSON.stringify(outcome.reasons)).toBe(true);
    const plan = outcome.plan;
    expect(plan).not.toBeNull();
    if (plan === null) {
      return;
    }
    // BYTES, not a parsed value: `pyJsonLoads` of the file would collapse both
    // spellings again and the case would assert nothing. This is the same
    // reason the LF case in `restart-preserves-fence.test.ts` reads bytes.
    const written = readFileSync(plan.settingsPath, "utf8");
    expect(written).toContain('"CONTINUO_INTEGRAL_FLOAT": 1.0');
    expect(written).toContain('"CONTINUO_BIG_INT": 9007199254740993');
    // And the persisted fence, which the restart path compares BY BYTES, holds
    // the same two spellings -- it carries the same `settings` payload.
    const fence = readFileSync(plan.fencePath, "utf8");
    expect(fence).toContain('"CONTINUO_INTEGRAL_FLOAT": 1.0');
    expect(fence).toContain('"CONTINUO_BIG_INT": 9007199254740993');
  });

  test("the in-memory settings payload is where the spelling has to survive", () => {
    // The half above reads files, so it would also go green if the spelling
    // were re-attached somewhere on the way to disk. This one names the object
    // the repair is actually about: `fence.settings` is what `writeSettings`
    // serialises and what the restart diff compares, and it is the value
    // `deepSortKeys` returns.
    const { root, ctx, ledger } = fixtures();
    const document = documentWithNumericEnv(root);
    const outcome = new FencedSpawner({ ledger, document }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    const settings = outcome.fence?.settings;
    expect(settings).toBeDefined();
    expect(pyJsonDumps(settings, { sortKeys: true })).toContain('"CONTINUO_INTEGRAL_FLOAT": 1.0');
    // The parsed VALUE of the big integer is still the rounded double -- only
    // the digits are recovered, for re-emission. Stated here as well as in the
    // pyjson header so the case cannot be read as a claim of exact arithmetic.
    const env = (settings as Record<string, unknown>)["env"] as Record<string, unknown>;
    expect(env["CONTINUO_BIG_INT"]).toBe(9007199254740992);
  });

  test("a settings section that is itself a number keeps its spelling", () => {
    // The FIFTH rebuild site, found by asking the same question of the call one
    // level up: `settingsPayload` builds a new object out of `rendered`, so a
    // section whose value is a bare NUMBER leaves its spelling behind on
    // `rendered` exactly as `deepSortKeys` did. A section is normally a
    // mapping, whose spellings ride on the mapping object itself, so this is
    // the only shape that reaches the gap -- and it is the shape no other case
    // in the suite constructs.
    //
    // Measured before the carry existed: CPython writes `"env": 1.0` here and
    // this port wrote `"env": 1`.
    const { root, ctx, ledger } = fixtures();
    const authored = mutate(fenceDocument(), "worker", { env: "<<1.0>>" });
    const text = pyJsonDumps(authored, { indent: 2 }).replaceAll(
      /"<<([^"]+)>>"/g,
      (_whole, literal: string) => literal,
    );
    const path = join(root, "roles-with-scalar-env.json");
    writeFileSync(path, text, "utf8");
    const outcome = new FencedSpawner({ ledger, document: loadDocument(path) }).spawn(
      "worker",
      ctx,
      recordingSpawner(),
    );
    expect(outcome.admitted, JSON.stringify(outcome.reasons)).toBe(true);
    const plan = outcome.plan;
    expect(plan).not.toBeNull();
    if (plan === null) {
      return;
    }
    expect(readFileSync(plan.settingsPath, "utf8")).toContain('"env": 1.0');
  });

  test("the pair-sequence form of dict() carries spellings onto the published fence", () => {
    // `state.ts` writes the persisted fence through `pyDict(fence.settings)`,
    // and `pyDict` has TWO rebuild branches: a mapping copied key by key, and a
    // sequence of pairs. Only the first carried the record. The value in the
    // second arrives as element 1 of a PAIR, so its spelling was recorded on
    // the pair rather than on the mapping being built, and it was dropped.
    //
    // Not reachable from `FencedSpawner` -- a rendered fence always carries an
    // object -- but `Fence`, `fenceToJson` and `writeFence` are exported, which
    // is exactly where `pyDict`'s own note says its divergences live. Compared
    // against CPython rather than reasoned about: `dict([["x", 1.0]])` dumps
    // `{"x": 1.0}` there and dumped `{"x": 1}` here.
    const pairs = pyJsonLoads('[["x", 1.0], ["y", 9007199254740993], ["z", 2]]');
    expect(pyJsonDumps(pyDict(pairs), { sortKeys: true })).toBe(
      '{"x": 1.0, "y": 9007199254740993, "z": 2}',
    );
    // A repeated key takes the LAST value, so it has to take the last value's
    // spelling too -- including when the last value has none.
    expect(pyJsonDumps(pyDict(pyJsonLoads('[["x", 1.0], ["x", 2]]')))).toBe('{"x": 2}');
    expect(pyJsonDumps(pyDict(pyJsonLoads('[["x", 2], ["x", 1.0]]')))).toBe('{"x": 1.0}');
  });

  test("a number at a document root is typed by CPython's syntactic rule, and the residue is asserted", () => {
    // The type-name half of the root-slot boundary D-0210 records. A number at
    // the ROOT has no container to hang a spelling on, so `pyTypeName` has to
    // guess -- and the guess belongs to the DOCUMENT (which literal did CPython
    // read?), not to the serialiser (`pyNumberKind`, which classifies values
    // built in code and calls `-0` and anything past 2**53 a float). Sharing
    // the serialiser's fallback reported `9007199254740992` and `-0` as
    // `float`, where CPython says `int`.
    //
    // Reachable through `FenceLedger.refusals()`, which reports a corrupt
    // ledger line as `'<type>' object is not subscriptable` and persists that
    // sentence.
    //
    // CPython's answers below were MEASURED (`type(json.loads(t)).__name__`),
    // not recalled.
    for (const [text, expected] of [
      ["1", "int"],
      ["-0", "int"],
      ["9007199254740992", "int"],
      ["0.5", "float"],
      ["-0.5", "float"],
      // Legal JSON that overflows the double. CPython's float overflows to
      // `inf`, which is still a float on both sides.
      ["1e400", "float"],
    ] as const) {
      expect(pyTypeName(pyJsonLoads(text)), text).toBe(expected);
    }

    // THE RESIDUE, asserted in BOTH directions so it fails loudly rather than
    // licensing a divergence that has gone away: an integral float at a root is
    // the same double as the integer, no value-derived rule can tell them
    // apart, and this port answers `int` where CPython answers `float`. The
    // same three documents inside a CONTAINER answer correctly, which is the
    // control that says the boundary is the root slot and nothing wider.
    for (const text of ["1.0", "-0.0", "1e16"]) {
      expect(pyTypeName(pyJsonLoads(text)), text).toBe("int");
      const inside = pyJsonLoads(`{"n": ${text}}`) as Record<string, unknown>;
      expect(pyTypeNameOf(inside, "n"), text).toBe("float");
    }
  });

  test("a ledger payload's own number spellings survive the append", () => {
    // `FenceLedger.append` builds its entry as `{event, at, ...payload}`, and a
    // SPREAD is a rebuild like any other -- the seventh branch this decision
    // enumerates, and the only one on the live spawn path. Without the carry, a
    // caller handing it a document-derived payload got the numbers re-spelled
    // by JavaScript: `{"at": 1.0, "big": 9007199254740993}` was written as
    // `{"at": 1, "big": 9007199254740992.0}`.
    //
    // The record is built as ONE map rather than as a carry followed by the
    // `PY_FLOAT` assertion, because `rememberNumberSpellings` REPLACES the
    // record: asserting `at` after carrying would drop everything carried. Both
    // halves are asserted below, in the same case, for exactly that reason.
    const root = fenceCaseRoot();
    const supplied = fenceLedger(root, "supplied.jsonl");
    supplied.append(
      "candidate",
      pyJsonLoads('{"at": 1.0, "big": 9007199254740993}') as Record<string, unknown>,
    );
    expect(readFileSync(supplied.path, "utf8")).toBe(
      '{"at": 1.0, "big": 9007199254740993, "event": "candidate"}\n',
    );

    // The other half: with no `at` in the payload the clock's value is used, it
    // is built in CODE, and `time.time()` is a float on every platform -- so an
    // integral timestamp must still print `0.0`, which is the D-0210 repair
    // this carry must not have displaced.
    const clocked = new FenceLedger(join(root, "clocked.jsonl"), { clock: () => 0 });
    clocked.append(
      "candidate",
      pyJsonLoads('{"big": 9007199254740993}') as Record<string, unknown>,
    );
    expect(readFileSync(clocked.path, "utf8")).toBe(
      '{"at": 0.0, "big": 9007199254740993, "event": "candidate"}\n',
    );
  });
});

/**
 * The two halves of the one rebuild branch that deliberately does NOT carry.
 *
 * D-0211 enumerated the rebuild sites and made every one of them carry the
 * number record. D-0212 swept `src/fencing` mechanically instead of reading
 * that enumeration, and found one more: `pyIterate`'s array branch returns
 * `[...value]`, which drops the index-keyed record like any other rebuild.
 *
 * It is left uncarried ON PURPOSE, so what stands in for the carry is a proof,
 * and a proof that nothing checks is a sentence. These are the checks. The
 * first measures the drop, so a future carry is a deliberate change rather than
 * a silent one; the second and third are the proof's two premises, each of
 * which fails loudly when it stops holding.
 */
describe("pyIterate's array branch drops the record, provably harmlessly (target-only, D-0212)", () => {
  test("the drop is real, and would be a divergence if a result were ever dumped", () => {
    // The measurement behind the enumeration entry, kept executable so the
    // entry cannot quietly become false. CPython's `json.dumps(list(x))` is
    // `[1.0, 9007199254740993]` -- there the spelling lives in the VALUE, so
    // `list()` cannot lose it. Here it lives on the container, so a copy starts
    // empty. Confirmed against CPython 3.12.3.
    const source = pyJsonLoads("[1.0, 9007199254740993]") as unknown[];
    expect(pyJsonDumps(source)).toBe("[1.0, 9007199254740993]");
    expect(pyJsonDumps(pyIterate(source))).toBe("[1, 9007199254740992.0]");
  });

  test("no consumer of a pyIterate result can reach a serialiser: the call sites are these", () => {
    // The first premise. `pyIterate` is safe because its consumer set is small
    // enough to have been checked one by one, not because copying is harmless
    // -- the case above shows it is not. So the SET is what has to hold, and a
    // new call site has to be classified before it can be added.
    //
    // The DIRECTORY is read rather than a list of file names being checked,
    // and that is the difference between a check and a decoration. An
    // allowlist only ever sees the files somebody thought to name, so a call
    // site added to a file that is not on it -- or to a file that did not
    // exist when the list was written -- passes silently, which is the exact
    // failure mode this case exists to catch, reproduced inside the case.
    //
    // Every REFERENCE to the identifier is counted, not every occurrence of the
    // text `pyIterate(`. The two differ exactly where it matters: `const it =
    // pyIterate; it(value)` and `values.map(pyIterate)` are consumers that the
    // call spelling never sees, and a consumer this case cannot see is a
    // consumer nobody classified. Counting references makes both of them move a
    // number.
    //
    // Comments are stripped first. They mention the name freely -- this
    // subsystem explains itself at length -- and a case that fired when someone
    // fixed a typo in a comment would be turned off rather than read.
    //
    // Counted per file rather than per line so that moving code within a file
    // does not fire this, and so that what fires is the thing that matters: a
    // reference nobody has traced to its consumer.
    const dir = join(import.meta.dirname, "..", "..", "src", "fencing");
    const counts: [string, number][] = [];
    for (const file of readdirSync(dir).sort()) {
      // `.mjs` too: the deny hook is JavaScript and is shipped from this
      // directory, so a reference there would be as real as any other.
      if (!file.endsWith(".ts") && !file.endsWith(".mjs")) {
        continue;
      }
      const code = readFileSync(join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
      const references = (code.match(/\bpyIterate\b/g) ?? []).length;
      if (references > 0) {
        counts.push([file, references]);
      }
    }
    // `renderer.ts` 5 = one import specifier + four calls: the permission-mode
    // list, `forbidden_allow_exact`, `forbidden_allow_regex` and a hook group,
    // all ending in `pyRepr`, `pyStr` or set membership. `state.ts` 2 = one
    // import specifier + the persisted rule list, whose elements become
    // all-string `FenceRule`s. `pysemantics.ts` 3 = the declaration + `pyDict`'s
    // own two, which read each spelling off `items[index]` -- the ORIGINAL
    // element, never the copy -- which is exactly this drop, already handled.
    //
    // A new FILE referencing the name adds a row here, and a new reference in
    // one of these three changes its count; either way the enumeration in
    // `pyjson.ts`'s header has to be re-read before the suite goes green.
    expect(counts).toStrictEqual([
      ["pysemantics.ts", 3],
      ["renderer.ts", 5],
      ["state.ts", 2],
    ]);
  });

  test("pysemantics is not on the package surface, so those call sites are all of them", () => {
    // The second premise, and the one that separates `pyIterate` from `pyDict`.
    // `pyDict` had to be repaired by D-0211 even though `FencedSpawner` never
    // reaches its pair branch, because `Fence`, `fenceToJson` and `writeFence`
    // ARE exported -- so a caller outside this repository can reach it and the
    // call-site enumeration above would not bound anything.
    //
    // `pysemantics` is deliberately absent from the package surface
    // (`src/index.ts` says so, with its reasons). Export it, and the proof
    // above stops being a proof on the same day -- so the absence is asserted
    // here rather than left as a property of a file nobody diffs against this
    // one.
    //
    // Asserted by IDENTITY against the entry module's actual exports, not by
    // grepping `src/index.ts` for a `from` string. A grep answers "is this
    // module named here", and the premise needs "can a caller outside this
    // repository reach these functions" -- which a re-export through some other
    // barrel, or a renamed binding, satisfies without the name ever appearing.
    // Comparing the exported VALUES catches every spelling of a re-export,
    // because whatever route it takes it arrives as the same function object.
    const surface = new Set(Object.values(api));
    for (const [name, value] of Object.entries(semantics)) {
      expect(
        surface.has(value),
        `src/index.ts re-exports pysemantics.${name}; D-0212's proof for pyIterate assumed it could not`,
      ).toBe(false);
    }
    // The other route to the same reachability: a subpath export in
    // `package.json` pointing at the module directly, which needs no line in
    // `src/index.ts` at all. The package deliberately publishes one entry point
    // and its manifest.
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(manifest.exports).sort()).toStrictEqual([".", "./package.json"]);
  });
});

/**
 * The binding names a module imports from `specifier` as VALUES.
 *
 * Type-only imports are excluded in both spellings TypeScript offers -- a
 * whole-statement `import type { ... } from` and a per-specifier `type X` --
 * because neither exists at runtime and neither can carry a call.
 */
function valueImportsOf(source: string, specifier: string): string[] {
  const names: string[] = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)";/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined || match[3] !== specifier) {
      continue;
    }
    for (const clause of (match[2] ?? "").split(",")) {
      const name = clause.trim();
      if (name !== "" && !name.startsWith("type ")) {
        names.push(name.split(/\s+as\s+/)[0] ?? name);
      }
    }
  }
  return names;
}
