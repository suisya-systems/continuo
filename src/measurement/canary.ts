import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { comparePythonStrings, pythonRepr } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";
// proveReadOnly is reader.ts's one implementation of the probe, called rather
// than copied: ACCEPTANCE.md section 3 condition 5 wants the read-only
// assertion evidenced off the LIVE connection the report is measured through,
// and openForMeasurement proves it only for the connection it opens itself --
// a different object from the one handed to this module.
import { measurementSnapshot, ReadOnlyCapabilityRefused, readerSeams } from "./reader.js";
import {
  reconcile,
  renderShadowReconciliation,
  type ShadowEpisode,
  type ShadowReconciliation,
  type V1Reference,
} from "./shadow.js";

/**
 * AC-7 -- the canary divergence report: what the canary produced, and no verdict on it.
 *
 * The failure this module is written against is the one `ACCEPTANCE.md` section
 * 3 names in its own words and then refuses to commit: the canary's *shape* is
 * decided (`D-0013`) and its **duration, sample size and numeric exit /
 * rollback criteria are not** (`Q-0005`). Section 3 goes further and closes the
 * obvious shortcut -- AC-9's reduction targets "are not the same thing as
 * canary go/no-go thresholds, and this document does not convert one into the
 * other". A harness that printed a verdict would perform exactly that
 * conversion, and it would perform it invisibly: the number it compared against
 * would be whichever threshold the person writing the harness had in mind on
 * the day, wearing the authority of a tool. Everything downstream -- whether
 * the cutover proceeds, whether a rollback is called -- would then rest on a
 * threshold nobody decided. So this module emits the measurements the decision
 * will be made from, and the decision stays with the people `Q-0005` is waiting
 * on. That is why there is no `passed` field on any type here and no verdict
 * line in the rendering; the test file greps the rendered report for the
 * verdict vocabulary so the absence is a property of the code rather than of
 * this paragraph.
 *
 * What the report *is*, per `docs/measurement-harness.md` section 5: section
 * 3.3's episode reconciliation rendered per period, plus the three assertions
 * `ACCEPTANCE.md` section 3's Verification bullets ask for. Each is a different
 * kind of statement and they are kept apart deliberately:
 *
 * **The writer audit** (condition 2, bullet 1) is about *records*: no record was
 * written by both stores over the canary window. It cannot be answered from
 * this database alone -- half the evidence is in v1's store -- so the v1 side
 * arrives as an input, exactly as the shadow adapter's episodes do
 * ({@link V1Reference}), and for the same reason: a harness that reached into
 * `.state/` and an `events` table would stop running the day those paths moved,
 * which is during the cutover it exists to observe. A v1 record naming a class
 * this audit does not query is **refused** rather than skipped
 * ({@link UndeclaredRecordClass}): a class nobody compares produces no overlap,
 * and "no overlap" read off an unasked question is the flattering answer
 * arriving through the absence of data.
 *
 * **The ownership ledger** (conditions 3, 4, 6) is about *runs*, and it rests on
 * the settled reading of `D-0013`: ownership is decided once at run start, and
 * a row in this database **is** the assertion that the run is Interlock-owned
 * -- there is no ownership column and none is coming. A run that changed owner
 * mid-flight is therefore not a state anything records; it is detectable only
 * as a run **claimed by both sides**, and that collision is the assertion
 * failing. `selectCohort` meets the same collision and *refuses*
 * (`OwnershipAssertionRefused`), which is right for it: its output is a
 * denominator, and a denominator computed from a contradicted input is a number
 * with no reason to be doubted. This report's output is the finding itself, so
 * refusing here would destroy the one artefact AC-7 asks for. Both claims are
 * kept, both are printed, and neither is deduped -- deduping is what turns a
 * violated assertion into a tidy row.
 *
 * **The read-only assertion** (condition 5) is about *this process*, and it is
 * the one bullet that names its own evidence: read-only "enforced by
 * capability, not by convention". A field on a report saying `read_only: true`
 * is a convention with a longer name -- it is true because someone typed it,
 * and it stays true after the capability is gone. So
 * {@link evidenceOfReadOnly} reads `PRAGMA query_only` back **off the live
 * connection** the rest of the report is being measured through, names the
 * `mode=ro` URI that connection's own `database_list` says it is attached to,
 * and then proves the file mode behaviourally through reader's probe. A
 * connection that merely *claims* read-only -- opened read-write with
 * `query_only` raised by hand -- clears the first check and is caught by the
 * second, which is the distinction the bullet is drawing.
 *
 * Ordering is load-bearing: the read-only evidence is gathered **before the
 * first measurement query**. Evidence collected afterwards would be evidence
 * about a connection that had already been used, and the question is whether
 * the instrument could have changed what it measured.
 *
 * Out of scope, and stated rather than implied: the two remaining verification
 * bullets -- the rehearsed, timed rollback and the bridge inventory -- are
 * *operational* records of something a person does, not measurements this
 * harness can read out of a database, and nothing here pretends to produce
 * them. Nor does this module raise an incident, apply a remedy, or decide
 * AC-10.
 *
 * Nothing here writes and nothing here reads a clock. The connection comes from
 * `openForMeasurement`; every bound is the caller's half-open `[start, end)`
 * (`time-base-policy.md` section 2, rule 4).
 */

/**
 * The store name this database's own records carry. A literal, because there is
 * exactly one Interlock store and the v1 side names itself in its own input --
 * a record's store is how a finding says *which two* wrote it.
 */
export const INTERLOCK_STORE = "interlock";

/**
 * The URI query string that carries the read-only capability (`D-0040`,
 * `measurement-harness.md` section 1). Named here because the report prints the
 * URI it was measured through, and a report that printed a URI without this
 * fragment would be reporting the absence of the capability.
 */
export const MODE_RO = "mode=ro";

/**
 * The finding kinds. Closed and always both emitted, at zero as well: a reader
 * diffing two reports must see `dual_write: 0`, because a missing key reads as
 * "nothing to report" when it means "this report was produced by code that did
 * not look".
 */
export const DUAL_WRITE = "dual_write";
export const OWNERSHIP_COLLISION = "ownership_collision";

export const FINDING_KINDS: readonly string[] = frozenList([DUAL_WRITE, OWNERSHIP_COLLISION]);

/**
 * Read off the live connection to name the file it is attached to. `main` is
 * the schema this harness measures; an attached second database would be a
 * different question and this report does not have one.
 */
