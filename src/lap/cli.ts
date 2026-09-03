/**
 * `continuo lap perform` -- the verb that drives one admitted run to an open
 * gate.
 *
 * Mounted into the unified CLI by `src/cli.ts`, which owns no flag of its own
 * here: the subtree's module declares its parser, exactly as `measurement/cli.ts`,
 * `settings/cli.ts`, `attention/cli.ts`, `control_plane/cli.ts` and
 * `control_plane/run_cli.ts` do (`D-0030`).
 *
 * **Why this file is where the concrete provider is named** (`D-0059`).
 * `root.ts` holds the order and is provider-agnostic; something has to supply
 * the backend. It is reached here as `createDefaultSessionProvider` **through
 * the package barrel**, which is the one file
 * `test/gate_item11/no-provider-detail-leaks.test.ts` allows to know both
 * vocabularies (`D-1001`). The name is provider-neutral, so swapping the
 * shipped default edits `src/session/` and not this file, and the number that
 * test grades is unchanged. `docs/design/composition-root-placement.md` records
 * the four alternatives and why each was rejected.
 *
 * **This layer is thin, and the thinness is the point** -- the same point
 * `control_plane/cli.ts` makes about the migrator. Every rule about what a lap
 * *is* lives in `root.ts` and in the modules it composes, and is stated there
 * once. This file resolves arguments, opens one database, calls exactly one
 * entry point, reports what happened, and closes the handle.
 *
 * **Why the verb is one command and not three.** An operator would rather type
 * `materialise`, `spawn` and `poll` separately, and it cannot be built that
 * way: `D-0217` makes a spawn plan executable only by the `FencedSpawner`
 * instance that admitted it, and that instance lives in memory. A `spawn` verb
 * in a second process would have to construct a second spawner, which `execute`
 * refuses -- correctly, because a fence admitted by one process and spent by
 * another has no provenance. So materialise, spawn, poll and ingest are one
 * process, and the seam an operator gets is `run admit` before it and the gate
 * verbs after it.
 *
 * **A refusal is an operator-facing line, not a stack trace**, in the family
 * every other subtree uses: one stderr line and exit 2. This verb composes four
 * subsystems and so meets four refusal taxonomies plus two usage-error families;
 * {@link isOperatorRefusal} says which of them are outcomes an operator acts on
 * and why the usage errors are among them here when they are not in
 * `run_cli.ts`.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives: every string
 * here reaches `--help` on a cp932 console, where a character the console cannot
 * encode is a crash rather than a smudge.
 */

import { randomUUID } from "node:crypto";

import {
  ArgparseExit,
  type ArgumentParser,
  type Namespace,
  type Subparsers,
} from "../cli/parser.js";
import { LeaseRefusal } from "../control_plane/lease.js";
import { openProductionControlPlane } from "../control_plane/migrator.js";
import { pythonRepr } from "../control_plane/python_repr.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
// The one import that names the shipped backend, and it names an abstraction:
// see this module's header and D-0059. Through `../index.js` deliberately --
// `../session/index.js` would make this file know a session backend, which is
// the join the leak test forbids outside the barrel.
import { createDefaultSessionProvider } from "../index.js";
// The session CONTRACT, not a backend: `no-provider-detail-leaks` excludes
// `src/session/provider.js` from what counts as knowing one, and this is the
// refusal every provider raises before it starts anything.
import { SpawnRefused } from "../session/provider.js";
import { OrchestrationRefused } from "../supervisor.js";
import { GitRefusal } from "../workspace/git.js";
import {
  WorkspaceMaterializationRefused,
  WorkspaceMaterializationUsageError,
} from "../workspace/materializer.js";
import { type LapOutcome, LapUsageError, performLap } from "./root.js";

// ASCII only: these reach --help on a cp932 console.
const DB_HELP =
  "path to the production control plane database file. It must already exist " +
  "and be at this build's head; 'db create' and 'db migrate' are what put it " +
  "there.";
