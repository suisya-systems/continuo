import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { type Destination, KeyedDropbox } from "../control_plane/destination.js";
import { appendEvent } from "../control_plane/events.js";
import { spikeRegistry } from "../control_plane/handlers.js";
// The flags this step generates and refuses an admitted run from restating.
// The list lives beside `FENCE_ALTERING_FLAGS` in `lap_run_intent.ts` rather
// than here, because `D-0086` needs the two concepts stated in one place and
// admission -- which runs before any workspace exists -- checks both. A sixth
// generated flag goes on that list, not on a copy of it here.
import { FENCE_OWNED_FLAGS } from "../control_plane/lap_run_intent.js";
import { pythonJsonDocumentSorted } from "../control_plane/python_json.js";
import { pythonRepr } from "../control_plane/python_repr.js";
import { FenceContext } from "../fencing/renderer.js";
import {
  defaultHookScript,
  FencedSpawner,
  FenceLedger,
  type SpawnOutcome,
  type SpawnPlan,
} from "../fencing/spawn.js";
import { writeAllSync } from "../fencing/state.js";
import { DELIVERY_LEASE_RESOURCE, EndpointConfig } from "../messagebus/endpoint.js";
import type { SessionOrchestratorOptions } from "../supervisor.js";
import {
  addWorktree,
  branchExists,
  type GitOptions,
  gitMetadataRoots,
  isWellFormedBranchName,
  repositoryRoot,
  resolveBranchCommit,
} from "./git.js";

/**
 * Step 7 of `docs/design/minimal-operating-loop.md`: materialise the workspace,
 * render the fence, and commit the result event last.
 *
 * This module is the application service that owns an **order**. Everything it
 * calls already exists -- `git.ts` runs git, `fencing/` renders and publishes,
 * `control_plane/events.ts` appends -- and none of those knows about the
 * others. What was missing, and is here, is the single sequence that turns a
 * base branch and a role into a `SessionOrchestratorOptions` a composition root
 * can hand to a `SessionOrchestrator`, plus the one durable statement that it
 * happened.
 *
 * ## The order, and why it is one-way (`D-0057`)
 *
 * SQLite and the filesystem cannot be joined in one transaction. `D-0051` got
 * atomicity for the `run` row and its `run_created` event by putting both
 * inside one `BEGIN IMMEDIATE`; a git worktree and three files have no such
 * boundary to join, so the property has to be built rather than borrowed.
 *
 * The property built here is not atomicity. It is **one-directionality**:
 *
 * - **artifacts, then the event.** Every file is published and then *re-stat'd*
 *   immediately before {@link appendEvent} is called, so the event names a
 *   manifest that was present a moment earlier.
 * - **"artifacts but no event" is allowed.** A crash anywhere before the append
 *   leaves a worktree and some files with nothing on the spine pointing at
 *   them. That state is recoverable by hand and by
 *   {@link import("./git.js").removeWorktree}, and recognising it is cheap: the
 *   worktree exists, the run has no `workspace_materialized` event.
 * - **"event but no artifacts" is not reachable through this producer.**
 *   {@link materializeWorkspace} is the only producer of
 *   {@link WORKSPACE_MATERIALIZED_EVENT_TYPE} in the build, it appends only
 *   after the stat sweep, and it exports no seam that lets a caller skip to its
 *   own append. What it cannot prevent is a direct `appendEvent` call under
 *   this type: the spine is a generic append-only fact log and every type on it
 *   is writable by anyone holding a connection -- `run_created` included. An
 *   earlier draft of this docstring said "unconstructible", which was wrong;
 *   `D-0057` rule 4 carries the correction and why reserving the type inside
 *   `appendEvent` was rejected.
 *
 * The asymmetry is chosen rather than accidental. Of the two recoverable-from
 * states, "files nobody claims" is a sweep; "a durable record of a workspace
 * that was never built" is a report an operator cannot act on, and the payload
 * of this very event -- the resolved base commit, the paths -- is what a retry
 * would be built from.
 *
 * **The one contrary precedent, reconciled.** `src/control_plane/lease.ts`
 * records `worktree_filesystem` as an unfenced destination whose stated
 * residual is "control-plane row under the fence first, file write derived from
 * it" -- the opposite order. That rule is about a *fenced write to a
 * destination*, where the row is the authority and the file is a projection of
 * it that can be re-derived at will. Nothing here is re-derivable: a worktree
 * is a checkout and the fence is bytes a hook will read. So the two are not in
 * conflict; they are the two halves of the same principle, which is that the
 * artifact that cannot be rebuilt from the record goes first.
 *
 * ## What this does not do
 *
 * It does not spawn. Step 8 writes the composition root and calls
 * {@link FencedSpawner.execute} with the plan this returns. It does not create
 * the run: `continuo run admit` (`D-0051`) does, and the `event.run_id` foreign
 * key means it must already have.
 *
 * It also does not decide what the work is. `runId`, `role`, `baseBranch`,
 * `topicBranch`, `workspace` and `prompt` are fields of the `LapRunIntent` the
 * admission command fixed and wrote (`D-0055`), and the composition root is
 * expected to read them off it rather than to invent a second answer -- that
 * separation is the whole of `D-0057` rule 1. They are taken here as plain
 * fields rather than as an intent because the request needs six more the intent
 * does not carry (the artifact directory, the endpoint binding, the fence
 * substitutions, the clock, the uuid factory, the git timeout), and because a
 * module that imported the intent's type would be a second reader of a record
 * whose only reader should be the step that acts on it. **Whether step 8's
 * composition root should pass the intent itself is a step-8 question, and it
 * is left open rather than answered here.**
 *
 * **ASCII only** in every message, per `docs/cli-output-policy.md`: these
 * strings reach an operator's console through a refusal.
 */

// --------------------------------------------------------------------------
// the vocabulary this step writes
// --------------------------------------------------------------------------

/**
 * The event type materialisation appends, in `D-0051` rule 5's
 * `subject_pastparticiple` form.
 *
 * One type, not three. `worktree_added`, `fence_published` and
 * `mcp_config_written` would each be a fact nothing consumes and would put the
 * partial states this module exists to make unobservable back onto the spine as
 * observable ones.
 */
export const WORKSPACE_MATERIALIZED_EVENT_TYPE = "workspace_materialized";

/** The `producer` stamped on every {@link WORKSPACE_MATERIALIZED_EVENT_TYPE}. */
export const WORKSPACE_MATERIALIZER_PRODUCER = "workspace_materializer";

/**
 * The MCP server name the worker's configuration registers the endpoint under.
 *
 * It is the name a worker's tools appear under, so it says `continuo` rather
 * than `interlock` (`D-0049`). The *environment variable* names inside the
 * configuration keep their `INTERLOCK_MESSAGEBUS_` prefix, which is not an
 * inconsistency: `D-0502` records that those are a wire contract with a
 * configuration file this repository does not own, and this is the file.
 */
export const MCP_SERVER_NAME = "continuo-messagebus";

/**
 * `FencedSpawner`'s own default settings file name, restated.
 *
 * Restated rather than imported because `FencedSpawner` does not export it --
 * it is a constructor default -- and the layout check below has to know what a
 * spawner built without one will write. A drift here is caught by the case that
 * asserts the published settings path is the one this predicts.
 */
const DEFAULT_SETTINGS_NAME = "settings.local.json";

/** File names inside the artifact directory. */
export const FENCE_FILENAME = "fence.json";
export const MCP_CONFIG_FILENAME = "mcp.json";
export const FENCE_LEDGER_FILENAME = "fence-ledger.jsonl";

/**
 * The endpoint module a worker's MCP configuration launches.
 *
 * Resolved relative to this module the way {@link FencedSpawner}'s
 * `defaultHookScript` resolves the deny hook, and for the same reason: the
 * child is `node <path>` (`D-0502`), so what is needed is a path, and the only
 * path that is right in both a checkout and an installed package is one derived
 * from where this file itself ended up. At runtime that is `dist/`, which is
 * also the reason the artifact depends on a build having happened -- stated
 * here rather than discovered when a worker's endpoint fails to start.
 *
 * `fileURLToPath`, never `URL.pathname`: the encoded form yields
 * `/C:/checkout/...` on Windows and percent-encodes a directory containing a
 * space on every platform. See `defaultHookScript`, which fixed exactly this.
 */
export function defaultEndpointModule(): string {
  return fileURLToPath(new URL("../messagebus/endpoint.js", import.meta.url));
}

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/** A caller passed something this module cannot work with. Nothing was done. */
export class WorkspaceMaterializationUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceMaterializationUsageError";
    Object.setPrototypeOf(this, WorkspaceMaterializationUsageError.prototype);
  }
}

/**
 * A {@link Destination} that exists only to be looked past.
 *
 * `spikeRegistry` takes one because `NotifyDestinationHandler` delivers through
 * it; `forRecipient` never touches it. Every method throws rather than
 * returning a plausible value, so a future use that does reach one of them
 * fails loudly here instead of quietly delivering into nothing.
 */
