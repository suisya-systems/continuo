import type { Database as SqliteDatabase } from "better-sqlite3";
import { isConstraintError } from "../sqlite/errors.js";
import type { AppendedEvent } from "./events.js";
import { appendEvent } from "./events.js";
import { pythonJsonDocumentSorted } from "./python_json.js";
import { pythonRepr, pythonTuple } from "./python_repr.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { transaction } from "./txn.js";

/**
 * G3 -- repository identity, the pull-request projection, and the run<->PR linkage.
 *
 * `docs/production-schema.md` sections 7.1-7.4 and `D-0034`. The whole
 * module is written against one dated incident: on 2026-08-06 v1's run->PR
 * tools defaulted an omitted `--repo` to `gh repo view` -- the cwd
 * repository, always the home repo for the Secretary -- so a cross-repo
 * run's PR number was resolved against the wrong repository, and renga PR
 * #302 was recorded with claude-org-ja PR #302's branch, commit and merge
 * time. **The tool exited ok.** Whether it corrupted silently or failed
 * loudly depended only on whether the home repo happened to own that
 * number.
 *
 * Three consequences shape this surface:
 *
 * - **There is no working-directory fallback, and no parameter that could
 *   become one.** {@link resolveRepository} takes a provider id and/or a
 *   slug and nothing else; it has no `cwd`, no `defaultRepo`, no
 *   `orCurrent`. The absence is the design -- a later reader cannot
 *   reintroduce the incident by passing an argument, only by editing this
 *   signature. When resolution fails it throws {@link RepoResolutionError},
 *   which is v1's own answer, kept for v1's own reason: "so the caller can
 *   exit non-zero instead of writing a foreign repo's PR onto the run".
 * - **Identity is `repoId`, never a URL string and never the slug.**
 *   `owner` and `name` are mutable -- a GitHub rename or transfer preserves
 *   the repository -- so {@link upsertRepository} absorbs a rename onto the
 *   *existing* row whenever the immutable `providerRepoId` matches, and
 *   every historical observation stays attached to the same `repoId`. The
 *   columns keep their case because the value is handed to `gh --repo` and
 *   recorded in payloads; only the unique index folds it.
 * - **An observation of a pull request is an event first and a projection
 *   second.** {@link observePullRequest} appends to the spine through
 *   {@link appendEvent} and writes the `pull_request` row as that append's
 *   typed side effect, so the projection and the fact it came from commit
 *   together or not at all. `headEventSeq` is what makes a head move
 *   auditable: the section 6.3 verdict projection selects CI evidence by
 *   `headSha`, so the event that moved the head has to be identifiable, not
 *   merely timestamped.
 *
 * **A reopen is a projection of a provider event, not an edit.**
 * `closed -> open` is admitted (only `merged` is terminal), and section 7.2
 * says what admitting it costs if done by halves: section 8.2 retires a
 * `watcher_scope` when its PR goes terminal, so a reopen that clears
 * `closedAtMs` without clearing `watcher_scope.retired_at_ms` leaves the PR
 * watched in name only. Both happen in the one append transaction here.
 *
 * **The provider's order guards the state as well as the head.** The
 * `pull_request_head_is_monotonic` trigger fires on the head columns only,
 * so an observation whose head stood still passes it untouched however late
 * it is. {@link planTransition} therefore refuses any transition,
 * head-moving or not, whose `observedAtMs` does not advance past
 * `headObservedAtMs` -- which is the instant of the newest observation
 * projected onto the row, since every transition writes the `max` of it.
 * Without that, `close -> reopen -> close` lets a delayed poll from the
 * intervening open period land as a second reopen, rewinding the state and
 * un-retiring the watcher scope section 8.2 had retired.
 *
 * **A no-change observation appends nothing.** Re-polling a PR whose head
 * and state are unchanged is not a new fact, and section 7.2 allows
 * refreshing the observation timestamp and no more. Spending an event row
 * on it would put one row per poll interval per PR on the spine -- and the
 * trace that *does* need to record "polled, nothing changed" already exists
 * and is not this table: `watcher_liveness.last_result =
 * 'observed_no_change'` (section 8.3).
 *
 * Time is the caller's everywhere, as integer epoch milliseconds; nothing
 * in this module reads a clock, and no column it writes has a `DEFAULT`.
 */

/**
 * How a repository was resolved, as `run_pr_link.resolution` CHECKs it. The
 * set is closed and the absence of a cwd-default member is the 2026-08-06
 * incident encoded: there is no value this column can hold that means "we
 * guessed from the working directory".
 */
export const RESOLUTIONS: readonly string[] = Object.freeze([
  "project_registry",
  "explicit_operator",
  "provider_event",
]);

/**
 * `run_pr_link.role`. Only the `primary` link drives a run's completion
 * transition, and at most one is live per run at a time.
 */
export const ROLES: readonly string[] = Object.freeze(["primary", "supporting"]);