const RUN_ID_HELP =
  "the run to perform. It must already be admitted: what it was admitted to " +
  "do is read back from its run_delegation_recorded event rather than retyped " +
  "here, so this verb cannot disagree with the record.";
const REPOSITORY_HELP =
  "a path inside the git repository the worktree is cut from. The base and " +
  "topic branches are the admitted run's, not this command's.";
const ARTIFACT_ROOT_HELP =
  "directory the run's fence, settings, MCP configuration and fence ledger " +
  "are published under, as <ARTIFACT_ROOT>/<run id>. It must be outside the " +
  "worktree: artifacts inside it would be files the fenced worker can edit.";
const STATE_ROOT_HELP =
  "directory the session provider keeps its per-session records and captured " +
  "output in. Never defaulted: two providers sharing one directory adopt each " +
  "other's children.";
const CLAUDE_COMMAND_HELP =
  "the worker CLI to run, as one token, and it must be an ABSOLUTE path. " +
  "Repeat the flag to give a command prefix in order (an interpreter and a " +
  "script); every token must be absolute. Required: a bare name would be " +
  "resolved through PATH, and the fence cannot rest on which directory the " +
  "worker happens to be started from.";
const ENDPOINT_EPOCH_HELP = "the epoch of the lease the worker's endpoint writes under.";
const ENDPOINT_RECIPIENT_HELP = "the one recipient the worker's endpoint serves.";
const ENDPOINT_DESTINATION_DIR_HELP = "directory the endpoint's delivery files are written into.";
const ENDPOINT_DB_HELP =
  "path the worker reaches the control plane by, when that is a different " +
  "spelling of --db (a symlink). Derived from --db when omitted, which is the " +
  "shape to prefer: a path naming a different database starts an endpoint the " +
  "run's messages never reach.";
const ENDPOINT_MODULE_HELP =
  "the endpoint module the worker's MCP server launches. Must be absolute, and " +
  "outside the worktree: it runs holding the messagebus lease and the control " +
  "plane's path.";
const NODE_HELP =
  "the interpreter the endpoint module is launched with. Must be absolute, and " +
  "must live outside the worktree: the MCP configuration is read by the worker's " +
  "Claude, whose working directory is the worktree, so a bare name would be " +
  "resolved through PATH and a path inside the checkout would name a file the " +
  "worker itself may rewrite.";
const INTERLOCK_ROOT_HELP =
  "the path substituted for {interlock_root} in the role document. Must be " +
  "absolute, and must live outside the worktree: it is interpolated into the " +
  "fence's own deny rules, so one pointed inside denies a directory the worker " +
  "controls while the real one stays readable.";
const CLAUDE_ORG_PATH_HELP =
  "the path substituted for {claude_org_path} in the role document. Absolute " +
  "and outside the worktree, for the same reason as --interlock-root.";
const HOOK_SCRIPT_HELP =
  "the deny hook substituted for {hook_script}. The bundled hook when omitted. " +
  "Must be absolute, and must live outside the worktree: it is the file that " +
  "enforces the fence, and it does not protect its own path.";
const PYTHON_HELP =
  "the interpreter substituted for {python}. This build's own when omitted. " +
  "Must be absolute, for the same reason as --hook-script: whoever runs the hook " +
  "decides what the hook does.";
const POLL_INTERVAL_MS_HELP =
  "milliseconds between transcript reads while waiting for the turn to end.";
const TURN_TIMEOUT_MS_HELP =
  "milliseconds to wait for the turn's terminal report before giving up. The " +
  "workspace and the fence are left as they are; the worker's session is " +
  "stopped, because a lap that gave up must not leave a fenced child running " +
  "with nobody polling it.";
const GIT_TIMEOUT_MS_HELP = "wall-clock bound on each git command materialisation runs.";
const GATE_OPTION_HELP =
  "one answer the gate offers the human. Repeat the flag to give several, in " +
  "order; omit it for a free-form answer.";
const GATE_DEADLINE_HELP =
  "epoch milliseconds the gate expires at. No deadline when omitted. A time " +
  "already in the past is refused up front; one that passes while the worker " +
  "runs is dropped, and the gate is opened without a deadline rather than the " +
  "report being lost.";