const INERT_DESTINATION: Destination = {
  name: "workspace-materializer-recipient-check",
  apply(): never {
    throw new Error("internal: the recipient check's destination must never be applied to");
  },
  effectCount(): never {
    throw new Error("internal: the recipient check's destination holds no effects");
  },
  attemptCount(): never {
    throw new Error("internal: the recipient check's destination records no attempts");
  },
};

/**
 * Materialisation refused. What had already been written is left where it is.
 *
 * The refusal deliberately does NOT roll back. See the module docstring: the
 * recoverable direction is artifacts without an event, and undoing a checkout
 * an operator may already be looking at is not a rollback, it is a deletion.
 */
export class WorkspaceMaterializationRefused extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceMaterializationRefused";
    Object.setPrototypeOf(this, WorkspaceMaterializationRefused.prototype);
  }
}

// --------------------------------------------------------------------------
// the request
// --------------------------------------------------------------------------

/**
 * What the worker's MCP endpoint is configured with.
 *
 * Every field here is read by `EndpointConfig` at endpoint startup and four of
 * them are refused when empty (exit status 2). They are required of the caller
 * rather than defaulted, because a default would produce a configuration file
 * that looks complete and fails the first time a worker polls -- which is
 * hours later and in a different process.
 */
export interface EndpointBinding {
  /**
   * `INTERLOCK_MESSAGEBUS_DB`: the production control plane, at head.
   *
   * Optional, and **derived from the connection materialisation writes to** when
   * absent -- which is the shape to prefer, because the two must be the same
   * database. `EndpointConfig` cannot check that: a path naming a different,
   * perfectly valid production plane passes `missing()`, the endpoint starts
   * normally, and the worker then polls a database this run's messages will
   * never be written to. Nothing fails; the worker is simply deaf.
   *
   * Supplied only when the worker reaches the same file by a different name --
   * a symlink -- and then it is checked against the connection rather than
   * trusted. See {@link namesTheSameDatabase}, which explains why a hard link
   * is deliberately not one of those names.
   */
  readonly databasePath?: string;
  /** `INTERLOCK_MESSAGEBUS_HOLDER`: the lease claimant the endpoint writes under. */
  readonly holder: string;
  /** `INTERLOCK_MESSAGEBUS_EPOCH`: that lease's epoch. */
  readonly epoch: number;
  /** `INTERLOCK_MESSAGEBUS_RECIPIENT`: the one recipient this endpoint serves. */
  readonly recipient: string;
  /** `INTERLOCK_MESSAGEBUS_DESTINATION_DIR`: the spike destination's directory. */
  readonly destinationDir: string;
  /**
   * The endpoint module to launch. Defaults to {@link defaultEndpointModule}.
   *
   * Overridable because a test drives a built path this checkout may not have,
   * and because an operator running an installed package is not running this
   * checkout at all.
   */
  readonly endpointModule?: string;
  /** The interpreter to launch it with. Defaults to `process.execPath`. */
  readonly node?: string;
}

/** The paths the role document's placeholders are substituted with. */
export interface FenceSubstitutions {
  /** `{interlock_root}`. */
  readonly interlockRoot: string;
  /** `{claude_org_path}`. */
  readonly claudeOrgPath: string;
  /** `{hook_script}`. Defaults to {@link defaultHookScript}, the bundled deny hook. */
  readonly hookScript?: string;
  /** `{python}`. Defaults to `process.execPath` (`D-0204`). */
  readonly python?: string;
}

/** One materialisation. */
export interface MaterializationRequest {
  /** The run this workspace belongs to. Must already be on the `run` table. */
  readonly runId: string;
  /** The lease claimant, carried into `SessionOrchestratorOptions`. */
  readonly holder: string;
  /** The role whose fence is rendered -- a key of the role document. */
  readonly role: string;
  /** A path inside the repository the worktree is added to. */
  readonly repository: string;
  /**
   * The branch the topic branch is cut from, and the branch the lap's pull
   * request is opened against. A branch, not a ref: see
   * {@link import("./git.js").branchExists}.
   */
  readonly baseBranch: string;
  /** The branch created in the new worktree. Must not already exist. */
  readonly topicBranch: string;
  /** Absolute path the worktree is created at. Must not exist. */
  readonly workspace: string;
  /**
   * Absolute path for the fence, settings, MCP configuration and fence ledger.
   *
   * **Outside the worktree, and required rather than defaulted for that
   * reason.** Putting them inside would make the fence a tracked file the
   * worker can commit, `git status` noise on every run, and -- worst -- a
   * fence the fenced child can edit. The layout is the composition root's
   * decision (step 8); this module refuses to guess it.
   */
  readonly artifactDir: string;
  /** The prompt the session's one turn runs, as `settings.prompt`. */
  readonly prompt: string;
  /**
   * The admitted run's extra CLI arguments, in order. Empty when none.
   *
   * `LapRunIntent` carries these (`D-0055`) and the provider consumes them
   * through `settings["cli_args"]`, so a materialiser that did not take them
   * would drop half the durable execution intent between the record and the
   * child -- silently, because `cli_args` would still be present and would
   * still look right, carrying only the flags this step generated.
   *
   * They are placed **before** the fence's own flags and are refused if they
   * name one. See {@link FENCE_OWNED_FLAGS}.
   */
  readonly cliArgs?: readonly string[];
  /** The caller's clock, taken once. Epoch milliseconds. */
  readonly nowMs: number;
  /** Carried verbatim into the returned `SessionOrchestratorOptions`. */
  readonly sessionUuidFactory: () => string;
  readonly endpoint: EndpointBinding;
  readonly fence: FenceSubstitutions;
  /** Per-git-command wall-clock bound. See `git.ts`. */
  readonly gitTimeoutMs?: number;
  /** The environment git runs under. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where the fence ledger is written. Defaults to {@link FENCE_LEDGER_FILENAME}
   * inside the artifact directory.
   *
   * **A path, and deliberately not a `FencedSpawner`.** An earlier revision took
   * the spawner itself, so that a composition root could own the object. That
   * was a mistake of a specific and instructive kind: `FencedSpawner` has two
   * public fields that decide *where it writes* -- `settingsName` and
   * `ledger.path` -- so accepting one handed this module an object whose write
   * paths it did not control, while remaining responsible for the invariant
   * that no artifact lands inside the worktree. Each review round found another
   * way through: an absolute `settingsName`, a traversing one, a `settingsName`
   * aliasing `fence.json`, a ledger inside the checkout. They are not four bugs;
   * they are one design, enumerated.
   *
   * So the spawner is constructed here, over paths this module derived and
   * checked, and handed back on {@link MaterializedWorkspace.spawner} -- which
   * is what a caller needed it for, since under `D-0217` only the admitting
   * instance can execute the plan. What remains configurable is the one thing a
   * caller has a real reason to move, and it is validated like every other
   * artifact path.
   */
  readonly fenceLedgerPath?: string;
}

// --------------------------------------------------------------------------
// the result
// --------------------------------------------------------------------------

/** One file materialisation published, by the role it plays. */
export interface MaterializedArtifact {
  /** `fence`, `settings` or `mcp-config`. */
  readonly kind: string;
  /** Absolute path, as written. */
  readonly path: string;
}

/**
 * The token {@link MaterializedWorkspace}'s constructor demands.
 *
 * Module-private, so `materializeWorkspace` is the only caller that can supply
 * it. The class is exported because a caller has to be able to *name* the type
 * and read its fields; what must not be exported is the ability to **make**
 * one, and in TypeScript a `private constructor` is erased at runtime and gone
 * from the emitted JavaScript entirely.
 *
 * The distinction matters because of what this object is for. Its whole claim
 * is that `workspace` names a checkout git actually made and artifacts this
 * step actually published -- that is the evidence half of the composition
 * root's veto (see {@link MaterializedWorkspace.options}). A value anyone can
 * construct for an arbitrary directory is not evidence of anything, and a
 * step-8 observer keyed on it would be admitting bare directories while
 * believing it had ruled them out. The check has to be one the runtime makes.
 *
 * `src/session/provider.ts`'s `ENUM_MINT` is the same device for the same
 * reason, and this follows it.
 */
const MATERIALIZATION_MINT = Symbol("materialized workspace mint");

/**
 * What step 7 produced: the completed `SessionOrchestratorOptions`, the
 * admitted spawn plan, the git provenance, and the event that records them.
 *
 * The whole value is frozen. It is handed to a composition root that will use
 * `workspace` as a fact about the world -- see {@link options} -- and a field
 * edited after the event was appended would make the record and the object
 * disagree with nothing to notice it.
 */
