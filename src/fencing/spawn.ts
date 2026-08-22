/**
 * Interlock's own fail-closed spawn precondition.
 *
 * D-0023 part 2: "Interlock validates the rendered per-role configuration and
 * refuses to spawn on a broken one". The obligation is Interlock's under D-0017
 * *regardless of provider*, which is why this file survived the C1 -> C2 switch
 * unchanged in intent while #8 did not survive at all.
 *
 * The shape that matters is negative: on a broken configuration the spawner
 * callable is **never invoked**. Not invoked with a narrowed fence, not invoked
 * with a warning logged -- not invoked. A downgraded spawn is the failure mode
 * the criterion names, and it is the one a "best effort" renderer produces.
 *
 * Three brokenness classes are named by issue #9 and each has a test:
 *
 * | broken configuration    | caught by                                 |
 * | ----------------------- | ----------------------------------------- |
 * | config deleted          | `document-unreadable` / `role-absent`     |
 * | hook path unresolvable  | `hook-unresolvable`                       |
 * | sandbox profile absent  | `sandbox-profile-absent`                  |
 *
 * A fourth is caught here rather than in the renderer: a fence that renders
 * cleanly but whose own breach battery does not deny every rule. That is a
 * self-check, and it refuses the spawn too -- shipping a fence Interlock cannot
 * itself prove is the same class of error as shipping no fence.
 *
 * Ported from interlock `src/claude_org_runtime/fencing/spawn.py` at `65f36c5`.
 *
 * ## How the negative shape is expressed in an ESM module graph (D-0205)
 *
 * interlock#71's canary acceptance is not satisfied by a precondition that
 * exists; it asks for one that is WIRED into the production spawn path. In
 * Python that wiring is a property of the module -- `FencedSpawner.spawn` calls
 * `self._admit(...)` and nothing else reaches the spawner -- and it is written
 * down nowhere a test can read. D-0205 re-expresses it as two obligations, and
 * this file carries the half that is source code:
 *
 * - {@link FencedSpawner.spawn} is the ONLY exported way to reach the injected
 *   spawner callable, and it calls the admission step directly rather than
 *   through a registry, a configuration key or an import-time side effect. The
 *   dependency is therefore visible in the import graph and survives being
 *   read.
 * - The admission step is a `#private` method. A caller cannot reach a
 *   {@link SpawnPlan} without going through it, and a later refactor that adds
 *   a second way to start a child cannot quietly bypass it -- there is no
 *   exported entry point to bypass it WITH.
 *
 * The other half is a target-only test that drives this entry point with a
 * deliberately broken configuration and asserts the spawner's call count is
 * exactly zero, plus a static check on the import graph. It lands with this
 * lane's ported cases and is recorded as target-only in the parity ledger.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type BatteryReport, ProbeSynthesisError, runBattery } from "./battery.js";
import { pyJsonDumps, pyJsonLoads } from "./pyjson.js";
import { isPlainObject, PyTypeError, pyStrip, pyTypeName } from "./pysemantics.js";
import {
  type FenceContext,
  FenceRefusal,
  RefusalReason,
  type RoleDocument,
  renderFence,
} from "./renderer.js";
import type { Fence } from "./rules.js";
import { PyKeyError, writeAllSync, writeFence } from "./state.js";

/**
 * Best effort: not every platform lets a directory be opened for fsync.
 *
 * Node inherits the same constraint from the same syscalls -- Windows has no
 * notion of syncing a directory entry and `openSync` on a directory fails there
 * outright -- so this stays best effort rather than becoming an error. A
 * platform that cannot sync its directory is not a platform on which the ledger
 * should refuse to append.
 */
function fsyncDir(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Deliberately swallowed, exactly as the source swallows its second
    // OSError: some filesystems (and every Windows one) reject fsync on a
    // directory handle even when opening it succeeded.
  } finally {
    closeSync(fd);
  }
}

export const EVENT_ADMITTED = "spawn-admitted";
export const EVENT_REFUSED = "spawn-refused";
export const EVENT_BATTERY = "battery-run";

export const REASON_BATTERY_INCOMPLETE = "battery-incomplete";
export const REASON_PROBE_UNSYNTHESIZABLE = "probe-unsynthesizable";

