/**
 * G6 -- the measurement harness.
 *
 * The instrument AC-9's rate, AC-10's ground truth and the AC-7 divergence
 * report are computed with. Its first and most load-bearing property is that it
 * cannot write: interlock's `ACCEPTANCE.md` section 3 condition 5 requires the
 * shadow path to be read-only **enforced by capability, not by convention**
 * (interlock `D-0040`), and {@link ./reader.js} is the only place in this
 * package that opens a database.
 *
 * Everything else here reads through the connection {@link openForMeasurement}
 * returns, so no module in the harness has to be trusted to refrain from
 * writing: none of them holds a handle that could.
 *
 * This barrel is deliberately narrow, and a source case is what keeps it that
 * way: it asserts that no exported name contains `migrate`, `create`, `write`
 * or `lease`. A writer re-exported here would be a writer the harness's callers
 * could reach through the harness's own front door.
 */

/**
 * Section 3.4's false-termination report.
 *
 * The `QUERY_DEFINITIONS`, the status/verdict/source literals and the query
 * text are all exported because they are part of what the report *claims*: the
 * provenance header carries the executed query text (interlock `D-0040`), and
 * `action.kind` is unconstrained in the DDL so the counted literal is a
 * declaration rather than something a reader can recover from the schema.
 */
export {
  type Adjudication,
  adjudicate,
  FalseTerminationRefusal,
  FalseTerminationReport,
  GROUND_TRUTH_PREFERENCE,
  measureFalseTermination,
  PRODUCTIVE_EVENT_TYPES_REQUIRED,
  QUERY_DEFINITIONS,
  readTerminateActions,
  renderFalseTerminationReport,
  SOURCE_FIXTURE_LABEL,
  SOURCE_HUMAN_ADJUDICATION,
  SOURCE_NONE,
  SOURCE_SUBSEQUENT_EVIDENCE,
  STATUS_APPLIED,
  STATUS_PENDING,
  STATUS_REFUSED,
  SUBSEQUENT_ACTIVITY_QUERY,
  subsequentActivityVerdicts,
  TERMINATE_ACTIONS_QUERY,
  TERMINATE_SESSION_KIND,
  TerminateAction,
  UnknownGroundTruthVerdict,
  VERDICT_NOT_STUCK,
  VERDICT_STUCK,
  VERDICT_UNDETERMINED,
} from "./false-termination.js";
/**
 * Number rendering that matches Python's, which is a parity surface here rather
 * than presentation (`D-0104`). Exported because every later module in this
 * harness renders figures and must use the same one.
 */
export { formatFixed, isAscii } from "./format.js";
export {
  AsynchronousReportRefused,
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MissingStateRefused,
  measurementSnapshot,
  NestedSnapshotRefused,
  openForMeasurement,
  proveReadOnly,
  ReadOnlyCapabilityRefused,
} from "./reader.js";
