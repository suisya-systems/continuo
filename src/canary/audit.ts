/**
 * The writer audit over both stores, and the rollback comparison.
 *
 * Ported from interlock `src/claude_org_runtime/canary/audit.py` at `65f36c5`.
 *
 * **Item 10 rehearsal artifact (Issue #23, D-0022), throwaway by default
 * (D-0026).** Every report this module produces carries {@link
 * REHEARSAL_MARKING} in its `label` field: the *output* is labelled, not just
 * the code around it.
 *
 * **The audit boundary.** The existing fencing write history cannot answer item
 * 10's question: `writer_epoch` is a lease generation -- who held write
 * authority over a *resource*, in which epoch -- not a which-*system*
 * attribution, and it exists in only one of the two stores anyway. So the audit
 * is defined over three facts of the rehearsal's construction:
 *
 * - **The logical record key both stores share is the run.** A "record written
 *   by both systems" means: one `run_id` with state in both stores.
 * - **Attribution is physical presence.** Each store is written by exactly one
 *   system -- the S5 control-plane database by Interlock, the JSON-lines store
 *   by the synthetic counterparty -- so *which store a record sits in* is
 *   *which system wrote it*, with no writer column to trust or forge.
 * - **Enumeration is capture.** Every write path of either system lands in its
 *   own store (both stores are their system's only durable state), so listing a
 *   store's runs lists that system's writes -- all of them, not a sample.
 *
 * The audit therefore reads the stores themselves, never the ledger's opinion
 * of them, and then holds the ledger to account against what it found: a run
 * present in a store whose ledger row names the *other* system is misrouted
 * evidence, and a run present in a store with no ledger row at all is a write
 * that bypassed the routing point.
 *
 * **The audit is defined over quiescent stores.** Its three enumerations are
 * sequential reads, so a write landing between them could hide from one read
 * what another already missed; the caller provides the quiet window (the
 * rehearsal audits stores nothing else is writing). How an audit window is
 * carved out of a *live* canary -- quiesce, snapshot, or an explicit
 * boundary -- is part of the canary's own design and is deliberately not
 * pre-empted by a synthetic rehearsal, exactly as Q-0005's numeric criteria are
 * not. Nothing here locks, and nothing here should be read as if it did.
 *
 * **The rollback comparison.** "Rollback is a routing change, not a data
 * migration" is asserted as: across the rollback, both run stores are
 * **byte-identical** and so is the run ledger; only `routing_decision` rows were
 * appended. The bytes compared are a **canonical serialisation** (stable row
 * order, stable encoding), not the raw database file: SQLite's file bytes move
 * with page headers, freelists and journal state that carry no facts, so
 * raw-file identity would fail on a store nothing was written to -- and a
 * comparison that must be forgiven its false alarms is not evidence. A bare
 * row-set equality would be weaker in the other direction (it has no stated
 * encoding to be identical *in*), so the canonical stream is hashed and the
 * hashes compared.
 *
 * Three things the port has to say that Python did not have to:
 *
 * - **The canonical JSON renderer is imported, not rewritten.** Python's
 *   `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=True)`
 *   is stdlib and is therefore the same function on both sides of this module
 *   and `synthetic_v1.py`. Here it is {@link canonicalJson}, exported by
 *   `synthetic_v1.ts` for exactly this reason: two canonical encoders that can
 *   drift apart are the defect these digests exist to detect.
 * - **`json.dumps(default=...)` has no counterpart.** `JSON.stringify`'s
 *   `replacer` is not it, and `canonicalJson` has no hook at all, so the
 *   `default=` hook is applied by this module as a **pre-pass over each row
 *   value** ({@link canonicalValue}) before the row object reaches the encoder.
 *   Same observable, different seam.
 * - **A BLOB arrives as a `Buffer`.** `JSON.stringify` renders one as
 *   `{"type":"Buffer","data":[...]}` -- a silently different and enormous
 *   encoding, and one that Python never produces. The `Buffer` branch is
 *   intercepted in the pre-pass, ahead of any generic object handling.
 */