export const READ_ONLY_URI_QUERY = "PRAGMA database_list";

/** Base for this module's refusals, under the control plane's hierarchy. */
export class CanaryRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CanaryRefusal";
    Object.setPrototypeOf(this, CanaryRefusal.prototype);
  }
}

/**
 * The v1 side handed over a record in a class this audit does not query.
 *
 * Skipping it would be the worst available outcome: the audit would run, find
 * no overlap in that class -- because it never asked this database about it --
 * and report an assertion holding on the strength of a comparison that did not
 * happen. Condition 2 is a claim about *all* authoritative records, so a class
 * outside {@link RECORD_CLASSES} is either a class this build must learn to
 * query or a record v1 should not be handing over, and both of those are for a
 * person to settle before the number means anything.
 */
export class UndeclaredRecordClass extends CanaryRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UndeclaredRecordClass";
    Object.setPrototypeOf(this, UndeclaredRecordClass.prototype);
  }
}

/**
 * The v1 ownership input contradicts itself, or is not shaped like one.
 *
 * Distinct from an ownership *finding*: a finding is two systems disagreeing
 * about the world, which is what this report exists to record, whereas this is
 * one system's own list disagreeing with itself -- the same run claimed twice
 * on the v1 side. The report cannot file that as a divergence between systems,
 * because it is not one.
 */
export class OwnershipInputRefused extends CanaryRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "OwnershipInputRefused";
    Object.setPrototypeOf(this, OwnershipInputRefused.prototype);
  }
}

/** A v1-side input was constructed without the provenance it must carry. */
export class V1InputRefused extends CanaryRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "V1InputRefused";
    Object.setPrototypeOf(this, V1InputRefused.prototype);
  }
}

// --------------------------------------------------------------------------
// condition 5 -- the read-only assertion, evidenced from the runtime
// --------------------------------------------------------------------------

/**
 * What was read *off the live connection* to evidence condition 5.
 *
 * Every field is a reading, not a claim. `queryOnly` is the value
 * `PRAGMA query_only` returned before this report ran a single measurement
 * query; `uri` is built from the path the connection's own
 * {@link READ_ONLY_URI_QUERY} reports, so it names the file that was actually
 * attached rather than the file the caller believes it opened; and
 * `fileModeProbe` records how the file itself answered a write.
 *
 * There is deliberately no `readOnly: boolean`. A boolean would be the same
 * shape whether it came from a measurement or from a literal, and condition 5
 * is precisely a rule about which of those two a claim of read-only is allowed
 * to be.
 */
export class ReadOnlyEvidence {
  readonly queryOnly: number;
  readonly databasePath: string;
  readonly uri: string;
  readonly fileModeProbe: string;
  readonly queryOnlyAfterProbe: number;

  constructor(fields: {
    readonly queryOnly: number;
    readonly databasePath: string;
    readonly uri: string;
    readonly fileModeProbe: string;
    readonly queryOnlyAfterProbe: number;
  }) {
    this.queryOnly = fields.queryOnly;
    this.databasePath = fields.databasePath;
    this.uri = fields.uri;
    this.fileModeProbe = fields.fileModeProbe;
    this.queryOnlyAfterProbe = fields.queryOnlyAfterProbe;
    Object.freeze(this);
  }
}

/**
 * How the file answered the probe. One value, because any other outcome is a
 * refusal rather than a recorded reading -- see {@link evidenceOfReadOnly}.
 */
export const FILE_REFUSED_THE_WRITE = "the file refused a write as SQLITE_READONLY";

/**
 * Evidence condition 5 from `connection` itself, or refuse.
 *
 * Three readings, in this order and for this reason:
 *
 * 1. `PRAGMA query_only` **as found**. Not set-then-read: setting it first
 *    would make every connection pass, including the writable one this check
 *    exists to catch. What is wanted is the state the rest of the report will
 *    be measured in.
 * 2. The attached file, from {@link READ_ONLY_URI_QUERY}, and the `mode=ro` URI
 *    naming it. A URI the caller passed in would be a claim about the past;
 *    this one is what the connection says it is holding now.
 * 3. The file-mode probe (reader's), which lowers `query_only` for one
 *    statement so the *file* answers rather than the connection guard. This is
 *    what separates a capability from a convention: a read-write connection
 *    with `query_only` raised by hand clears reading 1 and is caught here.
 *
 * `query_only` is read once more afterwards, because the probe is the one thing
 * in the harness that lowers it and therefore the one thing that could leave it
 * lowered.
 *
 * @throws {ReadOnlyCapabilityRefused} if `query_only` is not in force, if the
 *   connection is attached to no file (an in-memory or temporary database
 *   cannot evidence `mode=ro`, and a report that skipped the check for those
 *   would be skipping it for the one connection that has no file mode at all),
 *   or if the file accepts a write -- and equally if the probe could not reach
 *   an answer. All of these come back as reader's own refusal type, because
 *   they are one fact: this report is being measured through a handle that
 *   could have changed what it measured.
 */
export function evidenceOfReadOnly(connection: SqliteDatabase): ReadOnlyEvidence {
  const found = connection.pragma("query_only", { simple: true }) as number;
  if (found !== 1) {
    throw new ReadOnlyCapabilityRefused(
      `PRAGMA query_only reads back as ${found} on the ` +
        "connection this canary divergence report was handed; ACCEPTANCE.md " +
        "section 3 condition 5 requires the shadow path to be read-only " +
        "enforced by capability, and this report evidences that by reading the " +
        "live connection rather than by asserting it. Open the database through " +
        "measurement.reader.openForMeasurement",
    );
  }

  const path = attachedDatabasePath(connection);
  const uri = `${pathToFileURL(realpathSync(path)).href}?${MODE_RO}`;

  // Throws ReadOnlyCapabilityRefused on a writable file and on an inconclusive
  // probe alike; a returned call is the file having refused the write as
  // read-only, which is the only reading this function records.
  //
  // Reached through the seam record rather than by the imported binding: Python
  // resolves `prove_read_only` through the reader module's namespace at call
  // time, so a test can substitute it there, and D-0014 is that late binding
  // reproduced. It is what lets the post-probe guard below be exercised at all
  // -- the only way to leave query_only lowered is for the probe to misbehave.
  readerSeams.proveReadOnly(connection, path);

  const after = connection.pragma("query_only", { simple: true }) as number;
  if (after !== 1) {
    throw new ReadOnlyCapabilityRefused(
      `PRAGMA query_only reads back as ${after} after the ` +
        `file-mode probe on ${path}; the probe lowers the connection guard for ` +
        "one statement and must restore it, so a connection left unguarded here " +
        "is the harness having disarmed itself while checking that it was armed",
    );
  }

  return new ReadOnlyEvidence({
    queryOnly: Number(found),
    databasePath: String(path),
    uri,
    fileModeProbe: FILE_REFUSED_THE_WRITE,
    queryOnlyAfterProbe: Number(after),
  });
}

