import { createHash } from "node:crypto";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { TOOL_VERSION } from "../about.js";
import { appliedMigrations, PRODUCTION_APPLICATION_ID } from "../control_plane/migrator.js";
import { revisionOverPeriod } from "../control_plane/policy.js";
import { pythonJsonString } from "../control_plane/python_json.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { comparePythonStrings, pythonFloatRepr, pythonRepr } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";

export { TOOL_VERSION };

/**
 * G6 -- the header every report carries about itself, so it can be recomputed.
 *
 * The failure this module is written against is the one
 * `docs/measurement-harness.md` section 6 opens with: **a report that cannot be
 * recomputed later is an opinion.** A rate printed on its own is unfalsifiable
 * six weeks later, when the question is not "what did it say" but "was it
 * right" -- and answering that needs the database it was read from, the
 * migration head that shaped that database, the policy numbers every latency
 * was judged against, the detector build that produced the incidents, the
 * queries that were actually run, and the corpus the recall was measured over.
 * None of those are recoverable from the number. Each one of them changes the
 * number.
 *
 * So the header is not decoration on the report; it is the part of the report
 * that makes the rest of it a measurement. Section 6's table is reproduced here
 * field for field, and both renderings are generated from
 * {@link ReportHeader.asMapping} -- one mapping, two formatters -- so a field
 * cannot be present in the JSON and missing from the Markdown. Two renderings
 * that are allowed to drift are two different claims about the same run, and
 * the one the reader happens to have is the one that is wrong.
 *
 * **The fingerprint is the field that does the work, and its cheap form does
 * not do it.** Section 6 records the alternative that was considered and
 * rejected: row counts plus `MAX(seq)` / `MAX(rowid)`. The reason it fails is a
 * property of this schema, not a matter of taste. Most of the state a report
 * reads is *updated in place* -- a verdict projection, an `outbox` status, a
 * `gate` outcome, a `usage_status` backfilled by a late adapter after the
 * provider finally answered. Every one of those edits changes what the report
 * says. **Not one of them changes a row count or a maximum.** An aggregate
 * fingerprint would therefore stamp two materially different reads with the
 * same digest and certify them as the same content -- which is the exact claim
 * the provenance header exists to make, so the cheap form is not a weaker
 * version of the field, it is a false version of it. {@link FINGERPRINT_CONTENT}
 * is a sha256 over the *ordered rows* of every table the report read; it is the
 * default, and its cost is linear in rows read, which section 6 puts in the low
 * thousands per week-long period. {@link FINGERPRINT_AGGREGATE} remains
 * available for an interactive spot-check, and a report generated that way
 * carries {@link AGGREGATE_STATEMENT} in the header -- in both renderings --
 * saying in terms that its fingerprint does not establish identity of content.
 *
 * **Non-homogeneity is announced, never averaged over.** More than one
 * `detector_version` in the period, or a `policy_revision_id` that changed
 * inside it, means the period contains two different instruments. Section 6:
 * averaging across that is comparing two detectors and calling it a trend. The
 * banner is {@link ReportHeader.banner}, it is the first thing both renderers
 * emit, and it is emitted from the shared mapping rather than passed in by a
 * caller -- there is no code path through this module that renders a header
 * without it, and no argument that suppresses it. A homogeneous period gets the
 * banner too, saying so; a silent header would be indistinguishable from one
 * produced by code that did not look.
 *
 * **The version-valued fields are sets, and stay sets.** `detectorVersions` and
 * `adapterVersions` expose every value observed in the period. `Q-0009` -- what
 * cross-version compatibility means -- **is open** (section 7), so this
 * module's whole obligation is to expose the set; resolving it to a single
 * value here would answer `Q-0009` by inertia, and would do it invisibly, since
 * a collapsed set looks exactly like a period that only ever had one version.
 *
 * **The queries are data.** Every query the report ran is carried as text with
 * a sha256 over the set, in the same spirit as the spike's
 * `RECONSTRUCTION_QUERIES` (`D-0040`): a reader who disbelieves the number can
 * run them by hand. That is also why the digest is over the *text* -- a query
 * whose `>=` became a `>` moves the number and moves nothing else in the
 * header.
 *
 * Nothing here writes, nothing here reads a clock: `generatedAtMs` is injected,
 * like every other instant in this package (`time-base-policy.md` section 2),
 * and `TOOL_VERSION` comes from the package's own `about.ts` rather than a
 * literal, so a build cannot report a version it is not.
 *
 * Out of scope, and not implied: this module composes no report. It builds the
 * header a report carries; the sections that produce the figures are
 * {@link ./ac9.js}, {@link ./latency.js}, {@link ./shadow.js},
 * {@link ./false-termination.js} and {@link ./fixtures.js}, and the reconcile
 * driver that would act on any of it is not on this branch at all.
 */

/**
 * The two fingerprint modes of section 6. `content` is the field as specified;
 * `aggregate` is the rejected cheap form, kept reachable for an interactive
 * spot-check and stamped as what it is wherever it appears.
 */
export const FINGERPRINT_CONTENT = "content";
export const FINGERPRINT_AGGREGATE = "aggregate";
export const FINGERPRINT_MODES: readonly string[] = frozenList([
  FINGERPRINT_CONTENT,
  FINGERPRINT_AGGREGATE,
]);

/**
 * The sentence a content-mode report makes. Said here once so the renderers,
 * the JSON and the tests cannot disagree about what the digest claims.
 */
export const CONTENT_STATEMENT =
  "sha256 over the ordered rows of every table read - two reports carrying " +
  "this digest were computed over the same content";

/**
 * The sentence an aggregate-mode report is required by section 6 to make. It is
 * not a caveat about precision: an in-place UPDATE (a verdict projection, an
 * outbox status, a gate outcome, a usage_status backfilled by a late adapter)
 * changes the report and moves no count and no maximum, so this digest can be
 * equal across two reads that say different things.
 */
export const AGGREGATE_STATEMENT =
  "WEAKER MODE - this fingerprint does NOT establish identity of content. " +
  "It is row counts plus MAX(seq)/MAX(rowid), and state this report reads is " +
  "updated in place (verdict projection, outbox status, gate outcome, " +
  "usage_status backfilled by a late adapter): every one of those changes " +
  "the answer and none of them changes a count or a maximum";

/**
 * Section 2.4's two imputation rules, in the words that section uses for them.
 * Carried in the header so a reader can recompute under a different rule, which
 * is the reason section 2.4 gives for recording them at all.
 */
