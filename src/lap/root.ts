import { accessSync, constants, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { isFullyQualified, type LapRunIntent } from "../control_plane/lap_run_intent.js";
import { readLease } from "../control_plane/lease.js";
import { pythonRepr } from "../control_plane/python_repr.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { type IngestedReport, ingestTerminalReport } from "../control_plane/report_ingress.js";
import { readLapRunIntent } from "../control_plane/run_admission.js";
import { activeBinding } from "../control_plane/session_binding.js";
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
import {
  LoserTerminated,
  type OrchestrationOutcome,
  SessionOrchestrator,
  type SessionOrchestratorOptions,
} from "../supervisor.js";
import {
  type EndpointBinding,
  type FenceSubstitutions,
  isInside,
  type MaterializedWorkspace,
  materializeWorkspace,
} from "../workspace/materializer.js";
import {
  type DeliveryLeaseTimers,
  type HeldDeliveryLease,
  holdDeliveryLease,
} from "./endpoint_lease.js";

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
 * The longest single directory name a filesystem will accept.
 *
 * 255 on ext4, APFS and NTFS alike. The first two count bytes and the third
 * counts UTF-16 units; the encoded name is ASCII, so all three agree here.
 */
const MAX_ARTIFACT_SEGMENT = 255;

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
  // **The encoding can triple the length, and a filename cannot.**
  //
  // Every common filesystem caps a single name at 255 (ext4 and APFS count
  // bytes, NTFS counts UTF-16 units; the encoded name is ASCII, so the two agree
  // here). `LapRunIntent` puts no length rule on a run identifier, and `%XX`
  // makes the worst case three characters out of one -- so an 86-character run
  // of unsafe characters encodes to 258 and the directory simply cannot be
  // created. Left to the filesystem, that arrives as an `ENAMETOOLONG` from
  // inside materialisation, *after* the branch and the worktree exist, and
  // `D-0057` refuses a second materialisation -- so the run identifier is spent
  // and the operator's only recovery is a new one. Refused here it costs
  // nothing, and the message says the number that actually matters, which is
  // the encoded length rather than the one the operator can see.
  if (encoded.length > MAX_ARTIFACT_SEGMENT) {
    throw new LapUsageError(
      `run_id ${JSON.stringify(runId)} encodes to a directory name of ` +
        `${String(encoded.length)} characters, over the ${String(MAX_ARTIFACT_SEGMENT)} a ` +
        "filesystem accepts. Escaping a character costs three, so a run identifier can " +
        "exceed this well before it looks long; a shorter identifier is the fix",
    );
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
  /**
   * The **monotonic** reading the budget is measured against, in milliseconds.
   *
   * Defaults to `performance.now()`. Deliberately not the lap's `nowMs`, which
   * is a wall clock and is the right thing for *stamping* -- an event's
   * `occurred_at_ms` has to be comparable with every other row's. A wall clock
   * is the wrong thing for measuring an interval: NTP can step it, and a laptop
   * that suspends and resumes moves it by however long the lid was shut. Either
   * would make `--turn-timeout-ms` expire early or late by an amount that has
   * nothing to do with how long the worker worked.
   *
   * Injectable for the same reason `sleep` is: a case that asserts on a budget
   * needs a clock it controls, and one that ticks only when the injected wait
   * says so is the only way to observe an overshoot deterministically.
   */
  readonly elapsedMs?: () => number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The default monotonic reading. See {@link TurnCompletion.elapsedMs}. */
const DEFAULT_ELAPSED_MS = (): number => performance.now();

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
 * **What the budget bounds: the waiting, not the reading.** A report that exists
 * when a read returns is the turn's outcome and is never discarded, however long
 * that read took -- throwing away a report in hand would leave the worker's own
 * words unescalated and the gate unopened for a turn that did finish, which is
 * the failure this whole step exists to remove, arriving by way of a stopwatch.
 * Each wait is therefore capped at the remaining budget, and exactly one read may
 * begin at the deadline instant: it is the read that observes what the last wait
 * was waiting for, and refusing without it would discard a report that arrived
 * during that wait. A reader that blocks indefinitely is outside this bound and
 * cannot be brought inside it without abandoning a read in flight.
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
/**
 * **Everything this lap can refuse, refused before anything irreversible.**
 *
 * A list rather than a run of `if`s, and the list is the point. `D-0057` refuses
 * a second materialisation of one run, so anything rejected *after* the branch
 * and the worktree exist costs the run identifier itself -- the operator's
 * recovery is a new run, not a corrected retry. Every entry below is a check
 * that was, at some point, made too late:
 *
 * - the **completion budget** was validated inside the poll, which is the last
 *   step of the lap;
 * - the **gate deadline** was handed to the ingest and refused by a DDL
 *   constraint after the worker had finished (`D-0065`);
 * - the **provider's spawnability** was asked by `orchestrator.start()`, so
 *   `claude` not being on `PATH` burned a run;
 * - the **artifact directory's length** was left to the filesystem;
 * - the **provider's state root** is where the worker's transcript is written,
 *   and a transcript inside the worktree is a gate opened over words its own
 *   subject wrote (`D-0067`).
 *
 * They were each fixed as they were found, which is how five separate late
 * refusals came to exist: the discipline was stated and then applied one
 * instance at a time. Enumerating them here is the repair for *that* -- a check
 * added later has a place to go, and a flag added without one shows up as a
 * missing entry rather than as a hole.
 *
 * `materializeWorkspace` keeps the same rule for its own request and says so;
 * this is `performLap` keeping it for the arguments the materialiser never sees.
 */
function preflight(request: LapRequest, provider: SessionProvider, workspace: string): void {
  requireCompletion(request.completion);
  requireGateDeadline(request);
  // The artifact directory's name, which the encoding can push past a
  // filesystem's limit. Computed and discarded: what is wanted is the refusal.
  lapArtifactDir(request.artifactRoot, request.runId);
  // **Containment before the provider is asked anything, and the order is not
  // cosmetic.** `requireSpawnable` runs the capability probe, and the probe
  // writes `probe-evidence.txt` into the provider's state root -- so asking it
  // first would CREATE the very directory the next check exists to refuse, and
  // create it inside the worktree. The refusal would still fire, and it would
  // fire over a directory this preflight had just made. A check that has to be
  // run before its neighbour has a side effect is worth saying out loud.
  requireOutsideWorkspace(request, workspace);
  // The state root has to be a directory this process can write, and the
  // capability probe will not tell us. See {@link requireUsableStateRoot}.
  // After containment, because it creates the directory it is checking.
  requireUsableStateRoot(request.providerStateRoot);
  // The spawn precondition, asked here rather than left to the walk. It is on
  // the contract (`SessionProvider.requireSpawnable`), so this stays
  // provider-agnostic; it raises `SpawnRefused`, which the verb reports as one
  // line and exit 2.
  provider.requireSpawnable();
}

/** The gate deadline's rules. See {@link LapRequest.deadlineAtMs} and `D-0065`. */
function requireGateDeadline(request: LapRequest): void {
  const deadlineAtMs = request.deadlineAtMs;
  if (deadlineAtMs === undefined || deadlineAtMs === null) {
    return;
  }
  if (!Number.isInteger(deadlineAtMs)) {
    throw new LapUsageError(
      `deadline_at_ms must be an int of epoch milliseconds, got ${String(deadlineAtMs)}`,
    );
  }
  if (deadlineAtMs <= request.nowMs()) {
    // Refused up front rather than dropped silently at the ingest below. A
    // deadline already in the past when the lap STARTS is a typo -- a mistyped
    // digit, a stale value pasted from an earlier command -- and the operator
    // wants to hear about it now, while a corrected retry is still free. A
    // deadline that expires *while the worker runs* is a different thing
    // entirely and is handled at the ingest (`D-0065`).
    throw new LapUsageError(
      `deadline_at_ms ${String(deadlineAtMs)} is already in the past; a gate cannot be ` +
        "opened with a deadline it has already missed, and a deadline that was stale " +
        "before the worker started is a mistyped argument rather than a lap that ran long",
    );
  }
}

/**
 * The paths this lap supplies that the fenced worker must not be able to edit
 * (`D-0067`).
 *
 * **These two only.** Every other path the verb takes is a field of
 * `MaterializationRequest`, and containment for those belongs to
 * `materializeWorkspace`, which owns the invariant and has the workspace in
 * hand. What is here is what that module never sees:
 *
 * - the **provider's state root** holds `record.json` and the turn's transcript,
 *   and that transcript is the evidence `readTerminalReport` turns into a gate.
 *   Inside the worktree, a worker can append its own terminal line and open a
 *   gate over words it chose -- a human approval whose subject wrote the
 *   document. It is not a materialiser field at all: it exists only because this
 *   step constructs a provider.
 * - the **worker's own command** is the binary the fence is applied to.
 *
 * **Each is resolved the way its own consumer resolves it**, which is the whole
 * difficulty. `ClaudeCliSessionProvider` resolves the state root at
 * construction, against *this* process's working directory. The command is
 * spawned with the **workspace** as its working directory, so a relative token
 * resolves there -- a `--claude-command ./tool` that looks safe from the
 * operator's shell is `<workspace>/tool` when it runs. Resolving both the same
 * way would leave one of them checked against a directory it will never be read
 * from.
 *
 * The comparison is `materializeWorkspace`'s own `isInside`, imported rather
 * than rewritten: it case-folds on Windows (`D-0216`), and a second predicate
 * for one rule is how the two drift.
 */
function requireOutsideWorkspace(request: LapRequest, workspace: string): void {
  // **The root is resolved here, and forgetting to was a live hole rather than
  // a tidiness lapse.** `isInside` is lexical by design, and `materializeWorkspace`
  // normalises its own workspace before asking it -- but the value arriving here
  // is `intent.workspace` as an operator typed it at admission, and
  // `LapRunIntent` says in as many words that being *resolvable* is all it
  // checks and that normalisation "belong[s] to the task that materialises it".
  // So a workspace admitted as `/repo/wt/../wt` made this guard compare
  // `/repo/wt/tool` against a root it does not textually prefix, answer "not
  // inside", and pass a worker command the checkout would then contain. One
  // rule, one predicate, and now one spelling of its argument.
  const root = resolve(workspace);
  // **Every token of the worker command must be an absolute path**, which is
  // the rule that removes execution resolution from this lap entirely. See
  // {@link requireAbsoluteWorkerCommand}.
  requireAbsoluteWorkerCommand(request.workerCommand);

  const warded: readonly (readonly [string, string])[] = [
    // Resolved against this process: the provider does the same at construction.
    ["the provider's state root", resolve(request.providerStateRoot)],
    // Already absolute by the rule above, so `resolve` only normalises.
    ...(request.workerCommand ?? []).map(
      (token, index) => [`the worker command's token ${String(index)}`, resolve(token)] as const,
    ),
  ];
  for (const [what, path] of warded) {
    if (isInside(path, root)) {
      throw new LapUsageError(
        `${what} is ${pythonRepr(path)}, inside the workspace ${pythonRepr(root)}; the ` +
          "fenced child can edit anything in its own worktree, so anything the fence or " +
          "its evidence depends on must live outside it",
      );
    }
  }
}

/**
 * The provider's state root must be a directory this process can write.
 *
 * **The capability probe will not tell you this, and reading its source is the
 * only way to find out.** `ClaudeCliSessionProvider` writes `probe-evidence.txt`
 * into the state root while probing -- and when that write fails it catches the
 * error and returns a pointer string saying so, because, in its own words,
 * "failing to write it degrades the record, not the probe". That is right for
 * the probe: an unwritable state root says nothing about whether the CLI is
 * compatible. It does mean `requireSpawnable()` succeeds over a state root the
 * provider cannot actually use, and the failure surfaces later, from
 * `mkdirSync` on the session directory -- **after** the branch, the worktree and
 * `workspace_materialized`, on a run `D-0057` will not let anyone materialise
 * again.
 *
 * So the preflight asks the question the probe deliberately does not. A
 * `--state-root` naming an existing regular file, or a directory this process
 * may not write, is an ordinary operator typo, and the whole value of catching
 * it here is that a corrected retry is still free.
 *
 * **This check has a side effect, and its position is chosen for it.** It
 * creates the directory, which is what makes "can this be written" answerable
 * rather than guessed -- and the provider creates it moments later anyway, so
 * nothing irreversible is being done early. It runs **after** the containment
 * check for the reason that check exists: creating it first would put a
 * directory inside the worktree and only then refuse it for being there.
 */
function requireUsableStateRoot(stateRoot: string): void {
  const root = resolve(stateRoot);
  try {
    mkdirSync(root, { recursive: true });
    // `mkdirSync` on an existing directory is a no-op and proves nothing about
    // writing to it, so the permission is asked separately.
    accessSync(root, constants.W_OK);
  } catch (error) {
    throw new LapUsageError(
      `the provider's state root ${pythonRepr(root)} is not a writable directory: ` +
        `${String(error)}. The worker's records and the turn's transcript are written ` +
        "there, and the capability probe does not report this -- it treats an unwritable " +
        "state root as a degraded record rather than an incompatible CLI",
    );
  }
}

/**
 * Every token of the worker's command must be an **absolute path** (`D-0067`).
 *
 * **This rule replaces three separate attempts to make execution resolution
 * safe, and the reason it replaces them is worth more than the rule.**
 *
 * The first attempt skipped any token with no separator in it, reasoning that
 * `claude` is a name looked up on `PATH` rather than a location. The second
 * added a `PATH` check for a relative entry. Each was defeated in turn, and by
 * the same thing every time: **a resolution rule this file does not own.** A
 * `PATH` may carry a relative entry; on POSIX an **empty** element means the
 * current directory, and a filter that dropped empty entries as noise dropped
 * precisely the dangerous one; a command given as an interpreter and a script
 * has a *second* token that resolves relative to the child's cwd, which no
 * check of the first token sees. And the cwds differ: the capability probe runs
 * with the launcher's, the child is spawned with **the workspace** as its.
 *
 * The lesson is the one this file should have drawn at the first attempt.
 * Refusing rather than reimplementing looked like the conservative choice, and
 * it was not: **the condition to refuse on cannot be written without
 * understanding the resolution rules either.** Declining to reimplement them
 * and then depending on them is the same bet with the stake hidden.
 *
 * So the resolution is removed from the path instead. An absolute token is not
 * resolved against anything: not against `PATH`, not against a working
 * directory, not against whichever of the two working directories happens to
 * apply. `isInside` can then answer about it exactly, and the containment rule
 * above is a statement about the file that will actually be executed.
 *
 * **`--claude-command` becomes required, and that is the intended cost.**
 * `PATH` is ambient authority. The whole point of a fence is that what a worker
 * may do is decided explicitly, so "everything is explicit except which binary
 * the worker itself is" was never coherent -- and it showed: with the flag
 * omitted the command was `undefined` here and **nothing at all was checked**,
 * which made passing the flag safer than not passing it.
 *
 * `ClaudeCliSessionProvider` keeps its own `claude` default; this lap simply
 * never reaches it, because it always passes a command. Nothing in the provider
 * changes.
 *
 * **Resolving the name once at admission and recording the result was
 * considered and rejected.** Node has no `which`, and reaching for a shell to
 * get one adds an interpreter -- and its quoting -- to the path that decides
 * what a fenced worker runs. Asking an operator for a full path is a smaller
 * price than that.
 */
function requireAbsoluteWorkerCommand(command: readonly string[] | undefined): void {
  if (command === undefined || command.length === 0) {
    throw new LapUsageError(
      "the worker command must be given, and every token of it must be an absolute path; " +
        "a bare name would be resolved through PATH, which is ambient authority and not " +
        "something a fence can be built on",
    );
  }
  for (const [index, token] of command.entries()) {
    // `isFullyQualified`, not `isAbsolute`. On Windows `\worktree\worker.mjs`
    // is absolute and **drive-relative**: it resolves against whichever drive
    // the reading process is on, so a probe running on `C:` and a child whose
    // working directory is a workspace on `D:` resolve one string as two files.
    // That is the same failure this rule exists to prevent, arriving through the
    // check meant to prevent it -- and the repository already had the right
    // predicate, in the module that applies it to every persisted path.
    if (!isFullyQualified(token)) {
      throw new LapUsageError(
        `the worker command's token ${String(index)} is ${pythonRepr(token)}, which is not ` +
          "a fully qualified path. Every token is resolved by somebody -- PATH for a bare " +
          "name, a working directory for a relative one, and on Windows a DRIVE for a " +
          "rooted-but-driveless one -- and the child's working directory is the worktree it " +
          "may edit, so the command is required to name files outright",
      );
    }
  }
}

/**
 * The budget's rules, stated once and checked from both entry points.
 *
 * Separate from {@link awaitTerminalReport} because of *when* it has to run.
 * The poll is the last step of the lap; validating there means a malformed
 * budget is discovered after a worktree exists, a fence has been published and
 * a child has been started -- and `D-0057` refuses a second materialisation of
 * one run, so a mistyped `--turn-timeout-ms` would cost the run itself, with
 * recovery being a fresh run identifier rather than a corrected retry.
 * `materializeWorkspace` already holds the discipline this states -- refuse a
 * malformed request with nothing created -- and `performLap` now does too.
 */
export function requireCompletion(completion: TurnCompletion): void {
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
}

export async function awaitTerminalReport(
  reader: TerminalReportReader,
  sessionId: string,
  completion: TurnCompletion,
): Promise<LapTerminalReport> {
  // Checked here as well as in `performLap`'s prologue, and the duplication is
  // the point: this is an exported function a caller can reach on its own, so
  // it cannot rely on a check that lives in a different entry point. The RULES
  // are stated once, in `requireCompletion`; only the call is in two places.
  requireCompletion(completion);
  const { pollIntervalMs, timeoutMs } = completion;
  const sleep = completion.sleep ?? DEFAULT_SLEEP;
  const elapsedMs = completion.elapsedMs ?? DEFAULT_ELAPSED_MS;
  // Read once from the clock the caller gave, before the first read rather than
  // after it: a budget that started counting from the first answer would give a
  // provider that blocks for the whole timeout an unbounded second chance.
  const deadline = elapsedMs() + timeoutMs;

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
      if (readout.sessionId !== sessionId) {
        // The reader answered about a different session, and this value is on
        // its way to becoming a gate: `ingestTerminalReport` keys the
        // escalation on the session and generation the report carries, so a
        // mismatched one would open this run's gate over another session's
        // words -- a human asked to approve something no part of this lap ran.
        // Checked rather than trusted because the reader is a parameter: the
        // shipped one is the provider, and the next one may not be.
        throw new LapRefused(
          `the terminal report offered for session ${sessionId} is about ` +
            `${readout.sessionId}; a report is only evidence about the session it names`,
        );
      }
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
    const outOfBudget = (): LapRefused =>
      new LapRefused(
        `session ${sessionId} did not finish its turn within ${timeoutMs}ms; the last ` +
          `answer was ${readout.reason}. The workspace and the fence are left exactly ` +
          "as they are -- the refusal is about the turn, and deleting a checkout the " +
          "worker may have written into is not a rollback -- and the session is stopped " +
          "on the way out",
      );
    if (elapsedMs() >= deadline) {
      throw outOfBudget();
    }
    // Capped at what is left of the budget, not the bare interval. An interval
    // longer than the remaining time would sleep past the deadline and then
    // accept whatever the next read returned -- so a one-second timeout with a
    // two-second interval would accept a report that arrived at two seconds,
    // and `--turn-timeout-ms` would not be a bound at all.
    await sleep(Math.max(0, Math.min(pollIntervalMs, deadline - elapsedMs())));
    // **And again after the wait, because a timer is a minimum and not a
    // promise.** `setTimeout` guarantees only that it will not fire early; a
    // congested event loop can resolve it well past the deadline the cap was
    // computed against. Without this the next iteration reads first and returns
    // whatever it finds, so a report produced long after `--turn-timeout-ms` had
    // passed would be accepted -- and the invariant this function states, that
    // no new read is *started* after the deadline, would be one the code does
    // not keep.
    //
    // **Strictly past, where the check before the wait is at-or-past**, and the
    // asymmetry is the whole of what this preserves. The cap lands the wait
    // exactly ON the deadline by construction, and the read that follows it is
    // the read the wait was for -- refusing it would discard a report that
    // arrived while sleeping, which is the one thing this function never does.
    // Being strictly past means the timer did not honour the cap, and that is
    // the overshoot worth refusing.
    if (elapsedMs() > deadline) {
      throw outOfBudget();
    }
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
  /**
   * Where the session provider keeps its records and the turn's transcript.
   *
   * Carried so it can be **checked**, not used: `performLap` never reads it, and
   * the caller has already built the provider over it. It is here because the
   * transcript is what `readTerminalReport` turns into a gate, and a transcript
   * the worker can edit is a gate opened over words its own subject wrote --
   * and this is the only place that knows both the path and the workspace it
   * must stay out of. See {@link requireOutsideWorkspace} and `D-0067`.
   */
  readonly providerStateRoot: string;
  /** The worker's own command, if the caller pinned one, for the same check. */
  readonly workerCommand?: readonly string[];
  /**
   * The worker's endpoint binding, less the two fields this lap fixes itself.
   *
   * The holder is the admitted intent's claimant, and the **epoch is the one
   * this lap's own acquisition minted** (`D-0074`). Neither is a caller's to
   * supply: an epoch handed in from outside names whatever the caller believed,
   * and nothing under `src/` acquired this resource at all until step 4 -- so
   * the number was a fiction, and the endpoint it configured would have been
   * refused as a stale writer on its first delivery.
   */
  readonly endpoint: Omit<EndpointBinding, "holder" | "epoch">;
  /**
   * The endpoint lease's timer and interval, injectable for the same reason
   * {@link TurnCompletion}'s `sleep` is: a case that asserts on a renewal needs
   * a tick it fires itself rather than one it waits for.
   */
  readonly deliveryLease?: DeliveryLeaseTimers;
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
  /**
   * The deadline this lap was asked for and could not honour, or `null`.
   *
   * Non-null exactly when the operator's `deadlineAtMs` had passed by the time
   * the turn ended, in which case the gate was opened **without** it
   * (`D-0065`). A field rather than a log line, because the caller is what
   * tells the operator -- and it is the operator's own number handed back, so
   * the report can say which deadline was missed rather than that one was.
   */
  readonly elapsedDeadlineAtMs: number | null;
  /**
   * The renewal that latched and lost the endpoint's delivery lease, or `null`.
   *
   * Non-null exactly when a renewal was refused after the spawn and the lap
   * carried on regardless, which it does deliberately: once the turn's report
   * exists, a lost delivery lease costs the lease and never the report
   * (`D-0073`), the same trade `D-0065` made for an elapsed deadline. A loss
   * *before* the spawn is a refusal instead, because there is still a child not
   * to start.
   *
   * A field rather than a log line, for {@link elapsedDeadlineAtMs}'s reason:
   * the caller is what tells the operator, and it is the operator who has to
   * know that the worker's endpoint stopped being able to write partway
   * through -- the gate over the report is open either way.
   */
  readonly endpointLeaseFailure: Error | null;
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
  //    and every later step acts on that record. It comes first because the
  //    workspace the checks below are drawn against is on it.
  const intent = readLapRunIntent(connection, request.runId);

  // 1a. Everything this lap can refuse, refused before anything irreversible.
  //     See {@link preflight} for the list and for why it is a list.
  preflight(request, provider, intent.workspace);

  // 1b. The endpoint's lease, taken and armed (`D-0072`).
  //
  //     **Here and not earlier**: the holder is the admitted intent's claimant,
  //     so there is nothing to take before the intent has been read. **Here and
  //     not later**: the epoch is consumed by the materialiser below, which
  //     renders it into the worker's `mcp.json` as `INTERLOCK_MESSAGEBUS_EPOCH`
  //     -- and an epoch naming no live lease is exactly the defect this step
  //     closes. **After the preflight**, because this is the first durable
  //     write the lap makes and the preflight exists to refuse before one.
  //
  //     `outbox-delivery` is one global resource (`D-0053` rule 4), so a second
  //     concurrent lap is refused `LeaseHeld` right here -- before a worktree
  //     exists, before a fence is published and before any child. That
  //     serialisation is the lap-1 semantics rather than a limitation of this
  //     step: one delivery resource means one endpoint permitted to write.
  //
  //     **Unconditional** (`D-0075`): lap 1 requires the endpoint, so "a lap
  //     ran" and "an endpoint lease was held and renewed for it" are one fact
  //     and there is no branch here to get wrong.
  const hold = holdDeliveryLease(connection, {
    holder: intent.leaseClaimantId,
    // The LIVE clock, and for the reason `D-0066` gives about the orchestrator's:
    // a lease is the one thing in this lap that is about the passage of time,
    // and a renewal stamped from an instant frozen at the top would extend the
    // lease to a moment that has already gone.
    nowMs: request.nowMs,
    ...(request.deliveryLease ?? {}),
  });
  try {
    return await performLapHoldingTheEndpointLease(
      connection,
      provider,
      reader,
      request,
      intent,
      hold,
    );
  } finally {
    // **Unconditional, and it runs last on every path.** None of the three
    // predicates that guard the session teardown applies to a timer, and a
    // lease left held withholds a GLOBAL resource from the next lap for a whole
    // TTL. The ordering is what makes it correct: the inner call's own
    // `finally` has already awaited the session stop by the time this runs, so
    // the worker -- and therefore the endpoint it launched -- is gone before
    // renewal stops; and `lap/cli.ts` closes the database only after this
    // returns, so no tick can reach a closed handle.
    //
    // **Do not move the acquisition inside the inner call.** The timer is not
    // `unref`-ed, so a path that acquires without reaching this `stop` hangs
    // `lap perform` forever.
    hold.stop();
  }
}

/**
 * The lap's order, run with the endpoint's delivery lease held and renewing.
 *
 * Split from {@link performLap} rather than wrapped in place: the lease has to
 * be given up on every path out, including the ones where this body throws, and
 * an outer `try`/`finally` around two hundred lines would have re-indented all
 * of them for one statement. The split also says where the boundary is -- above
 * it the lease exists, below it every step may assume it does.
 */
async function performLapHoldingTheEndpointLease(
  connection: SqliteDatabase,
  provider: SessionProvider,
  reader: TerminalReportReader,
  request: LapRequest,
  intent: LapRunIntent,
  hold: HeldDeliveryLease,
): Promise<LapOutcome> {
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
    // Neither field is the caller's any more (`D-0074`): the holder is the
    // admitted run's claimant and the epoch is the one this lap's own
    // acquisition minted, so the three `INTERLOCK_MESSAGEBUS_` values the
    // worker's endpoint starts under name a lease that is live and being
    // renewed rather than a number somebody typed.
    endpoint: { ...request.endpoint, holder: intent.leaseClaimantId, epoch: hold.epoch },
    fence: request.fence,
    ...(request.gitTimeoutMs === undefined ? {} : { gitTimeoutMs: request.gitTimeoutMs }),
    ...(request.env === undefined ? {} : { env: request.env }),
  });

  // 2a. **The renewal materialisation could not have made.** `materializeWorkspace`
  //     is synchronous and its git runs through `spawnSync`, so the event loop
  //     was blocked for the whole of it and no timer fired -- on a slow
  //     `git worktree add` that is longer than the TTL. Renewing by hand here,
  //     and refusing if the renewal was refused, turns "the lease lapsed while
  //     git ran" into one stderr line **before any child exists**, instead of a
  //     worker whose endpoint is fenced out of its own outbox for a whole turn
  //     and whose only symptom is silence.
  hold.tick();
  hold.requireHeld();

  // 3. The veto, registered before anything can spawn. After materialisation
  //    because it is keyed on what materialisation produced, and before the
  //    orchestrator because `#createWorkspace` asks the observers *before* it
  //    makes the directory -- a veto arriving later would arrive after the
  //    bare directory existed.
  provider.registerWorkspaceObserver(new MaterializedWorkspaceRequired(materialized.workspace));

  // 4. The spawn, through the spawner that admitted the plan and no other.
  //    `execute` consumes the plan before calling the callable, so this is one
  //    admission and one child even if the walk below throws.
  // The identity the orchestrator is about to mint, captured as it mints it.
  //
  // **This is what makes the teardown below cover a walk that FAILED.**
  // `orchestrator.start()` can spawn a child and then reject -- the identity
  // never reads back, the post-spawn validation refuses, this writer loses a
  // race -- and the provider says in as many words that a `Failure` does not
  // prove no process was created. The session id lives inside that rejected
  // call, so a `finally` that read it off the outcome would have no outcome to
  // read, and the child would be left running with nobody observing it and its
  // handle holding this process open.
  //
  // The factory is wrapped rather than replaced: the value handed out is
  // `materialized.options`' own, so the identity the orchestrator commits and
  // the one stopped here cannot differ. `D-0057`'s "nothing below adds a field
  // to these options" is intact -- this observes one, and adds none.
  let sessionId: string | null = null;
  /** The lease epoch this lap's walk held, or `null` if it never took one. */
  let heldEpoch: number | null = null;
  // Derived the way `SessionOrchestrator` derives it, off the same options, so
  // the two cannot name different resources.
  const leaseResource = materialized.options.resource ?? `session-run:${intent.runId}`;
  const options: SessionOrchestratorOptions = {
    ...materialized.options,
    // **The epoch, taken from the acquisition itself** (`D-0068`).
    //
    // The first version read the lease row back after the walk had started, and
    // that answers a different question: if this process was suspended past the
    // TTL between the orchestrator's acquire and the read, the row already
    // belongs to a later claimant -- so the lap would record **the winner's
    // epoch as its own**, pass its own ownership check, and stop the winner's
    // worker. The check would have been defeated by where it got its number,
    // which is the failure it was added to prevent wearing a different hat. The
    // value is only trustworthy at the instant it is minted, and this is the
    // seam that hands it over there.
    onLeaseAcquired: (lease) => {
      heldEpoch = lease.epoch;
    },
    // **The orchestrator gets a LIVE clock, and step 7's frozen one is left
    // where it belongs** (`D-0066`).
    //
    // `MaterializationRequest.nowMs` is a `number`, so `materializeWorkspace`
    // has no live clock to pass on and closes over the instant it was given --
    // correctly, because that instant is what its own event records. But those
    // options are then handed to a `SessionOrchestrator` that acquires a lease
    // with them, and a lease is the one thing in this lap that is *about* the
    // passage of time: `ttlMs` defaults to 30 seconds, so a materialisation that
    // took longer than that -- `git worktree add` on a large repository -- would
    // acquire a lease stamped in the past and already expired. A concurrent
    // claimant reading a live clock could take it over immediately, putting this
    // lap on the loser path after it had already spawned.
    //
    // `request.nowMs` is a function precisely so this step can supply one.
    nowMs: request.nowMs,
    sessionUuidFactory: () => {
      const minted = materialized.options.sessionUuidFactory();
      sessionId = minted;
      return minted;
    },
  };
  const orchestrator = new SessionOrchestrator(connection, provider, options);

  // What went wrong, if anything, so the teardown can consult it. A `finally`
  // cannot see the exception unwinding through it, and here the exception is
  // precisely what decides whether the teardown is allowed to run at all.
  let failure: unknown;
  try {
    let walk: Promise<OrchestrationOutcome> | undefined;
    const spawn = materialized.spawner.execute(materialized.admission, () => {
      walk = orchestrator.start();
      return walk;
    });
    if (walk === undefined) {
      // Unreachable: `execute` either throws before calling the callable or
      // calls it exactly once. Checked rather than asserted, because the
      // alternative is awaiting `undefined` and reporting a lap that never
      // spawned as one that completed.
      throw new LapRefused("internal: the fenced spawn returned without starting the walk");
    }
    const orchestration = await walk;

    // 5. The turn. Awaited out here, outside every transaction, because
    //    `transaction()` joins rather than nests and refuses an async body.
    const report = await awaitTerminalReport(reader, orchestration.sessionId, request.completion);

    // 5a. **The renewal that says whether the lease survived the turn**, and it
    //     is by hand for the same reason the one above materialisation is.
    //     `hold.failure` records *attempted* renewals, so a turn during which no
    //     tick ever ran -- the event loop blocked, the process suspended past
    //     the TTL -- would leave it `null` over a lease that had already lapsed,
    //     and the lap would report nothing wrong while the endpoint had been
    //     fenced out. One synchronous attempt here makes the field an answer
    //     rather than an absence of evidence.
    //
    //     **No `requireHeld()`** (`D-0073`): the report exists, and past this
    //     point a lost lease costs the lease and never the report.
    hold.tick();

    // 6. The settled value, into the one transaction the event and its gate share.
    //
    //    The clock is read ONCE and used for both the deadline decision and the
    //    write, because `gate.created_at_ms` is this instant and the schema's
    //    `deadline_at_ms > created_at_ms` is checked against it. Two reads could
    //    straddle the boundary and put back exactly the constraint violation
    //    below is here to prevent.
    const ingestNowMs = request.nowMs();
    const requested = request.deadlineAtMs ?? null;
    // `D-0065`: an expired deadline costs the deadline, never the report.
    const elapsedDeadlineAtMs = requested !== null && requested <= ingestNowMs ? requested : null;
    const deadlineAtMs = elapsedDeadlineAtMs === null ? requested : null;
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
      nowMs: ingestNowMs,
      actorId: request.actorId ?? LAP_ACTOR_ID,
      deadlineAtMs,
      ...(request.gateOptions === undefined ? {} : { gateOptions: request.gateOptions }),
    });

    return Object.freeze({
      intent,
      materialized,
      orchestration,
      spawn,
      report,
      ingested,
      elapsedDeadlineAtMs,
      // **A field, and never a throw** (`D-0073`). The turn is over and its
      // report is in hand; a delivery lease lost while it ran costs the lease,
      // not the report -- the same trade `D-0065` made for an elapsed gate
      // deadline, in the same shape and one field along.
      endpointLeaseFailure: hold.failure,
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // 7. The session's life is the lap's, and it ends here on almost every path
    //    -- including the ones where the walk itself failed after spawning, and
    //    excluding the one where the orchestrator has already ruled a stop out.
    //    See {@link sessionMayBeStopped}.
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
    //
    //    **And only a session this lap actually bound.** The identity is
    //    captured from the factory the instant it is minted, which is what makes
    //    the teardown cover a walk that failed after spawning -- but minting
    //    happens *before* `prepareBinding`, so an id the orchestrator then
    //    failed to bind (because some other run already holds it) would leave
    //    `sessionId` set for a session this lap never started. Stopping on that
    //    would kill another run's worker, which is the same harm
    //    {@link sessionMayBeStopped} exists to prevent, reached by a different
    //    road. The binding table is the authority on whose session it is:
    //    `activeBinding(runId)` names it only if this run's own binding was
    //    written, and it is written by the orchestrator before any child exists.
    if (
      sessionId !== null &&
      sessionMayBeStopped(failure) &&
      stillThisLapsSession(connection, intent.runId, leaseResource, sessionId, heldEpoch)
    ) {
      await stopSession(provider, sessionId);
    }
  }
}

