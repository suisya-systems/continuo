/**
 * `continuo run admit`, `continuo run close` and `continuo run show`.
 *
 * Mounted into the unified CLI by `src/cli.ts`, which owns no flag of its own
 * here: the subtree's module declares its parser, exactly as
 * `measurement/cli.ts`, `settings/cli.ts`, `attention/cli.ts` and this
 * directory's `cli.ts` do (`D-0030`).
 *
 * **A separate module from `cli.ts`, deliberately.** That file is the `db`
 * subtree -- create, migrate, verify -- and the rule `src/cli.ts` states is that
 * a subtree's flags are declared by the module that owns them, so that they stay
 * in lock-step with it. `run` is a different subtree with a different subject:
 * `db` is about the file, and `run` is about what is written inside it. Folding
 * the second into the first would put two subtrees behind one `addSubparsers`,
 * which is the drift that rule exists to prevent, one directory earlier than
 * usual.
 *
 * **This layer is thin, and the thinness is the point** -- the same point
 * `cli.ts` makes about the migrator. Every rule about what an admission *is* --
 * that the row is inserted at `created`, that the row and its `run_created`
 * event are one transaction, that a second admission of one identifier is
 * refused -- lives in `run_admission.ts` and is stated there once. A second
 * statement of any of it here would be a second answer to "was this run
 * admitted", and two answers eventually disagree about one database. So the verb
 * resolves its arguments, opens the database, calls exactly one domain entry
 * point, reports what it wrote, and closes the handle.
 *
 * **Why the database is opened with `openProductionControlPlane`.** It is the
 * same standard `continuo db verify` stands in for: a production database, its
 * ledger verified, **and at this build's head** -- the control plane `D-0050`
 * settles the lap runs on. Admission writes rows whose
 * shape is this build's schema, so opening a database that is behind would write
 * them into a file whose DDL predates them -- the failure arriving later, as a
 * constraint nobody can place, rather than here as a refusal naming the version.
 * There is no `--migrate` shortcut: bringing a database forward is `db migrate`,
 * and a command that quietly migrated the file it was pointed at would make the
 * forward-only ledger a side effect of a write rather than a decision.
 *
 * **A refusal is an operator-facing line, not a stack trace.** `RunAlreadyAdmitted`
 * and the migrator's refusals are all in the `ControlPlaneRefusal` family, and
 * all of them are the ordinary outcome of a command an operator typed -- this
 * run is already admitted, this file is not a control plane, this file is behind
 * -- rather than defects. They become one stderr line and exit 2, the same code
 * `db verify` and `attention scan` use. `close` meets three families rather than
 * one, because it takes a lease and transitions a row; {@link isOperatorRefusal}
 * names them and says why each is an outcome an operator acts on. The two usage
 * errors are deliberately *not* caught: they are defects in a caller, and
 * `admit`'s is not reachable from here at all, because the parser has already
 * established that `--run-id` is a string and `--now-ms` an int.
 *
 * **`show` is the read half, and it is the read surface (`D-0096`).** cadenza's
 * operating-surface design measured what a console draws and found one pane
 * with no read path at all -- run and belt state, `awaiting_user` and the
 * outbox -- so the only way to draw it was to open continuo's SQLite file from
 * a second process. `D-0096` settles that the database is **not** a public read
 * surface and this verb is: it answers one run's row, its lease, its session
 * bindings, its open gates, its events and its outbox rows in the one envelope,
 * and it refuses an unknown run rather than answering an empty document. It is
 * as thin as the other two -- every rule about what those rows mean lives in
 * `run_view.ts` and the modules it reads through -- and it writes nothing, takes
 * no lease and reads no clock. It is deliberately outside the fence and outside
 * `lap perform`: a read a console makes is not a step of the lap.
 *
 * **`--json` changes the bytes and nothing else.** All three verbs answer a host
 * in the one envelope `src/cli/json_output.ts` declares, under the pinned schema
 * ids {@link ADMIT_SCHEMA}, {@link CLOSE_SCHEMA} and {@link SHOW_SCHEMA}. Without
 * the flag the report lines are byte-identical to what they have always been --
 * `show` is new, so what that means for it is that its human rendering is the
 * one it shipped with and is not a fallback for a failed document. With it, the
 * exit codes, the refusal families {@link isOperatorRefusal} names, the order of
 * operations and the `finally` that closes the handle are all unchanged: the
 * flag is read once per verb and reaches exactly two places, the report and
 * {@link refuse}. A verb that behaved differently under a flag a host sets for
 * its own convenience would make the flag part of the contract of what the verb
 * does, which is the thing this seam exists to keep out.
 *
 * **What `--json` does not reach, deliberately.** The two usage errors and
 * `LapRunIntentUsageError` still escape as a stack trace and exit 1, under
 * `--json` exactly as without it. Wrapping them in a refusal document would
 * erase the distinction the paragraph above draws, which is the only signal a
 * host has that it called this CLI wrongly rather than being told no. A host's
 * rule is therefore three-valued and is stated in `json_output.ts`: exit 0,
 * parse stdout; exit 2, parse stderr; anything else, stderr is text.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives: every string
 * here reaches `--help` on a cp932 console, where a character the console cannot
 * encode is a crash rather than a smudge.
 *
 * **What that leaves open, stated rather than glossed.** The report interpolates
 * two external values, and only one of them is constrained. `--run-id` is
 * refused unless it is printable ASCII, because admission is where run
 * identifiers enter the database and it promises to print them back (`D-0051`).
 * `--db` is **not**: it is echoed verbatim, exactly as `continuo db
 * create|migrate|verify` has echoed it since that subtree shipped. That is a
 * deliberate carry rather than an oversight -- an operator chooses a run id and
 * merely *has* a filesystem path, so narrowing the path would refuse databases
 * that exist and work. It does mean a path holding a newline or a character the
 * console cannot encode reaches stdout unaltered, which is the open problem
 * `docs/cli-output-policy.md` hands to "any code path that echoes external text
 * to a console". Answering it belongs to whichever entry settles it for every
 * verb at once, not to this one, which would otherwise leave the two subtrees
 * printing the same value under two rules.
 */

