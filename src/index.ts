/**
 * Public entry point for @suisya-systems/continuo.
 *
 * This package is the TypeScript port of interlock. At bootstrap the surface is
 * deliberately near-empty: the port lands module by module, test-first, and
 * every export added here is one the ported test suite already pins.
 *
 * Design lineage of record: https://github.com/suisya-systems/interlock
 * (DECISIONS.md D-0001..D-0042, docs/parity-audit.md).
 */

export {
  CHECK_SCOPES,
  CI_OBSERVED_EVENT_TYPE,
  CI_PROVIDERS,
  CI_VERDICTS,
  CiObservationRefused,
  EmptyIdentityFieldRefused,
  MalformedAttemptRefused,
  MalformedHeadShaRefused,
  MalformedPrNumberRefused,
  NO_ELIGIBLE_EVIDENCE,
  ObservationIdentity,
  observationDedupKey,
  prVerdict,
  recordCiObservation,
  type ScopeVerdict,
  scopeVerdicts,
  UnknownCheckScopeRefused,
  UnknownVerdictRefused,
  UnsupportedProviderRefused,
  VERDICT_SEVERITY,
} from "./control_plane/ci_ingest.js";
/**
 * The production control plane.
 *
 * The package exports only `.` (D-0002), so a name that is not re-exported here
 * is a name an installed consumer cannot reach at all -- `dist` containing the
 * module is not the same as the module being importable.
 *
 * `migratorSeams` and `schemaSeams` are deliberately absent. Each is a test
 * seam that reproduces Python's late binding (D-0014), and a consumer
 * replacing an entry on either would be reaching into a module's internals
 * through a door left open for tests.
 */
export {
  type ControlPlaneOpenOptions,
  configureConnection,
  openControlPlaneConnection,
} from "./control_plane/connection.js";
export {
  type AppendedEvent,
  appendEvent,
  BACKLOG_INCIDENT_CLASS,
  type BackloggedConsumer,
  backlogDepth,
  backloggedConsumers,
  CONSUMER_FENCE_SQL,
  type ConsumptionRow,
  DEGRADED_ORPHANED_OUTBOX_SQL,
  drainFrontier,
  EVENT_TYPES,
  EventSpineRefusal,
  EventSpineUsageError,
  headOfLineAgeMs,
  markConsumed,
  markFailed,
  markSkipped,
  ORPHANED_OUTBOX_SQL,
  type OrphanedOutboxRow,
  OUTBOX_DELIVERY_INCIDENT_CLASS,
  orphanedOutbox,
  registerConsumer,
  StaleConsumerRefused,
  subscribe,
  type UndrainedRow,
  undrained,
  unsubscribe,
} from "./control_plane/events.js";
export {
  ADMISSIBLE,
  AnswerBodyRequired,
  advanceOnAck,
  CLOSE_OUTCOME_STAGES,
  CorrectionTargetRefused,
  closeGate,
  type Edge,
  enqueueRelay,
  GATE_OUTCOMES,
  GATE_STAGES,
  GATE_TYPES,
  GateClosedRefused,
  GateRefusal,
  gatesNeedingAdvance,
  gatesPastDeadline,
  InadmissibleTransitionRefused,
  openGate,
  RELAYED_STAGES,
  RelayNotAckedRefused,
  recordCorrection,
  recordResend,
  relayGaps,
  stalledRelays,
  sweepSubjectGone,
  TERMINAL_RUN_STATUSES,
  TRANSITION_KINDS,
  UnknownGateRefused,
  WRITER,
} from "./control_plane/gates.js";
export {
  type AppliedMigration,
  appliedMigrations,
  createProductionControlPlane,
  discoverMigrationSteps,
  headVersion,
  LEDGER_COMPANIONS,
  MIGRATIONS_DIR,
  type MigrationStep,
  migrateControlPlane,
  openProductionControlPlane,
  PRODUCTION_APPLICATION_ID,
  renderCurrentSchema,
  STEP_FILENAME,
  verifyProductionDatabase,
} from "./control_plane/migrator.js";
export {
  BUDGET_KINDS,
  type BudgetViolation,
  budgetViolations,
  type DetectionLatencyPolicy,
  detectionLatency,
  effectiveRevisionId,
  type GateStageOwner,
  gateStageOwner,
  gateStageTolerance,
  NoEffectiveRevision,
  NotADuration,
  PolicyRefusal,
  PolicyRowMissing,
  PolicyUsageError,
  resolveToleranceMs,
  revisionOverPeriod,
  subjectUnitMs,
  THRESHOLD_KINDS,
} from "./control_plane/policy.js";
export {
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MigrationStepsRefused,
  MissingStateRefused,
} from "./control_plane/refusals.js";
export {
  linkRunPr,
  type ObservedPullRequest,
  observePullRequest,
  PR_STATES,
  PullRequestObservationRefused,
  primaryLink,
  RESOLUTIONS,
  RepoResolutionError,
  ROLES,
  RunPrLinkRefused,
  resolveRepository,
  StalePullRequestObservation,
  unlinkRunPr,
  upsertRepository,
} from "./control_plane/repo_link.js";
export {
  type ControlPlaneState,
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
} from "./control_plane/schema.js";
export { SPIKE_APPLICATION_ID } from "./control_plane/spike.js";
export {
  currentScope,
  inAutocommit,
  TransactionUsageError,
  transaction,
} from "./control_plane/txn.js";
/**
 * The G6 measurement harness.
 *
 * Only the measurement-specific names are listed: the refusal family it shares
 * with the control plane (`ControlPlaneRefusal` and friends) is already
 * exported above, and re-exporting the same bindings twice would be a duplicate
 * export rather than a second way to reach them.
 *
 * `readerSeams`, `requireQueryOnly` and `theErrorSaysTheDatabaseIsReadOnly` are
 * deliberately absent. The first is a test seam (D-0014); the other two are
 * module internals exported only because a source case reaches them and
 * TypeScript has no other way to be reached (D-0101). None of the three is
 * package API, and the measurement barrel's own test asserts the package
 * exports no way to write.
 */
