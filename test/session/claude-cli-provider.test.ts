import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import process from "node:process";

import { expect, test } from "vitest";

import { PyValueError } from "../../src/fencing/pysemantics.js";
import {
  CLI_VERSION_WRITTEN_AGAINST,
  ClaudeCliSessionProvider,
} from "../../src/session/claude_cli_provider.js";
import {
  Failure,
  FailureKind,
  Observation,
  Ok,
  type ProviderResult,
  REQUIRED_CAPABILITIES,
  type SessionReadout,
  SpawnRefused,
  StartRequest,
  WorkspaceDecision,
  type WorkspaceLifecycleObserver,
  type WorkspaceTransition,
  WorkspaceVerdict,
} from "../../src/session/provider.js";
import { sessionRuntime } from "../../src/session/runtime.js";
import { claudeSessionUuid } from "../../src/session/uuid5.js";
import { caseRoot } from "../testkit/cases.js";
import { chdirForTest } from "../testkit/cwd.js";
import { expectRefusal } from "../testkit/errors.js";
import { skipIf } from "../testkit/marks.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";
import {
  FAKE_VERSION,
  type FakeMode,
  fakeCli,
  fakeEnv,
  fakeMode,
  spawnLog,
} from "./helpers/fake-cli.js";
import {
  cliRequest,
  describeValue,
  POLL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  recordedGeneration,
  recordPath,
  recordPlanter,
  spawned,
  stopSessionsAtTeardown,
  waitForExit,
  waitForSpawns,
  waitForState,
} from "./helpers/session-cases.js";
import { docBlockBefore, methodDeclaration, repoSource } from "./helpers/source-text.js";

/**
 * S2 -- the C2 provider, exercised hermetically against a fake CLI.
 *
 * Every case here runs against a small stand-in for the `claude` executable,
 * for two reasons that matter more than realism:
 *
 * - the real CLI spends a billed model turn per spawn and does not exist on the
 *   CI matrix at all, so a suite that needed it would be a suite that never
 *   runs where regressions are caught;
 * - the failure shapes this provider is actually about -- a wrong identity read
 *   back, a refusal that exists only on stderr, a child that answers garbage,
 *   `is_error` alongside exit 0 -- are exactly the shapes a live healthy CLI
 *   will not produce on demand.
 *
 * The fake renders the *public surface the probes recorded* (`--version`, the
 * `--help` flag text, stream-json events with `session_id` in `init` and
 * `terminal_reason` / `is_error` / `subtype` in `result`) and nothing else.
 * Where a fact is provider-shaped and measured rather than contractual -- the
 * U27 admission-window width, say -- nothing here asserts it.
 *
 * Ported from interlock `tests/session/test_claude_cli_provider.py` at
 * `65f36c5`: 65 node ids, of which 63 are `ported` and two are `adapted` --
 * `test_the_refusal_is_stated_not_to_be_a_lock_next_to_the_spawn_path` and
 * `test_resume_says_it_is_unguarded_and_names_the_lease_as_the_gate`, each
 * carrying `ADAPTED.` at its head, and each because a Python docstring is a
 * string on the object where a JSDoc block is gone before anything runs. Eight
 * target-only cases at the end map to no source id and are declared as such in
 * the ledger.
 *
 * ## What is real here, and what is substituted
 *
 * **The normal path drives a real child process.** `sessionRuntime`'s
 * behaviour is *substituted* in exactly three places in this file, each of them
 * a branch a real child cannot reach: the Windows-equivalent liveness refusal
 * (`isPosix`), a record write that fails (`writeAtomic`), and a signal that is
 * delivered nowhere (`signalGroup`). Mocking the spawn generally would lose the
 * grandchild sweep and the spawn-error classification, which are the guarantees
 * this belt exists to prove.
 *
 * The target-only cases at the end also reach for `patchSeam`, and every one of
 * those patches is a **pass-through**: it records that the member was called
 * and delegates to the real one, so the child, the ladder and the record are
 * still the real ones. Substituting behaviour and observing it are different
 * acts, and only the first is rationed.
 *
 * ## Two target-side details that are not the source's
 *
 * - **Every hanging child is given a bounded sleep** ({@link BOUNDED_SLEEP})
 *   rather than the fake's 60-second default. Nothing observes the difference
 *   -- every deadline in this file is ten seconds -- and what it buys is that a
 *   missed kill self-heals inside the run rather than outliving it. On the
 *   Windows cell a surviving child holds its generation's `events-NNN.jsonl`
 *   open, and a directory with an open handle in it cannot be removed.
 * - **The teardown waits for the exits it asks for**, which the source's
 *   fixture does not need to. `stopSessionsAtTeardown` is that fixture plus the
 *   wait; see `./helpers/session-cases.ts`.
 */

// -- the source's module-level constants -----------------------------------

/**
 * `FAKE_SLEEP` for every case that leaves a child running on purpose.
 *
 * Thirty seconds: three times the longest deadline in this file, so no case can
 * race it, and short enough that a child a stop failed to reach is gone well
 * before the run ends. The source's fake defaults to sixty and no source case
 * sets this.
 */
const BOUNDED_SLEEP = "30";

/** A NUL, spelled as an escape so this file stays ASCII text. */
const NUL = "\u0000";

/**
 * `IS_POSIX = os.name == "posix"`, read once at module load.
 *
 * Collection time, as pytest evaluates a `skipif` condition (rule 4), and bound
 * once so that {@link posixTest} below is the file's only `skipIf` site for it.
 */
const IS_POSIX = process.platform !== "win32";

/**
 * `HAS_PROC = Path("/proc").is_dir()`.
 *
 * A real directory probe and **not** `platform === "linux"`, because the reason
 * strings the gated cases carry are about *macOS* -- a POSIX host with no
 * `/proc`. Deriving the condition from the platform name would make those
 * reasons untrue on the one host they were written for, and would silently run
 * five cases whose subject does not exist there.
 *
 * `is_dir()` and not `existsSync`: the two answer differently for a regular
 * file or a symlink named `/proc`, and it is the directory the gated cases
 * read `<pid>/cmdline` out of. `throwIfNoEntry: false` is what makes the
 * missing case an answer rather than an exception, which is `is_dir()`'s own
 * contract.
 */
const HAS_PROC = statSync("/proc", { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * `@pytest.mark.skipif(not IS_POSIX, reason=...)`, with the reason at the call
 * site.
 *
 * The two gate factories exist so that the `skipIf` construct appears **twice**
 * in this file -- once per condition -- while each of the seven gated cases still
 * carries its own reason string verbatim from the source. `scripts/parity-check.mjs`
 * counts the textual construct and requires an exact ledger approval per file, so
 * seven spellings of two conditions would be seven approvals for one fact.
 * Reasons differ per case and are not factored out: the reason is what a CI log
 * shows instead of a result, and the source wrote six distinct ones across its
 * seven gated cases because six different things are unavailable.
 */
function posixTest(reason: string): ReturnType<typeof skipIf> {
  return skipIf(!IS_POSIX, reason);
}

/** The same for `@pytest.mark.skipif(not HAS_PROC, reason=...)`. */
function procTest(reason: string): ReturnType<typeof skipIf> {
  return skipIf(!HAS_PROC, reason);
}

// -- the fixtures, and the helpers the cases share -------------------------

/**
 * The `provider` fixture: the fake CLI, a state root under the case root, and
 * the source's `stop_timeout=2.0`.
 *
 * The state root is `<root>/state`, a **subdirectory** of the case root, as the
 * source's fixture has it -- `<root>/workspaces/<id>` sits beside it, and
 * several cases read one while the provider owns the other.
 *
 * `stopSessionsAtTeardown` is the source's teardown (`list_sessions`, then
 * `stop` each) plus the one thing the source does not need: it **waits** for
 * each child to be gone. Registered after `caseRoot()` on purpose --
 * `onTestFinished` unwinds LIFO, so a later registration runs earlier, and the
 * children must be gone before the directory they are writing into is removed.
 */
function cliProvider(root: string): ClaudeCliSessionProvider {
  return stopSessionsAtTeardown(
    new ClaudeCliSessionProvider(join(root, "state"), {
      claudeCommand: fakeCli(root),
      stopTimeout: 2.0,
    }),
  );
}

/**
 * A scenario whose child stays up until it is stopped.
 *
 * Sets the mode and the bounded sleep together, because the two belong
 * together: the modes that hang are exactly the ones whose default sixty-second
 * sleep would outlive a failed stop.
 */
function hangingChild(mode: FakeMode): void {
  fakeMode(mode);
  fakeEnv("FAKE_SLEEP", BOUNDED_SLEEP);
}

/**
 * `_plant_record(tmp_path, session_id, **overrides)`, bound to the derivation
 * production uses.
 *
 * Curried in `./helpers/session-cases.ts` so the helper cannot carry a second
 * implementation of `claude_session_uuid` that agrees with itself and disagrees
 * with the provider; bound here, once, to the real one.
 */
const plantRecord = recordPlanter(claudeSessionUuid);

/**
 * `result.value` on a result that has to be an `Ok`.
 *
 * The source writes `.value` bare and lets Python raise `AttributeError` if a
 * `Failure` ever came back. The port has to say what happens instead, and says
 * it as an assertion naming the result, so a refusal is reported as a refusal
 * rather than as `undefined` failing some later comparison.
 */
function okValue<T>(result: ProviderResult<T>): T {
  expect(result, `expected Ok, got ${describeValue(result)}`).toBeInstanceOf(Ok);
  return (result as Ok<T>).value;
}

/** The same, for a result that has to be a `Failure`. */
function refusalOf(result: ProviderResult<unknown>): Failure {
  expect(result, `expected Failure, got ${describeValue(result)}`).toBeInstanceOf(Failure);
  return result as Failure;
}

/**
 * `uuid.UUID(text).version`.
 *
 * **Not the nibble at index 14.** CPython's `UUID.version` is guarded by
 * `UUID.variant`: it answers `None` for anything that is not an RFC 4122
 * layout, and only reads the version bits once the two top bits of octet 8
 * are `10`. Reading index 14 off the string answers `5` for a value whose
 * variant bits were never normalised, so `assert uuid.UUID(first).version == 5`
 * would fail on a derivation this case would call green -- the case asserting
 * less than its source (rule 0's floor).
 *
 * So both halves are computed the way CPython computes them: parse the text
 * the way `UUID(hex=...)` does (the `urn:uuid:` prefix and the surrounding
 * braces removed, the hyphens dropped, thirty-two hex digits required, and a
 * `ValueError` if that does not hold), then gate the version on the variant.
 */
function uuidVersionOf(text: string): number | null {
  const hex = text
    .replace("urn:", "")
    .replace("uuid:", "")
    .replace(/^\{|\}$/g, "")
    .replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`uuid.UUID() would refuse ${JSON.stringify(text)}`);
  }
  const value = BigInt(`0x${hex}`);
  // `UUID.variant`: `RFC_4122` iff bit 63 is set and bit 62 is clear, which is
  // exactly CPython's two-step `if not int & (0x8000 << 48) ... elif not int &
  // (0x4000 << 48)`.
  const isRfc4122 = (value & (0x8000n << 48n)) !== 0n && (value & (0x4000n << 48n)) === 0n;
  return isRfc4122 ? Number((value >> 76n) & 0xfn) : null;
}

