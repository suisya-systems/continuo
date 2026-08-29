/**
 * `continuo db create` / `continuo db migrate` / `continuo db verify`.
 *
 * Mounted into the unified CLI by `src/cli.ts`, which owns no flag of its own
 * here: the subtree's module declares its parser, exactly as
 * `measurement/cli.ts`, `settings/cli.ts` and `attention/cli.ts` do (`D-0030`).
 *
 * **Why this module exists at all.** `createProductionControlPlane`,
 * `migrateControlPlane` and `verifyProductionDatabase` have been in
 * `migrator.ts` since the port landed, and outside the barrel the only importers
 * were the measurement harness's two read-only modules. The shipped binary
 * therefore had no verb that brings a control plane into existence, so an
 * operator holding the package could not produce the file every other command
 * writes into (`docs/design/minimal-operating-loop.md` sections 4.1 and 6.1).
 *
 * **This layer is deliberately thin, and the thinness is the point.** Every
 * rule about what a production database *is* -- the `application_id` that says
 * whose database it is, the forward-only ledger, the checksum verification, the
 * refusal to downgrade -- lives in `migrator.ts` and is stated there once. A
 * second statement of any of it here would be a second answer to "is this
 * database usable", and two answers eventually disagree about one file. So each
 * verb resolves its arguments, calls exactly one migrator entry point, reports
 * the version it ended at, and closes the handle.
 *
 * **What each verb means, and where the meaning comes from.**
 *
 * - `create` is `createProductionControlPlane`: it creates and migrates to head,
 *   and it is **not idempotent**. An existing path is refused rather than
 *   adopted, because the migrator claims the path with an exclusive `open(...,
 *   "wx")` precisely so that two processes racing cannot both believe they made
 *   the database.
 * - `migrate` is `migrateControlPlane`: it is the only verb that writes DDL, it
 *   never creates, and it **is** idempotent -- a database already at head has no
 *   pending step, so a second run applies nothing and still exits 0.
 * - `verify` is `openProductionControlPlane`, opened and immediately closed.
 *   Section 6.1 of the design names `verifyProductionDatabase` for this verb,
 *   and that function is one half of the answer: it holds a database to the
 *   production standard but deliberately does **not** ask whether the database
 *   is *behind* this build, because migrating has to skip that question.
 *   `openProductionControlPlane` is that standard plus the at-head check, which
 *   is the question an operator asks before pointing a process at a file --
 *   "will this build's startup accept it" -- and it is the existing behaviour a
 *   verb must not restate in its own terms. So `verify` refuses an absent file,
 *   a file that is not a production database, a file whose ledger disagrees with
 *   this build's steps, and a file that is behind head; and it says which by
 *   passing the migrator's own refusal message through.
 *
 * **A refusal is an operator-facing line, not a stack trace.** Every entry point
 * below raises the `ControlPlaneRefusal` family for the states these verbs exist
 * to report -- the file is absent, the file already exists, the ledger does not
 * verify -- and all three of those are the ordinary outcome of a command an
 * operator typed, not a defect. They are turned into one stderr line and exit 2,
 * the same code `attention scan` uses for an input it was pointed at and cannot
 * use, rather than being allowed to escape as an unhandled error with the
 * carefully written message buried above it.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives: every string
 * here reaches `--help` on a cp932 console, where a character the console cannot
 * encode is a crash rather than a smudge.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  ArgparseExit,
  type ArgumentParser,
  type Namespace,
  type Subparsers,
} from "../cli/parser.js";
import {
  appliedMigrations,
  createProductionControlPlane,
  headVersion,
  migrateControlPlane,
  openProductionControlPlane,
} from "./migrator.js";
import { ControlPlaneRefusal } from "./refusals.js";

// ASCII only: these reach --help on a cp932 console.
const DB_HELP =
  "path to the production control plane database file. The directory it " +
  "lives in must already exist; no verb here creates one.";
const NOW_MS_HELP =
  "the clock, epoch milliseconds, stamped as applied_at_ms on every ledger " +
  "row this run writes. Read once from the system clock when omitted; nothing " +
  "below this command reads a clock.";

const CREATE_DESCRIPTION =
  "Create a new production control plane at --db and migrate it to head. " +
  "Refuses an existing path rather than adopting it: use 'db migrate' to " +
  "bring an existing database forward.";
const MIGRATE_DESCRIPTION =
  "Apply this build's pending migration steps to the database at --db. " +
  "Forward-only, one step per transaction, and never creates. Applying " +
  "nothing to a database already at head is success, so this is safe to " +
  "re-run.";
const VERIFY_DESCRIPTION =
  "Check that the database at --db is a production control plane this build " +
  "can open: integrity, application_id, ledger checksums, and at head. " +
  "Writes nothing and migrates nothing; exits 2 with the reason when it " +
  "refuses.";

/**
 * The two effects this module has on the world, as a replaceable record.
 *
 * The same shape and the same reason as `measurement/cli.ts`'s record: ESM
 * bindings cannot be rebound from outside the module that holds them, so the
 * clock and the two streams are reached through this record and the cases
 * replace the entry (`docs/test-translation-conventions.md` rule 5). `write`
 * and `writeError` are both here because a refused verb writes to stderr and a
 * successful one to stdout, and a test that read only one of them could not
 * tell "refused with a reason" from "printed nothing".
 *
 * Not re-exported from `src/index.ts`: a seam for the tests that own this
 * module, not public API.
 */
