/**
 * `D-1105`: the delegation record, written in the transaction that admits the
 * run, stored opaquely, and never interpreted.
 *
 * Three claims carry the decision, and each has cases here that go RED when the
 * claim is removed rather than when something near it moves:
 *
 * 1. **One transaction.** There is no path that produces a run without its
 *    record, and none that produces a record without its run.
 * 2. **Not interpreted.** Nothing in the control plane branches on what is
 *    inside the envelope. The bytes stored are the bytes handed in.
 * 3. **Immutable.** The row cannot be updated or deleted, and a stored record
 *    that no longer hashes to its digest is refused on the way back out.
 *
 * A target-only file: interlock has no delegation record, so there is no source
 * test any of this is ported from.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  CANONICALIZATION,
  DelegationRecord,
  DelegationRecordUsageError,
  DIGEST_ALGORITHM,
  MAX_ENVELOPE_LENGTH,
} from "../../src/control_plane/delegation_record.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import {
  createProductionControlPlane,
  MIGRATIONS_DIR,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import {
  admitRun,
  DelegationRecordTampered,
  DelegationRecordUnrecorded,
  RunAdmissionUsageError,
  readDelegationRecord,
  readLapRunIntent,
} from "../../src/control_plane/run_admission.js";
import { transaction } from "../../src/control_plane/txn.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { aDelegationRecord } from "../testkit/delegation.js";
import { expectRefusal } from "../testkit/errors.js";

/** One fixed clock, so no case depends on the order two reads happened in. */
const T0 = 1_700_000_000_000;

/** The absolute workspace path the fixtures record, on whichever platform. */
const WORKSPACE = resolve("wt", "run-1");

