import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { expect, test } from "vitest";

import {
  ABSTRACT_METHODS,
  type CapabilityReport,
  Failure,
  FailureKind,
  Observation,
  Ok,
  type ProviderResult,
  SessionProvider,
  SessionReadout,
  SpawnRefused,
  StartRequest,
  WorkspaceDecision,
  type WorkspaceLifecycleObserver,
  type WorkspaceTransition,
  WorkspaceVerdict,
} from "../../src/session/provider.js";
import { type ChildHandle, sessionRuntime } from "../../src/session/runtime.js";
import {
  ANNOUNCE_AFTER_ENV,
  DEFAULT_CHILD_PROGRAM,
  DEFAULT_CHILD_STATE,
  LocalProcessSessionProvider,
  STATE_FILE_ENV,
} from "../../src/session/stub_provider.js";
import { caseRoot } from "../testkit/cases.js";
import { chdirForTest } from "../testkit/cwd.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";
import {
  POLL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  reopenedPipe,
  stopSessionsAtTeardown,
  stubRequest,
  waitUntilObserved,
} from "./helpers/session-cases.js";
import { repoSource } from "./helpers/source-text.js";

/**
 * S3 -- the stub provider over local child processes.
 *
 * These cases exercise the stub as the control-plane suite will: through the S1
 * verbs only, including the degraded paths (a refused spawn, a session that
 * cannot be observed yet, a re-entry that is refused), since those are the ones
 * gate item 11's re-run leans on and the ones a happy-path-only suite would let
 * rot.
 *
 * Ported from interlock `tests/session/test_stub_provider.py` at `65f36c5`: 43
 * node ids, of which 39 are `ported` and four are `adapted`. Three target-only
 * cases at the end map to no source id and are declared as such in the ledger.
 *
 * ## The four adaptations, named where they happen
 *
 * - `test_the_stub_satisfies_the_s1_contract` -- `__abstractmethods__` has no
 *   runtime form in TypeScript and is read out of the `ABSTRACT_METHODS`
 *   registry instead. The two gate-identity assertions port **directly**:
 *   Python's `is` against `SessionProvider.__dict__[gate]` becomes `===`
 *   against `SessionProvider.prototype`'s own function.
 * - `test_the_probe_reports_a_build_and_every_required_capability` -- the
 *   version prefix is `node ` rather than `python `, because the port's stub
 *   spawns a Node child rather than a Python one.
 * - `test_a_refused_resume_releases_the_exited_childs_pipe` -- the source's
 *   `_reopened_pipe` is built from `os.pipe()`, which Node has no equivalent
 *   for. The substitute is an in-memory writable whose closed state is
 *   readable; the asserted behaviour, that a refused resume closes the child's
 *   standard input *before* returning the `Failure`, is unchanged.
 * - `test_no_claude_cli_and_no_network` -- the lint's five forbidden substrings
 *   are unchanged; **what it reads** had to change twice. A class does not know
 *   its defining file in ESM, so `sys.modules[...].__file__` becomes a literal
 *   path plus a compensating assertion that the text read still declares the
 *   class -- a class that moves fails loudly here rather than leaving the scan
 *   quietly following a stale file name. And the source's *one* module holds
 *   the verbs and every `subprocess` call, where this port splits that module
 *   in two: the spawn, probe and signal primitives are `src/session/runtime.ts`
 *   (D-0014's single runtime adapter). Reading only `stub_provider.ts` would
 *   scan the half of the source's module that was never going to open a socket,
 *   so both files are read. That is the source's one module and no more than
 *   it. Where this is **weaker** than the source, said rather than hidden: the
 *   source's file list is derived by the interpreter and is always exactly the
 *   defining module, while this one is two hand-written paths, so a future
 *   third file split out of either is scanned by nothing.
 *
 * The Node-not-Python child ripples further than those four -- into the
 * default child program and into the three caller-supplied child programs below
 * -- but changes **no other assertion**, so those cases stay `ported`.
 *
 * ## Where a seam is substituted, and where one deliberately is not
 *
 * Twenty-odd cases here drive a **real** child process, because the guarantees
 * this file exists to prove -- that a spawn failure is classified as one, that
 * a child's own state word survives the round trip, that closing a pipe is what
 * ends the default child -- are guarantees about processes. The only two cases
 * that patch `sessionRuntime` are the two whose *source* monkeypatches
 * `subprocess.Popen`, and both patches delegate to the real thing.
 *
 * The load-bearing subtlety in `test_an_unusable_command_never_reaches_a_spawn`
 * is in its source docstring: a spawn **is** performed during a refused start,
 * because the D-0010 probe runs first, so "nothing was spawned" is the wrong
 * assertion and "the caller's argv was never the thing spawned" is the right
 * one. In the port the probe and the child go through two *different* seam
 * members (`runProbe` and `spawn`), so the recorder is installed over both --
 * without that, the log would be empty during a refused start and the case
 * would be asking a weaker question than its source.
 */

// -- the source's module-level constant -----------------------------------

/**
 * Long enough that a test reading straight after the spawn always lands inside
 * the window in which the child has not reported yet.
 */
const NEVER_ANNOUNCES = 3600;

/** A NUL, spelled as an escape so this file stays ASCII text. */
const NUL = "\u0000";

// -- the fixture, and the small helpers the cases share -------------------

