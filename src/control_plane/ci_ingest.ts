import type { Database as SqliteDatabase } from "better-sqlite3";
import type { AppendedEvent } from "./events.js";
import { appendEvent } from "./events.js";
import { ControlPlaneRefusal } from "./refusals.js";

/**
 * G3 -- CI outcome ingestion: one identity, evidence that is never overwritten.
 *
 * `docs/production-schema.md` sections 6.1-6.3 and `D-0033` are the design
 * this module implements; nothing here decides anything they left open. Two
 * failures are what the shape is answering, and both are worth restating
 * because every rule below is one of them made unreachable.
 *
 * **Without an identity**, a re-poll, a CI rerun, a PR head update and a late
 * arrival are indistinguishable, and the event spine's `dedupKey` has
 * nothing to be made of. The identity is `(provider, repoId, prNumber,
 * headSha, checkScope, scopeId, attempt, verdict)`. It lives in exactly one
 * place in this module -- {@link ObservationIdentity} -- because section 6.2
 * says the unique index on `ci_observation` and the event's `dedup_key` are
 * *the same constraint expressed twice*, and two hand-written renderings of
 * one tuple drift silently: the index would keep refusing a re-poll while
 * the spine started accepting it, or the reverse, and neither shows up as an
 * error anywhere. So the dedup key is *derived* from the same object the
 * `INSERT` parameters are derived from, and {@link observationDedupKey} is
 * that derivation exposed rather than a second copy of it.
 *
 * `verdict` being **in** the identity is the part that costs a real result
 * if it is dropped. A fetch failure records `indeterminate` for a scope; the
 * next poll succeeds and the provider says `failed`. Provider, repo, PR,
 * head, scope and attempt are all unchanged -- the rerun never happened,
 * only our observation of it improved -- so an identity without `verdict`
 * collides, the append is an idempotent no-op, and the PR stays projected
 * `indeterminate` forever with the real verdict discarded.
 *
 * **Without an ordering rule**, arrival-order last-write-wins lets a stale
 * verdict overwrite a newer one -- a red PR reported green because the red
 * observation was slower, which is `D-0006`'s verdict honesty violated in
 * the most direct way available. So observations are evidence and are never
 * updated or deleted; the current verdict is the `ci_current_verdict`
 * **view** (a projection, not a column, so it cannot drift from the rows it
 * summarises) folded by {@link prVerdict}. A late arrival that orders lower
 * is stored and moves nothing.
 *
 * **The edge is where a malformed identity is refused.** An abbreviated or
 * upper-case `headSha`, an `attempt` below 1, a verdict outside the closed
 * set and a provider that is not `github` are all also `CHECK`ed in the DDL,
 * and that duplication is deliberate rather than redundant: the `CHECK`
 * fires *inside* the append transaction, after the event row has already
 * been written, so the producer learns "your database rejected something"
 * rather than "this SHA is an abbreviation". Refusing at the edge names the
 * defect at the only place that knows which field the caller got wrong, and
 * it keeps a doomed transaction from taking the write lock at all.
 *
 * **Nothing in this module opens a transaction.** The append is
 * {@link appendEvent}'s, and the `ci_observation` row is written as its
 * `sideEffect` so that the fact and its evidence commit together or not at
 * all. Reimplementing the append here would give the spine a second writer
 * with its own idea of the fan-out, which is exactly the push-vs-poll
 * duplication section 5.4 exists to remove.
 */

/**
 * The only provider designed in. `D-0033`: "a second provider widens the
 * `CHECK` in a migration step and brings its substitution test then". A
 * case-variant such as `'GITHUB'` is a *different* string in the identity
 * and would therefore admit the same fact twice, so this set is compared
 * against exactly, never case-folded.
 */
export const CI_PROVIDERS: ReadonlySet<string> = new Set(["github"]);

/**
 * The closed verdict vocabulary of `ci_observation`. `indeterminate` and
 * `no_run` are separate members because collapsing either into `failed` is
 * the v1 defect `D-0006` records.
 */
export const CI_VERDICTS: ReadonlySet<string> = new Set([
  "passed",
  "failed",
  "cancelled",
  "timed_out",
  "no_run",
  "indeterminate",
]);

