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

/**
 * The item 10 rehearsal (Issue `#23`, D-0022): run-start routing, the run-owner
 * ledger, the writer audit, and the stand-in counterparty.
 *
 * Re-exported through `src/canary/index.ts` rather than from the five modules
 * directly, because the barrel *is* the surface: it lists 27 names and omits
 * the five of `ledger.ts`'s that decide whether a file is this ledger
 * (`LEDGER_APPLICATION_ID`, `LEDGER_REVISION`, `LEDGER_SCHEMA_PATH`,
 * `LEDGER_TABLES`, `loadLedgerSql`), plus `configureLedgerConnection`. Naming
 * the modules here would quietly hand back what the barrel withheld.
 *
 * The package exports only `.` (D-0002), so this block is what makes the
 * rehearsal reachable by an installed consumer at all. It is exported for the
 * same reason the source's package is importable: the rehearsal's artifacts --
 * the marking above all -- are meant to be readable from outside, and a
 * throwaway (D-0026) that cannot be inspected is not a rehearsal anyone can
 * audit.
 */
export {
  CorruptLedgerRefused,
  canonicalSqliteBytes,
  canonicalSyntheticBytes,
  compareAcrossRollback,
  createRoutingLedger,
  INTERLOCK,
  MissingLedgerRefused,
  NoRoutingDecision,
  OWNING_SYSTEMS,
  OwnerChangeRefused,
  openRoutingLedger,
  REHEARSAL_MARKING,
  type RollbackComparison,
  type RoutedRun,
  type RoutingDecision,
  RoutingLedgerRefusal,
  RoutingRefused,
  RunStartRoutingPoint,
  type StoreSnapshot,
  SYNTHETIC_V1,
  SyntheticStoreRefusal,
  SyntheticV1RunStore,
  snapshotStores,
  UnknownOwningSystem,
  UnroutedRun,
  type WriterAuditReport,
  writerAudit,
} from "./canary/index.js";
/**
 * The settings generator (D-0213), and the parser the whole CLI now shares.
 *
 * The parser moved to `src/cli/parser.ts` with `D-0030` -- it is one parser for
 * the unified CLI rather than the settings CLI's own -- but it is re-exported
 * from here, where it already was, rather than from a new place: it is the same
 * surface under a new path, and the ported cases that reach `ArgparseExit`
 * reach it by that name.
 *
 * `src/cli.ts` itself stays absent, as it was: it is the `continuo` bin, not
 * library surface.
 *
 * `generatorSeams` is deliberately absent: it is a seam for this module's own
 * tests, not public API, exactly as `spawnSeams` is.
 */
