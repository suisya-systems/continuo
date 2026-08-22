/**
 * S5 -- the spike SQLite schema slice.
 *
 * Ported from interlock `tests/control_plane/test_spike_schema.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping, and the handful of
 * cases that are adapted rather than translated straight, are recorded in the
 * lane's parity ledger.
 *
 * The tests are the durable half of the spike (D-0026): the schema they
 * exercise may be thrown away, and they are written so that whatever replaces
 * it still has to answer the same questions. Four of the five acceptance
 * criteria of Issue `#12` are properties rather than behaviours -- the marking
 * is in the file, no `Q-0001` or `Q-0002` answer is encoded, state is
 * reconstructable by query alone, corrupt state is refused -- so each is
 * asserted against the artifact itself rather than described in prose.
 *
 * The `describe` blocks are the source file's own comment banners, in the
 * source's order: five criteria, two gate items, and two sections added by its
 * round-1 self-review. A section name is half of a target id, so they are
 * carried across verbatim rather than reworded.
 *
 * Two runtime differences run through the whole file and are noted once here
 * rather than at every call site:
 *
 * - **`cp.commit()` has no translation.** better-sqlite3 runs in autocommit,
 *   so a statement is durable when it returns. The source's explicit commits
 *   are dropped, and nothing downstream of them changes.
 * - **`sqlite3.IntegrityError` becomes a result code.** better-sqlite3 raises
 *   one error type for everything, so every `pytest.raises(sqlite3.IntegrityError)`
 *   is `expectSqliteError(..., { code: /^SQLITE_CONSTRAINT/ })` -- the code is
 *   what carries the distinction Python's exception hierarchy carried (D-0016),
 *   and the source's `match=` half is kept alongside it wherever it had one.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  ControlPlaneRefusal,
  CorruptStateRefused,
  MissingStateRefused,
} from "../../src/control_plane/refusals.js";
import {
  createControlPlane,
  expectedSchemaFingerprint,
  loadSchemaSql,
  openControlPlane,
  RECONSTRUCTION_QUERIES,
  reconstruct,
  SCHEMA_REVISION,
  SPIKE_MARKING,
  SPIKE_SCHEMA_PATH,
  STATE_TABLES,
  schemaFingerprint,
  schemaSeams,
} from "../../src/control_plane/schema.js";
import { SPIKE_APPLICATION_ID } from "../../src/control_plane/spike.js";
import { bytesOf, caseRoot, rawConnection } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/** A value a caller may bind, or leave at the helper's default. */
type Cell = string | number | null;

/**
 * The source's `db_path` fixture: a name inside a fresh per-test directory,
 * where no file exists yet. Several cases assert nothing was created there, so
 * this must not create it.
 */
function databaseName(root: string): string {
  return join(root, "control-plane.sqlite3");
}

/**
 * The source's `cp` fixture, as a plain call (function scope).
 *
 * The connection is closed by `onTestFinished` registered at the moment it is
 * opened, not by a file-level `afterEach`: several cases close it themselves
 * partway through, and on Windows a connection left open keeps a lock that
 * makes the temp-directory cleanup fail.
 */
function controlPlane(): { root: string; dbPath: string; cp: SqliteDatabase } {
  // The label is `s5` -- interlock's own name for this module -- and NOT
  // "spike-schema", for a reason that is load-bearing rather than cosmetic.
  //
  // Every refusal this module raises interpolates the database path into its
  // message, and `caseRoot(label)` puts the label into that path. A label
  // containing a word that also appears in a refusal message makes any
  // `expectRefusal(..., match)` on that word VACUOUS: the pattern is a search
  // over the whole message, so it matches the path and can no longer fail.
  //
  // That is not hypothetical. With the label "spike-schema", the four
  // `a database that lost a constraint is refused` expansions kept their
  // source's `match="schema"` and it could not discriminate: they would have
  // stayed green for an integrity_check failure, a missing state table, or a
  // foreign application_id -- any CorruptStateRefused at all -- instead of the
  // fingerprint mismatch they exist to pin. In the source the same pattern IS
  // discriminating, because pytest names `tmp_path` after the test function and
  // this test's name is truncated to `test_a_database_that_lost_a_co0`.
  //
  // So the rule for this file: the case-root label may not contain any word a
  // refusal message uses. A `parametrize`d case is the dangerous one, because
  // one vacuous match hides behind several passing expansions.
  const root = caseRoot("s5");
  const dbPath = databaseName(root);
  const cp = createControlPlane(dbPath);
  onTestFinished(() => {
    try {
      cp.close();
    } catch {
      // Already closed by the test. Closing twice is not an error worth
      // failing a passing test over.
    }
  });
  return { root, dbPath, cp };
}

/** Close a connection when the test finishes, whatever the test does with it. */
function closeAfterTest(connection: SqliteDatabase): SqliteDatabase {
  onTestFinished(() => {
    try {
      connection.close();
    } catch {
      // See controlPlane().
    }
  });
  return connection;
}

/** `cp.execute(sql, params)` with positional parameters; returns `rowcount`. */
function execute(cp: SqliteDatabase, sql: string, ...params: Cell[]): number {
  return cp.prepare(sql).run(...params).changes;
}

/** `cp.execute(sql, mapping)` with named parameters; returns `rowcount`. */
function executeNamed(cp: SqliteDatabase, sql: string, params: Record<string, Cell>): number {
  return cp.prepare(sql).run(params).changes;
}

/** The one-column scalar a `SELECT count(*) AS n` reads back. */
function count(cp: SqliteDatabase, sql: string): number {
  return (cp.prepare(sql).get() as { n: number }).n;
}

/**
 * `value` unless it was not supplied at all.
 *
 * Not `??`: a caller passing `null` is overriding the default with SQL NULL,
 * which is exactly what several cases do, and `??` would silently restore the
 * default instead. `undefined` never reaches a bind here either -- it binds as
 * NULL without an error (docs/sqlite-value-contract.md section 4).
 */
function or<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal row of each kind
// --------------------------------------------------------------------------

function addRun(
  cp: SqliteDatabase,
  options: { run_id?: string; status?: string; at?: number } = {},
): string {
  const runId = or(options.run_id, "run-1");
  const at = or(options.at, T0);
  execute(
    cp,
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
    runId,
    or(options.status, "running"),
    at,
    at,
  );
  return runId;
}

interface SessionOptions {
  session_id?: string;
  run_id?: string;
  at?: number;
  provider?: string | null;
  binding_phase?: string | null;
  observation?: string | null;
  provider_state?: string | null;
  observation_reason?: string | null;
  released_at_ms?: number | null;
}

function addSession(cp: SqliteDatabase, options: SessionOptions = {}): string {
  const sessionId = or(options.session_id, "sess-1");
  const observation = or(options.observation, "observed");
  const row = {
    provider: or(options.provider, "stub"),
    observation,
    provider_state: or(options.provider_state, "running"),
    observation_reason: or(options.observation_reason, null),
    released_at_ms: or(options.released_at_ms, null),
    // The schema ties the vocabularies together: only a confirmed binding
    // may claim an observation. Derive the honest default so existing
    // cases keep exercising what they were written for.
    binding_phase: or(
      options.binding_phase,
      observation === "observed" ? "identity_confirmed" : "prepared",
    ),
  };
  executeNamed(
    cp,
    `
        INSERT INTO session (session_id, run_id, provider, binding_phase, observation,
                             provider_state, observation_reason, bound_at_ms, released_at_ms)
        VALUES (:session_id, :run_id, :provider, :binding_phase, :observation,
                :provider_state, :observation_reason, :bound_at_ms, :released_at_ms)
        `,
    {
      session_id: sessionId,
      run_id: or(options.run_id, "run-1"),
      bound_at_ms: or(options.at, T0),
      ...row,
    },
  );
  return sessionId;
}

function addLease(
  cp: SqliteDatabase,
  options: {
    resource?: string;
    holder?: string;
    epoch?: number;
    at?: number;
    ttl_ms?: number;
  } = {},
): void {
  const at = or(options.at, T0);
  execute(
    cp,
    "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
      " VALUES (?, ?, ?, ?, ?)",
    or(options.resource, "run-1"),
    or(options.holder, "holder-a"),
    or(options.epoch, 1),
    at,
    at + or(options.ttl_ms, 30_000),
  );
}