import {
  addJsonArgument,
  type JsonValue,
  jsonRequested,
  refusalLine,
  successLine,
} from "../cli/json_output.js";
import type { Namespace, Subparsers } from "../cli/parser.js";
import { ArgparseExit, type ArgumentParser } from "../cli/parser.js";
import { LapRunIntent } from "./lap_run_intent.js";
import { LeaseRefusal } from "./lease.js";
import { openProductionControlPlane } from "./migrator.js";
import { ControlPlaneRefusal } from "./refusals.js";
import {
  admitRun,
  RUN_CREATED_EVENT_TYPE,
  RUN_DELEGATION_RECORDED_EVENT_TYPE,
} from "./run_admission.js";
import { closeRun, RUN_CLOSE_OUTCOMES } from "./run_close.js";
import { type RunStatus, RunTransitionRefused, UnknownRunRefused } from "./run_lifecycle.js";
import { type RunView, runView } from "./run_view.js";

// ASCII only: these reach --help on a cp932 console.
const DB_HELP =
  "path to the production control plane database file. It must already exist " +
  "and be at this build's head; 'db create' and 'db migrate' are what put it " +
  "there.";
const RUN_ID_HELP =
  "the run's identifier, unique across the database. Admitting an identifier " +
  "that is already on the run table is refused, not absorbed: admission " +
  "states that a run begins.";
const NOW_MS_HELP =
  "the clock, epoch milliseconds, stamped as the run's created_at_ms and " +
  "updated_at_ms and as both events' timestamps. Read once from the system " +
  "clock when omitted; nothing below this command reads a clock.";
const LEASE_CLAIMANT_ID_HELP =
  "the value this run's lease will be taken under. A claimant identity, not " +
  "an authority: it grants nothing, and the lease's exclusivity comes from " +
  "the database's epoch rule rather than from this string.";
const WORKSPACE_HELP =
  "absolute path this lap will materialise its workspace INTO. It need not " +
  "exist yet; recording it fixes where the work goes, and the task that " +
  "creates it reports what it made in its own event.";
const ROLE_HELP = "the role the worker runs as.";
const BASE_BRANCH_HELP = "the branch this lap's work starts from.";
const TOPIC_BRANCH_HELP = "the branch this lap's work lands on.";
const PROMPT_HELP =
  "what the worker is being asked to do, verbatim. Free-form text: unlike " +
  "--run-id it is not held to ASCII, because it is prose and is stored " +
  "rather than printed back by this command.";
const CLI_ARG_HELP =
  "one extra argument for the worker's CLI. Repeat the flag to give several, " +
  "in order; omit it for none. The complete list is refused unless the role " +
  "document src/fencing/cli_args_allow.json authorises exactly that list, in " +
  "that order, for this --role: the shipped document authorises none, so any " +
  "argument at all is refused until it is edited. Widening is an edit to that " +
  "document, reviewed and with a written reason, not a per-run decision.";

const ADMIT_DESCRIPTION =
  "Admit a run: insert its row at status 'created', append the run_created " +
  "event that records it, and append the run_delegation_recorded event that " +
  "fixes what this lap was asked to do -- all in one transaction. Refuses a " +
  "run-id already on the table rather than re-admitting it, and exits 2 with " +
  "the reason when it refuses.";