import { createHash } from "node:crypto";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { INTERLOCK, SYNTHETIC_V1 } from "./ledger.js";
import { REHEARSAL_MARKING } from "./marking.js";
import { canonicalJson, type SyntheticV1RunStore } from "./synthetic_v1.js";

// --------------------------------------------------------------------------
// canonical serialisation
// --------------------------------------------------------------------------

/**
 * A canonical byte stream of the database's schema objects and rows.
 *
 * Identity metadata first (`application_id` and `user_version` -- a changed
 * revision stamp is a changed store), then every schema object (a rollback that
 * only created, dropped or altered an object must move the digest even when no
 * row does), then tables in name order, rows in the order of their own
 * canonical encoding, values as sorted-keys JSON: two databases holding the
 * same facts serialise to the same bytes regardless of insertion order, page
 * layout or vacuum history.
 *
 * `excludeTables` is how the rollback comparison excludes exactly the routing
 * relation's **rows** and nothing else -- pragmas and schema objects, the
 * excluded table's own included, stay in the stream, so a rollback cannot hide
 * a mutation behind the very exclusion that licenses it.
 */
export function canonicalSqliteBytes(
  connection: SqliteDatabase,
  options: { readonly excludeTables?: readonly string[] } = {},
): Buffer {
  const excludeTables = options.excludeTables ?? [];

  // The store's identity metadata comes first: application_id and user_version
  // are how this codebase tells one store's revision from another, so a write
  // that changed either is a changed store even though neither lives in a
  // table.
  const lines: string[] = [
    canonicalJson({
      pragma: {
        application_id: connection.pragma("application_id", { simple: true }),
        user_version: connection.pragma("user_version", { simple: true }),
      },
    }),
  ];

  // Then every schema object: a stream of rows alone cannot see a rollback that
  // created or dropped an EMPTY table, or touched only an index or a trigger --
  // a mutation with no rows is still a mutation. `excludeTables` deliberately
  // does NOT reach in here: it excludes an excluded table's ROWS, never its
  // schema, because a rollback that dropped the routing relation's own
  // append-only trigger and then appended the expected row must not read as
  // "only the routing decision changed".
  const schemaObjects = connection
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
  for (const { type, name, sql } of schemaObjects) {
    // Python's `sql or ""`. A schema object can carry a NULL `sql` (SQLite
    // writes one for an index it created itself for a UNIQUE or PRIMARY KEY
    // constraint, and those survive the `sqlite_%` filter under their own
    // names); emitting `"sql":null` there would be a different byte stream from
    // the source's for every store that has one.
    lines.push(canonicalJson({ schema: { type, name, sql: sql ?? "" } }));
  }

  for (const table of userTables(connection)) {
    if (excludeTables.includes(table)) {
      continue;
    }
    // The identifier is interpolated inside double quotes, as in the source:
    // SQLite cannot bind an identifier, and switching to any parameterised form
    // would silently change which tables are visited. The names come from
    // `sqlite_master`, not from a caller.
    // `safeIntegers(true)`: SQLite's INTEGER is 64-bit and Python's `int` is
    // arbitrary precision, so the source's digest never loses a value. Read as
    // JavaScript `number`s, 9007199254740993 and 9007199254740992 collapse onto
    // one double and serialise identically -- a rollback that changed such a
    // value would be reported as leaving the store byte-identical, which is a
    // false negative in the one function the comparison's evidence rests on.
    // Every integer therefore arrives as a `bigint` and is rendered as its
    // decimal digits, which is byte-for-byte what `json.dumps` writes for a
    // Python `int`. Raised as [P1]/[P2] by the review gate; port-introduced, so
    // repaired here rather than disclosed (D-0023).
    const rows = connection.prepare(`SELECT * FROM "${table}"`).safeIntegers(true).all() as Record<
      string,
      unknown
    >[];
    const encoded = rows.map((row) => {
      const canonical: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(row)) {
        canonical[column] = canonicalValue(value);
      }
      return canonicalJson({ table, row: canonical });
    });
    // Sorted by the encoded line itself -- per table, never globally, and never
    // by primary key. This is the whole of the insertion-order defence: rowid
    // order, page layout and vacuum history all move the order rows come back
    // in, and none of them is a fact about the store.
    //
    // Python's `sorted()` on `str` compares by code point and JavaScript's
    // default comparator compares by UTF-16 code unit, which disagree above the
    // BMP -- but `ensure_ascii` has already escaped every character from
    // `U+007F` up, so every line here is pure ASCII and the two orders are the
    // same order. That is a property of the encoder, not a coincidence, which is
    // why it is worth saying once here rather than reaching for a code-point
    // comparator that could never see a difference.
    encoded.sort();
    lines.push(...encoded);
  }

  // The trailing newline is unconditional, so an empty stream is `b"\n"` rather
  // than `b""`. Every digest in this module would differ from the source's
  // without it.
  return Buffer.from(`${lines.join("\n")}\n`, "utf-8");
}