/**
 * The `provider` fixture: a provider whose children are always stopped, test
 * outcome regardless.
 *
 * The state root is `<root>/state`, a **subdirectory** of the case root and not
 * the case root itself -- the source's fixture is written that way and
 * `test_a_session_id_that_is_not_one_file_name_is_refused` depends on it, since
 * its decoy file sits one level above the root an escaping id would have to
 * reach.
 *
 * `stopSessionsAtTeardown` is the source's `finally` clause plus the one thing
 * the source does not need: it **waits** for each child to be gone rather than
 * merely signalling it. On POSIX a survivor costs a stray process; on the
 * Windows cell it holds this case's temp directory open and fails whichever
 * case the shuffled order cleans up into.
 *
 * Registered after `caseRoot()` on purpose. `onTestFinished` unwinds LIFO, so a
 * later registration runs earlier, and the children must be gone before the
 * directory they are writing into is removed.
 */
function stubProvider(root: string, options: { nodeExecutable?: string } = {}) {
  return stopSessionsAtTeardown(new LocalProcessSessionProvider(join(root, "state"), options));
}

/**
 * `result.value` on a result that has to be an `Ok`.
 *
 * The source writes `.value` bare and lets Python raise `AttributeError` if a
 * `Failure` ever came back. The port has to say what happens instead, and says
 * it as an assertion naming the result, so a refusal is reported as a refusal
 * rather than as `undefined` failing some later comparison.
 */
function okValue<T>(result: ProviderResult<T>): T {
  expect(result, `expected Ok, got ${String(result)}`).toBeInstanceOf(Ok);
  return (result as Ok<T>).value;
}

/** The poll's own timer, independent of the runtime seam's `sleep`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `dir(LocalProcessSessionProvider)` filtered to public names.
 *
 * `dir()` on a class lists **every** public class attribute, whatever its
 * kind: methods, `property` objects, and plain class-level data alike. Python
 * has one namespace for all three, so the source's filter sees a
 * `send_prompt` property and a `send_timeout` class attribute exactly as it
 * sees a `deliver()` method. JavaScript splits that namespace three ways --
 * prototype methods, accessors, and `static` members -- and a walk that keeps
 * only function-valued prototype entries is blind to two of the three. Since
 * this case's entire job is to police the surface against a delivery-shaped
 * member arriving later, being blind to two of the three ways to add one is
 * the case asserting less than its source (rule 0's floor).
 *
 * So: the **names** are collected, never the values, and from both chains --
 * up the prototype chain and up the constructor chain, each stopping before
 * the intrinsic it inherits from (`Object.prototype`, `Function.prototype`).
 * Reading values is what the descriptor check was for, and it is exactly what
 * must not happen: touching `.value` on an accessor descriptor reports
 * `undefined` for a getter, and invoking the getter to find out would run
 * provider code inside a lint.
 *
 * `constructor`, and `length` / `name` / `prototype` on the constructor
 * itself, are dropped as the JavaScript-side counterpart of the source's
 * `_`-prefix filter: they are the language's own machinery on every class,
 * which Python spells under dunder names and `dir()`'s caller discards.
 */