const CLOSE_RUN_ID_HELP =
  "the run to close. It must already be admitted and must not already be at a " +
  "terminal status: which terminal status a run reached is a fact, and a wrong " +
  "one is corrected by opening a new run.";
const OUTCOME_HELP =
  "the terminal status the run reached. Required and never defaulted: a close " +
  "records an outcome the operator observed, and a guessed 'completed' would " +
  "be a fact nobody stated.";
const ACTOR_ID_HELP =
  "who is closing the run. The run lease is taken under this identity and the " +
  "transition is stamped with its epoch, so it is what the row records about " +
  "who closed the run. An identity, not an authority.";
const CLOSE_NOW_MS_HELP =
  "the clock, epoch milliseconds, stamped as the run's updated_at_ms and used " +
  "to take and give back the lease. Read once from the system clock when " +
  "omitted; nothing below this command reads a clock.";

const SHOW_RUN_ID_HELP =
  "the run to read. It must already be admitted: a run-id naming no run is " +
  "refused with the reason, never answered with an empty document, because " +
  "an empty answer cannot be told from a run that has done nothing yet.";

const SHOW_DESCRIPTION =
  "Show one run: its row, the run lease, its session bindings, its open " +
  "gates, every event on its spine and every outbox row enqueued for it. A " +
  "read and nothing else -- it writes no row, takes no lease and reads no " +
  "clock, so 'is this lease live' and 'has this deadline passed' stay the " +
  "caller's questions against the caller's clock. This is the read surface " +
  "for a console (D-0096): the database is not one. Refuses a run that is " +
  "absent, and exits 2 with the reason.";

const CLOSE_DESCRIPTION =
  "Close a run: record the operator's close by advancing the run from its " +
  "current status to the terminal status given by --outcome, as the single " +
  "fenced writer of run.status. It records step 11 rather than performing it " +
  "-- push, PR and merge stay manual -- and it appends no event and reads no " +
  "gate (D-0084). Refuses a run that is absent or already closed, and exits 2 " +
  "with the reason.";

/**
 * The pinned shape identifiers this subtree's `--json` documents carry.
 *
 * One per verb rather than one per subtree, because a host reads the
 * discriminator to know which payload keys it may expect and `admit` and
 * `close` answer with different ones. The `/1` is the whole of the version
 * story `src/cli/json_output.ts` states: a field added later leaves it alone,
 * and only a change a host cannot absorb makes it `/2`.
 *
 * Written here as literals rather than derived from the subcommand names, so
 * that renaming a subcommand -- a thing an operator sees immediately -- cannot
 * silently rename the contract a host parses, which nobody would see until the
 * host broke.
 */
const ADMIT_SCHEMA = "continuo.run.admit/1";
const CLOSE_SCHEMA = "continuo.run.close/1";
const SHOW_SCHEMA = "continuo.run.show/1";

/**
 * The three effects this module has on the world, as a replaceable record.
 *
 * The same shape and the same reason as `cli.ts`'s `dbCliSeams`: ESM bindings
 * cannot be rebound from outside the module that holds them, so the clock and
 * the two streams are reached through this record and the cases replace the
 * entry (`docs/test-translation-conventions.md` rule 5). `write` and
 * `writeError` are both here because a refused verb writes to stderr and a
 * successful one to stdout, and a test that read only one of them could not tell
 * "refused with a reason" from "printed nothing".
 *
 * Its own record rather than a share of `dbCliSeams`, so that a case capturing
 * this subtree's output cannot be satisfied by the other subtree's, and so the
 * two clocks are counted separately.
 *
 * Not re-exported from `src/index.ts`: a seam for the tests that own this
 * module, not public API.
 */
export const runCliSeams = {
  /** The only clock read by this verb, in epoch milliseconds. */
  nowMs: (): number => Date.now(),
  /** Where the one-line result goes. */
  write: (text: string): void => {
    process.stdout.write(text);
  },
  /** Where a refusal goes. */
  writeError: (text: string): void => {
    process.stderr.write(text);
  },
};

/**
 * The errors this subtree reports as an operator-facing line rather than
 * letting escape, in the shape `lap/cli.ts`'s `isOperatorRefusal` has.
 *
 * `ControlPlaneRefusal` is `admit`'s whole answer and half of `close`'s. The
 * other three are `close`'s alone, and each is an outcome an operator acts on:
 *
 * - `LeaseRefusal` covers `LeaseHeld` -- a lap is still driving this run, so
 *   wait or stop it -- and the two fenced-write refusals its family carries,
 *   which is what a second closer racing this one looks like.
 * - `RunTransitionRefused` and `UnknownRunRefused` are `run_lifecycle.ts`'s, and
 *   `run_close.ts` refuses both cases before the write with a message of its
 *   own. They are listed anyway because the pre-check and the write are not one
 *   transaction: a run closed by another writer in between arrives here, and it
 *   is still an ordinary answer rather than a defect.
 *
 * `RunAdmissionUsageError` and `RunCloseUsageError` are deliberately absent:
 * they are defects in a caller, and burying a stack under `error: ...` would
 * cost the frames that diagnose it.
 */