/**
 * The durable record, parsed.
 *
 * `json.loads(path.read_text())` -- and the field accessor below is the other
 * half, because Python subscripting raises `KeyError` for a missing key where
 * JavaScript hands back `undefined`. Three cases assert a field `is not None`,
 * and `undefined` would satisfy that assertion while meaning the opposite.
 */
function readRecord(root: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(recordPath(root, sessionId), "utf8")) as Record<string, unknown>;
}

/** `record[key]`, with a missing key raising rather than answering `undefined`. */
function recordField(record: Record<string, unknown>, key: string): unknown {
  expect(Object.hasOwn(record, key), `the record has no ${JSON.stringify(key)} field`).toBe(true);
  return record[key];
}

/** The poll's own timer, independent of the runtime seam's `sleep`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The hand-rolled poll in `test_a_complete_line_that_is_not_json_fails_loudly`.
 *
 * Not `waitForState`: what that case waits for is the *absence* of an `Ok`, and
 * the deadline message is its own (`never failed loudly`). Kept here rather
 * than in the shared helpers because it is one case's loop, and the source
 * writes it inline for the same reason.
 */
async function waitForLoudFailure(
  provider: ClaudeCliSessionProvider,
  sessionId: string,
): Promise<Failure> {
  const deadline = performance.now() + POLL_DEADLINE_MS;
  for (;;) {
    const result = await provider.readState(sessionId);
    if (result instanceof Failure) {
      return result;
    }
    expect(performance.now() < deadline, `never failed loudly: ${describeValue(result)}`).toBe(
      true,
    );
    await pause(POLL_INTERVAL_MS);
  }
}

/**
 * The grandchild's pid, once the fake CLI has announced it.
 *
 * The source polls `pid_file.exists()` and then reads it; this waits for a
 * *complete* number instead, because the two languages differ on a torn read.
 * `int("")` raises `ValueError` and fails the case loudly, where
 * `Number.parseInt("")` is `NaN`, and `NaN` would flow into `_pid_running` as a
 * pid that answers "gone" -- so the two group-sweep cases would pass while
 * observing nothing. The deadline and its message are the source's.
 */
async function waitForAnnouncedPid(pidFile: string): Promise<number> {
  const deadline = performance.now() + POLL_DEADLINE_MS;
  for (;;) {
    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid >= 1) {
        return pid;
      }
    }
    expect(performance.now() < deadline, "the grandchild never announced itself").toBe(true);
    await pause(POLL_INTERVAL_MS);
  }
}

/**
 * `while s2._pid_running(pid): assert time.monotonic() < deadline, message`.
 *
 * The oracle is the seam's own `pidRunning`, which is what the source reaches
 * for as a module attribute -- the same function the provider's orphan loops
 * use, so the case cannot pass by agreeing with a second implementation.
 */
async function waitForPidToGo(pid: number, message: string): Promise<void> {
  const deadline = performance.now() + POLL_DEADLINE_MS;
  while (sessionRuntime.pidRunning(pid)) {
    expect(performance.now() < deadline, message).toBe(true);
    await pause(POLL_INTERVAL_MS);
  }
}

/**
 * The `pid` a durable record's JSON text carries, or `null`.
 *
 * `record.pid is not None` in the source's `failing_second_write`, asked of the
 * rendered text rather than of a dataclass because the seam this port
 * substitutes takes a path and a string. Anything that is not JSON, or is JSON
 * without a numeric `pid`, answers `null`.
 */
function recordedPidIn(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

/**
 * `monkeypatch.setattr(ClaudeCliSessionProvider, "_write_record",
 * failing_second_write)`.
 *
 * The source patches the provider's own method and discriminates on
 * `record.pid is not None`; the port's only write seam is
 * `sessionRuntime.writeAtomic`, so the discriminator has to be reconstructed
 * from what that member is given. **Both halves are load-bearing:**
 *
 * - the basename, because `#recordProbeEvidence` writes `probe-evidence.txt`
 *   through the same member and it is not JSON -- a pid-only guard would leave
 *   the probe's evidence write intact but a basename-only guard would break the
 *   probe, and the probe runs before every start;
 * - the pid, because *that the second write is the one carrying it* is exactly
 *   the property the two cases below exist to prove. A substitute that failed
 *   the first write would refuse the start before any child existed, and both
 *   cases would still be green while observing nothing about a running child.
 */
function refuseTheRecordWriteCarryingAPid(): void {
  const realWriteAtomic = sessionRuntime.writeAtomic.bind(sessionRuntime);
  patchSeam(sessionRuntime, "writeAtomic", (path, text) => {
    if (basename(path) === "record.json" && recordedPidIn(text) !== null) {
      // `OSError(28, "No space left on device")`. Node spells the same failure
      // with a string `code` and a negative `errno`; nothing here asserts on
      // either, and the port's `errorText` renders whichever it is given.
      const noSpace: NodeJS.ErrnoException = new Error("No space left on device");
      noSpace.errno = -28;
      noSpace.code = "ENOSPC";
      throw noSpace;
    }
    realWriteAtomic(path, text);
  });
}

// --------------------------------------------------------------------------
// The identity: derived before the spawn, as a pure function
// --------------------------------------------------------------------------

test("test_a_uuid_session_id_is_honoured_verbatim", () => {
  const chosen = "4C3A9A0E-D6E5-4D90-AEE0-0ED948DD8631";
  // `str(uuid.UUID(x))` canonicalises, and for a well-formed hyphenated
  // uppercase UUID canonicalising is exactly lowercasing.
  expect(claudeSessionUuid(chosen)).toBe(chosen.toLowerCase());
});

test("test_a_non_uuid_session_id_derives_the_same_uuid_every_time", () => {
  // Committable ahead of the process: no spawn is consulted to know it.
  const first = claudeSessionUuid("item11-bound-session");
  expect(first).toBe(claudeSessionUuid("item11-bound-session"));
  expect(uuidVersionOf(first)).toBe(5);
  expect(claudeSessionUuid("another-session")).not.toBe(first);
});

// --------------------------------------------------------------------------
// The capability probe (D-0010)
// --------------------------------------------------------------------------

test("test_the_probe_reports_the_clis_own_version_and_every_capability", () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  const result = provider.probeCapabilities();
  expect(result).toBeInstanceOf(Ok);
  const report = okValue(result);
  expect(report.providerVersion).toBe(FAKE_VERSION);
  // `report.supported >= REQUIRED_CAPABILITIES` -- a superset test, written out
  // because JavaScript's `Set` has no comparison operator and the naive
  // `size >= size` would pass for two disjoint sets of equal size.
  for (const capability of REQUIRED_CAPABILITIES) {
    expect(report.supported.has(capability), capability).toBe(true);
  }
  // The raw version answer is in the report, which is where D-0010's record of
  // "the capability probe's raw output" travels.
  expect(report.detail).toContain(FAKE_VERSION);
});

test("test_a_missing_flag_is_a_missing_capability_and_refuses_the_spawn", () => {
  const root = caseRoot("cli");
  fakeEnv("FAKE_HELP_OMIT", "--resume");
  // Its own provider, carrying the **default** `stopTimeout` rather than the
  // fixture's 2.0. The source builds it that way, and normalising the two would
  // quietly change what this case constructs. Nothing is spawned here, so there
  // is nothing to tear down.
  const provider = new ClaudeCliSessionProvider(join(root, "state"), {
    claudeCommand: fakeCli(root),
  });

  const result = provider.probeCapabilities();
  expect(result).toBeInstanceOf(Ok);
  // A missing flag is a missing *capability*, not a failed probe.
  expect(okValue(result).missing.has("session.resume")).toBe(true);

  // `start` is the gate and it **throws** -- synchronously, before anything is
  // created -- so this is `expectRefusal` and not an awaited `Failure`.
  const refusal = expectRefusal(() => provider.start(cliRequest(root)), SpawnRefused);
  expect(refusal.message).toContain("session.resume");
});