/**
 * The G6 harness's false-termination report (section 3.4), and the number
 * rendering the whole harness shares.
 *
 * Re-exported by name for the same reason as the measurement reader above: the
 * package exports only `.` (D-0002), so a name absent from here is one an
 * installed consumer cannot reach.
 */
/**
 * The G6 harness's observation window (section 3.5).
 *
 * Re-exported by name for the reason the entries above are: the package exports
 * only `.` (D-0002), so a name absent from here is one an installed consumer
 * cannot reach.
 */
/**
 * The G6 harness's detection-latency report (section 4).
 *
 * Re-exported by name for the reason the entries above are: the package exports
 * only `.` (D-0002), so a name absent from here is one an installed consumer
 * cannot reach.
 */
/**
 * The G6 harness's labelled fixture corpus (AC-10 source A, section 3.2).
 *
 * Re-exported by name for the reason the entries above are: the package exports
 * only `.` (D-0002), so a name absent from here is one an installed consumer
 * cannot reach.
 */
/**
 * The G6 harness's AC-9 cohort (section 2.1).
 *
 * Re-exported by name for the reason the entries above are: the package exports
 * only `.` (D-0002), so a name absent from here is one an installed consumer
 * cannot reach.
 */
/**
 * The G6 harness's per-module query catalogues, module-qualified.
 *
 * See the note in `src/measurement/index.ts`: Python namespaces these and a flat
 * export surface cannot, so both are qualified rather than one keeping the bare
 * name by having been ported first.
 */