interface OutboxOptions {
  message_id?: string;
  dedup_key?: string | null;
  at?: number;
  run_id?: string | null;
  recipient?: string | null;
  payload?: string | null;
  status?: string | null;
  retry_count?: number | null;
  writer_epoch?: number | null;
  delivered_at_ms?: number | null;
  acked_at_ms?: number | null;
}

function addOutbox(cp: SqliteDatabase, options: OutboxOptions = {}): string {
  const messageId = or(options.message_id, "msg-1");
  const row = {
    run_id: or(options.run_id, "run-1"),
    recipient: or(options.recipient, "secretary"),
    payload: or(options.payload, "{}"),
    status: or(options.status, "pending"),
    retry_count: or(options.retry_count, 0),
    writer_epoch: or(options.writer_epoch, 1),
    delivered_at_ms: or(options.delivered_at_ms, null),
    acked_at_ms: or(options.acked_at_ms, null),
  };
  executeNamed(
    cp,
    `
        INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, status,
                            retry_count, writer_epoch, enqueued_at_ms, delivered_at_ms,
                            acked_at_ms)
        VALUES (:message_id, :run_id, :recipient, :payload, :dedup_key, :status,
                :retry_count, :writer_epoch, :enqueued_at_ms, :delivered_at_ms, :acked_at_ms)
        `,
    {
      message_id: messageId,
      dedup_key: or(options.dedup_key, "dk-1"),
      enqueued_at_ms: or(options.at, T0),
      ...row,
    },
  );
  return messageId;
}

interface IncidentOptions {
  incident_id?: string;
  dedup_key?: string | null;
  at?: number;
  run_id?: string | null;
  session_id?: string | null;
  fact_state?: string | null;
  detector_version?: string | null;
  retry_count?: number | null;
  known_pattern?: string | null;
  elapsed_ms?: number | null;
  previous_assessment?: string | null;
  previous_action_id?: string | null;
  related_incident_id?: string | null;
  resolved_at_ms?: number | null;
}

function addIncident(cp: SqliteDatabase, options: IncidentOptions = {}): string {
  const incidentId = or(options.incident_id, "inc-1");
  const at = or(options.at, T0);
  const row = {
    run_id: or(options.run_id, "run-1"),
    session_id: or(options.session_id, null),
    fact_state: or(options.fact_state, "NO_ACTIVITY_EVIDENCE"),
    detector_version: or(options.detector_version, "d1"),
    retry_count: or(options.retry_count, 0),
    known_pattern: or(options.known_pattern, null),
    elapsed_ms: or(options.elapsed_ms, null),
    previous_assessment: or(options.previous_assessment, null),
    previous_action_id: or(options.previous_action_id, null),
    related_incident_id: or(options.related_incident_id, null),
    resolved_at_ms: or(options.resolved_at_ms, null),
  };
  executeNamed(
    cp,
    `
        INSERT INTO incident (incident_id, run_id, session_id, fact_state, detector_version,
                              dedup_key, retry_count, known_pattern, elapsed_ms,
                              previous_assessment, previous_action_id, related_incident_id,
                              created_at_ms, updated_at_ms, resolved_at_ms)
        VALUES (:incident_id, :run_id, :session_id, :fact_state, :detector_version, :dedup_key,
                :retry_count, :known_pattern, :elapsed_ms, :previous_assessment,
                :previous_action_id, :related_incident_id, :created_at_ms, :updated_at_ms,
                :resolved_at_ms)
        `,
    {
      incident_id: incidentId,
      dedup_key: or(options.dedup_key, "dk-1"),
      created_at_ms: at,
      updated_at_ms: at,
      ...row,
    },
  );
  return incidentId;
}

interface ActionOptions {
  action_id?: string;
  idempotency_key?: string | null;
  at?: number;
  run_id?: string | null;
  incident_id?: string | null;
  kind?: string | null;
  exactly_once_mechanism?: string | null;
  status?: string | null;
  refusal_reason?: string | null;
  result?: string | null;
  writer_epoch?: number | null;
  applied_at_ms?: number | null;
}

function addAction(cp: SqliteDatabase, options: ActionOptions = {}): string {
  const actionId = or(options.action_id, "act-1");
  const row = {
    run_id: or(options.run_id, "run-1"),
    incident_id: or(options.incident_id, null),
    kind: or(options.kind, "notify"),
    exactly_once_mechanism: or(options.exactly_once_mechanism, "destination_idempotency_key"),
    status: or(options.status, "pending"),
    refusal_reason: or(options.refusal_reason, null),
    result: or(options.result, null),
    writer_epoch: or(options.writer_epoch, 1),
    applied_at_ms: or(options.applied_at_ms, null),
  };
  executeNamed(
    cp,
    `
        INSERT INTO action (action_id, run_id, incident_id, kind, idempotency_key,
                            exactly_once_mechanism, status, refusal_reason, result,
                            writer_epoch, created_at_ms, applied_at_ms)
        VALUES (:action_id, :run_id, :incident_id, :kind, :idempotency_key,
                :exactly_once_mechanism, :status, :refusal_reason, :result, :writer_epoch,
                :created_at_ms, :applied_at_ms)
        `,
    {
      action_id: actionId,
      idempotency_key: or(options.idempotency_key, "ik-1"),
      created_at_ms: or(options.at, T0),
      ...row,
    },
  );
  return actionId;
}

/**
 * The DDL with its comments stripped -- what SQLite actually sees.
 *
 * Several assertions below are about what the schema *encodes*, and the
 * comments deliberately discuss the very things the schema must not encode
 * (writer assignment, collapse semantics). Scanning the raw text would fail on
 * the explanation of why the thing is absent.
 */