/**
 * The scopes an observation may be attributed to. `rollup` is the coarse
 * fallback an old `gh` forces, and section 6.3 rule 3 makes it subordinate
 * -- it is not a peer of the fine-grained scopes.
 */
export const CHECK_SCOPES: ReadonlySet<string> = new Set(["check_suite", "workflow_run", "rollup"]);

/**
 * The event type this module appends. The DDL leaves `event.event_type`
 * open text on purpose; this is the implementation's vocabulary, not a
 * constraint.
 */
export const CI_OBSERVED_EVENT_TYPE = "ci_observed";

/**
 * The severity fold of section 6.3 rule 5: `failed > timed_out > cancelled >
 * indeterminate > passed`.
 *
 * `indeterminate` outranking `passed` is `D-0006` again -- an unobservable
 * check is not a green one. `no_run` is ranked lowest but that rank is
 * never what decides an answer: {@link prVerdict} removes `no_run` from the
 * evidence *before* folding, because `no_run` means "no eligible evidence"
 * rather than "this PR passed", and a fold that merely ranked it below
 * `passed` would still report a PR green the moment one scope said nothing.
 */
export const VERDICT_SEVERITY: Readonly<Record<string, number>> = Object.freeze({
  failed: 5,
  timed_out: 4,
  cancelled: 3,
  indeterminate: 2,
  passed: 1,
  no_run: 0,
});

/** The verdict {@link prVerdict} reports when nothing eligible remains to fold. */
export const NO_ELIGIBLE_EVIDENCE = "no_run";

const SHA_LENGTH = 40;
const FULL_LOWERCASE_SHA = /^[0-9a-f]{40}$/;

/**
 * An observation was refused at the edge; nothing was written.
 *
 * A subclass of {@link ControlPlaneRefusal} because the answer is the same
 * one that family carries everywhere else -- the state was neither repaired
 * nor guessed at. The subclasses below exist so that a caller (and a test)
 * can say *which* field of the identity was wrong; a bare `boolean` return
 * would make "refused" indistinguishable from "already on the spine", and
 * those two need opposite responses from a watcher.
 */
export class CiObservationRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CiObservationRefused";
    Object.setPrototypeOf(this, CiObservationRefused.prototype);
  }
}

/**
 * The provider is not `'github'`.
 *
 * Separate from the other refusals because a case variant is the dangerous
 * shape: `provider` is part of the identity but the `ci_current_verdict`
 * per-scope subquery does not discriminate on it, so a `'GITHUB'` duplicate
 * of a green observation would compete against the real red one on
 * `(attempt, occurred_at_ms, event_seq)` and a later-timestamped bogus row
 * would win -- section 6.1's verdict-honesty failure in its most direct
 * form.
 */
export class UnsupportedProviderRefused extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnsupportedProviderRefused";
    Object.setPrototypeOf(this, UnsupportedProviderRefused.prototype);
  }
}

/**
 * The head SHA is not a full 40-character lowercase hex commit id.
 *
 * An abbreviation is not an identity: two heads can share a prefix, and the
 * observation would then be attributed to the wrong head -- and, through
 * `ci_current_verdict`'s join on `pull_request.head_sha`, to the wrong
 * projection.
 */
export class MalformedHeadShaRefused extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MalformedHeadShaRefused";
    Object.setPrototypeOf(this, MalformedHeadShaRefused.prototype);
  }
}

/**
 * The attempt number is not an integer of at least 1.
 *
 * `attempt` is the leading term of the projection's ordering, so a zero or
 * negative attempt does not merely look wrong -- it sorts a rerun *below*
 * the run it replaced.
 */
export class MalformedAttemptRefused extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MalformedAttemptRefused";
    Object.setPrototypeOf(this, MalformedAttemptRefused.prototype);
  }
}

/**
 * The PR number is not a positive integer.
 *
 * Its own class rather than a shared "bad number" refusal because the
 * caller's next move differs: a bad `attempt` is a parsing bug in the
 * adapter's read of one check run, while a bad `prNumber` means the whole
 * observation is attributed to nothing -- and section 7.1's dated incident
 * is precisely a PR number resolved against the wrong thing and stored
 * anyway.
 */