export class MaterializedWorkspace {
  readonly runId: string;
  readonly holder: string;
  readonly role: string;
  /** The repository's absolute root, as git resolved it. */
  readonly repository: string;
  readonly baseBranch: string;
  /** The full object id `refs/heads/<baseBranch>` named at materialisation. */
  readonly baseCommit: string;
  readonly topicBranch: string;
  /** The worktree. It exists: this object is only constructed after git made it. */
  readonly workspace: string;
  readonly artifactDir: string;
  readonly artifacts: readonly MaterializedArtifact[];
  /** The admitted plan. `FencedSpawner.execute` accepts only a plan it issued. */
  readonly plan: SpawnPlan;
  /** The spawn outcome `prepare` returned, which `execute` takes back. */
  readonly admission: SpawnOutcome;
  /**
   * The spawner that admitted {@link plan}, and the only object that can
   * execute it.
   *
   * Returned rather than discarded because `D-0217` makes provenance
   * per-instance: `execute` consults the spawner's own record of what it
   * admitted, so a step-8 composition root that constructed a second
   * `FencedSpawner` would be refused however correct its configuration. Handing
   * back the admitting instance is what makes the two halves of the split
   * reachable from two different steps -- without it the provenance check would
   * be a lock with the key thrown away.
   *
   * This is the only way to obtain it. See
   * {@link MaterializationRequest.fenceLedgerPath} for why the request takes a
   * path rather than a spawner.
   */
  readonly spawner: FencedSpawner;
  /** The `workspace_materialized` event's identity and sequence on the spine. */
  readonly eventId: string;
  readonly eventSeq: number;
  /**
   * The completed value a `SessionOrchestrator` is constructed with.
   *
   * **This is the evidence half of M2.** `ClaudeCliSessionProvider` creates a
   * missing workspace with a bare `mkdirSync` and announces a
   * `create-workspace` transition first, so a composition root that must not
   * accept a bare directory registers a `WorkspaceLifecycleObserver` that
   * vetoes that transition -- and the thing it needs in order to decide is a
   * workspace path it knows was materialised. That is what this object is: it
   * cannot be constructed except by {@link materializeWorkspace}, and
   * {@link materializeWorkspace} does not return until git has made the
   * checkout. So "`options.workspace` came off a `MaterializedWorkspace`" is a
   * checkable statement, and a veto keyed on it is not a guess.
   *
   * The observer itself is step 8's, along with the rest of the composition
   * root. Nothing in the ported provider is changed to enable it; the veto
   * point already exists (`registerWorkspaceObserver`).
   */
  readonly options: SessionOrchestratorOptions;

  constructor(
    mint: symbol,
    fields: {
      runId: string;
      holder: string;
      role: string;
      repository: string;
      baseBranch: string;
      baseCommit: string;
      topicBranch: string;
      workspace: string;
      artifactDir: string;
      artifacts: readonly MaterializedArtifact[];
      plan: SpawnPlan;
      admission: SpawnOutcome;
      spawner: FencedSpawner;
      eventId: string;
      eventSeq: number;
      options: SessionOrchestratorOptions;
    },
  ) {
    if (mint !== MATERIALIZATION_MINT) {
      throw new WorkspaceMaterializationUsageError(
        "a MaterializedWorkspace is produced by materializeWorkspace and nowhere else; " +
          "it is the statement that a checkout and its artifacts exist, so one that " +
          "could be constructed beside them would be evidence of nothing",
      );
    }
    this.runId = fields.runId;
    this.holder = fields.holder;
    this.role = fields.role;
    this.repository = fields.repository;
    this.baseBranch = fields.baseBranch;
    this.baseCommit = fields.baseCommit;
    this.topicBranch = fields.topicBranch;
    this.workspace = fields.workspace;
    this.artifactDir = fields.artifactDir;
    this.artifacts = Object.freeze([...fields.artifacts]);
    this.plan = fields.plan;
    this.admission = fields.admission;
    this.spawner = fields.spawner;
    this.eventId = fields.eventId;
    this.eventSeq = fields.eventSeq;
    this.options = fields.options;
    Object.freeze(this);
  }
}

// --------------------------------------------------------------------------
// validation
// --------------------------------------------------------------------------

/**
 * The field rules, restated from `LapRunIntent` rather than invented here.
 *
 * This module validates the same values a second time -- it is a second reader
 * of the intent's fields, and a caller can reach it without one -- so the rules
 * have to be the *same* rules. They were not, at first, and the divergence had
 * a name: applying the run-identifier rule to every string refused any run whose
 * workspace, branch, role or prompt carried a non-ASCII character. This
 * organization has repositories under paths with Japanese in them and writes its
 * prompts in Japanese, so that is not a hypothetical strictness -- it is step 7
 * refusing work `run admit` accepted, which is the port being stricter than the
 * record it acts on.
 *
 * So, field by field, matching `src/control_plane/lap_run_intent.ts`:
 *
 * - **the run identifier** is printable ASCII. It is quoted into one-line
 *   reports and refusals that end at a single newline, on a console that may be
 *   cp932.
 * - **every other text field** may be anything but a *control* character.
 *   `docs/cli-output-policy.md` says in as many words that values continuo
 *   receives from outside "may of course be non-ASCII"; what a control
 *   character does is different in kind, because it ends a line or moves a
 *   cursor and so cannot appear in a later report as the string the database
 *   holds.
 * - **the prompt** is held to nothing but non-emptiness. It is operator-written
 *   prose and may legitimately carry newlines.
 * - **every path** must additionally be *fully qualified*, which on Windows is
 *   not what `isAbsolute` answers. See {@link isFullyQualified}.
 *
 * `pythonJsonDocumentSorted` escapes every character from `U+007F` up exactly as
 * `json.dumps` does, so the event payload stays ASCII whatever these hold, and
 * `pythonRepr` does the same for the refusal messages.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** The C0 and C1 control characters. See the note above; `D-0055`'s rule. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the range is the subject
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

/** Non-empty text, and nothing more. The rule the prompt is held to. */
function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkspaceMaterializationUsageError(
      `${field} must be a non-empty string, got ${pythonRepr(value)}`,
    );
  }
  return value;
}

/** Non-empty text that can be quoted back into a line without breaking it. */
function requireQuotableText(field: string, value: unknown): string {
  const text = requireText(field, value);
  if (CONTROL_CHARACTERS.test(text)) {
    throw new WorkspaceMaterializationUsageError(
      `${field} must not contain a control character, got ${pythonRepr(text)}; ` +
        "this value is quoted back in this step's refusals and written into a " +
        "durable event payload, so a value that ends a line or moves a cursor is " +
        "one that cannot be quoted back as the string the database holds",
    );
  }
  return text;
}

/** The run identifier's rule, which is nobody else's. */
function requireRunId(field: string, value: unknown): string {
  const text = requireQuotableText(field, value);
  if (!PRINTABLE_ASCII.test(text)) {
    throw new WorkspaceMaterializationUsageError(
      `${field} must be printable ASCII (U+0020..U+007E), got ${pythonRepr(text)}; ` +
        "the identifier is printed back verbatim in this step's refusals, so a " +
        "character that cannot be printed is one that cannot be reported",
    );
  }
  return text;
}

/**
 * The admitted run's own CLI arguments, checked.
 *
 * The same three spellings `claude_cli_provider.ts`'s `matchesOwnedFlag`
 * recognises, minus the attached-value form, which only applies to its
 * single-dash short flags and none of these are: the exact form and the
 * `--flag=value` form. A rejection that knew one of the two would be a
 * rejection with a doorway in it.
 */
function requireCliArgs(value: unknown): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    throw new WorkspaceMaterializationUsageError(
      `cli_args must be an array of strings, got ${pythonRepr(value)}`,
    );
  }
  // `requireQuotableText` is deliberately NOT used: it demands non-emptiness,
  // and `LapRunIntent` permits an empty string as an argv element in as many
  // words -- "refusing it would be a rule this record invented". The rule here
  // is the one the record actually applies: a string, and no control character.
  //
  // This is the second time this module was stricter than the record it reads
  // (the first refused non-ASCII paths), which is why `D-0057` states the
  // general form rather than only the instance.
  const args = value.map((argument, index) => {
    const field = `cli_args[${String(index)}]`;
    if (typeof argument !== "string") {
      throw new WorkspaceMaterializationUsageError(
        `${field} must be a string, got ${pythonRepr(argument)}`,
      );
    }
    if (CONTROL_CHARACTERS.test(argument)) {
      throw new WorkspaceMaterializationUsageError(
        `${field} must not contain a control character, got ${pythonRepr(argument)}`,
      );
    }
    return argument;
  });
  for (const [index, argument] of args.entries()) {
    for (const flag of FENCE_OWNED_FLAGS) {
      if (argument === flag || argument.startsWith(`${flag}=`)) {
        throw new WorkspaceMaterializationUsageError(
          `cli_args[${String(index)}] is ${pythonRepr(argument)}, which repeats ${flag} -- ` +
            "a flag this step generates from the rendered fence. An admitted run may not " +
            "restate the fence's own arguments, because which occurrence a CLI honours is " +
            "not a property this repository controls",
        );
      }
    }
  }
  return Object.freeze(args);
}