/**
 * The module internals interlock's spawn cases replace (D-0014).
 *
 * Two ported cases -- `test_a_rule_whose_probe_cannot_be_synthesized_refuses_
 * and_is_recorded` and `test_a_fence_that_fails_its_own_battery_refuses_the_
 * spawn` -- do `monkeypatch.setattr(spawn_module, "run_battery", ...)`. In
 * Python that works because a module-level name is resolved at CALL time
 * through the module dictionary, so rebinding the entry changes what the caller
 * *inside* this module sees next. ESM has no equivalent: bindings are fixed at
 * link time and cannot be rebound from outside, and `vi.mock` does not reach
 * this case either -- it replaces a module for its IMPORTERS, and an
 * intra-module call has no importer to intercept.
 *
 * Both cases are load-bearing rather than incidental. A battery that cannot
 * synthesise a probe, and a battery that reports a breach, are the two states
 * that make `#admit` refuse on a fence that RENDERED cleanly -- the fourth
 * brokenness class in this file's header, the one the renderer cannot catch. A
 * fence is not reachable in either state through a role document, so without
 * this record the only ways to reach them are to rewrite the cases around a new
 * injected parameter (which changes the production call graph, and then the
 * test proves something about a test-only path) or to drop them.
 *
 * `runBattery` is the whole record, and that is measured, not assumed: grepping
 * `tests/fencing/` for `monkeypatch.setattr` finds exactly three targets --
 * `spawn_module.run_battery` (here), `FencedSpawner._write_settings` (patched
 * on the CLASS, and reachable already because {@link FencedSpawner.writeSettings}
 * is exposed and `@internal` under D-0101) and `hook_module.read_fence` (which
 * `hook.mjs` carries as `hookSeams`). `write_fence` is patched by no case.
 *
 * EVERY internal call site goes THROUGH this record --
 * `spawnSeams.runBattery(...)`, never the imported binding -- because a seam
 * nothing routes through is decoration: the patch would install cleanly, the
 * case would go green, and it would be exercising the real battery the whole
 * time. That property needs its own target-only liveness test.
 *
 * Not re-exported from `src/index.ts`: a seam for this module's tests, not
 * public API.
 */
export const spawnSeams = {
  /** @see ../fencing/battery.ts */
  runBattery,
};

/**
 * The deny hook's own file, as an absolute path.
 *
 * `hook.mjs`, not `hook.py` and not `hook.ts`: the hook is launched as a
 * subprocess by path, Node 22 (a required CI cell) cannot execute a `.ts` file
 * unflagged, and the renderer refuses with `hook-unresolvable` when the token
 * does not name a file that exists. D-0204 records that decision in full.
 *
 * `fileURLToPath`, never `URL.pathname`. `.pathname` is the URL's ENCODED path
 * component and it fails in two separate ways this project is already on notice
 * for: on Windows it yields a leading-slash form (`/C:/checkout/hook.mjs`) that
 * every filesystem call rejects, and on EVERY platform it is percent-encoded,
 * so a checkout under a directory containing a space resolves to
 * `.../my%20worker/hook.mjs`. Either one makes the fence refuse to render for a
 * hook that is present and correct. PR 1 fixed exactly this bug in
 * `bundledDocumentPath`.
 *
 * -- DEVIATION, small and deliberate -- the source is
 * `Path(__file__).resolve().with_name("hook.py")`, and `.resolve()` also
 * canonicalises SYMLINKS. This does not, because the Node equivalent
 * (`realpathSync`) THROWS when the target does not exist, where CPython's
 * `resolve()` (non-strict since 3.6) returns the path unchanged. Adding it
 * would convert the renderer's `hook-absent` refusal -- a fence that refuses,
 * loudly, with a reason an operator can read -- into an unhandled exception
 * inside the ledger transaction. `import.meta.url` is already absolute, which
 * is the part of `.resolve()` that this caller depends on; the symlink
 * canonicalisation is observable only when the package is reached through a
 * symlinked path (`npm link`), and then only in the spelling of the hook
 * command, never in which file runs.
 */
export function defaultHookScript(): string {
  return fileURLToPath(new URL("./hook.mjs", import.meta.url));
}

/** One `(code, detail)` pair as the ledger records it. */
export type SpawnReason = readonly [string, string];