function publicSurfaceOf(cls: abstract new (...args: never[]) => unknown): string[] {
  const names: string[] = [];
  const collect = (holder: object, stopAt: object, machinery: readonly string[]): void => {
    let current: object | null = holder;
    while (current !== null && current !== stopAt) {
      for (const name of Object.getOwnPropertyNames(current)) {
        if (name === "constructor" || name.startsWith("_") || machinery.includes(name)) {
          continue;
        }
        if (!names.includes(name)) {
          names.push(name);
        }
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  };
  collect(cls.prototype as object, Object.prototype, []);
  // Every class in the chain carries its own `length`, `name` and `prototype`,
  // so they are dropped at every level rather than only at the leaf.
  collect(cls as unknown as object, Function.prototype, ["length", "name", "prototype"]);
  return names;
}

/** `getattr(cls, name)`, resolved through the prototype chain. */
function resolveOn(cls: abstract new (...args: never[]) => unknown, name: string): unknown {
  return (cls.prototype as unknown as Record<string, unknown>)[name];
}

/**
 * A caller-supplied child, in the shape the source's three inline programs
 * take: read the state file's path out of the environment, put something in it,
 * then block until standard input closes.
 *
 * `body` receives the path variable's name. The blocking half is shared because
 * getting it wrong is silent: a child that exits immediately turns every one of
 * these cases into a race between the poll loop and the exit, and the readout it
 * would then see (`exited-0`) is a perfectly good observation.
 */
function callerSuppliedChild(body: string): readonly string[] {
  return [
    process.execPath,
    "-e",
    [
      'const fs = require("fs");',
      `const statePath = process.env[${JSON.stringify(STATE_FILE_ENV)}];`,
      body,
      'process.stdin.on("end", () => { process.exit(0); });',
      "process.stdin.resume();",
    ].join("\n"),
  ];
}

// -- it is a provider at all ----------------------------------------------

test("test_the_stub_satisfies_the_s1_contract", () => {
  // Concrete on every abstract member, and it did not override the gate.
  //
  // ADAPTED, in one of its three assertions. `__abstractmethods__` is computed
  // by `ABCMeta` and TypeScript's `abstract` is erased before anything runs, so
  // the registry `SessionProvider`'s constructor consults is what is read here
  // instead. The registry carries its own liveness case in the S1 battery, so
  // a registry that had drifted away from the class cannot make this green.
  const root = caseRoot("stub");
  const instance = new LocalProcessSessionProvider(root);
  expect(instance).toBeInstanceOf(SessionProvider);

  const unimplemented = [...ABSTRACT_METHODS].filter((name) => {
    const resolved = resolveOn(LocalProcessSessionProvider, name);
    // Still abstract when the chain resolves to the base's own placeholder --
    // the JavaScript stand-in for a function that is still
    // `__isabstractmethod__`.
    return typeof resolved !== "function" || resolved === resolveOn(SessionProvider, name);
  });
  expect(unimplemented).toEqual([]);

  for (const gate of ["start", "requireSpawnable"]) {
    // `getattr(cls, gate) is s1.SessionProvider.__dict__[gate]`, which ports
    // directly: identity of the function the prototype chain resolves.
    expect(resolveOn(LocalProcessSessionProvider, gate), gate).toBe(
      resolveOn(SessionProvider, gate),
    );
  }
});

test("test_no_claude_cli_and_no_network", async () => {
  // The scope's two hard constraints, checked rather than asserted in prose.
  const root = caseRoot("stub");
  const provider = stubProvider(root);

  // `Path(sys.modules[LocalProcessSessionProvider.__module__].__file__)`, which
  // in the source is **the whole stub**: one module holding the verbs, every
  // `subprocess` call, and the capability probe. Reading only
  // `stub_provider.ts` here would scan the half of that module that was never
  // going to open a socket, because the port's spawn, probe and signal
  // primitives live in `runtime.ts` -- so a network call added on the path the
  // stub actually takes to the operating system would go unnoticed. Both files
  // are read, which is the source's one module, and no more than it.
  //
  // ESM has no `cls.__module__`: a class does not know its defining file, and
  // `import.meta` belongs to the reader, not the read. The derivation is
  // therefore replaced by an assertion that the text really does define the
  // class -- so a class that moves fails loudly here instead of leaving the
  // scan quietly following a file name (rule 10).
  //
  // It must be the `.ts` file: `dist/` has the comments stripped, and half of
  // what this lint is about lives in comments, so a read that resolved there
  // would pass unconditionally. `repoSource` refuses a `dist/` path for that
  // reason.
  const declaring = repoSource("src/session/stub_provider.ts");
  expect(declaring).toContain(`class ${LocalProcessSessionProvider.name} extends`);
  const source = [declaring, repoSource("src/session/runtime.ts")].join("\n").toLowerCase();
  for (const forbidden of ["socket", "urllib", "requests", "http://", "https://"]) {
    expect(source.includes(forbidden), forbidden).toBe(false);
  }

  const started = await provider.start(stubRequest(root));
  const command = okValue(started).providerDetail["command"] as readonly string[];
  // `sys.executable` in the source; `process.execPath` is its counterpart and
  // the Node-child substitution the ported module's header records. The
  // assertion itself is unchanged: argv[0]
  // is the executable this provider was configured with.
  expect(command[0]).toBe(process.execPath);
});

test("test_no_verb_writes_to_a_child", () => {
  // D-0009: delivery is MessageBus's, and the stub grows no path to it.
  const deliveryWords = /deliver|send|write|notify|input|message|prompt/i;
  const deliveryShaped = publicSurfaceOf(LocalProcessSessionProvider).filter((name) =>
    deliveryWords.test(name),
  );
  expect(deliveryShaped, JSON.stringify(deliveryShaped)).toEqual([]);
});

// -- the capability probe and its fail-closed spawn (D-0010) ---------------

test("test_the_probe_reports_a_build_and_every_required_capability", () => {
  // ADAPTED. The source asserts `provider_version.startswith("python ")`. The
  // stub's local child is Node in the port, so the build this probe
  // reports is Node's and the prefix is `node `. The rejected alternative was
  // keeping a real `python3` child, which adds an interpreter dependency to a
  // TypeScript package's test suite and is not guaranteed on the Windows cell.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const probe = provider.probeCapabilities();
  expect(probe).toBeInstanceOf(Ok);
  const report = (probe as Ok<CapabilityReport>).value;
  expect(report.providerVersion.startsWith("node ")).toBe(true);
  expect(report.compatible).toBe(true);
  expect(report.missing.size).toBe(0);
});

test("test_an_unusable_interpreter_fails_the_probe_and_refuses_the_spawn", async () => {
  // The degraded path: nothing is spawned on a provider that does not answer.
  const root = caseRoot("stub");
  const broken = stubProvider(root, { nodeExecutable: join(root, "no-such-interpreter") });

  const probe = broken.probeCapabilities();
  expect(probe).toBeInstanceOf(Failure);
  expect((probe as Failure).kind).toBe(FailureKind.BACKEND_UNREACHABLE);

  // `start` is deliberately not an `async` function (D-0301), so the gate's
  // refusal is raised on the calling turn exactly as the source's is -- which
  // is what makes `expectRefusal`, a synchronous helper, the right translation
  // of `pytest.raises` here.
  expectRefusal(() => broken.start(stubRequest(root)), SpawnRefused);
  expect(okValue(await broken.listSessions())).toEqual([]);
});

// -- start, list, readState ------------------------------------------------

test("test_a_started_session_reports_the_childs_own_state_word", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  expect(await provider.start(stubRequest(root))).toBeInstanceOf(Ok);
  const readout = await waitUntilObserved(provider, "s-1");
  expect(readout.observation).toBe(Observation.OBSERVED);
  expect(readout.providerState).toBe(DEFAULT_CHILD_STATE);
  expect(readout.providerDetail["pid"] as number).toBeGreaterThan(0);
});

test("test_a_child_that_has_not_reported_yet_is_could_not_observe", async () => {
  // The case R4 and D-0006 exist for: alive, unobservable, and it says why.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  await provider.start(stubRequest(root, "s-1", { announce_after: NEVER_ANNOUNCES }));
  const result = await provider.readState("s-1");
  expect(result).toBeInstanceOf(Ok);
  const readout = (result as Ok<SessionReadout>).value;
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);
  expect(readout.providerState).toBeNull();
  expect(String(readout.couldNotObserveReason)).toContain("not reported");
});