/** `pull_request.state`. Only `merged` is terminal. */
export const PR_STATES: readonly string[] = Object.freeze(["open", "merged", "closed"]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PROVIDER = "github";

/**
 * A repository could not be resolved, and nothing was defaulted.
 *
 * v1 raises this "so the caller can exit non-zero instead of writing a
 * foreign repo's PR onto the run", and that sentence is the whole reason
 * this class exists rather than a `null` return: a caller that forgets to
 * check a `null` writes the foreign repo's PR, which is exactly what
 * happened on 2026-08-06.
 */
export class RepoResolutionError extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RepoResolutionError";
    Object.setPrototypeOf(this, RepoResolutionError.prototype);
  }
}

/**
 * An observation was not a projectable state of a pull request.
 *
 * The `pull_request` CHECKs tie `state` to `merged_at_ms`,
 * `merge_commit_sha` and `closed_at_ms` as biconditionals. Reaching them as
 * a raw driver error would tell the caller that *some* constraint failed;
 * this says which fact was missing from the observation.
 */
export class PullRequestObservationRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PullRequestObservationRefused";
    Object.setPrototypeOf(this, PullRequestObservationRefused.prototype);
  }
}

/**
 * The projection moved between reading it and writing the append.
 *
 * {@link observePullRequest} has to know the prior state before it can
 * name the event (a merge and a head move are different facts), and that
 * read happens before {@link appendEvent} opens its transaction. The read
 * is therefore re-taken inside the transaction and compared; a disagreement
 * aborts the append rather than filing an event whose type was chosen
 * against a state that no longer exists.
 */
export class StalePullRequestObservation extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StalePullRequestObservation";
    Object.setPrototypeOf(this, StalePullRequestObservation.prototype);
  }
}

/**
 * A run<->PR link was refused, and no link was written.
 *
 * Covers the second live `primary` for one run, an unlink of a link that is
 * not live, and a re-link of a `(runId, prId)` pair the history already
 * holds. Each is a caller error whose correct answer is to stop, not to
 * overwrite a row that records what was believed earlier.
 */
export class RunPrLinkRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunPrLinkRefused";
    Object.setPrototypeOf(this, RunPrLinkRefused.prototype);
  }
}

/**
 * What one call to {@link observePullRequest} did.
 *
 * {@link ObservedPullRequest.event} is `null` exactly when
 * {@link ObservedPullRequest.changed} is false -- the no-change re-poll,
 * which appends nothing. When the append was a duplicate
 * (`event.duplicate`) the whole transaction was abandoned, so the
 * projection fields describe what *would* have changed and the database
 * was not touched.
 */
export interface ObservedPullRequest {
  readonly prId: string;
  readonly changed: boolean;
  readonly created: boolean;
  readonly headMoved: boolean;
  readonly reopened: boolean;
  readonly eventType: string | null;
  readonly event: AppendedEvent | null;
  readonly reactivatedScopes: readonly string[];
}

// --------------------------------------------------------------------------
// repository identity
// --------------------------------------------------------------------------

