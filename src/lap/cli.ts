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
 * **`--json` changes the bytes and nothing else.** A host driving this verb as a
 * subprocess reads one document in the envelope `src/cli/json_output.ts`
 * declares, under the pinned schema id {@link PERFORM_SCHEMA}. Without the flag
 * every byte this file writes is what it has always been. The exit codes, the
 * refusal families {@link isOperatorRefusal} names, the order of the steps and
 * the `finally` that closes the handle are identical either way -- this verb
 * materialises a worktree and starts a fenced child, and an output flag that
 * could reach any of that would be a flag that decides what happened rather
 * than how it is spelled.
 *
 * **A refusal document names the session when the lap holds one** (`D-1102`).
 * `session_id` is a top-level key of the refusal envelope, beside `db` and
 * outside `error`: it is present, as a non-empty string, on the refusals raised
 * once this lap held a confirmed identity, and the key is absent -- never
 * `null` -- on every other refusal. {@link refusalMetadata} enumerates which
 * states those are and why the ones left out are left out. The schema stays
 * `/1` for the reason `report()` gives about `model`: a key a decoder has not
 * been taught is one every JSON reader already handles, and an old producer
 * that never writes it says "the identity is unknown", which is exactly what a
 * decoder should conclude. It must not go looking in `error.message` instead
 * (`D-0015` rule 7), even though the sentence there quotes the id: the message
 * is written for a person and is free to be reworded.
 *
 * **The whole report is one document, and this verb is the one where that is a
 * claim worth making.** `report()` writes a success line plus up to two
 * conditional `note:` lines, and it writes all of them after the lap is over --
 * there is no streaming progress to interleave. So the document has no partial
 * state to represent, and the two notes become two always-present keys rather
 * than two optional ones: a host must not have to tell "absent" from "null" to
 * learn that the lap was clean.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives: every string
 * here reaches `--help` on a cp932 console, where a character the console cannot
 * encode is a crash rather than a smudge.
 */

import { randomUUID } from "node:crypto";

import {
  addJsonArgument,
  jsonRequested,
  type RefusalMetadata,
  refusalLine,
  successLine,
} from "../cli/json_output.js";
import {
  ArgparseExit,
  type ArgumentParser,
  type Namespace,
  type Subparsers,
} from "../cli/parser.js";
import { SERVED_RECIPIENTS } from "../control_plane/handlers.js";
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
import {
  DEFAULT_READBACK_BUDGET_MS,
  LoserTerminated,
  OrchestrationRefused,
} from "../supervisor.js";
import { GitRefusal } from "../workspace/git.js";
import {
  WorkspaceMaterializationRefused,
  WorkspaceMaterializationUsageError,
} from "../workspace/materializer.js";
import { type LapOutcome, LapRefused, LapUsageError, performLap, requireModel } from "./root.js";

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
const MODEL_HELP =
  "the model the worker runs on, as a plain model id (claude-opus-5, sonnet, " +
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0). Appended to every spawn of " +
  "this lap's session as '--model <MODEL>'. Omitted by default, and omitting " +
  "it is not a neutral choice: the child then runs on whatever the worker CLI " +
  "defaults to, which this stack does not decide and cannot report. Refused " +
  "unless it starts with a letter or a digit and uses only letters, digits, " +
  "'.', '_', ':' and '-' after it -- the value becomes a token in the fenced " +
  "child's command line, so it must not be spellable as a second argument.";
const ENDPOINT_RECIPIENT_HELP =
  "the one recipient the worker's endpoint serves. Must be one the outbox has a handler " +
  "registered for (see the list this flag accepts above); a recipient with no handler is " +
  "refused here, before any worktree or fence is created.";
const ENDPOINT_DESTINATION_DIR_HELP =
  "directory the endpoint's delivery files are written into. Created if it " +
  "does not exist, and reused if it does: the dropbox deduplicates per " +
  "idempotency key and fences a superseded writer out by its own token, so " +
  "sharing one with an earlier run of the same control plane is supported (one " +
  "dropbox per control plane: the epochs it fences by are that plane's). Must be " +
  "outside the workspace. " +
  "'gate deliver --destination-dir' takes the same directory under the same rule.";
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
const IDENTITY_READBACK_TIMEOUT_MS_HELP =
  "milliseconds the spawned worker is given to emit an event naming the session " +
  "id committed for it, before the lap gives up with the binding left at " +
  `'spawned'. Defaults to ${String(DEFAULT_READBACK_BUDGET_MS)}. It buys the worker ` +
  "time and does not weaken the check: what counts as a read-back is the same " +
  "either way. Raise it on a machine where the worker CLI starts slowly.";
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