export const BOUNDED_IMPUTATION_RULE =
  "missing invocations imputed at max_output_tokens * model_response_count " +
  "(the caller's own per-request ceiling) - a genuine LOWER BOUND on the " +
  "reduction";
export const SENSITIVITY_IMPUTATION_RULE =
  "missing invocations imputed at the p95 of the covered distribution - an " +
  "ASSUMPTION, not a bound: a percentile of the observed sample does not " +
  "bound the unobserved values";

const BANNER_RULE = `!! ${"=".repeat(68)} !!`;

/**
 * A header that cannot be built truthfully, refused rather than approximated.
 *
 * Under {@link ControlPlaneRefusal} like every other refusal in the harness: a
 * caller catching the family catches these too, and no caller has to know that
 * the provenance header has its own hierarchy in order to stop when it cannot
 * be produced.
 */
export class ProvenanceRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ProvenanceRefusal";
    Object.setPrototypeOf(this, ProvenanceRefusal.prototype);
  }
}

/** The half-open period is empty, inverted, or not epoch milliseconds. */
export class PeriodRefused extends ProvenanceRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PeriodRefused";
    Object.setPrototypeOf(this, PeriodRefused.prototype);
  }
}

/**
 * The file is not the production control plane the header would claim it is.
 *
 * Section 6 has `application_id` on the header so a report *states* which
 * database it was over and that it was a production one. A header built over a
 * spike database would make that statement falsely, in the one field a later
 * reader would use to check it.
 */
export class NotAProductionDatabase extends ProvenanceRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "NotAProductionDatabase";
    Object.setPrototypeOf(this, NotAProductionDatabase.prototype);
  }
}

/** An unknown fingerprint mode, or a mode this build cannot compute. */
export class FingerprintModeRefused extends ProvenanceRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "FingerprintModeRefused";
    Object.setPrototypeOf(this, FingerprintModeRefused.prototype);
  }
}

/**
 * A table named for fingerprinting is not a table in this database.
 *
 * Refused rather than skipped. A skipped table hashes to nothing and the digest
 * still comes out looking like a fingerprint, so a typo in the table list would
 * silently narrow what the digest covers -- and narrowing it is exactly the
 * failure the field exists to prevent.
 */
export class TableNotReadable extends ProvenanceRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "TableNotReadable";
    Object.setPrototypeOf(this, TableNotReadable.prototype);
  }
}

/** The query set is empty, or one name carries two different texts. */
export class QueryDefinitionsRefused extends ProvenanceRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "QueryDefinitionsRefused";
    Object.setPrototypeOf(this, QueryDefinitionsRefused.prototype);
  }
}

/**
 * The bound policy revision was not in force anywhere in the period.
 *
 * Every latency judgement in the report is against that revision's numbers
 * (`time-base-policy.md` section 1), so a report bound to a revision the period
 * never ran under is mislabelled in the field a reader would use to recompute
 * it.
 */
export class RevisionNotInPeriod extends ProvenanceRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RevisionNotInPeriod";
    Object.setPrototypeOf(this, RevisionNotInPeriod.prototype);
  }
}

// --------------------------------------------------------------------------
// instants
// --------------------------------------------------------------------------

/**
 * `instantMs` as UTC ISO-8601 with milliseconds, e.g. `...T00:00:00.000Z`.
 *
 * Section 6 requires the period bounds printed as **both** epoch ms and
 * ISO-8601, and both for the same reason: the epoch value is what a query binds
 * and the ISO value is what a human checks against the incident they remember.
 * Printing one of them makes the other a mental arithmetic problem, and a
 * reader doing epoch arithmetic in their head is how a report gets read against
 * the wrong day.
 *
 * UTC, always, with a literal `Z`: a local-time rendering of a period bound is
 * ambiguous twice a year in exactly the way that makes two reports over "the
 * same day" disagree.
 */
export function iso8601Ms(instantMs: number): string {
  if (!Number.isSafeInteger(instantMs)) {
    // Safe, not merely integral (D-0007): Python's int is unbounded and this
    // check is `isinstance(instant_ms, int)`, but past 2^53 a JavaScript number
    // no longer names one instant, so a header printing it would state a
    // millisecond the query did not bind.
    throw new PeriodRefused(`${pythonRepr(String(instantMs))} is not epoch milliseconds`);
  }
  if (instantMs < 0) {
    throw new PeriodRefused(
      `${instantMs} is before the epoch; the control plane's instants are ` +
        "non-negative epoch milliseconds (time-base-policy.md section 2)",
    );
  }
  if (instantMs > MAX_ISO_INSTANT_MS) {
    // Python raises OverflowError here, from datetime's year 9999 ceiling,
    // rather than a PeriodRefused. Reproduced as a refusal in the family the
    // caller is already catching: an instant this module cannot render is one
    // the header cannot state, and the source's own message for the case is an
    // arithmetic error rather than an explanation.
    throw new PeriodRefused(
      `${instantMs} is past 9999-12-31T23:59:59.999Z, which is the last instant ` +
        "an ISO-8601 timestamp with a four-digit year can name",
    );
  }
  return new Date(instantMs).toISOString();
}

/** `9999-12-31T23:59:59.999Z`, where Python's `datetime` stops. */
const MAX_ISO_INSTANT_MS = 253_402_300_799_999;

function requirePeriod(periodStartMs: number, periodEndMs: number): void {
  iso8601Ms(periodStartMs);
  iso8601Ms(periodEndMs);
  if (periodEndMs <= periodStartMs) {
    throw new PeriodRefused(
      `[${periodStartMs}, ${periodEndMs}) is empty or inverted; the report ` +
        "period is half-open and must contain at least one millisecond " +
        "(time-base-policy.md section 2, rule 4)",
    );
  }
}

// --------------------------------------------------------------------------
// the fingerprint
// --------------------------------------------------------------------------

/**
 * One digest over the tables a report read, and what that digest proves.
 *
 * {@link DatabaseFingerprint.statement} travels with the digest rather than
 * being looked up by a renderer, because the difference between the two modes
 * is not a difference in strength that a reader can be expected to infer from
 * the word `aggregate`: one of them establishes identity of content and the
 * other cannot, and which one produced a given report is a fact about that
 * report.
 */
export class DatabaseFingerprint {
  readonly mode: string;
  readonly digest: string;
  readonly tables: readonly string[];