test("test_no_sessions_is_an_empty_success_not_a_failure", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const result = await provider.listSessions();
  expect(result).toBeInstanceOf(Ok);
  // `Ok(())` in the source. An array here (the port's `listSessions` returns
  // one), and the assertion is the same fact: reached, holding none.
  expect((result as Ok<readonly SessionReadout[]>).value).toEqual([]);
});

test("test_list_sessions_carries_one_readout_per_started_session", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  await provider.start(stubRequest(root, "s-1"));
  await provider.start(stubRequest(root, "s-2"));
  const listed = okValue(await provider.listSessions());
  expect(listed.map((readout) => readout.sessionId).sort()).toEqual(["s-1", "s-2"]);
});

test("test_a_reused_session_id_is_refused", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  await provider.start(stubRequest(root));
  const again = await provider.start(stubRequest(root));
  expect(again).toBeInstanceOf(Failure);
  expect((again as Failure).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
});

test("test_reading_an_unknown_session_is_a_failure_not_an_empty_readout", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const result = await provider.readState("never-started");
  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.UNKNOWN_SESSION);
});

test("test_a_child_that_cannot_be_spawned_is_a_failure", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const result = await provider.start(
    stubRequest(root, "s-1", { command: [join(root, "no-such-child")] }),
  );
  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.BACKEND_UNREACHABLE);
});

// -- stop ------------------------------------------------------------------

test("test_stop_reports_the_state_after_the_child_is_gone", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  await provider.start(stubRequest(root));
  await waitUntilObserved(provider, "s-1");
  const stopped = await provider.stop("s-1");
  expect(stopped).toBeInstanceOf(Ok);
  const readout = (stopped as Ok<SessionReadout>).value;
  expect(readout.observation).toBe(Observation.OBSERVED);
  // Prefix only, as the source asserts. On POSIX a SIGTERM'd child is
  // `exited--15`, with the two hyphens Python's negative return code produces;
  // the digits after the dash are deliberately not pinned here, because the
  // source does not pin them either (rule 0's ceiling).
  expect(String(readout.providerState).startsWith("exited-")).toBe(true);
  const afterwards = okValue(await provider.readState("s-1"));
  expect(String(afterwards.providerState).startsWith("exited-")).toBe(true);
});

test("test_stopping_an_unknown_session_is_a_failure", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const result = await provider.stop("never-started");
  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.UNKNOWN_SESSION);
});

// -- resume ----------------------------------------------------------------

test("test_resuming_a_live_session_returns_its_current_readout", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  await provider.start(stubRequest(root));
  await waitUntilObserved(provider, "s-1");
  const resumed = await provider.resume("s-1");
  expect(resumed).toBeInstanceOf(Ok);
  expect((resumed as Ok<SessionReadout>).value.providerState).toBe(DEFAULT_CHILD_STATE);
});

test("test_resuming_an_exited_session_is_refused_with_a_reason", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  await provider.start(stubRequest(root));
  // No wait for the child to report: stop terminates it regardless, which is
  // the point -- the session is exited whether or not it ever announced.
  await provider.stop("s-1");
  const resumed = await provider.resume("s-1");
  expect(resumed).toBeInstanceOf(Failure);
  expect((resumed as Failure).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect((resumed as Failure).detail).toContain("re-entered");
});

test("test_resuming_an_unknown_session_is_a_failure", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const result = await provider.resume("never-started");
  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.UNKNOWN_SESSION);
});

// -- the workspace lifecycle surface (gate item 7) -------------------------

/** An observer that records every transition and answers as told. */
class Recorder implements WorkspaceLifecycleObserver {
  readonly seen: WorkspaceTransition[] = [];

  constructor(private readonly decision: WorkspaceDecision) {}

  onWorkspaceTransition(transition: WorkspaceTransition): WorkspaceDecision {
    this.seen.push(transition);
    return this.decision;
  }
}

test("test_creating_a_workspace_is_announced_before_it_is_made", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const observer = new Recorder(new WorkspaceDecision(WorkspaceVerdict.ALLOW));
  provider.registerWorkspaceObserver(observer);
  // Built inline rather than through `stubRequest`, because that helper creates
  // the workspace and this case is about the provider creating it.
  const workspace = join(root, "fresh");
  const request = new StartRequest({
    sessionId: "s-1",
    workspace,
    role: "worker",
    settings: {},
  });

  expect(await provider.start(request)).toBeInstanceOf(Ok);
  expect(observer.seen.map((transition) => transition.kind)).toEqual(["create-workspace"]);
  expect(existsSync(workspace) && statSync(workspace).isDirectory()).toBe(true);
});