test("test_an_absent_cli_is_a_failure_that_refuses_the_spawn", () => {
  const root = caseRoot("cli");
  // A plain string, so the command is a one-element prefix, as the source's is.
  const provider = new ClaudeCliSessionProvider(join(root, "state"), {
    claudeCommand: join(root, "no-such-claude"),
  });

  const result = provider.probeCapabilities();
  expect(result).toBeInstanceOf(Failure);
  // Node reports a missing executable through an `error` event on a later turn
  // where Python's `subprocess.run` raises `OSError`; the seam folds the two
  // into the one outcome this classification depends on.
  expect(refusalOf(result).kind).toBe(FailureKind.BACKEND_UNREACHABLE);

  expectRefusal(() => provider.start(cliRequest(root)), SpawnRefused);
});

// --------------------------------------------------------------------------
// start: the readout before the child has spoken (R4's reachable case)
// --------------------------------------------------------------------------

test("test_a_fresh_start_is_could_not_observe_with_a_reason", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  // The silent child writes nothing at all, which is what makes this
  // deterministic rather than a race against the first event.
  hangingChild("silent");

  const result = await provider.start(cliRequest(root));
  expect(result).toBeInstanceOf(Ok);
  const readout = okValue(result);
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);
  expect(readout.couldNotObserveReason).toBeTruthy();
  expect(readout.providerState).toBeNull();
});

test("test_the_identity_is_durably_recorded_before_it_is_ever_read_back", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");

  await provider.start(cliRequest(root));

  // The record is written twice -- once before the spawn with `pid: null`, once
  // after with the pid -- and this reads the second.
  const record = readRecord(root, "sess-1");
  expect(recordField(record, "claude_session_uuid")).toBe(claudeSessionUuid("sess-1"));
  expect(recordField(record, "pid")).not.toBeNull();
});

test("test_a_session_id_that_escapes_the_state_root_is_refused", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  // The workspace here is the case root itself, and it exists -- the refusal is
  // about the id, and the probe gate has to pass before it can be issued.
  const result = await provider.start(
    new StartRequest({ sessionId: "../evil", workspace: root, role: "worker" }),
  );
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
});

test("test_a_session_id_is_never_reused", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");

  expect(await provider.start(cliRequest(root))).toBeInstanceOf(Ok);
  const again = await provider.start(cliRequest(root));
  expect(again).toBeInstanceOf(Failure);
  expect(refusalOf(again).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
});

test("test_unknown_settings_keys_belong_to_someone_else_and_are_ignored", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");

  // `settings` is opaque per-role configuration: a key this provider does not
  // read must not refuse the start and must not reach the argv.
  const result = await provider.start(
    cliRequest(root, "sess-1", { announce_after: 3600, some_other_key: "x" }),
  );
  expect(result).toBeInstanceOf(Ok);
});

test("test_cli_args_from_settings_reach_the_spawn_verbatim", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");
  const log = spawnLog(root);

  await provider.start(
    cliRequest(root, "sess-1", {
      cli_args: ["--settings", "/some/role.json", "--permission-mode", "plan"],
    }),
  );

  const entries = await waitForSpawns(log, 1);
  expect(entries).toHaveLength(1);
  const argv = (entries[0] as { argv: readonly string[] }).argv;
  expect(argv[argv.indexOf("--settings") + 1]).toBe("/some/role.json");
  expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
  expect(argv[argv.indexOf("--session-id") + 1]).toBe(claudeSessionUuid("sess-1"));
  // `str((tmp_path / "workspaces" / "sess-1").resolve())`. The directory exists
  // by now -- the provider made it -- so `realpathSync` is that call exactly,
  // and it is what the child's own `process.cwd()` will have reported through a
  // platform where `/tmp` may be a symlink.
  expect((entries[0] as { cwd: string }).cwd).toBe(
    realpathSync(join(root, "workspaces", "sess-1")),
  );
});

parametrize<Readonly<Record<string, unknown>>>(
  "test_unusable_settings_are_refused_with_a_reason_before_any_spawn",
  [
    // The ids are pytest's, verbatim, and the order is the source's `ids=[...]`
    // list.
    ["bare-string-args", { cli_args: "--model haiku" }],
    ["nul-in-args", { cli_args: [`--set${NUL}tings`] }],
    ["empty-prompt", { prompt: "" }],
    ["non-string-prompt", { prompt: 42 }],
    ["blank-resume", { resume_prompt: "   " }],
    ["flag-shaped-prompt", { prompt: "-p looks like a flag" }],
  ],
  async (settings) => {
    const root = caseRoot("cli");
    const provider = cliProvider(root);
    const log = spawnLog(root);

    const result = await provider.start(cliRequest(root, "sess-1", settings));
    expect(result).toBeInstanceOf(Failure);
    const refusal = refusalOf(result);
    expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
    expect(refusal.detail.trim()).toBeTruthy();
    // Read without waiting, and an absent log is zero spawns: "no spawn
    // happened" is the absence of any line, and there is nothing to wait for.
    expect(spawned(log)).toEqual([]);
  },
);

test("test_a_vetoed_workspace_creation_refuses_the_start", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  // The observer protocol is structural in the source (duck-typed) and an
  // interface here; either way registration is the public seam.
  class Vetoer implements WorkspaceLifecycleObserver {
    onWorkspaceTransition(_transition: WorkspaceTransition): WorkspaceDecision {
      return new WorkspaceDecision(WorkspaceVerdict.VETO, "unsaved artifacts present");
    }
  }
  provider.registerWorkspaceObserver(new Vetoer());

  // The workspace does not exist, so the create path -- and the veto -- is
  // reached. Nothing is spawned: the veto precedes the child.
  const result = await provider.start(cliRequest(root));
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).detail).toContain("vetoed");
});

// --------------------------------------------------------------------------
// read_state: the child's own words, and exit codes never as evidence
// --------------------------------------------------------------------------

test("test_the_readout_carries_the_childs_own_terminal_word", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  await provider.start(cliRequest(root));

  const readout = await waitForState(provider, "sess-1", "completed");
  expect(readout.observation).toBe(Observation.OBSERVED);
  // `is False`, so the field has to be a real boolean and not a truthiness.
  expect(readout.providerDetail["is_error"]).toBe(false);
});

test("test_exit_zero_is_not_taken_as_evidence_of_success", async () => {
  // A SIGINT'd run exits 0 with `is_error: true`. The readout must carry the
  // child's own word for that, not an invented success.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  fakeEnv("FAKE_IS_ERROR", "1");
  fakeEnv("FAKE_TERMINAL_REASON", "aborted_streaming");
  fakeEnv("FAKE_EXIT", "0");

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");

  const readout = await waitForState(provider, "sess-1", "aborted_streaming");
  expect(readout.providerDetail["is_error"]).toBe(true);
  expect(readout.providerDetail["returncode"]).toBe(0);
});

test("test_unknown_event_types_are_carried_uninterpreted", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  // `init`, then an event of a type nothing has ever heard of, then a hang. The
  // last event has no `subtype`, so the state word is its `type`.
  hangingChild("events-then-hang");

  await provider.start(cliRequest(root));

  const readout = await waitForState(provider, "sess-1", "unheard_of_event");
  expect(readout.observation).toBe(Observation.OBSERVED);
});

test("test_a_complete_line_that_is_not_json_fails_loudly", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("garbage-then-hang");

  await provider.start(cliRequest(root));

  // The garbage branch under "the child is alive" comes *before* the
  // events-based readout, so a live child with one bad line fails loudly rather
  // than reporting its last good event.
  const result = await waitForLoudFailure(provider, "sess-1");
  expect(result.kind).toBe(FailureKind.UNINTERPRETABLE_RESPONSE);
  expect(result.detail).toContain("not JSON");
});

test("test_a_result_that_names_no_outcome_fails_loudly", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  // A `result` event with neither a `terminal_reason` nor a `subtype`.
  fakeEnv("FAKE_RESULT_BARE", "1");

  await provider.start(cliRequest(root));
  // The child is confirmed exited, so the file is complete and one read is
  // enough -- no polling.
  await waitForExit(provider, "sess-1");

  const result = await provider.readState("sess-1");
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).kind).toBe(FailureKind.UNINTERPRETABLE_RESPONSE);
});

test("test_the_stderr_only_refusal_is_captured_and_surfaced", async () => {
  // The `already in use` refusal exists only on stderr, with an empty stdout.
  // The readout is the exit disposition with that stderr attached -- carried
  // verbatim, never interpreted as a lock (U27/U38).
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  fakeMode("refuse-in-use");

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");

  const readout = await waitForState(provider, "sess-1", "exited-1");
  expect(String(readout.providerDetail["stderr_tail"])).toContain("already in use");
});

test("test_an_unknown_session_is_a_typed_failure", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  // The three verbs bound, so a failure names which one answered wrongly.
  // `never-started` is a valid path component, so the lookup reaches a missing
  // file rather than being refused for its shape.
  const verbs: readonly [string, (id: string) => Promise<ProviderResult<SessionReadout>>][] = [
    ["readState", (id) => provider.readState(id)],
    ["stop", (id) => provider.stop(id)],
    ["resume", (id) => provider.resume(id)],
  ];
  for (const [name, verb] of verbs) {
    const result = await verb("never-started");
    expect(result, name).toBeInstanceOf(Failure);
    expect(refusalOf(result).kind, name).toBe(FailureKind.UNKNOWN_SESSION);
  }
});