  constructor(fields: {
    readonly mode: string;
    readonly digest: string;
    readonly tables: readonly string[];
  }) {
    this.mode = fields.mode;
    this.digest = fields.digest;
    this.tables = frozenList(fields.tables);
    Object.freeze(this);
  }

  get establishesContentIdentity(): boolean {
    return this.mode === FINGERPRINT_CONTENT;
  }

  get statement(): string {
    return this.establishesContentIdentity ? CONTENT_STATEMENT : AGGREGATE_STATEMENT;
  }
}

/**
 * Fingerprint the content of `tables`, in {@link FINGERPRINT_CONTENT} by default.
 *
 * The default is the strong mode on purpose: section 6 makes the content hash
 * the field, and the aggregate form something a caller must *ask* for. A
 * default that had to be argued down would put the weaker claim on every report
 * written by a caller who did not know there was a choice.
 *
 * Content mode hashes, per table in a canonical order: the table name, its
 * column names, then every row, ordered by all of its columns and encoded with
 * a type tag and an explicit length per value. The type tag is why `1` and
 * `'1'` do not collide -- SQLite's columns are not typed, and a value that
 * changed from an integer to its own decimal string is a change a report can
 * see. The length prefix is why `('a', 'bc')` and `('ab', 'c')` do not. The
 * column names are in the hash so a schema change under a report's feet moves
 * the digest even where no row moved.
 *
 * Ordering by every column rather than by `rowid` keeps the digest a function
 * of *content*: a table rebuilt by a `VACUUM` renumbers rowids and changes
 * nothing a report can read, and a digest that moved for that would cry wolf at
 * exactly the reader who is trying to establish that two reads agree.
 *
 * Aggregate mode is section 6's rejected form, reproduced faithfully so that
 * the thing it fails to notice is demonstrable: `COUNT(*)` plus `MAX(seq)`
 * where the table has a `seq` column and `MAX(rowid)` otherwise.
 */
export function fingerprintDatabase(
  connection: SqliteDatabase,
  options: { readonly tables: readonly string[]; readonly mode?: string },
): DatabaseFingerprint {
  const { tables } = options;
  const mode = options.mode ?? FINGERPRINT_CONTENT;

  if (!FINGERPRINT_MODES.includes(mode)) {
    throw new FingerprintModeRefused(
      `${pythonRepr(mode)} is not a fingerprint mode; expected one of ` +
        `${FINGERPRINT_MODES.join(", ")}`,
    );
  }
  if (tables.length === 0) {
    throw new TableNotReadable(
      "no tables named for the fingerprint; a digest over nothing is equal " +
        "for every database, which is the opposite of what the field asserts " +
        "(measurement-harness.md section 6)",
    );
  }

  const ordered = frozenList([...new Set(tables)].sort(comparePythonStrings));
  if (ordered.length !== tables.length) {
    throw new TableNotReadable(
      `the fingerprint table list repeats a table: ${pythonTupleOfStrings(tables)}; a ` +
        "table hashed twice makes the digest depend on how the list was " +
        "written rather than on what was read",
    );
  }

  const hasher = createHash("sha256");
  hasher.update(Buffer.from(mode, "utf8"));
  for (const table of ordered) {
    const columns = columnsOf(connection, table);
    feed(hasher, "T", Buffer.from(table, "utf8"));
    for (const column of columns) {
      feed(hasher, "C", Buffer.from(column, "utf8"));
    }
    if (mode === FINGERPRINT_CONTENT) {
      feedRows(hasher, connection, table, columns);
    } else {
      feedAggregate(hasher, connection, table, columns);
    }
  }

  return new DatabaseFingerprint({ mode, digest: hasher.digest("hex"), tables: ordered });
}

/** Python's `repr()` of a tuple of table names, for the duplicate refusal. */
function pythonTupleOfStrings(values: readonly string[]): string {
  if (values.length === 1) {
    return `(${pythonRepr(values[0] as string)},)`;
  }
  return `(${values.map((value) => pythonRepr(value)).join(", ")})`;
}

function columnsOf(connection: SqliteDatabase, table: string): readonly string[] {
  const row = connection
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  if (row === undefined) {
    throw new TableNotReadable(
      `${pythonRepr(table)} is not a table in this database; the report cannot ` +
        "claim a fingerprint over a table it did not read",
    );
  }
  const columns = (
    connection.prepare(`PRAGMA table_info("${quoted(table)}")`).all() as { name: string }[]
  ).map((info) => String(info.name));
  if (columns.length === 0) {
    throw new TableNotReadable(`${pythonRepr(table)} has no columns to fingerprint`);
  }
  return columns;
}

/**
 * SQLite identifier quoting: a literal `"` inside a name is doubled.
 *
 * Table names reach here from a caller's list, and the only safe way to put a
 * caller-supplied identifier into SQL -- which cannot be a bound parameter --
 * is to quote it explicitly rather than to trust that it looks harmless.
 */
function quoted(identifier: string): string {
  return identifier.replaceAll('"', '""');
}

/**
 * Append one tagged, length-prefixed field to the digest.
 *
 * Both parts are load-bearing. Without the tag an integer and its decimal
 * string hash alike, and SQLite will store either in the same column. Without
 * the length two adjacent values can be re-split without changing the
 * concatenation, so a digest could be equal for two different rows.
 */
function feed(hasher: ReturnType<typeof createHash>, tag: string, payload: Buffer): void {
  hasher.update(Buffer.from(tag, "ascii"));
  hasher.update(Buffer.from(String(payload.length), "ascii"));
  hasher.update(Buffer.from(":", "ascii"));
  hasher.update(payload);
}

/**
 * One SQLite value, tagged by its storage class.
 *
 * The five branches are Python's, and reaching them needs one adaptation.
 * `sqlite3` hands Python an `int` for an INTEGER column and a `float` for a
 * REAL one, so `isinstance` separates them; better-sqlite3 returns a JavaScript
 * number for both, and `1` and `1.0` would hash alike -- collapsing exactly the
 * distinction the type tag exists to make. The statement that reads the rows
 * therefore runs with `safeIntegers(true)`, which returns every INTEGER as a
 * BigInt, so `typeof` recovers the same five-way split. It also makes the
 * digest exact past 2^53, where a JavaScript number would silently round the
 * value being hashed (D-0007).
 */
