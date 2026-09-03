import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";

import type { LapRunIntent } from "../control_plane/lap_run_intent.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { type IngestedReport, ingestTerminalReport } from "../control_plane/report_ingress.js";
import { readLapRunIntent } from "../control_plane/run_admission.js";
import type { SpawnOutcome } from "../fencing/spawn.js";
import {
  Failure,
  type Ok,
  type ProviderResult,
  type SessionProvider,
  WorkspaceDecision,
  type WorkspaceLifecycleObserver,
  type WorkspaceTransition,
  WorkspaceVerdict,
} from "../session/provider.js";
import { type OrchestrationOutcome, SessionOrchestrator } from "../supervisor.js";
import {
  type EndpointBinding,
  type FenceSubstitutions,
  type MaterializedWorkspace,
  materializeWorkspace,
} from "../workspace/materializer.js";

/**
 * Step 8 of `docs/design/minimal-operating-loop.md`: the composition root.
 *
 * Section 4.5 states the gap this closes in one sentence -- "a lap can be
 * performed today only by hand-writing a TypeScript program" -- and names the
 * two halves of why: nothing in `src/` produces a `SessionOrchestratorOptions`,
 * and `FencedSpawner` is wired to nothing, so a lap that spawned would spawn
 * through the provider directly and the human gate would be advisory. Step 7
 * built the first half (`D-0057`, `D-0058`). This is the second: **the order
 * that carries an admitted run from its record to an open gate**, and the
 * single place the fence and the spawn meet.
 *
 * ## What lives here, and what deliberately does not
 *
 * Everything below already exists. `readLapRunIntent` reads what admission
 * fixed, `materializeWorkspace` builds the workspace and admits the fence,
 * `SessionOrchestrator` runs the lease-before-spawn walk, and
 * `ingestTerminalReport` turns the finished turn into an event and a gate. What
 * was missing is the sequence, and the sequence is all this module is.
 *
 * It is **provider-agnostic on purpose** (`D-0059`). It imports
 * `../session/provider.js` -- the contract -- and never a backend, so
 * `test/gate_item11/no-provider-detail-leaks.test.ts` passes over it unchanged
 * and the number that test grades is not moved by this step. The concrete
 * provider is chosen by the verb in `cli.ts` and handed in;
 * `docs/design/composition-root-placement.md` is the working behind that.
 *
 * ## The one thing that could not be reached by an interface
 *
 * `readTerminalReport` is on `ClaudeCliSessionProvider` and not on
 * `SessionProvider` (`D-0056`), and even its readout *type* is declared in the
 * provider's own module -- so `import type { TerminalReportReadout }` would be
 * a leak. {@link TerminalReportReader} and the two shapes above it are declared
 * here instead, structurally, exactly as `report_ingress.ts` declares
 * `TerminalReportFact` and for the same stated reason. Nothing about how a
 * transcript is read appears here, which is what `D-0056` decision 4 was
 * protecting.
 *
 * ## The order, and the two places it must not be rearranged
 *
 * 1. Read the intent. 2. Materialise. 3. Register the veto. 4. Spawn **through
 * the spawner materialisation handed back**. 5. Poll. 6. Ingest.
 *
 * - **Step 4 uses `materialized.spawner`, and constructing a second
 *   `FencedSpawner` here would be refused rather than merely redundant.**
 *   `D-0217` makes the provenance check per-instance: `execute` consults the
 *   spawner's own record of the plan it admitted, so a second instance -- however
 *   correctly configured -- cannot start the child. That is the design working,
 *   not an obstacle to route around.
 * - **Step 6 runs outside every transaction.** `transaction()` in
 *   `control_plane/txn.ts` joins rather than nests and refuses an async body, so
 *   the transcript read is awaited here and its settled value is passed in.
 *   `ingestTerminalReport` opens the one transaction the event and its gate
 *   share.
 */

// --------------------------------------------------------------------------
// the provider surface this step needs and the contract does not carry
// --------------------------------------------------------------------------

/**
 * One finished turn's report, structurally as the provider hands it over.
 *
 * `ClaudeCliSessionProvider`'s `TerminalReport`, re-declared for the reason the
 * module docstring gives. It is deliberately the same shape as
 * `report_ingress.ts`'s `TerminalReportFact` plus the discriminant, so the value
 * is passed straight through rather than rebuilt field by field -- a
 * re-assembly here would be a third statement of one shape and the place a
 * field would eventually be dropped.
 */