/**
 * Is this a path that means the same thing to every process that reads it?
 *
 * Restated from `src/control_plane/lap_run_intent.ts`, which explains it in
 * full: `isAbsolute` is not that question on Windows, where
 * `path.win32.isAbsolute("\\worktree")` is `true` for a **drive-relative**
 * path that resolves against whichever drive the reading process happens to be
 * on. Every path here is written into an event payload or an `mcp.json` that a
 * different process reads later, so the two can disagree and one recorded string
 * would name two directories.
 *
 * The rule is the root rather than the leading separator: `parse` gives `"C:\\"`
 * for a drive-qualified path and `"\\\\server\\share\\"` for a UNC one, and a bare
 * separator for the drive-relative form. On POSIX the root of an absolute path
 * is always one character, which is why `isAbsolute` is asked first and the root
 * is only examined where the two can disagree.
 */
function isFullyQualified(path: string): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  if (process.platform !== "win32") {
    return true;
  }
  return parsePath(path).root.length > 1;
}

function requireAbsolute(field: string, value: unknown): string {
  const text = requireQuotableText(field, value);
  if (!isFullyQualified(text)) {
    throw new WorkspaceMaterializationUsageError(
      `${field} must be a fully qualified absolute path, got ${pythonRepr(text)}; ` +
        "this value is read back by a later process with a working directory -- " +
        "and, on Windows, a current drive -- of its own, so a path whose meaning " +
        "depends on who reads it is one this step cannot fix",
    );
  }
  return text;
}

function requireInteger(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WorkspaceMaterializationUsageError(
      `${field} must be an integer, got ${pythonRepr(value)}`,
    );
  }
  return value;
}

// --------------------------------------------------------------------------
// artifact publication
// --------------------------------------------------------------------------

/**
 * Write one JSON artifact the way the fence is written: temp sibling, full
 * write, fsync, rename.
 *
 * Not `writeFileSync`. A truncated `mcp.json` is valid enough to parse in some
 * shapes and is read by a program this repository does not run, so a partial
 * write would be discovered by a worker failing to poll rather than by anything
 * here. `writeAllSync` (short-write loop) then `fsyncSync` then `renameSync` is
 * the sequence `state.writeFence` and `FencedSpawner.writeSettings` already use,
 * borrowed rather than re-derived so all three artifacts are published to the
 * same standard.
 */
function publishJsonArtifact(path: string, document: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = `${pythonJsonDocumentSorted(document)}\n`;
  const handle = openSync(tmp, "w");
  try {
    writeAllSync(handle, Buffer.from(body, "utf8"));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(tmp, path);
  return path;
}

/**
 * Build the worker's MCP configuration, and refuse one the endpoint would not
 * start under.
 *
 * The validation is `EndpointConfig` itself -- the class `main()` constructs
 * from `process.env` at endpoint startup and calls `missing()` on before it
 * serves anything. Re-implementing the check here would be a second statement
 * of the same contract, and the failure mode of a second statement is that it
 * drifts and the artifact starts passing a check the endpoint does not run.
 *
 * So the env map is built, fed to the real `EndpointConfig`, and refused if it
 * reports a gap or names a resource lap 1 does not admit. An `mcp.json` this
 * function returns is one the endpoint accepts.
 */
function renderMcpConfig(
  binding: EndpointBinding,
  databasePath: string,
  destinationDir: string,
): {
  readonly document: unknown;
  readonly env: Record<string, string>;
  /** The interpreter the MCP server is launched with, normalised. */
  readonly node: string;
  /** The module it is launched on, normalised. */
  readonly endpointModule: string;
} {
  const env: Record<string, string> = {
    INTERLOCK_MESSAGEBUS_DB: databasePath,
    INTERLOCK_MESSAGEBUS_RESOURCE: DELIVERY_LEASE_RESOURCE,
    INTERLOCK_MESSAGEBUS_HOLDER: binding.holder,
    INTERLOCK_MESSAGEBUS_EPOCH: String(binding.epoch),
    INTERLOCK_MESSAGEBUS_RECIPIENT: binding.recipient,
    INTERLOCK_MESSAGEBUS_DESTINATION_DIR: destinationDir,
  };

  const config = new EndpointConfig(env);
  try {
    // The registry the endpoint builds, built the same way, over an inert
    // destination. `spikeRegistry`'s composition is what decides which
    // recipients exist, so asking IT is the only check that cannot drift from
    // the one `main()` runs -- and the destination is never used, because
    // `forRecipient` only looks a name up. A real `KeyedDropbox` here would
    // create the destination directory as a side effect of validating a request
    // that may be about to be refused.
    spikeRegistry(INERT_DESTINATION).forRecipient(config.recipient);
  } catch (error) {
    throw new WorkspaceMaterializationUsageError(
      `the MCP configuration names recipient ${pythonRepr(config.recipient)}, which no ` +
        "registered handler serves; the endpoint refuses such a recipient at startup, and a " +
        "worker configured with one would poll an eternally empty queue while its real " +
        "messages stayed due",
      { cause: error },
    );
  }
  const gaps = config.missing();
  if (gaps.length > 0) {
    throw new WorkspaceMaterializationUsageError(
      `the MCP configuration would leave the endpoint unable to start; ` +
        `these are unset or unusable: ${gaps.join(", ")}`,
    );
  }
  if (config.resource !== DELIVERY_LEASE_RESOURCE) {
    // Unreachable while the resource is written from the constant above, and
    // checked anyway: this is the assertion that keeps the two in step if the
    // binding ever grows a `resource` field, which is the shape the endpoint's
    // own startup refusal is about.
    throw new WorkspaceMaterializationUsageError(
      `the MCP configuration names lease resource ${pythonRepr(config.resource)}, ` +
        `which the endpoint refuses; lap 1 admits only ${pythonRepr(DELIVERY_LEASE_RESOURCE)}`,
    );
  }

  // Validated rather than defaulted-over. `??` does not fire on `""`, and an
  // empty command or module path is outside `EndpointConfig`'s contract
  // entirely -- it validates the *environment*, not the launcher -- so an
  // empty override would sail through `missing()` and be recorded as a
  // successful materialisation whose MCP child cannot start.
  // `requireAbsolute`, not `requireQuotableText`, and the difference is the
  // whole of `D-0067` applied to this one field (`D-0070`). The string returned here is
  // written into `mcp.json` verbatim and then executed by the fenced worker's
  // Claude, whose working directory is **the worktree** -- so a relative
  // `--node ./node` names a file the worker itself may write, and a bare `node`
  // is resolved through a `PATH` this process does not own. Neither is a value
  // materialisation can judge, and both are values it can refuse.
  //
  // `resolve`d at the same time, and NOT only on the way out: these two strings
  // are what gets written into the document below, and warding one spelling
  // while publishing another is a gap rather than an inelegance. `resolve`
  // collapses `..` textually, the kernel collapses it after following symlinks,
  // and the two disagree exactly when a component is a link -- so a `--node`
  // spelled with a `..` could be warded as one file and executed as another.
  const node = resolve(requireAbsolute("endpoint.node", binding.node ?? process.execPath));
  const endpointModule = resolve(
    requireAbsolute("endpoint.endpoint_module", binding.endpointModule ?? defaultEndpointModule()),
  );
  return {
    document: {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: node,
          args: [endpointModule],
          env,
        },
      },
    },
    env,
    // Returned rather than recomputed by the caller: these two are the
    // launcher and the module the containment check wards, and a second
    // `??`-and-`requireAbsolute` at the call site would be a second statement
    // of which file this `mcp.json` actually names -- the drift `D-0067`
    // records as the way one rule becomes two (`D-0070`). They are the same
    // bytes the document above carries, which is the point.
    node,
    endpointModule,
  };
}

// --------------------------------------------------------------------------
// the step
// --------------------------------------------------------------------------

/**
 * Materialise one workspace and record that it happened.
 *
 * The order is the contract; see the module docstring. In outline:
 *
 * 1. validate the request (nothing is touched if this fails);
 * 2. resolve the repository, prove `baseBranch` is a **branch**, resolve it to
 *    a commit, and prove `topicBranch` is free;
 * 3. `git worktree add` at that exact commit;
 * 4. render, prove, publish and admit the fence through
 *    {@link FencedSpawner.prepare} -- which writes `fence.json` and
 *    `settings.local.json` and records `spawn-admitted`;
 * 5. publish the MCP configuration;
 * 6. re-stat every artifact;
 * 7. append `workspace_materialized`, last.
 *
 * @throws {WorkspaceMaterializationUsageError} for a malformed request, before
 *   anything is created.
 * @throws {WorkspaceMaterializationRefused} when a step refuses. Whatever
 *   earlier steps wrote is left in place, deliberately.
 * @throws {import("./git.js").GitRefusal} when git itself fails. Not wrapped:
 *   the three git failure shapes are the ones an operator acts on differently,
 *   and flattening them into one refusal would lose the distinction between
 *   "git said no" and "git never answered".
 */