const PERFORM_DESCRIPTION =
  "Perform one admitted run: materialise its workspace and render its fence, " +
  "start the worker under the fence that was admitted, wait for the turn's " +
  "terminal report, and open the human gate over it. Refuses with the reason " +
  "and exits 2 when a step will not proceed.";

/** Milliseconds between transcript reads when --poll-interval-ms is omitted. */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Milliseconds a turn is given when --turn-timeout-ms is omitted: fifteen minutes. */
const DEFAULT_TURN_TIMEOUT_MS = 900_000;

/**
 * The three effects this module has on the world, as a replaceable record.
 *
 * The same shape and the same reason as `control_plane/cli.ts`'s `dbCliSeams`
 * and `run_cli.ts`'s `runCliSeams`: ESM bindings cannot be rebound from outside
 * the module that holds them, so the clock and the two streams are reached
 * through this record and the cases replace the entry
 * (`docs/test-translation-conventions.md` rule 5).
 *
 * **`nowMs` is read many times here, unlike in the two verbs above**, and it is
 * a function rather than a value for that reason: materialisation stamps one
 * instant, the orchestrator's walk stamps its own, the poll loop measures a
 * budget against it, and the ingest stamps the moment the transcript was read.
 * A single value frozen at the top would make the poll loop's deadline
 * unreachable and the lap would wait forever.
 *
 * Not re-exported from `src/index.ts`: a seam for the tests that own this
 * module, not public API.
 */
export const lapCliSeams = {
  /** The clock every step of the lap stamps, in epoch milliseconds. */
  nowMs: (): number => Date.now(),
  /** The session identity factory handed to the orchestrator. */
  sessionUuid: (): string => randomUUID(),
  /** Where the report goes. */
  write: (text: string): void => {
    process.stdout.write(text);
  },
  /** Where a refusal goes. */
  writeError: (text: string): void => {
    process.stderr.write(text);
  },
};

/**
 * The refusal families this verb turns into one operator-facing line.
 *
 * The lap is the first surface that composes four subsystems, so it is the
 * first that meets four refusal taxonomies -- and each one is deliberately its
 * own family, because below this layer they mean different things.
 * `ControlPlaneRefusal` is what every other subtree reports; `git.ts` keeps its
 * shapes distinct because "git said no" and "git never answered" are acted on
 * differently; `LeaseRefusal` says another claimant holds the run; and
 * `OrchestrationRefused` says the walk stopped -- the provider would not start,
 * the identity did not read back, this writer lost a race.
 *
 * **Every one of them is an ordinary outcome of a command an operator typed**,
 * and this is the layer where they become the same thing: one line and exit 2.
 * The list is enumerated rather than widened to `Error`, because the point of
 * catching is to leave everything that is *not* on it escaping with its stack.
 *
 * **The two usage-error families are here too, and that is a departure from
 * `run_cli.ts` rather than an oversight.** That module leaves
 * `RunAdmissionUsageError` uncaught on the stated ground that it is a defect in
 * a caller -- and it is right, because by the time it could fire, its parser has
 * established every value it passes on. This verb's parser has not. It types
 * `--turn-timeout-ms` as an integer, which admits `-1`; it types
 * `--artifact-root` as a string, which admits a relative path. Both are values
 * an operator typed, and both reach {@link LapUsageError} or
 * `WorkspaceMaterializationUsageError` at runtime. Left out, they arrive as a
 * stack trace and exit 1 where every other verb in this CLI gives one line and
 * exit 2 -- so here the caller IS the operator, and the family follows the
 * caller rather than the name.
 *
 * The rules are deliberately not restated in the parser to catch them earlier.
 * `root.ts` and the materialiser each state their own constraints once, and a
 * second statement here would be a second answer to "is this argument usable"
 * -- the drift `control_plane/cli.ts` and `run_cli.ts` both argue against. The
 * classification is the seam; the rules stay where they are.
 */