function isOperatorRefusal(error: unknown): error is Error {
  return (
    error instanceof ControlPlaneRefusal ||
    error instanceof LeaseRefusal ||
    error instanceof RunTransitionRefused ||
    error instanceof UnknownRunRefused
  );
}

/**
 * Report a refusal on stderr and stop, rather than letting it escape.
 *
 * `ArgparseExit` rather than `process.exit`, because `src/cli.ts`'s `main`
 * already catches it and turns it into the process's status -- the one place
 * that is a process boundary.
 *
 * **The one place either verb refuses, and the reason `--json` is taught here
 * rather than at the two call sites.** Both verbs funnel every operator refusal
 * through this function, so teaching it the flag makes "a refusal a host can
 * parse" a property of the subtree instead of a property of whichever branch a
 * particular refusal took. Branching per call site would have left the families
 * `close` alone meets -- `LeaseHeld`, a lost fenced write, a run another writer
 * closed in between -- emitting human text under `--json` while every success
 * case stayed green, which is exactly the silent half-conversion this shape
 * rules out.
 *
 * `schema`, `db` and `json` are parameters rather than module state because
 * this function returns `never` and is reached from two verbs with two schema
 * ids: a module-level "current verb" would be a second answer to which verb is
 * running, and two answers eventually disagree.
 *
 * The exit code, the stream and the fact that this throws are identical either
 * way. `--json` changes the bytes, never the control flow.
 */
function refuse(error: Error, schema: string, db: string, json: boolean): never {
  runCliSeams.writeError(json ? refusalLine(schema, db, error) : `error: ${error.message}\n`);
  throw new ArgparseExit(2, "refused run verb");
}

/** `--now-ms` if given, else the one clock read. */
function nowMsOf(args: Namespace): number {
  const supplied = args["now_ms"];
  return typeof supplied === "number" ? supplied : runCliSeams.nowMs();
}

/**
 * `--cli-arg`, repeated, as the list the record takes.
 *
 * `action="append"` leaves the namespace key `None` when the flag was never
 * given and a list when it was, so both shapes are handled here rather than
 * inside {@link LapRunIntent}: an absent optional flag is a fact about the
 * command line, and the record's own vocabulary for "no arguments" is an empty
 * list.
 */
function cliArgsOf(args: Namespace): readonly string[] {
  const supplied = args["cli_args"];
  return Array.isArray(supplied) ? supplied.map(String) : [];
}

/**
 * The intent, built from the parsed arguments and validated by its own
 * constructor.
 *
 * Every value is read through `String` for the reason the existing `--db` and
 * `--run-id` reads are: the parser's namespace is `unknown`-valued, and the
 * record refuses what is not text anyway, so this narrows the type without
 * deciding anything the record has not already decided.
 */
function intentOf(args: Namespace): LapRunIntent {
  return new LapRunIntent({
    runId: String(args["run_id"]),
    leaseClaimantId: String(args["lease_claimant_id"]),
    workspace: String(args["workspace"]),
    role: String(args["role"]),
    baseBranch: String(args["base_branch"]),
    topicBranch: String(args["topic_branch"]),
    prompt: String(args["prompt"]),
    cliArgs: cliArgsOf(args),
  });
}

/**
 * `continuo run admit`.
 *
 * The handle is closed in a `finally` whatever the outcome, including a
 * refusal: the refusal path leaves a verified database open otherwise, and on
 * Windows an open handle is a locked file, so the next command would fail for a
 * reason that has nothing to do with what it was asked to do.
 */