export function materializeWorkspace(
  connection: SqliteDatabase,
  request: MaterializationRequest,
): MaterializedWorkspace {
  const runId = requireRunId("run_id", request.runId);
  const holder = requireQuotableText("holder", request.holder);
  const role = requireQuotableText("role", request.role);
  const repository = requireAbsolute("repository", request.repository);
  const baseBranch = requireQuotableText("base_branch", request.baseBranch);
  const topicBranch = requireQuotableText("topic_branch", request.topicBranch);
  // `resolve` rather than the raw value: it collapses `.` and `..` and
  // normalises separators, and both of the things done with these paths depend
  // on that. The containment guard below is lexical, so
  // `/a/other/../worktree/.continuo` would slip past a prefix comparison while
  // `join` puts the fence inside the worktree anyway; and the paths are written
  // into a durable event payload that an operator and a later retry both read,
  // where an un-normalised spelling is a second name for one directory.
  const workspace = resolve(requireAbsolute("workspace", request.workspace));
  const artifactDir = resolve(requireAbsolute("artifact_dir", request.artifactDir));
  const destinationDir = resolve(
    requireAbsolute("endpoint.destination_dir", request.endpoint.destinationDir),
  );
  const nowMs = requireInteger("now_ms", request.nowMs);
  requireInteger("endpoint.epoch", request.endpoint.epoch);
  requireText("prompt", request.prompt);
  const cliArgs = requireCliArgs(request.cliArgs);
  // Kept rather than discarded, and `resolve`d for the same two reasons the
  // workspace is: the containment guard below is lexical, and these are written
  // into the fence a later process reads.
  const interlockRoot = resolve(
    requireAbsolute("fence.interlock_root", request.fence.interlockRoot),
  );
  const claudeOrgPath = resolve(
    requireAbsolute("fence.claude_org_path", request.fence.claudeOrgPath),
  );
  // The deny hook and its interpreter, required to be fully qualified for the
  // reason `requireAbsolute`'s own refusal gives -- these two are rendered into
  // `settings.local.json` as the `PreToolUse` command, and Claude runs that
  // command with **the worktree** as its working directory. A relative
  // `--hook-script ./hook.py` is therefore `<workspace>/hook.py` when it is
  // finally executed, however safe it looked in the operator's shell, and a
  // bare `--python python3` is resolved through a `PATH` this process neither
  // owns nor can inspect. The lap already learned this once on the worker's own
  // command (`D-0067`, `D-0070`): the fix is to remove the resolution, not to reimplement
  // whoever else's rules would have performed it.
  const hookScript = resolve(
    requireAbsolute("fence.hook_script", request.fence.hookScript ?? defaultHookScript()),
  );
  const python = resolve(requireAbsolute("fence.python", request.fence.python ?? process.execPath));
  if (typeof request.sessionUuidFactory !== "function") {
    throw new WorkspaceMaterializationUsageError("session_uuid_factory must be a function");
  }
  // Rendered and validated HERE, before anything is created, and only
  // published at step 5. `renderMcpConfig` refuses a binding the endpoint would
  // not start under, and that is a malformed request -- so it has to be refused
  // where this error family promises it is refused: with nothing built. Leaving
  // it at the publication site made an empty `destinationDir` cost a topic
  // branch, a worktree, two published files and an admission ledger line before
  // anyone said the request was wrong.
  const endpointDatabase = endpointDatabasePath(connection, request.endpoint);
  const mcp = renderMcpConfig(request.endpoint, endpointDatabase, destinationDir);
  // **Containment for what the fence DEPENDS on but this step does not write**
  // (`D-0067`, closed for the materialiser's own fields by `D-0070`).
  //
  // The artifact list below states this rule over what materialisation
  // *creates*, and its refusal says why in its own words: "the fence and the
  // settings must not be files the fenced child can edit". By that argument the
  // **deny hook** belongs on a list before either of them. It is the file that
  // *enforces* the fence, the worker may edit anything in its own worktree, and
  // the hook does not protect its own path -- so a hook inside the worktree is
  // a fence the worker rewrites between one tool call and the next.
  //
  // The same hole, one step further out each time: the interpreter runs the
  // hook; the endpoint module and its interpreter run holding the messagebus
  // lease and the control plane's path; the database is where the gate this
  // whole lap exists to open is stored; and `{interlock_root}` /
  // `{claude_org_path}` are substituted into the fence's own deny rules, so a
  // `denyRead` of `{interlock_root}/.secrets` pointed inside the worktree
  // denies a directory holding no secrets while the real one stays readable.
  //
  // Checked separately from the artifacts rather than appended to that list,
  // because the two lists are asked opposite questions: an artifact must NOT
  // exist yet, and every one of these must already exist to be worth anything.
  //
  // Every entry is already fully qualified where it is validated, so `resolve`
  // here normalises and never resolves against this process's directory --
  // which matters, because this process's directory is not where any of these
  // are read from.
  //
  // The database entry is the one whose *hole* is out of reach rather than
  // whose check is: `git worktree add` refuses a workspace directory that is
  // already there, and a database has to exist to have been opened -- so the
  // refusal below fires, but git would have refused the same request a moment
  // later. It is on the list because the rule is about what the fence depends
  // on, not about which violations happen to have a second backstop.
  const wardedPaths: readonly (readonly [string, string])[] = [
    ["the deny hook", hookScript],
    ["the hook's interpreter", python],
    ["the endpoint module", mcp.endpointModule],
    ["the endpoint's interpreter", mcp.node],
    ["the control plane database", resolve(endpointDatabase)],
    ["the fence's interlock root", interlockRoot],
    ["the fence's claude-org path", claudeOrgPath],
  ];
  for (const [what, path] of wardedPaths) {
    if (isInside(path, workspace)) {
      throw new WorkspaceMaterializationUsageError(
        `${what} is ${pythonRepr(path)}, inside the workspace ${pythonRepr(workspace)}; ` +
          "the fenced child can edit anything in its own worktree, so a fence that " +
          "depends on a file living there is a fence the worker rewrites",
      );
    }
  }
  // The layout invariant, checked over every path an artifact will actually be
  // written to rather than over the directory they are nominally in.
  //
  // `artifactDir` alone is not enough, and the gap is reachable rather than
  // theoretical: `FencedSpawner.settingsName` is a public field, `writeSettings`
  // treats an ABSOLUTE one as a full replacement for the directory, and a
  // caller-supplied spawner (added so step 8 can execute the plan) carries
  // whatever name it was built with. So a request whose `artifactDir` is
  // impeccable can still publish `settings.local.json` into the worktree, where
  // the stat sweep would accept it and the fenced child could edit it. Checking
  // the paths closes that without making the spawner less useful than it is.
  const fencePath = join(artifactDir, FENCE_FILENAME);
  // `settingsName` is this module's own default rather than a caller's, so the
  // spawner writes where this list says. See `fenceLedgerPath`.
  const settingsPath = join(artifactDir, DEFAULT_SETTINGS_NAME);
  const mcpConfigPath = join(artifactDir, MCP_CONFIG_FILENAME);
  const fenceLedgerPath = resolve(
    requireAbsolute(
      "fence_ledger_path",
      request.fenceLedgerPath ?? join(artifactDir, FENCE_LEDGER_FILENAME),
    ),
  );
  // The paths this step (or `prepare` on its behalf) CREATES. The unclaimed
  // check below is stated over exactly this list, because "already there means
  // somebody else owns it" is an argument about a path whose only maker is
  // materialisation.
  const publishedArtifactPaths: readonly (readonly [string, string])[] = [
    ["the fence", fencePath],
    ["the settings", settingsPath],
    ["the MCP configuration", mcpConfigPath],
    // The ledger is written by `prepare` too, and it is the admission audit
    // trail -- the one artifact whose whole value is that its subject cannot
    // edit it.
    ["the fence ledger", fenceLedgerPath],
  ];
  const plannedArtifactPaths: readonly (readonly [string, string])[] = [
    ["artifact_dir", artifactDir],
    ...publishedArtifactPaths,
    // Not written by this step at all -- `KeyedDropbox` creates it at endpoint
    // startup and writes delivery files into it for the rest of the worker's
    // life. It belongs on this list for exactly that reason: it is the one
    // configured path whose contents appear inside the checkout *later*, where
    // no check of this step's would ever see them, and they are the operator's
    // delivery artifacts rather than the worker's. It is on THIS list and not
    // on `publishedArtifactPaths`, and `D-0085` is why: the containment and
    // distinctness rules below are about where the path is, which holds for a
    // dropbox this step never makes, while the unclaimed rule is about who made
    // it, which does not.
    ["the endpoint destination directory", destinationDir],
  ];
  // Unclaimed, before anything is created. Two runs pointed at one artifact
  // directory would otherwise have the second's `prepare` publish over the
  // first's fence and settings -- and the first's worker may be running under
  // them right now, so this is not a tidiness rule but the same "do not replace
  // a live fence" property `FencedSpawner` defends on the other side. It is
  // also reachable within ONE run: a retry with a different workspace replaces
  // the artifacts and only then meets the duplicate-event refusal, leaving the
  // earlier materialisation's files destroyed by a call that failed.
  //
  // The same shape `git worktree add` already imposes on the checkout, applied
  // to the directory beside it: materialisation creates what it names, so
  // finding it already there means somebody else owns it.
  //
  // Which is why the endpoint destination directory is NOT here. Materialisation
  // does not name it into existence -- `KeyedDropbox` opens it, `mkdir -p`, at
  // endpoint startup and again on every `gate deliver` -- so its presence says
  // nothing about another materialisation, and refusing it made the one dropbox
  // an operator polls unusable for the second lap pointed at it (`D-0085`, #122).
  // What a shared dropbox actually needs is a superseded writer refused, and the
  // dropbox has that already: `KeyedDropbox` keeps a per-scope fencing watermark
  // beside the effects and honours it before every apply.
  for (const [what, path] of publishedArtifactPaths) {
    if (existsSync(path)) {
      throw new WorkspaceMaterializationRefused(
        `${what} would be written to ${pythonRepr(path)}, which already exists; ` +
          "materialisation creates its artifacts, so a path that is already there " +
          "belongs to another materialisation -- publishing over it would replace a " +
          "fence some worker may be running under",
      );
    }
  }
  // Exempt from the ownership rule above, NOT from being a directory. The
  // reuse this step now permits is `KeyedDropbox`'s `mkdirSync(..., {recursive:
  // true})`, and that call does not open an existing *file*: it throws a raw
  // `EEXIST`/`ENOTDIR` at endpoint startup, which is after this step has cut a
  // branch and a worktree, published four artifacts and appended the event. So
  // the one thing the narrowing must not lose is the refusal of a destination
  // that is not a directory, and it is refused here -- where this error family
  // promises a malformed request is refused, with nothing built.
  //
  // Asked with `lstatSync` and answered with `statSync`, rather than with
  // `existsSync`: the two disagree on a **dangling symlink**, and that is the
  // spelling of "not a directory" a path check written the obvious way misses.
  // `existsSync` follows the link, finds nothing, and reports the path absent --
  // while `mkdirSync(..., {recursive: true})` sees the link itself and refuses
  // with `EEXIST`. So the entry is asked for without following (present at all?)
  // and then with (does it resolve to a directory?).
  const destinationEntry = lstatSync(destinationDir, { throwIfNoEntry: false });
  if (destinationEntry !== undefined) {
    const resolved = statSync(destinationDir, { throwIfNoEntry: false });
    if (resolved === undefined || !resolved.isDirectory()) {
      throw new WorkspaceMaterializationUsageError(
        `the endpoint destination directory ${pythonRepr(destinationDir)} exists and does not ` +
          "resolve to a directory; the dropbox opens it as one, so the endpoint would fail to " +
          "start under a materialisation this step had already recorded",
      );
    }
  }
  // Reuse is safe within ONE control plane, and this is where that qualifier is
  // enforced rather than left in a docstring. The dropbox keeps its fencing
  // watermark per scope, and the scope is the lease resource name
  // (`outbox-delivery`) -- a constant, with no database in it -- while the
  // epochs compared against it are a lease sequence local to one control plane.
  // So a dropbox that another database already drove to epoch 5 refuses this
  // run's epoch 1 as stale, and it refuses it at the endpoint's first delivery:
  // after the branch, the worktree, the artifacts and the event. Same-plane
  // reuse -- the case #122 is about -- passes, because a later lease epoch on
  // one resource is always higher than the ones before it.
  if (destinationEntry !== undefined) {
    // The read is wrapped because the fence file is somebody else's artifact: a
    // torn or hand-edited one raises out of `JSON.parse`, and the endpoint would
    // raise the same way on its first apply. Refused here, as a refusal, rather
    // than there, as a stack trace over a materialisation already recorded.
    let honoured: number | null;
    try {
      honoured = new KeyedDropbox(destinationDir, "materialisation-preflight").honouredToken(
        DELIVERY_LEASE_RESOURCE,
      );
    } catch (error) {
      throw new WorkspaceMaterializationRefused(
        `the endpoint destination directory ${pythonRepr(destinationDir)} holds a fence file ` +
          "that cannot be read; the dropbox checks it before every effect, so the endpoint would " +
          "fail the same way on its first delivery",
        { cause: error },
      );
    }
    if (honoured !== null && honoured >= request.endpoint.epoch) {
      throw new WorkspaceMaterializationRefused(
        `the endpoint destination directory ${pythonRepr(destinationDir)} has already honoured ` +
          `fencing token ${honoured} for ${pythonRepr(DELIVERY_LEASE_RESOURCE)}, which is not ` +
          `below this endpoint's epoch ${request.endpoint.epoch}; the dropbox would refuse every ` +
          "effect this run delivers as stale. A dropbox belongs to one control plane, whose lease " +
          "epochs only ever rise",
      );
    }
  }
  // This is check-then-act, and `D-0057` rule 3 records why the residual is
  // accepted: two processes reaching an initially empty directory both pass,
  // and the later one overwrites the earlier's fence. It needs two runs sharing
  // one `artifactDir`, which lap 1's layout does not produce -- step 8 cuts one
  // per run. The minimal close, if that changes, is `mkdirSync` without
  // `recursive` and its `EEXIST` as the claim.
  for (const [what, path] of plannedArtifactPaths) {
    if (isInside(path, workspace)) {
      throw new WorkspaceMaterializationUsageError(
        `${what} would be written to ${pythonRepr(path)}, inside the workspace ` +
          `${pythonRepr(workspace)}; the fence and the settings must not be files the ` +
          "fenced child can edit, and the worktree must stay a clean checkout",
      );
    }
  }
  // Distinctness, which containment does not imply. Two artifacts at one path
  // is not a layout error, it is a silent substitution: a `settingsName` of
  // `fence.json` overwrites the fence during publication, and one of `mcp.json`
  // is overwritten by the MCP document afterwards -- leaving `plan.settingsPath`
  // naming a file with no hooks and no sandbox in it, while every later `stat`
  // succeeds and the sweep reports a complete manifest.
  // Keyed on {@link pathIdentity}, not on the raw string: see that function for
  // what an exact-string map missed.
  const seen = new Map<string, string>();
  for (const [what, path] of plannedArtifactPaths.slice(1)) {
    const previous = seen.get(pathIdentity(path));
    if (previous !== undefined) {
      throw new WorkspaceMaterializationUsageError(
        `${what} and ${previous} would both be written to ${pythonRepr(path)}; ` +
          "one artifact would silently replace the other and the manifest would " +
          "still read complete",
      );
    }
    seen.set(pathIdentity(path), what);
  }

  const git: GitOptions = {
    cwd: repository,
    ...(request.gitTimeoutMs === undefined ? {} : { timeoutMs: request.gitTimeoutMs }),
    ...(request.env === undefined ? {} : { env: request.env }),
  };

  // -- 2. the branches, and M1's whole point --------------------------------
  const repositoryRootPath = repositoryRoot(git);

  if (!isWellFormedBranchName(baseBranch, git)) {
    throw new WorkspaceMaterializationRefused(
      `base_branch ${pythonRepr(baseBranch)} is not a well-formed branch name`,
    );
  }
  if (!branchExists(baseBranch, git)) {
    // The refusal M1 is about. `rev-parse` would have accepted a tag, an
    // abbreviated object id, `HEAD`, or a remote-tracking ref here -- four
    // things that are not branches, and three of which the lap cannot open a
    // pull request against at step 11.
    throw new WorkspaceMaterializationRefused(
      `base_branch ${pythonRepr(baseBranch)} is not a branch in ` +
        `${pythonRepr(repositoryRootPath)}; refs/heads/${baseBranch} does not exist. ` +
        "A tag, a commit id or a remote-tracking ref is not a base branch: the lap " +
        "opens its pull request against this name and has to be able to.",
    );
  }
  const baseCommit = resolveBranchCommit(baseBranch, git);

  if (!isWellFormedBranchName(topicBranch, git)) {
    throw new WorkspaceMaterializationRefused(
      `topic_branch ${pythonRepr(topicBranch)} is not a well-formed branch name`,
    );
  }
  if (branchExists(topicBranch, git)) {
    throw new WorkspaceMaterializationRefused(
      `topic_branch ${pythonRepr(topicBranch)} already exists in ` +
        `${pythonRepr(repositoryRootPath)}; materialisation creates the branch it ` +
        "checks out, so an existing one means two runs believe they own it",
    );
  }

  // -- 3. the worktree ------------------------------------------------------
  // The start point is `baseCommit`, never `baseBranch`: see `addWorktree`.
  addWorktree({ path: workspace, branch: topicBranch, startCommit: baseCommit }, git);

  // -- 4. the fence, through the admission path and not around it -----------
  const context = new FenceContext({
    interlockRoot,
    // `{worker_dir}` is the checkout the worker works in, which is the
    // worktree -- not the artifact directory beside it. The role document
    // exports it as `WORKER_DIR`, and a worker told its directory is the place
    // its fence lives would be told the wrong thing.
    workerDir: workspace,
    claudeOrgPath,
    // Required by `FenceContext`, not optional: a fence whose hook command does
    // not name an existing file refuses to render with `hook-unresolvable`, so
    // there is no useful "unset" state for this field to have.
    hookScript,
    fencePath,
    // Always passed now, rather than only when the caller supplied one: the
    // default `FenceContext` would otherwise reach for is `process.execPath`,
    // which is the same value `python` already holds -- and passing it makes
    // the interpreter the fence renders identical to the one warded above.
    python,
  });

  const spawner = new FencedSpawner({
    ledger: new FenceLedger(fenceLedgerPath),
    settingsName: DEFAULT_SETTINGS_NAME,
    // Asked of the worktree that was just created, not of the repository it was
    // created from, and asked here rather than computed from the layout: the
    // answer is where *this* checkout's git writes land, and only git knows it
    // (D-0082). A worktree's `.git` is a file pointing outside itself, so
    // without this the fence would claim a writable surface that stops at the
    // checkout while `git add` writes past it.
    sandboxWritableRoots: gitMetadataRoots({ ...git, cwd: workspace }),
    // The child this workspace is materialised for is a `claude -p` session --
    // `LapRunIntent` carries a prompt and the provider renders `--print`, and
    // there is no path through this step that produces an interactive one. So
    // the fence is rendered for a spawn with nobody at its prompt (`D-0081`).
    nonInteractive: true,
  });
  const admission = spawner.prepare(role, context);
  if (!admission.admitted || admission.plan === null) {
    // The fail-closed direction, and the reason this step goes through
    // `prepare` rather than calling `renderFence` / `writeFence` itself: a
    // refused fence publishes nothing, and there is nothing here to undo.
    throw new WorkspaceMaterializationRefused(
      `the fence for role ${pythonRepr(role)} was refused, so no workspace was ` +
        `materialised: ${admission.reasons.map(([code, detail]) => `${code} (${detail})`).join("; ")}`,
    );
  }
  const plan = admission.plan;

  // -- 5. the MCP configuration ---------------------------------------------
  // Already rendered and validated during validation above; this only writes it.
  publishJsonArtifact(mcpConfigPath, mcp.document);

  const artifacts: readonly MaterializedArtifact[] = Object.freeze([
    Object.freeze({ kind: "fence", path: plan.fencePath }),
    Object.freeze({ kind: "settings", path: plan.settingsPath }),
    Object.freeze({ kind: "mcp-config", path: mcpConfigPath }),
  ]);

  // -- 6. the sweep that makes step 7 one-way -------------------------------
  // The worktree first, because it is the artifact the event's central claim is
  // about and the one nothing else here would notice the loss of. A concurrent
  // cleanup between `git worktree add` and this point -- another operator's
  // sweep of "artifacts with no event", which this step's own ordering invites
  // people to run -- would leave the three files intact and the checkout gone,
  // and the event would record a workspace that is not there. Asked of git
  // rather than of `existsSync`, because "the directory exists" is also true of
  // the bare directory the provider would have made, and it is a *checkout*
  // this event claims.
  let checkedOutRoot: string;
  try {
    checkedOutRoot = repositoryRoot({ ...git, cwd: workspace });
  } catch (error) {
    throw new WorkspaceMaterializationRefused(
      `refusing to record a materialisation whose workspace at ${pythonRepr(workspace)} ` +
        "is no longer a git worktree",
      { cause: error },
    );
  }
  if (!sameExistingPath(checkedOutRoot, workspace)) {
    throw new WorkspaceMaterializationRefused(
      `refusing to record a materialisation whose workspace at ${pythonRepr(workspace)} ` +
        `is now inside ${pythonRepr(checkedOutRoot)} rather than being that worktree's ` +
        "own root; something has replaced it since it was created",
    );
  }

  // Every artifact is stat'd again, immediately before the append. This is not
  // belt and braces over the writes above: it is the enforcement of `D-0057`.
  // The event is a durable claim that a manifest exists, and the only way to
  // make that claim true rather than hopeful is to have looked, here, with
  // nothing in between.
  for (const artifact of artifacts) {
    let isFile = false;
    try {
      isFile = statSync(artifact.path).isFile();
    } catch (error) {
      throw new WorkspaceMaterializationRefused(
        `refusing to record a materialisation whose ${artifact.kind} artifact at ` +
          `${pythonRepr(artifact.path)} cannot be read back`,
        { cause: error },
      );
    }
    if (!isFile) {
      throw new WorkspaceMaterializationRefused(
        `refusing to record a materialisation whose ${artifact.kind} artifact at ` +
          `${pythonRepr(artifact.path)} is not a file`,
      );
    }
  }

  // -- 7. the event, last ---------------------------------------------------
  const factId = `${WORKSPACE_MATERIALIZED_EVENT_TYPE}/${runId}`;
  const appended = appendEvent(connection, {
    eventId: factId,
    eventType: WORKSPACE_MATERIALIZED_EVENT_TYPE,
    // The closed `subject_kind` vocabulary has no `workspace`. `run` is right
    // rather than merely available: a workspace has no identity of its own in
    // this schema, and the thing this fact is about is the run it was built
    // for.
    subjectKind: "run",
    subjectId: runId,
    dedupKey: factId,
    producer: WORKSPACE_MATERIALIZER_PRODUCER,
    // The source clock and ours are the same instant here, as in `admitRun`:
    // for a materialisation *we* are the source, and the fact is the work this
    // call just did rather than something a provider reported to us.
    occurredAtMs: nowMs,
    ingestedAtMs: nowMs,
    runId,
    payload: pythonJsonDocumentSorted({
      artifact_dir: artifactDir,
      artifacts: artifacts.map((artifact) => ({ kind: artifact.kind, path: artifact.path })),
      base_branch: baseBranch,
      base_commit: baseCommit,
      permission_mode: plan.fence.permissionMode,
      repository: repositoryRootPath,
      role,
      topic_branch: topicBranch,
      workspace,
    }),
  });

  if (appended.seq === null) {
    // The spine already held this fact, which means a previous materialisation
    // of this run reached step 7. It cannot be an idempotent retry: the worktree
    // and the branch were created above, so this call has already changed the
    // world in ways the earlier event does not describe. Refusing is what keeps
    // the event a statement about one materialisation rather than about
    // whichever one happened to append first.
    throw new WorkspaceMaterializationRefused(
      `the spine already holds ${factId} as event ${appended.eventId}; run ${runId} ` +
        "has been materialised before, and a second materialisation is a mistake " +
        "rather than a retry",
    );
  }

  const settings: Readonly<Record<string, unknown>> = Object.freeze({
    prompt: request.prompt,
    // The admitted run's own arguments first, then the fence's flags, then the
    // configuration that makes the worker able to poll. `plan.cliArgs()` is
    // `--settings <path> --permission-mode <mode> --setting-sources ''`
    // (`D-0010`, and the last of the three `D-0081`); `--mcp-config` is what
    // `D-0058` adds, and `--strict-mcp-config` beside it is `D-0081`'s other
    // half: without it the rendered MCP document is one more server list among
    // the target repository's own, rather than the only one.
    //
    // **The order is the fail-closed direction, and it is the second line of
    // defence rather than the first.** The flags this step generates are the
    // fence, and an operator argument repeating one of them must not win --
    // where a parser resolves a repeated option last-wins, putting the
    // generated flags last is what makes the fence the survivor. The first line
    // is `requireFenceOwnedFlagsAbsent` above, which refuses such an argument
    // outright, because "which occurrence wins" is a property of a CLI this
    // repository does not own and must not be the only thing a fence rests on.
    cli_args: Object.freeze([
      ...cliArgs,
      ...plan.cliArgs(),
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
    ]),
  });

  return new MaterializedWorkspace(MATERIALIZATION_MINT, {
    runId,
    holder,
    role,
    repository: repositoryRootPath,
    baseBranch,
    baseCommit,
    topicBranch,
    workspace,
    artifactDir,
    artifacts,
    plan,
    admission,
    spawner,
    eventId: appended.eventId,
    eventSeq: appended.seq,
    options: Object.freeze({
      runId,
      holder,
      workspace,
      role,
      // The validated local, closed over -- not a read of `request.nowMs` on
      // each call. `readonly` is a compile-time claim and freezes nothing, so a
      // caller mutating the request afterwards would make the orchestrator's
      // clock disagree with the instant this step recorded on the spine.
      nowMs: () => nowMs,
      sessionUuidFactory: request.sessionUuidFactory,
      settings,
    }),
  });
}