export {
  ADJUDICATIONS,
  type Adjudication,
  AdjudicationPending,
  AsynchronousReportRefused,
  AWAITING_HUMAN,
  adjudicate,
  BOTH,
  BOUNDED_ONSET_CAVEAT,
  CASE_FILES,
  CaseIncomplete,
  CaseOutcome,
  CENSORED,
  CENSORED_LEFT,
  CI_OUTCOME_EPISODES_QUERY,
  ClassDirectoryMismatch,
  ClassLatency,
  ClockNotSynthetic,
  COHORT_QUERY_DEFINITIONS,
  COHORT_REASONS,
  COHORT_RUNS_QUERY,
  CorpusCompositionRefused,
  CorrelationKey,
  censoredEpisodeIds,
  classify,
  classifyEpisodes,
  DETECTED,
  DetectionBeforeOnset,
  Distribution,
  DuplicateCorrelationKey,
  DuplicateEpisodeIdRefused,
  DuplicateEpisodeRefused,
  defaultGraceMs,
  Episode,
  EpisodeKeyRefused,
  EpisodeOutsidePeriod,
  EpisodeWindow,
  EvaluationRefusal,
  EXCLUDED_REASONS,
  EXPECTED_FILENAME,
  ExpectedLabel,
  episodeWindow,
  evaluate,
  FACT_STATES,
  FALSE_POSITIVE,
  FALSE_TERMINATION_QUERY_DEFINITIONS,
  FalseTerminationRefusal,
  FalseTerminationReport,
  FixtureCase,
  FixtureCorpus,
  FixtureEvaluation,
  FixtureRefusal,
  FROM_FIXTURE_LABEL,
  formatFixed,
  GRACE_DECLARED,
  GRACE_REVISION_RECONCILE_PERIOD,
  GROUND_TRUTH_PREFERENCE,
  GraceNotDeclared,
  IN_FLIGHT_AT_PERIOD_END,
  IN_PERIOD,
  INGESTION_LAG_QUERY,
  INTERLOCK_ONLY,
  IncidentBeforeOnset,
  IngestionLag,
  isAscii,
  KNOWN_RUN_STATUSES,
  LABEL_FIELDS,
  LabelMalformed,
  LatencyRefusal,
  LatencyReport,
  loadCase,
  loadCorpus,
  MatchedPair,
  MISS,
  measureFalseTermination,
  measureIngestionLag,
  measureLatency,
  measurementSnapshot,
  NegativeCasesRequired,
  NestedSnapshotRefused,
  NONE_CLASS,
  noShadowReference,
  Observation,
  ONSET_BASES,
  ONSET_BUCKET_MS,
  ONSET_OBSERVED,
  ONSET_UPPER_BOUND,
  OutcomeMissing,
  OWNERSHIP_COLLISION_QUERY,
  OwnershipAssertionRefused,
  openForMeasurement,
  PeriodNotClosedRefused,
  PeriodRefused,
  POSITIONAL_KEY_CAVEAT,
  POSITIONAL_SUBJECT_CLASSES,
  PositiveCasesRequired,
  PR_MERGE_EPISODES_QUERY,
  PRODUCTIVE_EVENT_TYPES_REQUIRED,
  PROVENANCE_KINDS,
  ProducedIncident,
  proveReadOnly,
  RECONCILIATION_BUCKETS,
  ReadOnlyCapabilityRefused,
  RunCohort,
  readCiOutcomeEpisodes,
  readInterlockEpisodes,
  readPrMergeEpisodes,
  readSessionLivenessEpisodes,
  readTerminateActions,
  readWorkerEscalationEpisodes,
  reconcile,
  renderFalseTerminationReport,
  renderFixtureReport,
  renderLatencyReport,
  renderShadowReconciliation,
  requireGraceMs,
  resolveBudgetMs,
  SESSION_LIVENESS_EPISODES_QUERY,
  SHADOW_ABSENT,
  SHADOW_CENSORED,
  SHADOW_MISS,
  SHADOW_PRESENT,
  SHADOW_QUERY_DEFINITIONS,
  SHADOW_REFERENCE_ABSENT,
  SHADOW_REFERENCE_PRESENT,
  ShadowEpisode,
  ShadowReconciliation,
  ShadowReference,
  ShadowReferenceAbsent,
  ShadowReferenceRefused,
  ShadowReferenceUnstated,
  ShadowRefusal,
  ShadowSource,
  SOURCE_FIXTURE_LABEL,
  SOURCE_HUMAN_ADJUDICATION,
  SOURCE_NONE,
  SOURCE_SUBSEQUENT_EVIDENCE,
  STARTED_BEFORE_PERIOD,
  STATUS_APPLIED,
  STATUS_PENDING,
  STATUS_REFUSED,
  StrayEntryRefused,
  SUBJECT_CI_OUTCOME,
  SUBJECT_CLASSES,
  SUBJECT_PR_MERGE,
  SUBJECT_SESSION_LIVENESS,
  SUBJECT_WORKER_ESCALATION,
  SUBSEQUENT_ACTIVITY_QUERY,
  SubjectRequired,
  SyntheticClock,
  selectCohort,
  shadowFromBothBucket,
  subsequentActivityVerdicts,
  TERMINAL_STATUS_UNKNOWN,
  TERMINATE_ACTIONS_QUERY,
  TERMINATE_SESSION_KIND,
  TerminateAction,
  TRACE_FILENAME,
  TRUE_NEGATIVE,
  TraceMalformed,
  terminalInstantMs,
  touchesPeriod,
  UNDETERMINED,
  UNMATCHED_KEY,
  UnknownAdjudication,
  UnknownCaseInOutcomes,
  UnknownEpisodeDetection,
  UnknownGroundTruthVerdict,
  UnknownRunStatusRefused,
  UnknownSubjectClass,
  V1_FALSE_POSITIVE,
  V1_ONLY,
  V1_OWNED,
  V1OnlyEpisode,
  V1Reference,
  VERDICT_NOT_STUCK,
  VERDICT_STUCK,
  VERDICT_UNDETERMINED,
  VERDICTS,
  WINDOW_CLASSIFICATIONS,
  WindowRefusal,
  WindowReport,
  WORKER_ESCALATION_EPISODES_QUERY,
} from "./measurement/index.js";
export { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";
export { isConstraintError } from "./sqlite/errors.js";
export { MEMORY, type OpenDatabaseOptions, openDatabase } from "./sqlite/open.js";