function executableDdl(): string {
  return loadSchemaSql()
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

// --------------------------------------------------------------------------
// criterion 1 -- the marking is in the schema file itself (D-0026)
// --------------------------------------------------------------------------

describe("criterion 1 -- the marking is in the schema file itself (D-0026)", () => {
  test("the schema file itself carries the spike marking", () => {
    const text = readFileSync(SPIKE_SCHEMA_PATH, "utf-8");

    expect(text).toContain(SPIKE_MARKING);
    expect(text.toLowerCase()).toContain("no migration path");
    expect(text).toContain("D-0026");
    // It has to be visible without scrolling: the mitigation is that a reader
    // who opens the file sees it, not that it exists somewhere inside.
    expect(text.split("\n").slice(0, 12).join("\n")).toContain(SPIKE_MARKING);
  });

  test("the marking says q 0001 is not answered here", () => {
    const text = readFileSync(SPIKE_SCHEMA_PATH, "utf-8");
    expect(text).toContain("Q-0001");
    expect(text.toLowerCase()).toContain("throwaway");
  });

  test("the ddl is refused if the marking is removed", () => {
    const root = caseRoot("s5");
    const stripped = join(root, "spike_schema.sql");
    // `replaceAll`, not `replace`: JavaScript's string `replace` substitutes
    // only the first occurrence where Python's `str.replace` substitutes every
    // one, and a copy that kept a later occurrence of the marking would be
    // loaded rather than refused.
    writeFileSync(stripped, loadSchemaSql().replaceAll(SPIKE_MARKING, ""), "utf-8");
    patchSeam(schemaSeams, "spikeSchemaPath", stripped);

    expectRefusal(() => loadSchemaSql(), ControlPlaneRefusal, "spike marking");
    expectRefusal(
      () => createControlPlane(join(root, "unmarked.sqlite3")),
      ControlPlaneRefusal,
      "spike marking",
    );
    expect(existsSync(join(root, "unmarked.sqlite3"))).toBe(false);
  });
});

// --------------------------------------------------------------------------
// the slice -- six tables and nothing else
// --------------------------------------------------------------------------

describe("the slice -- six tables and nothing else", () => {
  test("the slice is exactly the six named tables", () => {
    const { cp } = controlPlane();
    const tables = (
      cp
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect([...tables].sort()).toEqual([...STATE_TABLES].sort());
  });

  test("every table is reachable from a reconstruction query", () => {
    // D-0001: nothing is stored that no recovery query can read back.
    const sql = Object.values(RECONSTRUCTION_QUERIES).join(" ");
    for (const table of STATE_TABLES) {
      expect(new RegExp(`\\bFROM ${table}\\b`).test(sql), table).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// criterion 3 -- dedup key and retry count on incidents (D-0007)
// --------------------------------------------------------------------------

describe("criterion 3 -- dedup key and retry count on incidents (D-0007)", () => {
  test("incident dedup key and retry count are present and non nullable", () => {
    const { cp } = controlPlane();
    // `PRAGMA table_info` rows are objects here rather than tuples: the
    // source's `row[1]` is `name` and its `row[3]` is `notnull`.
    const columns = new Map(
      (cp.pragma("table_info(incident)") as { name: string; notnull: number }[]).map((row) => [
        row.name,
        row,
      ]),
    );

    expect(columns.has("dedup_key") && columns.has("retry_count")).toBe(true);
    expect(columns.get("dedup_key")?.notnull, "dedup_key must be NOT NULL (D-0007)").toBe(1);
    expect(columns.get("retry_count")?.notnull, "retry_count must be NOT NULL (D-0007)").toBe(1);
  });

  test("an incident without a dedup key is refused", () => {
    const { cp } = controlPlane();
    addRun(cp);
    expectSqliteError(() => addIncident(cp, { dedup_key: null }), {
      code: /^SQLITE_CONSTRAINT/,
    });
    expectSqliteError(() => addIncident(cp, { incident_id: "inc-2", dedup_key: "" }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });

  test("an incident retry count is never null and never decreases", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addIncident(cp);
    expectSqliteError(
      () => execute(cp, "UPDATE incident SET retry_count = NULL WHERE incident_id = 'inc-1'"),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    execute(cp, "UPDATE incident SET retry_count = 3 WHERE incident_id = 'inc-1'");
    expectSqliteError(
      () => execute(cp, "UPDATE incident SET retry_count = 2 WHERE incident_id = 'inc-1'"),
      { code: /^SQLITE_CONSTRAINT/, message: /must not decrease/ },
    );
  });
});

// --------------------------------------------------------------------------
// criterion 4 -- no Q-0001 and no Q-0002 answer is encoded
// --------------------------------------------------------------------------

describe("criterion 4 -- no Q-0001 and no Q-0002 answer is encoded", () => {
  test("no table assigns a writer to a state item", () => {
    const { cp } = controlPlane();
    // Q-0001 left the per-item single-writer table open on this spike schema.
    // D-0029 has since answered it in prose, in the production schema's writer
    // table (docs/production-schema.md section 4.2) -- not as a column here or
    // there. A column naming which component owns which state item would
    // answer it in DDL instead, and every downstream test would then inherit
    // the answer without anyone deciding it, which is what this asserts never
    // happens on this (deliberately frozen) spike schema.
    const forbidden = [
      "role",
      "component",
      "secretary",
      "dispatcher",
      "curator",
      "supervisor",
      "layer",
    ];
    for (const table of STATE_TABLES) {
      for (const row of cp.pragma(`table_info(${table})`) as { name: string }[]) {
        const column = row.name.toLowerCase();
        expect(
          forbidden.some((word) => column.includes(word)),
          `${table}.${column}`,
        ).toBe(false);
      }
    }

    const ddl = executableDdl().toLowerCase();
    for (const word of forbidden) {
      expect(ddl.includes(word), `'${word}' appears in the executable DDL`).toBe(false);
    }
  });

  test("the incident dedup key is indexed but not unique", () => {
    const { cp } = controlPlane();
    // Q-0002 is open: a UNIQUE dedup_key would force the increment-in-place
    // rule and make the linked-incident rule inexpressible.
    const indexes = new Map(
      (
        cp.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string;
        }[]
      ).map((row) => [row.name, cp.pragma(`index_info(${row.name})`)]),
    );
    const unique = new Set(
      (cp.pragma("index_list(incident)") as { name: string; unique: number }[])
        .filter((row) => row.unique)
        .map((row) => row.name),
    );
    expect(indexes.has("incident_by_dedup_key")).toBe(true);
    expect(unique.has("incident_by_dedup_key")).toBe(false);
  });

  parametrize(
    "both q 0002 collapse rules are expressible",
    [
      ["increment_in_place", "increment_in_place"],
      ["linked_incident", "linked_incident"],
    ],
    (collapseRule) => {
      // The test parameterises the rule rather than picking one, which is what
      // ACCEPTANCE.md section 2 requires of every downstream test until Q-0002
      // is settled. Both branches must work against the same schema.
      const { cp } = controlPlane();
      addRun(cp);
      const first = addIncident(cp, { incident_id: "inc-1", dedup_key: "same-key" });

      if (collapseRule === "increment_in_place") {
        execute(
          cp,
          "UPDATE incident SET retry_count = retry_count + 1, updated_at_ms = ?" +
            " WHERE dedup_key = 'same-key'",
          T0 + 1,
        );
        const rows = cp
          .prepare("SELECT retry_count FROM incident WHERE dedup_key = 'same-key'")
          .all();
        expect(rows).toEqual([{ retry_count: 1 }]);
      } else {
        addIncident(cp, {
          incident_id: "inc-2",
          dedup_key: "same-key",
          related_incident_id: first,
          at: T0 + 1,
        });
        const rows = cp
          .prepare(
            "SELECT incident_id, related_incident_id FROM incident WHERE dedup_key = 'same-key'" +
              " ORDER BY incident_id",
          )
          .all();
        expect(rows).toEqual([
          { incident_id: "inc-1", related_incident_id: null },
          { incident_id: "inc-2", related_incident_id: "inc-1" },
        ]);
      }
    },
  );

  test("no renotification window is baked into the schema", () => {
    // Q-0002's window and Q-0003's reconcile interval are open in absolute
    // time. A default, a CHECK against a duration or a column named for a
    // window would be one of them answered by DDL.
    const ddl = executableDdl().toLowerCase();
    for (const word of ["window", "renotif", "interval", "notify_after", "cooldown"]) {
      expect(ddl.includes(word), word).toBe(false);
    }
    // No timestamp column carries a DEFAULT either: the clock is the caller's.
    expect(/_at_ms[^,]*default/.test(ddl)).toBe(false);
  });

  test("a fact state vocabulary is not frozen in the ddl", () => {
    const { cp } = controlPlane();
    // D-0005's set is closed but lives in DECISIONS.md; duplicating it in a
    // schema that promises no migration would make extending it a schema
    // change.
    addRun(cp);
    addIncident(cp, { fact_state: "SOME_LATER_FACT_STATE" });
    expect(count(cp, "SELECT count(*) AS n FROM incident")).toBe(1);
  });
});

// --------------------------------------------------------------------------
// gate item 2 -- one session per run, across the crash window
// --------------------------------------------------------------------------

describe("gate item 2 -- one session per run, across the crash window", () => {
  test("a second active session for one run is refused", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addSession(cp, { session_id: "sess-1" });
    expectSqliteError(() => addSession(cp, { session_id: "sess-2" }), {
      code: /^SQLITE_CONSTRAINT/,
    });

    expect(count(cp, "SELECT count(*) AS n FROM session WHERE released_at_ms IS NULL")).toBe(1);
  });

  test("a released binding frees the run for the next session", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addSession(cp, { session_id: "sess-1" });
    execute(cp, "UPDATE session SET released_at_ms = ? WHERE session_id = 'sess-1'", T0 + 5);
    addSession(cp, { session_id: "sess-2", at: T0 + 6 });

    const active = cp.prepare("SELECT session_id FROM session WHERE released_at_ms IS NULL").all();
    expect(active).toEqual([{ session_id: "sess-2" }]);
  });

  test("a session cannot be bound to a run that does not exist", () => {
    const { cp } = controlPlane();
    expectSqliteError(() => addSession(cp, { session_id: "sess-1", run_id: "no-such-run" }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });

  test("a readout is never stored empty", () => {
    const { cp } = controlPlane();
    // R4: "could not observe" and "observed nothing" must stay distinguishable.
    addRun(cp);
    expectSqliteError(
      () => addSession(cp, { session_id: "sess-1", observation: "observed", provider_state: null }),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    expectSqliteError(
      () =>
        addSession(cp, {
          session_id: "sess-2",
          observation: "unobserved",
          provider_state: "running",
          observation_reason: null,
        }),
      { code: /^SQLITE_CONSTRAINT/ },
    );

    addSession(cp, {
      session_id: "sess-3",
      observation: "unobserved",
      provider_state: null,
      observation_reason: "child has not reported yet",
    });
  });

  test("the binding phase vocabulary is closed", () => {
    const { cp } = controlPlane();
    addRun(cp);
    expectSqliteError(() => addSession(cp, { session_id: "sess-1", binding_phase: "adopted" }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });

  test("a pre readback binding may not claim an observation", () => {
    const { cp } = controlPlane();
    // D-0024 / item 2: the binding is committed before the process exists, so a
    // 'prepared' or 'spawned' row claiming an observation would record a
    // read-back that never happened -- and a confirmed row without one would
    // discard the read-back D-0027 makes mandatory.
    addRun(cp);
    for (const phase of ["prepared", "spawned"]) {
      expectSqliteError(
        () =>
          addSession(cp, {
            session_id: `sess-${phase}`,
            binding_phase: phase,
            observation: "observed",
            provider_state: "running",
          }),
        { code: /^SQLITE_CONSTRAINT/ },
      );
    }
    expectSqliteError(
      () =>
        addSession(cp, {
          session_id: "sess-confirmed",
          binding_phase: "identity_confirmed",
          observation: "unobserved",
          provider_state: null,
          observation_reason: "never read back",
        }),
      { code: /^SQLITE_CONSTRAINT/ },
    );

    addSession(cp, {
      session_id: "sess-1",
      binding_phase: "prepared",
      observation: "unobserved",
      provider_state: null,
      observation_reason: "spawn not yet attempted",
    });
  });

  test("the binding phase only moves forward", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addSession(cp, {
      session_id: "sess-1",
      binding_phase: "prepared",
      observation: "unobserved",
      provider_state: null,
      observation_reason: "spawn not yet attempted",
    });

    // Skipping a step is refused too: a row that jumped straight to
    // 'identity_confirmed' would claim a read-back without ever recording
    // that a spawn was requested -- evidence recovery must be able to trust.
    expectSqliteError(
      () =>
        execute(
          cp,
          "UPDATE session SET binding_phase = 'identity_confirmed'," +
            " observation = 'observed', provider_state = 'running'," +
            " observation_reason = NULL WHERE session_id = 'sess-1'",
        ),
      { code: /^SQLITE_CONSTRAINT/ },
    );

    // The forward walk is the legal one: prepared -> spawned -> confirmed.
    execute(cp, "UPDATE session SET binding_phase = 'spawned' WHERE session_id = 'sess-1'");
    expectSqliteError(
      () =>
        execute(cp, "UPDATE session SET binding_phase = 'prepared' WHERE session_id = 'sess-1'"),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    execute(
      cp,
      "UPDATE session SET binding_phase = 'identity_confirmed', observation = 'observed'," +
        " provider_state = 'running', observation_reason = NULL" +
        " WHERE session_id = 'sess-1'",
    );
    for (const backwards of ["prepared", "spawned"]) {
      expectSqliteError(
        () =>
          execute(
            cp,
            "UPDATE session SET binding_phase = ?, observation = 'unobserved'," +
              " provider_state = NULL, observation_reason = 'rewound'" +
              " WHERE session_id = 'sess-1'",
            backwards,
          ),
        { code: /^SQLITE_CONSTRAINT/ },
      );
    }
  });

  test("a timestamp that is not an integer is refused", () => {
    const { cp } = controlPlane();
    // No STRICT tables before SQLite 3.37, so the type checks are CHECKs; a
    // string timestamp would sort wrong in every recovery query.
    expectSqliteError(
      () =>
        execute(
          cp,
          "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?,?,?,?)",
          "run-x",
          "running",
          "2026-08-19T00:00:00Z",
          "2026-08-19T00:00:00Z",
        ),
      { code: /^SQLITE_CONSTRAINT/ },
    );
  });
});

// --------------------------------------------------------------------------
// gate item 5 -- lease, fencing token, outbox, ack, dedup
// --------------------------------------------------------------------------

describe("gate item 5 -- lease, fencing token, outbox, ack, dedup", () => {
  test("a lease epoch never goes backwards", () => {
    const { cp } = controlPlane();
    addLease(cp, { holder: "holder-a", epoch: 7 });
    execute(cp, "UPDATE lease SET epoch = 8 WHERE resource = 'run-1'");
    expectSqliteError(() => execute(cp, "UPDATE lease SET epoch = 3 WHERE resource = 'run-1'"), {
      code: /^SQLITE_CONSTRAINT/,
      message: /never decreases/,
    });

    // A renewal by the same holder keeps its epoch: re-acquiring is not what
    // invalidates a token, and forcing a bump would make every heartbeat
    // invalidate writes that are still in flight.
    execute(cp, "UPDATE lease SET expires_at_ms = ? WHERE resource = 'run-1'", T0 + 90_000);
    expect(cp.prepare("SELECT epoch FROM lease").get()).toEqual({ epoch: 8 });
  });

  test("a change of holder must raise the epoch", () => {
    const { cp } = controlPlane();
    // The handover written without naming the epoch is the dangerous one: it
    // hands the replacement the previous holder's token, and a paused former
    // holder returning with that token is then indistinguishable from the
    // current one at any destination that validates tokens rather than rows.
    addLease(cp, { holder: "holder-a", epoch: 4 });

    expectSqliteError(
      () =>
        execute(
          cp,
          "UPDATE lease SET holder = 'holder-b', acquired_at_ms = ?, expires_at_ms = ?" +
            " WHERE resource = 'run-1'",
          T0 + 60_000,
          T0 + 90_000,
        ),
      { code: /^SQLITE_CONSTRAINT/, message: /new holder must raise it/ },
    );
    expectSqliteError(
      () => execute(cp, "UPDATE lease SET holder = 'holder-b', epoch = 4 WHERE resource = 'run-1'"),
      { code: /^SQLITE_CONSTRAINT/, message: /new holder must raise it/ },
    );

    execute(
      cp,
      "UPDATE lease SET holder = 'holder-b', epoch = 5, acquired_at_ms = ?, expires_at_ms = ?" +
        " WHERE resource = 'run-1'",
      T0 + 60_000,
      T0 + 90_000,
    );
    expect(cp.prepare("SELECT holder, epoch FROM lease").get()).toEqual({
      holder: "holder-b",
      epoch: 5,
    });
  });

  test("a lease resource cannot be renamed out of the way", () => {
    const { cp } = controlPlane();
    // Blocking DELETE is not enough: renaming the primary key vacates the
    // resource, and the next INSERT takes it at epoch 1 -- the same token
    // reuse, reached by a different statement.
    addLease(cp, { resource: "run-1", epoch: 9 });

    expectSqliteError(
      () => execute(cp, "UPDATE lease SET resource = 'run-1-old' WHERE resource = 'run-1'"),
      { code: /^SQLITE_CONSTRAINT/, message: /never renamed/ },
    );
    expectSqliteError(() => addLease(cp, { resource: "run-1", holder: "holder-c", epoch: 1 }), {
      code: /^SQLITE_CONSTRAINT/,
    });

    expect(cp.prepare("SELECT resource, epoch FROM lease").all()).toEqual([
      { resource: "run-1", epoch: 9 },
    ]);
  });

  test("an outbox row keeps the identity its ack was recorded against", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addOutbox(cp);
    expectSqliteError(
      () => execute(cp, "UPDATE outbox SET message_id = 'msg-2' WHERE message_id = 'msg-1'"),
      { code: /^SQLITE_CONSTRAINT/, message: /message identity/ },
    );
  });

  test("a lease row is expired not deleted", () => {
    const { cp } = controlPlane();
    addLease(cp);
    expectSqliteError(() => execute(cp, "DELETE FROM lease WHERE resource = 'run-1'"), {
      code: /^SQLITE_CONSTRAINT/,
      message: /never deleted/,
    });
  });

  test("a protected write validates the fencing token in the write", () => {
    const { cp } = controlPlane();
    // ACCEPTANCE.md section 2: expiry discovery alone is insufficient, the
    // token is validated atomically as part of the write. The schema's job is
    // to make that one statement possible; this is the statement.
    addRun(cp);
    addLease(cp, { resource: "run-1", holder: "holder-a", epoch: 2 });
    addOutbox(cp, { writer_epoch: 2 });

    const protectedWrite = `
        UPDATE outbox SET retry_count = retry_count + 1
         WHERE message_id = :message_id
           AND EXISTS (SELECT 1 FROM lease
                        WHERE resource = :resource AND holder = :holder
                          AND epoch = :epoch AND expires_at_ms > :now_ms)
    `;
    const stale = {
      message_id: "msg-1",
      resource: "run-1",
      holder: "holder-a",
      epoch: 1,
      now_ms: T0,
    };
    expect(executeNamed(cp, protectedWrite, stale)).toBe(0);

    const current = { ...stale, epoch: 2 };
    expect(executeNamed(cp, protectedWrite, current)).toBe(1);

    const expired = { ...current, now_ms: T0 + 10 ** 9 };
    expect(executeNamed(cp, protectedWrite, expired)).toBe(0);
    expect(cp.prepare("SELECT retry_count FROM outbox").get()).toEqual({ retry_count: 1 });
  });

  test("an outbox retry count is monotonic and survives a restart", () => {
    const { cp, dbPath } = controlPlane();
    addRun(cp);
    addOutbox(cp);
    execute(cp, "UPDATE outbox SET retry_count = 4 WHERE message_id = 'msg-1'");
    expectSqliteError(
      () => execute(cp, "UPDATE outbox SET retry_count = 0 WHERE message_id = 'msg-1'"),
      { code: /^SQLITE_CONSTRAINT/, message: /must not decrease/ },
    );
    cp.close();

    const reopened = closeAfterTest(openControlPlane(dbPath));
    expect(reopened.prepare("SELECT retry_count FROM outbox").get()).toEqual({ retry_count: 4 });
  });

  test("an acked message is acked once", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addOutbox(cp);
    execute(
      cp,
      "UPDATE outbox SET status = 'delivered', delivered_at_ms = ? WHERE message_id = 'msg-1'",
      T0 + 1,
    );
    execute(
      cp,
      "UPDATE outbox SET status = 'acked', acked_at_ms = ? WHERE message_id = 'msg-1'",
      T0 + 2,
    );

    // A duplicate ack changes nothing; a *different* ack instant is refused
    // rather than silently overwriting the first one.
    execute(
      cp,
      "UPDATE outbox SET status = 'acked', acked_at_ms = ? WHERE message_id = 'msg-1'",
      T0 + 2,
    );
    expectSqliteError(
      () => execute(cp, "UPDATE outbox SET acked_at_ms = ? WHERE message_id = 'msg-1'", T0 + 9),
      { code: /^SQLITE_CONSTRAINT/, message: /acked once/ },
    );

    expect(cp.prepare("SELECT status, acked_at_ms FROM outbox").all()).toEqual([
      { status: "acked", acked_at_ms: T0 + 2 },
    ]);
  });

  test("an outbox row cannot claim a state its timestamps deny", () => {
    const { cp } = controlPlane();
    addRun(cp);
    expectSqliteError(() => addOutbox(cp, { status: "delivered", delivered_at_ms: null }), {
      code: /^SQLITE_CONSTRAINT/,
    });
    expectSqliteError(
      () =>
        addOutbox(cp, {
          message_id: "msg-2",
          status: "acked",
          delivered_at_ms: T0 + 1,
          acked_at_ms: null,
        }),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    expectSqliteError(
      () => addOutbox(cp, { message_id: "msg-3", status: "pending", delivered_at_ms: T0 + 1 }),
      { code: /^SQLITE_CONSTRAINT/ },
    );
  });

  test("one effect per idempotency key and refusals stay recordable", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addAction(cp, { action_id: "act-1", idempotency_key: "ik-1" });
    expectSqliteError(() => addAction(cp, { action_id: "act-2", idempotency_key: "ik-1" }), {
      code: /^SQLITE_CONSTRAINT/,
    });

    // A refused attempt is durable, and a stale writer that keeps returning can
    // be recorded every time without any of those rows admitting an effect.
    addAction(cp, {
      action_id: "act-3",
      idempotency_key: "ik-1",
      status: "refused",
      refusal_reason: "stale fencing token",
    });
    addAction(cp, {
      action_id: "act-4",
      idempotency_key: "ik-1",
      status: "refused",
      refusal_reason: "stale fencing token",
    });

    const effects = count(
      cp,
      "SELECT count(*) AS n FROM action WHERE idempotency_key = 'ik-1' AND status <> 'refused'",
    );
    expect(effects).toBe(1);
  });

  test("an action must name its exactly once mechanism", () => {
    const { cp } = controlPlane();
    addRun(cp);
    expectSqliteError(() => addAction(cp, { exactly_once_mechanism: null }), {
      code: /^SQLITE_CONSTRAINT/,
    });
    expectSqliteError(() => addAction(cp, { exactly_once_mechanism: "hope" }), {
      code: /^SQLITE_CONSTRAINT/,
    });

    const mechanisms = ["destination_idempotency_key", "transactional_with_record", "human_gate"];
    mechanisms.forEach((mechanism, index) => {
      addAction(cp, {
        action_id: `act-${index}`,
        idempotency_key: `ik-${index}`,
        exactly_once_mechanism: mechanism,
      });
    });
  });

  test("an applied action is applied once", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addAction(cp);
    execute(
      cp,
      "UPDATE action SET status = 'applied', applied_at_ms = ? WHERE action_id = 'act-1'",
      T0 + 1,
    );
    expectSqliteError(
      () => execute(cp, "UPDATE action SET applied_at_ms = ? WHERE action_id = 'act-1'", T0 + 2),
      { code: /^SQLITE_CONSTRAINT/, message: /applied once/ },
    );
  });

  test("a refused action carries its reason", () => {
    const { cp } = controlPlane();
    addRun(cp);
    expectSqliteError(() => addAction(cp, { status: "refused", refusal_reason: null }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });
});

// --------------------------------------------------------------------------
// criterion 2 -- state is reconstructable by query from SQLite alone (D-0001)
// --------------------------------------------------------------------------

/** The source's `_write_in_flight_state`: a database mid-flight. */
function writeInFlightState(cp: SqliteDatabase): void {
  addRun(cp, { run_id: "run-1" });
  addRun(cp, { run_id: "run-2" });
  addSession(cp, { session_id: "sess-1", run_id: "run-1" });
  addSession(cp, {
    session_id: "sess-old",
    run_id: "run-2",
    at: T0 - 10,
    released_at_ms: T0 - 5,
  });
  addLease(cp, { resource: "run-1", holder: "holder-a", epoch: 3, ttl_ms: 30_000 });
  addLease(cp, { resource: "run-2", holder: "holder-b", epoch: 1, at: T0 - 90_000, ttl_ms: 1_000 });
  addOutbox(cp, { message_id: "msg-1", dedup_key: "dk-1" });
  addOutbox(cp, {
    message_id: "msg-2",
    dedup_key: "dk-2",
    status: "acked",
    delivered_at_ms: T0 + 1,
    acked_at_ms: T0 + 2,
  });
  addIncident(cp, { incident_id: "inc-1", dedup_key: "dk-1" });
  addIncident(cp, { incident_id: "inc-2", dedup_key: "dk-2", resolved_at_ms: T0 + 3 });
  addAction(cp, { action_id: "act-1", idempotency_key: "ik-1" });
  addAction(cp, {
    action_id: "act-2",
    idempotency_key: "ik-2",
    status: "applied",
    applied_at_ms: T0 + 4,
  });
}

describe("criterion 2 -- state is reconstructable by query from SQLite alone (D-0001)", () => {
  test("reconstruction reads only what is still in flight", () => {
    const { cp } = controlPlane();
    writeInFlightState(cp);
    const state = reconstruct(cp, T0 + 1_000);

    expect(state.runs.map((row) => row["run_id"])).toEqual(["run-1", "run-2"]);
    expect(state.activeSessions.map((row) => row["session_id"])).toEqual(["sess-1"]);
    expect(state.heldLeases.map((row) => row["resource"])).toEqual(["run-1"]);
    expect(state.unfinishedOutbox.map((row) => row["message_id"])).toEqual(["msg-1"]);
    expect(state.unresolvedIncidents.map((row) => row["incident_id"])).toEqual(["inc-1"]);
    expect(state.pendingActions.map((row) => row["action_id"])).toEqual(["act-1"]);
  });

  test("lease liveness is read against the callers clock", () => {
    const { cp } = controlPlane();
    writeInFlightState(cp);

    // The clock is skewed across the expiry boundary, as ACCEPTANCE.md section
    // 2 requires; the answer changes with the caller's clock and with nothing
    // else.
    expect(reconstruct(cp, T0 - 89_500).heldLeases.map((row) => row["resource"])).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(reconstruct(cp, T0 + 10 ** 9).heldLeases).toEqual([]);
  });

  test("the incident packet is reconstructed whole", () => {
    const { cp } = controlPlane();
    // D-0007: the on-demand AI is startable statelessly from the row alone, so
    // every field of the packet has to come back out of the query.
    addRun(cp);
    addIncident(cp, {
      known_pattern: "approval-prompt",
      elapsed_ms: 1234,
      previous_assessment: "watch",
      detector_version: "d7",
      retry_count: 2,
    });
    const packet = reconstruct(cp, T0).unresolvedIncidents[0];

    expect(packet?.["dedup_key"]).toBe("dk-1");
    expect(packet?.["retry_count"]).toBe(2);
    expect(packet?.["detector_version"]).toBe("d7");
    expect(packet?.["known_pattern"]).toBe("approval-prompt");
    expect(packet?.["elapsed_ms"]).toBe(1234);
    expect(packet?.["previous_assessment"]).toBe("watch");
    expect(packet?.["evidence_refs"]).toBe("[]");
  });

  test("state survives the process that wrote it", () => {
    // The reconstruction a *fresh interpreter* gets is the same one (D-0001).
    //
    // Run in a subprocess rather than on a second connection: a second
    // connection in this process would still share module state, and the claim
    // under test is that nothing a recovering process needs lives only in a
    // process.
    const { cp, root, dbPath } = controlPlane();
    writeInFlightState(cp);
    const inProcess = reconstruct(cp, T0 + 1_000);
    cp.close();

    // Where Python hands the child `sys.executable -c <program>` and a
    // PYTHONPATH, the child here needs one more piece: `schema.ts` is
    // TypeScript, and its relative imports carry the `.js` suffixes NodeNext
    // requires (D-0002). So the child registers a resolve hook that falls back
    // to the `.ts` file, and runs under Node's type stripping. Both files are
    // written into the case's own directory and are ASCII-only (D-0006).
    const hook = join(root, "resolve-ts-hook.mjs");
    writeFileSync(
      hook,
      [
        "// Resolve the '.js' specifiers of a NodeNext TypeScript graph to the",
        "// '.ts' files they name, so a child process can import src/ directly.",
        "export async function resolve(specifier, context, nextResolve) {",
        "  try {",
        "    return await nextResolve(specifier, context);",
        "  } catch (error) {",
        '    if (specifier.startsWith(".") && specifier.endsWith(".js")) {',
        '      return await nextResolve(specifier.slice(0, -3) + ".ts", context);',
        "    }",
        "    throw error;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    const program = join(root, "recover.mjs");
    writeFileSync(
      program,
      [
        'import { register } from "node:module";',
        'import { pathToFileURL } from "node:url";',
        "",
        "// pathToFileURL, never a bare path: a Windows path is not a URL, and a",
        "// dynamic import of one fails before the recovery under test runs.",
        "register(pathToFileURL(process.argv[2]).href);",
        "const schema = await import(pathToFileURL(process.argv[3]).href);",
        "const connection = schema.openControlPlane(process.argv[4]);",
        "const state = schema.reconstruct(connection, Number(process.argv[5]));",
        "process.stdout.write(JSON.stringify(state));",
        "connection.close();",
        "",
      ].join("\n"),
      "utf-8",
    );

    const schemaSource = fileURLToPath(
      new URL("../../src/control_plane/schema.ts", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [...stripTypesFlags(), program, hook, schemaSource, dbPath, String(T0 + 1_000)],
      { encoding: "utf-8" },
    );
    // Report the child's own words. A bare status assertion carries the exit
    // code and nothing else, which is a failure nobody can diagnose from a CI
    // log.
    expect(
      result.status,
      `the recovering process exited ${result.status}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    const recovered = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(recovered["activeSessions"]).toEqual(inProcess.activeSessions);
    expect(recovered["unresolvedIncidents"]).toEqual(inProcess.unresolvedIncidents);
    expect(recovered["pendingActions"]).toEqual(inProcess.pendingActions);
    expect(recovered["unfinishedOutbox"]).toEqual(inProcess.unfinishedOutbox);
    expect(recovered["heldLeases"]).toEqual(inProcess.heldLeases);
    expect(recovered["runs"]).toEqual(inProcess.runs);
  });
});

/**
 * The flags the child needs to run TypeScript sources.
 *
 * Node strips types without a flag from 22.18.0 and 23.6.0 onward; earlier
 * releases in this package's supported range (>=22.14.0) need
 * `--experimental-strip-types`. Asking the running interpreter rather than
 * passing the flag unconditionally keeps the child from failing on a release
 * that has retired it.
 */
function stripTypesFlags(): string[] {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const stripsByDefault = major > 22 || (major === 22 && minor >= 18);
  return stripsByDefault ? ["--no-warnings"] : ["--experimental-strip-types", "--no-warnings"];
}

// --------------------------------------------------------------------------
// criterion 5 -- corrupt state is refused, never recovered as empty (R3)
// --------------------------------------------------------------------------

describe("criterion 5 -- corrupt state is refused, never recovered as empty (R3)", () => {
  test("an absent database is refused and not created", () => {
    const dbPath = databaseName(caseRoot("s5"));
    expectRefusal(() => openControlPlane(dbPath), MissingStateRefused);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("a file that is not a database is refused and left alone", () => {
    const root = caseRoot("s5");
    const dbPath = databaseName(root);
    writeFileSync(dbPath, Buffer.from("this is not a database, it is a note someone left"));
    const before = bytesOf(dbPath);

    expectRefusal(() => openControlPlane(dbPath), CorruptStateRefused);

    expect(bytesOf(dbPath).equals(before)).toBe(true);
    expect(readdirSync(root).filter((name) => name.endsWith("-journal"))).toEqual([]);
    expect(readdirSync(root).filter((name) => name.endsWith("-wal"))).toEqual([]);
  });

  test("a truncated database is refused", () => {
    const { cp, dbPath } = controlPlane();
    addRun(cp);
    cp.close();
    const handle = openSync(dbPath, "r+");
    try {
      ftruncateSync(handle, Math.floor(statSync(dbPath).size / 3));
    } finally {
      closeSync(handle);
    }

    expectRefusal(() => openControlPlane(dbPath), CorruptStateRefused);
  });

  test("a database missing a state table is refused not rebuilt", () => {
    const { cp, dbPath } = controlPlane();
    addRun(cp);
    execute(cp, "DROP TABLE action");
    cp.close();

    expectRefusal(() => openControlPlane(dbPath), CorruptStateRefused, "missing state table");

    // Refused means untouched: the table is not recreated behind the caller's
    // back, and the surviving rows are not discarded either.
    const raw = rawConnection(dbPath);
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).not.toContain("action");
    expect(count(raw, "SELECT count(*) AS n FROM run")).toBe(1);
    raw.close();
  });

  test("a database from another application is refused", () => {
    const root = caseRoot("s5");
    const other = join(root, "someone-elses.sqlite3");
    const raw = rawConnection(other);
    raw.exec("CREATE TABLE notes (body TEXT)");
    raw.close();

    expectRefusal(() => openControlPlane(other), CorruptStateRefused, "application_id");
  });

  test("a database at another revision is refused rather than migrated", () => {
    const { cp, dbPath } = controlPlane();
    cp.close();
    const raw = rawConnection(dbPath);
    raw.pragma(`user_version = ${SCHEMA_REVISION + 1}`);
    raw.close();

    expectRefusal(() => openControlPlane(dbPath), CorruptStateRefused, "no migration path");
  });

  test("a dangling reference is refused", () => {
    const { cp, dbPath } = controlPlane();
    cp.close();
    // Foreign keys are per-connection, so a writer that never enabled them can
    // leave a session pointing at no run. Recovery must not read that as state.
    const raw = rawConnection(dbPath);
    // Python's `sqlite3.connect` leaves `foreign_keys` off, which is what makes
    // the source's raw INSERT possible; better-sqlite3 turns it on for every
    // connection it opens. Turning it back off is what reproduces the careless
    // writer -- without it the sabotage fails and the refusal under test is
    // never reached.
    raw.pragma("foreign_keys = OFF");
    execute(
      raw,
      "INSERT INTO session (session_id, run_id, provider, binding_phase, observation," +
        " provider_state, bound_at_ms) VALUES ('sess-1', 'ghost-run', 'stub'," +
        " 'identity_confirmed', 'observed', 'running', ?)",
      T0,
    );
    raw.close();

    expectRefusal(() => openControlPlane(dbPath), CorruptStateRefused, "foreign key");
  });

  test("creating over an existing path is refused", () => {
    const { cp, dbPath } = controlPlane();
    addRun(cp);

    expectRefusal(() => createControlPlane(dbPath), ControlPlaneRefusal, "already exists");

    expect(count(cp, "SELECT count(*) AS n FROM run")).toBe(1);
  });

  test("a created database is stamped so it can be recognised", () => {
    const { cp } = controlPlane();
    expect(cp.pragma("application_id", { simple: true })).toBe(SPIKE_APPLICATION_ID);
    expect(cp.pragma("user_version", { simple: true })).toBe(SCHEMA_REVISION);
  });

  test("an opened connection enforces foreign keys", () => {
    const { cp, dbPath } = controlPlane();
    cp.close();

    // The source pins `_configure`: Python's sqlite3 defaults `foreign_keys`
    // OFF, so a reopened connection reporting 1 proves `open_control_plane`
    // turned it on. better-sqlite3 defaults it ON (measured: 1 on 13.0.3), so
    // the bare assertion would hold even with `configureConnection` deleted
    // from `openControlPlane` -- green for the wrong reason, which is exactly
    // what the seam-liveness rule exists to stop.
    //
    // So the driver's default is removed first: the connect seam hands back a
    // handle with foreign keys explicitly OFF, and the only thing that can
    // then make the reopened connection report 1 is production's own
    // `configureConnection` call. The assertion is the source's, unchanged;
    // what is restored is its ability to fail.
    const realConnect = schemaSeams.connect;
    patchSeam(schemaSeams, "connect", (path, options) => {
      const connection = realConnect(path, options);
      if (options?.readonly !== true) {
        connection.pragma("foreign_keys = OFF");
      }
      return connection;
    });

    const reopened = closeAfterTest(openControlPlane(dbPath));
    expect(reopened.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

// --------------------------------------------------------------------------
// durable evidence cannot be edited away (round-1 self-review)
// --------------------------------------------------------------------------

describe("durable evidence cannot be edited away (round-1 self-review)", () => {
  test("an action keeps the idempotency key it was recorded with", () => {
    const { cp } = controlPlane();
    // A key unique among *current* values is a snapshot, not evidence:
    // rewriting an applied action's key vacates it, and the next writer takes
    // the original key as though the first effect had never happened.
    addRun(cp);
    addAction(cp, {
      action_id: "act-1",
      idempotency_key: "ik-1",
      status: "applied",
      applied_at_ms: T0 + 1,
    });

    expectSqliteError(
      () => execute(cp, "UPDATE action SET idempotency_key = 'ik-2' WHERE action_id = 'act-1'"),
      { code: /^SQLITE_CONSTRAINT/, message: /keeps the idempotency key/ },
    );
    expectSqliteError(() => addAction(cp, { action_id: "act-2", idempotency_key: "ik-1" }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });

  test("a refused action stays refused", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addAction(cp, { status: "refused", refusal_reason: "stale fencing token" });

    expectSqliteError(
      () =>
        execute(
          cp,
          "UPDATE action SET status = 'pending', refusal_reason = NULL WHERE action_id = 'act-1'",
        ),
      { code: /^SQLITE_CONSTRAINT/, message: /stays refused/ },
    );
    expect(cp.prepare("SELECT status, refusal_reason FROM action").all()).toEqual([
      { status: "refused", refusal_reason: "stale fencing token" },
    ]);
  });

  test("the outbox lifecycle does not walk backwards", () => {
    const { cp } = controlPlane();
    addRun(cp);
    addOutbox(cp);
    execute(
      cp,
      "UPDATE outbox SET status = 'delivered', delivered_at_ms = ? WHERE message_id = 'msg-1'",
      T0 + 1,
    );

    // Whichever guard fires first -- the forward-only status trigger or the
    // set-once delivery instant -- the row does not walk back. A status
    // regression that leaves delivered_at_ms alone is refused by the CHECK
    // instead, so every route out of 'delivered' is closed.
    expectSqliteError(
      () =>
        execute(
          cp,
          "UPDATE outbox SET status = 'pending', delivered_at_ms = NULL" +
            " WHERE message_id = 'msg-1'",
        ),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    expectSqliteError(
      () => execute(cp, "UPDATE outbox SET status = 'pending' WHERE message_id = 'msg-1'"),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    expectSqliteError(
      () => execute(cp, "UPDATE outbox SET delivered_at_ms = ? WHERE message_id = 'msg-1'", T0 + 9),
      { code: /^SQLITE_CONSTRAINT/, message: /delivered once/ },
    );
    expectSqliteError(
      () => execute(cp, "UPDATE outbox SET dedup_key = 'dk-other' WHERE message_id = 'msg-1'"),
      { code: /^SQLITE_CONSTRAINT/, message: /keeps the dedup key/ },
    );

    expect(cp.prepare("SELECT status, delivered_at_ms, dedup_key FROM outbox").all()).toEqual([
      { status: "delivered", delivered_at_ms: T0 + 1, dedup_key: "dk-1" },
    ]);
  });

  test("an empty reason is as empty as a missing one", () => {
    const { cp } = controlPlane();
    // R4 is about the *distinction* surviving, and '' erases it exactly as NULL
    // would -- with the added harm that a CHECK written against NULL says it
    // did not.
    addRun(cp);
    expectSqliteError(
      () =>
        addSession(cp, {
          session_id: "sess-1",
          observation: "unobserved",
          provider_state: null,
          observation_reason: "",
        }),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    expectSqliteError(
      () => addSession(cp, { session_id: "sess-2", observation: "observed", provider_state: "" }),
      { code: /^SQLITE_CONSTRAINT/ },
    );
    expectSqliteError(() => addAction(cp, { status: "refused", refusal_reason: "" }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });
});

// --------------------------------------------------------------------------
// the shape of the schema is verified, not just the names (round-1 self-review)
// --------------------------------------------------------------------------

describe("the shape of the schema is verified, not just the names (round-1 self-review)", () => {
  parametrize(
    "a database that lost a constraint is refused",
    [
      [
        "DROP INDEX session_one_active_binding_per_run",
        "DROP INDEX session_one_active_binding_per_run",
      ],
      ["DROP INDEX action_one_effect_per_key", "DROP INDEX action_one_effect_per_key"],
      ["DROP TRIGGER lease_epoch_is_monotonic", "DROP TRIGGER lease_epoch_is_monotonic"],
      ["DROP TRIGGER outbox_ack_is_set_once", "DROP TRIGGER outbox_ack_is_set_once"],
    ],
    (damage) => {
      // integrity_check answers "are the pages readable", not "is this the
      // schema you wrote". A database missing an index or a trigger passes it
      // and then permits exactly what the lost constraint forbade -- silently,
      // and only at the moment it matters.
      const { cp, dbPath } = controlPlane();
      execute(cp, damage);
      cp.close();

      expectRefusal(() => openControlPlane(dbPath), CorruptStateRefused, "schema");
    },
  );

  test("the expected fingerprint is derived from the ddl not pinned beside it", () => {
    const { cp } = controlPlane();
    expect(schemaFingerprint(cp)).toBe(expectedSchemaFingerprint());
  });

  test("a creation that loses a race does not delete the winners database", () => {
    // Two processes creating the same absent path both pass an exists() check;
    // the loser's CREATE TABLE then fails against the winner's database, and a
    // cleanup that trusts "I was creating it" deletes a live database. The
    // claim is atomic instead, so the loser never reaches the cleanup.
    //
    // Adapted: the source makes the loser's pre-check useless by patching
    // `Path.exists` to return False. `createControlPlane` has no such
    // pre-check -- it claims the path with an O_EXCL open -- so there is no
    // exists() to falsify, and the strongest faithful statement of the same
    // property is that the loser is refused *before it ever connects*: the
    // connect seam is armed to fail the test if production reaches it, which
    // is the step the source's cleanup hung off.
    const { cp, dbPath } = controlPlane();
    addRun(cp);

    const real = schemaSeams.connect;
    let refuseConnect = true;
    patchSeam(schemaSeams, "connect", (path, options) => {
      if (refuseConnect) {
        throw new Error("createControlPlane connected after losing the claim on the path");
      }
      return real(path, options);
    });

    expectRefusal(() => createControlPlane(dbPath), ControlPlaneRefusal, "already exists");

    refuseConnect = false; // the source's monkeypatch.undo()
    expect(existsSync(dbPath)).toBe(true);
    const survivor = closeAfterTest(openControlPlane(dbPath));
    expect(count(survivor, "SELECT count(*) AS n FROM run")).toBe(1);
  });

  test("a run with nothing hanging off it still reconstructs", () => {
    const { cp } = controlPlane();
    // The riskiest moment for a run is before anything references it: a
    // reconstruction that reached runs only through their sessions, outbox rows
    // or incidents would lose exactly the run that was killed there.
    addRun(cp, { run_id: "run-lonely", status: "starting" });
    const state = reconstruct(cp, T0);

    expect(state.runs.map((row) => [row["run_id"], row["status"]])).toEqual([
      ["run-lonely", "starting"],
    ]);
    expect(state.activeSessions).toEqual([]);
  });

  test("exactly once evidence cannot be deleted out of the way", () => {
    const { cp } = controlPlane();
    // Freezing a value protects it only while the row exists. Deleting an
    // applied action vacates its idempotency key, and the same effect can then
    // be applied a second time -- the one thing item 4 asks this table to make
    // impossible.
    addRun(cp);
    addAction(cp, {
      action_id: "act-1",
      idempotency_key: "ik-1",
      status: "applied",
      applied_at_ms: T0 + 1,
    });
    addOutbox(cp, {
      message_id: "msg-1",
      status: "acked",
      delivered_at_ms: T0 + 1,
      acked_at_ms: T0 + 2,
    });

    expectSqliteError(() => execute(cp, "DELETE FROM action WHERE action_id = 'act-1'"), {
      code: /^SQLITE_CONSTRAINT/,
      message: /never deleted/,
    });
    expectSqliteError(() => execute(cp, "DELETE FROM outbox WHERE message_id = 'msg-1'"), {
      code: /^SQLITE_CONSTRAINT/,
      message: /never deleted/,
    });

    // And a refusal is evidence too, so it is not deletable either.
    addAction(cp, {
      action_id: "act-2",
      idempotency_key: "ik-2",
      status: "refused",
      refusal_reason: "stale token",
    });
    expectSqliteError(() => execute(cp, "DELETE FROM action WHERE action_id = 'act-2'"), {
      code: /^SQLITE_CONSTRAINT/,
      message: /never deleted/,
    });

    expectSqliteError(() => addAction(cp, { action_id: "act-3", idempotency_key: "ik-1" }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });

  test("a creation that cannot connect leaves no file behind", () => {
    // The O_EXCL claim creates the file before SQLite is involved, so a connect
    // that never returns a connection would otherwise leave an empty file that
    // refuses creation (it exists) and refuses opening (it is not a database).
    //
    // Adapted: the source patches `sqlite3.connect` to raise
    // `sqlite3.OperationalError`. better-sqlite3 has no exception hierarchy to
    // raise from, so the seam throws an error shaped the way the driver shapes
    // one -- a `SQLITE_CANTOPEN` code with SQLite's own wording -- and the
    // assertion keeps both halves through `expectSqliteError` (D-0016).
    const dbPath = databaseName(caseRoot("s5"));

    const real = schemaSeams.connect;
    let unavailable = true;
    patchSeam(schemaSeams, "connect", (path, options) => {
      if (unavailable) {
        const error = new Error("unable to open database file") as Error & { code: string };
        error.code = "SQLITE_CANTOPEN";
        throw error;
      }
      return real(path, options);
    });

    expectSqliteError(() => createControlPlane(dbPath), {
      code: "SQLITE_CANTOPEN",
      message: /unable to open database file/,
    });

    unavailable = false; // the source's monkeypatch.undo()
    expect(existsSync(dbPath)).toBe(false);
    createControlPlane(dbPath).close();
  });
});

// --------------------------------------------------------------------------
// seam liveness (target-only)
// --------------------------------------------------------------------------

describe("seam liveness (target-only)", () => {
  test("loadSchemaSql reads the schema path through the seam record", () => {
    // A seam that production stopped routing through would leave the three
    // cases that replace an entry green for the wrong reason: the replacement
    // would simply never be reached, and the refusals they assert would still
    // hold. So each seam entry is pinned by a test that fails when production
    // reads the constant or calls the function directly (D-0014).
    const root = caseRoot("s5");
    const copy = join(root, "spike_schema.sql");
    const marker = "-- seam liveness marker\n";
    writeFileSync(copy, marker + readFileSync(SPIKE_SCHEMA_PATH, "utf-8"), "utf-8");
    patchSeam(schemaSeams, "spikeSchemaPath", copy);

    expect(loadSchemaSql().startsWith(marker)).toBe(true);
  });

  test("createControlPlane connects through the seam record", () => {
    const dbPath = databaseName(caseRoot("s5"));
    const real = schemaSeams.connect;
    let calls = 0;
    patchSeam(schemaSeams, "connect", (path, options) => {
      calls += 1;
      return real(path, options);
    });

    closeAfterTest(createControlPlane(dbPath));
    expect(calls).toBe(1);
  });

  test("openControlPlane connects through the seam record", () => {
    const { cp, dbPath } = controlPlane();
    cp.close();
    const real = schemaSeams.connect;
    let calls = 0;
    patchSeam(schemaSeams, "connect", (path, options) => {
      calls += 1;
      return real(path, options);
    });

    closeAfterTest(openControlPlane(dbPath));
    // Four: the read-only verification connection, the in-memory scratch
    // database `expectedSchemaFingerprint` builds the DDL in while verifying,
    // the writable one -- and a second scratch database, because the returned
    // handle is verified AGAIN on itself.
    //
    // This count used to be three, with a comment arguing that verifying the
    // returned handle would mean "verifying a file it had already opened for
    // writing". That argument was wrong, and `migrator.ts` had already
    // disproved it: `openProductionControlPlane` has re-verified its own
    // handle since the pilot, because the read-only verification closes its
    // connection and leaves the file unobserved until the writable one opens.
    // Without the second pass this function can hand back a connection to a
    // database it never checked. Repaired under D-0023, and this assertion is
    // the pin inverted to match.
    expect(calls).toBe(4);
  });
});