test("test_a_vetoed_workspace_is_neither_created_nor_started", async () => {
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const observer = new Recorder(
    new WorkspaceDecision(WorkspaceVerdict.VETO, "outside the approved root"),
  );
  provider.registerWorkspaceObserver(observer);
  const workspace = join(root, "forbidden");
  const request = new StartRequest({
    sessionId: "s-1",
    workspace,
    role: "worker",
    settings: {},
  });

  const result = await provider.start(request);
  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect((result as Failure).detail).toContain("outside the approved root");
  expect(existsSync(workspace)).toBe(false);
  expect(okValue(await provider.listSessions())).toEqual([]);
});

test("test_an_existing_workspace_announces_nothing", async () => {
  // The stub only announces transitions it actually makes.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const observer = new Recorder(new WorkspaceDecision(WorkspaceVerdict.ALLOW));
  provider.registerWorkspaceObserver(observer);
  // `stubRequest` has already made the workspace, which is the whole setup.
  await provider.start(stubRequest(root));
  expect(observer.seen).toEqual([]);
});

// -- the child contract a caller may substitute into ------------------------

test("test_a_caller_supplied_child_is_read_through_the_same_readout", async () => {
  // Nothing in the readout is special-cased for the default child.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const child = callerSuppliedChild('fs.writeFileSync(statePath, "its-own-word");');
  await provider.start(stubRequest(root, "s-1", { command: child }));
  const readout = await waitUntilObserved(provider, "s-1");
  expect(readout.providerState).toBe("its-own-word");
});

test("test_the_announce_delay_is_passed_to_the_child_by_environment", async () => {
  // The knob the could-not-observe window depends on is the child's, not ours.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const child = callerSuppliedChild(
    `fs.writeFileSync(statePath, process.env[${JSON.stringify(ANNOUNCE_AFTER_ENV)}]);`,
  );
  await provider.start(stubRequest(root, "s-1", { command: child, announce_after: 7 }));
  const readout = await waitUntilObserved(provider, "s-1");
  // `str(7)` is `"7"` and so is `String(7)`. The coercion rule is the source's
  // `str()`, reproduced by `pyStr` in the provider; only the integer 7 is
  // exercised here, and a Python float would render `7.0` where JavaScript
  // renders `7`.
  expect(readout.providerState).toBe("7");
});

// -- the state files the readout depends on ---------------------------------

/**
 * The seven ids, spelled as `pytest --collect-only` printed them.
 *
 * The **id** is the escaped rendering the inventory carries and the **value**
 * is the real string, so `[back\\slash]` names a value holding one backslash
 * and `[nul\x00id]` names one holding an actual NUL. Getting that backwards
 * would make the target id a different string from the source node id, and the
 * ledger maps one to the other by name.
 */
const UNUSABLE_SESSION_IDS: readonly (readonly [string, string])[] = [
  ["../escape", "../escape"],
  ["/absolute", "/absolute"],
  ["nested/id", "nested/id"],
  ["..", ".."],
  ["back\\\\slash", "back\\slash"],
  ["C:escape", "C:escape"],
  ["nul\\x00id", `nul${NUL}id`],
];

parametrize(
  "test_a_session_id_that_is_not_one_file_name_is_refused",
  UNUSABLE_SESSION_IDS,
  async (sessionId: string) => {
    // The id names a state file, so it may not pick a file outside the root.
    const root = caseRoot("stub");
    const provider = stubProvider(root);
    // One level above the state root, which is `<root>/state`: exactly where an
    // id of `../escape` would land.
    const victim = join(root, "escape.state");
    writeFileSync(victim, "do not touch", "utf8");

    const result = await provider.start(stubRequest(root, sessionId));
    expect(result).toBeInstanceOf(Failure);
    expect((result as Failure).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(okValue(await provider.listSessions())).toEqual([]);
  },
);

test("test_a_relative_state_root_still_observes_its_children", async () => {
  // The child runs with the workspace as cwd, so the root must be absolute.
  const root = caseRoot("stub");
  // `monkeypatch.chdir(tmp_path)`. Measured (tmp/digest/spike-platform.md section 6):
  // this project declares no `pool`, so Vitest 4.1.11 runs each file in a
  // forked child process where `process.chdir` works. A feature check would be
  // worse than none -- `typeof process.chdir === "function"` is true under the
  // `threads` pool too, and then throws on call.
  chdirForTest(root);
  // Registered after the chdir, so it unwinds first: the children are stopped
  // while the working directory is still the one they were started under.
  const instance = stopSessionsAtTeardown(new LocalProcessSessionProvider("state"));

  expect(await instance.start(stubRequest(root))).toBeInstanceOf(Ok);
  expect((await waitUntilObserved(instance, "s-1")).providerState).toBe(DEFAULT_CHILD_STATE);
});

test("test_an_unusable_state_root_is_a_failure_not_an_exception", async () => {
  // Ordinary provider-side trouble is returned, never raised at the caller.
  const root = caseRoot("stub");
  const blocked = join(root, "state");
  writeFileSync(blocked, "not a directory", "utf8");
  const instance = stopSessionsAtTeardown(new LocalProcessSessionProvider(blocked));

  const result = await instance.start(stubRequest(root));
  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect(okValue(await instance.listSessions())).toEqual([]);
});

test("test_reading_an_exited_session_releases_its_child_pipe", async () => {
  // A child that exits on its own is never handed to stop().
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  // `[sys.executable, "-c", "pass"]` -- a child that does nothing and exits 0.
  await provider.start(stubRequest(root, "s-1", { command: [process.execPath, "-e", ""] }));

  const deadline = performance.now() + POLL_DEADLINE_MS;
  while (okValue(await provider.readState("s-1")).observation === Observation.COULD_NOT_OBSERVE) {
    expect(performance.now() < deadline, "child never exited").toBe(true);
    await pause(POLL_INTERVAL_MS);
  }

  const readout = okValue(await provider.readState("s-1"));
  expect(readout.providerState).toBe("exited-0");
  // `provider._sessions["s-1"].process.stdin.closed`, through the `@internal`
  // accessor D-0101 asks for. `stdinClosed()` reports the seam's own
  // closed-by-us flag rather than the stream's state, and that distinction is
  // what keeps this assertion from being satisfied by Node destroying the pipe
  // when the child died -- see `ChildHandle.stdinClosed` in `runtime.ts`.
  const child = provider.childOf("s-1");
  expect(child).not.toBeNull();
  expect((child as ChildHandle).stdinClosed()).toBe(true);
});

test("test_an_unusable_child_command_is_a_failure_not_an_exception", async () => {
  // Unusable caller settings are refused, on every platform.
  //
  // The original version of this test asserted the same thing but rested on a
  // POSIX-only premise -- that the spawn rejects these before the operating
  // system sees them. It does on POSIX, where an empty argv is an `IndexError`
  // and a NUL is a `ValueError`. On Windows an empty argv reaches
  // `CreateProcess`, comes back as `OSError` (`WinError 87`), and was
  // classified `BACKEND_UNREACHABLE` -- so the same request got two different
  // answers depending on where it ran, and the wrong one told the caller to
  // retry something no retry can fix.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  for (const command of [[], [process.execPath, "-e", `0${NUL}`]]) {
    const result = await provider.start(stubRequest(root, "s-1", { command }));
    expect(result, JSON.stringify(command)).toBeInstanceOf(Failure);
    expect((result as Failure).kind, JSON.stringify(command)).toBe(FailureKind.REFUSED_BY_PROVIDER);
  }
  expect(okValue(await provider.listSessions())).toEqual([]);
});

