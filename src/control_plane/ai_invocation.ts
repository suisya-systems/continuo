import type { Database as SqliteDatabase } from "better-sqlite3";
import { pythonRepr, pythonTuple } from "./python_repr.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { transaction } from "./txn.js";

/**
 * G6 -- the AI invocation ledger: a missing usage record is a fact with a name.
 *
 * `docs/measurement-harness.md` sections 2.2-2.4 and `D-0038` are the design
 * this module writes to; nothing here decides anything they left open. The
 * table already ships in `migrations/0001_initial.sql`; this is its only
 * writer.
 *
 * **The failure this module is written against.** v1 measured "AI prompts"
 * from whatever the log happened to contain, and its own baseline records the
 * trap in two numbers that were never reconciled: **3,531 unique
 * assistant/model responses** and **4,960 AI tool calls**. AC-9's target is a
 * reduction against the first of those. A ledger that counts the other unit --
 * in *either* direction -- reports a reduction that does not exist:
 *
 * - counting **tool calls** compares Interlock against 4,960 and invents a
 *   reduction out of the ratio between two different units;
 * - counting the **invocation** (one row per "the AI was called") compares a
 *   coarser Interlock unit against a finer v1 numerator and *overstates* the
 *   reduction by exactly the tool-use factor -- the same error with the sign
 *   flipped. It is also the one that shows up as arithmetic rather than as
 *   opinion: an invocation's summed `output_tokens` would exceed a
 *   per-request `max_output_tokens`, which is a contradiction, not a debate.
 *
 * So `model_response_count` is **assistant turns the provider returned inside
 * this invocation: 1 plus one per tool round trip**, it is supplied by the
 * component that ran the loop and counted them, and it is neither the
 * tool-call count nor the constant 1. Section 2.2 says getting it wrong
 * breaks AC-9 in both directions; a later reader tempted to "simplify" it to
 * an invocation count is looking at the second bullet above.
 *
 * `attempt_count` is the *transport* axis and is deliberately unrelated to
 * it: a 429 followed by a successful retry is two attempts and **one**
 * assistant turn. Folding retries into the response count would make a flaky
 * network read as AI workload, which is a regression in AC-9 caused by the
 * ledger rather than by the system.
 *
 * **Why the ceiling is a column written at request time.** Section 2.4:
 * treating a missing `output_tokens` as `0` understates Interlock's token use
 * and therefore *overstates* the reduction -- a bias that always flatters the
 * target, in the criterion the target is judged by. The report's honest
 * answer is to impute a missing invocation at
 * `max_output_tokens * model_response_count`, which is a genuine lower bound
 * because the provider cannot return more output than the caller allowed.
 * That imputation is only available if the caller's ceiling was recorded
 * **before** the request, since by hypothesis no usage record ever came back
 * to read it from. {@link startInvocation} therefore writes it, and an
 * invocation started without one is *permitted* -- the caller may genuinely
 * have sent no cap -- but is then permanently un-imputable and is what the
 * report itemises as `unbounded_missing`. It stays recognisable in the row:
 * `max_output_tokens IS NULL`, forever, because nothing here ever fills it in
 * afterwards from a usage record that would not bound anything.
 *
 * **The provider seam is five columns and stops there.** Section 2.3: usage
 * figures are the one provider-shaped thing in the harness. {@link
 * ProviderUsage} is that seam -- `output_tokens` / `input_tokens` /
 * `cache_read_tokens`, plus the `usage_status` naming how complete the record
 * was and the `adapter_version` qualifying all three. Nothing else in this
 * module or in the harness above it is provider-shaped, and no provider
 * vocabulary crosses the seam: an adapter translates, it does not widen.
 * `cache_read_tokens` rides along the same seam and is *neither* an output
 * nor an input figure (`ACCEPTANCE.md` section 5, 1,399,565,488 in the
 * baseline: "a bandwidth indicator ... not new input tokens and not a billing
 * figure"), so it is stored in its own column and never added to either.
 *
 * **AC-1 is measured from these rows, so a missing `incident_id` is
 * recorded, not refused.** "Zero AI turns absent incidents" is the assertion
 * that every row here carries one (section 2.2). Refusing an invocation that
 * names no incident would destroy the only evidence the violation ever
 * existed and make AC-1 true by construction -- the measurement equivalent of
 * counting a structural zero as a triumph. {@link startInvocation} writes the
 * row and the report itemises it.
 *
 * **Append, then one usage fill-in** (`production-schema.md` section 4, the
 * writer table). `invocation_id` is the idempotency key and the writer is
 * single *by construction* -- the Dispatcher AI is on-demand and
 * incident-triggered (`D-0003`) -- which is why, unlike `watcher_liveness`,
 * no lease epoch is fenced inside these statements: there is no second
 * writer to fence against, and inventing an epoch column here would imply a
 * concurrency this component does not have. What is enforced instead is that
 * the fill-in happens **once**: {@link completeInvocation} refuses a second
 * completion rather than overwriting the first, because a re-reported usage
 * record is a different fact and the first one is evidence.
 *
 * A started-but-unfinished row carries `usage_status = 'unavailable'` -- true
 * at that instant, since no usage record has arrived -- and is told apart
 * from an invocation that *finished* without usage by
 * `finished_at_ms IS NULL`. That is the distinction, and it is why the
 * completion writes the timestamp even when the usage it carries is empty.
 *
 * Both calls take one transaction from `./txn.js`: the completion reads the
 * row's ceiling and started instant and then writes against them, and a
 * ceiling read outside the write could be stale by the time it is compared.
 *
 * Every timestamp is an integer of milliseconds since the Unix epoch and
 * comes from the caller. Nothing here reads a clock, and no *timestamp*
 * column has a `DEFAULT` (`time-base-policy.md` section 2, rule 2) -- which
 * is the rule that matters, because a defaulted timestamp would be filled
 * from the database's own clock and silently leave the caller's time base.
 * Non-timestamp columns are a different question and two of them do carry
 * one: `model_response_count` and `attempt_count` are `DEFAULT 1` in the DDL.
 * Both writers below name those columns explicitly anyway, so the default is
 * never what lands in a row this module wrote.
 */