export {
  ArgparseExit,
  type ArgparseStreams,
  ArgumentParser,
  type ArgumentSpec,
  type Namespace,
  type Subparsers,
} from "./cli/parser.js";
export {
  AiInvocationRefused,
  AiInvocationUsageError,
  CompletionPrecedesStartRefused,
  completeInvocation,
  DuplicateInvocationRefused,
  InvocationAlreadyCompleteRefused,
  InvocationNotStartedRefused,
  MalformedAttemptCountRefused,
  MalformedCeilingRefused,
  MalformedResponseCountRefused,
  NegativeTokenCountRefused,
  OutputExceedsRequestCeilingRefused,
  ProviderUsage,
  readInvocation,
  startInvocation,
  UnknownUsageStatusRefused,
  USAGE_STATUSES,
  UsageStatusContradictsTokensRefused,
  UsageWithoutRecordRefused,
} from "./control_plane/ai_invocation.js";
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
  ATTEMPT_LOG_NAME,
  DeliveryReceipt,
  type Destination,
  DestinationRefusal,
  EFFECT_SUFFIX,
  FENCE_NAME,
  isDestination,
  KeyedDropbox,
  LOCK_NAME,
  StaleTokenRefused,
} from "./control_plane/destination.js";
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
  HUMAN_GATED_RECIPIENT,
  HumanGatedHandler,
  NOTIFY_RECIPIENT,
  NotifyDestinationHandler,
  spikeRegistry,
} from "./control_plane/handlers.js";
export {
  Authority,
  acquire,
  and_,
  appliedEpochRegressions,
  authorityTimeline,
  Claim,
  ClockSkewRefused,
  Comparison,
  Conjunction,
  claimedTimeline,
  DESTINATIONS,
  DestinationFencing,
  DestinationRejectedStaleToken,
  EpochGuardedDestination,
  EXACTLY_ONCE_MECHANISMS,
  effectKind,
  epochRegressions,
  eq,
  FENCE_PARAMS,
  FENCE_SQL,
  FencedStatement,
  fencedInsert,
  fencedUpdate,
  fenceEpoch,
  Increment,
  IsNull,
  increment,
  isNull,
  Lease,
  LeaseHeld,
  LeaseNotHeld,
  LeaseRefusal,
  LeaseUsageError,
  ne,
  overlappingClaims,
  Param,
  PROTECTED_TABLES,
  type Predicate,
  ProtectedWrite,
  ProtectedWriteMissed,
  param,
  protectedWrite,
  readLease,
  release,
  renew,
  resourceOfKind,
  StaleWriterRefused,
  UnfencedStatement,
  Value,
  value,
  WRITE_HISTORY_QUERY,
  writeHistory,
} from "./control_plane/lease.js";
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
  AckOutcome,
  ActionHandler,
  AttemptOutcome,
  CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  CHECKPOINT_BEFORE_DURABLE_WRITE,
  CHECKPOINT_DELIVERED_BEFORE_ACK,
  CHECKPOINTS,
  HandlerRegistry,
  HandlerRejected,
  HumanGateRequired,
  Outbox,
  OutboxMessage,
  OutboxUsageError,
  RecoveryReport,
  UNOWNED_OUTBOX_QUERY,
  UNSUPPORTED_MECHANISMS,
} from "./control_plane/outbox.js";
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
export {
  EFFECTIVE_REVISION_SQL,
  errorStreakScopes,
  HEARTBEAT_RESULTS,
  HeartbeatRefused,
  heartbeat,
  registerScope,
  retireScope,
  SCOPE_KINDS,
  SCOPE_LEASE_PREFIX,
  ScopeNotRegistered,
  scopeLeaseResource,
  silentScopes,
  uncoveredScopes,
  WatcherRefusal,
  WatcherUsageError,
} from "./control_plane/watcher.js";
/**
 * Per-role fencing: the rule model, the renderer, the breach battery, the
 * persisted fence and the fail-closed spawn precondition.
 *
 * Listed by name for the reason the entries above are: the package exports only
 * `.` (D-0002), so a name absent from here is one an installed consumer cannot
 * reach -- and `dist/fencing/roles.json` being present is not the same as the
 * renderer that reads it being importable.
 *
 * The surface mirrors interlock's `fencing/__init__.py` `__all__`, restricted to
 * what is ported. Absent because they are not ported yet, not because they were
 * judged internal: nothing from `__all__` -- `state.ts` and `spawn.ts` complete
 * it. Present here but NOT in that `__all__`: `EVENT_BATTERY`,
 * `REASON_BATTERY_INCOMPLETE`, `REASON_PROBE_UNSYNTHESIZABLE`,
 * `FENCE_FORMAT_VERSION`, `fenceToJson` and `fenceFromJson`, which are
 * module-level publics interlock's own cases import from
 * `claude_org_runtime.fencing.spawn` and `...fencing.state` directly. Python
 * offers a submodule path for that and a single-entry package does not, so the
 * names an interlock case can reach are the names this barrel carries -- a
 * ported case cannot be made to reach less than its original did.
 *
 * `hook.mjs` has no export here at all, and that is not an omission: the deny
 * hook is launched as a subprocess BY PATH (D-0204), so `defaultHookScript()`
 * is its entire public surface.
 *
 * The CPython transcriptions (`fnmatch`, `shlex`, `pypath`, `pyrepr`, `pyjson`,
 * `pysemantics`, `pyregex`, `uescape`) are deliberately absent. In interlock
 * those behaviours are the standard library, so they are not part of the
 * package's surface there either; here they are an implementation detail of the
 * fence, pinned by a differential vector (D-0200) rather than offered as API.
 */
export {
  BatteryReport,
  BreachProbe,
  ProbeResult,
  ProbeSynthesisError,
  probeFor,
  probeIds,
  probesFor,
  runBattery,
} from "./fencing/battery.js";
/**
 * The public effective-configuration readback (D-0214).
 *
 * Not in interlock's `fencing/__init__.py` `__all__` -- its cases import these
 * from `claude_org_runtime.fencing.readback` directly, which is the submodule
 * path this package does not have. Same reason `FenceLedger` and `fenceToJson`
 * are here: a ported case cannot be made to reach less than its original did.
 */