test("test_an_unusable_command_never_reaches_a_spawn", async () => {
  // The classification must not depend on which layer does the rejecting.
  //
  // This is the assertion the platform-specific version could not make. Whether
  // an empty argv is refused in the language or in `CreateProcess` differs by
  // platform, so a test that only checks the resulting `kind` passes on the
  // platform it was written on and says nothing about the other. Pinning that
  // the caller's command never reaches a spawn states the property itself.
  //
  // Note that a spawn *is* performed during a refused start: the provider runs
  // its own version probe (D-0010) first. So "nothing was spawned" is the wrong
  // assertion, and the right one is that **the caller's argv** was never the
  // thing spawned. In the port the probe goes through `runProbe` and the child
  // through `spawn`, so the recorder is installed over both -- a recorder on
  // `spawn` alone would see an empty log during a refused start, which is a
  // weaker question than the source asks.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const spawnedArgv: unknown[] = [];
  const realSpawn = sessionRuntime.spawn.bind(sessionRuntime);
  const realProbe = sessionRuntime.runProbe.bind(sessionRuntime);
  const record = (argv: readonly string[]): void => {
    // `args[0] if isinstance(args[0], str) else list(args[0])`. The string arm
    // is unreachable through the port's types and is kept because the source's
    // last assertion is about it: a bare string must not be taken apart into
    // its characters, and recording it whole is what lets that be checked.
    spawnedArgv.push(typeof (argv as unknown) === "string" ? argv : [...argv]);
  };
  patchSeam(sessionRuntime, "spawn", (argv, options) => {
    record(argv);
    return realSpawn(argv, options);
  });
  patchSeam(sessionRuntime, "runProbe", (argv, timeoutMs) => {
    record(argv);
    return realProbe(argv, timeoutMs);
  });

  const unusable: readonly unknown[] = [[], [process.execPath, "-e", `0${NUL}`], "a-bare-string"];
  for (const command of unusable) {
    const result = await provider.start(stubRequest(root, "s-1", { command }));
    expect(result, JSON.stringify(command)).toBeInstanceOf(Failure);
    expect((result as Failure).kind, JSON.stringify(command)).toBe(FailureKind.REFUSED_BY_PROVIDER);
  }

  for (const command of unusable) {
    expect(spawnedArgv, `${JSON.stringify(command)} was handed to the spawn`).not.toContainEqual(
      command,
    );
  }
  // A bare string must not be taken apart either: iterating it would spawn its
  // first character, which is what the shape check exists to prevent.
  expect(spawnedArgv).not.toContainEqual([..."a-bare-string"]);
  expect(okValue(await provider.listSessions())).toEqual([]);
});

test("test_the_windows_spawn_failure_no_longer_changes_the_answer", async () => {
  // The reported CI failure, reproduced on any platform.
  //
  // On Windows an empty argv reached `CreateProcess` and came back as
  // `OSError(EINVAL)` -- `[WinError 87] The parameter is incorrect` -- which is
  // indistinguishable at the call site from a genuine spawn failure and was
  // therefore classified `BACKEND_UNREACHABLE`. The behaviour is injected here
  // so the regression is provable without a Windows runner: if the check ever
  // moves back behind the spawn, this fails on Linux and macOS too.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const realSpawn = sessionRuntime.spawn.bind(sessionRuntime);
  patchSeam(sessionRuntime, "spawn", (argv, options) => {
    // Only the *child* spawn behaves like Windows. The source needs this guard
    // because its probe and its child both go through `Popen`; here they go
    // through different seam members, so the guard is belt and braces -- kept
    // because it is the source's, and because a future port of the probe onto
    // this member would need it.
    if (argv.length === 0) {
      const failure: NodeJS.ErrnoException = new Error("[WinError 87] The parameter is incorrect");
      failure.errno = 22;
      failure.code = "EINVAL";
      return Promise.reject(failure);
    }
    return realSpawn(argv, options);
  });

  const result = await provider.start(stubRequest(root, "s-1", { command: [] }));
  expect(result).toBeInstanceOf(Failure);
  expect(
    (result as Failure).kind,
    "an empty argv is unusable caller settings on every platform; letting " +
      "the operating system's errno decide makes the same request get two " +
      "different answers depending on where it runs",
  ).toBe(FailureKind.REFUSED_BY_PROVIDER);
});