/**
 * The file `main` is attached to, read off `connection`.
 *
 * An empty file name is SQLite's answer for an in-memory or temporary database.
 * That is refused rather than tolerated: such a connection has no file to be
 * read-only *by capability*, so the evidence condition 5 asks for does not
 * exist for it, and producing a report that quietly omitted the check would
 * leave the omission indistinguishable from the check having succeeded.
 */
function attachedDatabasePath(connection: SqliteDatabase): string {
  const rows = connection.pragma("database_list") as { name: string; file: string }[];
  for (const row of rows) {
    if (row.name !== "main") {
      continue;
    }
    if (!row.file) {
      throw new ReadOnlyCapabilityRefused(
        "the connection this report was handed is attached to no file (an " +
          "in-memory or temporary database); mode=ro is a property of opening a " +
          "file, so there is nothing here that could evidence ACCEPTANCE.md " +
          "section 3 condition 5",
      );
    }
    return row.file;
  }
  /* c8 ignore next 3 -- SQLite always has main */
  throw new ReadOnlyCapabilityRefused(
    "the connection this report was handed has no 'main' database",
  );
}

// --------------------------------------------------------------------------
// condition 2 -- the writer audit
// --------------------------------------------------------------------------

/**
 * One class of authoritative record, and the query that finds it here.
 *
 * `sql` is executed, not described: the text in this object *is* the text that
 * runs, so the `queryDefinitions` provenance (`measurement-harness.md` section
 * 6) cannot drift away from the query it documents. It binds `:window_from_ms`
 * and `:window_to_ms` and returns `record_key`, `first_written_at_ms` and
 * `last_written_at_ms`.
 *
 * `keyShape` is the spelling both systems must agree on. It is written down
 * because the audit's whole power is that the two sides compute the same string
 * from different schemas -- a key one side spells differently overlaps with
 * nothing and reports a clean audit for the wrong reason.
 */
export class RecordClass {
  readonly name: string;
  readonly keyShape: string;
  readonly sql: string;

  constructor(fields: {
    readonly name: string;
    readonly keyShape: string;
    readonly sql: string;
  }) {
    this.name = fields.name;
    this.keyShape = fields.keyShape;
    this.sql = fields.sql;
    Object.freeze(this);
  }
}

/**
 * A run. `run_id` is the key both sides carry -- it is the routing decision's
 * subject (`D-0013`), so a run v1 also wrote is nameable by exactly this string
 * on both sides.
 */
export const RECORD_CLASS_RUN = new RecordClass({
  name: "run",
  keyShape: "run_id",
  // The window test is an OVERLAP of the record's write span, not "was last
  // written inside the window". The schema records a first and a last write and
  // nothing between (there is no per-write audit trail), so a record created
  // before the window and updated after it may well have been written inside
  // it, and the audit has no way to say otherwise. Overlap over-includes;
  // over-inclusion can only add a candidate finding a person then dismisses,
  // whereas the tighter test can drop the one record the whole audit exists to
  // find.
  sql: `
        SELECT run_id            AS record_key,
               created_at_ms     AS first_written_at_ms,
               updated_at_ms     AS last_written_at_ms
        FROM run
        WHERE created_at_ms < :window_to_ms
          AND updated_at_ms >= :window_from_ms
        ORDER BY run_id
    `,
});

/**
 * A pull request. Keyed the way section 3.3 keys its PR episodes -- provider,
 * lowercased owner/repo, number -- because that is the spelling v1 can reach
 * from its stored `pr_url`, and because the fold happens in SQL for the reason
 * shadow.ts gives: SQLite's `lower()` folds ASCII only while JavaScript's
 * `toLowerCase` is Unicode-aware, so an independently spelled fold agrees on
 * every ASCII slug and then names a repository the database's own index never
 * named.
 */
export const RECORD_CLASS_PULL_REQUEST = new RecordClass({
  name: "pull_request",
  keyShape: "provider/owner/name#pr_number, owner and name lowercased",
  sql: `
        SELECT repository.provider || '/'
               || lower(repository.owner) || '/'
               || lower(repository.name) || '#'
               || pull_request.pr_number       AS record_key,
               pull_request.created_at_ms      AS first_written_at_ms,
               pull_request.updated_at_ms      AS last_written_at_ms
        FROM pull_request
        JOIN repository ON repository.repo_id = pull_request.repo_id
        WHERE pull_request.created_at_ms < :window_to_ms
          AND pull_request.updated_at_ms >= :window_from_ms
        ORDER BY record_key
    `,
});

/**
 * The classes audited by default: the two whose keys **both** systems can
 * spell. The list is short on purpose. A class Interlock can key and v1 cannot
 * contributes an empty v1 side, which is not evidence of no dual write -- it is
 * the absence of a comparison, and putting it in the report would dress one up
 * as the other. Adding a class means the v1 adapter learned to spell its key,
 * which is a change to both sides at once.
 */
export const RECORD_CLASSES: readonly RecordClass[] = frozenList([
  RECORD_CLASS_RUN,
  RECORD_CLASS_PULL_REQUEST,
]);

/** The ledger listing, named so the provenance catalogue and the reader share one text. */
export const OWNERSHIP_LEDGER_QUERY = `
        SELECT run_id, created_at_ms
        FROM run
        WHERE created_at_ms >= :window_from_ms
          AND created_at_ms < :window_to_ms
        ORDER BY created_at_ms, run_id
    `;

/** Every query this module executes, as text, for section 6's provenance header. */
export const QUERY_DEFINITIONS: ReadonlyMap<string, string> = readOnlyMap([
  ["read_only_uri", READ_ONLY_URI_QUERY],
  ...RECORD_CLASSES.map(
    (recordClass) => [`record_class:${recordClass.name}`, recordClass.sql] as const,
  ),
  ["ownership_ledger", OWNERSHIP_LEDGER_QUERY],
  ["ownership_collision", "SELECT run_id FROM run WHERE run_id IN (...)"],
]);