/**
 * Is `candidate` the same path as `root`, or underneath it?
 *
 * Both arguments have already been through `resolve`, which is what makes a
 * lexical comparison sound here: `..` is gone, separators are the platform's,
 * and a trailing one has been dropped. Comparing raw input would answer `false`
 * for `/a/other/../worktree/.continuo` against `/a/worktree` while `join` put
 * the fence inside the worktree regardless -- the guard reporting safe for the
 * exact case it exists to catch.
 *
 * The comparison is case-folded on Windows, following `D-0216`: an NTFS volume
 * resolves `C:\\Work\\tree` and `C:\\work\\TREE` to one directory, so a
 * case-sensitive comparison there is the same hole in a different spelling.
 *
 * It is deliberately NOT a symlink-resolving check. Neither path exists yet
 * when this runs, `realpathSync` throws on a missing path, and a guard that has
 * to create directories to decide is a guard with side effects. A caller
 * determined to defeat it with a symlink can; the layout mistake a caller
 * actually makes -- `join(workspace, ".continuo")`, with or without a `..` in
 * front of it -- is caught, which is what it is for.
 */
export function isInside(candidate: string, root: string): boolean {
  const foldedRoot = pathIdentity(root);
  const foldedCandidate = pathIdentity(candidate);
  const rootWithSeparator = foldedRoot.endsWith(sep) ? foldedRoot : `${foldedRoot}${sep}`;
  return foldedCandidate === foldedRoot || foldedCandidate.startsWith(rootWithSeparator);
}

