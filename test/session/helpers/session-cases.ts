import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { onTestFinished } from "vitest";

import {
  Observation,
  Ok,
  type SessionProvider,
  type SessionReadout,
  StartRequest,
} from "../../../src/session/provider.js";
import { type ChildHandle, sessionRuntime } from "../../../src/session/runtime.js";

/**
 * The per-case scaffolding shared by the session belt's three test files:
 * interlock's `_request`, `_spawned`, `_wait_for_spawns`, `_wait_for_state`,
 * `_wait_for_exit`, `_recorded_generation`, `_plant_record`,
 * `_wait_until_observed` and `_reopened_pipe`, plus the `provider` fixture's
 * teardown.
 *
 * ## The one rule that is not in the source: teardown must *await* the exits
 *
 * The source's `provider` fixture lists its sessions and calls `stop` on each,
 * and on POSIX a child that survives that costs a stray process and nothing
 * else. On the Windows cell it costs the whole run: the child holds the
 * generation's `events-NNN.jsonl` and `stderr-NNN.log` open, Windows will not
 * remove a directory containing an open handle, and the temp cleanup then fails
 * with `EBUSY` -- attributed to whichever case the shuffled order (D-0005)
 * happened to clean up into, which is the worst failure shape the belt can
 * produce. Thirteen cases leave a child sleeping on purpose, so this is not a
 * theoretical path.
 *
 * {@link stopSessionsAtTeardown} therefore stops **and then waits**, and fails
 * loudly if a child outlives the wait. Two consequences for callers:
 *
 * - Register it **after** the `caseRoot()` whose directory the provider
 *   writes into. `onTestFinished` unwinds LIFO, so a later registration runs
 *   earlier, and the children must be gone before the directory is removed.
 * - Give every hanging child a short `FAKE_SLEEP`. The fake's default is the
 *   source's 60 seconds; a missed kill then self-heals in a minute rather than
 *   at the end of the run, but the wait here is what actually catches it.
 *
 * ## Why the polling helpers do not use the runtime seam's clock or sleep
 *
 * {@link sessionRuntime} carries `monotonicMs()` and `sleep()`, and this file
 * deliberately uses neither. They are the *subject* of the belt: cases patch
 * them to compress the stop ladder's waits, and a poll loop that shared them
 * would speed up or hang along with the code it is watching. `waitForExit` is
 * the single exception and has to be -- only the runtime can turn a
 * {@link ChildHandle} back into something waitable.
 */

/**
 * `time.sleep(0.02)` between polls, and a 10-second deadline: the source's two
 * constants, in milliseconds.
 *
 * Both are defaults on every helper below, exactly as they are defaults on the
 * source's, so a case that needs a different deadline says so at the call site
 * and every other case reads the same as its Python.
 */
export const POLL_INTERVAL_MS = 20;

/** The source's `timeout: float = 10.0`. */
export const POLL_DEADLINE_MS = 10_000;

/**
 * How long {@link stopSessionsAtTeardown} waits for a stopped child to be gone.
 *
 * The same 10 seconds, and generous on purpose: this is a hygiene check, and a
 * slow CI cell must not be able to turn a passing case red. What it must catch
 * is a child that is *not going to exit at all*.
 */
export const TEARDOWN_EXIT_TIMEOUT_MS = 10_000;

/**
 * The poll's own timer, independent of the runtime seam.
 *
 * `unref` is deliberately **not** called: a poll that let the process exit
 * underneath it would report a passing test that never finished waiting.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `time.monotonic()`, in milliseconds, and not the seam's. */
function nowMs(): number {
  return performance.now();
}

// --------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------

/**
 * `_request` from `test_claude_cli_provider.py`.
 *
 * The workspace is `<root>/workspaces/<session id>` and is **not created**.
 * The provider creates it, and the transition it announces to a registered
 * observer is a *creation* only while the directory is absent -- so a helper
 * that made the directory first would defeat
 * `test_a_vetoed_workspace_creation_refuses_the_start`, which is the case that
 * vetoes exactly that transition, in the same way a `databasePath` that
 * touched the file would (see rule 6). Measured, not assumed: pre-creating the
 * directory here turns that case, and only that case, red.
 */