/**
 * The closed `usage_status` vocabulary, mirrored from the table's own CHECK.
 *
 * The three members are three *different* facts and section 2.4 is built on
 * keeping them apart: `'reported'` is a complete usage record, `'partial'`
 * is some fields present with `output_tokens` absent, `'unavailable'` is no
 * usage record at all. Collapsing the last two into "missing" would lose the
 * input and cache figures a partial record did deliver; collapsing either
 * into a zero output is the bias the whole section exists to refuse.
 */
export const USAGE_STATUSES = Object.freeze(["reported", "partial", "unavailable"] as const);

/**
 * The status a row is born with. No usage record has arrived at request
 * time, which is exactly what `'unavailable'` says, so the start needs no
 * fourth member to describe itself -- and a fourth member would be a state
 * the table's CHECK does not admit.
 */
const STATUS_AT_START = "unavailable";

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/**
 * An invocation write was refused at the edge; nothing was written.
 *
 * A subclass of {@link ControlPlaneRefusal} because the answer is the same
 * one the rest of the control plane gives: state a fact that cannot be
 * recorded truthfully rather than record an approximation of it.
 *
 * **What is behind each subclass, exactly.** Most -- but not all -- of them
 * restate a constraint the DDL also holds, and the duplication there is
 * deliberate: the constraint can only say "your database rejected
 * something", while the edge knows *which* figure the caller got wrong and
 * says so.
 *
 * - Backed by a `CHECK` in `ai_invocation`: {@link UnknownUsageStatusRefused},
 *   {@link UsageStatusContradictsTokensRefused}, {@link
 *   MalformedCeilingRefused}, {@link MalformedResponseCountRefused}, {@link
 *   MalformedAttemptCountRefused}, {@link OutputExceedsRequestCeilingRefused},
 *   {@link CompletionPrecedesStartRefused}, and {@link
 *   NegativeTokenCountRefused} **for `output_tokens` only** -- the
 *   `input_tokens` and `cache_read_tokens` halves of it are this module's
 *   alone, as that subclass's own doc comment records.
 * - Backed by the `invocation_id` PRIMARY KEY rather than a `CHECK`: {@link
 *   DuplicateInvocationRefused}.
 * - Enforced by this module and nothing else: {@link
 *   UsageWithoutRecordRefused} (a status of `'unavailable'` beside an input
 *   or cache figure is a perfectly legal row to the DDL), {@link
 *   InvocationNotStartedRefused} (an `UPDATE` matching no row is not an error
 *   in SQL, it is a silent no-op), and {@link InvocationAlreadyCompleteRefused}.
 *
 * **Where the refusal happens relative to the write lock.** The checks on
 * the caller's own arguments -- the vocabulary, the status/token agreement,
 * the negative counts, the ceiling and the two counts -- run before {@link
 * transaction} is entered and therefore before the lock is taken. Four do
 * not, because they compare the caller's figures against the stored row and
 * that comparison is only sound inside the same transaction as the write:
 * {@link DuplicateInvocationRefused}, {@link
 * InvocationAlreadyCompleteRefused}, {@link CompletionPrecedesStartRefused}
 * and {@link OutputExceedsRequestCeilingRefused} are all raised with
 * `BEGIN IMMEDIATE` already held, which rolls the transaction back and
 * leaves nothing written.
 *
 * **The set-once discipline lives here, not in the DDL.** `ai_invocation`
 * carries no trigger at all: unlike `outbox_delivery_is_set_once`,
 * `action_apply_is_set_once` and `gate_transition_rows_are_immutable`, a
 * completed row here can be `UPDATE`d or `DELETE`d by any writer that goes
 * around this module, and only {@link completeInvocation} refusing a second
 * fill-in makes the one-usage-record rule hold. The DDL is quoted verbatim
 * from `measurement-harness.md` section 2.3, so an
 * `ai_invocation_usage_is_set_once` trigger is the natural backstop if the
 * design later wants one -- flagged here, not taken, because adding it would
 * be a schema decision and this is its implementation.
 */