/**
 * Which database the worker's endpoint is pointed at, bound to the one this
 * materialisation writes to.
 *
 * The event goes onto `connection`; the worker polls whatever `mcp.json` names.
 * If those differ, every check in this module passes, the endpoint starts
 * cleanly, and the worker waits forever on a queue its messages are not in --
 * the failure mode that looks most like working, and the one `D-0058`'s whole
 * purpose ("a worker that can both work and poll") rules out.
 *
 * So the default is derivation, not validation: with no override the endpoint is
 * pointed at the connection's own file and the question cannot be got wrong. An
 * override exists because a worker can legitimately reach one file by another
 * name -- a symlink, a bind mount -- and it is checked rather than trusted.
 *
 * The check is {@link namesTheSameDatabase}: the same spelling, or the same
 * canonical path after symlinks. **Not file identity** -- see that function for
 * why `(device, inode)` equality is the wrong test for a database on a rollback
 * journal. It cannot see across a container boundary and does not pretend to:
 * an operator who needs that is outside what lap 1's one-process-per-worker
 * shape describes, and should be told so by a refusal rather than by a silent
 * mismatch.
 *
 * @throws {WorkspaceMaterializationUsageError} for an override naming another
 *   database, or for a connection with no file behind it at all.
 */
function endpointDatabasePath(connection: SqliteDatabase, binding: EndpointBinding): string {
  const connectionPath = mainDatabasePath(connection);
  if (connectionPath === "" || connectionPath === ":memory:") {
    // An in-memory control plane has no path a separate process could open, so
    // there is nothing to point the endpoint at. Refusing beats writing
    // `":memory:"` into an `mcp.json`, which the endpoint would open as a fresh
    // empty database and then refuse for being behind head -- a confusing
    // report about migrations for a mistake about which database this is.
    throw new WorkspaceMaterializationUsageError(
      `the control plane this materialisation writes to has no file behind it ` +
        `(${pythonRepr(connectionPath)}), so the worker's endpoint cannot be pointed at it; ` +
        "materialise against a production control plane on disk",
    );
  }
  // Already absolute: SQLite resolved it at open time. `resolve` is kept for
  // separator normalisation only, and is a no-op on the value's leading form.
  const derived = resolve(connectionPath);
  if (binding.databasePath === undefined) {
    return derived;
  }
  const override = resolve(requireAbsolute("endpoint.database_path", binding.databasePath));
  if (!namesTheSameDatabase(override, derived)) {
    throw new WorkspaceMaterializationUsageError(
      `endpoint.database_path ${pythonRepr(override)} is not the control plane this ` +
        `materialisation writes to (${pythonRepr(derived)}); the event would be recorded in ` +
        "one database and the worker configured to poll another, so the worker would " +
        "start cleanly and never see this run's messages",
    );
  }
  return override;
}