export class MalformedPrNumberRefused extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MalformedPrNumberRefused";
    Object.setPrototypeOf(this, MalformedPrNumberRefused.prototype);
  }
}

/**
 * The verdict is outside {@link CI_VERDICTS}.
 *
 * The vocabulary is closed so that {@link VERDICT_SEVERITY} is total over
 * it: an unrecognised verdict reaching the fold would have no rank, and the
 * only available failure modes there are "crash" or "silently treated as
 * green".
 */
export class UnknownVerdictRefused extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownVerdictRefused";
    Object.setPrototypeOf(this, UnknownVerdictRefused.prototype);
  }
}

/**
 * The check scope is outside {@link CHECK_SCOPES}.
 *
 * A scope the view does not know is a scope rule 3 cannot classify as
 * coarse or fine, so it would take part in the fold as a peer of the real
 * checks.
 */
export class UnknownCheckScopeRefused extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownCheckScopeRefused";
    Object.setPrototypeOf(this, UnknownCheckScopeRefused.prototype);
  }
}

/**
 * A field of the identity is empty, so the rendered dedup key is ambiguous.
 *
 * `'ci/github//7/...'` and `'ci/github/x//...'` are different facts that a
 * reader cannot tell apart, and an empty component makes the
 * separator-joined key non-injective -- which is the one property the whole
 * rendering rests on.
 */
export class EmptyIdentityFieldRefused extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EmptyIdentityFieldRefused";
    Object.setPrototypeOf(this, EmptyIdentityFieldRefused.prototype);
  }
}