export function cliRequest(
  root: string,
  sessionId = "sess-1",
  settings: Readonly<Record<string, unknown>> = {},
): StartRequest {
  return new StartRequest({
    sessionId,
    workspace: join(root, "workspaces", sessionId),
    role: "worker",
    settings,
  });
}

/**
 * `_request` from `test_stub_provider.py` -- a different helper of the same
 * name, and the differences are load-bearing rather than cosmetic.
 *
 * One workspace shared by every session id (`<root>/workspace`, not
 * `.../<session id>`), created up front, and the default id is `s-1` rather
 * than `sess-1`. The stub's cases assert on `provider_detail["workspace"]` and
 * on ids by name, so collapsing the two request builders into one would change
 * both files' expectations.
 */
export function stubRequest(
  root: string,
  sessionId = "s-1",
  settings: Readonly<Record<string, unknown>> = {},
): StartRequest {
  const workspace = join(root, "workspace");
  // `workspace.mkdir(exist_ok=True)`. `recursive` also creates the parents,
  // which the source's call does not -- `root` always exists, so the two agree
  // wherever the suite reaches this.
  mkdirSync(workspace, { recursive: true });
  return new StartRequest({ sessionId, workspace, role: "worker", settings });
}

// --------------------------------------------------------------------------
// The spawn log
// --------------------------------------------------------------------------

/** One line of the fake CLI's spawn log. */
export interface SpawnLogEntry {
  readonly argv: readonly string[];
  readonly cwd: string;
}

/**
 * `_spawned(spawn_log)` -- the log's lines, parsed.
 *
 * An **absent** log is zero spawns, not an error. That is the source's shape
 * and it is the only one that lets a case assert "nothing was spawned": the
 * fake creates the file on its first spawn and never before, so the negative
 * case has no file to read.
 */
export function spawned(log: string): readonly SpawnLogEntry[] {
  if (!existsSync(log)) {
    return [];
  }
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SpawnLogEntry);
}

/**
 * `_wait_for_spawns(spawn_log, count)`.
 *
 * The fake writes its log line once it is *executing*, which is after `spawn`
 * has resolved -- so arrival is waited for and never assumed. A case that read
 * the log straight after `start()` returned would see zero entries roughly as
 * often as the machine is busy, which is the definition of a flake.
 */
export async function waitForSpawns(
  log: string,
  count: number,
  timeoutMs = POLL_DEADLINE_MS,
): Promise<readonly SpawnLogEntry[]> {
  const deadline = nowMs() + timeoutMs;
  for (;;) {
    const entries = spawned(log);
    if (entries.length >= count) {
      return entries;
    }
    // Checked after the attempt and before the sleep, as the source's
    // `assert time.monotonic() < deadline` is: one full attempt always happens,
    // and the deadline can only fail a poll that already came up short.
    if (nowMs() >= deadline) {
      throw new Error(`saw ${entries.length} spawns, wanted ${count}`);
    }
    await pause(POLL_INTERVAL_MS);
  }
}

// --------------------------------------------------------------------------
// Polling the provider
// --------------------------------------------------------------------------

/**
 * `_wait_for_state(provider, session_id, state)`.
 *
 * Polls `read_state` until the provider reports the backend's own state word,
 * and gives up loudly with the last result in the message. The word is the
 * backend's -- `completed`, `running`, `exited-1` -- and is compared exactly,
 * because a prefix comparison is what turns `exited-1` and `exited-0` into the
 * same observation.
 */