export class AiInvocationRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AiInvocationRefused";
    Object.setPrototypeOf(this, AiInvocationRefused.prototype);
  }
}

/**
 * `usage_status` is outside {@link USAGE_STATUSES}.
 *
 * An unknown status would be counted by no branch of the coverage arithmetic
 * in section 2.4, so the invocation would silently leave both the covered
 * and the imputed populations -- a row that exists and is in no denominator.
 */
export class UnknownUsageStatusRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownUsageStatusRefused";
    Object.setPrototypeOf(this, UnknownUsageStatusRefused.prototype);
  }
}

/**
 * The status and the presence of `output_tokens` disagree.
 *
 * The DDL states it as an equivalence -- `(usage_status = 'reported') =
 * (output_tokens IS NOT NULL)` -- and both halves cost a real result.
 * `'reported'` with no tokens puts an invocation in coverage's numerator
 * while contributing nothing to the token sum, which understates
 * Interlock's usage exactly as imputing zero would. A non-`'reported'` row
 * *with* tokens is a figure the report will impute over and therefore
 * double.
 */
export class UsageStatusContradictsTokensRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UsageStatusContradictsTokensRefused";
    Object.setPrototypeOf(this, UsageStatusContradictsTokensRefused.prototype);
  }
}

/**
 * `'unavailable'` was reported alongside a usage figure.
 *
 * Section 2.3 defines `'unavailable'` as **no usage record at all**. A row
 * carrying an input or cache-read count under that status is evidence that a
 * record did arrive, so one of the two is wrong and the ledger cannot say
 * which. The honest report of a record that arrived with only some fields is
 * `'partial'`, which is why that member exists.
 */
export class UsageWithoutRecordRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UsageWithoutRecordRefused";
    Object.setPrototypeOf(this, UsageWithoutRecordRefused.prototype);
  }
}

/**
 * A token count is negative.
 *
 * The DDL guards `output_tokens` alone; the other two are guarded here for
 * the same reason and against the same failure. A negative count is not a
 * smaller number than zero in this arithmetic -- it *subtracts* from the
 * period's total and can only move the measured reduction upward, which is
 * once more the direction that flatters the target.
 */
export class NegativeTokenCountRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "NegativeTokenCountRefused";
    Object.setPrototypeOf(this, NegativeTokenCountRefused.prototype);
  }
}

/**
 * `max_output_tokens` is not a positive integer.
 *
 * `0` is the value that matters: it would make the bound
 * `max_output_tokens * model_response_count` equal zero, so a missing
 * invocation would be imputed at nothing at all. That is the "treat missing
 * as zero" bias of section 2.4 arriving through the one column that exists
 * to prevent it. `null` is legal and different -- it is the honest
 * `unbounded_missing` -- and only a recorded ceiling has to be a real one.
 */
export class MalformedCeilingRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MalformedCeilingRefused";
    Object.setPrototypeOf(this, MalformedCeilingRefused.prototype);
  }
}

/**
 * `model_response_count` is below 1.
 *
 * An invocation that reached the provider returned at least one assistant
 * turn, so zero is not a smaller count but a different claim. It would also
 * zero the imputation product, exactly as a zero ceiling does.
 */
export class MalformedResponseCountRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MalformedResponseCountRefused";
    Object.setPrototypeOf(this, MalformedResponseCountRefused.prototype);
  }
}

/**
 * `attempt_count` is below 1.
 *
 * The first send is an attempt. A zero here would describe an invocation
 * that was never transmitted, which has no usage record to complete.
 */
export class MalformedAttemptCountRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MalformedAttemptCountRefused";
    Object.setPrototypeOf(this, MalformedAttemptCountRefused.prototype);
  }
}

/**
 * The reported output exceeds `max_output_tokens * model_response_count`.
 *
 * **The ceiling is per request, and an invocation makes
 * `model_response_count` of them**, so the invocation's ceiling is the
 * product. The DDL says in terms that comparing the summed output against a
 * single request's cap "would fail on every tool-using invocation" -- so
 * this refusal must be computed against the product, and a future
 * simplification to the flat cap would refuse every honest agentic loop
 * while looking stricter.
 *
 * Reaching it the other way round means the caller's own arithmetic is
 * inconsistent -- the provider cannot return more than it was allowed -- and
 * the bound in section 2.4 stops being a bound if such a row is stored.
 */
export class OutputExceedsRequestCeilingRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "OutputExceedsRequestCeilingRefused";
    Object.setPrototypeOf(this, OutputExceedsRequestCeilingRefused.prototype);
  }
}