function feedValue(hasher: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null) {
    feed(hasher, "N", Buffer.alloc(0));
  } else if (typeof value === "bigint") {
    feed(hasher, "i", Buffer.from(value.toString(), "ascii"));
  } else if (typeof value === "number") {
    feed(hasher, "f", Buffer.from(pythonFloatRepr(value), "ascii"));
  } else if (value instanceof Uint8Array) {
    feed(hasher, "b", Buffer.from(value));
  } else {
    feed(hasher, "s", Buffer.from(String(value), "utf8"));
  }
}

function feedRows(
  hasher: ReturnType<typeof createHash>,
  connection: SqliteDatabase,
  table: string,
  columns: readonly string[],
): void {
  const projection = columns.map((column) => `"${quoted(column)}"`).join(", ");
  const statement = `SELECT ${projection} FROM "${quoted(table)}" ORDER BY ${projection}`;
  const rows = connection.prepare(statement).raw().safeIntegers(true).all() as unknown[][];
  for (const row of rows) {
    feed(hasher, "R", Buffer.from(String(row.length), "ascii"));
    for (const value of row) {
      feedValue(hasher, value);
    }
  }
}

function feedAggregate(
  hasher: ReturnType<typeof createHash>,
  connection: SqliteDatabase,
  table: string,
  columns: readonly string[],
): void {
  const maximum = columns.includes("seq") ? "MAX(seq)" : "MAX(rowid)";
  const row = connection
    .prepare(`SELECT COUNT(*), ${maximum} FROM "${quoted(table)}"`)
    .raw()
    .safeIntegers(true)
    .get() as unknown[];
  feed(hasher, "A", Buffer.from(maximum, "ascii"));
  feedValue(hasher, row[0]);
  feedValue(hasher, row[1]);
}

// --------------------------------------------------------------------------
// the query set
// --------------------------------------------------------------------------

/**
 * Every query the report ran, as text, plus a sha256 over the set.
 *
 * The digest is over the *text* of each query paired with its name. A query
 * whose `>=` became a `>` produces a different report and changes nothing else
 * in the header, so the digest is the only field that can notice it; and the
 * text is carried in full because section 6's point is that a reader can run
 * them by hand, which a digest alone does not permit.
 */
export class QueryCatalogue {
  readonly definitions: ReadonlyMap<string, string>;
  readonly digest: string;

  constructor(fields: {
    readonly definitions: ReadonlyMap<string, string>;
    readonly digest: string;
  }) {
    this.definitions = fields.definitions;
    this.digest = fields.digest;
    Object.freeze(this);
  }
}

/**
 * Build the catalogue, refusing an empty set and a name used twice.
 *
 * An empty set is refused because a report always ran at least the header's own
 * queries: an empty `query_definitions` would mean the report cannot say what
 * it read, which is section 6's failure exactly.
 */
export function queryCatalogue(definitions: ReadonlyMap<string, string>): QueryCatalogue {
  if (definitions.size === 0) {
    throw new QueryDefinitionsRefused(
      "a report ran at least one query; an empty query_definitions set leaves " +
        "the reader nothing to run by hand (measurement-harness.md section 6)",
    );
  }
  const ordered = [...definitions.entries()].sort(([left], [right]) =>
    comparePythonStrings(left, right),
  );
  const hasher = createHash("sha256");
  for (const [name, text] of ordered) {
    if (!name) {
      throw new QueryDefinitionsRefused(`${pythonRepr(name)} is not a query name`);
    }
    if (text.trim() === "") {
      throw new QueryDefinitionsRefused(
        `query ${pythonRepr(name)} carries no text; the queries are the data ` +
          "here, and a named query with no body is a name",
      );
    }
    feed(hasher, "Q", Buffer.from(name, "utf8"));
    feed(hasher, "S", Buffer.from(text, "utf8"));
  }
  return new QueryCatalogue({
    definitions: readOnlyMap(ordered),
    digest: hasher.digest("hex"),
  });
}

function mergeQueries(
  ...sets: readonly ReadonlyMap<string, string>[]
): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const definitions of sets) {
    for (const [name, text] of definitions) {
      const existing = merged.get(name);
      if (existing !== undefined && existing !== text) {
        throw new QueryDefinitionsRefused(
          `query name ${pythonRepr(name)} carries two different texts; the ` +
            "digest would be over one of them and the report would have run " +
            "the other",
        );
      }
      merged.set(name, text);
    }
  }
  return merged;
}

/**
 * The queries this module itself runs. They are in the catalogue for the same
 * reason every other query is: a reader recomputing `detectorVersions` needs to
 * know it was taken over `incident.created_at_ms` half-open, not over
 * `resolved_at_ms`, and not over every incident in the database.
 */
export const DETECTOR_VERSIONS_QUERY = `
SELECT DISTINCT detector_version
  FROM incident
 WHERE created_at_ms >= :period_start_ms
   AND created_at_ms <  :period_end_ms
 ORDER BY detector_version
`;

export const ADAPTER_VERSIONS_QUERY = `
SELECT DISTINCT adapter_version
  FROM ai_invocation
 WHERE started_at_ms >= :period_start_ms
   AND started_at_ms <  :period_end_ms
 ORDER BY adapter_version
`;

export const HEADER_QUERIES: ReadonlyMap<string, string> = readOnlyMap([
  ["provenance_detector_versions", DETECTOR_VERSIONS_QUERY],
  ["provenance_adapter_versions", ADAPTER_VERSIONS_QUERY],
]);

// --------------------------------------------------------------------------
// the remaining header parts
// --------------------------------------------------------------------------

/**
 * Version *and* name of the newest applied step, as section 6 asks.
 *
 * The version alone would not survive the ledger being rewritten during
 * development, and the name alone does not order. Together they say which shape
 * of the schema the numbers came off.
 */
export class SchemaMigrationHead {
  readonly version: number;
  readonly name: string;

  constructor(fields: { readonly version: number; readonly name: string }) {
    this.version = fields.version;
    this.name = fields.name;
    Object.freeze(this);
  }
}

/**
 * Commit and split case count of the labelled corpus, or a stated absence.
 *
 * `absentReason` rather than `null` for a report that measured no recall: a
 * missing `fixture_suite_ref` reads as "the corpus was not recorded", which is
 * a defect in the report, and this makes "there was no corpus in this report" a
 * different, statable thing.
 *
 * The split matters (section 3.2): a miss rate over a corpus with no negatives
 * is a number a detector that alarms on everything scores perfectly on, so
 * `positive` and `negative` are separate fields and never one total.
 */