export async function waitForState(
  provider: SessionProvider,
  sessionId: string,
  state: string,
  timeoutMs = POLL_DEADLINE_MS,
): Promise<SessionReadout> {
  const deadline = nowMs() + timeoutMs;
  for (;;) {
    const result = await provider.readState(sessionId);
    if (result instanceof Ok && result.value.providerState === state) {
      return result.value;
    }
    if (nowMs() >= deadline) {
      throw new Error(`never reached ${JSON.stringify(state)}: ${describeValue(result)}`);
    }
    await pause(POLL_INTERVAL_MS);
  }
}

/**
 * `_wait_until_observed(provider, session_id)` from the stub's file.
 *
 * Polls until the child has reported anything at all. Note the deadline is
 * taken **before** the first read, as the source's is, so the timeout covers
 * the reads as well as the sleeps.
 *
 * The source writes `provider.read_state(session_id).value` with no `Ok` check
 * and relies on Python raising `AttributeError` if a `Failure` ever came back.
 * The port has to say what happens instead, and says it as a failure naming the
 * result -- silently treating a `Failure` as "not observed yet" would poll for
 * ten seconds and then report a timeout, hiding the refusal that caused it.
 */
export async function waitUntilObserved(
  provider: SessionProvider,
  sessionId: string,
  timeoutMs = POLL_DEADLINE_MS,
): Promise<SessionReadout> {
  const deadline = nowMs() + timeoutMs;
  let readout = readoutOf(await provider.readState(sessionId), sessionId);
  while (readout.observation === Observation.COULD_NOT_OBSERVE) {
    if (nowMs() >= deadline) {
      throw new Error(`child never reported: ${describeValue(readout)}`);
    }
    await pause(POLL_INTERVAL_MS);
    readout = readoutOf(await provider.readState(sessionId), sessionId);
  }
  return readout;
}

/** `result.value` on a result the helper requires to be `Ok`. */
function readoutOf(result: unknown, sessionId: string): SessionReadout {
  if (!(result instanceof Ok)) {
    throw new Error(`read_state(${JSON.stringify(sessionId)}) refused: ${describeValue(result)}`);
  }
  return result.value as SessionReadout;
}

/**
 * `repr(value)`, near enough for a diagnostic message.
 *
 * These messages are the only thing a reader gets when a poll times out, so the
 * naive spelling costs more than it looks. `JSON.stringify` renders a branded
 * enum member as `{"value":"could-not-observe"}` and a frozen class with no own
 * enumerable data as `{}`; a flat `String(...)` renders a `SessionReadout` as
 * `[object Object]`, which is what the first version of this function did --
 * caught by a throwaway driver spec run while this scaffolding was written, not
 * by reading. So:
 *
 * - a class that **defines its own `toString`** is asked -- `Observation` and
 *   `FailureKind` both render as `Class.MEMBER`, which is what Python's `repr`
 *   of an enum member shows;
 * - anything else is rendered structurally, `Class(field=..., field=...)`, which
 *   is Python's `repr` of a dataclass;
 * - and the recursion is bounded, because a provider detail map can carry
 *   anything, including a cycle.
 */
export function describeValue(value: unknown, depth = 3): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return depth <= 0
      ? "[...]"
      : `[${value.map((entry) => describeValue(entry, depth - 1)).join(", ")}]`;
  }
  // Checked before the depth guard: an enum member is a leaf however deep it is.
  const render = (value as { toString?: unknown }).toString;
  if (typeof render === "function" && render !== Object.prototype.toString) {
    return String(value);
  }
  if (depth <= 0) {
    return "{...}";
  }
  const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "Object";
  const fields = Object.entries(value).map(
    ([key, entry]) => `${key}=${describeValue(entry, depth - 1)}`,
  );
  // A plain object gets braces rather than `Object(...)`, which is how an empty
  // `providerDetail` reads in the message a failed poll prints.
  return name === "Object" ? `{${fields.join(", ")}}` : `${name}(${fields.join(", ")})`;
}

// --------------------------------------------------------------------------
// The live child a provider holds
// --------------------------------------------------------------------------

