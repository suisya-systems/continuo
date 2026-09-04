/**
 * `continuo run admit` and `continuo run close`.
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

import type { Namespace, Subparsers } from "../cli/parser.js";
import { ArgparseExit, type ArgumentParser } from "../cli/parser.js";
import { LapRunIntent } from "./lap_run_intent.js";
import { LeaseRefusal } from "./lease.js";
import { openProductionControlPlane } from "./migrator.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { admitRun } from "./run_admission.js";
import { closeRun, RUN_CLOSE_OUTCOMES } from "./run_close.js";
import { type RunStatus, RunTransitionRefused, UnknownRunRefused } from "./run_lifecycle.js";

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

const CLOSE_DESCRIPTION =
  "Close a run: record the operator's close by advancing the run from its " +
  "current status to the terminal status given by --outcome, as the single " +
  "fenced writer of run.status. It records step 11 rather than performing it " +
  "-- push, PR and merge stay manual -- and it appends no event and reads no " +
  "gate (D-0084). Refuses a run that is absent or already closed, and exits 2 " +
  "with the reason.";

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
 */
function refuse(error: Error): never {
  runCliSeams.writeError(`error: ${error.message}\n`);
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

  try {
    const connection = openProductionControlPlane(path);
    try {
      const admitted = admitRun(connection, { intent, nowMs });
      // Both events, named and numbered. The line is what an operator has to
      // read to know the work statement landed with the run rather than after
      // it -- reporting only the first would make the transaction's whole point
      // invisible at the surface that performs it.
      runCliSeams.write(
        `admitted ${admitted.runId} in ${path}: status ${admitted.status}, ` +
          `${admitted.eventId} at seq ${admitted.eventSeq}, ` +
          `${admitted.delegationEventId} at seq ${admitted.delegationEventSeq}\n`,
      );
    } finally {
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
      runCliSeams.write(
        `closed ${closed.runId} in ${path}: status ${closed.from} -> ${closed.to} ` +
          `by ${closed.actorId} under writer epoch ${closed.writerEpoch}\n`,
      );
    } finally {
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

/** `add_subparsers`: mount `admit` under `run`. */
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
  close.setDefaults({ func: cmdRunClose });
}