export function cmdRunAdmit(args: Namespace): number {
  const path = String(args["db"]);
  // Built BEFORE the database is opened, so a malformed field costs no handle:
  // the record's constructor is the whole of this verb's field validation, and
  // it must be reached on the path where nothing is open yet.
  const intent = intentOf(args);
  const nowMs = nowMsOf(args);
  const json = jsonRequested(args);

  try {
    const connection = openProductionControlPlane(path);
    try {
      const admitted = admitRun(connection, { intent, nowMs });
      // Both events, named and numbered. The line is what an operator has to
      // read to know the work statement landed with the run rather than after
      // it -- reporting only the first would make the transaction's whole point
      // invisible at the surface that performs it.
      //
      // The JSON document says the same thing, plus `created_at_ms`. That value
      // is not on the human line, and it is the resolved clock -- `--now-ms` if
      // given and this build's one read of the system clock otherwise. A host
      // that omitted `--now-ms` could otherwise learn what its own run was
      // stamped with only by reopening the database, which is the one thing a
      // thin verb should not make its caller do.
      //
      // `events` is a NAMED object keyed by the event type constants rather than
      // an array. `AdmittedRun` carries two named pairs and promises nothing
      // about their relative order beyond the append order the seq numbers
      // already state; a host writing `events[0]` would be reading an order off
      // a position this record never fixed. The keys come from the exported
      // constants for the same reason `--outcome`'s `choices` reads
      // `RUN_CLOSE_OUTCOMES`: the vocabulary itself, not a copy of it.
      runCliSeams.write(
        json
          ? successLine(ADMIT_SCHEMA, path, {
              run_id: admitted.runId,
              status: admitted.status,
              created_at_ms: admitted.createdAtMs,
              events: {
                [RUN_CREATED_EVENT_TYPE]: {
                  event_id: admitted.eventId,
                  seq: admitted.eventSeq,
                },
                [RUN_DELEGATION_RECORDED_EVENT_TYPE]: {
                  event_id: admitted.delegationEventId,
                  seq: admitted.delegationEventSeq,
                },
              },
            })
          : `admitted ${admitted.runId} in ${path}: status ${admitted.status}, ` +
              `${admitted.eventId} at seq ${admitted.eventSeq}, ` +
              `${admitted.delegationEventId} at seq ${admitted.delegationEventSeq}\n`,
      );
    } finally {
      connection.close();
    }
  } catch (error) {
    if (isOperatorRefusal(error)) {
      refuse(error, ADMIT_SCHEMA, path, json);
    }
    throw error;
  }
  return 0;
}

/**
 * `continuo run close`.
 *
 * As thin as `admit`, and thin about a smaller thing: every rule about what a
 * close is -- the statuses it may leave, the terminal set it may reach, that it
 * appends no event and reads no gate -- lives in `run_close.ts` and is stated
 * there once (`D-0084`). This resolves arguments, opens the database, calls one
 * entry point, reports what moved, and closes the handle in a `finally` whatever
 * the outcome, for the reason `cmdRunAdmit` does.
 */
export function cmdRunClose(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  const json = jsonRequested(args);

  try {
    const connection = openProductionControlPlane(path);
    try {
      const closed = closeRun(connection, {
        runId: String(args["run_id"]),
        // The parser's `choices` is this same set, so the cast narrows a value
        // argparse has already held to the vocabulary.
        outcome: String(args["outcome"]) as RunStatus,
        actorId: String(args["actor_id"]),
        nowMs,
      });
      // The step and the epoch. The step, because an operator closing a run out
      // of `created` should see that it never ran; the epoch, because it is the
      // link between this row and the lease row naming who closed it, and it is
      // the whole of the close's audit trail.
      //
      // The document carries the same five facts, field by field off the
      // record: `from` and `to` are the step, and `writer_epoch` is a number
      // rather than the string the human line interpolates, because it is the
      // integer that links this row to the lease row naming who closed the run
      // and a host comparing it against a lease would otherwise be comparing
      // text to an integer.
      runCliSeams.write(
        json
          ? successLine(CLOSE_SCHEMA, path, {
              run_id: closed.runId,
              from: closed.from,
              to: closed.to,
              actor_id: closed.actorId,
              writer_epoch: closed.writerEpoch,
            })
          : `closed ${closed.runId} in ${path}: status ${closed.from} -> ${closed.to} ` +
              `by ${closed.actorId} under writer epoch ${closed.writerEpoch}\n`,
      );
    } finally {
      connection.close();
    }
  } catch (error) {
    if (isOperatorRefusal(error)) {
      refuse(error, CLOSE_SCHEMA, path, json);
    }
    throw error;
  }
  return 0;
}

/**
 * An epoch-millisecond or epoch column, or `-` when the row carries none.
 *
 * The human rendering's placeholder only. The document never carries `"-"`:
 * `null` is what an absent value is there, for the reason `gate/cli.ts` gives
 * -- a host that saw `"-"` could not tell a missing value from a value one
 * character long.
 */
function stamp(value: number | string | null): string {
  return value === null ? "-" : String(value);
}