export {
  allServersConnected,
  compareReadbacks,
  comparisonEqual,
  type InitReadback,
  MCP_COUPLED_TOOLS,
  MCP_TOOL_PREFIX,
  parseInitEvent,
  type ReadbackComparison,
  ReadbackUnsound,
  readInitEvent,
  stableTools,
} from "./fencing/readback.js";
export {
  bundledDocumentPath,
  DISCARDED_ROLE_KEYS,
  FenceContext,
  FenceRefusal,
  loadDocument,
  RefusalReason,
  type RefusalReasonCode,
  type RoleDocument,
  renderFence,
  roleNames,
} from "./fencing/renderer.js";
export {
  type Decision,
  decide,
  Fence,
  FenceRule,
  FenceRuleNotFound,
  KIND_PERMISSION_DENY,
  KIND_SANDBOX_DENY_READ,
  KIND_SANDBOX_DENY_WRITE,
  LAYER_PERMISSIONS,
  LAYER_SANDBOX,
  makeDecision,
  parsePermissionRule,
  parseSandboxEntry,
  RuleSyntaxError,
  type ToolInput,
  WITNESS_TOKEN,
  witnessSubject,
} from "./fencing/rules.js";
export {
  defaultHookScript,
  EVENT_ADMITTED,
  EVENT_BATTERY,
  EVENT_REFUSED,
  FencedSpawner,
  FenceLedger,
  REASON_BATTERY_INCOMPLETE,
  REASON_PROBE_UNSYNTHESIZABLE,
  SpawnOutcome,
  SpawnPlan,
  type SpawnReason,
} from "./fencing/spawn.js";
export {
  diffFences,
  FENCE_FORMAT_VERSION,
  FenceDiff,
  FenceStateError,
  fenceFromJson,
  fenceToJson,
  readFence,
  writeFence,
} from "./fencing/state.js";
/**
 * Section 5's AC-7 canary divergence report.
 *
 * Re-exported straight from the module rather than through the measurement
 * barrel, and the reason is a ported invariant: interlock's
 * `tests/measurement/test_reader.py` asserts that the measurement PACKAGE
 * exports no name containing `migrate`, `create`, `write` or `lease`, so that a
 * writer cannot be reached through the harness's own front door. canary's
 * vocabulary is full of the word -- `WriterAudit`, `WrittenRecord`,
 * `auditWriters`, `DUAL_WRITE` -- because what it audits IS writing, and none
 * of those names is a writer. interlock keeps the invariant by re-exporting
 * only reader's names from `measurement/__init__.py`; continuo's wider barrel
 * exists only because D-0002 exports `.` alone, so the fix belongs to the
 * barrel and not to the assertion. See DECISIONS.md D-0106.
 */