/**
 * Append-only JSONL record of spawn admissions and refusals.
 *
 * "Recorded durably" is taken literally: every event is flushed and `fsync`ed
 * before the caller is told anything, because a refusal lost on crash is a
 * refusal that was not recorded -- and the crash is precisely the moment the
 * record is wanted.
 */
export class FenceLedger {
  readonly path: string;
  readonly #clock: () => number;

  constructor(path: string, options?: { readonly clock?: () => number }) {
    this.path = path;
    // `time.time()`: seconds since the epoch as a float. `Date.now()` is
    // milliseconds as an integer, so the division is what puts the value in the
    // source's unit -- a ledger recording milliseconds would compare against an
    // interlock ledger as though every event happened in the year 57000.
    // The resolution differs (CPython offers microseconds, `Date.now()` whole
    // milliseconds); nothing in this subsystem measures a sub-millisecond
    // interval, and `at` is a record, not a clock read a decision turns on.
    this.#clock = options?.clock ?? (() => Date.now() / 1000);
  }

  /**
   * Run `body` inside the ledger's mutual exclusion.
   *
   * ## The cross-process lock is NOT reproduced, and this is the honest reason
   *
   * The source has two branches. On POSIX it takes an exclusive `flock` on a
   * `.lock` sibling for the whole admission, so two Interlock processes cannot
   * render, prove, publish and record for the same fence path at the same time.
   * On Windows `fcntl` is `None` -- imported under `try`/`except ImportError`
   * -- and the branch degrades to the in-process lock alone.
   *
   * Node has no `flock` in its standard library at all, on any platform. So the
   * choice is between three things, and none of them is a translation:
   *
   * 1. take the source's own `fcntl is None` branch everywhere (what this does);
   * 2. invent a lockfile protocol out of `openSync(..., "wx")`;
   * 3. add a native dependency that exposes `flock(2)`.
   *
   * (2) is rejected rather than merely not chosen. `flock` is released by the
   * KERNEL when the holder dies; an `O_EXCL` lockfile is not. A spawner killed
   * with SIGKILL -- which is what a crash looks like, and the crash is exactly
   * the scenario this ledger exists for -- would leave a lock file that every
   * later process waits on, and the operation left waiting is the recording of
   * a REFUSAL, which the source's own comment says "must never wait". Trading a
   * concurrency window for a permanent deadlock on the fail-closed path makes
   * the guarantee worse, not better. (3) is not a translator's call: it adds a
   * runtime dependency and a build step to a package whose dependency surface
   * is a recorded decision.
   *
   * What is lost, stated plainly so nobody has to infer it: two continuo
   * processes publishing a fence to the SAME path concurrently can interleave.
   * Each ledger LINE is still atomic (a single `O_APPEND` write below the pipe
   * buffer), so no record is torn or lost; what can interleave is the
   * publish-then-record sequence, so the fence on disk could be the loser's
   * while both admissions are recorded. Within one process there is no window
   * at all: every call here is synchronous, so `body` runs to completion before
   * any other JavaScript does, which is what the source's `threading.RLock`
   * buys and the reason it has no counterpart in this file.
   *
   * ESCALATED, not decided: whether continuo needs a real cross-process lock
   * (and therefore (3), or a documented single-writer deployment constraint) is
   * an operator decision about how Interlock is run, not a fidelity question a
   * translator can settle. Until it is settled this file behaves exactly as
   * interlock does on Windows.
   */
  transaction<T>(body: () => T): T {
    return body();
  }