function isOperatorRefusal(error: unknown): error is Error {
  return (
    error instanceof ControlPlaneRefusal ||
    error instanceof WorkspaceMaterializationRefused ||
    error instanceof WorkspaceMaterializationUsageError ||
    error instanceof GitRefusal ||
    error instanceof LeaseRefusal ||
    error instanceof OrchestrationRefused ||
    // The spawn precondition, which fires before any child exists: the worker
    // CLI is not on PATH, its capability probe timed out, it lacks a flag the
    // fence needs. Every one of those is an environment an operator fixes, and
    // the commonest of them -- `claude` not installed -- was arriving as a stack
    // trace after the worktree had already been materialised.
    error instanceof SpawnRefused ||
    error instanceof LapUsageError
  );
}

/** Report a refusal on stderr and stop, rather than letting it escape. */
function refuse(error: Error): never {
  lapCliSeams.writeError(`error: ${error.message}\n`);
  throw new ArgparseExit(2, "refused lap");
}

/** An optional string flag, as the namespace leaves it. */
function optionalText(args: Namespace, dest: string): string | undefined {
  const supplied = args[dest];
  return typeof supplied === "string" ? supplied : undefined;
}

/** An optional int flag, as the namespace leaves it. */
function optionalInt(args: Namespace, dest: string): number | undefined {
  const supplied = args[dest];
  return typeof supplied === "number" ? supplied : undefined;
}

/**
 * `--claude-command`, repeated, as the provider's command prefix.
 *
 * `undefined` rather than an empty list when the flag was never given, so the
 * provider's own default (`claude`) is what applies -- a `[]` handed to it would
 * be a command of no tokens, which is a different thing from no opinion.
 */
function claudeCommandOf(args: Namespace): readonly string[] | undefined {
  const supplied = args["claude_command"];
  return Array.isArray(supplied) ? supplied.map(String) : undefined;
}

/** `--gate-option`, repeated. `append` leaves the key unset when never given. */
function gateOptionsOf(args: Namespace): readonly string[] {
  const supplied = args["gate_options"];
  return Array.isArray(supplied) ? supplied.map(String) : [];
}

/**
 * The one line this verb prints, naming what a person has to act on next.
 *
 * The gate rather than the workspace: an operator who ran this wants to know
 * that a human is now being asked something and where to find the answer's
 * subject. The workspace and the session are on it too, because they are what
 * the next two steps of the lap operate on.
 */
function report(path: string, outcome: LapOutcome): void {
  // **The paths are quoted on the SUCCESS line too, and that is the half this
  // verb had missed.** Every refusal below already goes out through `pythonRepr`
  // -- the run identifier, the parser's diagnostic, the containment paths -- on
  // the reasoning that external text reaching a one-line report can forge a
  // second line. The success line carries the same external text: a POSIX
  // filename may hold a newline or a terminal control sequence, and `--db`,
  // the workspace and the branch all arrive from outside. Guarding the failure
  // path and leaving the success path open protects the case where an operator
  // is already looking for trouble and not the case where they are not.
  //
  // `run_cli.ts` records the open problem this is one answer to: it echoes
  // `--db` verbatim, deliberately, and says settling it "belongs to whichever
  // entry settles it for every verb at once". This settles it for this verb
  // only; the `db` and `run` subtrees still echo raw, and that inconsistency is
  // named here rather than left for a reader to find.
  lapCliSeams.write(
    `performed ${pythonRepr(outcome.intent.runId)} in ${pythonRepr(path)}: worktree ` +
      `${pythonRepr(outcome.materialized.workspace)} ` +
      `on ${pythonRepr(outcome.intent.topicBranch)} at ${outcome.materialized.baseCommit}, session ` +
      `${outcome.orchestration.sessionId} ${outcome.orchestration.path}, gate ` +
      `${outcome.ingested.gateId} over event ${outcome.ingested.eventId} at seq ` +
      `${outcome.ingested.eventSeq}\n`,
  );
  if (outcome.elapsedDeadlineAtMs !== null) {
    // Its own line, and on stdout beside the success it qualifies rather than on
    // stderr: the lap succeeded, the gate is open, and this is the one thing
    // about it that is not what the operator asked for. Naming the number they
    // gave is what lets them tell "my deadline was too tight" from "the worker
    // ran long", which are different next moves.
    lapCliSeams.write(
      `note: the requested gate deadline ${String(outcome.elapsedDeadlineAtMs)} had passed ` +
        `when the turn ended, so gate ${outcome.ingested.gateId} was opened without one; ` +
        "the report is on the spine either way\n",
    );
  }
}