/**
 * The file SQLite has open as `main`, as SQLite itself resolved it.
 *
 * **Not `connection.name`**, which is the string the caller passed to the
 * driver, verbatim. A connection opened with a relative filename keeps that
 * relative string forever, so a process that changed directory between opening
 * the database and materialising would resolve it against the *new* working
 * directory -- and write into the worker's configuration a path naming a
 * different database, or none at all. The whole point of deriving this value
 * from the live connection is that it cannot be got wrong, so it has to come
 * from the connection rather than from a string beside it.
 *
 * `PRAGMA database_list` reports one row per attached database, `main` among
 * them; its `file` column is SQLite's own absolute resolution, and is empty for
 * a temporary or in-memory database -- which the caller treats as "no file
 * behind it", the same answer `":memory:"` gets.
 */
function mainDatabasePath(connection: SqliteDatabase): string {
  const rows = connection.prepare("PRAGMA database_list").all() as {
    readonly name: string;
    readonly file: string | null;
  }[];
  const main = rows.find((row) => row.name === "main");
  return main?.file ?? "";
}

/**
 * Do these two paths name one **safely interchangeable** control plane?
 *
 * The same spelling, or the same canonical path after symlinks. Nothing else --
 * and the "nothing else" is the load-bearing part, because an earlier revision
 * accepted `(device, inode)` equality here and that was wrong for this
 * database in particular.
 *
 * **Why file identity is not enough for a SQLite database.** This control plane
 * runs on a rollback journal, not WAL, and deliberately so: `connection.ts`
 * records why `journal_mode = WAL` is refused. SQLite derives the journal's
 * pathname from the *spelling the database was opened with* -- `<path>-journal`
 * -- so two hard links to one database file are two databases as far as
 * recovery is concerned: each process writes its own journal, and after a crash
 * one path cannot see the other's hot journal. The bytes are shared and the
 * recovery is not, which is worse than two separate databases because it looks
 * like one.
 *
 * A **directory-level** alias -- a bind-mounted directory -- does not have that
 * problem, because the sidecar is derived beside the database inside the same
 * mounted directory and both spellings reach the same journal file. It is
 * nonetheless not accepted here: distinguishing it from a same-directory hard
 * link means comparing basenames and parent-directory identity, a rule this
 * suite cannot exercise without root, and an untested rule guarding a
 * crash-recovery property is worth less than a refusal an operator can read.
 *
 * So the override covers a **symlink** and nothing more, and an operator whose
 * worker reaches the database another way is told so by a refusal rather than
 * discovering it after a crash.
 */
function namesTheSameDatabase(left: string, right: string): boolean {
  // Through {@link sameExistingPath}, so the 8.3-short-name and symlink cases
  // are one rule here and at the worktree sweep rather than two that can drift.
  return sameExistingPath(left, right);
}

/**
 * Do these two paths name the same existing file or directory?
 *
 * `resolve` alone is not this question, and Windows CI is where that stopped
 * being theoretical. `TMPDIR` on a GitHub runner is an **8.3 short path**
 * (`C:\\Users\\RUNNER~1\\...`) while git reports the long form
 * (`C:/Users/runneradmin/...`); `resolve` normalises the separators and leaves
 * `RUNNER~1` alone, so two spellings of one directory compared unequal and the
 * final sweep refused a workspace that *was* the worktree's own root -- after
 * the worktree and every artifact had been created. A false refusal at the last
 * step is the worst place for one.
 *
 * `realpathSync.native` is the fix rather than `realpathSync`: only the native
 * form expands a short name to its long one. It also resolves symlinks, which
 * is wanted for the same reason on every platform -- a workspace reached
 * through a symlinked parent is one directory with two spellings too, and that
 * is reachable on Linux where the 8.3 case is not.
 *
 * Falls back to the lexical answer when either side cannot be resolved: this is
 * asked of paths that are supposed to exist, so a failure to resolve is itself
 * a reason to say no rather than to guess yes.
 */
function sameExistingPath(left: string, right: string): boolean {
  if (pathIdentity(resolve(left)) === pathIdentity(resolve(right))) {
    return true;
  }
  try {
    return pathIdentity(realpathSync.native(left)) === pathIdentity(realpathSync.native(right));
  } catch {
    return false;
  }
}

/**
 * The form two paths must share to be the same file, as far as this module can
 * tell without touching the disk.
 *
 * One function, used by every path comparison here, because having two was the
 * bug: containment folded case on Windows and distinctness did not, so on an
 * NTFS volume a fence ledger at `FENCE.JSON` and a fence at `fence.json` read as
 * two artifacts -- the ledger's appends would overwrite the published fence,
 * every `stat` would still succeed, and the materialisation would be recorded as
 * complete.
 *
 * Case-folding is the right approximation on Windows and the wrong one on
 * POSIX, where two spellings differing in case are two files. `D-0216` takes the
 * same position for the same reason.
 */
function pathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