/**
 * The user tables of a store, in name order.
 *
 * `ORDER BY name` is SQLite's BINARY collation, done inside the query: a JS
 * re-sort compares differently, and a locale-aware one differs even for ASCII.
 */
function userTables(connection: SqliteDatabase): readonly string[] {
  return connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

/**
 * `json.dumps`'s `default=` hook, as a pre-pass over one column value.
 *
 * SQLite BLOBs, deterministically. A store column without a `typeof` CHECK
 * (S5's outbox payload, say) can legally hold bytes, and a canonicaliser that
 * crashed on one would make exactly the store it most needs to see -- an
 * unexpected write -- the one it cannot serialise. The blob is represented by
 * its digest and its length, never by its bytes: the canonical stream is UTF-8
 * text, and the bytes that most want auditing are exactly the ones that are not
 * valid UTF-8.
 *
 * Applied to values rather than passed to the encoder because `canonicalJson`
 * has no `default=` seam (see this module's header). The difference is
 * invisible from outside: Python's hook fires only for values `json` cannot
 * serialise, and every value this pre-pass leaves alone is one `json` could
 * serialise too.
 */
function canonicalValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    // `Buffer` is a `Uint8Array`, and the wider test is the honest one: what is
    // being asked is "is this a byte string", not "did better-sqlite3 hand back
    // its own subclass".
    return {
      $blob_sha256: createHash("sha256").update(value).digest("hex"),
      $bytes: value.length,
    };
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    // `bigint` is how every SQLite INTEGER arrives here, because the row read
    // above asks for safe integers. `canonicalJson` renders it as its decimal
    // digits, which is exactly what Python emits for the `int` the source sees.
    return value;
  }
  // Everything else takes the source's fallback, which in Python is reached
  // only through `default=`. Two kinds of value can arrive here, and both are
  // better loud than quiet:
  //
  // Only one kind of value reaches here now: anything a future driver returns
  // that is neither text, number, bigint, NULL nor bytes -- the case the
  // source's message is written for. `bigint` used to be refused here on the
  // reasoning that no encoding of it could match Python's bytes; that was wrong
  // in the one direction that mattered, since `json.dumps` writes a Python
  // `int` as its decimal digits and `BigInt.prototype.toString()` produces the
  // same digits. Rendering it is therefore the faithful choice, and refusing it
  // was the lossy one.
  throw new TypeError(`${typeNameOf(value)} is not canonically serialisable`);
}

/**
 * Python's `type(value).__name__`, as closely as JavaScript can say it.
 *
 * There is no exact counterpart -- the message names a *Python* type in the
 * source -- so the constructor's name is used where there is one and `typeof`
 * where there is not. Nothing a SQLite driver returns reaches this, and no
 * ported case exercises it; the sentence is reproduced because a refusal whose
 * text drifts is a refusal nobody can match on later.
 */
function typeNameOf(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  const maker = (value as { constructor?: { name?: string } }).constructor;
  return maker?.name ?? typeof value;
}

/**
 * The synthetic store's canonical bytes.
 *
 * Records are re-serialised through the same sorted-keys JSON as the SQLite side
 * rather than hashed as raw file bytes, so both stores are compared in one
 * stated encoding. File order is kept -- **no sorting** -- because the store is
 * append-only and its order is part of its history; unifying the two
 * canonicalisers under one "sort the lines" helper would throw that evidence
 * away and make two stores with the same records in different orders digest the
 * same.
 */