/**
 * `continuo lap perform`.
 *
 * Asynchronous, and the only verb in this CLI that is: the orchestrator's walk
 * and the transcript poll are both `await`ed. `src/cli.ts`'s `mainAsync` is what
 * carries that to the process's exit status.
 *
 * The handle is closed in a `finally` whatever the outcome, including a
 * refusal, for the reason `run_cli.ts` gives: on Windows an open handle is a
 * locked file, so the next command would fail for a reason that has nothing to
 * do with what it was asked to do.
 */
export async function cmdLapPerform(args: Namespace): Promise<number> {
  const path = String(args["db"]);
  const stateRoot = String(args["state_root"]);
  const claudeCommand = claudeCommandOf(args);
  const provider = createDefaultSessionProvider(stateRoot, {
    ...(claudeCommand === undefined ? {} : { claudeCommand }),
  });
  const endpointModule = optionalText(args, "endpoint_module");
  const endpointDatabase = optionalText(args, "endpoint_db");
  const node = optionalText(args, "node");
  const hookScript = optionalText(args, "hook_script");
  const python = optionalText(args, "python");
  const gitTimeoutMs = optionalInt(args, "git_timeout_ms");
  const deadlineAtMs = optionalInt(args, "gate_deadline_at_ms");

  try {
    const connection = openProductionControlPlane(path);
    try {
      const outcome = await performLap(connection, provider, provider, {
        runId: String(args["run_id"]),
        repository: String(args["repository"]),
        artifactRoot: String(args["artifact_root"]),
        // Handed over to be CHECKED against the workspace, not used
        // (`D-0067`). The provider is already built over this path, which is
        // exactly why the check cannot live here: the workspace is not known
        // until the admitted intent has been read.
        providerStateRoot: stateRoot,
        ...(claudeCommand === undefined ? {} : { workerCommand: claudeCommand }),
        endpoint: {
          epoch: Number(args["endpoint_epoch"]),
          recipient: String(args["endpoint_recipient"]),
          destinationDir: String(args["endpoint_destination_dir"]),
          ...(endpointDatabase === undefined ? {} : { databasePath: endpointDatabase }),
          ...(endpointModule === undefined ? {} : { endpointModule }),
          ...(node === undefined ? {} : { node }),
        },
        fence: {
          interlockRoot: String(args["interlock_root"]),
          claudeOrgPath: String(args["claude_org_path"]),
          ...(hookScript === undefined ? {} : { hookScript }),
          ...(python === undefined ? {} : { python }),
        },
        nowMs: () => lapCliSeams.nowMs(),
        sessionUuidFactory: () => lapCliSeams.sessionUuid(),
        completion: {
          pollIntervalMs: optionalInt(args, "poll_interval_ms") ?? DEFAULT_POLL_INTERVAL_MS,
          timeoutMs: optionalInt(args, "turn_timeout_ms") ?? DEFAULT_TURN_TIMEOUT_MS,
        },
        ...(gitTimeoutMs === undefined ? {} : { gitTimeoutMs }),
        gateOptions: gateOptionsOf(args),
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      });
      report(path, outcome);
    } finally {
      // Closed before the session is stopped, so a stop that hangs cannot hold
      // the database open: everything durable this verb writes has already
      // committed by the time the report line is printed.
      connection.close();
    }
  } catch (error) {
    if (isOperatorRefusal(error)) {
      refuse(error);
    }
    throw error;
  }
  return 0;
}