export interface LapTerminalReport {
  readonly kind: "report";
  readonly sessionId: string;
  readonly generation: number;
  readonly report: string;
  readonly terminalReason: string | null;
  readonly subtype: string | null;
  readonly isError: boolean;
  readonly returncode: number | null;
}

/** A turn with no report to read yet, or none it will ever have. */
export interface LapNoTerminalReport {
  readonly kind: "no-report";
  /** `true` only while a report could still arrive. See {@link awaitTerminalReport}. */
  readonly pending: boolean;
  readonly reason: string;
}

/** What {@link TerminalReportReader.readTerminalReport} answers with. */
export type LapTerminalReadout = LapTerminalReport | LapNoTerminalReport;

/**
 * The half of the session backend this step needs and `SessionProvider` does
 * not declare.
 *
 * A separate parameter from the provider rather than an intersection type,
 * because the two are separate questions: the orchestrator's walk is defined
 * over the contract and would run against any backend, while reading a
 * transcript is a capability only some backends have. Keeping them apart is
 * what lets a caller supply one object that happens to be both -- which the
 * shipped default is -- without the order below claiming that they must be.
 */
export interface TerminalReportReader {
  readTerminalReport(sessionId: string): Promise<ProviderResult<LapTerminalReadout>>;
}

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/**
 * The lap could not be carried to an open gate, and nothing further was
 * attempted.
 *
 * In the {@link ControlPlaneRefusal} family for the reason `run_cli.ts` gives
 * about its own: every state below is the ordinary outcome of a command an
 * operator typed -- the run was not admitted, the turn said nothing, the child
 * outlived its budget -- rather than a defect, and each becomes one stderr line
 * and exit 2 instead of a stack trace with the message buried above it.
 */
export class LapRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LapRefused";
    // The family's convention, and it is load-bearing rather than decorative:
    // extending a built-in under a downlevel emit target loses the prototype
    // chain and `instanceof` then silently reports false. See `refusals.ts`.
    Object.setPrototypeOf(this, LapRefused.prototype);
  }
}

/** A malformed argument to {@link performLap}. A defect in a caller. */
export class LapUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LapUsageError";
    Object.setPrototypeOf(this, LapUsageError.prototype);
  }
}

// --------------------------------------------------------------------------
// decision 5: the veto (D-0062)
// --------------------------------------------------------------------------

/**
 * The provider's own word for the transition it makes when a start is asked for
 * a workspace that does not exist.
 *
 * Spelled out rather than imported. `stub_provider.ts` exports it and
 * `claude_cli_provider.ts` keeps a private copy of the same string, and
 * importing either would make this module know a backend -- the one thing
 * `D-0059`'s placement is built to avoid. The duplication is three words of a
 * provider-neutral vocabulary (`WorkspaceTransition.kind` is documented as
 * carried uninterpreted), and the case that pins it is
 * `vetoes the provider's bare-mkdir create-workspace transition`.
 */
export const CREATE_WORKSPACE_TRANSITION = "create-workspace";

/**
 * The acting half of `M2`: a workspace this lap did not materialise is not one
 * its worker may run in.
 *
 * `ClaudeCliSessionProvider` creates a missing workspace with a bare
 * `mkdirSync(workspace, { recursive: true })` and announces a
 * `create-workspace` transition first -- deliberately, so that a party who
 * knows better can stop it. Step 7 built the evidence half and said so: a
 * {@link MaterializedWorkspace} cannot be constructed except by
 * `materializeWorkspace`, which does not return until git has made the
 * checkout. This is the other half.
 *
 * **It vetoes every `create-workspace`, not merely one for an unexpected
 * path**, and that is the stronger and the correct rule. By the time the
 * orchestrator starts, the worktree exists: git made it and the materialiser
 * re-asked git about it immediately before appending its event. So a provider
 * announcing that it is about to *create* this workspace is not reporting a
 * mismatch of paths -- it is reporting that the checkout is **gone**, swept
 * between materialisation and spawn. Allowing it because the path matched would
 * put the worker in a bare directory with the right name, which is precisely
 * the outcome the fence, the branch and the base commit were all established to
 * prevent, and the run would look normal from every record.
 *
 * Other transition kinds are allowed: this observer has one thing to say and
 * says only that. An observer that vetoed what it had no opinion about would be
 * an outage wearing a safety check's name.
 */
