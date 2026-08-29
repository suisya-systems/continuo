/**
 * `continuo db create` / `migrate` / `verify` -- the mount, and what each verb
 * means.
 *
 * **Target-only.** There is no interlock source for these cases: interlock
 * mounts no `db` subtree, and the gap this closes is continuo's own
 * (`docs/design/minimal-operating-loop.md` sections 4.1 and 6.1). So they are
 * written against the property rather than translated, and rule 10 of
 * `docs/test-translation-conventions.md` applies -- each one names what would be
 * silently wrong without it.
 *
 * Every case drives the **mounted** command through `src/cli.ts`'s `main`, not a
 * hand-built namespace, because half of what is being tested is the mount: a
 * verb whose parser is correct and which `src/cli.ts` never hangs off its
 * subcommand table is exactly the state this task exists to fix, and a test that
 * called the handler directly would stay green through it.
 *
 * The three verbs are thin over `migrator.ts`, so these cases deliberately do
 * **not** re-test the migrator's rules -- `migrator.test.ts` owns those. What is
 * asserted here is the layer this module adds: which migrator entry point each
 * verb reaches, that a refusal arrives as one operator-facing line and exit 2
 * rather than as a stack trace, that the clock is read once, and that `verify`
 * leaves the file it inspected untouched.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { helpStrings } from "../../src/cli/parser.js";
import { buildParser, main, cliSeams as topLevelSeams } from "../../src/cli.js";
import { dbCliSeams } from "../../src/control_plane/cli.js";
import {
  createProductionControlPlane,
  headVersion,
  MIGRATIONS_DIR,
} from "../../src/control_plane/migrator.js";
import { createControlPlane } from "../../src/control_plane/schema.js";
import {
  bytesOf,
  caseRoot,
  databasePath,
  ledgerRows,
  sidecars,
  versionOf,
  writeStep,
} from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant, and two later ones. */
const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;

/** This build's head, read rather than written down: a fourth step must not fail these. */
const HEAD = headVersion();

/** What one verb wrote to each stream. */
interface Streams {
  out(): string;
  err(): string;
}

/**
 * Capture both of the module's streams for the running test.
 *
 * Both, always. A refusal case that only read stdout would pass against a
 * command that printed nothing and exited 2 for the wrong reason, and a success
 * case that only read stdout would not notice a warning on stderr.
 */