const productionTemplate = suiteTemplate("delegation-record.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A migrated production control plane at head, with no rows of its own. */
function cpFixture(label: string): { connection: SqliteDatabase; path: string } {
  const path = productionTemplate.copyInto(caseRoot(label));
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  return { connection, path };
}

function intent(runId = "run-1"): LapRunIntent {
  return new LapRunIntent({
    runId,
    leaseClaimantId: "secretary-1",
    workspace: WORKSPACE,
    role: "worker",
    baseBranch: "main",
    topicBranch: "feat/run-1",
    prompt: "port the thing",
  });
}

/** Every `.ts` file under `root`, recursively, in a stable order. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

function rows(connection: SqliteDatabase, table: string): Record<string, unknown>[] {
  return connection.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

// --------------------------------------------------------------------------
// claim 1 -- one transaction
// --------------------------------------------------------------------------

describe("the run and its delegation record commit together or not at all", () => {
  test("admission writes both, and the record is about the run it was admitted with", () => {
    const { connection } = cpFixture("both");

    const admitted = admitRun(connection, {
      intent: intent(),
      delegationRecord: aDelegationRecord(),
      nowMs: T0,
    });

    expect(rows(connection, "run").map((row) => row["run_id"])).toEqual(["run-1"]);
    const stored = rows(connection, "delegation_record");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.["run_id"]).toBe("run-1");
    expect(stored[0]?.["recorded_at_ms"]).toBe(T0);
    expect(admitted.delegationRecordDigest).toBe(stored[0]?.["envelope_digest"]);
  });

  test("an outer transaction that fails afterwards leaves neither", () => {
    // The case that distinguishes one transaction from two that both happened
    // to succeed. `txn.ts` JOINS an inner block to an outer one rather than
    // nesting it, so an outer failure must take the run row AND its record down
    // together. If the record insert committed on its own, the row below would
    // survive the throw with no run to belong to -- and if the run committed on
    // its own, a run would survive with nothing saying what it may do.
    const { connection } = cpFixture("outer-throw");

    expect(() => {
      transaction(connection, (tx) => {
        admitRun(tx, { intent: intent(), delegationRecord: aDelegationRecord(), nowMs: T0 });
        throw new Error("the caller abandoned the transaction");
      });
    }).toThrow("the caller abandoned the transaction");

    expect(rows(connection, "run")).toEqual([]);
    expect(rows(connection, "delegation_record")).toEqual([]);
  });

  test("a record insert that fails inside admitRun leaves no run row", () => {
    // The case the falsification bullet needs and did not have. The two cases
    // above pin the transaction BOUNDARY -- an outer throw, and a hand-rolled
    // pair of statements -- but neither drives `admitRun` itself into a failure
    // after it has written the run row. Without this, moving the record INSERT
    // out of the block so it runs after the commit leaves the whole suite
    // green, which was measured during review of this change.
    //
    // The failure is provoked by a trigger installed on the fixture rather than
    // by a mock, so what fails is the real statement inside the real block.
    const { connection } = cpFixture("insert-fails-inside");
    connection
      .prepare(
        `CREATE TRIGGER test_refuse_delegation_record
         BEFORE INSERT ON delegation_record
         BEGIN SELECT RAISE(ABORT, 'the test refused this record'); END`,
      )
      .run();

    expect(() =>
      admitRun(connection, { intent: intent(), delegationRecord: aDelegationRecord(), nowMs: T0 }),
    ).toThrow(/the test refused this record/);

    expect(rows(connection, "run")).toEqual([]);
    expect(rows(connection, "event")).toEqual([]);
    expect(rows(connection, "delegation_record")).toEqual([]);
  });

  test("the run row cannot outlive its record", () => {
    // The other direction of the reference, and the one an ordering mistake
    // would hide. A run whose record could be removed from under it is a run
    // that can end up admitted with nothing saying what it may do -- the exact
    // state `D-1105` closes, reached by deletion instead of by a missing write.
    // The record's own trigger refuses a DELETE of the record, and the foreign
    // key refuses a DELETE of the run while the record points at it, so neither
    // half can be removed alone.
    const { connection } = cpFixture("no-orphaned-run");
    admitRun(connection, { intent: intent(), delegationRecord: aDelegationRecord(), nowMs: T0 });

    expect(() => connection.prepare("DELETE FROM run WHERE run_id = 'run-1'").run()).toThrow(
      /FOREIGN KEY/i,
    );
    expect(rows(connection, "run")).toHaveLength(1);
    expect(rows(connection, "delegation_record")).toHaveLength(1);
  });

  test("a failure writing the record rolls the run row back", () => {
    // Admission's block, reproduced statement by statement with the record
    // insert made to fail on a CHECK. `admitRun` itself cannot be driven into
    // this state -- `DelegationRecord`'s constructor is the validation and there
    // is no route to an invalid one -- so what this pins is the boundary rather
    // than the validation: the run row and the record insert are inside one
    // transaction, and a failure at the second undoes the first.
    const { connection } = cpFixture("record-insert-fails");

    expect(() =>
      transaction(connection, (tx) => {
        tx.prepare(
          `INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)
           VALUES ('run-1', 'created', :now, :now)`,
        ).run({ now: T0 });
        tx.prepare(
          `INSERT INTO delegation_record (
             run_id, record_schema, envelope, envelope_digest,
             digest_algorithm, canonicalization, recorded_at_ms
           ) VALUES ('run-1', 's/1', '{}', 'not-a-digest', 'sha256', 'verbatim-utf8', :now)`,
        ).run({ now: T0 });
      }),
    ).toThrow(/CHECK constraint failed/i);

    expect(rows(connection, "run")).toEqual([]);
    expect(rows(connection, "delegation_record")).toEqual([]);
  });

  test("a delegation record for a run that does not exist is unrepresentable", () => {
    // The foreign key, exercised directly. This is what makes the INSERT order
    // inside admission a property of the schema rather than a thing the code
    // remembers to do in the right order.
    const { connection } = cpFixture("orphan");

    expect(() =>
      connection
        .prepare(
          `INSERT INTO delegation_record (
             run_id, record_schema, envelope, envelope_digest,
             digest_algorithm, canonicalization, recorded_at_ms
           ) VALUES ('never-admitted', 's/1', '{}', :digest, 'sha256', 'verbatim-utf8', :now)`,
        )
        .run({ digest: createHash("sha256").update("{}").digest("hex"), now: T0 }),
    ).toThrow(/FOREIGN KEY/i);
  });

  test("admission refuses without a record, before anything is opened or written", () => {
    // The parameter has no absent case. Without this the type would be the only
    // thing holding the property, and a caller reaching the function from
    // JavaScript -- which every consumer of the published package can -- would
    // admit a run with no record at all.
    const { connection } = cpFixture("no-record");

    expectRefusal(
      () =>
        (
          admitRun as unknown as (
            connection: SqliteDatabase,
            options: { intent: LapRunIntent; nowMs: number },
          ) => unknown
        )(connection, { intent: intent(), nowMs: T0 }),
      RunAdmissionUsageError,
      /delegation_record must be a DelegationRecord/,
    );

    expect(rows(connection, "run")).toEqual([]);
    expect(rows(connection, "delegation_record")).toEqual([]);
  });

  test("an object that merely looks like a record is refused", () => {
    // The nominal type, which is what makes "every record that reached the
    // table was validated" a property rather than a convention.
    const { connection } = cpFixture("forged");

    expectRefusal(
      () =>
        admitRun(connection, {
          intent: intent(),
          delegationRecord: {
            recordSchema: "forged/1",
            envelope: "{}",
            envelopeDigest: "0".repeat(64),
            digestAlgorithm: "sha256",
            canonicalization: "verbatim-utf8",
          } as unknown as DelegationRecord,
          nowMs: T0,
        }),
      RunAdmissionUsageError,
      /delegation_record must be a DelegationRecord/,
    );
    expect(rows(connection, "run")).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// claim 2 -- the envelope is not interpreted
// --------------------------------------------------------------------------

describe("continuo stores the envelope and does not read it", () => {
  test("the stored bytes are the bytes handed in, verbatim", () => {
    // Key order, spacing and escaping are all preserved: nothing re-serialises
    // the document. This is the case that goes red the moment somebody parses
    // the envelope and writes the parse back, which would make the stored
    // record depend on this build's JSON writer rather than on the producer's.
    const envelope = '{"z":1,\n  "a"  :  [3,2,1], "u":"\\u00e9 caf\\u00e9"}';
    const { connection } = cpFixture("verbatim");

    admitRun(connection, {
      intent: intent(),
      delegationRecord: new DelegationRecord({ recordSchema: "any.format/7", envelope }),
      nowMs: T0,
    });

    expect(rows(connection, "delegation_record")[0]?.["envelope"]).toBe(envelope);
    expect(readDelegationRecord(connection, "run-1").envelope).toBe(envelope);
  });

  test("the digest is sha256 over exactly those bytes, and is recorded as such", () => {
    const envelope = '{"anything": "at all"}';
    const record = new DelegationRecord({ recordSchema: "any.format/7", envelope });

    expect(record.envelopeDigest).toBe(
      createHash("sha256").update(Buffer.from(envelope, "utf-8")).digest("hex"),
    );
    expect(record.digestAlgorithm).toBe(DIGEST_ALGORITHM);
    expect(record.canonicalization).toBe(CANONICALIZATION);
  });

  test("admission behaves identically whatever the envelope says", () => {
    // The claim stated as an experiment rather than as an assertion about the
    // source. Four envelopes that a control plane WOULD branch on if it read
    // them -- one denying everything, one granting everything, one naming
    // continuo's own vocabulary, one contradicting itself -- produce the same
    // observable admission in every respect except the bytes and their digest.
    const envelopes = [
      '{"granted": [], "askable": [], "refused": "everything"}',
      '{"granted": ["*"], "unattended": true}',
      '{"role": "no-such-role", "cli_args": ["--dangerously-skip-permissions"]}',
      '{"granted": ["a"], "askable": ["a"], "expired_at_ms": 1}',
    ];

    const observed = envelopes.map((envelope, index) => {
      const runId = `run-${index}`;
      const { connection } = cpFixture(`opaque-${index}`);
      const admitted = admitRun(connection, {
        intent: intent(runId),
        delegationRecord: new DelegationRecord({ recordSchema: "any.format/7", envelope }),
        nowMs: T0,
      });
      const run = rows(connection, "run")[0] ?? {};
      const record = rows(connection, "delegation_record")[0] ?? {};
      return {
        status: admitted.status,
        createdAtMs: admitted.createdAtMs,
        eventSeq: admitted.eventSeq,
        delegationEventSeq: admitted.delegationEventSeq,
        runStatus: run["status"],
        recordSchema: record["record_schema"],
        digestAlgorithm: record["digest_algorithm"],
        canonicalization: record["canonicalization"],
        recordedAtMs: record["recorded_at_ms"],
        // The one thing that legitimately differs, kept in the comparison so
        // the case cannot pass by observing nothing at all.
        storedEnvelope: record["envelope"],
      };
    });

    for (const [index, actual] of observed.entries()) {
      expect(actual).toEqual({
        ...observed[0],
        storedEnvelope: envelopes[index],
      });
    }
  });

  test("nothing in the control plane reads a key out of a delegation envelope", () => {
    // A source scan, in the shape `run-lifecycle.test.ts` scans for raw writes
    // to the run table. The property is about the whole layer rather than about
    // one function, and a case that only exercised `admitRun` would stay green
    // the day a second module started branching on the document.
    //
    // What it looks for: any module under `src/` that both names the envelope
    // and indexes something. `delegation_record.ts` parses for validity and is
    // named as the one place that may -- and even there the parse result is
    // never indexed, which is what the second assertion pins.
    const module = readFileSync(resolve(MIGRATIONS_DIR, "..", "delegation_record.ts"), "utf8");

    // The parsed document is bound once and read for its shape only: no
    // property access, no index, no destructuring of a key.
    expect(module).toMatch(/parsed = JSON\.parse\(envelope\)/);
    expect(module).not.toMatch(/parsed\[/);
    expect(module).not.toMatch(/parsed\.[a-z]/i);
    expect(module).not.toMatch(/hasOwn\(parsed/);
    expect(module).not.toMatch(/\.\.\.parsed/);
    expect(module).not.toMatch(/Object\.keys\(parsed/);

    // And no other module under `src/` parses an envelope at all: the one place
    // the document is decoded is the one place named above. A second decode
    // site is how interpretation arrives -- somebody needs one field, parses it
    // where they need it, and the layering is gone before anybody reviews a
    // decision about it.
    // Keyed on the BINDING rather than on one spelling of the call. The first
    // shape of this scan matched `JSON.parse(<argument spelled 'envelope'>)`,
    // and review defeated it in one line: a module that binds the column to a
    // local and parses the local passes it. So the scan now follows the value
    // -- every identifier bound from an expression naming the envelope is
    // collected, and no module outside `delegation_record.ts` may hand one of
    // them to a decoder.
    //
    // The parse is the right thing to key on, and that is not a shortcut: the
    // envelope is TEXT. There is no way to read a key of it without decoding it
    // first, so a module that never decodes it cannot be interpreting it.
    //
    // Comments are stripped before matching, because "envelope" is an overloaded
    // word here -- `json_output.ts`'s one-line document is called an envelope
    // too, and three modules discuss it in prose while parsing unrelated JSON.
    const readers = sourceFiles(resolve(MIGRATIONS_DIR, "..", "..")).filter((file) => {
      const code = readFileSync(file, "utf8")
        .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
        .replaceAll(/\/\/[^\n]*/g, " ");
      const bound = ["envelope"];
      for (const match of code.matchAll(
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;]*)/g,
      )) {
        const [, name, initializer] = match;
        // `prepare(` is skipped: a SELECT naming the column is a string that
        // mentions the envelope, not a value derived from one.
        if (
          name !== undefined &&
          initializer !== undefined &&
          /\benvelope\b/i.test(initializer) &&
          !/\bprepare\(/.test(initializer)
        ) {
          bound.push(name);
        }
      }
      return bound.some((name) => new RegExp(`JSON\\.parse\\(\\s*${name}\\b`).test(code));
    });
    expect(readers.map((file) => basename(file))).toEqual(["delegation_record.ts"]);
  });

  test("a format name this build has never seen is stored, not refused", () => {
    // The version is recorded and never recognised. A control plane that kept a
    // list of the format names it knows would be one with opinions about the
    // contents, arrived at one version string at a time.
    const { connection } = cpFixture("unknown-format");

    admitRun(connection, {
      intent: intent(),
      delegationRecord: new DelegationRecord({
        recordSchema: "some.future.format/9999",
        envelope: "{}",
      }),
      nowMs: T0,
    });

    expect(readDelegationRecord(connection, "run-1").recordSchema).toBe("some.future.format/9999");
  });

  test("the record and the lap intent stay two records", () => {
    // `D-0055`'s payload is not widened by `D-1105`: the intent still reads
    // back through its own reader, unchanged, beside a record that says
    // something else about the same run.
    const { connection } = cpFixture("two-records");

    admitRun(connection, {
      intent: intent(),
      delegationRecord: aDelegationRecord(),
      nowMs: T0,
    });

    expect(readLapRunIntent(connection, "run-1").prompt).toBe("port the thing");
    expect(readDelegationRecord(connection, "run-1").recordSchema).toBe("testkit.delegation/1");
  });
});