/**
 * `(recordClass, recordKey)` as one string, length-prefixed so the encoding is
 * injective.
 *
 * Python keys this by the tuple itself, which cannot be ambiguous; a JavaScript
 * Map compares tuples by reference, so the two components have to become one
 * string. A plain separator is not enough here, and that is the difference from
 * shadow.ts's correlation token: there the four key shapes are the module's own
 * and no component can contain a unit separator, whereas BOTH halves of this
 * identity are caller-supplied -- the class name through the `recordClasses`
 * argument, the key through the v1 adapter's ledger -- so nothing rules the
 * separator out. Under a bare join `("a", "b<US>c")` and `("a<US>b", "c")` spell
 * one identity and pair as a dual write neither store made.
 *
 * The length prefix is the same device `provenance.py` uses on every hashed
 * field, for the same reason: with the class's length written down first there
 * is exactly one way to split the string back.
 */
function recordIdentity(recordClass: string, recordKey: string): string {
  return `${recordClass.length}:${recordClass}${recordKey}`;
}

/**
 * One authoritative record, and the store that wrote it.
 *
 * Both sides use this type. `firstWrittenAtMs`/`lastWrittenAtMs` bracket the
 * writing rather than pinning it, because neither store keeps a per-write
 * trail; the audit turns on *identity*, and the instants are what a person
 * reads when deciding what a finding means.
 */
export class WrittenRecord {
  readonly recordClass: string;
  readonly recordKey: string;
  readonly firstWrittenAtMs: number;
  readonly lastWrittenAtMs: number;
  readonly store: string;

  constructor(fields: {
    readonly recordClass: string;
    readonly recordKey: string;
    readonly firstWrittenAtMs: number;
    readonly lastWrittenAtMs: number;
    readonly store: string;
  }) {
    this.recordClass = fields.recordClass;
    this.recordKey = fields.recordKey;
    this.firstWrittenAtMs = fields.firstWrittenAtMs;
    this.lastWrittenAtMs = fields.lastWrittenAtMs;
    this.store = fields.store;
    Object.freeze(this);
  }

  /** `(recordClass, recordKey)`, as the string both sides are matched on. */
  get identity(): string {
    return recordIdentity(this.recordClass, this.recordKey);
  }
}

/**
 * One record both stores wrote. Condition 2 violated, named.
 *
 * Carries both records whole -- not a merged row -- because the question a
 * person asks next is *when* each store wrote it, and a finding that had
 * already reconciled the two instants would have answered that question by
 * discarding it.
 */
export class DualWriteFinding {
  readonly recordClass: string;
  readonly recordKey: string;
  readonly interlock: WrittenRecord;
  readonly v1: WrittenRecord;

  constructor(fields: {
    readonly recordClass: string;
    readonly recordKey: string;
    readonly interlock: WrittenRecord;
    readonly v1: WrittenRecord;
  }) {
    this.recordClass = fields.recordClass;
    this.recordKey = fields.recordKey;
    this.interlock = fields.interlock;
    this.v1 = fields.v1;
    Object.freeze(this);
  }
}

/**
 * v1's list of what it wrote, as a separable adapter hands it over.
 *
 * The constructors force apart the two states an empty list conflates, on
 * exactly the argument {@link V1Reference} makes for episodes: an adapter that
 * returned nothing and an adapter that did not run look identical from their
 * output, and read as "v1 wrote nothing" they produce a writer audit that finds
 * no dual write for the one reason that proves nothing.
 */
export class V1WriterLedger {
  readonly source: string | null;
  readonly records: readonly WrittenRecord[];
  readonly absentReason: string | null;

  private constructor(fields: {
    readonly source: string | null;
    readonly records: readonly WrittenRecord[];
    readonly absentReason: string | null;
  }) {
    this.source = fields.source;
    this.records = frozenList(fields.records);
    this.absentReason = fields.absentReason;
    Object.freeze(this);
  }

  get available(): boolean {
    return this.source !== null;
  }

  static absent(options: { readonly reason: string }): V1WriterLedger {
    if (!options.reason) {
      throw new V1InputRefused(
        "an absent writer ledger must say why it is absent; the report prints " +
          "the reason where the audit would have been",
      );
    }
    return new V1WriterLedger({ source: null, records: [], absentReason: options.reason });
  }

  /** Records read by `source`; an empty read degrades to {@link V1WriterLedger.absent}. */
  static observed(options: {
    readonly source: string;
    readonly records: Iterable<WrittenRecord>;
  }): V1WriterLedger {
    if (!options.source) {
      throw new V1InputRefused(
        "an observed writer ledger must name its source (D-0040: a report " +
          "records where its numbers came from)",
      );
    }
    const materialised = [...options.records];
    if (materialised.length === 0) {
      return V1WriterLedger.absent({
        reason:
          `the v1 writer audit adapter ${pythonRepr(options.source)} returned no ` +
          "records; an empty read is not evidence that v1 wrote nothing (use " +
          "V1WriterLedger.attestsEmpty to claim that on purpose)",
      });
    }
    return new V1WriterLedger({
      source: options.source,
      records: materialised,
      absentReason: null,
    });
  }

  /** `source` audited v1's store over this window and found no record. */
  static attestsEmpty(options: { readonly source: string }): V1WriterLedger {
    if (!options.source) {
      throw new V1InputRefused("an attestation that v1 wrote nothing must name who attests it");
    }
    return new V1WriterLedger({ source: options.source, records: [], absentReason: null });
  }
}

/**
 * Verification bullet 1: no record was written by both stores.
 *
 * `findings` is the answer; the counts around it are what make an empty
 * `findings` mean something. Zero findings over zero compared records is not
 * the assertion holding, it is the assertion unasked, and the rendering says
 * which of the two happened.
 */
export class WriterAudit {
  readonly windowFromMs: number;
  readonly windowToMs: number;
  readonly available: boolean;
  readonly v1Source: string | null;
  readonly absentReason: string | null;
  readonly recordClasses: readonly string[];
  readonly interlockRecordCount: number;
  readonly v1RecordCount: number;
  readonly findings: readonly DualWriteFinding[];

