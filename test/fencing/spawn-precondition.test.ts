import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  BatteryReport,
  ProbeResult,
  ProbeSynthesisError,
  runBattery,
} from "../../src/fencing/battery.js";
import { pyJsonLoads } from "../../src/fencing/pyjson.js";
import { type FenceContext, RefusalReason, type RoleDocument } from "../../src/fencing/renderer.js";
import { makeDecision } from "../../src/fencing/rules.js";
import {
  EVENT_ADMITTED,
  FencedSpawner,
  type FenceLedger,
  REASON_BATTERY_INCOMPLETE,
  REASON_PROBE_UNSYNTHESIZABLE,
  type SpawnOutcome,
  spawnSeams,
} from "../../src/fencing/spawn.js";
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