test("test_zero_sessions_is_a_fact_not_a_failure", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  // An exact value equality against `Ok(empty)`. `toStrictEqual` and not
  // `toEqual`, because Python's dataclass equality requires the same class and
  // `toEqual` would accept a plain `{value: []}`. Note that the state root does
  // not exist yet -- the probe has not run -- and listing must tolerate that
  // without an error and without creating it.
  expect(await provider.listSessions()).toStrictEqual(new Ok([]));
});

// --------------------------------------------------------------------------
// Identity read-back: a mismatch is an incident, not a warning
// --------------------------------------------------------------------------

test("test_a_wrong_identity_read_back_is_an_incident", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  // A random, definitely-different UUID reported in every event.
  fakeEnv("FAKE_REPORT_ID", crypto.randomUUID());

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");

  // Two implementation paths satisfy this, and both must stay: on a slow
  // machine the whole detection can happen inside `start()`'s own readout, in
  // which case this read is answered by the persisted-incident branch instead.
  const result = await provider.readState("sess-1");
  expect(result).toBeInstanceOf(Failure);
  const refusal = refusalOf(result);
  expect(refusal.kind).toBe(FailureKind.UNINTERPRETABLE_RESPONSE);
  expect(refusal.detail).toContain("identity incident");
  expect(refusal.providerDetail["expected"]).toBe(claudeSessionUuid("sess-1"));
});

test("test_an_identity_incident_survives_a_supervisor_restart", async () => {
  const root = caseRoot("cli");
  fakeEnv("FAKE_REPORT_ID", crypto.randomUUID());
  // One command prefix for both lives, as the source's one `fake_cli` fixture
  // gives both. Both carry the default `stopTimeout`.
  const command = fakeCli(root);
  const stateRoot = join(root, "state");
  const first = stopSessionsAtTeardown(
    new ClaudeCliSessionProvider(stateRoot, { claudeCommand: command }),
  );

  await first.start(cliRequest(root));
  await waitForExit(first, "sess-1", 10_000);
  expect(await first.readState("sess-1")).toBeInstanceOf(Failure);

  // A new supervisor life over the same state root: the incident is in the
  // durable record, so the session still answers as impounded rather than
  // reading as healthy. `second` holds no child, so it needs no teardown.
  const second = new ClaudeCliSessionProvider(stateRoot, { claudeCommand: command });
  const result = await second.readState("sess-1");
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).detail).toContain("identity incident");

  // And the acting verb refuses on it too, before any liveness question and
  // without spawning anything.
  const resumed = await second.resume("sess-1");
  expect(resumed).toBeInstanceOf(Failure);
  expect(refusalOf(resumed).detail).toContain("identity incident");
});

// --------------------------------------------------------------------------
// stop: the process group, and the readout taken after the exit
// --------------------------------------------------------------------------

test("test_stop_terminates_a_running_child_and_reports_what_is_left", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");

  await provider.start(cliRequest(root));
  const result = await provider.stop("sess-1");

  expect(result).toBeInstanceOf(Ok);
  const readout = okValue(result);
  expect(readout.observation).toBe(Observation.OBSERVED);
  // Prefix only, deliberately: the source does not observe the digits after the
  // dash for a signalled child, and the port's own convention for them is not
  // this case's to pin.
  expect(String(readout.providerState).startsWith("exited-")).toBe(true);
  // The record and captured output stay on disk: the disposition of what the
  // child left behind is that it is kept, not swept.
  expect(existsSync(recordPath(root, "sess-1"))).toBe(true);
});

test("test_stop_of_an_already_exited_child_is_a_readout_not_an_error", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");

  // Liveness is false, so the ladder is skipped entirely and the sweep finds
  // nothing carrying the marker. The readout is then the child's **own**
  // terminal word, not `exited-0`.
  const result = await provider.stop("sess-1");
  expect(result).toBeInstanceOf(Ok);
  expect(okValue(result).providerState).toBe("completed");
});

// --------------------------------------------------------------------------
// resume: adopt-or-spawn, in the order that cannot mint a second writer
// --------------------------------------------------------------------------

test("test_resume_of_a_live_child_adopts_it_and_spawns_nothing", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");

  await provider.start(cliRequest(root));
  const result = await provider.resume("sess-1");

  expect(result).toBeInstanceOf(Ok);
  // A resume that spawned would have bumped the durable generation before the
  // spawn -- the record, not a race against the child's own log, is the
  // evidence nothing was spawned.
  expect(recordedGeneration(root, "sess-1")).toBe(0);
});

test("test_resume_of_an_exited_session_spawns_dash_dash_resume", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  const log = spawnLog(root);

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");
  const result = await provider.resume("sess-1");
  expect(result).toBeInstanceOf(Ok);

  const entries = await waitForSpawns(log, 2);
  const argv = (entries[1] as { argv: readonly string[] }).argv;
  expect(argv[argv.indexOf("--resume") + 1]).toBe(claudeSessionUuid("sess-1"));
  // Never a fresh claim: U28 shows the dead session still holds it.
  expect(argv).not.toContain("--session-id");
  // The second generation must reach `completed` too, which it can only do if
  // the readout is reading `events-001.jsonl` and not the first life's file.
  await waitForState(provider, "sess-1", "completed");
});

test("test_resume_persists_its_generation_so_the_next_life_reads_the_right_output", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");
  await provider.resume("sess-1");

  const record = readRecord(root, "sess-1");
  expect(recordField(record, "generation")).toBe(1);
  // The zero-padded three-digit name, and the file exists from the moment the
  // spawn opened it for the child's stdout -- so there is no race here.
  expect(existsSync(join(root, "state", "sess-1", "events-001.jsonl"))).toBe(true);
});

// --------------------------------------------------------------------------
// Reclaim across supervisor lives: the orphan, its adoption, its recycled pid
// --------------------------------------------------------------------------

posixTest("orphan liveness is resolved via POSIX signals")(
  "test_an_orphans_record_is_detected_by_the_next_supervisor_life",
  async () => {
    const root = caseRoot("cli");
    hangingChild("silent");
    // One command prefix for both lives, and both carry the **default**
    // `stopTimeout` -- neither is the fixture's provider, which is why the
    // source takes `fake_cli` rather than `provider` here.
    const command = fakeCli(root);
    const stateRoot = join(root, "state");
    // The source's `try: ... finally: first.stop("orphaned")`, registered at
    // acquisition instead (rule 1) so it also runs when an assertion throws --
    // and it waits for the exit, which the source does not need to.
    const first = stopSessionsAtTeardown(
      new ClaudeCliSessionProvider(stateRoot, { claudeCommand: command }),
    );
    await first.start(cliRequest(root, "orphaned"));

    // A second supervisor life over the same state root. It holds no child of
    // its own, so it has nothing to tear down: everything it knows about the
    // session it read off the disk.
    const second = new ClaudeCliSessionProvider(stateRoot, { claudeCommand: command });
    const listed = await second.listSessions();
    expect(listed).toBeInstanceOf(Ok);
    expect(okValue(listed).map((readout) => readout.sessionId)).toEqual(["orphaned"]);
  },
);

procTest("adoption requires confirming the pid's command line via /proc")(
  "test_a_live_orphan_is_adopted_not_resumed_around",
  async () => {
    // The reclaim order issue #17 fixes: the surviving process is resolved
    // first, because a `--resume` issued while it runs is the second live
    // writer the provider will not refuse (U32).
    const root = caseRoot("cli");
    hangingChild("silent");
    const command = fakeCli(root);
    const stateRoot = join(root, "state");
    const first = stopSessionsAtTeardown(
      new ClaudeCliSessionProvider(stateRoot, { claudeCommand: command }),
    );
    await first.start(cliRequest(root, "orphaned"));

    const second = new ClaudeCliSessionProvider(stateRoot, {
      claudeCommand: command,
      stopTimeout: 2.0,
    });
    const result = await second.resume("orphaned");
    expect(result).toBeInstanceOf(Ok);
    // The durable generation, not a race against the child's own log: a resume
    // that spawned would have bumped it before the spawn.
    expect(recordedGeneration(root, "orphaned"), "resume spawned next to a live orphan").toBe(0);

    // And the adopting life can stop what it adopted -- an orphan is not a
    // child of this process, so the ladder takes its no-`wait` path.
    const stopped = await second.stop("orphaned");
    expect(stopped).toBeInstanceOf(Ok);
  },
);