/**
 * One field of unconstrained persisted text, quoted, or `-` when absent.
 *
 * **This is the rendering decision the "one line per row" claim depends on, and
 * it is applied by one rule rather than field by field.** A value this build
 * constrains is printed raw; a value it does not is printed through here.
 * Interpolated raw, a newline in an unconstrained field silently stops the
 * rendering being one line per row, and a terminal escape lets persisted text
 * forge a line an operator reads as this command's own.
 *
 * **Raw, because something narrows them.** The closed vocabularies the DDL
 * enforces with a `CHECK ... IN`: `run.status`, `session.binding_phase`,
 * `session.observation`, `gate.gate_type`, `gate.stage`, `event.subject_kind`
 * and `outbox.status`. A run identifier, and the lease resource derived from
 * one, because `D-0051` holds an admitted run id to printable ASCII and
 * admission is the only writer of the row -- and because `run admit` and
 * `run close` print run ids raw, so quoting here would print one value under
 * two rules. `--db` for that same reason, which this module's header already
 * records as a standing exception belonging to whichever entry settles echoed
 * external text for every verb at once.
 *
 * **Quoted, because nothing does.** Everything else: `lease.holder`,
 * `session.session_id`, `session.provider`, `session.provider_state`,
 * `session.observation_reason`, `gate.gate_id`, `event.event_id`,
 * `event.event_type` (`events.ts` says the column is deliberately open text),
 * `event.subject_id`, `event.producer`, `outbox.message_id` and
 * `outbox.recipient`. Each is `NOT NULL` and at most `length(...) > 0`, and
 * each is written by a caller -- `prepareBinding` takes a session id and a
 * provider name and validates neither's alphabet.
 *
 * **Quoting is conditional, and that is what keeps this verb's lines the same
 * as every other verb's on real data.** A value that cannot break the framing
 * is printed exactly as it is; only one that could is quoted. The condition is
 * {@link BREAKS_A_LINE}: anything outside printable ASCII -- which is every
 * character that can end a line or move a terminal cursor -- plus the double
 * quote itself, so that a reader never has to wonder whether a quoted-looking
 * value was quoted by this function or stored that way. An ordinary session
 * uuid, provider name, gate id or recipient renders byte for byte as it would
 * have without this function, so `run show` and `gate show` print one value the
 * same way; a hostile one renders as an escaped, quoted, still-reversible
 * string on one line.
 *
 * `JSON.stringify` for the escaping rather than a scheme invented here: one
 * call, reversible, and it escapes exactly the characters the condition
 * selects for. Deliberately NOT held to ASCII on the raw path -- see `--db`
 * above.
 *
 * **The other human renderings in this CLI do not do this yet**, and saying so
 * is the honest half: `gate list` and `gate show` interpolate gate ids, relay
 * message ids, actor ids and answer bodies raw, and carry the same exposure.
 * Closing it there is the cross-verb entry `docs/cli-output-policy.md` is
 * waiting for, not a change this verb makes on their behalf. What this verb
 * does not do is add a new instance of it.
 *
 * The document needs none of this: {@link asciiJsonLine} escapes every one of
 * these values already, which is why the two payload columns are safe there and
 * absent here.
 */
const BREAKS_A_LINE = /[^\x20-\x7e]|"/;

function quoted(value: string | null): string {
  if (value === null) {
    return "-";
  }
  return BREAKS_A_LINE.test(value) ? JSON.stringify(value) : value;
}

/**
 * `run show`'s payload: the run, and the five things a console draws beside it.
 *
 * Built key by key rather than by spreading the record, for the two reasons
 * `gate/cli.ts`'s `showPayload` gives and which apply here with more force:
 * the record's fields are `camelCase` and the document's are `snake_case`, and
 * a spread would make every future field of {@link RunView} an unreviewed
 * addition to a pinned host contract.
 *
 * **The keys are the tables**, so a host reading this document and a person
 * reading `docs/production-schema.md` are looking at the same five nouns.
 * `lease` is `null` when the run has never been leased -- an absent lease is a
 * fact about the run, and `{}` would be a lease with no holder. The four lists
 * are always present and empty when nothing matched, because an absent key is
 * the one absence a JSON reader cannot distinguish from one it forgot to read.
 *
 * `payload` is carried on an event and on an outbox row as the **verbatim TEXT
 * of the column**, not as a nested object. The DDL already guarantees
 * `json_valid(payload)` for an event, so a host that wants the object calls
 * `JSON.parse` on a string; re-encoding it here would make these bytes depend
 * on this build's JSON renderer rather than on the value that was stored, which
 * is the same argument `D-0090` makes for not borrowing `pyJsonDumps`.
 */