/** `null` as Python would render it in an f-string; a string is itself. */
function reprOf(value: unknown): string {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  // `String(null)` is "null" and `String(undefined)` is "undefined"; Python's
  // repr of the absence these stand for is `None`. These messages are how an
  // operator reads back what was rejected, and the whole point of the guards
  // above is that they fire on absence -- so absence has to render as the
  // source renders it. Booleans likewise: Python prints True/False.
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

/** `repr(sorted(...))`-shaped text: a Python list of single-quoted strings. */
function pyList(values: readonly string[]): string {
  return `[${values.map((v) => `'${v}'`).join(", ")}]`;
}

function isFullLowercaseSha(value: unknown): value is string {
  return typeof value === "string" && value.length === SHA_LENGTH && FULL_LOWERCASE_SHA.test(value);
}

/**
 * The single tuple both the `dedupKey` and the row's key columns come from.
 *
 * Validated on construction, so an instance of this class is by definition
 * an identity the DDL will accept: the edge checks and the `CHECK`
 * constraints say the same things, and this is the place they are kept
 * saying them together.
 */
export class ObservationIdentity {
  readonly provider: string;
  readonly repoId: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkScope: string;
  readonly scopeId: string;
  readonly attempt: number;
  readonly verdict: string;

  constructor(options: {
    readonly provider: string;
    readonly repoId: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly checkScope: string;
    readonly scopeId: string;
    readonly attempt: number;
    readonly verdict: string;
  }) {
    const { provider, repoId, prNumber, headSha, checkScope, scopeId, attempt, verdict } = options;

    if (!CI_PROVIDERS.has(provider)) {
      throw new UnsupportedProviderRefused(
        `provider ${reprOf(provider)} is not one of ${pyList(Array.from(CI_PROVIDERS).sort())}; ` +
          "a case variant is a different string in the identity and would admit the same fact twice",
      );
    }
    // Python's guard is `if not getattr(self, field_name)`, a truthiness test,
    // so `None` is refused here as surely as `""` is. A bare `=== ""` narrows
    // it: an untyped caller passing `null` would build an identity, render a
    // dedup key reading `ci/github/null/7/...`, and fail only on the NOT NULL
    // constraint INSIDE the append transaction -- which is the outcome this
    // edge check exists to prevent, arriving later and as a driver error
    // instead of a typed refusal.
    if (typeof repoId !== "string" || repoId === "") {
      throw new EmptyIdentityFieldRefused(
        "repo_id is empty; the rendered dedup key would be ambiguous",
      );
    }
    if (typeof scopeId !== "string" || scopeId === "") {
      throw new EmptyIdentityFieldRefused(
        "scope_id is empty; the rendered dedup key would be ambiguous",
      );
    }
    if (typeof prNumber !== "number" || !Number.isInteger(prNumber)) {
      throw new MalformedPrNumberRefused(`pr_number ${reprOf(prNumber)} is not an integer`);
    }
    if (prNumber < 1) {
      throw new MalformedPrNumberRefused(`pr_number ${reprOf(prNumber)} is below 1`);
    }
    if (!isFullLowercaseSha(headSha)) {
      throw new MalformedHeadShaRefused(
        `head_sha ${reprOf(headSha)} is not a full ${SHA_LENGTH}-character lowercase hex ` +
          "commit id; an abbreviation is not an identity because two heads can share a prefix",
      );
    }
    if (!CHECK_SCOPES.has(checkScope)) {
      throw new UnknownCheckScopeRefused(
        `check_scope ${reprOf(checkScope)} is not one of ${pyList(Array.from(CHECK_SCOPES).sort())}`,
      );
    }
    if (typeof attempt !== "number" || !Number.isInteger(attempt)) {
      throw new MalformedAttemptRefused(`attempt ${reprOf(attempt)} is not an integer`);
    }
    if (attempt < 1) {
      throw new MalformedAttemptRefused(
        `attempt ${reprOf(attempt)} is below 1; attempt leads the projection's ordering, so a ` +
          "rerun must never sort below the run it replaced",
      );
    }
    if (!CI_VERDICTS.has(verdict)) {
      throw new UnknownVerdictRefused(
        `verdict ${reprOf(verdict)} is not one of ${pyList(Array.from(CI_VERDICTS).sort())}`,
      );
    }

    this.provider = provider;
    this.repoId = repoId;
    this.prNumber = prNumber;
    this.headSha = headSha;
    this.checkScope = checkScope;
    this.scopeId = scopeId;
    this.attempt = attempt;
    this.verdict = verdict;
  }

  /** The identity rendered as section 6.2's event `dedupKey` string. */
  get dedupKey(): string {
    return [
      "ci",
      this.provider,
      this.repoId,
      String(this.prNumber),
      this.headSha,
      this.checkScope,
      this.scopeId,
      String(this.attempt),
      this.verdict,
    ].join("/");
  }

  /**
   * The event subject: the PR's provider-side identity, `repoId#number`.
   *
   * Not `pull_request.pr_id`. A CI observation references `repository` and
   * `event` but deliberately not `pull_request`, so an observation may
   * legitimately arrive before we have ever recorded the PR row -- and a
   * subject that could only be filled in once that row existed would either
   * drop the event or make the subject depend on arrival order.
   * `(repoId, prNumber)` is an alternate key of `pull_request`
   * (`pull_request_identity`), so this names the same PR either way.
   */
  get subjectId(): string {
    return `${this.repoId}#${this.prNumber}`;
  }
}

/**
 * Render section 6.2's dedup key, refusing an identity the DDL would refuse.
 *
 * The rendering is {@link ObservationIdentity.dedupKey}; this function
 * exists so that a caller wanting only the key -- a reconcile pass asking
 * "is this fact already on the spine?" -- gets it from the same
 * construction {@link recordCiObservation} uses rather than from a format
 * string of its own.
 */
export function observationDedupKey(options: {
  readonly provider?: string;
  readonly repoId: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkScope: string;
  readonly scopeId: string;
  readonly attempt: number;
  readonly verdict: string;
}): string {
  const {
    provider = "github",
    repoId,
    prNumber,
    headSha,
    checkScope,
    scopeId,
    attempt,
    verdict,
  } = options;
  return new ObservationIdentity({
    provider,
    repoId,
    prNumber,
    headSha,
    checkScope,
    scopeId,
    attempt,
    verdict,
  }).dedupKey;
}

/**
 * Append one CI observation to the spine, with its evidence row, atomically.
 *
 * The event carries the identity as its `dedupKey`, so a re-poll of the
 * identical fact is refused at the *first* statement of the append
 * transaction (section 5.4 step 1) and reported as {@link AppendedEvent}
 * with `duplicate=true` -- an idempotent no-op, not an error. Nothing
 * downstream of that statement runs, which is why a watcher may re-poll as
 * often as it likes without the fan-out, the outbox or this side table
 * seeing the repeat at all.
 *
 * `eventId` defaults to `observationId`. Both are the caller's own
 * identifier for *this observation attempt*, and giving them one value
 * keeps the event and its evidence row trivially correlatable without
 * inventing a second identifier scheme; a re-poll that mints a fresh
 * `observationId` still collides on the `dedupKey`, which is the constraint
 * that is supposed to catch it.
 *
 * `occurredAtMs` is the provider's clock and `ingestedAtMs` is ours; they
 * are never conflated, and neither is read from a clock here -- both are
 * the caller's, as every timestamp in this schema is.
 */
export function recordCiObservation(
  connection: SqliteDatabase,
  options: {
    readonly observationId: string;
    readonly provider?: string;
    readonly repoId: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly checkScope: string;
    readonly scopeId: string;
    readonly attempt: number;
    readonly verdict: string;
    readonly observer: string;
    readonly observerEpoch: number;
    readonly occurredAtMs: number;
    readonly ingestedAtMs: number;
    readonly verdictDetail?: string | null;
    readonly sourceId?: string | null;
    readonly eventId?: string | null;
    readonly runId?: string | null;
  },
): AppendedEvent {
  const {
    observationId,
    provider = "github",
    repoId,
    prNumber,
    headSha,
    checkScope,
    scopeId,
    attempt,
    verdict,
    observer,
    observerEpoch,
    occurredAtMs,
    ingestedAtMs,
    verdictDetail = null,
    sourceId = null,
    eventId = null,
    runId = null,
  } = options;

  const identity = new ObservationIdentity({
    provider,
    repoId,
    prNumber,
    headSha,
    checkScope,
    scopeId,
    attempt,
    verdict,
  });

  function insertObservation(inner: SqliteDatabase, eventSeq: number): void {
    inner
      .prepare<{
        observation_id: string;
        event_seq: number;
        provider: string;
        repo_id: string;
        pr_number: number;
        head_sha: string;
        check_scope: string;
        scope_id: string;
        attempt: number;
        verdict: string;
        verdict_detail: string | null;
        source_id: string | null;
        observer: string;
        observer_epoch: number;
        occurred_at_ms: number;
        ingested_at_ms: number;
      }>(
        `
            INSERT INTO ci_observation (observation_id, event_seq, provider, repo_id,
                                        pr_number, head_sha, check_scope, scope_id, attempt,
                                        verdict, verdict_detail, source_id, observer,
                                        observer_epoch, occurred_at_ms, ingested_at_ms)
            VALUES (:observation_id, :event_seq, :provider, :repo_id, :pr_number, :head_sha,
                    :check_scope, :scope_id, :attempt, :verdict, :verdict_detail, :source_id,
                    :observer, :observer_epoch, :occurred_at_ms, :ingested_at_ms)
            `,
      )
      .run({
        observation_id: observationId,
        event_seq: eventSeq,
        provider: identity.provider,
        repo_id: identity.repoId,
        pr_number: identity.prNumber,
        head_sha: identity.headSha,
        check_scope: identity.checkScope,
        scope_id: identity.scopeId,
        attempt: identity.attempt,
        verdict: identity.verdict,
        verdict_detail: verdictDetail,
        source_id: sourceId,
        observer,
        observer_epoch: observerEpoch,
        occurred_at_ms: occurredAtMs,
        ingested_at_ms: ingestedAtMs,
      });
  }

  return appendEvent(connection, {
    eventId: eventId === null ? observationId : eventId,
    eventType: CI_OBSERVED_EVENT_TYPE,
    subjectKind: "pull_request",
    subjectId: identity.subjectId,
    dedupKey: identity.dedupKey,
    producer: observer,
    producerEpoch: observerEpoch,
    occurredAtMs,
    ingestedAtMs,
    runId,
    payload: null,
    sideEffect: insertObservation,
  });
}

/** One row of {@link scopeVerdicts}'s eligible per-scope projection. */
export interface ScopeVerdict {
  readonly repoId: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkScope: string;
  readonly scopeId: string;
  readonly verdict: string;
  readonly attempt: number;
  readonly occurredAtMs: number;
  readonly eventSeq: number;
}

/**
 * The eligible per-scope projection for one PR, straight out of the view.
 *
 * Reading `ci_current_verdict` rather than re-deriving it in TypeScript is
 * the point: rule 1 (only the PR's current head is eligible), rule 2 (the
 * `attempt DESC, occurred_at_ms DESC, event_seq DESC` order) and rule 3 (a
 * rollup drops out the moment a fine-grained scope exists for that head)
 * are all in the view, and a second implementation of them here would be a
 * second thing to keep true.
 *
 * The rows are returned oldest-scope-first by `(checkScope, scopeId)` so
 * that a caller rendering them gets a stable order; the projection itself
 * is unordered, one row per eligible scope.
 */
export function scopeVerdicts(
  connection: SqliteDatabase,
  options: { readonly repoId: string; readonly prNumber: number },
): readonly ScopeVerdict[] {
  const rows = connection
    .prepare<
      [string, number],
      {
        repo_id: string;
        pr_number: number;
        head_sha: string;
        check_scope: string;
        scope_id: string;
        verdict: string;
        attempt: number;
        occurred_at_ms: number;
        event_seq: number;
      }
    >(
      `
        SELECT repo_id, pr_number, head_sha, check_scope, scope_id, verdict, attempt,
               occurred_at_ms, event_seq
          FROM ci_current_verdict
         WHERE repo_id = ? AND pr_number = ?
         ORDER BY check_scope, scope_id
        `,
    )
    .all(options.repoId, options.prNumber);
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        repoId: row.repo_id,
        prNumber: Number(row.pr_number),
        headSha: row.head_sha,
        checkScope: row.check_scope,
        scopeId: row.scope_id,
        verdict: row.verdict,
        attempt: Number(row.attempt),
        occurredAtMs: Number(row.occurred_at_ms),
        eventSeq: Number(row.event_seq),
      }),
    ),
  );
}