export class FixtureSuiteRef {
  readonly commit: string | null;
  readonly positive: number | null;
  readonly negative: number | null;
  readonly contentDigest: string | null;
  readonly absentReason: string | null;

  constructor(fields: {
    readonly commit: string | null;
    readonly positive: number | null;
    readonly negative: number | null;
    readonly contentDigest: string | null;
    readonly absentReason?: string | null;
  }) {
    this.commit = fields.commit;
    this.positive = fields.positive;
    this.negative = fields.negative;
    this.contentDigest = fields.contentDigest;
    this.absentReason = fields.absentReason ?? null;
    Object.freeze(this);
  }

  static absent(reason: string): FixtureSuiteRef {
    if (reason.trim() === "") {
      throw new ProvenanceRefusal(
        "state why this report carries no fixture suite; an unexplained " +
          "absence is indistinguishable from a report that forgot to record one",
      );
    }
    return new FixtureSuiteRef({
      commit: null,
      positive: null,
      negative: null,
      contentDigest: null,
      absentReason: reason,
    });
  }

  get total(): number | null {
    if (this.positive === null || this.negative === null) {
      return null;
    }
    return this.positive + this.negative;
  }
}

/**
 * Section 6's `fixture_suite_ref` from a loaded corpus and its commit.
 *
 * `commit` is a required argument with no default and is not derived here: the
 * corpus lives in the repository, its commit is a fact about the checkout the
 * report ran from, and a module that guessed it (by shelling out to git, say)
 * would be recording the commit of whatever tree it happened to run in rather
 * than the one the cases came from.
 *
 * The corpus's own `contentDigest` is carried alongside the commit because a
 * commit identifies the tree and not the working copy: an edited label that was
 * never committed changes every number the report prints and moves no commit at
 * all -- the same argument section 6 makes for `db_fingerprint` being content
 * rather than counts.
 */
export function fixtureSuiteRef(
  corpus: {
    composition(): ReadonlyMap<string, number>;
    readonly contentDigest: string;
  },
  options: { readonly commit: string },
): FixtureSuiteRef {
  if (options.commit.trim() === "") {
    throw new ProvenanceRefusal(
      "the labelled corpus's commit is required; 'which cases' is not " +
        "answered by a case count (measurement-harness.md section 6)",
    );
  }
  const composition = corpus.composition();
  return new FixtureSuiteRef({
    commit: options.commit,
    positive: Number(composition.get("positive")),
    negative: Number(composition.get("negative")),
    contentDigest: String(corpus.contentDigest),
  });
}

/**
 * The AC-9 rules in force, and the count nothing can be imputed for.
 *
 * `unboundedMissing` is on the header and not only in the AC-9 section because
 * section 2.4 makes it disqualifying: **a report with a non-zero
 * `unbounded_missing` count cannot support an AC-9 acceptance claim.** A reader
 * who sees only the reduction rate has no way to know that, so the count
 * travels with the rules it invalidates.
 */
export class ImputationRule {
  readonly bounded: string;
  readonly sensitivity: string;
  readonly unboundedMissing: number;

  constructor(fields: {
    readonly bounded: string;
    readonly sensitivity: string;
    readonly unboundedMissing: number;
  }) {
    this.bounded = fields.bounded;
    this.sensitivity = fields.sensitivity;
    this.unboundedMissing = fields.unboundedMissing;
    Object.freeze(this);
  }

  get supportsAcceptanceClaim(): boolean {
    return this.unboundedMissing === 0;
  }
}

/**
 * The imputation rule block for an AC-9 report.
 *
 * The count is read off the report rather than recounted here: two counts of
 * the same thing eventually disagree, and the one in the header is the one a
 * reader would trust.
 */
export function imputationFromAc9(report: {
  readonly unboundedMissing: readonly unknown[];
}): ImputationRule {
  return new ImputationRule({
    bounded: BOUNDED_IMPUTATION_RULE,
    sensitivity: SENSITIVITY_IMPUTATION_RULE,
    unboundedMissing: report.unboundedMissing.length,
  });
}

/**
 * AC-9 coverage with both counts, and the excluded-reason breakdown.
 *
 * Section 2.4 states the requirement in bold: **coverage and the
 * excluded-reason breakdown are required output; a reduction rate printed
 * without them is not a valid report.** Both counts, not just the ratio,
 * because `3/4` and `3000/4000` are the same percentage and not the same
 * evidence.
 */
export class CoverageSummary {
  readonly covered: number;
  readonly total: number;
  readonly excluded: ReadonlyMap<string, number>;

  constructor(fields: {
    readonly covered: number;
    readonly total: number;
    readonly excluded: ReadonlyMap<string, number> | Iterable<readonly [string, number]>;
  }) {
    this.covered = fields.covered;
    this.total = fields.total;
    this.excluded = readOnlyMap(fields.excluded);
    Object.freeze(this);
  }

  /** `null` at an empty cohort -- not `0.0`, which claims a measurement. */
  get ratio(): number | null {
    if (this.total === 0) {
      return null;
    }
    return this.covered / this.total;
  }
}

/**
 * Coverage from an AC-9 report, with the cohort's exclusion breakdown.
 *
 * The two come from different objects because they count different things --
 * invocations for coverage, runs for exclusions -- and the header carries both
 * because a rate over a cohort that quietly dropped half its runs is as
 * misleading as one over invocations that quietly dropped their usage records.
 */
export function coverageFromAc9(
  report: { readonly coveredCount: number; readonly invocationCount: number },
  cohort: { excludedCounts(): ReadonlyMap<string, number> },
): CoverageSummary {
  return new CoverageSummary({
    covered: Number(report.coveredCount),
    total: Number(report.invocationCount),
    excluded: cohort.excludedCounts(),
  });
}

// --------------------------------------------------------------------------
// the header
// --------------------------------------------------------------------------

/**
 * A `float` where JavaScript has only `number`.
 *
 * Python distinguishes `1` from `1.0` and prints them apart, in `repr` and in
 * `json.dumps` alike; JavaScript does not. `coverage.ratio` is the one float in
 * section 6's table, and a coverage of 4/4 renders as `1.0` in interlock's
 * header. Wrapping it is what lets both renderers spell it Python's way without
 * either of them having to know which field it was.
 */
export class PythonFloat {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
    Object.freeze(this);
  }

  toString(): string {
    return pythonFloatRepr(this.value);
  }
}