  constructor(fields: {
    readonly windowFromMs: number;
    readonly windowToMs: number;
    readonly available: boolean;
    readonly v1Source: string | null;
    readonly absentReason: string | null;
    readonly recordClasses: readonly string[];
    readonly interlockRecordCount: number;
    readonly v1RecordCount: number;
    readonly findings: readonly DualWriteFinding[];
  }) {
    this.windowFromMs = fields.windowFromMs;
    this.windowToMs = fields.windowToMs;
    this.available = fields.available;
    this.v1Source = fields.v1Source;
    this.absentReason = fields.absentReason;
    this.recordClasses = frozenList(fields.recordClasses);
    this.interlockRecordCount = fields.interlockRecordCount;
    this.v1RecordCount = fields.v1RecordCount;
    this.findings = frozenList(fields.findings);
    Object.freeze(this);
  }

  get findingCount(): number {
    return this.findings.length;
  }
}

/** This database's authoritative records whose write span meets the window. */
export function readInterlockRecords(
  connection: SqliteDatabase,
  options: {
    readonly windowFromMs: number;
    readonly windowToMs: number;
    readonly recordClasses?: readonly RecordClass[];
  },
): readonly WrittenRecord[] {
  const { windowFromMs, windowToMs } = options;
  const recordClasses = options.recordClasses ?? RECORD_CLASSES;
  requireWindow(windowFromMs, windowToMs);
  const bindings = { window_from_ms: windowFromMs, window_to_ms: windowToMs };
  const records: WrittenRecord[] = [];
  for (const recordClass of recordClasses) {
    const rows = connection.prepare(recordClass.sql).all(bindings) as {
      record_key: string;
      first_written_at_ms: number;
      last_written_at_ms: number;
    }[];
    for (const row of rows) {
      records.push(
        new WrittenRecord({
          recordClass: recordClass.name,
          recordKey: String(row.record_key),
          firstWrittenAtMs: Number(row.first_written_at_ms),
          lastWrittenAtMs: Number(row.last_written_at_ms),
          store: INTERLOCK_STORE,
        }),
      );
    }
  }
  return frozenList(records);
}

/**
 * Compare both stores' records over the canary window (condition 2).
 *
 * A record present on both sides under one `(recordClass, recordKey)` is a
 * {@link DualWriteFinding}. Nothing is deduped and nothing is resolved: which
 * store "really" owns the record is the question the finding exists to put in
 * front of a person, and an audit that answered it would be deciding the thing
 * it was built to detect.
 *
 * @throws {UndeclaredRecordClass} if a v1 record names a class outside
 *   `recordClasses`.
 */
export function auditWriters(
  connection: SqliteDatabase,
  options: {
    readonly windowFromMs: number;
    readonly windowToMs: number;
    readonly v1Ledger: V1WriterLedger;
    readonly recordClasses?: readonly RecordClass[];
  },
): WriterAudit {
  const { windowFromMs, windowToMs, v1Ledger } = options;
  const recordClasses = options.recordClasses ?? RECORD_CLASSES;
  requireWindow(windowFromMs, windowToMs);
  const declared = recordClasses.map((recordClass) => recordClass.name);

  if (!v1Ledger.available) {
    return new WriterAudit({
      windowFromMs,
      windowToMs,
      available: false,
      v1Source: null,
      absentReason: v1Ledger.absentReason,
      recordClasses: declared,
      interlockRecordCount: readInterlockRecords(connection, {
        windowFromMs,
        windowToMs,
        recordClasses,
      }).length,
      v1RecordCount: 0,
      findings: [],
    });
  }

  for (const record of v1Ledger.records) {
    if (!declared.includes(record.recordClass)) {
      throw new UndeclaredRecordClass(
        `the v1 writer ledger ${pythonRepr(v1Ledger.source as string)} names ` +
          `record class ${pythonRepr(record.recordClass)} (key ` +
          `${pythonRepr(record.recordKey)}), which this audit does not query; ` +
          `it queries ${declared.join(", ")}. Auditing a class on one side only ` +
          "cannot show that no record was written by both -- it can only fail " +
          "to find one (ACCEPTANCE.md section 3 condition 2)",
      );
    }
  }

  const ours = readInterlockRecords(connection, { windowFromMs, windowToMs, recordClasses });
  const byIdentity = new Map(ours.map((record) => [record.identity, record]));

  const findings: DualWriteFinding[] = [];
  for (const record of v1Ledger.records) {
    const mine = byIdentity.get(record.identity);
    if (mine !== undefined) {
      findings.push(
        new DualWriteFinding({
          recordClass: record.recordClass,
          recordKey: record.recordKey,
          interlock: mine,
          v1: record,
        }),
      );
    }
  }

  return new WriterAudit({
    windowFromMs,
    windowToMs,
    available: true,
    v1Source: v1Ledger.source,
    absentReason: null,
    recordClasses: declared,
    interlockRecordCount: ours.length,
    v1RecordCount: v1Ledger.records.length,
    findings: [...findings].sort(
      (left, right) =>
        comparePythonStrings(left.recordClass, right.recordClass) ||
        comparePythonStrings(left.recordKey, right.recordKey),
    ),
  });
}

// --------------------------------------------------------------------------
// conditions 3, 4, 6 -- the run -> owning system ledger
// --------------------------------------------------------------------------

/**
 * One system's claim that it owns a run, and when the claim was made.
 *
 * `decidedAtMs` is the run's start on the claiming side: `D-0013` decides
 * routing once, at run start, so the start instant *is* the decision instant.
 * There is no separate routing table to read, on either side.
 */
export class OwnedRun {
  readonly runId: string;
  readonly owningSystem: string;
  readonly decidedAtMs: number;
  readonly store: string;

  constructor(fields: {
    readonly runId: string;
    readonly owningSystem: string;
    readonly decidedAtMs: number;
    readonly store: string;
  }) {
    this.runId = fields.runId;
    this.owningSystem = fields.owningSystem;
    this.decidedAtMs = fields.decidedAtMs;
    this.store = fields.store;
    Object.freeze(this);
  }
}

/**
 * One run claimed by both systems. Conditions 3, 4 and 6 violated, named.
 *
 * `claims` holds every claim as it arrived -- both of them, in full. The one
 * thing this must not do is reduce them to a run id: with the two claims side
 * by side a person can see which system started it and which picked it up
 * mid-flight, which is the difference between a routing bug and a converter
 * that was not supposed to exist (condition 6).
 */
export class OwnershipCollisionFinding {
  readonly runId: string;
  readonly claims: readonly OwnedRun[];

  constructor(fields: { readonly runId: string; readonly claims: readonly OwnedRun[] }) {
    this.runId = fields.runId;
    this.claims = frozenList(fields.claims);
    Object.freeze(this);
  }
}