export {
  auditWriters,
  buildOwnershipLedger,
  CanaryDivergenceReport,
  CanaryRefusal,
  DUAL_WRITE,
  DualWriteFinding,
  evidenceOfReadOnly,
  FILE_REFUSED_THE_WRITE,
  FINDING_KINDS,
  INTERLOCK_STORE,
  MODE_RO,
  measureCanaryDivergence,
  NO_VERDICT_NOTE,
  OWNERSHIP_COLLISION,
  OWNERSHIP_LEDGER_QUERY,
  OwnedRun,
  OwnershipCollisionFinding,
  OwnershipInputRefused,
  OwnershipLedger,
  QUERY_DEFINITIONS as CANARY_QUERY_DEFINITIONS,
  READ_ONLY_URI_QUERY,
  RECORD_CLASS_PULL_REQUEST,
  RECORD_CLASS_RUN,
  RECORD_CLASSES,
  ReadOnlyEvidence,
  RecordClass,
  readInterlockRecords,
  renderCanaryDivergenceReport,
  UndeclaredRecordClass,
  V1InputRefused,
  V1OwnershipInput,
  V1WriterLedger,
  WriterAudit,
  WrittenRecord,
} from "./measurement/canary.js";
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
  AC9_QUERY_DEFINITIONS,
  Ac9MeasurementRefused,
  Ac9Report,
  ADAPTER_VERSIONS_QUERY,
  ADJUDICATIONS,
  type Adjudication,
  AdjudicationPending,
  AGGREGATE_STATEMENT,
  AsynchronousReportRefused,
  AWAITING_HUMAN,
  adjudicate,
  BaselineRefused,
  BLOCK_LANGUAGE,
  BOTH,
  BOUNDED_IMPUTATION_RULE,
  BOUNDED_ONSET_CAVEAT,
  buildHeader,
  buildMeasurementReport,
  CASE_FILES,
  CaseIncomplete,
  CaseOutcome,
  CENSORED,
  CENSORED_LEFT,
  CI_OUTCOME_EPISODES_QUERY,
  ClassDirectoryMismatch,
  ClassLatency,
  ClockNotSynthetic,
  COHORT_INVOCATIONS_QUERY,
  COHORT_QUERY_DEFINITIONS,
  COHORT_REASONS,
  COHORT_RUNS_QUERY,
  CONTENT_STATEMENT,
  CorpusCompositionRefused,
  CorrelationKey,
  CoverageSummary,
  cell,
  censoredEpisodeIds,
  classify,
  classifyEpisodes,
  coverageFromAc9,
  DatabaseFingerprint,
  DETECTED,
  DETECTOR_VERSIONS_QUERY,
  DetectionBeforeOnset,
  Distribution,
  DuplicateCorrelationKey,
  DuplicateEpisodeIdRefused,
  DuplicateEpisodeRefused,
  DuplicateSectionRefused,
  defaultGraceMs,
  EMPTY_BLOCK,
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
  FINGERPRINT_AGGREGATE,
  FINGERPRINT_CONTENT,
  FINGERPRINT_MODES,
  FINGERPRINT_TABLES,
  Figure,
  FigureExceedsExactRangeRefused,
  FingerprintModeRefused,
  FixtureCase,
  FixtureCorpus,
  FixtureEvaluation,
  FixtureRefusal,
  FixtureSuiteRef,
  FROM_FIXTURE_LABEL,
  fingerprintDatabase,
  fixtureSuiteRef,
  flatten,
  formatFixed,
  GRACE_DECLARED,
  GRACE_REVISION_RECONCILE_PERIOD,
  GROUND_TRUTH_PREFERENCE,
  GraceNotDeclared,
  HEADER_QUERIES,
  type HeaderValue,
  ImputationRule,
  IN_FLIGHT_AT_PERIOD_END,
  IN_PERIOD,
  INGESTION_LAG_QUERY,
  INTERLOCK_ONLY,
  IncidentBeforeOnset,
  IngestionLag,
  imputationFromAc9,
  isAscii,
  iso8601Ms,
  JSON_RENDERING,
  KIND_ASSUMPTION,
  KIND_FACT,
  KIND_LOWER_BOUND,
  KNOWN_RUN_STATUSES,
  LABEL_FIELDS,
  LabelMalformed,
  LatencyRefusal,
  LatencyReport,
  loadCase,
  loadCorpus,
  MARKDOWN,
  MatchedPair,
  MeasuredBaseline,
  MeasurementReport,
  MISS,
  measureAc9,
  measureFalseTermination,
  measureIngestionLag,
  measureLatency,
  measurementSnapshot,
  NegativeCasesRequired,
  NestedSnapshotRefused,
  NO_VERDICT_NOTE as RENDER_NO_VERDICT_NOTE,
  NONE_CLASS,
  NotAProductionDatabase,
  noShadowReference,
  Observation,
  ONSET_BASES,
  ONSET_BUCKET_MS,
  ONSET_OBSERVED,
  ONSET_UPPER_BOUND,
  OUTPUT_TOKEN_REDUCTION_TARGET,
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
  PROMPT_REDUCTION_TARGET,
  PROVENANCE_KINDS,
  ProducedIncident,
  ProvenanceRefusal,
  PythonFloat,
  proveReadOnly,
  QUERY_CATALOGUE_LIMITATION,
  QueryCatalogue,
  QueryDefinitionsRefused,
  queryCatalogue,
  RECONCILIATION_BUCKETS,
  RENDERINGS,
  REPORT_KIND,
  REPORT_QUERY_SOURCES,
  ReadOnlyCapabilityRefused,
  RenderRefusal,
  ReportHeader,
  type ReportHeaderLike,
  ReportPeriodRefused,
  ReportSection,
  type ReportValue,
  RevisionNotInPeriod,
  RunCohort,
  readCiOutcomeEpisodes,
  readInterlockEpisodes,
  readPrMergeEpisodes,
  readSessionLivenessEpisodes,
  readTerminateActions,
  readWorkerEscalationEpisodes,
  reconcile,
  render,
  renderAc9Report,
  renderFalseTerminationReport,
  renderFixtureReport,
  renderHeaderJson,
  renderHeaderMarkdown,
  renderJson,
  renderLatencyReport,
  renderMarkdown,
  renderShadowReconciliation,
  reportQueryDefinitions,
  requireGraceMs,
  resolveBudgetMs,
  SchemaMigrationHead,
  SENSITIVITY_IMPUTATION_RULE,
  SESSION_LIVENESS_EPISODES_QUERY,
  SectionNameRefused,
  SectionsRequired,
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
  sectionFromAc9,
  sectionFromWindowDeclaration,
  selectCohort,
  shadowFromBothBucket,
  subsequentActivityVerdicts,
  TableNotReadable,
  TERMINAL_STATUS_UNKNOWN,
  TERMINATE_ACTIONS_QUERY,
  TERMINATE_SESSION_KIND,
  TerminateAction,
  TOOL_VERSION,
  TRACE_FILENAME,
  TRUE_NEGATIVE,
  TraceMalformed,
  terminalInstantMs,
  touchesPeriod,
  UNATTESTED_STATEMENTS,
  UNATTRIBUTED_INVOCATIONS_QUERY,
  UNDETERMINED,
  UNMATCHED_KEY,
  UnknownAdjudication,
  UnknownCaseInOutcomes,
  UnknownEpisodeDetection,
  UnknownGroundTruthVerdict,
  UnknownRendering,
  UnknownRunStatusRefused,
  UnknownSubjectClass,
  UnknownUsageStatusInLedgerRefused,
  V1_FALSE_POSITIVE,
  V1_MEASURED_BASELINE,
  V1_ONLY,
  V1_OWNED,
  V1OnlyEpisode,
  V1Reference,
  V1ShadowInput,
  V1ShadowInputRefused,
  VERDICT_NOT_STUCK,
  VERDICT_STUCK,
  VERDICT_UNDETERMINED,
  VERDICTS,
  WINDOW_CLASSIFICATIONS,
  WINDOW_EPISODES_NOT_CLASSIFIED,
  WindowRefusal,
  WindowReport,
  WORKER_ESCALATION_EPISODES_QUERY,
} from "./measurement/index.js";
export { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";
/**
 * The item 8 rehearsal (interlock Issue `#21`, interlock D-0022): the stub
 * Secretary intake and its explicit queue boundary.
 *
 * Re-exported through `src/secretary/index.ts` rather than from `intake.ts`
 * directly, because the barrel *is* the surface: it lists the four names of the
 * boundary contract and omits the status vocabulary (`ACCEPTED`,
 * `REFUSED_QUEUE_FULL`) and the item type that crosses the boundary, which the
 * source keeps private. Naming the module here would quietly hand back what the
 * barrel withheld.
 *
 * The package exports only `.` (D-0002), so this block is what makes the
 * rehearsal reachable by an installed consumer at all -- and a throwaway
 * (interlock D-0026) whose non-blocking claim cannot be inspected from outside
 * is not a rehearsal anyone can audit. The boundary contract itself is written
 * down in `docs/secretary-intake-boundary.md` (D-0701).
 */
export { IntakeQueue, IntakeReceipt, IntakeRefused, SecretaryIntake } from "./secretary/index.js";

/**
 * The session subsystem (S1, S2, S3).
 *
 * Re-exported through `src/session/index.ts` rather than from the four modules
 * directly, so this file and that barrel cannot drift into two different
 * answers about what the subsystem's surface is.
 *
 * **`Observation` is aliased, and only here.** `src/measurement/fixtures.ts`
 * already exports a class of that name through this barrel, and the two mean
 * different things -- the measurement one is a harness fixture, this one is
 * S1's "the backend's state was read" / "it could not be read" distinction.
 * It is the ONLY alias: `Ok`, `Failure` and `ContractViolation` are generic
 * enough to look like clashes and are not, and renaming a name the source
 * chose, without a clash to force it, is a divergence for tidiness.
 * The alias is on the newcomer because the other name is already on this
 * surface and renaming it would break a consumer to spare a name clash. Inside
 * the subsystem, and in `src/session/index.ts`, the name stays `Observation`:
 * that is what the source calls it and what every ported case asserts against.
 *
 * The interface this exposes is **provisional** by its own declaration
 * (`PROVISIONAL` is `true`, and `PROMOTION_REQUIRES` says what would settle
 * it). Exporting it is not a claim that it is settled. It is here because the
 * alternative is worse: a barrel the package entry point does not reach is a
 * module claiming a consumer it does not have, and it would leave the only
 * subsystem in this repository that cannot be imported by the name the package
 * publishes. The package is `private` until publication is decided (D-0008),
 * so nothing is promised to anyone by this line today.
 */
export {
  ANNOUNCE_AFTER_ENV,
  CAPABILITY_ASSIGNMENTS,
  CapabilityAssignment,
  type CapabilityAssignmentFields,
  CapabilityReport,
  type CapabilityReportFields,
  CLI_VERSION_WRITTEN_AGAINST,
  ClaudeCliSessionProvider,
  type ClaudeCliSessionProviderOptions,
  ContractViolation,
  checkSpawnPrecondition,
  claudeSessionUuid,
  D0009_VERBS,
  DEFAULT_CHILD_STATE,
  DELIVERY_ABSENCE_IS_DELIBERATE,
  Failure,
  FailureKind,
  LocalProcessSessionProvider,
  type LocalProcessSessionProviderOptions,
  Observation as SessionObservation,
  Ok,
  OWNER_MESSAGE_BUS,
  OWNER_NEITHER_CONTRACT,
  OWNER_SESSION_PROVIDER,
  PROMOTION_REQUIRES,
  PROVISIONAL,
  type ProviderResult,
  REQUIRED_CAPABILITIES,
  SessionProvider,
  SessionReadout,
  type SessionReadoutFields,
  SpawnRefused,
  STATE_FILE_ENV,
  StartRequest,
  type StartRequestFields,
  VERB_IMPLEMENTATION_HOOKS,
  WorkspaceDecision,
  type WorkspaceLifecycleObserver,
  WorkspaceTransition,
  type WorkspaceTransitionFields,
  WorkspaceVerdict,
} from "./session/index.js";
export {
  addArguments,
  addDoctorArguments,
  addSandboxSubparsers,
  addSettingsSubparsers,
  addShowArguments,
  buildDoctorParser,
  buildParser,
  defaultStreams,
  main as settingsMain,
} from "./settings/cli.js";
export {
  bundledSchemaPath,
  detectWsl,
  formatShowOutput,
  type GeneratorContext,
  loadSchema,
  normalizeSandboxEntry,
  type RenderOptions,
  type RenderResult,
  renderRole,
  renderRoleWithMetadata,
  run as settingsGenerate,
  runShow as settingsShow,
  type SandboxMetadata,
  type SandboxPathRewrite,
  type SandboxSuppression,
  SchemaNotFoundError,
  type SettingsArgs,
  sandboxMetadata,
  sandboxMetadataToJsonable,
} from "./settings/generator.js";
/**
 * The sandbox preflight and its bwrap canary (D-0214).
 *
 * Here for the same reason `readback` is: the source's cases reach it as
 * `claude_org_runtime.settings.sandbox_doctor`, and a single-entry package has
 * no submodule path to offer instead. `doctorSeams` is deliberately absent, as
 * `generatorSeams` and `spawnSeams` are -- it is a seam for this module's own
 * tests, not public API.
 */
export {
  analyzeTargets,
  CANARY_FAIL,
  CANARY_PASS,
  CANARY_SKIPPED,
  type CanaryRunner,
  type CompletedProcess,
  collectDenyTargets,
  DEFAULT_MANAGED_SETTINGS_PATHS,
  type DenyTarget,
  type DoctorArgs,
  type DoctorReport,
  diagnose,
  diagnoseSources,
  discoverMergedScopes,
  type Finding,
  findingToJsonable,
  formatReport,
  loadSource,
  PROJECT_SCOPE_FILENAMES,
  reportFailures,
  reportOk,
  reportToJsonable,
  run as sandboxDoctor,
  runBwrapCanary,
  type SettingsSource,
  STATUS_OK,
  STATUS_SYMLINK_ESCAPE,
  STATUS_UNSUPPORTED,
  USER_SETTINGS_PATH,
  validateSettings,
} from "./settings/sandbox_doctor.js";
export { isConstraintError } from "./sqlite/errors.js";
export { MEMORY, type OpenDatabaseOptions, openDatabase } from "./sqlite/open.js";