export const dbCliSeams = {
  /** The only clock read by these verbs, in epoch milliseconds. */
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
 * that is a process boundary. Only the `ControlPlaneRefusal` family is caught: a
 * `TypeError` from a clock that is not an integer, or an errno error from a
 * directory that does not exist, is a defect or an environment fault rather than
 * a state these verbs exist to report, and burying it under a one-line "error:"
 * would cost the stack that diagnoses it.
 */
function refuse(error: ControlPlaneRefusal): never {
  dbCliSeams.writeError(`error: ${error.message}\n`);
  throw new ArgparseExit(2, "refused control plane database");
}

/** Run `action`, reporting a `ControlPlaneRefusal` as one stderr line and exit 2. */
function reportingRefusals(action: () => number): number {
  try {
    return action();
  } catch (error) {
    if (error instanceof ControlPlaneRefusal) {
      refuse(error);
    }
    throw error;
  }
}

/**
 * The one line each verb prints, read off the ledger rather than assumed.
 *
 * The version is `appliedMigrations`'s last row, which is the authority the
 * schema document names (`user_version` is the cheap check, and the migrator has
 * already refused a database where the two disagree). Printing it rather than
 * "ok" is what makes the output useful to the operator's next decision: `create`
 * and a `migrate` that applied nothing are indistinguishable from their exit
 * codes, and the version is what tells them apart.
 */
function reportVersion(verb: string, path: string, connection: SqliteDatabase): void {
  const applied = appliedMigrations(connection);
  const last = applied[applied.length - 1];
  const current = last === undefined ? 0 : last.version;
  dbCliSeams.write(`${verb} ${path}: schema version ${current} of ${headVersion()}\n`);
}

/** Close a handle whatever the caller did with it, then hand the result back. */
function closing(connection: SqliteDatabase, use: (open: SqliteDatabase) => void): number {
  try {
    use(connection);
  } finally {
    connection.close();
  }
  return 0;
}

/** `--now-ms` if given, else the one clock read. */
function nowMsOf(args: Namespace): number {
  const supplied = args["now_ms"];
  return typeof supplied === "number" ? supplied : dbCliSeams.nowMs();
}

/** `continuo db create`. */
export function cmdDbCreate(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  return reportingRefusals(() =>
    closing(createProductionControlPlane(path, { nowMs }), (connection) => {
      reportVersion("created", path, connection);
    }),
  );
}

/** `continuo db migrate`. */
export function cmdDbMigrate(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  return reportingRefusals(() =>
    closing(migrateControlPlane(path, { nowMs }), (connection) => {
      reportVersion("migrated", path, connection);
    }),
  );
}

/** `continuo db verify`. */
export function cmdDbVerify(args: Namespace): number {
  const path = String(args["db"]);
  return reportingRefusals(() =>
    closing(openProductionControlPlane(path), (connection) => {
      reportVersion("verified", path, connection);
    }),
  );
}

/** `--db`, which all three verbs require and spell identically. */
function addDbArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--db"],
    dest: "db",
    required: true,
    metavar: "DB",
    help: DB_HELP,
  });
}

/**
 * `--now-ms`, on the two verbs that write.
 *
 * Not on `verify`, because `verify` writes no ledger row and a clock it could
 * not stamp anywhere would be a flag that does nothing -- and a flag that does
 * nothing is one an operator will eventually believe did something.
 */
function addNowMsArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--now-ms"],
    dest: "now_ms",
    type: "int",
    metavar: "NOW_MS",
    help: NOW_MS_HELP,
  });
}

/** `add_subparsers`: mount `create`, `migrate` and `verify` under `db`. */
export function addSubparsers(sub: Subparsers): void {
  const create = sub.addParser("create", CREATE_DESCRIPTION);
  addDbArgument(create);
  addNowMsArgument(create);
  create.setDefaults({ func: cmdDbCreate });

  const migrate = sub.addParser("migrate", MIGRATE_DESCRIPTION);
  addDbArgument(migrate);
  addNowMsArgument(migrate);
  migrate.setDefaults({ func: cmdDbMigrate });

  const verify = sub.addParser("verify", VERIFY_DESCRIPTION);
  addDbArgument(verify);
  verify.setDefaults({ func: cmdDbVerify });
}