// --------------------------------------------------------------------------
// claim 3 -- immutable, and the digest is checked rather than trusted
// --------------------------------------------------------------------------

describe("a written record is never edited", () => {
  test("an UPDATE is refused by the table itself", () => {
    const { connection } = cpFixture("no-update");
    admitRun(connection, { intent: intent(), delegationRecord: aDelegationRecord(), nowMs: T0 });

    expect(() => connection.prepare("UPDATE delegation_record SET envelope = '{}'").run()).toThrow(
      /written once/,
    );
  });

  test("a DELETE is refused by the table itself", () => {
    const { connection } = cpFixture("no-delete");
    admitRun(connection, { intent: intent(), delegationRecord: aDelegationRecord(), nowMs: T0 });

    expect(() => connection.prepare("DELETE FROM delegation_record").run()).toThrow(
      /only account of what a run was permitted to do/,
    );
  });

  test("INSERT OR REPLACE cannot rewrite a record, whatever recursive_triggers says", () => {
    // The route the two triggers above do NOT cover, found by review of this
    // change and repaired the way `src/canary/routing_ledger.sql` repairs it.
    // `INSERT OR REPLACE` resolves a primary-key conflict with an implicit
    // DELETE that fires no BEFORE DELETE trigger unless `recursive_triggers` is
    // ON, and that pragma is per-connection and off by default -- so without a
    // BEFORE INSERT guard one ordinary statement rewrites the envelope, the
    // digest and the timestamp together, and every reader then reports the
    // substituted record as intact because it hashes to its own new digest.
    //
    // The pragma is asserted off first, so the case is testing the trigger and
    // not a connection setting that happens to be closing the hole.
    const { connection } = cpFixture("no-replace");
    admitRun(connection, { intent: intent(), delegationRecord: aDelegationRecord(), nowMs: T0 });
    expect(connection.pragma("recursive_triggers", { simple: true })).toBe(0);

    const forged = '{"granted": ["everything"]}';
    expect(() =>
      connection
        .prepare(
          `INSERT OR REPLACE INTO delegation_record (
             run_id, record_schema, envelope, envelope_digest,
             digest_algorithm, canonicalization, recorded_at_ms
           ) VALUES ('run-1', 's/1', :envelope, :digest, 'sha256', 'verbatim-utf8', :now)`,
        )
        .run({
          envelope: forged,
          digest: createHash("sha256").update(Buffer.from(forged, "utf-8")).digest("hex"),
          now: T0,
        }),
    ).toThrow(/never replaced/);

    expect(readDelegationRecord(connection, "run-1").envelope).not.toBe(forged);
  });

  test("the replace guard defers to the row's own CHECKs rather than masking them", () => {
    // The WHEN clause exists so a row the table would refuse anyway is refused
    // by the constraint that is actually wrong with it. Without it, a malformed
    // replacement of an existing record would report "never replaced" and send
    // an operator looking for the wrong thing.
    const { connection } = cpFixture("replace-defers");
    admitRun(connection, { intent: intent(), delegationRecord: aDelegationRecord(), nowMs: T0 });

    expect(() =>
      connection
        .prepare(
          `INSERT OR REPLACE INTO delegation_record (
             run_id, record_schema, envelope, envelope_digest,
             digest_algorithm, canonicalization, recorded_at_ms
           ) VALUES ('run-1', 's/1', 'not json', :digest, 'sha256', 'verbatim-utf8', :now)`,
        )
        .run({ digest: "0".repeat(64), now: T0 }),
    ).toThrow(/CHECK constraint failed/i);
  });

  test("bytes that no longer hash to the stored digest are refused on the way out", () => {
    // The digest column is checked rather than returned, which is the whole
    // reason to store it. The row is planted with a mismatched digest because
    // the triggers above make an edit through SQLite impossible: what this
    // reproduces is a file altered by something other than this build.
    const { connection } = cpFixture("tampered");
    connection
      .prepare(
        `INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)
         VALUES ('run-1', 'created', :now, :now)`,
      )
      .run({ now: T0 });
    connection
      .prepare(
        `INSERT INTO delegation_record (
           run_id, record_schema, envelope, envelope_digest,
           digest_algorithm, canonicalization, recorded_at_ms
         ) VALUES ('run-1', 's/1', '{"granted": ["everything"]}', :digest, 'sha256',
                   'verbatim-utf8', :now)`,
      )
      .run({ digest: "0".repeat(64), now: T0 });

    expectRefusal(
      () => readDelegationRecord(connection, "run-1"),
      DelegationRecordTampered,
      /hashes to/,
    );
  });

  test("a run admitted before the record existed is named as such, not as unknown", () => {
    // The unrecoverable past, reported rather than papered over. Collapsing this
    // into "no such run" would send an operator looking for a typo when the true
    // answer is that the record was never written.
    const { connection } = cpFixture("pre-record");
    connection
      .prepare(
        `INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)
         VALUES ('legacy-1', 'created', :now, :now)`,
      )
      .run({ now: T0 });

    expectRefusal(
      () => readDelegationRecord(connection, "legacy-1"),
      DelegationRecordUnrecorded,
      /carries no delegation record/,
    );
  });

  test("a malformed run identifier is a caller defect, not an operator's answer", () => {
    const { connection } = cpFixture("bad-run-id");

    expectRefusal(
      () => readDelegationRecord(connection, ""),
      RunAdmissionUsageError,
      /run_id must be a non-empty string/,
    );
  });
});