function showPayload(view: RunView): { readonly [key: string]: JsonValue } {
  return {
    run: {
      run_id: view.run.runId,
      status: view.run.status,
      writer_epoch: view.run.writerEpoch,
      created_at_ms: view.run.createdAtMs,
      updated_at_ms: view.run.updatedAtMs,
    },
    lease:
      view.lease === null
        ? null
        : {
            resource: view.lease.resource,
            holder: view.lease.holder,
            epoch: view.lease.epoch,
            acquired_at_ms: view.lease.acquiredAtMs,
            expires_at_ms: view.lease.expiresAtMs,
          },
    sessions: view.sessions.map((session) => ({
      session_id: session.sessionId,
      provider: session.provider,
      binding_phase: session.bindingPhase,
      observation: session.observation,
      provider_state: session.providerState,
      observation_reason: session.observationReason,
      bound_at_ms: session.boundAtMs,
      released_at_ms: session.releasedAtMs,
    })),
    gates: view.gates.map((gate) => ({
      gate_id: gate.gateId,
      gate_type: gate.gateType,
      stage: gate.stage,
      stage_entered_at_ms: gate.stageEnteredAtMs,
      deadline_at_ms: gate.deadlineAtMs,
    })),
    events: view.events.map((event) => ({
      seq: event.seq,
      event_id: event.eventId,
      event_type: event.eventType,
      subject_kind: event.subjectKind,
      subject_id: event.subjectId,
      payload: event.payload,
      producer: event.producer,
      producer_epoch: event.producerEpoch,
      dedup_key: event.dedupKey,
      occurred_at_ms: event.occurredAtMs,
      ingested_at_ms: event.ingestedAtMs,
    })),
    outbox: view.outbox.map((row) => ({
      message_id: row.messageId,
      recipient: row.recipient,
      payload: row.payload,
      dedup_key: row.dedupKey,
      status: row.status,
      retry_count: row.retryCount,
      writer_epoch: row.writerEpoch,
      enqueued_at_ms: row.enqueuedAtMs,
      delivered_at_ms: row.deliveredAtMs,
      acked_at_ms: row.ackedAtMs,
    })),
  };
}

/**
 * The human rendering of `run show`: one line for the run, one per row after it.
 *
 * **Neither payload is on a human line, and that is not an oversight.** An
 * event or outbox payload is free-form text that may hold a newline, and a
 * line-per-row rendering that interpolated one would silently stop being one
 * line per row. An operator reading a payload asks for the document; the
 * rendering here is the shape of the run, which is what a person scanning a
 * terminal is actually after.
 */
function writeRunView(view: RunView, path: string): number {
  runCliSeams.write(
    `run ${view.run.runId} in ${path}: status ${view.run.status} ` +
      `created=${view.run.createdAtMs} updated=${view.run.updatedAtMs} ` +
      `writer_epoch=${stamp(view.run.writerEpoch)}\n`,
  );
  runCliSeams.write(
    view.lease === null
      ? "lease -\n"
      : `lease ${view.lease.resource} holder=${quoted(view.lease.holder)} ` +
          `epoch=${view.lease.epoch} acquired=${view.lease.acquiredAtMs} ` +
          `expires=${view.lease.expiresAtMs}\n`,
  );
  for (const session of view.sessions) {
    runCliSeams.write(
      `session ${quoted(session.sessionId)} provider=${quoted(session.provider)} ` +
        `phase=${session.bindingPhase} observation=${session.observation} ` +
        `state=${quoted(session.providerState)} reason=${quoted(session.observationReason)} ` +
        `bound=${session.boundAtMs} released=${stamp(session.releasedAtMs)}\n`,
    );
  }
  for (const gate of view.gates) {
    runCliSeams.write(
      `gate ${quoted(gate.gateId)} ${gate.gateType} stage=${gate.stage} ` +
        `since=${gate.stageEnteredAtMs} deadline=${stamp(gate.deadlineAtMs)}\n`,
    );
  }
  for (const event of view.events) {
    runCliSeams.write(
      `event ${event.seq} ${quoted(event.eventType)} ${quoted(event.eventId)} ` +
        `subject=${event.subjectKind}/${quoted(event.subjectId)} producer=${quoted(event.producer)} ` +
        `epoch=${stamp(event.producerEpoch)} occurred=${event.occurredAtMs} ` +
        `ingested=${event.ingestedAtMs}\n`,
    );
  }
  for (const row of view.outbox) {
    runCliSeams.write(
      `outbox ${quoted(row.messageId)} to=${quoted(row.recipient)} status=${row.status} ` +
        `retries=${row.retryCount} epoch=${stamp(row.writerEpoch)} ` +
        `enqueued=${row.enqueuedAtMs} delivered=${stamp(row.deliveredAtMs)} ` +
        `acked=${stamp(row.ackedAtMs)}\n`,
    );
  }
  return 0;
}