/**
 * The internal accessor the source reaches through `provider._sessions[id]
 * .process`.
 *
 * Twelve cases in the CLI file and two in the stub's read this, so it is not
 * optional scaffolding: it is a module-private name a source case reaches, and
 * the repository's answer to that is to export it and mark it `@internal`
 * (D-0101), not to widen the public surface.
 *
 * It is required rather than optional on {@link stopSessionsAtTeardown}'s
 * parameter on purpose. A provider that did not implement it would still
 * type-check against an optional member, and the teardown's wait -- the whole
 * of the Windows mitigation above -- would silently do nothing.
 */
export interface HoldsChildren {
  /**
   * The live child this instance holds for `sessionId`, or `null` when it holds
   * none -- an adopted orphan, a planted record, a session that never spawned.
   *
   * @internal
   */
  childOf(sessionId: string): ChildHandle | null;

  /**
   * Every session id this instance still holds a table entry for.
   *
   * Required for the same reason `childOf` is: it is the roster the teardown
   * falls back to when `listSessions()` refuses, and a provider that did not
   * implement it would type-check against an optional member while the
   * fallback silently found nothing.
   *
   * @internal
   */
  heldSessionIds(): readonly string[];
}

/** A provider whose live children the belt's helpers can reach. */
export type SupervisedProvider = HoldsChildren & SessionProvider;

/**
 * `_wait_for_exit(provider, session_id)`.
 *
 * The source calls `session.process.wait(timeout=)` after asserting the process
 * is not `None`; both halves are here, and the assertion is the important one.
 * A helper that quietly returned when the provider held no child would let
 * every case built on it proceed against a session that never spawned -- and
 * those cases go on to assert `exited-0` or a recorded return code, which a
 * never-spawned session cannot produce, so the failure would arrive one
 * assertion later wearing someone else's name.
 *
 * This is the one helper that uses the runtime seam, because only the seam can
 * wait on a handle it minted.
 */
export async function waitForExit(
  provider: SupervisedProvider,
  sessionId: string,
  timeoutMs = POLL_DEADLINE_MS,
): Promise<number> {
  const child = provider.childOf(sessionId);
  if (child === null) {
    throw new Error(
      `the provider holds no live child for ${JSON.stringify(sessionId)}, so there is no exit ` +
        "to wait for",
    );
  }
  return await sessionRuntime.waitForExit(child, timeoutMs);
}

/**
 * The `provider` fixture's teardown: stop every session this instance holds,
 * and wait until its children are actually gone.
 *
 * Returns the provider so a case reads as one statement:
 *
 * ```ts
 * const provider = stopSessionsAtTeardown(
 *   new ClaudeCliSessionProvider(join(root, "state"), { claudeCommand: fakeCli(root) }),
 * );
 * ```
 *
 * Three details, each answering a way the naive version goes wrong:
 *
 * - **The stop's result is ignored, as the source ignores it.** A session with
 *   an unreadable record refuses `stop`, and a case that planted such a record
 *   is asserting that refusal; making the teardown fail on it would turn every
 *   one of those cases red.
 * - **The wait is not ignored.** A child still running after its stop is the
 *   `EBUSY` above, and the only place it can be attributed correctly is here,
 *   in the test that leaked it.
 * - **A grandchild cannot be waited for**, because it is not this process's
 *   child -- `shielded-grandchild` cases end with the provider's group sweep
 *   having signalled it, and nothing here can confirm the reap. The fake's
 *   grandchild holds no file open (`stdio: "ignore"`) and dies on its own timer
 *   for exactly that reason.
 */
export function stopSessionsAtTeardown<P extends SupervisedProvider>(provider: P): P {
  onTestFinished(() => stopEverySession(provider));
  return provider;
}