  append(event: string, payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const entry: Record<string, unknown> = { event, at: this.#clock(), ...payload };
    mkdirSync(dirname(this.path), { recursive: true });
    // `fsync` on a *newly created* file does not promise its directory entry
    // survives a power loss -- the bytes would be on disk under a pathname that
    // no longer exists. The parent is synced on creation so a refusal recorded
    // seconds before a crash is still there afterwards.
    const isNew = !exists(this.path);
    // `sortKeys`, so the line's bytes do not depend on which caller built the
    // payload, and `pyJsonDumps` rather than `JSON.stringify` so a numeric-
    // looking key sorts the way CPython sorts it. See `./pyjson.js`.
    const line = `${pyJsonDumps(entry, { sortKeys: true })}\n`;
    // `newline=""` in the source pins the JSONL record separator to the `\n`
    // written above rather than a platform-dependent CRLF, matching
    // `curator.ledger.ApprovalLedger`. Node performs no newline translation, so
    // writing the bytes of the string is that guarantee; the descriptor (rather
    // than `appendFileSync`) is what makes the `fsync` below possible at all.
    const handle = openSync(this.path, "a");
    try {
      // `writeAllSync`, never a bare `writeSync`: a short write here appends a
      // TRUNCATED JSONL record, which `events()` then fails to parse -- and the
      // record most likely to be lost that way is a refusal, the one durable
      // trace of a spawn that was already going wrong. See `writeAllSync`.
      writeAllSync(handle, Buffer.from(line, "utf8"));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    if (isNew) {
      fsyncDir(dirname(this.path));
    }
    return entry;
  }

  events(): Record<string, unknown>[] {
    if (!exists(this.path)) {
      return [];
    }
    const text = readFileSync(this.path, "utf8");
    // Python iterates the file in TEXT mode, whose universal-newline handling
    // turns `\r\n` and a lone `\r` into line breaks as well as `\n`. Splitting
    // on `\n` alone would hand a `\r`-terminated ledger to `JSON.parse` as one
    // enormous line. `line.strip()` is `pyStrip`, which strips the Python
    // whitespace set, not JavaScript's.
    return text
      .split(/\r\n|\n|\r/)
      .filter((line) => pyStrip(line) !== "")
      .map((line) => pyJsonLoads(line) as Record<string, unknown>);
  }

  refusals(): Record<string, unknown>[] {
    return this.events().filter((entry) => {
      // `entry["event"]` in the source, which raises `KeyError` on a line that
      // carries no `event` key. Reproduced rather than softened to a miss: a
      // ledger line without an `event` is a corrupt durable record, and reading
      // past it would report "no refusals" for a file whose contents nobody can
      // account for -- the fail-open direction on the one query an operator
      // runs after a crash.
      // The source SUBSCRIPTS (`entry["event"]`), and a subscript raises two
      // different exceptions depending on what the line turned out to be. Both
      // are reproduced, because the TYPE is what a caller routes on -- a
      // reviewer measured this and found the two collapsed into one:
      //
      //   line            CPython                                            here
      //   {"role": "w"}   KeyError: 'event'                                  PyKeyError
      //   [1, 2]          TypeError: list indices must be integers or ...    PyTypeError
      //   7               TypeError: 'int' object is not subscriptable       PyTypeError
      //   "x"             TypeError: string indices must be integers, ...    PyTypeError
      //   null            TypeError: 'NoneType' object is not subscriptable  PyTypeError
      //
      // Raising rather than skipping is the point either way: a ledger line
      // that is not an object is a corrupt durable record, and reading past it
      // would report "no refusals" for a file whose contents nobody can account
      // for -- the fail-open direction on the one query an operator runs after
      // a crash.
      if (!isPlainObject(entry)) {
        throw new PyTypeError(subscriptTypeErrorMessage(entry));
      }
      if (!Object.hasOwn(entry, "event")) {
        // `PyKeyError`, not a bare `Error`: the message is
        // `str(KeyError('event'))`, which is `'event'` WITH the quotes --
        // `KeyError.__str__` reprs its key -- and `PyKeyError` is the single
        // transcription of that rendering.
        throw new PyKeyError("event");
      }
      return entry["event"] === EVENT_REFUSED;
    });
  }
}

/**
 * CPython's message for subscripting a non-subscriptable value with a string.
 *
 * The wording differs per type, and the ported ledger cases assert on it, so
 * the three shapes a JSONL line can actually take are spelled out rather than
 * collapsed into one generic sentence.
 */
function subscriptTypeErrorMessage(value: unknown): string {
  if (Array.isArray(value)) {
    return "list indices must be integers or slices, not str";
  }
  if (typeof value === "string") {
    return "string indices must be integers, not 'str'";
  }
  return `'${pyTypeName(value)}' object is not subscriptable`;
}

/** What a spawner is handed once, and only once, the fence is sound. */
export class SpawnPlan {
  readonly role: string;
  readonly fence: Fence;
  readonly settingsPath: string;
  readonly fencePath: string;
  readonly context: FenceContext;

  constructor(init: {
    role: string;
    fence: Fence;
    settingsPath: string;
    fencePath: string;
    context: FenceContext;
  }) {
    this.role = init.role;
    this.fence = init.fence;
    this.settingsPath = init.settingsPath;
    this.fencePath = init.fencePath;
    this.context = init.context;
    // Frozen dataclass in the source. The plan is the authority the spawner
    // acts on: a plan editable after admission would let a caller widen the
    // fence a child starts under without going through the precondition, which
    // is the whole property this module defends.
    Object.freeze(this);
  }

  /**
   * The public-CLI flags this fence renders to (D-0010).
   *
   * `--permission-mode` is passed explicitly rather than left to the settings
   * file, because i01 section 3.9 showed `permissionMode` is the one part of
   * the fence the provider reads back -- so it is the one part a restart can be
   * checked against directly.
   */
  cliArgs(): string[] {
    return ["--settings", this.settingsPath, "--permission-mode", this.fence.permissionMode];
  }
}

export class SpawnOutcome {
  readonly admitted: boolean;
  readonly role: string;
  readonly fence: Fence | null;
  readonly plan: SpawnPlan | null;
  readonly result: unknown;
  readonly reasons: readonly SpawnReason[];
  readonly battery: BatteryReport | null;

  constructor(init: {
    admitted: boolean;
    role: string;
    fence?: Fence | null;
    plan?: SpawnPlan | null;
    result?: unknown;
    reasons?: readonly SpawnReason[];
    battery?: BatteryReport | null;
  }) {
    this.admitted = init.admitted;
    this.role = init.role;
    // The source's dataclass defaults are `None`, `None`, `None`, `()`, `None`.
    // `null` rather than `undefined` for each, so `outcome.fence` reads the
    // same whether the field was defaulted or passed -- `exactOptionalPropertyTypes`
    // otherwise makes "absent" and "present and null" two distinguishable
    // states where Python has one.
    this.fence = init.fence ?? null;
    this.plan = init.plan ?? null;
    this.result = init.result ?? null;
    this.reasons = Object.freeze([...(init.reasons ?? [])]);
    this.battery = init.battery ?? null;
    Object.freeze(this);
  }

  get codes(): readonly string[] {
    return this.reasons.map(([code]) => code);
  }
}

/**
 * Renders, validates, publishes and only then spawns.
 *
 * `spawner` is injected so the precondition is testable without a real
 * `claude -p` child; the live probe that exercises the real one lives in
 * `investigation/i04_pretooluse_probe.py`. Under D-0205 that injection point is
 * also what the canary acceptance is asserted on -- call count exactly zero on
 * a broken configuration -- and it is a production parameter, not a test seam.
 */
export class FencedSpawner {
  readonly ledger: FenceLedger;
  readonly document: RoleDocument | undefined;
  readonly settingsName: string;

  // NOT PORTED: the source declares `_last_battery: BatteryReport | None` with
  // `init=False, repr=False` and then never reads or writes it, anywhere in
  // interlock. A field nothing observes has no behaviour to reproduce, and
  // carrying it would trip biome's `noUnusedPrivateClassMembers` -- so it is
  // recorded here instead, where a reader comparing the two files finds the
  // answer rather than a discrepancy.

  constructor(init: {
    ledger: FenceLedger;
    document?: RoleDocument | undefined;
    settingsName?: string;
  }) {
    this.ledger = init.ledger;
    this.document = init.document;
    this.settingsName = init.settingsName ?? "settings.local.json";
  }

  /**
   * Admit or refuse, then -- only if admitted -- start the child.
   *
   * The child is started **outside** the ledger transaction. A synchronous
   * spawner (`subprocess.run` on a `claude -p` session) would otherwise hold
   * the cross-process lock for the entire session, and every other role would
   * block on it -- including roles trying to record a *refusal*, which is the
   * one thing that must never wait.
   */
  spawn(role: string, ctx: FenceContext, spawner: (plan: SpawnPlan) => unknown): SpawnOutcome {
    const outcome = this.#admit(role, ctx);
    if (!outcome.admitted) {
      return outcome;
    }
    const plan = outcome.plan;
    if (plan === null) {
      // Unreachable: `#admit` returns `admitted: true` only alongside a plan.
      // A non-null assertion would silence the compiler and, on the day that
      // stops being true, hand the spawner a `null` plan -- a child started
      // with no fence, which is the exact outcome this module exists to make
      // impossible. Raising is the fail-closed direction.
      throw new Error("internal: admitted outcome carries no plan");
    }
    return new SpawnOutcome({
      admitted: true,
      role: outcome.role,
      fence: outcome.fence,
      plan,
      result: spawner(plan),
      battery: outcome.battery,
    });
  }

  #admit(role: string, ctx: FenceContext): SpawnOutcome {
    return this.ledger.transaction(() => {
      let fence: Fence;
      try {
        // `document=None` in the source means "load the bundled document", and
        // `renderFence` spells that as an absent option. Passing
        // `{ document: undefined }` is a different thing under
        // `exactOptionalPropertyTypes`, hence the branch.
        fence =
          this.document === undefined
            ? renderFence(role, ctx)
            : renderFence(role, ctx, { document: this.document });
      } catch (exc) {
        if (exc instanceof FenceRefusal) {
          return this.#refuse(role, exc.reasons);
        }
        throw exc;
      }

      let battery: BatteryReport;
      try {
        // Through the seam, never through the imported binding: see spawnSeams.
        battery = spawnSeams.runBattery(fence);
      } catch (exc) {
        // A rule the battery cannot aim a probe at is a rule nothing observes.
        // Letting this escape would skip the durable record entirely, so it
        // refuses like any other unprovable fence.
        if (exc instanceof ProbeSynthesisError) {
          return this.#refuse(role, [[REASON_PROBE_UNSYNTHESIZABLE, exc.message]]);
        }
        throw exc;
      }
      this.ledger.append(EVENT_BATTERY, {
        role,
        probes: battery.results.length,
        all_denied: battery.allDenied,
      });
      if (!battery.allDenied) {
        const unproven = battery.breaches.map((result) => result.probe.ruleId);
        return this.#refuse(
          role,
          [
            [
              REASON_BATTERY_INCOMPLETE,
              `fence rendered but did not deny its own probes: ${unproven.join(", ")}`,
            ],
          ],
          battery,
        );
      }

      // Publication is all-or-nothing. A fence left on disk by a spawn that was
      // then refused would be read by the hook on the next start and enforced
      // as though it had been admitted -- the refusal invariant says nothing is
      // published, and half of something is not nothing.
      // A fence may already be live at this path from an earlier admitted
      // session. Unlinking the replacement on failure would leave that session
      // with no fence at all -- every hook call denying until the next
      // successful publication -- so the previous bytes are kept and restored.
      //
      // `readFileSync` is OUTSIDE the try below in the source too: `is_file()`
      // swallows its own errors, but a read that fails after it succeeded (a
      // permission change, a race) raises out of `_admit` rather than becoming
      // a refusal. Reproduced, because a rollback that cannot know the previous
      // bytes must not proceed as though there were none.
      const previous = isFile(ctx.fencePath) ? readFileSync(ctx.fencePath) : null;
      let fencePath: string | null = null;
      let settingsPath: string | null = null;
      try {
        fencePath = writeFence(fence, ctx.fencePath);
        settingsPath = this.writeSettings(fence, ctx);
      } catch (exc) {
        if (!isOSError(exc)) {
          throw exc;
        }
        if (fencePath !== null) {
          try {
            if (previous === null) {
              unlinkSync(fencePath);
            } else {
              // `Path.write_bytes`: truncate and write, no fsync -- the source
              // does not sync the rollback either, and adding one here would
              // make the restored file MORE durable than the file it restores.
              writeFileSync(fencePath, previous);
            }
          } catch (rollbackExc) {
            if (!isOSError(rollbackExc)) {
              throw rollbackExc;
            }
            // The rollback itself failed, so the refusal must say so: an
            // operator has a stale fence to remove by hand.
            return this.#refuse(role, [
              [
                RefusalReason.DOCUMENT_UNREADABLE,
                `cannot publish fence: ${describe(exc)}; and the partially ` +
                  `published fence at ${fencePath} could not be ` +
                  `rolled back -- restore it before the next spawn`,
              ],
            ]);
          }
        }
        return this.#refuse(role, [
          [RefusalReason.DOCUMENT_UNREADABLE, `cannot publish fence: ${describe(exc)}`],
        ]);
      }
      if (fencePath === null || settingsPath === null) {
        // Unreachable: the try above either assigns both or the catch returns.
        // TypeScript's definite-assignment analysis cannot see that through a
        // `try`, and this is the fail-closed way to say so.
        throw new Error("internal: publication left a path unset");
      }

      const plan = new SpawnPlan({ role, fence, settingsPath, fencePath, context: ctx });
      this.ledger.append(EVENT_ADMITTED, {
        role,
        rules: fence.rules.length,
        permission_mode: fence.permissionMode,
        fence_path: fencePath,
        settings_path: settingsPath,
      });
      return new SpawnOutcome({ admitted: true, role, fence, plan, battery });
    });
  }

  /**
   * `_write_settings`: the child's `settings.local.json`, beside the fence.
   *
   * @internal Not package API. It is a method rather than a module-private
   * function, and not a `#private` one, because interlock's spawn cases replace
   * it on the class (`monkeypatch.setattr(FencedSpawner, "_write_settings", ...)`)
   * to drive the two publication-rollback cases -- a failed settings write is
   * otherwise unreachable without filling a disk. D-0101 covers exactly this:
   * a module-private name a source case reaches is exposed and marked
   * `@internal` rather than having the case rewritten around it, because the
   * rewrite is what turns a ported case into a target-only one.
   */
  writeSettings(fence: Fence, ctx: FenceContext): string {
    // `Path(ctx.fence_path).parent / self.settings_name`. pathlib's `/` lets an
    // ABSOLUTE right-hand side replace the left entirely, and `join` does not,
    // so the absolute case is spelled out: a caller who sets `settingsName` to
    // an absolute path writes there in interlock, and would write inside the
    // fence directory here.
    const path = isAbsolute(this.settingsName)
      ? this.settingsName
      : join(dirname(ctx.fencePath), this.settingsName);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const body = `${pyJsonDumps(fence.settings, { sortKeys: true, indent: 2 })}\n`;
    const handle = openSync(tmp, "w");
    try {
      // Full write BEFORE the fsync, and the rename is after the `try`: a short
      // write throws out of this block, so the `renameSync` below is
      // unreachable from a partially written temp file. Without the loop a
      // truncated `settings.local.json` -- one that can have lost its `hooks`
      // block entirely -- would be fsynced, renamed into place and recorded as
      // an ADMITTED spawn, launching a child with no deny hook. See
      // `writeAllSync` in `./state.js`.
      writeAllSync(handle, Buffer.from(body, "utf8"));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    // `os.replace`: atomic replace-if-exists on both platforms. See the note
    // in `state.writeFence` -- `renameSync` is the same call underneath.
    renameSync(tmp, path);
    return path;
  }

  #refuse(role: string, reasons: readonly SpawnReason[], battery?: BatteryReport): SpawnOutcome {
    this.ledger.append(EVENT_REFUSED, {
      role,
      reasons: reasons.map(([code, detail]) => ({ code, detail })),
    });
    return new SpawnOutcome({
      admitted: false,
      role,
      reasons,
      battery: battery ?? null,
    });
  }
}