// --------------------------------------------------------------------------
// the record's own field rules
// --------------------------------------------------------------------------

describe("the record checks form and nothing else", () => {
  test("an envelope that is not JSON is refused with the decoder's complaint", () => {
    expectRefusal(
      () => new DelegationRecord({ recordSchema: "s/1", envelope: "{not json" }),
      DelegationRecordUsageError,
      /must be a JSON document/,
    );
  });

  test("an envelope that is not an object is refused", () => {
    for (const envelope of ["[]", '"a string"', "42", "null"]) {
      expectRefusal(
        () => new DelegationRecord({ recordSchema: "s/1", envelope }),
        DelegationRecordUsageError,
        /must be a JSON object/,
      );
    }
  });

  test("an empty envelope is refused, and an empty JSON object is not", () => {
    expectRefusal(
      () => new DelegationRecord({ recordSchema: "s/1", envelope: "" }),
      DelegationRecordUsageError,
      /must be a non-empty string/,
    );
    expect(new DelegationRecord({ recordSchema: "s/1", envelope: "{}" }).envelope).toBe("{}");
  });

  test("an envelope past the bound is refused, and the message names the bound", () => {
    const oversize = `{"pad": "${"x".repeat(MAX_ENVELOPE_LENGTH)}"}`;
    expectRefusal(
      () => new DelegationRecord({ recordSchema: "s/1", envelope: oversize }),
      DelegationRecordUsageError,
      new RegExp(`the limit is ${MAX_ENVELOPE_LENGTH}`),
    );
  });

  test("a format name that cannot be printed back is refused", () => {
    // The same rule `LapRunIntent` holds `run_id` to, and for the same reason:
    // the value is quoted into a one-line report that ends at a single newline.
    expectRefusal(
      () => new DelegationRecord({ recordSchema: "s/1\nadmitted forged", envelope: "{}" }),
      DelegationRecordUsageError,
      /must be printable ASCII/,
    );
    expectRefusal(
      () => new DelegationRecord({ recordSchema: "  ", envelope: "{}" }),
      DelegationRecordUsageError,
      /must be a non-empty string/,
    );
  });

  test("a record is frozen once constructed", () => {
    const record = aDelegationRecord();
    expect(Object.isFrozen(record)).toBe(true);
  });
});