/**
 * The runs v1 says it owns, from the same separable adapter.
 *
 * Same three constructors and the same argument as {@link V1WriterLedger}: read
 * as "v1 owned nothing", an empty list makes every collision impossible and the
 * ledger reads clean because nobody looked.
 */
export class V1OwnershipInput {
  readonly source: string | null;
  readonly runs: readonly OwnedRun[];
  readonly absentReason: string | null;

  private constructor(fields: {
    readonly source: string | null;
    readonly runs: readonly OwnedRun[];
    readonly absentReason: string | null;
  }) {
    this.source = fields.source;
    this.runs = frozenList(fields.runs);
    this.absentReason = fields.absentReason;
    Object.freeze(this);
  }

  get available(): boolean {
    return this.source !== null;
  }

  static absent(options: { readonly reason: string }): V1OwnershipInput {
    if (!options.reason) {
      throw new V1InputRefused("an absent ownership input must say why it is absent");
    }
    return new V1OwnershipInput({ source: null, runs: [], absentReason: options.reason });
  }

  static observed(options: {
    readonly source: string;
    readonly runs: Iterable<OwnedRun>;
  }): V1OwnershipInput {
    if (!options.source) {
      throw new V1InputRefused("an observed ownership input must name its source");
    }
    const materialised = [...options.runs];
    if (materialised.length === 0) {
      return V1OwnershipInput.absent({
        reason:
          `the v1 ownership adapter ${pythonRepr(options.source)} returned no ` +
          "runs; an empty read is not evidence that v1 owned none (use " +
          "V1OwnershipInput.attestsEmpty to claim that on purpose)",
      });
    }
    const seen = new Map<string, OwnedRun>();
    for (const run of materialised) {
      const previous = seen.get(run.runId);
      if (previous !== undefined) {
        throw new OwnershipInputRefused(
          `the v1 ownership input ${pythonRepr(options.source)} claims run ` +
            `${pythonRepr(run.runId)} twice (at ${previous.decidedAtMs} from ` +
            `${previous.store} and at ${run.decidedAtMs} from ${run.store}); one ` +
            "system claiming a run twice is that system's list contradicting " +
            "itself, not a divergence between systems, and this report cannot " +
            "file it as one",
        );
      }
      seen.set(run.runId, run);
    }
    return new V1OwnershipInput({
      source: options.source,
      runs: materialised,
      absentReason: null,
    });
  }

  static attestsEmpty(options: { readonly source: string }): V1OwnershipInput {
    if (!options.source) {
      throw new V1InputRefused("an attestation that v1 owned no run must name who attests it");
    }
    return new V1OwnershipInput({ source: options.source, runs: [], absentReason: null });
  }
}

/**
 * Verification bullet 2: run -> owning system at run start.
 *
 * `entries` is the ledger itself, both systems' claims in one list, and it is
 * **not** deduped: a run appearing twice is the finding, and the ledger a
 * person reads must show it twice or the finding has no evidence behind it.
 */
export class OwnershipLedger {
  readonly windowFromMs: number;
  readonly windowToMs: number;
  readonly available: boolean;
  readonly v1Source: string | null;
  readonly absentReason: string | null;
  readonly entries: readonly OwnedRun[];
  readonly findings: readonly OwnershipCollisionFinding[];

  constructor(fields: {
    readonly windowFromMs: number;
    readonly windowToMs: number;
    readonly available: boolean;
    readonly v1Source: string | null;
    readonly absentReason: string | null;
    readonly entries: readonly OwnedRun[];
    readonly findings: readonly OwnershipCollisionFinding[];
  }) {
    this.windowFromMs = fields.windowFromMs;
    this.windowToMs = fields.windowToMs;
    this.available = fields.available;
    this.v1Source = fields.v1Source;
    this.absentReason = fields.absentReason;
    this.entries = frozenList(fields.entries);
    this.findings = frozenList(fields.findings);
    Object.freeze(this);
  }

  get findingCount(): number {
    return this.findings.length;
  }

  /**
   * The runs both systems claim.
   *
   * Named separately because it is the input `selectCohort` refuses on: an AC-9
   * report over this period cannot be produced while this list is non-empty,
   * and this is where the operator reads *which* runs made that so.
   */
  collisionRunIds(): readonly string[] {
    return frozenList(this.findings.map((finding) => finding.runId));
  }
}

/**
 * The run -> owning-system ledger over the canary window (conditions 3, 4, 6).
 *
 * The Interlock side is every run whose `created_at_ms` falls in the window: a
 * run row here *is* the Interlock-ownership assertion (`D-0013`; there is no
 * ownership column), and routing is decided at run start, so the run's creation
 * is its ledger entry.
 *
 * **The collision check is not bounded by the window, and the listing is.**
 * Those are two different questions. The listing answers "what was routed
 * during the canary", which is a window question. A collision answers "did a
 * run change owner mid-flight", and a run that changed owner did so precisely
 * by starting on one side *before* the window and appearing on the other inside
 * it -- bounding the check would blind it to the case it exists for. So every
 * run id the v1 input names is checked against the whole `run` table.
 */
export function buildOwnershipLedger(
  connection: SqliteDatabase,
  options: {
    readonly windowFromMs: number;
    readonly windowToMs: number;
    readonly v1Ownership: V1OwnershipInput;
  },
): OwnershipLedger {
  const { windowFromMs, windowToMs, v1Ownership } = options;
  requireWindow(windowFromMs, windowToMs);

  const listed = connection
    .prepare(OWNERSHIP_LEDGER_QUERY)
    .all({ window_from_ms: windowFromMs, window_to_ms: windowToMs }) as {
    run_id: string;
    created_at_ms: number;
  }[];
  const entries: OwnedRun[] = listed.map(
    (row) =>
      new OwnedRun({
        runId: String(row.run_id),
        owningSystem: INTERLOCK_STORE,
        decidedAtMs: Number(row.created_at_ms),
        store: INTERLOCK_STORE,
      }),
  );

  if (!v1Ownership.available) {
    return new OwnershipLedger({
      windowFromMs,
      windowToMs,
      available: false,
      v1Source: null,
      absentReason: v1Ownership.absentReason,
      entries,
      findings: [],
    });
  }

  const claimedHere = runsThisDatabaseHolds(
    connection,
    v1Ownership.runs.map((run) => run.runId),
  );
  const oursById = new Map(entries.map((entry) => [entry.runId, entry]));

  const findings: OwnershipCollisionFinding[] = [];
  for (const run of v1Ownership.runs) {
    entries.push(run);
    if (!claimedHere.has(run.runId)) {
      continue;
    }
    // The Interlock claim may be outside the listing window -- that is the
    // mid-flight case -- so it is read from the row rather than taken from the
    // listing, which would drop exactly those findings.
    const mine = oursById.get(run.runId) ?? ownershipRow(connection, run.runId);
    findings.push(new OwnershipCollisionFinding({ runId: run.runId, claims: [mine, run] }));
  }

  return new OwnershipLedger({
    windowFromMs,
    windowToMs,
    available: true,
    v1Source: v1Ownership.source,
    absentReason: null,
    entries: [...entries].sort(
      (left, right) =>
        left.decidedAtMs - right.decidedAtMs ||
        comparePythonStrings(left.runId, right.runId) ||
        comparePythonStrings(left.store, right.store),
    ),
    findings: [...findings].sort((left, right) => comparePythonStrings(left.runId, right.runId)),
  });
}