/** Anything the header mapping can hold. */
export type HeaderValue =
  | string
  | number
  | boolean
  | null
  | PythonFloat
  | readonly HeaderValue[]
  | ReadonlyMap<string, HeaderValue>;

/**
 * Section 6's table, field for field, and the homogeneity verdict over it.
 *
 * Both renderings are generated from {@link ReportHeader.asMapping}, so the
 * Markdown and the JSON carry the same fields by construction rather than by
 * two maintainers remembering the same list.
 */
export class ReportHeader {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly generatedAtMs: number;
  readonly toolVersion: string;
  readonly dbPath: string;
  readonly applicationId: number;
  readonly userVersion: number;
  readonly schemaMigrationHead: SchemaMigrationHead;
  readonly fingerprint: DatabaseFingerprint;
  /** The revision every latency in this report was judged against. */
  readonly policyRevisionId: number;
  /**
   * Every revision in force anywhere in the period. More than one member is
   * half of what makes the period non-homogeneous.
   */
  readonly policyRevisionIds: readonly number[];
  readonly detectorVersions: readonly string[];
  readonly adapterVersions: readonly string[];
  readonly queries: QueryCatalogue;
  readonly fixtureSuite: FixtureSuiteRef;
  readonly imputation: ImputationRule;
  readonly coverage: CoverageSummary;
  readonly censored: number;
  readonly censoredLeft: number;
  readonly unmatched: ReadonlyMap<string, number>;

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly generatedAtMs: number;
    readonly toolVersion: string;
    readonly dbPath: string;
    readonly applicationId: number;
    readonly userVersion: number;
    readonly schemaMigrationHead: SchemaMigrationHead;
    readonly fingerprint: DatabaseFingerprint;
    readonly policyRevisionId: number;
    readonly policyRevisionIds: readonly number[];
    readonly detectorVersions: readonly string[];
    readonly adapterVersions: readonly string[];
    readonly queries: QueryCatalogue;
    readonly fixtureSuite: FixtureSuiteRef;
    readonly imputation: ImputationRule;
    readonly coverage: CoverageSummary;
    readonly censored: number;
    readonly censoredLeft: number;
    readonly unmatched: ReadonlyMap<string, number>;
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.generatedAtMs = fields.generatedAtMs;
    this.toolVersion = fields.toolVersion;
    this.dbPath = fields.dbPath;
    this.applicationId = fields.applicationId;
    this.userVersion = fields.userVersion;
    this.schemaMigrationHead = fields.schemaMigrationHead;
    this.fingerprint = fields.fingerprint;
    this.policyRevisionId = fields.policyRevisionId;
    this.policyRevisionIds = frozenList(fields.policyRevisionIds);
    this.detectorVersions = frozenList(fields.detectorVersions);
    this.adapterVersions = frozenList(fields.adapterVersions);
    this.queries = fields.queries;
    this.fixtureSuite = fields.fixtureSuite;
    this.imputation = fields.imputation;
    this.coverage = fields.coverage;
    this.censored = fields.censored;
    this.censoredLeft = fields.censoredLeft;
    this.unmatched = fields.unmatched;
    Object.freeze(this);
  }

  get databaseIsProduction(): boolean {
    return this.applicationId === PRODUCTION_APPLICATION_ID;
  }

  /**
   * Why the period is non-homogeneous, one reason per cause, in words.
   *
   * Section 6 names exactly two causes, and they are reported separately
   * because the reader's next move differs: two detector versions means the
   * recall numbers are two detectors' numbers, two policy revisions means the
   * *budgets* moved underneath a latency comparison.
   */
  get nonHomogeneityReasons(): readonly string[] {
    const reasons: string[] = [];
    if (this.detectorVersions.length > 1) {
      reasons.push(
        "detector_version changed inside the period: " +
          `${this.detectorVersions.join(", ")} - the latency and recall ` +
          "figures are two detectors' figures, and Q-0009 (cross-version " +
          "compatibility) is OPEN, so this report exposes the set and " +
          "does not resolve it",
      );
    }
    if (this.policyRevisionIds.length > 1) {
      reasons.push(
        "policy_revision_id changed inside the period: " +
          `${this.policyRevisionIds.map((revision) => String(revision)).join(", ")}` +
          " - the tolerances and budgets every judgement is against were " +
          "not the same numbers throughout",
      );
    }
    return frozenList(reasons);
  }

  get nonHomogeneous(): boolean {
    return this.nonHomogeneityReasons.length > 0;
  }

  /**
   * The lines that go at the top of every rendering, homogeneous or not.
   *
   * There is no argument that suppresses this and no render path that omits it:
   * both renderers take it from {@link ReportHeader.asMapping}, which always
   * carries it. A banner a caller can turn off is a banner that is off in the
   * report that needed it.
   *
   * The homogeneous case says so rather than printing nothing, because silence
   * is what a header produced by code that never checked also looks like.
   */
  banner(): readonly string[] {
    const reasons = this.nonHomogeneityReasons;
    if (reasons.length === 0) {
      const detector = this.detectorVersions[0] ?? "none observed";
      const revision =
        this.policyRevisionIds.length > 0 ? String(this.policyRevisionIds[0]) : "none in force";
      return frozenList([
        `period is HOMOGENEOUS: one detector_version (${detector}), ` +
          `one policy_revision_id (${revision})`,
      ]);
    }
    const lines = [
      BANNER_RULE,
      "!! NON-HOMOGENEOUS PERIOD - DO NOT AVERAGE ACROSS IT",
      "!! a latency comparison across a detector change is comparing two detectors",
      "!! and calling it a trend (measurement-harness.md section 6)",
    ];
    for (const reason of reasons) {
      lines.push(`!! - ${reason}`);
    }
    lines.push(BANNER_RULE);
    return frozenList(lines);
  }

  /**
   * The one shape both renderings are generated from.
   *
   * Ordered deliberately: the homogeneity verdict first, because a reader who
   * stops after the first screen must not stop before it.
   */
  asMapping(): ReadonlyMap<string, HeaderValue> {
    return readOnlyMap<string, HeaderValue>([
      ["non_homogeneous", this.nonHomogeneous],
      ["non_homogeneity_reasons", [...this.nonHomogeneityReasons]],
      ["banner", [...this.banner()]],
      ["period_start_ms", this.periodStartMs],
      ["period_start_iso", iso8601Ms(this.periodStartMs)],
      ["period_end_ms", this.periodEndMs],
      ["period_end_iso", iso8601Ms(this.periodEndMs)],
      ["period_bounds", "half-open [start, end)"],
      ["generated_at_ms", this.generatedAtMs],
      ["generated_at_iso", iso8601Ms(this.generatedAtMs)],
      ["tool_version", this.toolVersion],
      ["db_path", this.dbPath],
      ["application_id", this.applicationId],
      ["application_id_hex", `0x${this.applicationId.toString(16).toUpperCase().padStart(8, "0")}`],
      ["database_is_production", this.databaseIsProduction],
      ["user_version", this.userVersion],
      [
        "schema_migration_head",
        readOnlyMap<string, HeaderValue>([
          ["version", this.schemaMigrationHead.version],
          ["name", this.schemaMigrationHead.name],
        ]),
      ],
      ["db_fingerprint", this.fingerprint.digest],
      ["fingerprint_mode", this.fingerprint.mode],
      ["fingerprint_tables", [...this.fingerprint.tables]],
      ["fingerprint_establishes_content_identity", this.fingerprint.establishesContentIdentity],
      ["fingerprint_statement", this.fingerprint.statement],
      ["policy_revision_id", this.policyRevisionId],
      ["policy_revision_ids", [...this.policyRevisionIds]],
      ["detector_versions", [...this.detectorVersions]],
      ["adapter_versions", [...this.adapterVersions]],
      ["query_definitions", readOnlyMap<string, HeaderValue>(this.queries.definitions)],
      ["query_definitions_sha256", this.queries.digest],
      [
        "fixture_suite_ref",
        readOnlyMap<string, HeaderValue>([
          ["commit", this.fixtureSuite.commit],
          ["positive", this.fixtureSuite.positive],
          ["negative", this.fixtureSuite.negative],
          ["total", this.fixtureSuite.total],
          ["content_digest", this.fixtureSuite.contentDigest],
          ["absent_reason", this.fixtureSuite.absentReason],
        ]),
      ],
      [
        "imputation_rule",
        readOnlyMap<string, HeaderValue>([
          ["bounded", this.imputation.bounded],
          ["sensitivity", this.imputation.sensitivity],
          ["unbounded_missing", this.imputation.unboundedMissing],
          ["supports_acceptance_claim", this.imputation.supportsAcceptanceClaim],
        ]),
      ],
      [
        "coverage",
        readOnlyMap<string, HeaderValue>([
          ["covered", this.coverage.covered],
          ["total", this.coverage.total],
          // Wrapped so both renderers spell it as Python spells a float: a
          // coverage of 4/4 is `1.0` in interlock's header and would be `1`
          // through JavaScript's own number rendering.
          ["ratio", this.coverage.ratio === null ? null : new PythonFloat(this.coverage.ratio)],
          ["excluded", readOnlyMap<string, HeaderValue>(this.coverage.excluded)],
        ]),
      ],
      ["censored", this.censored],
      ["censored_left", this.censoredLeft],
      ["unmatched", readOnlyMap<string, HeaderValue>(this.unmatched)],
    ]);
  }
}