procTest("the pid-reuse guard reads the pid's command line via /proc")(
  "test_a_recycled_pid_is_never_trusted_signalled_or_adopted",
  async () => {
    // A record whose pid now names a stranger -- here: this very test process --
    // must be read as "the child is gone". The stranger is left untouched and
    // the session is re-entered via `--resume` (i02 3.3).
    const root = caseRoot("cli");
    const log = spawnLog(root);
    const provider = stopSessionsAtTeardown(
      new ClaudeCliSessionProvider(join(root, "state"), { claudeCommand: fakeCli(root) }),
    );
    // The source writes this record out by hand, field for field; the fields
    // are `_plant_record`'s defaults with the two pid columns overridden, and
    // this is that helper with the same two overrides.
    plantRecord(root, "stale", { pid: process.pid, pgid: process.pid });

    const result = await provider.resume("stale");
    expect(result, `resume refused a reclaimable session: ${describeValue(result)}`).toBeInstanceOf(
      Ok,
    );
    const entries = await waitForSpawns(log, 1);
    // Exactly one, as the source's one-element unpacking requires: a provider
    // that had also signalled or adopted would show a second line here.
    expect(entries).toHaveLength(1);
    const argv = (entries[0] as { argv: readonly string[] }).argv;
    // Two argv entries, never `--resume=`, and the value is the derived uuid
    // rather than the raw session id.
    expect(argv[argv.indexOf("--resume") + 1]).toBe(claudeSessionUuid("stale"));
    await waitForState(provider, "stale", "completed");
  },
);

// --------------------------------------------------------------------------
// Degraded observation: broken records, unreadable output, unknowable liveness
// --------------------------------------------------------------------------

test("test_a_corrupt_record_does_not_vanish_and_does_not_read_as_unknown", async () => {
  // R4 at the roster: a session whose durable record cannot be read is still a
  // session -- explicitly unobservable with the reason, never absent and never
  // "this provider holds no record of one".
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  const sessionDir = join(root, "state", "broken");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "record.json"), '{"truncated', "utf8");

  const listed = await provider.listSessions();
  expect(listed).toBeInstanceOf(Ok);
  const readouts = okValue(listed);
  expect(readouts).toHaveLength(1);
  const readout = readouts[0] as SessionReadout;
  expect(readout.sessionId).toBe("broken");
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);
  expect(String(readout.couldNotObserveReason)).toContain("could not be read");

  const read = await provider.readState("broken");
  expect(read).toBeInstanceOf(Ok);
  expect(okValue(read).observation).toBe(Observation.COULD_NOT_OBSERVE);

  // Acting on an unreadable identity is refused, not guessed at.
  const verbs: readonly [string, (id: string) => Promise<ProviderResult<SessionReadout>>][] = [
    ["stop", (id) => provider.stop(id)],
    ["resume", (id) => provider.resume(id)],
  ];
  for (const [name, verb] of verbs) {
    const result = await verb("broken");
    expect(result, name).toBeInstanceOf(Failure);
    expect(refusalOf(result).kind, name).toBe(FailureKind.REFUSED_BY_PROVIDER);
  }

  // And the id is still never reused. Built directly rather than through
  // `cliRequest`, as the source builds it: no settings, and a workspace of its
  // own that does not exist -- the refusal precedes any workspace question.
  const again = await provider.start(
    new StartRequest({ sessionId: "broken", workspace: join(root, "w"), role: "worker" }),
  );
  expect(again).toBeInstanceOf(Failure);
});

test("test_an_unreadable_output_file_is_could_not_observe_not_a_failure", async () => {
  // S1's read_state contract: a session that exists but cannot be read yields
  // Ok(COULD_NOT_OBSERVE) with the reason -- Failure is reserved for an answer
  // in an uninterpretable shape.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  const sessionDir = plantRecord(root, "unreadable");
  // A directory where the events file should be, so the read raises on every
  // platform: EISDIR here, `IsADirectoryError` there.
  mkdirSync(join(sessionDir, "events-000.jsonl"));

  const result = await provider.readState("unreadable");
  expect(result).toBeInstanceOf(Ok);
  const readout = okValue(result);
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);
  expect(String(readout.couldNotObserveReason)).toContain("could not be read");
});

test("test_unknowable_liveness_fails_closed_for_acting_and_open_eyed_for_reading", async () => {
  // Where the platform cannot answer whether the recorded child is alive,
  // reading reports the session as unobservable -- and resume/stop refuse,
  // because acting on "probably dead" is how the U32 second writer is minted.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  plantRecord(root, "elsewhere", { pid: 12345, pgid: 12345 });
  expect(await provider.readState("elsewhere")).toBeInstanceOf(Ok); // materialise first

  // `monkeypatch.setattr(s2.os, "name", "nt")`. The seam is the port's
  // reproduction of that late binding, and this is one of the file's three
  // sanctioned substitutions: no real child can put this host on the branch a
  // platform without `kill(pid, 0)` takes. Its liveness partner is the
  // target-only case at the end of this file.
  patchSeam(sessionRuntime, "isPosix", () => false);

  const read = await provider.readState("elsewhere");
  expect(read).toBeInstanceOf(Ok);
  expect(okValue(read).observation).toBe(Observation.COULD_NOT_OBSERVE);
  expect(String(okValue(read).couldNotObserveReason)).toContain("liveness");

  const resumed = await provider.resume("elsewhere");
  expect(resumed).toBeInstanceOf(Failure);
  expect(refusalOf(resumed).kind).toBe(FailureKind.BACKEND_UNREACHABLE);

  const stopped = await provider.stop("elsewhere");
  expect(stopped).toBeInstanceOf(Failure);
  expect(refusalOf(stopped).kind).toBe(FailureKind.BACKEND_UNREACHABLE);
});

test("test_two_session_ids_cannot_share_one_provider_identity", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");

  await provider.start(cliRequest(root, "s-one"));
  // A uuid session id is honoured verbatim, so starting a session *named* the
  // derived identity collides with the session that derives it.
  const twin = claudeSessionUuid("s-one");
  const result = await provider.start(cliRequest(root, twin));
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  // The detail names the *other* session, which is the only thing that makes
  // the refusal actionable.
  expect(refusalOf(result).detail).toContain("s-one");
});

test("test_a_garbage_line_before_a_valid_result_is_surfaced_not_swallowed", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  fakeEnv("FAKE_GARBAGE_BEFORE_RESULT", "1");

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");

  // The state is `completed` -- the later, well-formed result is read -- and
  // the line that could not be interpreted still rides in the detail.
  const readout = await waitForState(provider, "sess-1", "completed");
  expect(String(readout.providerDetail["uninterpretable_line"])).toContain("not JSON");
});

parametrize<readonly string[]>(
  "test_provider_owned_flags_in_role_arguments_are_refused",
  [
    // The ids are pytest's, verbatim, and the order is the source's `ids=[...]`.
    // The five values are the five spellings a role configuration could reach
    // the CLI's option parser with: a plain long flag, the `--flag=value` form,
    // a short flag, `--continue`, and a short flag with an attached value.
    ["session-id", ["--session-id", "5".repeat(8)]],
    ["resume-eq", ["--resume=abc"]],
    ["print", ["-p", "another prompt"]],
    ["continue", ["--continue"]],
    ["resume-attached", ["-r00000000-0000-0000-0000-000000000000"]],
  ],
  async (cliArgs) => {
    // A role configuration must not be able to override the committed identity
    // or the structured-output invocation from `cli_args`.
    const root = caseRoot("cli");
    const provider = cliProvider(root);
    const log = spawnLog(root);

    const result = await provider.start(cliRequest(root, "sess-1", { cli_args: cliArgs }));
    expect(result).toBeInstanceOf(Failure);
    expect(refusalOf(result).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
    // Read without waiting: "nothing was spawned" is the absence of any line,
    // and there is nothing to wait for.
    expect(spawned(log)).toEqual([]);
  },
);

test("test_a_finished_child_that_never_named_its_identity_is_not_accepted", async () => {
  // The read-back is positive: a result from output that never carried a
  // session identity cannot be reconciled, so it is answered loudly rather than
  // accepted on trust.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  fakeEnv("FAKE_OMIT_IDENTITY", "1");

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");

  const result = await provider.readState("sess-1");
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).kind).toBe(FailureKind.UNINTERPRETABLE_RESPONSE);
  expect(refusalOf(result).detail).toContain("read back");
});

test("test_a_live_child_that_has_not_named_its_identity_yet_is_tolerated", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  fakeEnv("FAKE_OMIT_IDENTITY", "1");
  hangingChild("events-then-hang");

  await provider.start(cliRequest(root));

  // The source's own inline loop, and it is not `waitForState`: what it waits
  // for is a *reason*, and every poll on the way must still be an `Ok` -- a
  // helper that tolerated a `Failure` as "not yet" would hide the case's
  // opposite outcome behind a ten-second timeout.
  const deadline = performance.now() + POLL_DEADLINE_MS;
  let readout: SessionReadout;
  for (;;) {
    const result = await provider.readState("sess-1");
    expect(result).toBeInstanceOf(Ok);
    readout = okValue(result);
    if ((readout.couldNotObserveReason ?? "").includes("identity")) {
      break;
    }
    expect(
      performance.now() < deadline,
      `never saw the withheld state: ${describeValue(readout)}`,
    ).toBe(true);
    await pause(POLL_INTERVAL_MS);
  }
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);
});

test("test_a_relative_workspace_is_recorded_absolute", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");
  // `monkeypatch.chdir(tmp_path)`. Registered after the provider so the working
  // directory is restored *before* the children are stopped and the directory
  // removed; the provider's own state root was resolved at construction and is
  // unaffected either way.
  chdirForTest(root);

  const result = await provider.start(
    new StartRequest({ sessionId: "rel", workspace: "rel-ws", role: "worker" }),
  );
  expect(result).toBeInstanceOf(Ok);

  const record = readRecord(root, "rel");
  const workspace = String(recordField(record, "workspace"));
  // `Path(record["workspace"]).is_absolute()`. `path.isAbsolute` is the same
  // question on both platform flavours of the module, which is what the source
  // gets from `PurePath` picking `PurePosixPath` or `PureWindowsPath` for it.
  expect(isAbsolute(workspace)).toBe(true);
  // `str((tmp_path / "rel-ws").resolve())`. The provider created the directory,
  // so the non-strict `resolve()` is a plain realpath here -- and it has to be
  // one: on a host where the temp root is reached through a symlink, comparing
  // against the unresolved join would compare two different spellings of one
  // directory.
  expect(workspace).toBe(realpathSync(join(root, "rel-ws")));
});