/**
 * The pinned shape identifier this subtree's `--json` documents carry.
 *
 * `continuo.lap.perform/1`, and the `/1` is the whole of the version story
 * `src/cli/json_output.ts` states: a field added later leaves it alone, because
 * an unread key is one every JSON reader already handles, and a change a host
 * cannot absorb -- a key renamed, a null that starts meaning something else --
 * becomes `/2` so the two can be told apart by reading one key.
 */
const PERFORM_SCHEMA = "continuo.lap.perform/1";

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

/**
 * Report a refusal on stderr and stop, rather than letting it escape.
 *
 * **The one place this verb refuses, and the reason `--json` is taught here
 * rather than at the call site.** Every family {@link isOperatorRefusal} names
 * -- four subsystems' taxonomies plus the two usage-error families -- funnels
 * through this function, so teaching it the flag makes "a refusal a host can
 * parse" a property of the subtree rather than of whichever branch a particular
 * refusal took. A flag read at the call site would have been read on the paths
 * somebody looked at and missed on the rest, leaving `LeaseHeld`, a timed-out
 * turn and a worker CLI that will not start emitting human text under `--json`
 * while every success case stayed green.
 *
 * `db` is a parameter because the document carries it on refusals for the same
 * reason it carries it on successes: a host driving several control planes
 * cannot attribute a refusal it read from a log without it, and the human line
 * carries the path only when the message happens to quote it.
 *
 * The stream, the exit code and the fact that this throws are identical either
 * way. `--json` changes the bytes, never the control flow.
 */
function refuse(error: Error, db: string, json: boolean): never {
  lapCliSeams.writeError(
    json
      ? refusalLine(PERFORM_SCHEMA, db, error, refusalMetadata(error))
      : `error: ${error.message}\n`,
  );
  throw new ArgparseExit(2, "refused lap");
}

/**
 * The structured facts this verb's refusal document carries beside the class
 * and the message -- today exactly one, the session (`D-1102`).
 *
 * **The rule is about the state the lap reached, not about the shape of a
 * class.** A refusal names a session here only where the lap already held a
 * CONFIRMED identity for it, so the list is enumerated rather than derived by
 * asking whether an error happens to have a `sessionId` field:
 *
 * - {@link LapRefused} carries one only when `root.ts` set it, which is on the
 *   refusals raised after the walk returned -- the turn's report could not be
 *   read, was about another session, never came, or ran out of budget. The
 *   identity has been read back and committed by then.
 * - `LoserTerminated` carries the identity of the session it ordered stopped.
 *   The binding for it exists; this claimant simply lost the lease afterwards,
 *   and the id is the one thing an operator chasing a possibly-rogue child has
 *   to have.
 *
 * And the two states deliberately left without a key:
 *
 * - `IdentityUnconfirmed` has no session to name. That is the whole content of
 *   the refusal -- an identity was committed and never confirmed -- and putting
 *   the unconfirmed id on the wire would report as spawned a session nothing
 *   read back. The refusal's `message` and the binding, which stays honestly at
 *   `spawned`, are where that id lives.
 * - Every refusal raised before the walk: the run was not admitted, an argument
 *   was malformed, git said no, the worker CLI is not installed. `performLap`
 *   mints an identity before it binds one, so an id in hand at those depths may
 *   belong to no binding at all.
 *
 * The absent key is not silence a host has to interpret twice over: `D-0015`
 * rule 7 holds, so "no `session_id`" means "the identity is unknown" and never
 * "read the message for it".
 */