/**
 * `Path.exists()`: false for anything that cannot be stat'ed, never a raise.
 *
 * `existsSync` has precisely that contract -- it follows symlinks and answers
 * false on any error -- which is why it is used rather than a `statSync`
 * wrapped in a `try`.
 */
function exists(path: string): boolean {
  return existsSync(path);
}

/** `Path.is_file()`: false for a directory, a missing path, or an EACCES. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a caught error is what CPython would have raised as `OSError`.
 *
 * The `except OSError` around the publication is a NARROW catch and has to stay
 * narrow: `pyJsonDumps` raises `PyTypeError` for a settings payload carrying a
 * value JSON cannot represent, and CPython's `json.dumps` raises `TypeError`
 * there too -- neither is caught, and both must escape rather than being
 * recorded as `cannot publish fence`, which would tell an operator to look at
 * the disk for a bug in the document.
 *
 * Node marks filesystem failures with a string `code` (`ENOENT`, `EACCES`,
 * `ENOSPC`) on an `Error`, which is the only classification available; a plain
 * `Error` thrown by a test double therefore does NOT look like an `OSError`
 * here, and the ported cases construct one accordingly.
 */
function isOSError(exc: unknown): boolean {
  return exc instanceof Error && typeof (exc as NodeJS.ErrnoException).code === "string";
}

/** `str(exc)`: CPython's `str` of an exception never prefixes the class name. */
function describe(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