export class MaterializedWorkspaceRequired implements WorkspaceLifecycleObserver {
  readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  onWorkspaceTransition(transition: WorkspaceTransition): WorkspaceDecision {
    if (transition.kind !== CREATE_WORKSPACE_TRANSITION) {
      return new WorkspaceDecision(WorkspaceVerdict.ALLOW);
    }
    return new WorkspaceDecision(
      WorkspaceVerdict.VETO,
      `${transition.workspace} would be created by the provider, but this lap's ` +
        `workspace ${this.workspace} was materialised by git before the spawn; a ` +
        "create-workspace here means the checkout is gone, and a bare directory " +
        "with the right name is not the worktree the fence, the branch and the " +
        "base commit were established against",
    );
  }
}

// --------------------------------------------------------------------------
// decision 4: the artifact layout (D-0061)
// --------------------------------------------------------------------------

/**
 * Path characters that need no encoding in a directory name on either platform.
 *
 * **Uppercase is deliberately not in it.** An NTFS volume resolves `run` and
 * `RUN` to one directory, so two admitted runs whose identifiers differ only by
 * case would share an artifact directory -- and would then race through the
 * materialiser's check-before-write guard on the fence, the settings and the
 * ledger. `D-0216` records the same hazard for the containment guard and
 * answers it the same way: the platform's identity rule, not the string's.
 * Lowercase identifiers -- which is every one this repository writes -- are
 * unaffected and stay readable.
 */
const ARTIFACT_SEGMENT_SAFE = /^[a-z0-9._-]$/;

