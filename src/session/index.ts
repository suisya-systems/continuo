/**
 * S1 -- the session contracts, and the two providers that implement them.
 *
 * The port of interlock's `src/claude_org_runtime/session/__init__.py` at
 * `65f36c5`. `SessionProvider` (D-0009) lives here; `MessageBus` deliberately
 * does not -- delivery is a separate contract built as S8, and the separation
 * is the point (see {@link DELIVERY_ABSENCE_IS_DELIBERATE}).
 *
 * {@link LocalProcessSessionProvider} (S3) is the deliberately trivial
 * implementation over local child processes; {@link ClaudeCliSessionProvider}
 * (S2) is the C2 implementation over Interlock-supervised `claude -p`
 * subprocesses (D-0025, D-0027). The contract they implement stays provisional
 * (D-0021) whether or not something implements it.
 *
 * ## What this barrel carries, and on what ground
 *
 * The source's `__all__` names thirty things, and all thirty are ported and
 * listed below under the camelCase spelling D-0201 gives them. Three further
 * kinds of name are here, each for a reason the repository has already used:
 *
 * 1. **Module-level publics an interlock case imports by submodule path** --
 *    `STATE_FILE_ENV`, `ANNOUNCE_AFTER_ENV` and `DEFAULT_CHILD_STATE`
 *    (`tests/session/test_stub_provider.py` imports all three from
 *    `...session.stub_provider`) and {@link CLI_VERSION_WRITTEN_AGAINST}
 *    (`test_claude_cli_provider.py` reaches it as `s2.CLI_VERSION_WRITTEN_AGAINST`).
 *    Python offers a submodule path for that and a single-entry package
 *    (D-0002) does not, so a ported case cannot be made to reach less than its
 *    original did. This is the same ground `src/index.ts` states for
 *    `fencing`'s `FENCE_FORMAT_VERSION` and friends.
 * 2. **The seven shapes this port had to name because Python did not have to.**
 *    Python's dataclasses and keyword-only constructors carry their parameter
 *    names on the class; TypeScript needs a separate interface, and this port
 *    wrote one -- `StartRequestFields` and its four siblings, and the two
 *    `...ProviderOptions`. Each is the declared parameter type of a
 *    constructor on a class that IS in `__all__`, so with `exports` restricted
 *    to `.` (D-0002) a barrel that omitted them would ship a class whose
 *    argument type no consumer can name. `src/index.ts` already carries
 *    `ControlPlaneOpenOptions`, `OpenDatabaseOptions` and `ArgparseStreams` on
 *    exactly this ground.
 *
 * ## What is deliberately absent
 *
 * `./runtime.ts` contributes **nothing**. It is this belt's single runtime
 * adapter -- spawn, exit waiting, process-group signalling, `/proc` reads, the
 * monotonic clock and the record write -- and D-0014 makes it a seam that tests
 * substitute, not API a consumer may reach. `sessionRuntime` above all: a
 * consumer replacing an entry on it would be reaching into the belt through a
 * door left open for tests. `ChildHandle`, `SpawnOptions`, `ProbeResult`,
 * `SessionRuntime` and `ChildTimeout` go with it; `ChildTimeout` in particular
 * is raised and caught entirely inside the two providers and never crosses the
 * contract boundary, so exporting it would advertise a failure a caller cannot
 * observe. It has no Python counterpart to be measured against either -- it is
 * the adapter interlock's two modules' OS calls collapse into.
 *
 * `LocalProcessSessionProvider.childOf`, `.stateFileOf` and
 * `ClaudeCliSessionProvider.childOf` are `@internal` (D-0101): they are the
 * exported form of a `provider._sessions[...]` reach that is module-private in
 * the source. Being instance methods they could not appear in a barrel in any
 * case, which is the shape D-0101 wants -- an internal is *called* by a test,
 * not offered to a consumer.
 *
 * `ABSTRACT_METHODS` and `VERB_DOCS` are absent because they have no source
 * counterpart at all: they exist because `ABCMeta` and `__doc__` are runtime
 * facts in Python and a JSDoc block is gone before anything runs. They are
 * registries this port's own cases read, not contract surface.
 * `DEFAULT_CHILD_PROGRAM` is `_DEFAULT_CHILD_PROGRAM` in the source -- private
 * there, exported here only because a ported case reaches it -- and
 * `CREATE_WORKSPACE` is a source public that no source case ever imports.
 *
 * From `./uuid5.ts` only {@link claudeSessionUuid} is here. The rest of that
 * module -- `uuid5`, `parsePythonUuid`, `NAMESPACE_URL`,
 * `SESSION_UUID_NAMESPACE_NAME`, `SESSION_UUID_NAMESPACE` -- is a transcription
 * of CPython's `uuid`, which is the standard library in interlock and therefore
 * not part of its package surface either. It is absent for the reason
 * `src/index.ts` gives for `fnmatch`, `shlex` and `pyrepr`.
 *
 * ## The eager load, reproduced on purpose
 *
 * The source's `__init__.py` imports `claude_cli_provider` first, so anything
 * that touches `claude_org_runtime.session` -- including
 * `...session.provider` -- pays for S2 whether it wanted S2 or not. This barrel
 * reproduces that ordering, and the cost is the same: three module
 * evaluations, no I/O, no spawn, and one SHA-1 at load, for
 * `SESSION_UUID_NAMESPACE`, which is where `uuid.uuid5(...)` runs at import in
 * the source too.
 *
 * It was worth reproducing rather than splitting into a lazy or a
 * contract-only entry, and the reason is that ESM makes the port's version
 * strictly cheaper than the source's: `import ... from "./provider.js"` does
 * NOT evaluate this file, whereas `import claude_org_runtime.session.provider`
 * unavoidably executes `__init__.py`. Only a consumer that asked for the
 * subsystem pays here, which is the population the eager import was already
 * correct for. Splitting S2 out would buy nothing measurable and would leave
 * the package's session surface narrower than `__all__` -- the one thing this
 * barrel exists not to do.
 */

export {
  CLI_VERSION_WRITTEN_AGAINST,
  ClaudeCliSessionProvider,
  type ClaudeCliSessionProviderOptions,
} from "./claude_cli_provider.js";
export { createDefaultSessionProvider } from "./default_provider.js";
export {
  CAPABILITY_ASSIGNMENTS,
  CapabilityAssignment,
  type CapabilityAssignmentFields,
  CapabilityReport,
  type CapabilityReportFields,
  ContractViolation,
  checkSpawnPrecondition,
  D0009_VERBS,
  DELIVERY_ABSENCE_IS_DELIBERATE,
  Failure,
  FailureKind,
  Observation,
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
  StartRequest,
  type StartRequestFields,
  VERB_IMPLEMENTATION_HOOKS,
  WorkspaceDecision,
  type WorkspaceLifecycleObserver,
  WorkspaceTransition,
  type WorkspaceTransitionFields,
  WorkspaceVerdict,
} from "./provider.js";
export {
  ANNOUNCE_AFTER_ENV,
  DEFAULT_CHILD_STATE,
  LocalProcessSessionProvider,
  type LocalProcessSessionProviderOptions,
  STATE_FILE_ENV,
} from "./stub_provider.js";
export { claudeSessionUuid } from "./uuid5.js";