/**
 * The teardown's body, as a function a test can call.
 *
 * Split out because the guarantee it carries -- *the wait actually happens* --
 * is otherwise unobservable. A callback registered with `onTestFinished` can
 * only report by failing its own test, so a case cannot assert that it threw,
 * and a mutation that deletes the wait leaves every test green. Measured, with the same throwaway
 * driver spec: with the `waitForExit` call below deleted and this function
 * still inlined in the registration, every one of its sixteen cases stayed
 * green (rule 10 -- the check went green because its subject became
 * unreachable, not because it held). Split out and driven directly, the same
 * deletion turns the case red on the first assertion.
 *
 * So the wait is here, where a target-only case can drive it against a provider
 * whose `stop` acknowledges and kills nothing, and `stopSessionsAtTeardown` is
 * the one-line registration above. `timeoutMs` is a parameter for the same
 * reason: that case should not spend the full ten seconds proving the wait
 * exists.
 */
export async function stopEverySession(
  provider: SupervisedProvider,
  timeoutMs = TEARDOWN_EXIT_TIMEOUT_MS,
): Promise<void> {
  // `if isinstance(listed, Ok):` in the source, where the alternative costs a
  // stray process. Here it cannot be a bare `return`: `listSessions` is a verb
  // and refuses -- `ClaudeCliSessionProvider` answers
  // `Failure(BACKEND_UNREACHABLE)` whenever the read of the state root throws
  // -- while the table of live children is not a verb and cannot. Nothing
  // deletes from that table, so on a refused roster the provider is still
  // holding every child it ever spawned, and returning here would abandon
  // exactly the children this fixture exists to reap, silently. So the ids the
  // provider still holds are the fallback roster.
  const listed = await provider.listSessions();
  const sessionIds =
    listed instanceof Ok
      ? listed.value.map((readout) => readout.sessionId)
      : provider.heldSessionIds();
  for (const sessionId of sessionIds) {
    // The result is dropped, as the source drops it: a session whose record is
    // unreadable refuses `stop`, and the case that planted it is asserting that
    // refusal.
    await provider.stop(sessionId);
  }
  for (const sessionId of sessionIds) {
    const child = provider.childOf(sessionId);
    if (child === null) {
      continue;
    }
    try {
      await sessionRuntime.waitForExit(child, timeoutMs);
    } catch (error) {
      throw new Error(
        `session ${JSON.stringify(sessionId)} left a child running (pid ` +
          `${child.pid}) after stop(). It holds this case's events and stderr files open, ` +
          "which fails temp cleanup on Windows in whichever case the shuffled order cleans " +
          `up into: ${String(error)}`,
      );
    }
  }
}

// --------------------------------------------------------------------------
// Durable records
// --------------------------------------------------------------------------

/**
 * `_recorded_generation(tmp_path, session_id)`.
 *
 * The generation counter out of the durable record, which is how the cases that
 * care about resume distinguish "a new generation started" from "the record was
 * rewritten".
 *
 * The shape check is rule 9's: `record["generation"]` in Python is an `int`
 * because the writer wrote one, while `JSON.parse` here yields `unknown` and
 * would happily hand back a string that then compares unequal to `1` with no
 * indication why.
 */
export function recordedGeneration(root: string, sessionId: string): number {
  const record = JSON.parse(readFileSync(recordPath(root, sessionId), "utf8")) as {
    generation?: unknown;
  };
  const generation = record.generation;
  if (typeof generation !== "number") {
    throw new Error(
      `record.json for ${JSON.stringify(sessionId)} has generation ` +
        `${JSON.stringify(generation)}, which is not a number`,
    );
  }
  return generation;
}

/** `tmp_path / "state" / session_id / "record.json"`. */
export function recordPath(root: string, sessionId: string): string {
  return join(root, "state", sessionId, "record.json");
}

/**
 * The durable record's on-disk shape, in the source's field order.
 *
 * **The keys are `snake_case` because the file is**: interlock's
 * `_SessionRecord.to_json` names each key explicitly, and the differential
 * oracle compares the two runtimes' files. This interface is the port's copy of
 * that wire format, and it must agree with the provider's writer -- a
 * `camelCase` writer would make every planted record here invisible to it, and
 * the cases that plant one all assert the provider *did* see it, so they would
 * fail in a way that reads as a parser defect.
 */