test("test_a_type_invalid_record_is_a_broken_record_not_a_crash", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  // Valid JSON, wrong type: validation is by type and not by parseability.
  plantRecord(root, "typebad", { cli_args: null });

  const read = await provider.readState("typebad");
  expect(read).toBeInstanceOf(Ok);
  expect(okValue(read).observation).toBe(Observation.COULD_NOT_OBSERVE);
  const listed = await provider.listSessions();
  expect(listed).toBeInstanceOf(Ok);
  expect(okValue(listed).map((readout) => readout.sessionId)).toEqual(["typebad"]);
});

// --------------------------------------------------------------------------
// The process group: the ladder, and the sweep the leader's exit does not end
// --------------------------------------------------------------------------

procTest(
  "the post-exit sweep signals only a group whose live member provably " +
    "carries the session marker, and the proof is read from /proc; where " +
    "/proc does not exist (macOS) the sweep deliberately does nothing " +
    "rather than signal an unverifiable group, so a TERM-ignoring " +
    "survivor of an exited leader is a documented platform limitation, " +
    "not a behaviour to assert",
)("test_stop_reaps_a_group_member_that_outlived_the_leader", async () => {
  // H1's exact shape: an MCP-like grandchild ignores the SIGTERM, the leader
  // honours it, and `wait()` returning must not end the stop -- the group is
  // confirmed empty, killing what remains.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("shielded-grandchild");
  const pidFile = join(root, "grandchild.pid");
  fakeEnv("FAKE_GRANDCHILD_PID_FILE", pidFile);

  await provider.start(cliRequest(root));
  const grandchild = await waitForAnnouncedPid(pidFile);

  const result = await provider.stop("sess-1");
  expect(result).toBeInstanceOf(Ok);
  await waitForPidToGo(
    grandchild,
    `the shielded grandchild (pid ${String(grandchild)}) survived the stop`,
  );
});

procTest("the after-exit sweep proves ownership via /proc")(
  "test_stop_reaps_the_group_even_when_the_leader_already_exited",
  async () => {
    // The leader being gone does not end the stop: the group member is still
    // swept -- and only because its environment provably carries this session's
    // marker, so a recycled pgid is never signalled.
    const root = caseRoot("cli");
    const provider = cliProvider(root);
    // No bounded sleep: this leader is asked to exit immediately, so there is
    // no hanging child to bound. The grandchild's own 120-second timer is the
    // fake's, and it is what makes a missed sweep self-heal.
    fakeMode("shielded-grandchild");
    fakeEnv("FAKE_LEADER_EXITS", "1");
    const pidFile = join(root, "grandchild.pid");
    fakeEnv("FAKE_GRANDCHILD_PID_FILE", pidFile);

    await provider.start(cliRequest(root));
    await waitForExit(provider, "sess-1");
    const grandchild = await waitForAnnouncedPid(pidFile);
    expect(
      sessionRuntime.pidRunning(grandchild),
      "the scenario needs a surviving group member",
    ).toBe(true);

    // No SIGTERM is sent on this path at all -- the leader is already reaped, so
    // the ladder is skipped and the sweep goes straight to SIGKILL over a group
    // it has proven is still this session's.
    const result = await provider.stop("sess-1");
    expect(result).toBeInstanceOf(Ok);
    await waitForPidToGo(
      grandchild,
      `the grandchild (pid ${String(grandchild)}) survived a stop after the leader's exit`,
    );
  },
);

test("test_provider_owned_flags_in_base_cli_args_are_a_construction_error", () => {
  const root = caseRoot("cli");
  const command = fakeCli(root);
  const stateRoot = join(root, "state");

  // `ValueError` at construction, not a per-spawn refusal: a provider-wide
  // argument overriding the committed identity is a programmer error.
  expectRefusal(
    () =>
      new ClaudeCliSessionProvider(stateRoot, {
        claudeCommand: command,
        baseCliArgs: ["--session-id", "x"],
      }),
    PyValueError,
  );
  expectRefusal(
    () =>
      new ClaudeCliSessionProvider(stateRoot, {
        claudeCommand: command,
        baseCliArgs: ["-r00000000-0000-0000-0000-000000000000"],
      }),
    PyValueError,
  );
  // The seam still exists for what it is for. Nothing is spawned, so nothing is
  // torn down.
  new ClaudeCliSessionProvider(stateRoot, {
    claudeCommand: command,
    baseCliArgs: ["--model", "haiku"],
  });
});

test("test_resume_reconciles_the_finished_generation_before_spawning", async () => {
  // A child that reported the wrong identity and then exited must not be
  // resumed straight past the incident: the finished generation is read -- and
  // the incident persisted -- before any new generation may bury it.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  const log = spawnLog(root);
  fakeEnv("FAKE_REPORT_ID", crypto.randomUUID());

  await provider.start(cliRequest(root));
  await waitForExit(provider, "sess-1");
  // Deliberately no readState in between: resume itself must reconcile.
  const result = await provider.resume("sess-1");
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).detail).toContain("identity incident");
  // Read without waiting: the first spawn's line was written before the child
  // exited, and the assertion is that a *second* one never appeared.
  expect(spawned(log), "resume spawned past an unreconciled incident").toHaveLength(1);
  const record = readRecord(root, "sess-1");
  expect(recordField(record, "incident")).not.toBeNull();
});

test("test_a_child_whose_pid_cannot_be_recorded_is_not_left_running", async () => {
  // A running child whose pid never reached the durable record would be
  // unadoptable by the next supervisor life -- and read as "gone", resumed
  // around. The spawn fails closed: terminated, cleaned up, reported.
  const root = caseRoot("cli");
  hangingChild("silent");
  const provider = stopSessionsAtTeardown(
    new ClaudeCliSessionProvider(join(root, "state"), {
      claudeCommand: fakeCli(root),
      stopTimeout: 2.0,
    }),
  );
  refuseTheRecordWriteCarryingAPid();

  const result = await provider.start(cliRequest(root));
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).detail).toContain("terminated");
  // By value against `Ok(())`. `toStrictEqual` and not `toEqual`, because
  // Python's dataclass equality requires the same class.
  expect(await provider.listSessions()).toStrictEqual(new Ok([]));
  // The whole session directory, gone: a start that never had a process is not
  // a session, and a half-written record would refuse the id forever.
  expect(existsSync(join(root, "state", "sess-1"))).toBe(false);
});

posixTest("the emergency-kill path signals a POSIX group")(
  "test_a_child_that_outlives_the_emergency_kill_is_not_abandoned",
  async () => {
    // If the pid cannot be recorded AND the child survives the SIGKILL, the
    // spawn must not claim a clean termination: the child keeps its in-memory
    // supervision, the state stays reserved, and the caller hears TIMED_OUT.
    const root = caseRoot("cli");
    hangingChild("silent");
    const provider = stopSessionsAtTeardown(
      new ClaudeCliSessionProvider(join(root, "state"), {
        claudeCommand: fakeCli(root),
        stopTimeout: 0.3,
      }),
    );
    // Captured before the substitutes are installed, so they are the originals
    // and not each other.
    const realWriteAtomic = sessionRuntime.writeAtomic.bind(sessionRuntime);
    const realSignalGroup = sessionRuntime.signalGroup.bind(sessionRuntime);
    refuseTheRecordWriteCarryingAPid();
    // `monkeypatch.setattr(s2, "_signal_group", lambda pgid, signum: None)`.
    // The "SIGKILL" is made a no-op so the child genuinely survives it -- the
    // third of this file's sanctioned substitutions, and the only way to reach
    // this branch, since a real SIGKILL cannot be survived.
    patchSeam(sessionRuntime, "signalGroup", () => {});

    const result = await provider.start(cliRequest(root));
    expect(result).toBeInstanceOf(Failure);
    expect(refusalOf(result).kind).toBe(FailureKind.TIMED_OUT);
    expect(refusalOf(result).detail).toContain("in-memory supervision");
    // Still supervised and still reserved, not abandoned. The contrast with the
    // case above is the whole point: a clean emergency kill takes the directory
    // down, a failed one keeps everything.
    expect(await provider.readState("sess-1")).toBeInstanceOf(Ok);
    expect(existsSync(join(root, "state", "sess-1"))).toBe(true);

    // `monkeypatch.undo()`. `patchSeam` has no manual undo, so the originals are
    // re-patched over the substitutes: the LIFO unwind then restores the
    // substitute and, beneath it, the original, which is the same end state.
    patchSeam(sessionRuntime, "writeAtomic", realWriteAtomic);
    patchSeam(sessionRuntime, "signalGroup", realSignalGroup);
    const stopped = await provider.stop("sess-1");
    expect(stopped).toBeInstanceOf(Ok);
  },
);

test("test_a_broken_records_identity_stays_reserved", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  const sessionDir = join(root, "state", "brok");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "record.json"), '{"truncated', "utf8");

  // The reservation is derived from the *directory name*, so an unreadable
  // record still holds the identity its name derives -- it may have a live
  // child behind it.
  const result = await provider.start(cliRequest(root, claudeSessionUuid("brok")));
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect(refusalOf(result).detail).toContain("brok");
});