/**
 * The DOS device names Windows still reserves, in every directory, with or
 * without an extension.
 *
 * A run called `nul` is a perfectly good identifier and cannot be a directory:
 * the create fails with a message about the path rather than about the run, and
 * it fails on Windows only. Lowercase only, because {@link ARTIFACT_SEGMENT_SAFE}
 * has already encoded every uppercase letter, and the comparison is made against
 * the stem before the first dot, because that is the part Windows reserves.
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** `%XX`, the one escape this encoding has. */
function percentEncode(character: string): string {
  return `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * The directory this lap's fence, settings, MCP configuration and fence ledger
 * are published into: `<artifactRoot>/<encoded runId>`.
 *
 * **One directory per run, under a root the operator names.** The materialiser
 * refuses to guess this and says why: the artifacts must be outside the
 * worktree, because inside it they would be tracked files the worker can commit,
 * `git status` noise on every run, and -- worst -- a fence the fenced child can
 * edit. It cannot derive a root itself without inventing a convention about the
 * operator's filesystem, so the root is a required flag and the *layout* under
 * it is this step's.
 *
 * **The run identifier is encoded rather than trusted**, against the
 * *filesystem's* identity rules and not the string's. `LapRunIntent` holds it to
 * printable ASCII, which is a much wider set than a directory name may safely
 * be, and three separate things go wrong if it is used as written:
 *
 * - `/`, `\` and `:` turn "a directory named after the run" into a directory
 *   somewhere else, and `..` into one above the root;
 * - Windows resolves `run` and `RUN` to one directory and drops a trailing dot,
 *   so two admitted runs would share a fence, a settings file and a ledger, and
 *   would race through the materialiser's check-before-write guard;
 * - Windows reserves `con`, `nul`, `com1` and their kin in every directory, so a
 *   run legitimately called `nul` could not be materialised at all -- on one
 *   platform, with a message about a path rather than about a run.
 *
 * So every character outside `[a-z0-9._-]` becomes `%XX`, a trailing dot is
 * encoded, and a reserved device name has its first character escaped. The
 * result is reversible, identical on every platform, and collision-free even
 * under case folding -- the escape character is itself escaped, so two distinct
 * identifiers cannot encode to one name.
 *
 * Not a hash: an operator looking for a run's fence has the run id and should be
 * able to find the directory by reading it.
 */
export function lapArtifactDir(artifactRoot: string, runId: string): string {
  let encoded = "";
  for (const character of runId) {
    encoded += ARTIFACT_SEGMENT_SAFE.test(character) ? character : percentEncode(character);
  }
  // A trailing dot is silently dropped by Windows, so `run.` and `run` would be
  // one directory; encoding it also settles `.` and `..`, which are legal
  // identifiers and are not legal directory names.
  if (encoded.endsWith(".")) {
    encoded = `${encoded.slice(0, -1)}%2E`;
  }
  const stem = encoded.split(".")[0] ?? "";
  if (RESERVED_DEVICE_NAMES.has(stem)) {
    // The first character, so the rest of the name still reads: `nul` becomes
    // `%6Eul`. Escaping is enough -- a reserved name is reserved exactly, and
    // `%6Eul` is not one of them.
    encoded = `${percentEncode(encoded.slice(0, 1))}${encoded.slice(1)}`;
  }
  // `join` rather than string concatenation: the encoded name carries no
  // separator of either platform's, so there is nothing here for `join` to
  // collapse, and the root is spelled the way the operator gave it.
  return join(artifactRoot, encoded);
}

// --------------------------------------------------------------------------
// decision 2: when the turn is over (D-0060)
// --------------------------------------------------------------------------

/** How long the composition root waits for the turn to end, and how often it asks. */
export interface TurnCompletion {
  /** Milliseconds between transcript reads. */
  readonly pollIntervalMs: number;
  /** Milliseconds from the first read until the lap gives up. */
  readonly timeoutMs: number;
  /** The wait, injectable so a case does not spend wall-clock. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the transcript until the turn is over, and answer with what it said.
 *
 * **"The turn is over" means the terminal `result` line has been written, not
 * that the child has exited** (`D-0060`). `D-0056` returns the report as soon as
 * that line appears and records the second-`result`-line hazard as an open
 * limitation "belonging with the composition root in step 8, which is the
 * component that will actually poll". This is that component, and this is the
 * answer: the **first** report a turn produces is the turn's report, polling
 * stops there, and a second `result` line written afterwards is not read.
 *
 * Waiting for the exit instead was considered and is worse in the direction that
 * matters. A `claude -p` child's exit is not the turn's end: it can outlive the
 * terminal line by however long its MCP servers take to shut down, and it can
 * fail to arrive at all -- a wedged child would hold the lap open with a
 * complete report already on disk, and the gate would never be asked. Stopping
 * at the report makes the lap's duration a property of the worker's work rather
 * than of its teardown.
 *
 * The cost is stated rather than hidden: a turn that somehow wrote two terminal
 * lines would have its first read and its second ignored. That is the safe
 * direction -- a report is escalated once, to one gate, and `D-0056`'s dedup key
 * is per turn -- and the fix, if the second line ever proves to be real content
 * rather than a restatement, is a second generation and a second ingest, not a
 * longer wait here.
 *
 * @throws {LapRefused} when the turn ended with nothing to report, when the
 *   provider refuses the read, or when the budget runs out.
 */
export async function awaitTerminalReport(
  reader: TerminalReportReader,
  sessionId: string,
  completion: TurnCompletion,
  nowMs: () => number,
): Promise<LapTerminalReport> {
  const { pollIntervalMs, timeoutMs } = completion;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new LapUsageError(
      `poll_interval_ms must be a non-negative integer of milliseconds, got ${String(pollIntervalMs)}`,
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new LapUsageError(
      `timeout_ms must be a non-negative integer of milliseconds, got ${String(timeoutMs)}`,
    );
  }
  const sleep = completion.sleep ?? DEFAULT_SLEEP;
  // Read once from the clock the caller gave, before the first read rather than
  // after it: a budget that started counting from the first answer would give a
  // provider that blocks for the whole timeout an unbounded second chance.
  const deadline = nowMs() + timeoutMs;

  for (;;) {
    // A read is started only while there is budget left. What the budget bounds
    // is the WAITING; a report that exists when a read returns is the turn's
    // outcome and is never discarded, however long that read took. Throwing away
    // a report in hand would leave the worker's own words unescalated and the
    // gate unopened for a turn that did finish -- which is the failure this
    // whole step exists to remove, arriving by way of a stopwatch.
    const result = await reader.readTerminalReport(sessionId);
    if (Failure.is(result)) {
      // Not retried. A refusal here is the provider saying it cannot read this
      // session at all -- an unknown session, an identity incident, an
      // uninterpretable transcript -- and none of those become true by waiting.
      throw new LapRefused(
        `the terminal report for session ${sessionId} could not be read: ` +
          `${result.kind.value}: ${result.detail}`,
      );
    }
    const readout = (result as Ok<LapTerminalReadout>).value;
    if (readout.kind === "report") {
      return readout;
    }
    if (!readout.pending) {
      // The turn ended and said nothing usable. Polling will not change it, and
      // `pending` is a field rather than a sentence precisely so this decision
      // is not made by reading a diagnostic message.
      throw new LapRefused(
        `session ${sessionId} finished its turn without a report to escalate: ${readout.reason}`,
      );
    }
    if (nowMs() >= deadline) {
      throw new LapRefused(
        `session ${sessionId} did not finish its turn within ${timeoutMs}ms; the last ` +
          `answer was ${readout.reason}. The workspace and the fence are left exactly ` +
          "as they are -- the refusal is about the turn, and deleting a checkout the " +
          "worker may have written into is not a rollback -- and the session is stopped " +
          "on the way out",
      );
    }
    // Capped at what is left of the budget, not the bare interval. An interval
    // longer than the remaining time would sleep past the deadline and then
    // accept whatever the next read returned -- so a one-second timeout with a
    // two-second interval would accept a report that arrived at two seconds,
    // and `--turn-timeout-ms` would not be a bound at all. Waking at the
    // deadline makes the last read the one the deadline check sees.
    await sleep(Math.max(0, Math.min(pollIntervalMs, deadline - nowMs())));
  }
}

// --------------------------------------------------------------------------
// the lap
// --------------------------------------------------------------------------

/** Everything the lap needs that the admitted intent does not already fix. */
export interface LapRequest {
  /** The admitted run. Its intent is read back rather than restated here. */
  readonly runId: string;
  /** A path inside the repository the worktree is cut from. */
  readonly repository: string;
  /** The root {@link lapArtifactDir} places this run's artifact directory under. */
  readonly artifactRoot: string;
  /** The worker's endpoint binding, less the holder the intent already fixes. */
  readonly endpoint: Omit<EndpointBinding, "holder">;
  readonly fence: FenceSubstitutions;
  /** The caller's clock. Read at each step that stamps one. */
  readonly nowMs: () => number;
  readonly sessionUuidFactory: () => string;
  readonly completion: TurnCompletion;
  /** Per-git-command wall-clock bound, passed through to the materialiser. */
  readonly gitTimeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The actor recorded on the escalation event. Defaults to `lap_composition_root`. */
  readonly actorId?: string;
  /** The gate's answer vocabulary, passed to `ingestTerminalReport`. */
  readonly gateOptions?: readonly string[];
  /** The gate's deadline, epoch milliseconds. `null` for none. */
  readonly deadlineAtMs?: number | null;
}

/** The default `actor_id` on the escalation event this step ingests. */
export const LAP_ACTOR_ID = "lap_composition_root";

/** What one lap did, in the order it did it. */
export interface LapOutcome {
  /** What admission fixed, as it was read back off the spine. */
  readonly intent: LapRunIntent;
  /** Step 7's result, including the admitted plan and the spawner that issued it. */
  readonly materialized: MaterializedWorkspace;
  /** The orchestrator's walk. */
  readonly orchestration: OrchestrationOutcome;
  /** `execute`'s answer: the same fence and battery report, one spawn spent. */
  readonly spawn: SpawnOutcome;
  /** The turn's own words. */
  readonly report: LapTerminalReport;
  /** The escalation event and the gate now standing over it. */
  readonly ingested: IngestedReport;
}

/**
 * Carry one admitted run from its record to an open gate.
 *
 * `connection` must be a production control plane at this build's head, opened
 * by the caller: this function neither opens nor closes it, for the reason
 * `run_cli.ts` gives -- the verb owns the handle it made.
 *
 * @throws {LapRefused} for a state an operator acts on.
 * @throws {WorkspaceMaterializationRefused} / {@link import("../workspace/git.js").GitRefusal}
 *   from the materialiser, unwrapped. Flattening them would lose the distinction
 *   between "git said no" and "git never answered", which is the one an operator
 *   acts on differently.
 */
export async function performLap(
  connection: SqliteDatabase,
  provider: SessionProvider,
  reader: TerminalReportReader,
  request: LapRequest,
): Promise<LapOutcome> {
  if (typeof request.runId !== "string" || request.runId === "") {
    throw new LapUsageError("run_id must be a non-empty string");
  }
  if (typeof request.nowMs !== "function" || typeof request.sessionUuidFactory !== "function") {
    throw new LapUsageError("now_ms and session_uuid_factory must be functions");
  }

  // 1. What this run was admitted to do. Read rather than retyped: the whole
  //    point of D-0055 is that the execution intent is fixed once, at admission,
  //    and every later step acts on that record.
  const intent = readLapRunIntent(connection, request.runId);

  // 2. The workspace, the fence, and the admitted plan. One call, and the
  //    `SessionOrchestratorOptions` it returns is complete -- nothing below adds
  //    a field to it, which is what makes step 7 the producer section 4.5 says
  //    was missing rather than a helper this step finishes.
  const materialized = materializeWorkspace(connection, {
    runId: intent.runId,
    holder: intent.leaseClaimantId,
    role: intent.role,
    repository: request.repository,
    baseBranch: intent.baseBranch,
    topicBranch: intent.topicBranch,
    workspace: intent.workspace,
    artifactDir: lapArtifactDir(request.artifactRoot, intent.runId),
    prompt: intent.prompt,
    cliArgs: intent.cliArgs,
    nowMs: request.nowMs(),
    sessionUuidFactory: request.sessionUuidFactory,
    endpoint: { ...request.endpoint, holder: intent.leaseClaimantId },
    fence: request.fence,
    ...(request.gitTimeoutMs === undefined ? {} : { gitTimeoutMs: request.gitTimeoutMs }),
    ...(request.env === undefined ? {} : { env: request.env }),
  });

  // 3. The veto, registered before anything can spawn. After materialisation
  //    because it is keyed on what materialisation produced, and before the
  //    orchestrator because `#createWorkspace` asks the observers *before* it
  //    makes the directory -- a veto arriving later would arrive after the
  //    bare directory existed.
  provider.registerWorkspaceObserver(new MaterializedWorkspaceRequired(materialized.workspace));

  // 4. The spawn, through the spawner that admitted the plan and no other.
  //    `execute` consumes the plan before calling the callable, so this is one
  //    admission and one child even if the walk below throws.
  const orchestrator = new SessionOrchestrator(connection, provider, materialized.options);
  let walk: Promise<OrchestrationOutcome> | undefined;
  const spawn = materialized.spawner.execute(materialized.admission, () => {
    walk = orchestrator.start();
    return walk;
  });
  if (walk === undefined) {
    // Unreachable: `execute` either throws before calling the callable or calls
    // it exactly once. Checked rather than asserted, because the alternative is
    // awaiting `undefined` and reporting a lap that never spawned as one that
    // completed.
    throw new LapRefused("internal: the fenced spawn returned without starting the walk");
  }
  const orchestration = await walk;

  try {
    // 5. The turn. Awaited out here, outside every transaction, because
    //    `transaction()` joins rather than nests and refuses an async body.
    const report = await awaitTerminalReport(
      reader,
      orchestration.sessionId,
      request.completion,
      request.nowMs,
    );

    // 6. The settled value, into the one transaction the event and its gate share.
    const ingested = ingestTerminalReport(connection, {
      runId: intent.runId,
      report: {
        sessionId: report.sessionId,
        generation: report.generation,
        report: report.report,
        terminalReason: report.terminalReason,
        subtype: report.subtype,
        isError: report.isError,
        returncode: report.returncode,
      },
      nowMs: request.nowMs(),
      actorId: request.actorId ?? LAP_ACTOR_ID,
      ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }),
      ...(request.gateOptions === undefined ? {} : { gateOptions: request.gateOptions }),
    });

    return Object.freeze({
      intent,
      materialized,
      orchestration,
      spawn,
      report,
      ingested,
    });
  } finally {
    // 7. The session's life is the lap's, and it ends here on every path.
    //
    //    **On the refusal paths this is not tidiness, it is what makes the
    //    refusal reach anyone.** The provider holds a referenced Node child
    //    handle, so a running child keeps its process's event loop alive: a
    //    `--turn-timeout-ms` that printed a refusal and then hung until the
    //    child felt like exiting would be a bound in the help text and nowhere
    //    else. And a lap that has given up must not leave a fenced worker
    //    running with nobody polling it.
    //
    //    It is safe here because it is after everything durable. The escalation
    //    event and its gate have committed by the time the successful path
    //    reaches this, and on a refusal there is nothing to commit -- so a stop
    //    that goes badly cannot un-open a gate or lose a report.
    await stopSession(provider, orchestration.sessionId);
  }
}

/**
 * Stop the session, and never let the stop become the lap's outcome.
 *
 * `stop` is the provider's supervised ladder -- terminate, wait, escalate --
 * and not a signal, so a child that is already finishing is simply reaped. Its
 * answer is deliberately unread and its failures are swallowed: this runs in a
 * `finally`, and an exception thrown from there would REPLACE whatever the lap
 * was returning or throwing. A teardown that reported itself instead of the
 * gate that was just opened is the one way this call could do real harm.
 */
async function stopSession(provider: SessionProvider, sessionId: string): Promise<void> {
  try {
    await provider.stop(sessionId);
  } catch {
    // Deliberately empty. See above.
  }
}