/**
 * Read the database's self-description and assemble section 6's header.
 *
 * Every argument is a named field and none of the report-shaped ones has a
 * default. That is the point of the module: a header field that could go
 * missing would go missing precisely on the report that needed it, and the
 * caller who forgot `censored` would publish a miss rate with no way for a
 * reader to see that half of its episodes were cut off by the period boundary.
 * `fingerprintMode` and `toolVersion` do default, to the strong mode and to
 * this build's own version -- defaults that cannot be wrong in the flattering
 * direction.
 *
 * `connection` is expected to be `openForMeasurement`'s, which is read-only by
 * capability; this function never writes and takes no lease.
 */
export function buildHeader(
  connection: SqliteDatabase,
  options: {
    readonly dbPath: string;
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly generatedAtMs: number;
    readonly policyRevisionId: number;
    readonly fingerprintTables: readonly string[];
    readonly queryDefinitions: ReadonlyMap<string, string>;
    readonly fixtureSuite: FixtureSuiteRef;
    readonly imputation: ImputationRule;
    readonly coverage: CoverageSummary;
    readonly censored: number;
    readonly censoredLeft: number;
    readonly unmatched: ReadonlyMap<string, number>;
    readonly fingerprintMode?: string;
    readonly toolVersion?: string;
  },
): ReportHeader {
  const { periodStartMs, periodEndMs, generatedAtMs, policyRevisionId } = options;
  const fingerprintMode = options.fingerprintMode ?? FINGERPRINT_CONTENT;
  const toolVersion = options.toolVersion ?? TOOL_VERSION;

  requirePeriod(periodStartMs, periodEndMs);
  iso8601Ms(generatedAtMs);
  if (generatedAtMs < periodEndMs) {
    throw new PeriodRefused(
      `generated_at_ms (${generatedAtMs}) precedes the period end ` +
        `(${periodEndMs}); a report cannot be generated over a period that ` +
        "has not closed - the rows for its last milliseconds are not written " +
        "yet (measurement-harness.md section 3.5)",
    );
  }

  const applicationId = Number(connection.pragma("application_id", { simple: true }));
  if (applicationId !== PRODUCTION_APPLICATION_ID) {
    throw new NotAProductionDatabase(
      `application_id ${hex8(applicationId)} is not the production control ` +
        `plane's ${hex8(PRODUCTION_APPLICATION_ID)}; this header would state ` +
        "that a non-production database was a production one " +
        "(production-schema.md section 3)",
    );
  }
  const userVersion = Number(connection.pragma("user_version", { simple: true }));

  const applied = appliedMigrations(connection);
  if (applied.length === 0) {
    throw new ProvenanceRefusal(
      "the schema_migration ledger is empty; there is no migration head to " +
        "record, and a report over an unmigrated database is over an unknown " +
        "shape",
    );
  }
  const newest = applied[applied.length - 1] as { version: number; name: string };
  const head = new SchemaMigrationHead({
    version: Number(newest.version),
    name: String(newest.name),
  });

  const revisions = revisionOverPeriod(connection, { periodStartMs, periodEndMs });
  if (!revisions.includes(policyRevisionId)) {
    throw new RevisionNotInPeriod(
      `revision ${policyRevisionId} was not in force anywhere in ` +
        `[${periodStartMs}, ${periodEndMs}); the revisions in force were ` +
        `${revisions.length > 0 ? pythonTupleOfNumbers(revisions) : "(none)"}`,
    );
  }

  const bounds = { period_start_ms: periodStartMs, period_end_ms: periodEndMs };
  const detectorVersions = (
    connection.prepare(DETECTOR_VERSIONS_QUERY).raw().all(bounds) as unknown[][]
  ).map((row) => String(row[0]));
  const adapterVersions = (
    connection.prepare(ADAPTER_VERSIONS_QUERY).raw().all(bounds) as unknown[][]
  ).map((row) => String(row[0]));

  const fingerprint = fingerprintDatabase(connection, {
    tables: options.fingerprintTables,
    mode: fingerprintMode,
  });
  const queries = queryCatalogue(mergeQueries(HEADER_QUERIES, options.queryDefinitions));

  if (options.censored < 0 || options.censoredLeft < 0) {
    throw new ProvenanceRefusal(
      `censored (${options.censored}) and censored_left (${options.censoredLeft}) ` +
        "are counts and cannot be negative",
    );
  }

  return new ReportHeader({
    periodStartMs,
    periodEndMs,
    generatedAtMs,
    toolVersion,
    dbPath: String(options.dbPath),
    applicationId,
    userVersion,
    schemaMigrationHead: head,
    fingerprint,
    policyRevisionId,
    policyRevisionIds: revisions,
    detectorVersions,
    adapterVersions,
    queries,
    fixtureSuite: options.fixtureSuite,
    imputation: options.imputation,
    coverage: options.coverage,
    censored: options.censored,
    censoredLeft: options.censoredLeft,
    unmatched: readOnlyMap(options.unmatched),
  });
}