export function canonicalSyntheticBytes(store: SyntheticV1RunStore): Buffer {
  const lines = store.records().map((record) => canonicalJson(record));
  return Buffer.from(`${lines.join("\n")}\n`, "utf-8");
}

/** `hashlib.sha256(payload).hexdigest()`. */
function digest(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

// --------------------------------------------------------------------------
// the writer audit
// --------------------------------------------------------------------------

/** A `(system, run_id)` pair, as the source's 2-tuples. */
export type SystemRun = readonly [system: string, runId: string];

/**
 * What the audit found, labelled as the rehearsal output it is.
 *
 * `clean` is a reading aid; the fields are the evidence. A caller that wants the
 * acceptance criterion asserts `dualWritten.length === 0` itself -- the report
 * never collapses "no dual write" into a bare boolean it would then have to be
 * trusted about.
 *
 * Python's `@property clean` is a computed **field** here rather than a method
 * or a class: the source's report is a frozen dataclass whose only behaviour is
 * that one derivation, and an object frozen at construction with the value
 * already in it has the same observable surface with nothing to keep in step.
 */
export interface WriterAuditReport {
  readonly label: string;
  readonly interlockWritten: readonly string[];
  readonly syntheticV1Written: readonly string[];
  /**
   * Run ids with state in BOTH stores -- item 10's "record written by both
   * systems". The rehearsal requires this empty.
   */
  readonly dualWritten: readonly string[];
  /**
   * `(system, runId)` pairs present in a store but absent from the ledger:
   * writes that bypassed the routing point.
   */
  readonly unledgered: readonly SystemRun[];
  /**
   * `(system, runId)` pairs present in a store whose ledger row names the other
   * system.
   */
  readonly misrouted: readonly SystemRun[];
  readonly clean: boolean;
}

/**
 * Every run the store holds state for, from every table that keys on one.
 *
 * "Enumeration is capture" has to mean the whole store: a run present only in a
 * child table (a session, an outbox row, an incident) is still that system
 * writing about the run, and an audit that read only `run` would miss it. The
 * tables are discovered rather than listed, so a table added to the store later
 * is inside the audit by construction rather than by someone remembering to
 * extend a list here.
 */
export function sqliteRunIds(connection: SqliteDatabase): readonly string[] {
  const runIds = new Set<string>();
  for (const table of userTables(connection)) {
    // `PRAGMA table_info` rather than a `SELECT *` whose columns are read off
    // the statement: the probe must not read the table's rows to find out
    // whether it has the column, and a table with no `run_id` is not read at
    // all.
    const columns = new Set(
      (connection.pragma(`table_info("${table}")`) as { name: string }[]).map((row) => row.name),
    );
    if (!columns.has("run_id")) {
      continue;
    }
    const values = connection
      .prepare(`SELECT DISTINCT run_id FROM "${table}" WHERE run_id IS NOT NULL`)
      .pluck()
      .all();
    for (const value of values) {
      runIds.add(runIdOf(value));
    }
  }
  return [...runIds].sort(byCodePoint);
}

/**
 * Rule 9: a `run_id` column is TEXT by declaration, and SQLite's type affinity
 * makes that a preference rather than a constraint, so a foreign writer can
 * leave an integer there. Python would put the `int` in the set and then raise
 * `TypeError` from `sorted()` on the mixed set; nothing here can raise that, so
 * the value is rendered. The source type-checks nothing, so neither does this.
 */
function runIdOf(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * Python's ordering for `sorted()`, which is by **code point**. JavaScript's
 * default comparator is by UTF-16 code unit, and the two disagree above the
 * BMP: a leading surrogate is `0xD800`..`0xDBFF`, so an astral character sorts
 * *below* `U+E000`..`U+FFFF` under code units and *above* them under code
 * points.
 *
 * The canonical row lines do not need this (they are ASCII by construction --
 * see {@link canonicalSqliteBytes}), but run ids come from the store as they
 * were written, and `synthetic_v1.ts` sorts its own side by code point. A
 * comparison whose two sides sort differently is a comparison that reports a
 * difference nobody made, so this side sorts the same way. The comparator is
 * repeated here rather than imported because `synthetic_v1.ts` keeps it
 * private; it carries no state and cannot drift the way a second *encoder*
 * could, which is the duplication that would actually matter.
 */
function byCodePoint(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    // Both are in range; the `??` arms are unreachable and are here because
    // `noUncheckedIndexedAccess` types the element as possibly undefined and a
    // non-null assertion would be the wrong way to say it.
    const a = (leftPoints[index] ?? "").codePointAt(0) ?? 0;
    const b = (rightPoints[index] ?? "").codePointAt(0) ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
}

/** Audit both stores against each other, then against the ledger. */
export function writerAudit(
  ledgerConnection: SqliteDatabase,
  interlockConnection: SqliteDatabase,
  syntheticStore: SyntheticV1RunStore,
): WriterAuditReport {
  const interlockWritten = sqliteRunIds(interlockConnection);
  const syntheticWritten = syntheticStore.runIds();
  const syntheticSet = new Set(syntheticWritten);
  const dualWritten = interlockWritten.filter((runId) => syntheticSet.has(runId)).sort(byCodePoint);

  // The ledger's opinion, read once. Note what is NOT read: no routing
  // decision, no "current owner" -- an empty ledger is a legitimate input (the
  // rogue-write case has one), and asking it for a current route would turn
  // that into a refusal.
  const ownerOf = new Map(
    (
      ledgerConnection.prepare("SELECT run_id, owning_system FROM run_owner").all() as {
        run_id: string;
        owning_system: string;
      }[]
    ).map((row) => [row.run_id, row.owning_system]),
  );

  const unledgered: SystemRun[] = [];
  const misrouted: SystemRun[] = [];
  // The iteration order fixes the order of both lists: every interlock pair
  // first, then every synthetic pair, each in its store's own (sorted) run
  // order. The ported cases compare these positionally, so a port that
  // rebuilt them from a Map or re-sorted the combined list would pass a
  // set-shaped assertion and fail these.
  for (const [system, written] of [
    [INTERLOCK, interlockWritten],
    [SYNTHETIC_V1, syntheticWritten],
  ] as const) {
    for (const runId of written) {
      const recorded = ownerOf.get(runId);
      if (recorded === undefined) {
        unledgered.push([system, runId]);
      } else if (recorded !== system) {
        misrouted.push([system, runId]);
      }
    }
  }

  return Object.freeze({
    label: REHEARSAL_MARKING,
    interlockWritten,
    syntheticV1Written: syntheticWritten,
    dualWritten,
    unledgered,
    misrouted,
    clean: !(dualWritten.length > 0 || unledgered.length > 0 || misrouted.length > 0),
  });
}

// --------------------------------------------------------------------------
// the rollback comparison
// --------------------------------------------------------------------------

/** One `routing_decision` row: `(decision_seq, owning_system, decided_at_ms, reason)`. */
export type RoutingDecisionRow = readonly [
  decisionSeq: number,
  owningSystem: string,
  decidedAtMs: number,
  reason: string,
];

/**
 * Both stores and the ledger, canonically serialised at one instant.
 *
 * Exactly four members, and a ported case constructs one by hand from another's
 * fields -- so an extra required member here would break that construction as
 * surely as a missing one.
 */
export interface StoreSnapshot {
  readonly interlockDigest: string;
  readonly syntheticV1Digest: string;
  /** The ledger *minus* the routing relation: `run_owner` rows, digested. */
  readonly runLedgerDigest: string;
  /**
   * The routing relation itself, kept as rows rather than a digest so the
   * comparison can say WHAT was appended, not merely that something was.
   */
  readonly routingDecisionRows: readonly RoutingDecisionRow[];
}

export function snapshotStores(
  ledgerConnection: SqliteDatabase,
  interlockConnection: SqliteDatabase,
  syntheticStore: SyntheticV1RunStore,
): StoreSnapshot {
  return Object.freeze({
    interlockDigest: digest(canonicalSqliteBytes(interlockConnection)),
    syntheticV1Digest: digest(canonicalSyntheticBytes(syntheticStore)),
    runLedgerDigest: digest(
      canonicalSqliteBytes(ledgerConnection, { excludeTables: ["routing_decision"] }),
    ),
    routingDecisionRows: (
      ledgerConnection
        .prepare(
          "SELECT decision_seq, owning_system, decided_at_ms, reason " +
            "  FROM routing_decision ORDER BY decision_seq",
        )
        .raw()
        .all() as unknown[][]
    ).map(
      // `.raw()` gives each row as an array in the SELECT's column order, which
      // is Python's `tuple(row)`. Frozen because the snapshot is a value and one
      // ported case passes the same snapshot in as both `before` and `after`.
      (row) => Object.freeze(row) as unknown as RoutingDecisionRow,
    ),
  });
}

/**
 * Two snapshots compared across a rehearsed rollback, labelled.
 *
 * The claim under test is D-0022's: a rollback changes **only the routing
 * decision**. `onlyTheRoutingDecisionChanged` is that sentence as a predicate --
 * both run stores byte-identical, the run ledger byte-identical, and the routing
 * history only ever appended to, never rewritten -- and the fields are the
 * evidence for each clause.
 *
 * The predicate deliberately does NOT assert that anything was appended: it
 * answers "did the rollback touch anything beyond routing?", not "did a rollback
 * happen?". Two identical snapshots satisfy it vacuously. A caller asserting a
 * rehearsed (or real) rollback must therefore also hold `appendedDecisions` to
 * the decision it expects, which is what the rehearsal test does -- the two
 * questions are separate on purpose, so that neither can stand in for the other.
 */
export interface RollbackComparison {
  readonly label: string;
  readonly interlockIdentical: boolean;
  readonly syntheticV1Identical: boolean;
  readonly runLedgerIdentical: boolean;
  /**
   * True iff the earlier routing history is an untouched prefix of the later
   * one -- appended to, never edited or truncated.
   */
  readonly decisionsAppendedOnly: boolean;
  /** The `routing_decision` rows the rollback appended. */
  readonly appendedDecisions: readonly RoutingDecisionRow[];
  readonly onlyTheRoutingDecisionChanged: boolean;
}

export function compareAcrossRollback(
  before: StoreSnapshot,
  after: StoreSnapshot,
): RollbackComparison {
  const prefix = after.routingDecisionRows.slice(0, before.routingDecisionRows.length);
  // Python compares two tuples of tuples with `==`, which is structural all the
  // way down. JavaScript's `===` on arrays is identity, so the comparison is
  // spelled out -- and it has to be, because the rows on the two sides came
  // from two separate reads and are never the same objects.
  //
  // A shorter `after` makes `prefix` shorter than `before` and so unequal:
  // truncation is a rewritten history, not a smaller append.
  const decisionsAppendedOnly =
    prefix.length === before.routingDecisionRows.length &&
    prefix.every((row, index) => rowsEqual(row, before.routingDecisionRows[index]));

  const interlockIdentical = before.interlockDigest === after.interlockDigest;
  const syntheticV1Identical = before.syntheticV1Digest === after.syntheticV1Digest;
  const runLedgerIdentical = before.runLedgerDigest === after.runLedgerDigest;

  return Object.freeze({
    label: REHEARSAL_MARKING,
    interlockIdentical,
    syntheticV1Identical,
    runLedgerIdentical,
    decisionsAppendedOnly,
    // Empty whenever the prefix check failed, deliberately: a suffix taken off
    // a rewritten history is not "what was appended", and reporting one would
    // dress a rewrite up as a rollback.
    appendedDecisions: decisionsAppendedOnly
      ? after.routingDecisionRows.slice(before.routingDecisionRows.length)
      : [],
    onlyTheRoutingDecisionChanged:
      interlockIdentical && syntheticV1Identical && runLedgerIdentical && decisionsAppendedOnly,
  });
}

/** Two routing rows, compared the way Python compares two tuples. */
function rowsEqual(left: RoutingDecisionRow, right: RoutingDecisionRow | undefined): boolean {
  if (right === undefined) {
    return false;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