/** A required string flag. */
function addRequired(parser: ArgumentParser, option: string, dest: string, help: string): void {
  parser.addArgument({
    optionStrings: [option],
    dest,
    required: true,
    metavar: dest.toUpperCase(),
    help,
  });
}

/** An optional string flag. */
function addOptional(parser: ArgumentParser, option: string, dest: string, help: string): void {
  parser.addArgument({ optionStrings: [option], dest, metavar: dest.toUpperCase(), help });
}

/** An optional int flag. */
function addOptionalInt(parser: ArgumentParser, option: string, dest: string, help: string): void {
  parser.addArgument({
    optionStrings: [option],
    dest,
    type: "int",
    metavar: dest.toUpperCase(),
    help,
  });
}

/** `add_subparsers`: mount `perform` under `lap`. */
export function addSubparsers(sub: Subparsers): void {
  const perform = sub.addParser("perform", PERFORM_DESCRIPTION);
  addRequired(perform, "--db", "db", DB_HELP);
  addRequired(perform, "--run-id", "run_id", RUN_ID_HELP);
  addRequired(perform, "--repository", "repository", REPOSITORY_HELP);
  addRequired(perform, "--artifact-root", "artifact_root", ARTIFACT_ROOT_HELP);
  addRequired(perform, "--state-root", "state_root", STATE_ROOT_HELP);

  // the worker's endpoint binding (D-0058)
  perform.addArgument({
    optionStrings: ["--endpoint-epoch"],
    dest: "endpoint_epoch",
    required: true,
    type: "int",
    metavar: "ENDPOINT_EPOCH",
    help: ENDPOINT_EPOCH_HELP,
  });
  addRequired(perform, "--endpoint-recipient", "endpoint_recipient", ENDPOINT_RECIPIENT_HELP);
  addRequired(
    perform,
    "--endpoint-destination-dir",
    "endpoint_destination_dir",
    ENDPOINT_DESTINATION_DIR_HELP,
  );
  addOptional(perform, "--endpoint-db", "endpoint_db", ENDPOINT_DB_HELP);
  addOptional(perform, "--endpoint-module", "endpoint_module", ENDPOINT_MODULE_HELP);
  addOptional(perform, "--node", "node", NODE_HELP);
  perform.addArgument({
    optionStrings: ["--claude-command"],
    dest: "claude_command",
    append: true,
    required: true,
    metavar: "CLAUDE_COMMAND",
    help: CLAUDE_COMMAND_HELP,
  });

  // the role document's placeholders
  addRequired(perform, "--interlock-root", "interlock_root", INTERLOCK_ROOT_HELP);
  addRequired(perform, "--claude-org-path", "claude_org_path", CLAUDE_ORG_PATH_HELP);
  addOptional(perform, "--hook-script", "hook_script", HOOK_SCRIPT_HELP);
  addOptional(perform, "--python", "python", PYTHON_HELP);

  // when the turn is over, and how long it is given (D-0060)
  addOptionalInt(perform, "--poll-interval-ms", "poll_interval_ms", POLL_INTERVAL_MS_HELP);
  addOptionalInt(perform, "--turn-timeout-ms", "turn_timeout_ms", TURN_TIMEOUT_MS_HELP);
  addOptionalInt(perform, "--git-timeout-ms", "git_timeout_ms", GIT_TIMEOUT_MS_HELP);

  // the gate this verb opens
  perform.addArgument({
    optionStrings: ["--gate-option"],
    dest: "gate_options",
    append: true,
    metavar: "GATE_OPTION",
    help: GATE_OPTION_HELP,
  });
  addOptionalInt(perform, "--gate-deadline-at-ms", "gate_deadline_at_ms", GATE_DEADLINE_HELP);

  // `asynchronous` is read by `dispatch` BEFORE the handler is called: this
  // verb materialises a worktree, publishes a fence and starts a child, and a
  // synchronous caller that discovered the shape from the returned value would
  // have discovered it after all of that had already happened.
  perform.setDefaults({ func: cmdLapPerform, asynchronous: true });
}