/** `0x` plus eight upper-case hex digits, as the source's `f"0x{id:08X}"`. */
function hex8(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

/** Python's `repr()` of a tuple of ints, for the revision refusal. */
function pythonTupleOfNumbers(values: readonly number[]): string {
  if (values.length === 1) {
    return `(${values[0]},)`;
  }
  return `(${values.join(", ")})`;
}

// --------------------------------------------------------------------------
// the two renderings
// --------------------------------------------------------------------------

/**
 * The JSON rendering: {@link ReportHeader.asMapping}, verbatim.
 *
 * Key order is deliberately preserved rather than sorted: the mapping's order
 * puts the homogeneity verdict first, and sorting would bury it under
 * `adapter_versions`. Non-ASCII is escaped -- section 6's header is printed to
 * a console that may be cp932, and a non-encodable character there crashes the
 * report rather than degrading it.
 *
 * `JSON.stringify` is not this function: it emits no `ensure_ascii` escaping,
 * and it would print an integral float as an integer. Both differences are
 * invisible to any assertion that parses the text (D-0017 rule 4 is the same
 * argument for the control plane's persisted JSON).
 */
export function renderHeaderJson(header: ReportHeader): string {
  return `${renderPythonJson(header.asMapping(), 0)}`;
}

/**
 * Is this header value a nested mapping?
 *
 * `instanceof Map` is deliberately false for what {@link readOnlyMap} returns
 * (D-0105's sibling reasoning in `immutable.ts`: it is not a `Map`, and code
 * branching on `instanceof Map` to decide whether it may write should take the
 * other branch). So the test is structural -- everything the renderers need is
 * `entries()` -- and it excludes the two object-shaped leaves, arrays and
 * {@link PythonFloat}, explicitly.
 */
function isHeaderMap(value: HeaderValue): value is ReadonlyMap<string, HeaderValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PythonFloat) &&
    typeof (value as ReadonlyMap<string, HeaderValue>).entries === "function"
  );
}

function renderPythonJson(value: HeaderValue, depth: number): string {
  const pad = "  ".repeat(depth + 1);
  const closePad = "  ".repeat(depth);
  if (value === null) {
    return "null";
  }
  if (value instanceof PythonFloat) {
    return value.toString();
  }
  if (typeof value === "string") {
    return pythonJsonString(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((item) => `${pad}${renderPythonJson(item as HeaderValue, depth + 1)}`);
    return `[\n${items.join(",\n")}\n${closePad}]`;
  }
  if (!isHeaderMap(value)) {
    /* c8 ignore next 2 -- every HeaderValue is one of the branches above */
    throw new ProvenanceRefusal(`the header mapping carries a value it cannot render: ${value}`);
  }
  const entries = [...value.entries()];
  if (entries.length === 0) {
    return "{}";
  }
  const rendered = entries.map(
    ([key, item]) => `${pad}${pythonJsonString(key)}: ${renderPythonJson(item, depth + 1)}`,
  );
  return `{\n${rendered.join(",\n")}\n${closePad}}`;
}

/**
 * The Markdown rendering: the same mapping, flattened into section 6's table.
 *
 * Nested blocks are flattened with dotted keys (`coverage.excluded.*`) so that
 * every leaf of the mapping reaches the table. A renderer that skipped a nested
 * block would produce a Markdown header quietly missing fields the JSON one
 * carries, and the reader with the Markdown would never know.
 */
export function renderHeaderMarkdown(header: ReportHeader): string {
  const mapping = header.asMapping();
  const lines: string[] = [...header.banner()];
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  for (const [key, value] of mapping) {
    if (key === "banner") {
      continue;
    }
    for (const [fieldName, rendered] of flatten(key, value)) {
      lines.push(`| \`${fieldName}\` | ${rendered} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function flatten(prefix: string, value: HeaderValue): [string, string][] {
  if (isHeaderMap(value)) {
    const entries = [...value.entries()];
    if (entries.length === 0) {
      return [[prefix, "(none)"]];
    }
    const flattened: [string, string][] = [];
    for (const [key, item] of entries) {
      flattened.push(...flatten(`${prefix}.${key}`, item));
    }
    return flattened;
  }
  return [[prefix, cell(value)]];
}

/**
 * One table cell, ASCII and pipe-safe.
 *
 * A `|` inside a query's text would end the cell and shift every field after it
 * one column left, which is a rendering that silently mislabels values -- so it
 * is escaped rather than trusted not to appear.
 */
function cell(value: HeaderValue): string {
  let rendered: string;
  if (value === null) {
    rendered = "(none)";
  } else if (typeof value === "boolean") {
    rendered = value ? "true" : "false";
  } else if (Array.isArray(value)) {
    rendered =
      value.length > 0 ? value.map((item) => cell(item as HeaderValue)).join(", ") : "(none)";
  } else {
    rendered = String(value);
  }
  return rendered.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}