test("test_a_well_formed_command_that_cannot_be_spawned_is_still_unreachable", async () => {
  // The refusal must not over-reach and swallow real spawn failures.
  //
  // A command that is *well formed* but names something that will not start is
  // a different answer -- the backend could not be reached -- and moving the
  // unusability check earlier must not collapse the two. If it did, a genuinely
  // broken environment would be reported as a configuration mistake.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const missing = join(root, "no-such-executable-anywhere");
  const result = await provider.start(stubRequest(root, "s-1", { command: [missing] }));

  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.BACKEND_UNREACHABLE);
  expect(okValue(await provider.listSessions())).toEqual([]);
});

test("test_the_refused_command_is_reported_back_with_the_refusal", async () => {
  // The caller has to be able to see *which* setting was unusable.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const result = await provider.start(stubRequest(root, "s-1", { command: [] }));
  // Exact equality, so an extra key would fail: the source compares the whole
  // mapping, and `list(raw)` rather than `repr(raw)` is what makes the value an
  // empty list rather than the string `[]`.
  expect((result as Failure).providerDetail).toEqual({ command: [] });
  expect((result as Failure).detail).toContain("at least one argument");
});

test("test_a_state_word_that_is_not_utf8_is_could_not_observe", async () => {
  // A child writes what it likes; unreadable bytes are not a state.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  // The source's child puts the two bytes straight into the state file. This
  // one renames a partial file onto it instead, which is the idiom the source's
  // own default child uses and for the source's own stated reason: the poll
  // below waits for the file to *exist*, and a direct write leaves a window in
  // which it exists and is empty. In that window the provider reports "has not
  // reported a state yet" and the assertion below would fail for a reason that
  // has nothing to do with UTF-8. No assertion changes.
  const child = callerSuppliedChild(
    [
      'fs.writeFileSync(statePath + ".part", Buffer.from([0xff, 0xfe]));',
      'fs.renameSync(statePath + ".part", statePath);',
    ].join("\n"),
  );
  await provider.start(stubRequest(root, "s-1", { command: child }));

  // `provider._sessions["s-1"].state_file.exists()`, through the `@internal`
  // accessor (D-0101).
  const stateFile = provider.stateFileOf("s-1");
  expect(stateFile).not.toBeNull();
  const deadline = performance.now() + POLL_DEADLINE_MS;
  while (!existsSync(stateFile as string)) {
    expect(performance.now() < deadline, "child never wrote its state file").toBe(true);
    await pause(POLL_INTERVAL_MS);
  }

  const readout = okValue(await provider.readState("s-1"));
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);
  expect(String(readout.couldNotObserveReason)).toContain("not UTF-8");
});

test("test_an_unusable_workspace_path_is_a_failure_not_an_exception", async () => {
  // S1 only requires a non-empty string, so the provider checks the rest.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const result = await provider.start(
    // No `settings` argument, as the source omits it: it defaults to `{}`.
    new StartRequest({
      sessionId: "s-1",
      workspace: join(root, `with${NUL}nul`),
      role: "worker",
    }),
  );
  expect(result).toBeInstanceOf(Failure);
  expect((result as Failure).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect(okValue(await provider.listSessions())).toEqual([]);
});