/**
 * May this lap stop the session it started?
 *
 * **No, in exactly one state, and it is a state the orchestrator has already
 * decided about.** `LoserTerminated` carries `stopAttempted`, and a `false`
 * there is not "the stop failed" -- it is `SessionOrchestrator`'s recorded
 * judgement that it *must not* stop: this claimant lost its lease, a takeover
 * writer has since **confirmed the binding**, and that winner may have adopted
 * the very child this lap spawned. A session-level stop cannot name a process
 * generation, so issuing one here would kill the winner's worker. The
 * orchestrator surfaces the loser's possibly-rogue process as an unresolved
 * hazard on the exception instead, and this function is what keeps that
 * decision from being quietly overridden one frame up.
 *
 * Everything else -- a refused turn, a timeout, a walk that failed while this
 * lap still owned the session, a `LoserTerminated` that *did* stop -- is a
 * session this lap is still responsible for, and it is stopped.
 *
 * **The cost, stated rather than hidden.** In the one state above the child is
 * left running, and the provider holds a referenced handle to it, so
 * `lap perform` may not return until that child exits. That is the safe
 * direction and not a regression to fix by stopping anyway: a command that
 * hangs is visible and recoverable, and a command that killed another
 * claimant's live worker is neither. The hazard is on the exception the
 * operator reads.
 */