/**
 * `finished_at_ms` is earlier than the row's `started_at_ms`.
 *
 * Latency is measured off these two columns, and a negative duration is not
 * a small one: it is a clock the caller mixed. `time-base-policy.md`
 * section 2 puts the clock in the caller's hands precisely so this is
 * checkable here.
 */
export class CompletionPrecedesStartRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CompletionPrecedesStartRefused";
    Object.setPrototypeOf(this, CompletionPrecedesStartRefused.prototype);
  }
}

/**
 * No invocation with this id was ever started.
 *
 * The completion is a fill-in, never an upsert. Inserting the row here
 * instead would manufacture a `started_at_ms` out of the completion instant
 * and hand every such invocation a zero latency and no recorded ceiling.
 */
export class InvocationNotStartedRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "InvocationNotStartedRefused";
    Object.setPrototypeOf(this, InvocationNotStartedRefused.prototype);
  }
}

/**
 * This invocation's usage was already filled in once.
 *
 * `production-schema.md` section 4 allows the row exactly one usage
 * fill-in. A second report is a *different* fact -- a retried parse, a
 * duplicated callback, a second adapter -- and overwriting would replace
 * evidence with the most recent claim about it, which is the arrival-order
 * last-write-wins the control plane refuses everywhere else.
 */
export class InvocationAlreadyCompleteRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "InvocationAlreadyCompleteRefused";
    Object.setPrototypeOf(this, InvocationAlreadyCompleteRefused.prototype);
  }
}

/**
 * An invocation with this id was already started.
 *
 * `invocation_id` is the idempotency key of a single writer, so a repeat is
 * not a benign re-poll: it is either a caller reusing an id (and about to
 * make two invocations indistinguishable in every report) or a lost response
 * treated as a new request. Both need the caller to know.
 */
export class DuplicateInvocationRefused extends AiInvocationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DuplicateInvocationRefused";
    Object.setPrototypeOf(this, DuplicateInvocationRefused.prototype);
  }
}

/**
 * The caller used this module in a way that would break its guarantees.
 *
 * A programming error rather than a refusable fact -- a non-integer clock,
 * an empty identifier -- and therefore not part of the {@link
 * AiInvocationRefused} hierarchy a caller handles. Mirrors the source's
 * `ValueError`: not a {@link ControlPlaneRefusal}.
 */
export class AiInvocationUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AiInvocationUsageError";
    Object.setPrototypeOf(this, AiInvocationUsageError.prototype);
  }
}

// --------------------------------------------------------------------------
// argument checks
// --------------------------------------------------------------------------

function requireIdentifier(field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AiInvocationUsageError(
      `${field} must be a non-empty string, got ${pythonRepr(value)}`,
    );
  }
}

function requireOptionalIdentifier(field: string, value: string | null): void {
  if (value !== null) {
    requireIdentifier(field, value);
  }
}

function requireInt(field: string, value: unknown): void {
  // A bool is excluded implicitly here too: `typeof true` is `"boolean"`, not
  // `"number"`, so it fails the `typeof` check on its own -- unlike Python,
  // where `bool` is a subclass of `int` and needs an explicit exclusion.
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AiInvocationUsageError(
      `${field} must be an int, got ${pythonRepr(value)}; the clock and the counts ` +
        "are the caller's and are never derived from the database",
    );
  }
}

function requireOptionalCount(field: string, value: number | null): void {
  if (value === null) {
    return;
  }
  requireInt(field, value);
  if (value < 0) {
    throw new NegativeTokenCountRefused(
      `${field} must not be negative, got ${value}; a negative count ` +
        "subtracts from the period's token total and can only move the " +
        "measured reduction upward (measurement-harness.md section 2.4)",
    );
  }
}

// --------------------------------------------------------------------------
// the provider seam
// --------------------------------------------------------------------------

/**
 * What a provider adapter reports back, and the whole of what it reports.
 *
 * Five fields, matching section 2.3's seam exactly: the three token figures,
 * the `usageStatus` saying how complete the record was, and the
 * `adapterVersion` that qualifies all of them. Anything a provider says that
 * is not one of these is the adapter's business and stops at this boundary --
 * the report's `adapter_versions` set (section 6) is how a change in the
 * translation is made visible, and it is only meaningful while the
 * translation happens on the provider's side of the seam.
 *
 * `modelResponseCount` and `attemptCount` are deliberately **not** here.
 * They are counted by the component that ran the loop, not parsed out of a
 * usage record: a provider that reports usage per request cannot tell us how
 * many requests our loop made, and a provider whose response never arrived
 * still made an attempt we must count.
 *
 * Construct through {@link ProviderUsage.reported}, {@link
 * ProviderUsage.partial} or {@link ProviderUsage.unavailable} rather than by
 * hand -- each one makes its status and its tokens agree by construction,
 * which is the invariant the DDL states as an equivalence. The plain
 * constructor performs no validation of its own, mirroring the source's
 * frozen dataclass: an out-of-vocabulary `usageStatus` constructs cleanly and
 * is refused only where it reaches {@link completeInvocation}, which is the
 * one case the ported suite constructs directly.
 */