/**
 * Which of `runIds` this database holds a run row for.
 *
 * The same fact cohort's ownership assertion computes, and chunked for the same
 * reason it chunks: SQLite's default parameter ceiling is 999 and a v1 input is
 * a list of whatever length the adapter hands over, so a query that worked in
 * testing would fail on the first real period. What differs is only the verb --
 * cohort refuses, because its output is a denominator that would otherwise be
 * quietly short; this module reports, because the finding *is* its output.
 */
function runsThisDatabaseHolds(
  connection: SqliteDatabase,
  runIds: readonly string[],
): ReadonlySet<string> {
  const held = new Set<string>();
  for (let start = 0; start < runIds.length; start += 500) {
    const chunk = runIds.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = connection
      .prepare(`SELECT run_id FROM run WHERE run_id IN (${placeholders})`)
      .all(...chunk) as { run_id: string }[];
    for (const row of rows) {
      held.add(String(row.run_id));
    }
  }
  return held;
}

function ownershipRow(connection: SqliteDatabase, runId: string): OwnedRun {
  const row = connection
    .prepare<[string], { run_id: string; created_at_ms: number }>(
      "SELECT run_id, created_at_ms FROM run WHERE run_id = ?",
    )
    .get(runId) as { run_id: string; created_at_ms: number };
  return new OwnedRun({
    runId: String(row.run_id),
    owningSystem: INTERLOCK_STORE,
    decidedAtMs: Number(row.created_at_ms),
    store: INTERLOCK_STORE,
  });
}

// --------------------------------------------------------------------------
// the report
// --------------------------------------------------------------------------

/**
 * Section 5's report for one period: reconciliation plus three assertions.
 *
 * There is no verdict field, and the omission is the point -- see the module
 * docstring. `findingCounts` is as close as the report comes to a summary, and
 * a count of findings is a measurement: it says what was observed, not whether
 * it is acceptable, and `Q-0005` is where acceptable gets decided.
 */
export class CanaryDivergenceReport {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly readOnly: ReadOnlyEvidence;
  readonly reconciliation: ShadowReconciliation;
  readonly writerAudit: WriterAudit;
  readonly ownership: OwnershipLedger;

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly readOnly: ReadOnlyEvidence;
    readonly reconciliation: ShadowReconciliation;
    readonly writerAudit: WriterAudit;
    readonly ownership: OwnershipLedger;
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.readOnly = fields.readOnly;
    this.reconciliation = fields.reconciliation;
    this.writerAudit = fields.writerAudit;
    this.ownership = fields.ownership;
    Object.freeze(this);
  }

  /** Both kinds, always, at zero as well as above it. */
  findingCounts(): ReadonlyMap<string, number> {
    return readOnlyMap([
      [DUAL_WRITE, this.writerAudit.findingCount],
      [OWNERSHIP_COLLISION, this.ownership.findingCount],
    ]);
  }
}

/**
 * Assemble section 5's report over one period.
 *
 * The reconciliation is computed here, by calling {@link reconcile}, rather
 * than taken as a finished argument. That is not convenience: the report is
 * section 3.3's reconciliation *rendered per period*, and a finished
 * reconciliation handed in could have been computed over a different period,
 * which the reader of the rendered page has no way to see. Computing it from
 * the same two bounds makes the alignment structural. Nothing about the
 * reconciliation is re-implemented -- the buckets, the censoring precedence and
 * the miss-count refusal are all shadow's.
 *
 * The read-only evidence is gathered **first**, before any measurement query
 * touches `connection`.
 *
 * **The whole report is read inside one snapshot**
 * ({@link measurementSnapshot}). The writer audit and the ownership ledger are
 * two separate scans of the same control plane, and on an autocommit connection
 * a commit landing between them produces a report whose two halves describe
 * different states of the database -- a run present in one and absent from the
 * other, reported as a divergence that never existed. The cost is the one that
 * function states: production databases here are not in WAL, so the report
 * holds a SHARED lock and blocks writers until it finishes.
 */
export function measureCanaryDivergence(
  connection: SqliteDatabase,
  options: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly interlockEpisodes: Iterable<ShadowEpisode>;
    readonly v1Reference: V1Reference;
    readonly censoredIds: Iterable<string>;
    readonly fixtureLabels: ReadonlyMap<string, string>;
    readonly v1WriterLedger: V1WriterLedger;
    readonly v1Ownership: V1OwnershipInput;
    readonly recordClasses?: readonly RecordClass[];
  },
): CanaryDivergenceReport {
  requireWindow(options.periodStartMs, options.periodEndMs);
  return measurementSnapshot(connection, {}, (held) => measureInsideTheSnapshot(held, options));
}

/**
 * The body of {@link measureCanaryDivergence}, with the snapshot held.
 *
 * Split out so the snapshot is one scope with one exit rather than a callback
 * wrapped around forty lines whose `return` a later edit could move outside it.
 */