function refusalMetadata(error: Error): RefusalMetadata {
  if (error instanceof LoserTerminated) {
    return { sessionId: error.sessionId };
  }
  if (error instanceof LapRefused) {
    return { sessionId: error.sessionId };
  }
  return {};
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
 *
 * **Under `--json` the same facts are one document**, built field by field off
 * the `LapOutcome` record rather than by parsing the line above: the two
 * spellings are two renderings of one record, and a document assembled from the
 * text would be a rendering of a rendering.
 *
 * **`pythonRepr` is deliberately absent from the JSON path**, and its absence is
 * not the guard being forgotten. The quoting below exists because a POSIX
 * filename may hold a newline or a terminal control sequence and a one-line
 * report is forgeable by one; a JSON document is not, because
 * `asciiJsonLine` escapes every such byte on its way out and a host parses the
 * result instead of reading it. Applying both would put a repr's own quotes
 * inside a JSON string, which is a value naming a path nothing on the host's
 * side can open.
 */
function report(path: string, outcome: LapOutcome, json: boolean): void {
  if (json) {
    lapCliSeams.write(
      successLine(PERFORM_SCHEMA, path, {
        run_id: outcome.intent.runId,
        workspace: outcome.materialized.workspace,
        topic_branch: outcome.intent.topicBranch,
        base_commit: outcome.materialized.baseCommit,
        session_id: outcome.orchestration.sessionId,
        // The walk's own name for the road it took -- `started`, `respawned`,
        // `resumed` -- and not a filesystem path, which is what the human line
        // beside the session id says too.
        session_path: outcome.orchestration.path,
        gate_id: outcome.ingested.gateId,
        event_id: outcome.ingested.eventId,
        event_seq: outcome.ingested.eventSeq,
        // **Always present, and `null` when there is nothing to say.** These are
        // the two conditional `note:` lines below, and a host that had to tell
        // an absent key from a null one to learn that the lap was clean would be
        // reading the absence of evidence as evidence. The failure is reduced to
        // its message rather than carried as the Error it is: `successLine` takes
        // primitives, and a class instance handed to a JSON encoder is whatever
        // its enumerable fields happen to be -- for an `Error`, nothing.
        endpoint_lease_failure:
          outcome.endpointLeaseFailure === null
            ? null
            : { message: outcome.endpointLeaseFailure.message },
        elapsed_deadline_at_ms: outcome.elapsedDeadlineAtMs,
        // **A key added under the same `/1`, which is the version story this
        // module's `PERFORM_SCHEMA` states rather than an exception to it**: an
        // unread key is one every JSON reader already handles, and `/2` is for
        // a change a host cannot absorb. It is here because a host that drives
        // laps is the thing that has to account for what they cost, and until
        // `D-0099` no surface in this stack could tell it which model a lap ran
        // on. `null` says the choice was the worker CLI's, which is a different
        // fact from any model name and is reported as such.
        model: outcome.model,
      }),
    );
    return;
  }
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
      `${outcome.ingested.eventSeq}` +
      // **The one clause that is present or absent rather than always there**,
      // and the asymmetry with the JSON document's always-present `model` key is
      // deliberate. A host has to be able to tell "the operator chose" from "the
      // CLI chose" without knowing which keys to expect, so the document says
      // `null`; a person reading a line already knows whether they typed the
      // flag, and a lap that named no model prints the line it has always
      // printed, byte for byte (`D-0099`).
      `${outcome.model === null ? "" : `, model ${pythonRepr(outcome.model)}`}\n`,
  );
  if (outcome.endpointLeaseFailure !== null) {
    // Its own line, on stdout beside the success it qualifies, exactly as the
    // elapsed deadline below is: the lap succeeded and the gate is open, and
    // this says that the worker's endpoint stopped being able to write partway
    // through the turn. The operator needs it because nothing else will say so
    // -- the report reached the gate through the transcript, not through the
    // endpoint -- and because a delivery attempted after this point was
    // refused rather than lost.
    lapCliSeams.write(
      `note: the endpoint's delivery lease was lost while the turn ran, so the worker's ` +
        `endpoint could no longer write: ${outcome.endpointLeaseFailure.message}\n`,
    );
  }
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
  const model = optionalText(args, "model");
  const endpointModule = optionalText(args, "endpoint_module");
  const endpointDatabase = optionalText(args, "endpoint_db");
  const node = optionalText(args, "node");
  const hookScript = optionalText(args, "hook_script");
  const python = optionalText(args, "python");
  const gitTimeoutMs = optionalInt(args, "git_timeout_ms");
  const identityReadbackTimeoutMs = optionalInt(args, "identity_readback_timeout_ms");
  const deadlineAtMs = optionalInt(args, "gate_deadline_at_ms");
  // Read once, at the top, and carried to the two places that write bytes. The
  // value cannot change while the lap runs, and reading it inside `report` or
  // `refuse` would make two functions ask the namespace the same question.
  const json = jsonRequested(args);

  try {
    // **Before the provider is constructed, and that order is the whole of why
    // this call exists** (`D-0099`). The provider takes the model as
    // `base_cli_args` and raises `PyValueError` at construction on any flag it
    // renders itself -- so `--model=-p` met that guard first, and a rule whose
    // promise is one line and exit 2 produced a stack trace and exit 1, with no
    // refusal document under `--json`. The rule itself is `root.ts`'s and is
    // stated once there; `performLap`'s preflight asks it again for its own
    // callers.
    requireModel(model);
    const provider = createDefaultSessionProvider(stateRoot, {
      ...(claudeCommand === undefined ? {} : { claudeCommand }),
      // **This is where model selection lives** (`D-0099`), and the seam is the
      // provider's own: `baseCliArgs` is documented there as the one for
      // provider-wide choices "(a pinned `--model`, say)", appended to every
      // spawn before the per-role `cli_args` and after the flags the provider
      // renders itself. Nothing else in the stack had a place for the choice --
      // `roles.json` carries no model key and is not going to (`D-0014`: a role
      // is not an executor), the `cli_args` allowlist is a per-run operator
      // vector checked by whole-vector equality (`D-0088`), and the admitted
      // record fixes what a run may do rather than what it costs.
      //
      // Two tokens and never one: `--model=<id>` would be a single token whose
      // interpretation belongs to the child's parser, and the value has been
      // checked as an id on the assumption that it arrives as its own argument.
      //
      // Constructed AFTER the check above and handed to `performLap` below to be
      // CHECKED again, exactly as `--claude-command` and `--state-root` are
      // (`D-0067`): this constructor has a guard of its own over `base_cli_args`,
      // and reaching it first turned an operator's typo into a stack trace.
      ...(model === undefined ? {} : { baseCliArgs: ["--model", model] }),
    });
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
        // Handed over to be CHECKED, like the two above it (`D-0099`): the
        // provider is already built over this value, and `preflight` is where
        // an argument an operator typed is refused before a branch, a worktree
        // and the one global delivery lease exist.
        ...(model === undefined ? {} : { model }),
        endpoint: {
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
        // Omitted when the operator did not type one, so the default is the
        // orchestrator's single statement of it rather than a copy here that
        // could drift from it (the pattern `--git-timeout-ms` already follows,
        // and the reason `--turn-timeout-ms`'s local default is the exception:
        // that one is read by this module's own poll loop).
        ...(identityReadbackTimeoutMs === undefined ? {} : { identityReadbackTimeoutMs }),
        gateOptions: gateOptionsOf(args),
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      });
      report(path, outcome, json);
    } finally {
      // Closed before the session is stopped, so a stop that hangs cannot hold
      // the database open: everything durable this verb writes has already
      // committed by the time the report line is printed.
      connection.close();
    }
  } catch (error) {
    if (isOperatorRefusal(error)) {
      refuse(error, path, json);
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
  // No --endpoint-epoch (D-0074). The epoch is the one `performLap` mints when
  // it takes the delivery lease, so the worker's endpoint is configured with a
  // lease that is live and being renewed rather than with a number an operator
  // typed. Keeping the flag as an override would keep a supported way to render
  // an epoch naming no live lease, which is the defect step 4 closes.
  perform.addArgument({
    optionStrings: ["--endpoint-recipient"],
    dest: "endpoint_recipient",
    choices: SERVED_RECIPIENTS,
    required: true,
    help: ENDPOINT_RECIPIENT_HELP,
  });
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

  // which model the worker runs on (`D-0099`). Optional, and its absence is
  // what every lap before it did: no token is appended and the worker CLI's own
  // default applies.
  addOptional(perform, "--model", "model", MODEL_HELP);

  // the role document's placeholders
  addRequired(perform, "--interlock-root", "interlock_root", INTERLOCK_ROOT_HELP);
  addRequired(perform, "--claude-org-path", "claude_org_path", CLAUDE_ORG_PATH_HELP);
  addOptional(perform, "--hook-script", "hook_script", HOOK_SCRIPT_HELP);
  addOptional(perform, "--python", "python", PYTHON_HELP);

  // when the turn is over, and how long it is given (D-0060)
  addOptionalInt(perform, "--poll-interval-ms", "poll_interval_ms", POLL_INTERVAL_MS_HELP);
  addOptionalInt(perform, "--turn-timeout-ms", "turn_timeout_ms", TURN_TIMEOUT_MS_HELP);
  addOptionalInt(perform, "--git-timeout-ms", "git_timeout_ms", GIT_TIMEOUT_MS_HELP);
  addOptionalInt(
    perform,
    "--identity-readback-timeout-ms",
    "identity_readback_timeout_ms",
    IDENTITY_READBACK_TIMEOUT_MS_HELP,
  );

  // the gate this verb opens
  perform.addArgument({
    optionStrings: ["--gate-option"],
    dest: "gate_options",
    append: true,
    metavar: "GATE_OPTION",
    help: GATE_OPTION_HELP,
  });
  addOptionalInt(perform, "--gate-deadline-at-ms", "gate_deadline_at_ms", GATE_DEADLINE_HELP);

  // Declared by `cli/json_output.ts` rather than here: this is the one flag in
  // the CLI whose whole value is that every host-facing verb spells it
  // identically, and that module says why it is the deliberate exception to
  // "a subtree declares its own flags".
  addJsonArgument(perform);

  // `asynchronous` is read by `dispatch` BEFORE the handler is called: this
  // verb materialises a worktree, publishes a fence and starts a child, and a
  // synchronous caller that discovered the shape from the returned value would
  // have discovered it after all of that had already happened.
  perform.setDefaults({ func: cmdLapPerform, asynchronous: true });
}