export class ProviderUsage {
  readonly usageStatus: string;
  readonly adapterVersion: string;
  readonly outputTokens: number | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;

  constructor(options: {
    readonly usageStatus: string;
    readonly adapterVersion: string;
    readonly outputTokens?: number | null;
    readonly inputTokens?: number | null;
    readonly cacheReadTokens?: number | null;
  }) {
    this.usageStatus = options.usageStatus;
    this.adapterVersion = options.adapterVersion;
    this.outputTokens = options.outputTokens ?? null;
    this.inputTokens = options.inputTokens ?? null;
    this.cacheReadTokens = options.cacheReadTokens ?? null;
    // The source is `@dataclass(frozen=True)`, so assignment after
    // construction raises. `readonly` alone is erased at emit, and this record
    // exists precisely so a usage cannot change between the validation and the
    // UPDATE that writes it -- a window a compile-time-only guarantee does not
    // cover.
    Object.freeze(this);
  }

  /** A complete usage record: the provider returned an output figure. */
  static reported(options: {
    readonly adapterVersion: string;
    readonly outputTokens: number;
    readonly inputTokens?: number | null;
    readonly cacheReadTokens?: number | null;
  }): ProviderUsage {
    return new ProviderUsage({
      usageStatus: "reported",
      adapterVersion: options.adapterVersion,
      outputTokens: options.outputTokens,
      inputTokens: options.inputTokens ?? null,
      cacheReadTokens: options.cacheReadTokens ?? null,
    });
  }

  /**
   * A record arrived, without `outputTokens`.
   *
   * The fields that *did* arrive are kept: they are facts, and discarding
   * them because the headline figure is missing would throw away the input
   * and cache series the report prints in their own right.
   */
  static partial(options: {
    readonly adapterVersion: string;
    readonly inputTokens?: number | null;
    readonly cacheReadTokens?: number | null;
  }): ProviderUsage {
    return new ProviderUsage({
      usageStatus: "partial",
      adapterVersion: options.adapterVersion,
      inputTokens: options.inputTokens ?? null,
      cacheReadTokens: options.cacheReadTokens ?? null,
    });
  }

  /**
   * No usage record at all -- the case section 2.4 imputes a bound for.
   *
   * It takes no token arguments on purpose: there is nothing to carry, and a
   * parameter would invite a caller to pass a zero that the report would
   * then read as a measured figure.
   */
  static unavailable(options: { readonly adapterVersion: string }): ProviderUsage {
    return new ProviderUsage({
      usageStatus: "unavailable",
      adapterVersion: options.adapterVersion,
    });
  }
}

/** Check the seam's own invariants before any of it reaches a statement. */
function validateUsage(usage: ProviderUsage): void {
  if (!(usage instanceof ProviderUsage)) {
    throw new AiInvocationUsageError(
      `usage must be a ProviderUsage, got ${pythonRepr(usage)}; the provider seam ` +
        "is a typed object so that a mapping with a provider's own field " +
        "names cannot cross it",
    );
  }
  requireIdentifier("usage.adapter_version", usage.adapterVersion);
  if (!(USAGE_STATUSES as readonly string[]).includes(usage.usageStatus)) {
    throw new UnknownUsageStatusRefused(
      `usage_status must be one of ${pythonTuple(USAGE_STATUSES)}, got ` +
        `${pythonRepr(usage.usageStatus)}; an unknown status belongs to no branch of ` +
        "the coverage arithmetic and would leave the invocation in no " +
        "denominator at all",
    );
  }
  requireOptionalCount("usage.output_tokens", usage.outputTokens);
  requireOptionalCount("usage.input_tokens", usage.inputTokens);
  requireOptionalCount("usage.cache_read_tokens", usage.cacheReadTokens);

  if ((usage.usageStatus === "reported") !== (usage.outputTokens !== null)) {
    throw new UsageStatusContradictsTokensRefused(
      `usage_status ${pythonRepr(usage.usageStatus)} and output_tokens ` +
        `${pythonRepr(usage.outputTokens)} disagree: 'reported' means the provider ` +
        "returned an output figure and every other status means it did not. " +
        "A 'reported' row without tokens counts as covered while adding " +
        "nothing to the sum; a missing-status row with tokens is imputed " +
        "over and counted twice",
    );
  }
  if (
    usage.usageStatus === "unavailable" &&
    (usage.inputTokens !== null || usage.cacheReadTokens !== null)
  ) {
    throw new UsageWithoutRecordRefused(
      "usage_status 'unavailable' means no usage record at all " +
        "(measurement-harness.md section 2.3), but input_tokens " +
        `${pythonRepr(usage.inputTokens)} / cache_read_tokens ` +
        `${pythonRepr(usage.cacheReadTokens)} say one arrived; report a record that ` +
        "arrived incomplete as 'partial'",
    );
  }
}