procTest("the stranger check reads cmdline via /proc")(
  "test_stop_of_a_record_whose_pid_is_now_a_stranger_touches_nothing",
  async () => {
    // A recorded pid recycled to a stranger -- here: this very test process --
    // reads as "the child is gone": the stop signals nothing, sweeps nothing
    // unverified, and reports the session as itself.
    const root = caseRoot("cli");
    const provider = cliProvider(root);
    plantRecord(root, "stale", { pid: process.pid, pgid: process.pid });

    const result = await provider.stop("stale");
    expect(result).toBeInstanceOf(Ok);
    expect(okValue(result).observation).toBe(Observation.COULD_NOT_OBSERVE);
  },
);

test("test_a_misplaced_record_is_broken_not_another_sessions_readout", async () => {
  // A record copied into the wrong directory must not let read_state answer
  // with another session's state, or stop/resume act on another session's pid:
  // the directory's derivable identity is the invariant.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  plantRecord(root, "session-a");
  const source = readFileSync(recordPath(root, "session-a"), "utf8");
  const misplaced = join(root, "state", "session-b");
  mkdirSync(misplaced, { recursive: true });
  writeFileSync(join(misplaced, "record.json"), source, "utf8");

  const read = await provider.readState("session-b");
  expect(read).toBeInstanceOf(Ok);
  expect(okValue(read).observation).toBe(Observation.COULD_NOT_OBSERVE);
  expect(String(okValue(read).couldNotObserveReason)).toContain("misplaced");
  const verbs: readonly [string, (id: string) => Promise<ProviderResult<SessionReadout>>][] = [
    ["stop", (id) => provider.stop(id)],
    ["resume", (id) => provider.resume(id)],
  ];
  for (const [name, verb] of verbs) {
    const result = await verb("session-b");
    expect(result, name).toBeInstanceOf(Failure);
    expect(refusalOf(result).kind, name).toBe(FailureKind.REFUSED_BY_PROVIDER);
  }
});

test("test_a_record_replaced_by_a_directory_stays_on_the_roster", async () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  // `record.json` *is* a directory: the read raises rather than answering, and
  // the session must degrade rather than vanish or crash the roster.
  mkdirSync(join(root, "state", "dirrec", "record.json"), { recursive: true });

  const listed = await provider.listSessions();
  expect(listed).toBeInstanceOf(Ok);
  const readouts = okValue(listed);
  expect(readouts).toHaveLength(1);
  const readout = readouts[0] as SessionReadout;
  expect(readout.sessionId).toBe("dirrec");
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);
  const read = await provider.readState("dirrec");
  expect(read).toBeInstanceOf(Ok);
  expect(okValue(read).observation).toBe(Observation.COULD_NOT_OBSERVE);
});

test("test_the_probes_raw_answers_are_durably_recorded", () => {
  const root = caseRoot("cli");
  const provider = cliProvider(root);

  const result = provider.probeCapabilities();
  expect(result).toBeInstanceOf(Ok);
  const evidence = readFileSync(join(root, "state", "probe-evidence.txt"), "utf8");
  // The version answer, the *invocation* that produced the help text -- which
  // the help output itself never contains -- and one flag out of that output.
  expect(evidence).toContain(FAKE_VERSION);
  expect(evidence).toContain("--help");
  expect(evidence).toContain("--session-id");
});

// --------------------------------------------------------------------------
// The stated assumptions: mechanically present, next to the code they bind
// --------------------------------------------------------------------------

/**
 * `S2_SOURCE = Path(s2.__file__).read_text()`.
 *
 * The `.ts`, never `dist/`: `tsc` strips comments, so a build artefact would
 * fail the two presence assertions visibly and satisfy the absence assertion
 * unconditionally. `repoSource` refuses a `dist/` path for that reason.
 */
const S2_SOURCE = repoSource("src/session/claude_cli_provider.ts");

test("test_the_refusal_is_stated_not_to_be_a_lock_next_to_the_spawn_path", () => {
  // ADAPTED, in its third assertion (see the file header's count).
  // Issue #17: "State this assumption in the code, next to the spawn path."
  // Checked mechanically so deleting the sentence fails the build.
  expect(S2_SOURCE).toContain("never relied on as a lock");
  expect(S2_SOURCE).toContain("U27");
  // `ClaudeCliSessionProvider._start_session.__doc__`. A Python docstring is a
  // string on the object; a JSDoc block is a comment and is gone before
  // anything runs, so the adapted half asks the same file for the block
  // **immediately preceding** the declaration -- adjacency is what stops it
  // reading `resume`'s block instead, and those two blocks are neighbours whose
  // recorded sentences differ.
  const startDoc = docBlockBefore(S2_SOURCE, methodDeclaration("_startSession"));
  expect(startDoc).toContain("never relied on as a lock");
});

test("test_resume_says_it_is_unguarded_and_names_the_lease_as_the_gate", () => {
  // ADAPTED. `ClaudeCliSessionProvider.resume.__doc__` is a string on the
  // object in Python and a comment that is gone before anything runs here, so
  // both assertions are re-pointed at the block immediately preceding the
  // declaration in this module's own text -- the idiom `S2_SOURCE` already is.
  const resumeDoc = docBlockBefore(S2_SOURCE, methodDeclaration("resume"));
  expect(resumeDoc).toContain("U32");
  expect(resumeDoc).toContain("lease");
});

test("test_the_provider_imports_nothing_from_the_control_plane", () => {
  // D-0009's contract separation, asserted on the module rather than trusted to
  // review: the provider that cannot name the lease cannot borrow it, and
  // cannot be borrowed by it.
  //
  // One assertion, which is the source's one assertion. The camelCase spelling
  // this port also has to forbid is a *second* absence and would make this case
  // say more than `test_the_provider_imports_nothing_from_the_control_plane`
  // says, so it is a target-only case at the end of this file rather than an
  // extra line here (rule 0's ceiling).
  expect(S2_SOURCE).not.toContain("control_plane");
});

test("test_the_cli_version_written_against_is_recorded", () => {
  expect(
    CLI_VERSION_WRITTEN_AGAINST.includes("2.1.234") ||
      CLI_VERSION_WRITTEN_AGAINST.includes("2.1.237"),
  ).toBe(true);
});

// -- target-only: the liveness of the three substituted seam members -------
//
// D-0014's rule: a seam nothing routes through is decoration. If production
// stopped calling one of these members -- reading `process.platform` directly,
// writing the record with `writeFileSync`, calling `process.kill` itself -- the
// three cases above that substitute them would stay **green**, because each of
// them asserts a refusal or an absence, and a substitute that is never reached
// changes nothing an absence assertion can see. These three are the only thing
// standing between that and a silent loss of coverage.

test("the liveness question is routed through the platform seam (target-only)", async () => {
  // The partner of `test_unknowable_liveness_fails_closed_for_acting_and_...`.
  // On Windows that case passes whether or not the seam is consulted, because
  // the host is already the platform it substitutes; on POSIX the substitution
  // is the only thing that reaches the branch, so this is where the routing is
  // pinned on every host.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  plantRecord(root, "elsewhere", { pid: 12345, pgid: 12345 });
  let asked = 0;
  const realIsPosix = sessionRuntime.isPosix.bind(sessionRuntime);
  patchSeam(sessionRuntime, "isPosix", () => {
    asked += 1;
    return realIsPosix();
  });

  expect(await provider.readState("elsewhere")).toBeInstanceOf(Ok);
  expect(
    asked,
    "reading a record that carries a pid never asked the platform seam",
  ).toBeGreaterThan(0);
});

test("the durable record is written through the seam, twice, and the second carries the pid (target-only)", async () => {
  // The partner of the two emergency-kill cases, and it pins the discriminator
  // their substitute keys on as well as the routing. Both halves are load
  // bearing: a port that wrote the record once, or that wrote the pid first,
  // would leave `refuseTheRecordWriteCarryingAPid` refusing a write that never
  // happens -- and `test_a_child_whose_pid_cannot_be_recorded_is_not_left_running`
  // would then be asserting that an ordinary start fails, which it does not.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");
  const writes: [string, number | null][] = [];
  const realWriteAtomic = sessionRuntime.writeAtomic.bind(sessionRuntime);
  patchSeam(sessionRuntime, "writeAtomic", (path, text) => {
    writes.push([basename(path), recordedPidIn(text)]);
    realWriteAtomic(path, text);
  });

  expect(await provider.start(cliRequest(root))).toBeInstanceOf(Ok);
  const records = writes.filter(([name]) => name === "record.json");
  expect(records.map(([, pid]) => pid === null)).toEqual([true, false]);
  // And the probe's evidence goes through the same member, which is why the
  // substitute has to discriminate on the basename as well as on the pid.
  expect(writes.map(([name]) => name)).toContain("probe-evidence.txt");
});