interface RepositoryRow {
  readonly repo_id: string;
  readonly provider: string;
  readonly provider_repo_id: string | null;
  readonly owner: string;
  readonly name: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

/**
 * Record a repository, absorbing a rename or transfer onto the existing row.
 *
 * Returns the `repoId` the repository actually has, which is *not*
 * necessarily the one passed: when `providerRepoId` matches a row already
 * present, that row is the repository, and its identity wins. Absorbing
 * rather than inserting is what keeps every historical `pull_request`,
 * `ci_observation` and `watcher_scope` attached across a rename; the
 * alternative -- a new row for the new slug -- forks the identity silently
 * and leaves the metrics join to guess, which is the defect `D-0034` names
 * in v1's stored `pr_url`.
 *
 * Case is preserved in `owner`/`name` and folded only in the lookup index,
 * because the value is handed to `gh --repo` and recorded in payloads.
 *
 * @throws {RepoResolutionError} if `repoId` already names a different
 *   repository, or if the rename would collide with another row's slug.
 *   Both mean two identities are being merged by accident, and a wrong
 *   merge here is indistinguishable downstream from the 2026-08-06
 *   incident.
 */
export function upsertRepository(
  connection: SqliteDatabase,
  options: {
    readonly repoId: string;
    readonly owner: string;
    readonly name: string;
    readonly nowMs: number;
    readonly providerRepoId?: string | null;
    readonly provider?: string;
  },
): string {
  const { repoId, owner, name, nowMs, providerRepoId = null, provider = PROVIDER } = options;

  requireEpochMs({ now_ms: nowMs });
  requireText({ repo_id: repoId, owner, name });
  if (providerRepoId !== null && providerRepoId === "") {
    throw new RepoResolutionError("provider_repo_id, when given, must be a non-empty string");
  }

  return transaction(connection, (tx) => {
    let existing: RepositoryRow | undefined;
    if (providerRepoId !== null) {
      existing = one<RepositoryRow>(
        tx,
        "SELECT * FROM repository WHERE provider = ? AND provider_repo_id = ?",
        [provider, providerRepoId],
      );
    }
    if (existing === undefined) {
      existing = one<RepositoryRow>(
        tx,
        "SELECT * FROM repository" +
          " WHERE provider = ? AND lower(owner) = lower(?) AND lower(name) = lower(?)",
        [provider, owner, name],
      );
    }

    if (existing === undefined) {
      const claimed = one<{ provider: string; owner: string; name: string }>(
        tx,
        "SELECT provider, owner, name FROM repository WHERE repo_id = ?",
        [repoId],
      );
      if (claimed !== undefined) {
        throw new RepoResolutionError(
          `repo_id ${pythonRepr(repoId)} already names ${claimed.owner}/${claimed.name}; a ` +
            "repository identity is never reassigned, because every observation ever " +
            "attached to it would move too",
        );
      }
      tx.prepare<[string, string, string | null, string, string, number, number]>(
        "INSERT INTO repository (repo_id, provider, provider_repo_id, owner, name," +
          " created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(repoId, provider, providerRepoId, owner, name, nowMs, nowMs);
      return repoId;
    }

    const resolvedId = existing.repo_id;
    // provider_repo_id is learned once and never rewritten: a row whose
    // immutable id changed is two repositories, not a rename.
    if (
      providerRepoId !== null &&
      existing.provider_repo_id !== null &&
      existing.provider_repo_id !== providerRepoId
    ) {
      throw new RepoResolutionError(
        `${owner}/${name} is already recorded as ${resolvedId} with provider id ` +
          `${pythonRepr(existing.provider_repo_id)}; a slug that moves to a different immutable ` +
          "id is a different repository reusing the name, not a rename",
      );
    }
    const mergedProviderRepoId =
      providerRepoId === null ? existing.provider_repo_id : providerRepoId;
    try {
      tx.prepare<[string, string, string | null, number, string]>(
        "UPDATE repository SET owner = ?, name = ?, provider_repo_id = ?," +
          " updated_at_ms = ? WHERE repo_id = ?",
      ).run(owner, name, mergedProviderRepoId, Math.max(nowMs, existing.updated_at_ms), resolvedId);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new RepoResolutionError(
          `${owner}/${name} is already held by another repository row; renaming ${resolvedId} ` +
            `onto it would merge two identities (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      throw error;
    }
    return resolvedId;
  });
}

/**
 * Resolve a repository to its `repoId`, or refuse.
 *
 * The immutable `providerRepoId` is tried first and the slug second,
 * case-insensitively, because the slug is a lookup key and the provider id
 * is the identity. **There is no third fallback**, and deliberately no
 * parameter that could grow into one: the 2026-08-06 incident was a
 * defaulted `--repo`, so the safety here is the absence of the argument,
 * not a check on its value.
 *
 * @throws {RepoResolutionError} if no identifier was supplied, if only half
 *   a slug was supplied, or if nothing matched. A caller that cannot name
 *   the repository must exit non-zero.
 */
export function resolveRepository(
  connection: SqliteDatabase,
  options: {
    readonly owner?: string | null;
    readonly name?: string | null;
    readonly providerRepoId?: string | null;
    readonly provider?: string;
  } = {},
): string {
  const { owner = null, name = null, providerRepoId = null, provider = PROVIDER } = options;

  if (providerRepoId !== null) {
    const row = one<{ repo_id: string }>(
      connection,
      "SELECT repo_id FROM repository WHERE provider = ? AND provider_repo_id = ?",
      [provider, providerRepoId],
    );
    if (row !== undefined) {
      return row.repo_id;
    }
  }

  if ((owner === null) !== (name === null)) {
    throw new RepoResolutionError(
      "a slug lookup needs both owner and name; half a slug is not a repository",
    );
  }
  if (owner !== null && name !== null) {
    const row = one<{ repo_id: string }>(
      connection,
      "SELECT repo_id FROM repository" +
        " WHERE provider = ? AND lower(owner) = lower(?) AND lower(name) = lower(?)",
      [provider, owner, name],
    );
    if (row !== undefined) {
      return row.repo_id;
    }
  }

  if (providerRepoId === null && owner === null && name === null) {
    throw new RepoResolutionError(
      "a repository is resolved by provider id or by owner/name and by nothing else; there " +
        "is no working-directory default (2026-08-06)",
    );
  }
  const wanted = providerRepoId !== null ? providerRepoId : `${owner}/${name}`;
  throw new RepoResolutionError(
    `no repository matches ${pythonRepr(wanted)}; refusing to default, because the caller ` +
      "exiting non-zero is the only alternative to writing a foreign repository's PR onto the run",
  );
}

// --------------------------------------------------------------------------
// the pull-request projection
// --------------------------------------------------------------------------

interface PullRequestRow {
  readonly pr_id: string;
  readonly repo_id: string;
  readonly pr_number: number;
  readonly provider_pr_id: string | null;
  readonly head_sha: string;
  readonly head_observed_at_ms: number;
  readonly head_event_seq: number;
  readonly state: string;
  readonly merge_commit_sha: string | null;
  readonly merged_at_ms: number | null;
  readonly closed_at_ms: number | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

/**
 * Project one provider observation of a pull request, as an event.
 *
 * The event is appended through {@link appendEvent} and the `pull_request`
 * row is written inside that append's transaction, so the projection
 * cannot exist without the fact that produced it and `headEventSeq` names
 * the event that moved the head.
 *
 * Which event the observation *is* comes from the transition, most
 * consequential first: a merge is `pr_merged`, a close is `pr_closed`, a
 * `closed -> open` is `pr_reopened`, and a head that moved with no state
 * change is `pr_head_updated`. The first observation of a PR is
 * `pr_head_updated` when it arrives open: the implementation's vocabulary
 * has no `pr_opened`, and the fact that matters downstream -- section 6.3
 * selects CI evidence by `headSha` -- is that this head is now the head.
 *
 * `observedAtMs` is the **provider's** clock for the observed state and
 * `ingestedAtMs` is ours; section 5.2 keeps them apart because a
 * provider's skew would otherwise read as a relay gap. The default
 * `dedupKey` is built from the provider's own timestamp for the fact, so a
 * re-poll of an unchanged provider state is the same key and a genuine
 * second transition -- including a force-push back to a previously seen
 * `headSha` -- is a different one.
 *
 * An observation that changes neither head nor state writes nothing and
 * returns `changed=false`; "polled, nothing changed" is
 * `watcher_liveness`'s distinction to record, not the spine's.
 *
 * @throws {PullRequestObservationRefused} for a state whose accompanying
 *   facts are missing or contradictory (a merge with no `mergeCommitSha`,
 *   an open PR carrying `closedAtMs`, a non-lowercase or non-40-character
 *   `headSha`), and for a transition the provider's own order does not
 *   support -- a head move or, on an unchanged head, a state change whose
 *   `observedAtMs` does not advance past the newest observation already
 *   projected onto the row.
 * @throws {StalePullRequestObservation} if the projection changed between
 *   the transition being named and the transaction that writes it.
 */
export function observePullRequest(
  connection: SqliteDatabase,
  options: {
    readonly repoId: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly state: string;
    readonly observedAtMs: number;
    readonly ingestedAtMs: number;
    readonly eventId: string;
    readonly producer: string;
    readonly producerEpoch?: number | null;
    readonly providerPrId?: string | null;
    readonly mergeCommitSha?: string | null;
    readonly mergedAtMs?: number | null;
    readonly closedAtMs?: number | null;
    readonly runId?: string | null;
    readonly dedupKey?: string | null;
    readonly payload?: Readonly<Record<string, unknown>> | null;
  },
): ObservedPullRequest {
  const {
    repoId,
    prNumber,
    headSha,
    state,
    observedAtMs,
    ingestedAtMs,
    eventId,
    producer,
    producerEpoch = null,
    providerPrId = null,
    mergeCommitSha = null,
    mergedAtMs = null,
    closedAtMs = null,
    runId = null,
    dedupKey = null,
    payload = null,
  } = options;

  requireEpochMs({ observed_at_ms: observedAtMs, ingested_at_ms: ingestedAtMs });
  requireText({ repo_id: repoId, event_id: eventId, producer });
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new PullRequestObservationRefused(
      `pr_number must be a positive integer, got ${pythonRepr(prNumber)}`,
    );
  }
  if (!isFullLowercaseSha(headSha)) {
    throw new PullRequestObservationRefused(
      `head_sha must be 40 lowercase hex characters, got ${pythonRepr(headSha)}`,
    );
  }
  requireStateFacts({ state, mergeCommitSha, mergedAtMs, closedAtMs });

  const prId = `${repoId}#${prNumber}`;
  const before = readPullRequest(connection, { repoId, prNumber });
  const plan = planTransition({ before, headSha, state, observedAtMs });
  if (plan === null) {
    return Object.freeze({
      prId,
      changed: false,
      created: false,
      headMoved: false,
      reopened: false,
      eventType: null,
      event: null,
      reactivatedScopes: Object.freeze([]),
    });
  }
  const { eventType, headMoved, reopened, created } = plan;

  const factAtMs =
    eventType === "pr_merged" ? mergedAtMs : eventType === "pr_closed" ? closedAtMs : observedAtMs;
  // `??` only falls back for null/undefined; Python's `dedup_key or <default>`
  // is a truthiness test, so an EMPTY dedup key takes the default there and
  // would be passed straight through here -- and an empty dedup key is the one
  // value that makes every fact collide with every other.
  const key =
    dedupKey === undefined || dedupKey === null || dedupKey === ""
      ? `${eventType}/${repoId}/${prNumber}/${headSha}/${String(factAtMs)}`
      : dedupKey;

  const body: Record<string, unknown> = {
    repo_id: repoId,
    pr_number: prNumber,
    pr_id: prId,
    head_sha: headSha,
    state,
    previous_state: before === undefined ? null : before.state,
    previous_head_sha: before === undefined ? null : before.head_sha,
    merge_commit_sha: mergeCommitSha,
    merged_at_ms: mergedAtMs,
    closed_at_ms: closedAtMs,
  };
  if (payload !== null) {
    Object.assign(body, payload);
  }

  const reactivated: string[] = [];

  const appended = appendEvent(connection, {
    eventId,
    eventType,
    subjectKind: "pull_request",
    subjectId: prId,
    dedupKey: key,
    producer,
    occurredAtMs: observedAtMs,
    ingestedAtMs,
    runId,
    producerEpoch,
    payload: pythonJsonDocumentSorted(body),
    sideEffect: (tx, seq) => {
      writeProjection(tx, {
        seq,
        expected: before,
        prId,
        repoId,
        prNumber,
        providerPrId,
        headSha,
        state,
        observedAtMs,
        ingestedAtMs,
        mergeCommitSha,
        mergedAtMs,
        closedAtMs,
        reopened,
        reactivated,
      });
    },
  });
  if (appended.duplicate) {
    // The transaction was abandoned, so nothing the side effect collected
    // describes the database any more.
    reactivated.length = 0;
  }
  return Object.freeze({
    prId,
    changed: !appended.duplicate,
    created: created && !appended.duplicate,
    headMoved: headMoved && !appended.duplicate,
    reopened: reopened && !appended.duplicate,
    eventType,
    event: appended,
    reactivatedScopes: Object.freeze([...reactivated]),
  });
}

// --------------------------------------------------------------------------
// run <-> PR linkage
// --------------------------------------------------------------------------

/**
 * Link a run to a pull request, naming how the repository was resolved.
 *
 * The linkage is many-to-many on purpose (`D-0034`): a run may hold several
 * PRs across repositories, and a PR may be touched by several runs. What
 * makes completion unambiguous despite both is that at most one `primary`
 * link per run is live at a time -- so a re-point is an
 * {@link unlinkRunPr} with a recorded reason followed by a link to another
 * PR, and both rows survive as the history of the re-point.
 *
 * `resolution` is checked here as well as in the DDL, because the value
 * that matters is the one that is *absent*: a caller reaching for a
 * working-directory guess finds no member to name it, and gets this
 * refusal rather than a raw constraint error two layers down.
 *
 * @throws {RunPrLinkRefused} for an unknown role or resolution, a second
 *   live primary, an unknown run or PR, or a pair the table already holds.
 */
export function linkRunPr(
  connection: SqliteDatabase,
  options: {
    readonly runId: string;
    readonly prId: string;
    readonly role: string;
    readonly resolution: string;
    readonly linkedAtMs: number;
  },
): void {
  const { runId, prId, role, resolution, linkedAtMs } = options;

  requireEpochMs({ linked_at_ms: linkedAtMs });
  requireText({ run_id: runId, pr_id: prId });
  if (!ROLES.includes(role)) {
    throw new RunPrLinkRefused(
      `role must be one of ${pythonTuple(ROLES)}, got ${pythonRepr(role)}`,
    );
  }
  if (!RESOLUTIONS.includes(resolution)) {
    throw new RunPrLinkRefused(
      `resolution must be one of ${pythonTuple(RESOLUTIONS)}, got ${pythonRepr(resolution)}; there is ` +
        "no member meaning 'we guessed from the working directory' (2026-08-06)",
    );
  }

  transaction(connection, (tx) => {
    if (role === "primary") {
      const live = one<{ pr_id: string }>(
        tx,
        "SELECT pr_id FROM run_pr_link" +
          " WHERE run_id = ? AND role = 'primary' AND unlinked_at_ms IS NULL",
        [runId],
      );
      if (live !== undefined) {
        throw new RunPrLinkRefused(
          `run ${pythonRepr(runId)} already has a live primary link to ${pythonRepr(live.pr_id)}; ` +
            "re-point it by unlinking that link with a reason, so the history of the re-point survives",
        );
      }
    }
    try {
      tx.prepare<[string, string, string, string, number]>(
        "INSERT INTO run_pr_link (run_id, pr_id, role, resolution, linked_at_ms," +
          " unlinked_at_ms, unlink_reason) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
      ).run(runId, prId, role, resolution, linkedAtMs);
    } catch (error) {
      if (isConstraintError(error)) {
        // `cause` carried, because the source chains here (`raise ... from
        // error`) exactly as it does in upsertRepository, and the driver's own
        // message is the only thing that says WHICH constraint refused.
        throw new RunPrLinkRefused(
          `(${pythonRepr(runId)}, ${pythonRepr(prId)}) could not be linked: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  });
}

/**
 * Retire a live link, recording why.
 *
 * The reason is mandatory in the signature and in the DDL's biconditional
 * because an unlinked link with no reason is indistinguishable from a link
 * somebody deleted -- and the row exists precisely so that a re-point can
 * be read back later.
 *
 * @throws {RunPrLinkRefused} if there is no live link for the pair, or the
 *   reason is empty, or `unlinkedAtMs` precedes the link.
 */
export function unlinkRunPr(
  connection: SqliteDatabase,
  options: {
    readonly runId: string;
    readonly prId: string;
    readonly unlinkedAtMs: number;
    readonly unlinkReason: string;
  },
): void {
  const { runId, prId, unlinkedAtMs, unlinkReason } = options;

  requireEpochMs({ unlinked_at_ms: unlinkedAtMs });
  requireText({ run_id: runId, pr_id: prId, unlink_reason: unlinkReason });

  transaction(connection, (tx) => {
    const cursor = tx
      .prepare<[number, string, string, string, number]>(
        "UPDATE run_pr_link SET unlinked_at_ms = ?, unlink_reason = ?" +
          " WHERE run_id = ? AND pr_id = ? AND unlinked_at_ms IS NULL" +
          "   AND ? >= linked_at_ms",
      )
      .run(unlinkedAtMs, unlinkReason, runId, prId, unlinkedAtMs);
    if (cursor.changes === 0) {
      throw new RunPrLinkRefused(
        `no live link (${pythonRepr(runId)}, ${pythonRepr(prId)}) at or after its linked_at_ms to ` +
          "unlink; an already-unlinked link is history and is never rewritten",
      );
    }
  });
}

/**
 * The run's live `primary` link, or `undefined`.
 *
 * `undefined` is the honest answer here, unlike in {@link resolveRepository}:
 * a run with no primary PR yet is the ordinary state of every run before
 * its first PR exists, and the caller's next move is to wait, not to exit.
 * Returned exactly as read -- the database's own snake_case column names --
 * because this is a raw projection of one row, not a typed value this
 * module owns the shape of.
 */
export function primaryLink(
  connection: SqliteDatabase,
  options: { readonly runId: string },
): Readonly<Record<string, unknown>> | undefined {
  return one(
    connection,
    "SELECT * FROM run_pr_link" +
      " WHERE run_id = ? AND role = 'primary' AND unlinked_at_ms IS NULL",
    [options.runId],
  );
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

interface Plan {
  readonly eventType: string;
  readonly headMoved: boolean;
  readonly reopened: boolean;
  readonly created: boolean;
}

/**
 * Name the transition. `null` means the observation restates what is
 * already recorded.
 *
 * The order of the tests is the order of consequence -- a merge that also
 * moved the head is a merge, because `pr_merged` is what the Secretary
 * consumes to complete a run and filing it as `pr_head_updated` would
 * strand the run.
 */
function planTransition(options: {
  readonly before: PullRequestRow | undefined;
  readonly headSha: string;
  readonly state: string;
  readonly observedAtMs: number;
}): Plan | null {
  const { before, headSha, state, observedAtMs } = options;

  if (before === undefined) {
    if (state === "merged") {
      return { eventType: "pr_merged", headMoved: true, reopened: false, created: true };
    }
    if (state === "closed") {
      return { eventType: "pr_closed", headMoved: true, reopened: false, created: true };
    }
    return { eventType: "pr_head_updated", headMoved: true, reopened: false, created: true };
  }

  const wasState = before.state;
  const wasHead = before.head_sha;
  const headMoved = headSha !== wasHead;

  if (wasState === "merged" && state !== "merged") {
    throw new PullRequestObservationRefused(
      `${before.pr_id} is recorded merged and a merge is a fact; an observation reporting ` +
        `${pythonRepr(state)} is either a different pull request or a bad read`,
    );
  }
  // The staleness of a head is a property of the head, not of the
  // transition that happens to carry it, so this is tested BEFORE the
  // transition is named rather than inside the pr_head_updated branch. A
  // delayed merge, close or reopen carrying an older, different headSha is
  // the same late provider read section 7.2 calls evidence and not a
  // projection -- and the pull_request_head_is_monotonic trigger
  // (migrations/0001_initial.sql) refuses the UPDATE either way, so what
  // is at stake here is the *name*: reaching the trigger leaves the caller
  // a raw constraint error saying only that some constraint failed, which
  // is the loss of naming PullRequestObservationRefused exists to prevent.
  const watermark = before.head_observed_at_ms;
  if (headMoved && observedAtMs <= watermark) {
    throw new PullRequestObservationRefused(
      `${before.pr_id} head ${wasHead} was observed at ${watermark}; a head move to ${headSha} ` +
        `claimed at ${observedAtMs} with state ${pythonRepr(state)} is a late arrival, which is ` +
        "evidence and not a projection (section 7.2)",
    );
  }
  // ...and the same for a state that moves while the head stands still,
  // which neither the test above nor the DDL trigger reaches -- the
  // trigger fires on head_sha / head_observed_at_ms / head_event_seq, and
  // an unchanged head touches none of them. Without this, the provider
  // sequence close -> reopen -> close leaves a poll from the intervening
  // open period in flight that is accepted as a SECOND reopen.
  if (state !== wasState && observedAtMs <= watermark) {
    throw new PullRequestObservationRefused(
      `${before.pr_id} is recorded ${pythonRepr(wasState)} from an observation at ${watermark}; a ` +
        `transition to ${pythonRepr(state)} claimed at ${observedAtMs} on the unchanged head ` +
        `${headSha} is a late arrival, which is evidence and not a projection (section 7.2)`,
    );
  }

  if (state === "merged" && wasState !== "merged") {
    return { eventType: "pr_merged", headMoved, reopened: false, created: false };
  }
  if (state === "closed" && wasState === "open") {
    return { eventType: "pr_closed", headMoved, reopened: false, created: false };
  }
  if (state === "open" && wasState === "closed") {
    return { eventType: "pr_reopened", headMoved, reopened: true, created: false };
  }
  if (headMoved) {
    return { eventType: "pr_head_updated", headMoved: true, reopened: false, created: false };
  }
  return null;
}

/**
 * Write the row, and on a reopen un-retire the scope in the same breath.
 *
 * The prior row is re-read here and compared with what the transition was
 * named against: the naming read happened before the transaction opened,
 * and a projection that moved in between would have its event mislabelled.
 * The comparison is on the three columns the naming used.
 */
function writeProjection(
  connection: SqliteDatabase,
  options: {
    readonly seq: number;
    readonly expected: PullRequestRow | undefined;
    readonly prId: string;
    readonly repoId: string;
    readonly prNumber: number;
    readonly providerPrId: string | null;
    readonly headSha: string;
    readonly state: string;
    readonly observedAtMs: number;
    readonly ingestedAtMs: number;
    readonly mergeCommitSha: string | null;
    readonly mergedAtMs: number | null;
    readonly closedAtMs: number | null;
    readonly reopened: boolean;
    readonly reactivated: string[];
  },
): void {
  const {
    seq,
    expected,
    prId,
    repoId,
    prNumber,
    providerPrId,
    headSha,
    state,
    observedAtMs,
    ingestedAtMs,
    mergeCommitSha,
    mergedAtMs,
    closedAtMs,
    reopened,
    reactivated,
  } = options;

  const current = readPullRequest(connection, { repoId, prNumber });
  if (!identityEquals(current, expected)) {
    throw new StalePullRequestObservation(
      `${prId} changed between naming this observation and writing it (${identityRepr(expected)} ` +
        `-> ${identityRepr(current)}); the event would carry the wrong type, so nothing is written`,
    );
  }

  if (current === undefined) {
    connection
      .prepare<
        [
          string,
          string,
          number,
          string | null,
          string,
          number,
          number,
          string,
          string | null,
          number | null,
          number | null,
          number,
          number,
        ]
      >(
        "INSERT INTO pull_request (pr_id, repo_id, pr_number, provider_pr_id, head_sha," +
          " head_observed_at_ms, head_event_seq, state, merge_commit_sha, merged_at_ms," +
          " closed_at_ms, created_at_ms, updated_at_ms)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        prId,
        repoId,
        prNumber,
        providerPrId,
        headSha,
        observedAtMs,
        seq,
        state,
        mergeCommitSha,
        mergedAtMs,
        closedAtMs,
        ingestedAtMs,
        ingestedAtMs,
      );
    return;
  }

  connection
    .prepare<
      [
        string,
        number,
        number,
        string,
        string | null,
        string | null,
        number | null,
        number | null,
        number,
        string,
      ]
    >(
      "UPDATE pull_request SET head_sha = ?, head_observed_at_ms = ?, head_event_seq = ?," +
        " state = ?, provider_pr_id = COALESCE(?, provider_pr_id), merge_commit_sha = ?," +
        " merged_at_ms = ?, closed_at_ms = ?, updated_at_ms = ?" +
        " WHERE pr_id = ?",
    )
    .run(
      headSha,
      Math.max(observedAtMs, current.head_observed_at_ms),
      Math.max(seq, current.head_event_seq),
      state,
      providerPrId,
      mergeCommitSha,
      mergedAtMs,
      closedAtMs,
      Math.max(ingestedAtMs, current.updated_at_ms),
      prId,
    );

  if (!reopened) {
    return;
  }
  // Section 7.2: section 8.2 retired this PR's scope when it went
  // terminal, so a reopen that clears closed_at_ms and stops there leaves
  // the PR watched in name only. Same transaction, or the reconcile
  // pass's scope-coverage query is left to find it.
  const scopes = all<{ scope_id: string }>(
    connection,
    "SELECT scope_id FROM watcher_scope WHERE pr_id = ? AND retired_at_ms IS NOT NULL",
    [prId],
  );
  for (const scope of scopes) {
    connection
      .prepare<[string]>("UPDATE watcher_scope SET retired_at_ms = NULL WHERE scope_id = ?")
      .run(scope.scope_id);
    reactivated.push(scope.scope_id);
  }
}

/**
 * A general row reader, mirroring the source's `_one`: unlike better-
 * sqlite3's own default, Python's `sqlite3` needs a per-cursor
 * `row_factory` to read by name at all. better-sqlite3 already returns a
 * plain object keyed by column name for every statement, so this wrapper
 * exists only to keep the shared `sql, params -> row | undefined` shape
 * the callers above are written against, not to work around a driver gap.
 */
function one<T = Record<string, unknown>>(
  connection: SqliteDatabase,
  sql: string,
  params: readonly unknown[],
): T | undefined {
  return all<T>(connection, sql, params)[0];
}

function all<T = Record<string, unknown>>(
  connection: SqliteDatabase,
  sql: string,
  params: readonly unknown[],
): readonly T[] {
  return connection.prepare<unknown[], T>(sql).all(...params);
}

function readPullRequest(
  connection: SqliteDatabase,
  options: { readonly repoId: string; readonly prNumber: number },
): PullRequestRow | undefined {
  return one<PullRequestRow>(
    connection,
    "SELECT * FROM pull_request WHERE repo_id = ? AND pr_number = ?",
    [options.repoId, options.prNumber],
  );
}

function identityOf(
  row: PullRequestRow | undefined,
): readonly [string, string, number] | undefined {
  if (row === undefined) {
    return undefined;
  }
  return [row.state, row.head_sha, row.head_event_seq];
}

function identityEquals(a: PullRequestRow | undefined, b: PullRequestRow | undefined): boolean {
  const ia = identityOf(a);
  const ib = identityOf(b);
  if (ia === undefined || ib === undefined) {
    return ia === ib;
  }
  return ia[0] === ib[0] && ia[1] === ib[1] && ia[2] === ib[2];
}

/** A Python tuple repr of `(state, head_sha, head_event_seq)`, or `None`. */
function identityRepr(row: PullRequestRow | undefined): string {
  const id = identityOf(row);
  if (id === undefined) {
    return "None";
  }
  return `('${id[0]}', '${id[1]}', ${id[2]})`;
}

/** The `pull_request` biconditionals, refused by name instead of by CHECK. */
function requireStateFacts(options: {
  readonly state: string;
  readonly mergeCommitSha: string | null;
  readonly mergedAtMs: number | null;
  readonly closedAtMs: number | null;
}): void {
  const { state, mergeCommitSha, mergedAtMs, closedAtMs } = options;

  if (!PR_STATES.includes(state)) {
    throw new PullRequestObservationRefused(
      `state must be one of ${pythonTuple(PR_STATES)}, got ${pythonRepr(state)}`,
    );
  }
  if ((state === "merged") !== (mergedAtMs !== null)) {
    throw new PullRequestObservationRefused(
      `state ${pythonRepr(state)} and merged_at_ms ${pythonRepr(mergedAtMs)} disagree; a merge carries ` +
        "its own time and nothing else does",
    );
  }
  if ((state === "merged") !== (mergeCommitSha !== null)) {
    throw new PullRequestObservationRefused(
      `state ${pythonRepr(state)} and merge_commit_sha ${pythonRepr(mergeCommitSha)} disagree`,
    );
  }
  if (mergeCommitSha !== null && !isFullLowercaseSha(mergeCommitSha)) {
    throw new PullRequestObservationRefused(
      `merge_commit_sha must be 40 lowercase hex characters, got ${pythonRepr(mergeCommitSha)}`,
    );
  }
  if ((state === "merged" || state === "closed") !== (closedAtMs !== null)) {
    throw new PullRequestObservationRefused(
      `state ${pythonRepr(state)} and closed_at_ms ${pythonRepr(closedAtMs)} disagree; a merged or ` +
        "closed pull request is closed and an open one is not",
    );
  }
}

/**
 * Reject a clock value that is not an integer count of milliseconds.
 *
 * The bare Python `TypeError` this raises for has no dedicated usage-error
 * class in this module (`repo_link.py` declares none of its own, unlike
 * `EventSpineUsageError` / `PolicyUsageError`), so it maps straight to
 * `TypeError` here too.
 */
function requireEpochMs(values: Readonly<Record<string, unknown>>): void {
  for (const [label, value] of Object.entries(values)) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new TypeError(
        `${label} must be an int of epoch milliseconds, got ${typeof value}; the clock is the ` +
          "caller's and is never read from the database",
      );
    }
  }
}

/**
 * Reject an empty or non-string identifier. Maps the source's bare
 * `ValueError` to `TypeError`, the house convention for an untyped Python
 * `ValueError` (see `gates.test.ts`'s translation notes).
 */
function requireText(values: Readonly<Record<string, unknown>>): void {
  for (const [label, value] of Object.entries(values)) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`${label} must be a non-empty string, got ${pythonRepr(value)}`);
    }
  }
}

function isFullLowercaseSha(value: unknown): value is string {
  return typeof value === "string" && value.length === 40 && SHA_PATTERN.test(value);
}