/**
 * `continuo run show`.
 *
 * As thin as the other two, and thin about a read: `run_view.ts` decides what a
 * run's state consists of and this decides how it is rendered. The handle is
 * closed in a `finally` whatever the outcome, for the reason `cmdRunAdmit`
 * gives.
 *
 * No `--now-ms`: this verb reads no clock. There is nothing to stamp, and a
 * clock argument on a read would invite the belief that the answer is evaluated
 * at it -- the millisecond columns are carried raw so the caller evaluates them
 * against its own.
 */
export function cmdRunShow(args: Namespace): number {
  const path = String(args["db"]);
  const runId = String(args["run_id"]);
  const json = jsonRequested(args);

  try {
    const connection = openProductionControlPlane(path);
    try {
      const view = runView(connection, runId);
      if (json) {
        runCliSeams.write(successLine(SHOW_SCHEMA, path, showPayload(view)));
        return 0;
      }
      return writeRunView(view, path);
    } finally {
      connection.close();
    }
  } catch (error) {
    if (isOperatorRefusal(error)) {
      refuse(error, SHOW_SCHEMA, path, json);
    }
    throw error;
  }
}

/** `--db`, spelled as the `db` subtree spells it. */
function addDbArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--db"],
    dest: "db",
    required: true,
    metavar: "DB",
    help: DB_HELP,
  });
}

/** `add_subparsers`: mount `admit`, `close` and `show` under `run`. */
export function addSubparsers(sub: Subparsers): void {
  const admit = sub.addParser("admit", ADMIT_DESCRIPTION);
  addDbArgument(admit);
  admit.addArgument({
    optionStrings: ["--run-id"],
    dest: "run_id",
    required: true,
    metavar: "RUN_ID",
    help: RUN_ID_HELP,
  });
  // The intent's fields, in the record's own field order rather than
  // alphabetically, so `--help` reads as the record reads.
  for (const [option, dest, help] of [
    ["--lease-claimant-id", "lease_claimant_id", LEASE_CLAIMANT_ID_HELP],
    ["--workspace", "workspace", WORKSPACE_HELP],
    ["--role", "role", ROLE_HELP],
    ["--base-branch", "base_branch", BASE_BRANCH_HELP],
    ["--topic-branch", "topic_branch", TOPIC_BRANCH_HELP],
    ["--prompt", "prompt", PROMPT_HELP],
  ] as const) {
    admit.addArgument({
      optionStrings: [option],
      dest,
      required: true,
      metavar: dest.toUpperCase(),
      help,
    });
  }
  admit.addArgument({
    optionStrings: ["--cli-arg"],
    dest: "cli_args",
    append: true,
    metavar: "CLI_ARG",
    help: CLI_ARG_HELP,
  });
  admit.addArgument({
    optionStrings: ["--now-ms"],
    dest: "now_ms",
    type: "int",
    metavar: "NOW_MS",
    help: NOW_MS_HELP,
  });
  // Declared by `cli/json_output.ts` rather than here: this is the one flag in
  // the CLI whose whole value is that twelve verbs spell it identically, and that
  // module says why it is the deliberate exception to "a subtree declares its
  // own flags".
  addJsonArgument(admit);
  admit.setDefaults({ func: cmdRunAdmit });

  const close = sub.addParser("close", CLOSE_DESCRIPTION);
  addDbArgument(close);
  close.addArgument({
    optionStrings: ["--run-id"],
    dest: "run_id",
    required: true,
    metavar: "RUN_ID",
    help: CLOSE_RUN_ID_HELP,
  });
  close.addArgument({
    optionStrings: ["--outcome"],
    dest: "outcome",
    required: true,
    // The vocabulary itself, not a copy of it: `run_close.ts` names the terminal
    // set and this reads it, so --help and the domain cannot disagree.
    choices: RUN_CLOSE_OUTCOMES,
    help: OUTCOME_HELP,
  });
  close.addArgument({
    optionStrings: ["--actor-id"],
    dest: "actor_id",
    required: true,
    metavar: "ACTOR_ID",
    help: ACTOR_ID_HELP,
  });
  close.addArgument({
    optionStrings: ["--now-ms"],
    dest: "now_ms",
    type: "int",
    metavar: "NOW_MS",
    help: CLOSE_NOW_MS_HELP,
  });
  addJsonArgument(close);
  close.setDefaults({ func: cmdRunClose });

  // `show` takes exactly two arguments and no clock: it is a read, so there is
  // nothing to stamp and nothing to fence.
  const show = sub.addParser("show", SHOW_DESCRIPTION);
  addDbArgument(show);
  show.addArgument({
    optionStrings: ["--run-id"],
    dest: "run_id",
    required: true,
    metavar: "RUN_ID",
    help: SHOW_RUN_ID_HELP,
  });
  addJsonArgument(show);
  show.setDefaults({ func: cmdRunShow });
}