/**
 * Fold the eligible per-scope verdicts into one, most severe wins.
 *
 * Section 6.3 rule 5. `no_run` rows are dropped *before* the fold rather
 * than ranked within it: `no_run` is a fact about the repository ("no CI is
 * configured for this head"), not about the change, and a fold that merely
 * ranked it below `passed` would answer `passed` for a PR whose only
 * evidence is that nothing ran. When nothing eligible survives -- no
 * observation for the current head, or every one of them `no_run` -- the
 * answer is {@link NO_ELIGIBLE_EVIDENCE}, which says absent evidence and is
 * not a pass.
 */
export function prVerdict(
  connection: SqliteDatabase,
  options: { readonly repoId: string; readonly prNumber: number },
): string {
  const verdicts = scopeVerdicts(connection, options)
    .filter((row) => row.verdict !== NO_ELIGIBLE_EVIDENCE)
    .map((row) => row.verdict);
  if (verdicts.length === 0) {
    return NO_ELIGIBLE_EVIDENCE;
  }
  // Python folds with `max(verdicts, key=lambda v: VERDICT_SEVERITY[v])`, and
  // that subscript raises KeyError for a verdict the severity table does not
  // rank. Defaulting the miss to -Infinity would silently rank an unknown
  // verdict below every known one -- so a verdict the closed set gained without
  // a severity would be quietly treated as the weakest evidence there is,
  // at the one place the module's docstring says the ordering must be total.
  return verdicts.reduce((best, current) => {
    const currentSeverity = VERDICT_SEVERITY[current];
    const bestSeverity = VERDICT_SEVERITY[best];
    if (currentSeverity === undefined) {
      throw new TypeError(`verdict '${current}' has no entry in VERDICT_SEVERITY`);
    }
    if (bestSeverity === undefined) {
      throw new TypeError(`verdict '${best}' has no entry in VERDICT_SEVERITY`);
    }
    return currentSeverity > bestSeverity ? current : best;
  });
}