// --------------------------------------------------------------------------
// the writer
// --------------------------------------------------------------------------

/**
 * Record an invocation at **request** time, before the provider answers.
 *
 * Everything this row needs in order to be bounded later is known now and
 * nothing that is known now is left for the completion to supply, because
 * the completion may never happen: a process killed mid-request, a provider
 * that never returns, a usage record lost in transport. Section 2.4's whole
 * argument turns on that asymmetry.
 *
 * `maxOutputTokens` is the caller's own per-request cap and is the
 * load-bearing one. With it, a missing invocation is imputed at
 * `maxOutputTokens * modelResponseCount` -- a genuine *lower bound* on the
 * reduction, because the provider cannot return more output than it was
 * allowed. Without it the invocation is un-imputable and the report itemises
 * it as `unbounded_missing`; a report with a non-zero count there cannot
 * support an AC-9 acceptance claim. Passing `null` is therefore permitted
 * and is not a shortcut: it is the honest record of a request that carried
 * no cap.
 *
 * `incidentId` is likewise optional and likewise consequential. AC-1 ("zero
 * AI turns absent incidents") is the assertion that every row here carries
 * one, so an invocation with none is written and reported as a violation
 * rather than refused -- refusing it would erase the only evidence the
 * violation happened.
 *
 * **`modelResponseCount` written here is a request-time PLACEHOLDER of `1`,
 * not a count.** Nobody can know the number of assistant turns before the
 * provider has answered; the real figure is supplied by the component that
 * ran the loop and lands in {@link completeInvocation}. The placeholder is
 * consequential in exactly one direction, and it is the flattering one:
 * section 2.4 imputes a non-`'reported'` invocation at
 * `maxOutputTokens * modelResponseCount`, so a four-turn invocation whose
 * process was killed mid-loop would be imputed at `cap * 1` -- a quarter of
 * its real bound. That *understates* Interlock's tokens and therefore
 * *overstates* the reduction, which is the bias section 2.4 exists to
 * refuse.
 *
 * So the placeholder must never be imputed at the product.
 * `finished_at_ms IS NULL` is the discriminator -- it is what tells a
 * never-completed row from one that finished -- and a row on that side of it
 * carries a response count no writer has ever confirmed. A report must
 * itemise those rows separately (as in-flight or abandoned) rather than fold
 * them into the imputed population. The column and the DDL are left as
 * `measurement-harness.md` section 2.3 gives them; what is fixed here is
 * that the value's meaning is written down where a later reader of the table
 * will find it.
 *
 * `adapterVersion` is the version of the adapter issuing the request. It is
 * `NOT NULL` and a row must therefore carry one from the start; {@link
 * completeInvocation} replaces it with the version that actually parsed the
 * usage, since that is what the figures are qualified by.
 *
 * @throws {DuplicateInvocationRefused} if the id was already started.
 * @throws {MalformedCeilingRefused} if `maxOutputTokens` is not positive.
 */