function captureStreams(): Streams {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  patchSeam(dbCliSeams, "write", (text: string) => {
    outChunks.push(text);
  });
  patchSeam(dbCliSeams, "writeError", (text: string) => {
    errChunks.push(text);
  });
  return {
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

/** Freeze the clock and count the reads, so "read once" is a number and not a hope. */
function countedClock(instant: number): { reads: () => number } {
  let reads = 0;
  patchSeam(dbCliSeams, "nowMs", () => {
    reads += 1;
    return instant;
  });
  return { reads: () => reads };
}

/**
 * A production database holding only the first `count` of this build's steps.
 *
 * Built by pointing the migrator at a directory holding **byte-identical copies**
 * of the real step files, so the ledger's checksums are the ones this build
 * computes -- a hand-written stand-in would be refused as an edited step rather
 * than accepted as a database that is merely behind, and the case would then be
 * green for the wrong refusal.
 */
function databaseBehindHead(root: string, count: number): string {
  const prefix = join(root, `at-000${count}`);
  const names = ["0001_initial.sql", "0002_policy_seed.sql", "0003_outbox_cancelled_status.sql"];
  for (const name of names.slice(0, count)) {
    writeStep(prefix, name, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  const path = databasePath(root);
  createProductionControlPlane(path, { nowMs: T0, migrationsDir: prefix }).close();
  return path;
}

// --------------------------------------------------------------------------
// db create
// --------------------------------------------------------------------------

describe("db create", () => {
  test("creates a production control plane at head and reports the version", () => {
    const path = databasePath(caseRoot("db-create"));
    const streams = captureStreams();

    const code = main(["db", "create", "--db", path, "--now-ms", String(T0)]);

    expect(code).toBe(0);
    expect(streams.err()).toBe("");
    expect(streams.out()).toBe(`created ${path}: schema version ${HEAD} of ${HEAD}\n`);
    // The claim in the printed line is checked against the file, not against the
    // command's own belief about it.
    expect(versionOf(path)).toEqual([HEAD, HEAD]);
  });

  test("stamps --now-ms on every ledger row it writes", () => {
    // The clock is the caller's (`docs/time-base-policy.md` section 2 rule 2).
    // A verb that passed `Date.now()` down regardless would still exit 0 and
    // still print the right version; the ledger is the only place it shows.
    const path = databasePath(caseRoot("db-create"));
    captureStreams();

    expect(main(["db", "create", "--db", path, "--now-ms", String(T0)])).toBe(0);

    const rows = ledgerRows(path);
    expect(rows.length).toBe(HEAD);
    for (const row of rows) {
      expect(row["applied_at_ms"]).toBe(T0);
    }
  });

  test("reads the clock exactly once without --now-ms, and not at all with it", () => {
    // Two reads would put two instants in one ledger, and every row would still
    // look plausible. Only the count catches it.
    const withoutFlag = databasePath(caseRoot("db-create"));
    captureStreams();
    const clock = countedClock(T1);

    expect(main(["db", "create", "--db", withoutFlag])).toBe(0);
    expect(clock.reads()).toBe(1);
    for (const row of ledgerRows(withoutFlag)) {
      expect(row["applied_at_ms"]).toBe(T1);
    }

    const withFlag = databasePath(caseRoot("db-create-flag"));
    expect(main(["db", "create", "--db", withFlag, "--now-ms", String(T0)])).toBe(0);
    expect(clock.reads()).toBe(1);
  });

  test("refuses an existing path with one line on stderr, leaving it byte for byte", () => {
    // Not idempotent, on purpose: the migrator claims the path exclusively so
    // that two processes racing cannot both believe they made the database. The
    // byte comparison is what says the refusal happened *before* anything was
    // written -- an exit code alone cannot tell a clean refusal from one that
    // truncated the file on its way out.
    const root = caseRoot("db-create");
    const path = databasePath(root);
    writeFileSync(path, "not a database at all\n", "utf8");
    const before = bytesOf(path);
    const streams = captureStreams();

    const code = main(["db", "create", "--db", path, "--now-ms", String(T0)]);

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    expect(streams.err()).toMatch(/^error: /);
    expect(streams.err()).toContain("already exists");
    expect(streams.err().endsWith("\n")).toBe(true);
    expect(bytesOf(path)).toEqual(before);
    expect(sidecars(path)).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// db migrate
// --------------------------------------------------------------------------

describe("db migrate", () => {
  test("brings a database behind this build forward to head", () => {
    const root = caseRoot("db-migrate");
    const path = databaseBehindHead(root, HEAD - 1);
    const streams = captureStreams();

    const code = main(["db", "migrate", "--db", path, "--now-ms", String(T1)]);

    expect(code).toBe(0);
    expect(streams.err()).toBe("");
    expect(streams.out()).toBe(`migrated ${path}: schema version ${HEAD} of ${HEAD}\n`);
    expect(versionOf(path)).toEqual([HEAD, HEAD]);
    // The steps that were already applied keep their original stamp; only the
    // ones this run applied carry the new one. A verb that re-applied the whole
    // ledger would still end at head and would still print this line.
    const rows = ledgerRows(path);
    expect(rows.slice(0, HEAD - 1).map((row) => row["applied_at_ms"])).toEqual(
      Array(HEAD - 1).fill(T0),
    );
    expect(rows[HEAD - 1]?.["applied_at_ms"]).toBe(T1);
  });

  test("applies nothing to a database already at head and still succeeds", () => {
    // The idempotency the verb promises in its help. Asserted on the ledger
    // rather than on the exit code, because "wrote a duplicate row and exited 0"
    // and "wrote nothing and exited 0" are the same exit code.
    const root = caseRoot("db-migrate");
    const path = databasePath(root);
    createProductionControlPlane(path, { nowMs: T0 }).close();
    const before = ledgerRows(path);
    const streams = captureStreams();

    const code = main(["db", "migrate", "--db", path, "--now-ms", String(T1)]);

    expect(code).toBe(0);
    expect(streams.err()).toBe("");
    expect(streams.out()).toBe(`migrated ${path}: schema version ${HEAD} of ${HEAD}\n`);
    expect(ledgerRows(path)).toEqual(before);
  });

  test("refuses a path that does not exist rather than creating one", () => {
    // Migrating never creates. Without the existence assertion this case would
    // pass against a verb that created the database and then failed to migrate
    // it, which is the state that leaves a half-made file behind.
    const path = databasePath(caseRoot("db-migrate"));
    const streams = captureStreams();

    const code = main(["db", "migrate", "--db", path, "--now-ms", String(T0)]);

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    expect(streams.err()).toMatch(/^error: /);
    expect(streams.err()).toContain("does not exist");
    expect(existsSync(path)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// db verify
// --------------------------------------------------------------------------

describe("db verify", () => {
  test("accepts a database at head and writes nothing to it", () => {
    // "Writes nothing" is the half that is easy to lose: the verb opens a
    // writable handle (that is what `openProductionControlPlane` returns), so
    // only the bytes and the absence of a journal sidecar say it did not use it.
    const root = caseRoot("db-verify");
    const path = databasePath(root);
    createProductionControlPlane(path, { nowMs: T0 }).close();
    const before = bytesOf(path);
    const streams = captureStreams();

    const code = main(["db", "verify", "--db", path]);

    expect(code).toBe(0);
    expect(streams.err()).toBe("");
    expect(streams.out()).toBe(`verified ${path}: schema version ${HEAD} of ${HEAD}\n`);
    expect(bytesOf(path)).toEqual(before);
    expect(sidecars(path)).toEqual([]);
  });

  test("refuses a database behind this build rather than migrating it", () => {
    // This is the case that pins the contract choice: `verifyProductionDatabase`
    // alone would ACCEPT this database, because it deliberately does not ask
    // whether the file is behind. `verify` is the question an operator asks
    // before pointing a process at a file, so it is `openProductionControlPlane`
    // -- the same standard plus the at-head check -- and a database this build
    // cannot open is one `verify` must refuse.
    const root = caseRoot("db-verify");
    const path = databaseBehindHead(root, HEAD - 1);
    const before = bytesOf(path);
    const streams = captureStreams();

    const code = main(["db", "verify", "--db", path]);

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    expect(streams.err()).toContain(`is at version ${HEAD - 1}`);
    expect(streams.err()).toContain("opening never migrates");
    // Refusing is not migrating: the file is exactly as it was found.
    expect(bytesOf(path)).toEqual(before);
    expect(versionOf(path)).toEqual([HEAD - 1, HEAD - 1]);
  });

  test("refuses a database that is not there", () => {
    const path = databasePath(caseRoot("db-verify"));
    const streams = captureStreams();

    const code = main(["db", "verify", "--db", path]);

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    expect(streams.err()).toContain("does not exist");
    expect(existsSync(path)).toBe(false);
  });

  test("refuses a spike database, naming it as one", () => {
    // The refusal the distinct `application_id` exists to make possible. A
    // `verify` that reported "no such tables, needs migrating" would send an
    // operator to `db migrate`, and there is no migration from the spike schema
    // and none will be written.
    const root = caseRoot("db-verify");
    const path = join(root, "spike.sqlite3");
    createControlPlane(path).close();
    const streams = captureStreams();

    const code = main(["db", "verify", "--db", path]);

    expect(code).toBe(2);
    expect(streams.err()).toContain("spike database");
  });
});

// --------------------------------------------------------------------------
// the mount itself
// --------------------------------------------------------------------------

describe("the mount", () => {
  test("all three verbs are reachable from the top-level parser", () => {
    // The whole point of the task. `src/cli.ts` could hold a correct parser for
    // a subtree it never mounts, and every case above would still be green if
    // they called the handlers directly -- they do not, and this states why.
    const reachable = helpStrings(buildParser());

    expect(reachable.some((text) => text.startsWith("Create a new production control plane"))).toBe(
      true,
    );
    expect(reachable.some((text) => text.startsWith("Apply this build's pending migration"))).toBe(
      true,
    );
    expect(reachable.some((text) => text.startsWith("Check that the database at --db"))).toBe(true);
  });

  test("every help string the db subtree contributes is ASCII", () => {
    // `docs/cli-output-policy.md`: a single em dash here crashes `--help` on a
    // cp932 console, and an in-process capture cannot see it. The contract test
    // scans the source file; this scans the strings the parser actually holds,
    // which is what reaches the console.
    for (const text of helpStrings(buildParser())) {
      if (text.includes("control plane database") || text.includes("migration step")) {
        expect(isAscii(text), text).toBe(true);
      }
    }
  });

  test("--help after a db verb is that verb's help", () => {
    // A parser that scanned the whole argv for `--help` would answer this with
    // the top-level screen -- the one screen that does not list `--now-ms` --
    // and would exit 0 either way.
    const chunks: string[] = [];
    patchSeam(topLevelSeams, "out", (text: string) => {
      chunks.push(text);
    });

    const code = main(["db", "create", "--help"]);

    expect(code).toBe(0);
    const help = chunks.join("");
    expect(help).toContain("usage: continuo db create");
    expect(help).toContain("--now-ms");
  });

  test("a db verb given no --db is refused by the parser, not by the migrator", () => {
    // `--db` is `required`, so the refusal is argparse's exit 2 with a usage
    // line. Without it the command would reach the migrator with the string
    // "undefined" as a path and refuse there, naming a file nobody typed.
    const errors: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      errors.push(text);
    });

    expect(main(["db", "verify"])).toBe(2);
    expect(errors.join("")).toContain("--db");
  });
});

/** Every codepoint in `text` is printable ASCII, tab or newline. */
function isAscii(text: string): boolean {
  return [...text].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e);
  });
}
