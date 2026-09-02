/**
 * `continuo run admit`.
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
 * `db verify` and `attention scan` use. `RunAdmissionUsageError` is deliberately
 * *not* caught: it is a defect in a caller, and it is not reachable from here at
 * all, because the parser has already established that `--run-id` is a string
 * and `--now-ms` an int.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives: every string
 * here reaches `--help` on a cp932 console, where a character the console cannot
 * encode is a crash rather than a smudge.
 */

import type { Namespace, Subparsers } from "../cli/parser.js";
import { ArgparseExit, type ArgumentParser } from "../cli/parser.js";
import { openProductionControlPlane } from "./migrator.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { admitRun } from "./run_admission.js";

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
  "updated_at_ms and as the run_created event's timestamps. Read once from " +
  "the system clock when omitted; nothing below this command reads a clock.";

const ADMIT_DESCRIPTION =
  "Admit a run: insert its row at status 'created' and append the " +
  "run_created event that records it, in one transaction. Refuses a run-id " +
  "already on the table rather than re-admitting it, and exits 2 with the " +
  "reason when it refuses.";

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
 * Report a control-plane refusal on stderr and stop, rather than letting it
 * escape.
 *
 * `ArgparseExit` rather than `process.exit`, because `src/cli.ts`'s `main`
 * already catches it and turns it into the process's status -- the one place
 * that is a process boundary.
 */
function refuse(error: ControlPlaneRefusal): never {
  runCliSeams.writeError(`error: ${error.message}\n`);
  throw new ArgparseExit(2, "refused run admission");
}

/** `--now-ms` if given, else the one clock read. */
function nowMsOf(args: Namespace): number {
  const supplied = args["now_ms"];
  return typeof supplied === "number" ? supplied : runCliSeams.nowMs();
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
  const runId = String(args["run_id"]);
  const nowMs = nowMsOf(args);

  try {
    const connection = openProductionControlPlane(path);
    try {
      const admitted = admitRun(connection, { runId, nowMs });
      runCliSeams.write(
        `admitted ${admitted.runId} in ${path}: status ${admitted.status}, ` +
          `${admitted.eventId} at seq ${admitted.eventSeq}\n`,
      );
    } finally {
      connection.close();
    }
  } catch (error) {
    if (error instanceof ControlPlaneRefusal) {
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
  admit.addArgument({
    optionStrings: ["--now-ms"],
    dest: "now_ms",
    type: "int",
    metavar: "NOW_MS",
    help: NOW_MS_HELP,
  });
  admit.setDefaults({ func: cmdRunAdmit });
}