export function startInvocation(
  connection: SqliteDatabase,
  options: {
    readonly invocationId: string;
    readonly provider: string;
    readonly model: string;
    readonly adapterVersion: string;
    readonly startedAtMs: number;
    readonly incidentId?: string | null;
    readonly runId?: string | null;
    readonly maxOutputTokens?: number | null;
  },
): void {
  const {
    invocationId,
    provider,
    model,
    adapterVersion,
    startedAtMs,
    incidentId = null,
    runId = null,
    maxOutputTokens = null,
  } = options;

  requireIdentifier("invocation_id", invocationId);
  requireIdentifier("provider", provider);
  requireIdentifier("model", model);
  requireIdentifier("adapter_version", adapterVersion);
  requireOptionalIdentifier("incident_id", incidentId);
  requireOptionalIdentifier("run_id", runId);
  requireInt("started_at_ms", startedAtMs);
  if (maxOutputTokens !== null) {
    requireInt("max_output_tokens", maxOutputTokens);
    if (maxOutputTokens <= 0) {
      throw new MalformedCeilingRefused(
        `max_output_tokens must be positive when recorded, got ` +
          `${maxOutputTokens}; a zero ceiling imputes a missing ` +
          "invocation at nothing, which is the treat-missing-as-zero bias " +
          "the column exists to remove. Pass null to record honestly that " +
          "the request carried no cap",
      );
    }
  }

  transaction(connection, (tx) => {
    const already = tx
      .prepare<[string], { started_at_ms: number }>(
        "SELECT started_at_ms FROM ai_invocation WHERE invocation_id = ?",
      )
      .get(invocationId);
    if (already !== undefined) {
      throw new DuplicateInvocationRefused(
        `invocation ${pythonRepr(invocationId)} was already started at ` +
          `${already.started_at_ms}; the id is this writer's idempotency key, so a ` +
          "repeat makes two invocations indistinguishable in every report " +
          "rather than deduplicating one",
      );
    }
    tx.prepare<{
      invocation_id: string;
      incident_id: string | null;
      run_id: string | null;
      provider: string;
      model: string;
      adapter_version: string;
      usage_status: string;
      max_output_tokens: number | null;
      started_at_ms: number;
    }>(
      `
            INSERT INTO ai_invocation (
                    invocation_id, incident_id, run_id, provider, model,
                    adapter_version, usage_status, output_tokens, input_tokens,
                    cache_read_tokens, max_output_tokens, model_response_count,
                    attempt_count, started_at_ms, finished_at_ms)
            VALUES (:invocation_id, :incident_id, :run_id, :provider, :model,
                    :adapter_version, :usage_status, NULL, NULL,
                    -- model_response_count = 1 is a PLACEHOLDER, not a count:
                    -- the turns are unknown until the provider has answered,
                    -- and complete_invocation writes the real figure. A row
                    -- with finished_at_ms IS NULL therefore carries an
                    -- unconfirmed 1, and imputing it at max_output_tokens * 1
                    -- would bound a crashed multi-turn invocation at a
                    -- fraction of its real cap -- understating Interlock's
                    -- tokens and overstating the reduction (2.4). Both counts
                    -- are named explicitly rather than left to their DDL
                    -- DEFAULT 1, so the value is visible at the write site.
                    NULL, :max_output_tokens, 1,
                    1, :started_at_ms, NULL)
            `,
    ).run({
      invocation_id: invocationId,
      incident_id: incidentId,
      run_id: runId,
      provider,
      model,
      adapter_version: adapterVersion,
      // True at this instant: no usage record has arrived. The row is told
      // apart from an invocation that finished without usage by
      // finished_at_ms IS NULL, not by a fourth status.
      usage_status: STATUS_AT_START,
      max_output_tokens: maxOutputTokens,
      started_at_ms: startedAtMs,
    });
  });
}

/**
 * Fill in the usage the provider reported, once.
 *
 * `modelResponseCount` is **assistant turns returned**: 1, plus one per tool
 * round trip. It is not the number of tool calls (v1's 4,960, the figure
 * AC-9 is *not* measured against) and it is not 1-per-invocation (which
 * would overstate the reduction by the tool-use factor and let a summed
 * output exceed a per-request cap). The component that ran the loop counts
 * them; no part of this module infers it.
 *
 * `attemptCount` is transport retries and contributes to no response count:
 * a 429 plus a successful retry is `attemptCount=2` and
 * `modelResponseCount=1`. Adding retries into the response count would
 * report a flaky network as AI workload.
 *
 * The two are checked against the recorded ceiling **inside** the same
 * transaction as the write, because the comparison that matters is
 * `outputTokens <= maxOutputTokens * modelResponseCount` and both operands
 * must come from the row as it is being updated.
 *
 * @throws {InvocationNotStartedRefused} if the id was never started.
 * @throws {InvocationAlreadyCompleteRefused} if usage was already filled in.
 * @throws {OutputExceedsRequestCeilingRefused} if the output exceeds the
 *   product of the recorded ceiling and the response count.
 */