test("the stop ladder's first rung is routed through the group seam (target-only)", async () => {
  // The partner of `test_a_child_that_outlives_the_emergency_kill_is_not_abandoned`,
  // whose substitute is a no-op: a `signalGroup` production had stopped calling
  // would make that case's `TIMED_OUT` arrive for the right reason by accident,
  // and would make it unfalsifiable.
  //
  // Asserted on both platform flavours rather than skipped on one: off POSIX the
  // ladder signals the leader alone, and that the group seam is *not* reached
  // there is the same routing question with the opposite answer.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");
  const signalled: [number, string][] = [];
  const realSignalGroup = sessionRuntime.signalGroup.bind(sessionRuntime);
  patchSeam(sessionRuntime, "signalGroup", (pgid, signal) => {
    signalled.push([pgid, signal]);
    realSignalGroup(pgid, signal);
  });

  await provider.start(cliRequest(root));
  const child = provider.childOf("sess-1");
  expect(child).not.toBeNull();
  const pid = (child as { pid: number }).pid;
  expect(await provider.stop("sess-1")).toBeInstanceOf(Ok);

  if (IS_POSIX) {
    // The first rung, and only the first is pinned: whether a SIGKILL follows
    // depends on how quickly the leader honours the SIGTERM, which is the
    // machine's business and not this assertion's.
    expect(signalled[0]).toEqual([pid, "SIGTERM"]);
  } else {
    expect(signalled).toEqual([]);
  }
});

// -- target-only: the decisions D-0301 made, which no source case can reach ---
//
// Python's five verbs run under one thread and its `Popen.poll()` is
// synchronous, so interlock's suite gets both properties below for free and has
// no case that could lose them. Here each is a line of code that can be
// deleted, and deleting either leaves all 65 ported cases green -- measured,
// not assumed.

test("the five verbs are serialised per provider instance (target-only, D-0301)", async () => {
  // D-0301 part 3. On C2 the consequence of losing the exclusion is worse than
  // on the stub: a `readState` can land inside `stop()`'s TERM -> wait ->
  // SIGKILL -> sweep ladder, and a second `resume` can bump `record.generation`
  // while the first is still mid-spawn.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");
  const order: string[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A pass-through, not a substitute: the real child is still spawned, and the
  // only thing added is a point at which `start` can be held mid-verb.
  const realSpawn = sessionRuntime.spawn.bind(sessionRuntime);
  patchSeam(sessionRuntime, "spawn", async (argv, options) => {
    order.push("spawn entered");
    await gate;
    return await realSpawn(argv, options);
  });

  const started = provider.start(cliRequest(root)).then((result) => {
    order.push("start settled");
    return result;
  });
  const read = provider.readState("sess-1").then((result) => {
    order.push("readState settled");
    return result;
  });
  const listed = provider.listSessions().then((result) => {
    order.push("listSessions settled");
    return result;
  });

  // Several real macrotask turns. Neither `readState` nor `listSessions` waits
  // on the child, so without the queue both would have run to completion by now
  // -- and `readState` would have run against a session that does not exist.
  for (let turn = 0; turn < 5; turn += 1) {
    await pause(5);
  }
  expect(order).toEqual(["spawn entered"]);

  release();
  expect(await started).toBeInstanceOf(Ok);
  expect(await read).toBeInstanceOf(Ok);
  expect(okValue(await listed)).toHaveLength(1);
  expect(order).toEqual([
    "spawn entered",
    "start settled",
    "readState settled",
    "listSessions settled",
  ]);
});

test("every read of a child's exit status is preceded by a macrotask settle (target-only, D-0301)", async () => {
  // D-0301 part 4, in the two halves it actually has.
  //
  // **The member's kind.** `settleExits` has to be a *macrotask* yield.
  // Measured: five thousand microtask turns leave `exitCode` at `null` for a
  // child that exited over a second earlier, and one `setTimeout(0)` releases
  // it. Nothing else in the suite would notice `await Promise.resolve()` being
  // substituted here, because every other path to an exit status is preceded by
  // an awaited `waitForExit` or by a polling helper, and both supply the
  // macrotask turn incidentally. So the property is asserted directly: a timer
  // armed before the call has fired by the time it resolves, where no amount of
  // microtask draining lets it.
  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);
  for (let turn = 0; turn < 5000; turn += 1) {
    await Promise.resolve();
  }
  expect(timerFired, "a microtask drain let a timer run; the measurement is stale").toBe(false);
  await sessionRuntime.settleExits();
  expect(timerFired, "settleExits() resolved without letting the event loop turn").toBe(true);

  // **The routing** (D-0014). A member production stopped calling is
  // decoration, and here the loss is silent in the worst direction: the readout
  // still arrives, it is just occasionally the previous one. Both seam members
  // are wrapped as pass-throughs and the order of the calls is read back.
  const root = caseRoot("cli");
  const provider = cliProvider(root);
  hangingChild("silent");
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

  expect(await provider.start(cliRequest(root))).toBeInstanceOf(Ok);
  expect(await provider.readState("sess-1")).toBeInstanceOf(Ok);
  expect(calls, "no verb read a child's exit status at all").toContain("read");
  expect(calls.indexOf("settle"), "a child's exit status was read before any settle").toBe(0);
  // Every read, not merely the first: a settle must sit between the verb's
  // entry and each readout it takes.
  expect(calls.filter((name) => name === "settle").length).toBeGreaterThanOrEqual(
    calls.filter((name) => name === "read").length,
  );
});

// -- target-only: two orderings and one durable field the source's cases -----
// -- observe only by their consequence ---------------------------------------

test("a vetoed workspace is neither created nor started (target-only)", async () => {
  // The partner of `test_a_vetoed_workspace_creation_refuses_the_start`, which
  // asserts a `Failure` whose detail says "vetoed" and nothing else -- so it is
  // green whether the veto precedes the directory or follows it, and green
  // whether or not a child was spawned. Gate item 7, and this provider's own
  // comment ("Asked **before** the directory is made"), are about exactly that
  // ordering. Measured: creating the workspace above the veto leaves all 65
  // ported cases green, and turns this one red.
  //
  // The stub's suite pins both halves in its ported slot
  // (`test_a_vetoed_workspace_is_neither_created_nor_started`); C2's does not,
  // and the ceiling forbids borrowing the stronger assertion into C2's ported
  // slot, so it lives here.
  const root = caseRoot("cli");
  const log = spawnLog(root);
  const provider = cliProvider(root);
  class Vetoer implements WorkspaceLifecycleObserver {
    onWorkspaceTransition(_transition: WorkspaceTransition): WorkspaceDecision {
      return new WorkspaceDecision(WorkspaceVerdict.VETO, "unsaved artifacts present");
    }
  }
  provider.registerWorkspaceObserver(new Vetoer());

  const request = cliRequest(root);
  expect(existsSync(request.workspace), "the fixture created the workspace").toBe(false);
  const result = await provider.start(request);
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).detail).toContain("vetoed");
  expect(existsSync(request.workspace), "the veto was asked after the directory was made").toBe(
    false,
  );
  expect(spawned(log), "a vetoed start reached the child").toEqual([]);
});

test("an identity incident is committed to the record, and read back from it (target-only)", async () => {
  // The durable half of the incident, which the source's two cases observe only
  // through their consequence and therefore do not pin in either direction.
  //
  // - Deleting `#readout`'s persisted-incident branch leaves all 65 green: every
  //   ported case that observes an incident can also reach it through the live
  //   per-event mismatch scan.
  // - Making `#recordIncident` skip its durable write leaves
  //   `test_an_identity_incident_survives_a_supervisor_restart` green: the
  //   second supervisor life re-derives the incident from the events file that
  //   is still on disk, so the case named for durability passes with nothing
  //   durable.
  //
  // Both are asserted here by taking the events file away, which is what makes
  // the durable record the only surviving evidence.
  const root = caseRoot("cli");
  fakeEnv("FAKE_REPORT_ID", crypto.randomUUID());
  const command = fakeCli(root);
  const stateRoot = join(root, "state");
  const first = stopSessionsAtTeardown(
    new ClaudeCliSessionProvider(stateRoot, { claudeCommand: command }),
  );

  await first.start(cliRequest(root));
  await waitForExit(first, "sess-1", 10_000);
  expect(await first.readState("sess-1")).toBeInstanceOf(Failure);

  // The field itself, on disk. `test_a_wrong_identity_read_back_is_an_incident`
  // asserts the two `detail` strings and no record field at all.
  const incident = recordField(readRecord(root, "sess-1"), "incident");
  expect(typeof incident, `the record carries no incident: ${describeValue(incident)}`).toBe(
    "string",
  );

  // Now remove every event file the session wrote. The live mismatch scan has
  // nothing left to find, so a supervisor that still answers "identity
  // incident" can only be answering from the record.
  const sessionDir = join(stateRoot, "sess-1");
  const events = readdirSync(sessionDir).filter((name) => name.startsWith("events-"));
  expect(events.length, "the session wrote no events file").toBeGreaterThan(0);
  for (const name of events) {
    unlinkSync(join(sessionDir, name));
  }

  const second = new ClaudeCliSessionProvider(stateRoot, { claudeCommand: command });
  const result = await second.readState("sess-1");
  expect(result).toBeInstanceOf(Failure);
  expect(refusalOf(result).detail).toContain("identity incident");
});

test("the provider names no control-plane symbol in either spelling (target-only)", () => {
  // The camelCase half of `test_the_provider_imports_nothing_from_the_control_plane`,
  // which is that case's whole assertion in the source and only half of it here.
  // interlock's package directory and its identifiers are both snake_case, so
  // `"control_plane"` covers the import and the symbol at once; continuo's
  // directory is `src/control_plane/` while its identifiers are camelCase
  // (D-0201), so an import of the barrel and a mention of a symbol from it are
  // two different strings. Asserting the second one in the ported slot would
  // make that case say more than its source says (rule 0's ceiling), so it says
  // it here.
  expect(S2_SOURCE).not.toContain("controlPlane");
});