function measureInsideTheSnapshot(
  connection: SqliteDatabase,
  options: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly interlockEpisodes: Iterable<ShadowEpisode>;
    readonly v1Reference: V1Reference;
    readonly censoredIds: Iterable<string>;
    readonly fixtureLabels: ReadonlyMap<string, string>;
    readonly v1WriterLedger: V1WriterLedger;
    readonly v1Ownership: V1OwnershipInput;
    readonly recordClasses?: readonly RecordClass[];
  },
): CanaryDivergenceReport {
  const { periodStartMs, periodEndMs } = options;
  const readOnly = evidenceOfReadOnly(connection);

  const reconciliation = reconcile({
    periodStartMs,
    periodEndMs,
    interlockEpisodes: options.interlockEpisodes,
    v1Reference: options.v1Reference,
    censoredIds: options.censoredIds,
    fixtureLabels: options.fixtureLabels,
  });
  const writerAudit = auditWriters(connection, {
    windowFromMs: periodStartMs,
    windowToMs: periodEndMs,
    v1Ledger: options.v1WriterLedger,
    recordClasses: options.recordClasses ?? RECORD_CLASSES,
  });
  const ownership = buildOwnershipLedger(connection, {
    windowFromMs: periodStartMs,
    windowToMs: periodEndMs,
    v1Ownership: options.v1Ownership,
  });
  return new CanaryDivergenceReport({
    periodStartMs,
    periodEndMs,
    readOnly,
    reconciliation,
    writerAudit,
    ownership,
  });
}

/**
 * Printed once, at the end of every rendering. It is the reason the report
 * stops where it stops, and it is text rather than a rule in a docstring
 * because the person reading the rendering is the person who would otherwise
 * supply the missing verdict from memory.
 */
export const NO_VERDICT_NOTE =
  "Q-0005 (canary duration, sample size, numeric exit criteria) is open. " +
  "AC-9's reduction targets are not canary exit thresholds and ACCEPTANCE.md " +
  "section 3 does not convert one into the other, so this report states the " +
  "measurements a canary decision will be made from and states no verdict on " +
  "the canary.";

/**
 * The report as text. ASCII only -- this reaches a cp932 console.
 *
 * Every section prints even when it is empty, and an unavailable v1 side prints
 * its reason where its numbers would have been. The alternative -- omitting a
 * section with nothing in it -- makes "no dual write was found" and "no
 * dual-write audit ran" render identically, and those are the two readings
 * condition 2 turns on.
 */
export function renderCanaryDivergenceReport(report: CanaryDivergenceReport): string {
  const lines = [
    `Canary divergence report [${report.periodStartMs}, ${report.periodEndMs})`,
    "",
    renderShadowReconciliation(report.reconciliation),
    "",
  ];
  lines.push(...renderWriterAudit(report.writerAudit));
  lines.push("");
  lines.push(...renderOwnership(report.ownership));
  lines.push("");
  lines.push(...renderReadOnly(report.readOnly));
  lines.push("");
  lines.push(`NOTE: ${NO_VERDICT_NOTE}`);
  return lines.join("\n");
}

function renderWriterAudit(audit: WriterAudit): string[] {
  const lines = [
    "Writer audit (ACCEPTANCE.md section 3 condition 2) " +
      `[${audit.windowFromMs}, ${audit.windowToMs})`,
    `  record classes audited: ${audit.recordClasses.join(", ")}`,
  ];
  if (!audit.available) {
    lines.push("  v1 store: ABSENT");
    lines.push(`  reason: ${audit.absentReason}`);
    lines.push(
      `  Interlock records read: ${audit.interlockRecordCount}. ` +
        "No comparison is reported: with one store's records missing, " +
        "finding no record written by both is not evidence that none was.",
    );
    return lines;
  }
  lines.push(`  v1 store: ${audit.v1Source}`);
  lines.push(
    `  records compared: interlock=${audit.interlockRecordCount}, v1=${audit.v1RecordCount}`,
  );
  lines.push(`  ${DUAL_WRITE} findings: ${audit.findingCount}`);
  for (const finding of audit.findings) {
    lines.push(
      `    - ${finding.recordClass} ${finding.recordKey}: ` +
        `${finding.interlock.store} wrote ` +
        `[${finding.interlock.firstWrittenAtMs}, ${finding.interlock.lastWrittenAtMs}], ` +
        `${finding.v1.store} wrote ` +
        `[${finding.v1.firstWrittenAtMs}, ${finding.v1.lastWrittenAtMs}]`,
    );
  }
  if (audit.findings.length > 0) {
    lines.push("  Condition 2 (no dual write) is VIOLATED for the records above.");
  }
  return lines;
}

function renderOwnership(ledger: OwnershipLedger): string[] {
  const lines = [
    "Ownership ledger at run start (conditions 3, 4, 6) " +
      `[${ledger.windowFromMs}, ${ledger.windowToMs})`,
  ];
  if (!ledger.available) {
    lines.push("  v1 claims: ABSENT");
    lines.push(`  reason: ${ledger.absentReason}`);
    lines.push(
      `  Interlock-owned runs listed: ${ledger.entries.length}. ` +
        "No collision is reported: a run changing owner mid-flight is only " +
        "visible as a run both systems claim, and only one side's claims " +
        "are here.",
    );
    return lines;
  }
  lines.push(`  v1 claims from: ${ledger.v1Source}`);
  lines.push(`  ledger entries: ${ledger.entries.length}`);
  for (const entry of ledger.entries) {
    lines.push(
      `    - ${entry.runId} -> ${entry.owningSystem} ` + `at ${entry.decidedAtMs} (${entry.store})`,
    );
  }
  lines.push(`  ${OWNERSHIP_COLLISION} findings: ${ledger.findingCount}`);
  for (const finding of ledger.findings) {
    const claims = finding.claims
      .map((claim) => `${claim.owningSystem} at ${claim.decidedAtMs} (${claim.store})`)
      .join("; ");
    lines.push(`    - ${finding.runId} claimed by ${claims}`);
  }
  if (ledger.findings.length > 0) {
    lines.push(
      "  Conditions 3, 4 and 6 (no run changes owner mid-flight) are " +
        "VIOLATED for the runs above. Both claims are listed as they " +
        "arrived; the report does not pick a side.",
    );
  }
  return lines;
}

function renderReadOnly(evidence: ReadOnlyEvidence): string[] {
  return [
    "Shadow path read-only assertion (condition 5), read off the live connection",
    `  PRAGMA query_only: ${evidence.queryOnly}`,
    `  uri: ${evidence.uri}`,
    `  file mode probe: ${evidence.fileModeProbe}`,
    `  PRAGMA query_only after probe: ${evidence.queryOnlyAfterProbe}`,
  ];
}

function requireWindow(fromMs: number, toMs: number): void {
  if (toMs <= fromMs) {
    throw new CanaryRefusal(
      `the canary window [${fromMs}, ${toMs}) is empty or inverted; a ` +
        "half-open window must end strictly after it starts " +
        "(time-base-policy.md section 2, rule 4)",
    );
  }
}