export function completeInvocation(
  connection: SqliteDatabase,
  options: {
    readonly invocationId: string;
    readonly usage: ProviderUsage;
    readonly modelResponseCount: number;
    readonly finishedAtMs: number;
    readonly attemptCount?: number;
  },
): void {
  const { invocationId, usage, modelResponseCount, finishedAtMs, attemptCount = 1 } = options;

  requireIdentifier("invocation_id", invocationId);
  requireInt("model_response_count", modelResponseCount);
  requireInt("attempt_count", attemptCount);
  requireInt("finished_at_ms", finishedAtMs);
  validateUsage(usage);
  if (modelResponseCount < 1) {
    throw new MalformedResponseCountRefused(
      `model_response_count must be at least 1, got ` +
        `${modelResponseCount}; an invocation that reached the provider ` +
        "returned at least one assistant turn, and a zero would also zero " +
        "the imputation product a missing invocation is bounded by",
    );
  }
  if (attemptCount < 1) {
    throw new MalformedAttemptCountRefused(
      `attempt_count must be at least 1, got ${attemptCount}; the first ` +
        "send is an attempt, so a zero describes an invocation that was " +
        "never transmitted and therefore has no usage to report",
    );
  }

  transaction(connection, (tx) => {
    const row = tx
      .prepare<
        [string],
        { started_at_ms: number; finished_at_ms: number | null; max_output_tokens: number | null }
      >(
        `
            SELECT started_at_ms, finished_at_ms, max_output_tokens
              FROM ai_invocation
             WHERE invocation_id = ?
            `,
      )
      .get(invocationId);
    if (row === undefined) {
      throw new InvocationNotStartedRefused(
        `invocation ${pythonRepr(invocationId)} was never started; the usage ` +
          "fill-in is not an upsert, and inserting here would invent a " +
          "started_at_ms out of the completion instant -- a zero latency " +
          "and no recorded ceiling for every such invocation",
      );
    }
    const startedAtMs = row.started_at_ms;
    const alreadyFinishedAtMs = row.finished_at_ms;
    const maxOutputTokens = row.max_output_tokens;
    if (alreadyFinishedAtMs !== null) {
      throw new InvocationAlreadyCompleteRefused(
        `invocation ${pythonRepr(invocationId)} was already completed at ` +
          `${alreadyFinishedAtMs}; the row takes exactly one usage ` +
          "fill-in (production-schema.md section 4) and a second report " +
          "is a different fact, not a correction of the first",
      );
    }
    if (finishedAtMs < startedAtMs) {
      throw new CompletionPrecedesStartRefused(
        `finished_at_ms ${finishedAtMs} precedes started_at_ms ` +
          `${startedAtMs} for invocation ${pythonRepr(invocationId)}; latency is ` +
          "measured off these two columns and a negative duration is a " +
          "mixed clock rather than a small number",
      );
    }
    if (usage.outputTokens !== null && maxOutputTokens !== null) {
      // The ceiling is PER REQUEST and the invocation made
      // modelResponseCount of them, so the invocation's ceiling is the
      // product. Comparing against the flat cap instead would refuse every
      // tool-using invocation -- the DDL comment says so in as many words.
      const ceiling = maxOutputTokens * modelResponseCount;
      if (usage.outputTokens > ceiling) {
        throw new OutputExceedsRequestCeilingRefused(
          `invocation ${pythonRepr(invocationId)} reports ` +
            `${usage.outputTokens} output tokens against a ceiling of ` +
            `${maxOutputTokens} per request x ${modelResponseCount} ` +
            `responses = ${ceiling}; the provider cannot return more ` +
            "than the caller allowed, so one of the three figures is " +
            "wrong and storing the row would stop the bounded " +
            "reduction of section 2.4 being a bound",
        );
      }
    }

    tx.prepare<{
      invocation_id: string;
      adapter_version: string;
      usage_status: string;
      output_tokens: number | null;
      input_tokens: number | null;
      cache_read_tokens: number | null;
      model_response_count: number;
      attempt_count: number;
      finished_at_ms: number;
    }>(
      `
            UPDATE ai_invocation
               SET adapter_version      = :adapter_version,
                   usage_status         = :usage_status,
                   output_tokens        = :output_tokens,
                   input_tokens         = :input_tokens,
                   cache_read_tokens    = :cache_read_tokens,
                   model_response_count = :model_response_count,
                   attempt_count        = :attempt_count,
                   finished_at_ms       = :finished_at_ms
             WHERE invocation_id = :invocation_id
               AND finished_at_ms IS NULL
            `,
    ).run({
      invocation_id: invocationId,
      // The version that PARSED the usage, which is what the three token
      // figures are qualified by. In every non-rolling-deploy case it is the
      // version that issued the request; when it is not, the report's
      // adapter_versions set (section 6) is what makes the change visible,
      // and it can only do that if the row names the translation that
      // actually happened.
      adapter_version: usage.adapterVersion,
      usage_status: usage.usageStatus,
      output_tokens: usage.outputTokens,
      input_tokens: usage.inputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      model_response_count: modelResponseCount,
      attempt_count: attemptCount,
      finished_at_ms: finishedAtMs,
    });
  });
}

/**
 * One invocation's row, or `undefined` if the id was never started.
 *
 * A single-row read, deliberately not an aggregate: coverage, the
 * imputations and the `unbounded_missing` itemisation are the report's
 * arithmetic and the report is a separate, read-only instrument (`D-0040`).
 * This exists so that a caller -- and the suite -- can see what was recorded
 * without hand-writing SQL against a table it does not own.
 *
 * Returned exactly as read -- the database's own snake_case column names --
 * because this is a raw projection of one row, not a typed value this module
 * owns the shape of (`D-0007`: a row that does not exist reads back as
 * `undefined`, not `null`).
 */
export function readInvocation(
  connection: SqliteDatabase,
  invocationId: string,
): Readonly<Record<string, unknown>> | undefined {
  requireIdentifier("invocation_id", invocationId);
  const row = connection
    .prepare<[string], Record<string, unknown>>(
      "SELECT * FROM ai_invocation WHERE invocation_id = ?",
    )
    .get(invocationId);
  // Frozen, because the source returns `MappingProxyType(dict(...))` -- a
  // mapping whose mutation raises at RUNTIME. A `Readonly<>` type is erased at
  // emit, so a plain-JavaScript caller (or one `as any`) would edit the row a
  // reader handed back. Every sibling module that ports a `MappingProxyType`
  // freezes it (events.ts, ci_ingest.ts, repo_link.ts); this one had not.
  return row === undefined ? undefined : Object.freeze(row);
}