parametrize(
  "test_a_child_command_that_is_not_a_list_is_refused",
  [
    ["1", 1],
    ["a-bare-string", "a-bare-string"],
    // pytest names a dict positionally, so this id is a pytest artefact and is
    // hard-coded rather than derived from the value.
    ["command2", { argv: ["x"] }],
  ] as const,
  async (command: unknown) => {
    // `settings` is opaque, so anything at all can arrive as a command.
    const root = caseRoot("stub");
    const provider = stubProvider(root);
    const result = await provider.start(stubRequest(root, "s-1", { command }));
    expect(result).toBeInstanceOf(Failure);
    expect((result as Failure).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
    expect(okValue(await provider.listSessions())).toEqual([]);
  },
);

test("test_a_refused_resume_releases_the_exited_childs_pipe", async () => {
  // Repeated failed resumes must not be a way to exhaust descriptors.
  //
  // ADAPTED. The source's `_reopened_pipe` builds a genuinely open write end
  // with `os.pipe()`, which Node exposes no equivalent for on Node 22. The
  // substitute is an in-memory writable, which is what
  // `ChildHandle.stdinClosed()` asks about anyway -- it reports the port's own
  // closed-by-us flag, and `replaceStdin` resets it. What the replacement is
  // *for* is unchanged and is the whole point of the case: `stop` has already
  // closed the real pipe by now, so without one the assertion below would be
  // satisfied by the previous verb and would prove nothing about `resume`.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  await provider.start(stubRequest(root));
  await provider.stop("s-1");
  const child = provider.childOf("s-1");
  expect(child).not.toBeNull();
  (child as ChildHandle).replaceStdin(reopenedPipe());

  const resumed = await provider.resume("s-1");
  expect(resumed).toBeInstanceOf(Failure);
  expect((provider.childOf("s-1") as ChildHandle).stdinClosed()).toBe(true);
});

// -- target-only: what this port has that the source cannot express -------

test("start routes both the probe and the child through the runtime seam (target-only)", async () => {
  // D-0014's liveness requirement for the two seam members the cases above
  // substitute. A seam production stopped routing through installs cleanly,
  // goes green and exercised the real thing the whole time -- and here that
  // failure is invisible in exactly the wrong direction: the two cases that
  // patch `spawn` and `runProbe` both assert that something is *absent* from
  // the record, which an unreachable record satisfies for free.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const seen: string[][] = [];
  const realSpawn = sessionRuntime.spawn.bind(sessionRuntime);
  const realProbe = sessionRuntime.runProbe.bind(sessionRuntime);
  patchSeam(sessionRuntime, "spawn", (argv, options) => {
    seen.push([...argv]);
    return realSpawn(argv, options);
  });
  patchSeam(sessionRuntime, "runProbe", (argv, timeoutMs) => {
    seen.push([...argv]);
    return realProbe(argv, timeoutMs);
  });

  expect(await provider.start(stubRequest(root))).toBeInstanceOf(Ok);
  // The probe first (the D-0010 gate runs before anything is created), then the
  // child. Both argv values are the provider's own, so this pins the routing
  // and the order in one read.
  expect(seen).toEqual([
    [process.execPath, "-e", expect.stringContaining("process.versions.node")],
    [process.execPath, "-e", DEFAULT_CHILD_PROGRAM],
  ]);
});

test("the five verbs are serialised per provider instance (target-only, D-0301)", async () => {
  // D-0301 part 3. In Python `list_sessions` cannot run while `_start_session`
  // is mid-spawn, because there is one thread; the port has to build that, and
  // no source case can construct the interleaving, so nothing in the 43 above
  // would notice the queue being deleted.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const order: string[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realSpawn = sessionRuntime.spawn.bind(sessionRuntime);
  patchSeam(sessionRuntime, "spawn", async (argv, options) => {
    order.push("spawn entered");
    await gate;
    return await realSpawn(argv, options);
  });

  const started = provider.start(stubRequest(root)).then((result) => {
    order.push("start settled");
    return result;
  });
  const listed = provider.listSessions().then((result) => {
    order.push("list settled");
    return result;
  });

  // Several real macrotask turns. Nothing in `listSessions` waits on the child,
  // so without the queue it would have run to completion by now.
  for (let turn = 0; turn < 5; turn += 1) {
    await pause(5);
  }
  expect(order).toEqual(["spawn entered"]);

  release();
  expect(okValue(await started)).toBeInstanceOf(SessionReadout);
  expect(okValue(await listed)).toHaveLength(1);
  expect(order).toEqual(["spawn entered", "start settled", "list settled"]);
});

test("every read of a child's exit status is preceded by a macrotask settle (target-only, D-0301)", async () => {
  // D-0301 part 4, the routing half (D-0014). The three call sites in this
  // module can all be deleted without a single one of the 43 ported cases
  // noticing -- measured -- because every path that reads an exit status is
  // also reached through an awaited `waitForExit` or a polling helper, and both
  // supply the macrotask turn incidentally. What is lost is not an answer but
  // its *timing*: a readout taken straight after a state change silently
  // becomes the previous one, in the "already exited but still reads as
  // running" direction, and under the shuffled order (D-0005) that arrives as
  // someone else's flake.
  //
  // The other half of the decision -- that `settleExits` must be a *macrotask*
  // yield and not `await Promise.resolve()` -- belongs to the shared runtime and
  // is asserted once, in `test/session/claude-cli-provider.test.ts`.
  const root = caseRoot("stub");
  const provider = stubProvider(root);
  const calls: string[] = [];
  const realSettle = sessionRuntime.settleExits.bind(sessionRuntime);
  const realExitStatus = sessionRuntime.exitStatusOf.bind(sessionRuntime);
  patchSeam(sessionRuntime, "settleExits", () => {
    calls.push("settle");
    return realSettle();
  });
  patchSeam(sessionRuntime, "exitStatusOf", (child) => {
    calls.push("read");
    return realExitStatus(child);
  });

  // Pass-throughs, so this is the real child and the real ladder throughout.
  expect(await provider.start(stubRequest(root))).toBeInstanceOf(Ok);
  expect(await provider.readState("s-1")).toBeInstanceOf(Ok);
  // `resume`'s own answer is not this case's subject -- the case that owns it
  // is above -- but its exit-status read is one of the three call sites, so the
  // verb is driven.
  await provider.resume("s-1");
  expect(await provider.stop("s-1")).toBeInstanceOf(Ok);

  expect(calls, "no verb read a child's exit status at all").toContain("read");
  expect(calls.indexOf("settle"), "a child's exit status was read before any settle").toBe(0);
  // Every read, not merely the first: a settle has to sit between each verb's
  // entry and the readout it takes, so there can never be fewer settles than
  // reads.
  expect(calls.filter((name) => name === "settle").length).toBeGreaterThanOrEqual(
    calls.filter((name) => name === "read").length,
  );
});
