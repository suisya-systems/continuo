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
 * AC-9's denominator: the run cohort and the four reasons a run is not in it
 * (section 2.1).
 *
 * `TERMINAL_RUN_STATUSES` is deliberately NOT re-exported here: it belongs to
 * the control plane's gate module and continuo already exports it from there.
 * A second export path would read as a second definition, which is the drift
 * cohort.ts imports it to avoid.
 */
export {
  COHORT_REASONS,
  COHORT_RUNS_QUERY,
  EXCLUDED_REASONS,
  IN_FLIGHT_AT_PERIOD_END,
  KNOWN_RUN_STATUSES,
  OWNERSHIP_COLLISION_QUERY,
  OwnershipAssertionRefused,
  PeriodNotClosedRefused,
  QUERY_DEFINITIONS as COHORT_QUERY_DEFINITIONS,
  RunCohort,
  STARTED_BEFORE_PERIOD,
  selectCohort,
  TERMINAL_STATUS_UNKNOWN,
  terminalInstantMs,
  touchesPeriod,
  UnknownRunStatusRefused,
  V1_OWNED,
} from "./cohort.js";
/**
 * Section 3.4's false-termination report.
 *
 * The `QUERY_DEFINITIONS`, the status/verdict/source literals and the query
 * text are all exported because they are part of what the report *claims*: the
 * provenance header carries the executed query text (interlock `D-0040`), and
 * `action.kind` is unconstrained in the DDL so the counted literal is a
 * declaration rather than something a reader can recover from the schema.
 */
/**
 * The per-module query catalogues, module-qualified.
 *
 * Python namespaces these -- `false_termination.QUERY_DEFINITIONS` and
 * `cohort.QUERY_DEFINITIONS` are two names -- and a flat barrel cannot carry
 * two exports of one spelling. Aliasing both, rather than letting whichever
 * module landed first keep the bare name, is the choice that stays honest as
 * more modules of this harness arrive: every catalogue is qualified, and none
 * is privileged by the order it was ported in. Each module still exports
 * `QUERY_DEFINITIONS` under its own path, exactly as the source does.
 */
export {
  type Adjudication,
  adjudicate,
  FalseTerminationRefusal,
  FalseTerminationReport,
  GROUND_TRUTH_PREFERENCE,
  measureFalseTermination,
  PRODUCTIVE_EVENT_TYPES_REQUIRED,
  QUERY_DEFINITIONS as FALSE_TERMINATION_QUERY_DEFINITIONS,
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
 * AC-10's ground truth: the labelled fixture corpus, its loader and its
 * evaluator (section 3.2).
 *
 * The refusal family is exported in full because every one of them is a
 * distinct thing a corpus can be wrong about, and an operator fixing a corpus
 * needs to know which.
 */
export {
  CASE_FILES,
  CaseIncomplete,
  CaseOutcome,
  ClassDirectoryMismatch,
  ClockNotSynthetic,
  CorpusCompositionRefused,
  DETECTED,
  EvaluationRefusal,
  EXPECTED_FILENAME,
  ExpectedLabel,
  evaluate,
  FACT_STATES,
  FALSE_POSITIVE,
  FixtureCase,
  FixtureCorpus,
  FixtureEvaluation,
  FixtureRefusal,
  IncidentBeforeOnset,
  LABEL_FIELDS,
  LabelMalformed,
  loadCase,
  loadCorpus,
  MISS,
  NegativeCasesRequired,
  NONE_CLASS,
  Observation,
  OutcomeMissing,
  PositiveCasesRequired,
  PROVENANCE_KINDS,
  ProducedIncident,
  renderFixtureReport,
  StrayEntryRefused,
  SyntheticClock,
  TRACE_FILENAME,
  TRUE_NEGATIVE,
  TraceMalformed,
  UnknownCaseInOutcomes,
  VERDICTS,
} from "./fixtures.js";
/**
 * Number rendering that matches Python's, which is a parity surface here rather
 * than presentation (`D-0104`). Exported because every later module in this
 * harness renders figures and must use the same one.
 */
export { formatFixed, isAscii } from "./format.js";
/**
 * Section 4's detection-latency report, its two references, and the ingestion
 * lag beside it.
 *
 * `INGESTION_LAG_QUERY` is exported for the same reason the false-termination
 * catalogue is: the provenance header carries the executed query text
 * (interlock `D-0040`), and a copy would be right on the day it was pasted.
 */
export {
  ClassLatency,
  DetectionBeforeOnset,
  Distribution,
  INGESTION_LAG_QUERY,
  IngestionLag,
  LatencyRefusal,
  LatencyReport,
  measureIngestionLag,
  measureLatency,
  noShadowReference,
  renderLatencyReport,
  SHADOW_ABSENT,
  SHADOW_PRESENT,
  ShadowReference,
  ShadowReferenceUnstated,
  ShadowSource,
  shadowFromBothBucket,
  UnknownEpisodeDetection,
} from "./latency.js";
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
/**
 * Section 3.5's observation window and its two censored buckets.
 *
 * The classification constants and `WINDOW_CLASSIFICATIONS` are exported
 * because a consumer must be able to iterate the buckets in the order the
 * report emits them, and because a report that named a bucket this module does
 * not have would otherwise fail only at read time.
 */
export {
  CENSORED,
  CENSORED_LEFT,
  classify,
  classifyEpisodes,
  DuplicateEpisodeRefused,
  defaultGraceMs,
  Episode,
  EpisodeOutsidePeriod,
  EpisodeWindow,
  episodeWindow,
  GRACE_DECLARED,
  GRACE_REVISION_RECONCILE_PERIOD,
  GraceNotDeclared,
  IN_PERIOD,
  PeriodRefused,
  requireGraceMs,
  resolveBudgetMs,
  SubjectRequired,
  WINDOW_CLASSIFICATIONS,
  WindowRefusal,
  WindowReport,
} from "./windows.js";