export function sessionMayBeStopped(failure: unknown): boolean {
  return !(failure instanceof LoserTerminated) || failure.stopAttempted;
}

/**
 * Is the session named by `sessionId` still **this lap's** to stop? (`D-0068`)
 *
 * **Two questions, and the second is the one that took three attempts to get
 * right.**
 *
 * The first is whether this run bound this identity at all. The identity is
 * captured from the factory the instant it is minted, which is what lets the
 * teardown reach a walk that failed *after* spawning -- but minting happens
 * before `prepareBinding`, so an id the orchestrator then failed to bind
 * (because another run already holds it) would otherwise be stopped by a lap
 * that never started it.
 *
 * The second is whether this lap is still the owner, **and a session id cannot
 * answer it**. `SessionOrchestrator.recover()` reads the id off the existing
 * binding and keeps it, so after a legitimate takeover the binding still names
 * the same session -- an id comparison passes and the original lap stops a
 * worker the new owner has adopted. This is not an edge case: the orchestrator's
 * lease defaults to a 30-second TTL and `--turn-timeout-ms` defaults to fifteen
 * minutes, so **any lap whose worker works for longer than half a minute spends
 * most of its poll holding an expired lease**, which anyone may take.
 *
 * **The owner's identity is the lease epoch.** It is strictly increasing and a
 * change of holder raises it (`docs/lease-fencing.md`), so:
 *
 * - the epoch is unchanged -> nobody took over. The lease may well have expired,
 *   and that is fine: an expired lease nobody claimed leaves this lap the only
 *   party with a claim on the child, and the child is still its to stop.
 * - the epoch has moved -> somebody took over, and whatever they did with the
 *   session is theirs. Stand down, exactly as `LoserTerminated.stopAttempted`
 *   makes the orchestrator stand down.
 *
 * `heldEpoch` of `null` means the walk never reached a lease, so there is
 * nothing this lap can claim to own.
 */
function stillThisLapsSession(
  connection: SqliteDatabase,
  runId: string,
  leaseResource: string,
  sessionId: string,
  heldEpoch: number | null,
): boolean {
  if (heldEpoch === null) {
    return false;
  }
  if (activeBinding(connection, runId)?.sessionId !== sessionId) {
    return false;
  }
  return readLease(connection, leaseResource)?.epoch === heldEpoch;
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