export interface PlantedRecord {
  readonly session_id: string;
  readonly claude_session_uuid: string;
  readonly workspace: string;
  readonly role: string;
  readonly resume_prompt: string;
  readonly cli_args: readonly string[];
  readonly generation: number;
  readonly argv: readonly string[];
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly incident: string | null;
}

/**
 * `_plant_record`, bound to the port's `claudeSessionUuid`.
 *
 * Curried because a helper file cannot import the derivation and stay honest.
 * `claude_session_uuid` is production's uuid5 of the session id, and one case
 * (`test_a_recycled_pid_is_never_trusted_signalled_or_adopted`) resumes a
 * planted record and asserts the spawn carried
 * `--resume <claudeSessionUuid("stale")>`
 * -- so a second implementation of the derivation living here could agree with
 * itself and disagree with the provider, and that case would still pass. Bind
 * it once at the top of the test file:
 *
 * ```ts
 * const plantRecord = recordPlanter(claudeSessionUuid);
 * ```
 *
 * and the five call sites then read exactly as the source's do.
 */
export function recordPlanter(
  derive: (sessionId: string) => string,
): (root: string, sessionId: string, overrides?: Readonly<Record<string, unknown>>) => string {
  return (root, sessionId, overrides = {}) => {
    const sessionDir = join(root, "state", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const workspace = join(root, "workspaces", sessionId);
    mkdirSync(workspace, { recursive: true });

    const record: PlantedRecord = {
      session_id: sessionId,
      claude_session_uuid: derive(sessionId),
      workspace,
      role: "worker",
      resume_prompt: "continue",
      cli_args: [],
      generation: 0,
      argv: ["claude", "-p", "x"],
      pid: null,
      pgid: null,
      incident: null,
    };
    // `record.update(overrides)`. The overrides are typed `unknown` on purpose:
    // three cases plant a record that is deliberately *type-invalid*
    // (`cli_args: null` is the whole of
    // `test_a_type_invalid_record_is_a_broken_record_not_a_crash`),
    // and a `Partial<PlantedRecord>` would refuse the very values the cases
    // exist to feed the parser.
    writeFileSync(
      join(sessionDir, "record.json"),
      JSON.stringify({ ...record, ...overrides }),
      "utf8",
    );
    return sessionDir;
  };
}

// --------------------------------------------------------------------------
// A replacement stdin pipe
// --------------------------------------------------------------------------

/**
 * `_reopened_pipe` -- a stand-in for a pipe `stop()` has not already closed.
 *
 * Used by one stub case, `test_a_refused_resume_releases_the_exited_childs_pipe`,
 * which assigns it over the child's `stdin` (the port spells that
 * `ChildHandle.replaceStdin`, D-0101) and then asserts `resume` closed it. The
 * replacement is what gives the case teeth: by the time `resume` is called,
 * `stop` has already closed the real pipe, so without one the assertion is
 * satisfied by the previous verb.
 *
 * The source builds it from `os.pipe()` with the read end closed. Node exposes
 * no `os.pipe()` -- there is no supported way to make an anonymous fd pair on
 * Node 22 -- so this is an in-memory `PassThrough` instead. That is sufficient
 * and, on the Windows cell, better: what the case reads is
 * `ChildHandle.stdinClosed()`, which reports the port's own
 * *closed-by-us* flag rather than the stream's state (see `runtime.ts`), and an
 * in-memory stream holds no handle to leak if the case fails before closing it.
 * What would **not** be sufficient is an already-destroyed stream, which is why
 * this mints a fresh one per call.
 *
 * Destroyed at `onTestFinished`, registered here at acquisition (rule 1), so a
 * case that fails before its assertion still leaves nothing behind.
 */
export function reopenedPipe(): Writable {
  const pipe = new PassThrough();
  onTestFinished(() => {
    pipe.destroy();
  });
  return pipe;
}
