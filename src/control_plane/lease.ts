import { randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { pythonList, pythonRepr, pythonTuple } from "./python_repr.js";

/**
 * S6 -- the lease, and the fencing token validated atomically with each write.
 *
 * **Spike scaffold, throwaway by default (D-0026).** This implementation may be
 * discarded; its *tests* are the durable half. Nothing here is promoted into the
 * real implementation by having discharged a gate item. `Q-0001` -- which
 * component may hold which resource -- was open when this module was written;
 * D-0029 has since resolved it in the production schema
 * (`docs/production-schema.md` section 4.2, `migrations/0001_initial.sql`), but
 * this module still runs against the S5 spike schema that predates the answer,
 * so {@link Lease.holder} stays an opaque claimant identity here and
 * deliberately not a role.
 *
 * `ACCEPTANCE.md` section 2 states the requirement and names the wrong answer in
 * the same breath: **expiry discovery alone is insufficient**, because the lease
 * can expire between the check and the write. So there is no `isHeld()` that a
 * caller is expected to consult before writing. Every protected write carries
 * the lease epoch and validates it **inside the write**, as one statement:
 *
 * ```sql
 * UPDATE outbox
 *    SET status = 'delivered', writer_epoch = :fence_epoch
 *  WHERE message_id = :message_id
 *    AND EXISTS (SELECT 1 FROM lease
 *                 WHERE resource = :fence_resource AND holder = :fence_holder
 *                   AND epoch = :fence_epoch AND expires_at_ms > :fence_now_ms)
 * ```
 *
 * {@link protectedWrite} accepts only a {@link ProtectedWrite}, whose `statement`
 * is a {@link FencedStatement} that only the typed builders can issue and which
 * always carries {@link FENCE_SQL} in the write's own predicate, so the unfenced
 * shape cannot reach the database through this module at all.
 *
 * **Why the epoch and not the expiry is what a write validates.** Time is the
 * caller's throughout -- every function takes `nowMs` and the database has no
 * clock of its own (the schema gives no timestamp a `DEFAULT` for exactly this
 * reason). Under clock skew two holders really can overlap in *true* time: a
 * claimant whose clock runs fast sees a lease as expired while its holder still
 * believes it live, and takes it over. Worse, the rows cannot show that: each
 * claimant stamps its acquisition in its own frame, so the recorded windows come
 * out disjoint while the real ones are not. A timeline of lease rows is only ever
 * as truthful as the clocks that wrote it.
 *
 * What cannot overlap is **write authority**, because taking the lease over
 * raises the epoch and the old token then matches nothing. The exclusion is the
 * fence's, never the clock's -- see {@link authorityTimeline}, which orders by
 * epoch, and {@link claimedTimeline}, which shows what the clocks claimed and is
 * not the same thing.
 *
 * **No test here may lean on a provider refusing a duplicate.** Under C2 the
 * provider's own "already in use" refusal has a measured admission window (U27)
 * and the `--resume` path excludes nothing at all (U32,
 * `investigation/pre-spawn-fence-search.md` section 5.3). This module therefore
 * imports nothing from the session provider and must keep working with the
 * provider's refusal assumed absent; the suite asserts the absence of that
 * import edge rather than describing it. **The module is self-contained**: no
 * import of `txn.ts` or `events.ts`, matching the source's own `re` / `sqlite3`
 * / `uuid`-only import list.
 *
 * **Refusals are recorded, never dropped.** A write refused for a stale token is
 * an `action` row in status `refused` carrying the reason, the epoch that was
 * refused, and the lease row as it actually stood. That record is written
 * **unfenced**, deliberately: a refusal that could only be recorded by a live
 * holder is a refusal that vanishes exactly when it matters.
 */

// --------------------------------------------------------------------------
// the module's replaceable internals (D-0014)
// --------------------------------------------------------------------------

/**
 * The module's one replaceable internal: the id generator behind an unnamed
 * refusal's `action_id`.
 *
 * The source calls `uuid.uuid4().hex` inline in `_record_refusal`, and
 * nothing in `test_lease.py` patches it -- every case that reaches that path
 * passes its own `attempt_id` explicitly (`attempt_id="refusal-1"`, etc.),
 * so the source suite never needs to pin the generated id and never
 * monkeypatches `uuid`. A translated case that *does* need a fixed refusal
 * id for an unnamed attempt has no other way to get one than a seam, so this
 * one is provided anyway, per D-0014's own reasoning: a seam nothing routes
 * through is worse than none. The one internal call site
 * ({@link _recordRefusal}) goes through it.
 *
 * Not re-exported from `src/index.ts`: it is a testing seam, not public API.
 */
export const leaseSeams = {
  /** `uuid.uuid4().hex`: a lower-case 32-character hex string, no dashes. */
  uuid4Hex: (): string => randomUUID().replace(/-/g, ""),
};

// --------------------------------------------------------------------------
// constants
// --------------------------------------------------------------------------

/**
 * The fence, as the exact text every builder-issued statement carries. It is a
 * constant rather than a template because the builders splice it in verbatim:
 * a fence assembled by string surgery would be a fence that can be assembled
 * slightly wrong, and the failure would be invisible in the row that results.
 * What {@link protectedWrite} enforces is the {@link FencedStatement} type,
 * not a scan for this text -- see that class for why a substring test cannot
 * tell a fence that gates a write from one parked somewhere harmless.
 */
export const FENCE_SQL =
  "EXISTS (SELECT 1 FROM lease\n" +
  "                    WHERE resource = :fence_resource\n" +
  "                      AND holder = :fence_holder\n" +
  "                      AND epoch = :fence_epoch\n" +
  "                      AND expires_at_ms > :fence_now_ms)";

/**
 * The parameter names {@link protectedWrite} binds itself. A caller's own
 * parameters may not use them -- silently overwriting the fence's resource or
 * epoch with the caller's value would leave a statement that still *looks*
 * fenced.
 */
export const FENCE_PARAMS = Object.freeze([
  "fence_resource",
  "fence_holder",
  "fence_epoch",
  "fence_now_ms",
] as const);

/**
 * The three answers `ACCEPTANCE.md` section 2 accepts to "how is this effect
 * made exactly-once?", mirrored from the `action` table's `CHECK`. Every
 * protected write names one; a write that cannot name one is a human gate
 * (D-0004), not an automatic retry.
 */
export const EXACTLY_ONCE_MECHANISMS = Object.freeze([
  "destination_idempotency_key",
  "transactional_with_record",
  "human_gate",
] as const);

/**
 * The write history, as data, so it can be run by hand against a database
 * recovered from a crash (D-0001). The spike `action` table has no resource
 * column -- which component owns which state item was `Q-0001` and open on
 * this schema (D-0029 has since answered it in the production schema, section
 * 4.2, but this module still runs against the spike table) -- so the caller
 * names the effect *kind* it wants the history of, and {@link effectKind} is
 * how a kind carries the resource whose epochs its rows were written under --
 * which is also what lets this filter by resource across every effect taken
 * under one lease.
 *
 * The order is `rowid`, the database's own insertion order, and **not**
 * `created_at_ms`. The timestamp is the caller's clock (that is the point of
 * the whole module), so under the skew `ACCEPTANCE.md` section 2 injects it
 * can disagree with the order the rows were actually written in -- and an
 * ordering claim read out of a skewed clock would manufacture regressions
 * that never happened and hide ones that did.
 */
export const WRITE_HISTORY_QUERY = `
    SELECT rowid AS write_seq, action_id, kind, status, writer_epoch,
           refusal_reason, created_at_ms, applied_at_ms
      FROM action
     WHERE writer_epoch IS NOT NULL
       AND (:kind IS NULL OR kind = :kind)
       AND (:resource IS NULL
            OR substr(kind, -(length(:resource) + 1)) = '@' || :resource)
     ORDER BY write_seq
`;

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/** A lease operation was refused. Nothing was written past the refusal. */
export class LeaseRefusal extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LeaseRefusal";
    Object.setPrototypeOf(this, LeaseRefusal.prototype);
  }
}

/** Acquisition refused: the resource has a live holder at the caller's clock. */
export class LeaseHeld extends LeaseRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LeaseHeld";
    Object.setPrototypeOf(this, LeaseHeld.prototype);
  }
}

/**
 * Renewal or release refused: this token is not the live one any more.
 *
 * Raised when the epoch has moved on (someone took the lease over), when the
 * holder differs, or -- for a renewal -- when the lease had already expired.
 * An expired lease is **not** renewable: re-acquiring is what a returning
 * holder must do, and re-acquiring raises the epoch, which is precisely what
 * invalidates the token it came back with.
 */
export class LeaseNotHeld extends LeaseRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LeaseNotHeld";
    Object.setPrototypeOf(this, LeaseNotHeld.prototype);
  }
}

/**
 * A renewal whose new expiry would land at or before the acquisition.
 *
 * Only reachable with the caller's clock skewed backwards past the moment the
 * lease was taken. Refusing is the safe direction: the alternative is an
 * `expires_at_ms > acquired_at_ms` `CHECK` violation surfacing as a generic
 * integrity error from inside a write the caller believed was a renewal.
 */
export class ClockSkewRefused extends LeaseRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ClockSkewRefused";
    Object.setPrototypeOf(this, ClockSkewRefused.prototype);
  }
}

/**
 * A protected write was refused because its fencing token was not live.
 *
 * The refusal is durable before this is raised: {@link actionId} names the
 * `action` row in status `refused` that records it, and {@link observed} is
 * the lease row as it actually stood at the moment of the refusal
 * (`undefined` if the resource had no row at all -- D-0007).
 */
export class StaleWriterRefused extends LeaseRefusal {
  readonly actionId: string;
  readonly observed: Lease | undefined;

  constructor(
    message: string,
    options: {
      readonly actionId: string;
      readonly observed: Lease | undefined;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StaleWriterRefused";
    this.actionId = options.actionId;
    this.observed = options.observed;
    Object.setPrototypeOf(this, StaleWriterRefused.prototype);
  }
}

/**
 * The fence held, but the caller's own `WHERE` clause matched no row.
 *
 * Distinguished from {@link StaleWriterRefused} on purpose, and no refusal is
 * recorded for it: writing a "stale writer" row for a write that missed
 * because its target did not exist would put a rejection that never happened
 * into the evidence gate item 5 is read out of.
 */
export class ProtectedWriteMissed extends LeaseRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ProtectedWriteMissed";
    Object.setPrototypeOf(this, ProtectedWriteMissed.prototype);
  }
}

/**
 * A statement was handed to {@link protectedWrite} without the fence.
 *
 * A programming error, not a runtime condition: the caller wrote the
 * check-then-write shape `ACCEPTANCE.md` section 2 rules out, and this
 * module refuses to be the path by which it reaches the database.
 *
 * Mirrors the source's `ValueError` subclass: not a {@link LeaseRefusal}.
 */
export class UnfencedStatement extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnfencedStatement";
    Object.setPrototypeOf(this, UnfencedStatement.prototype);
  }
}

/**
 * The caller used this module in a way that would break its guarantees.
 *
 * Mirrors the source's `ValueError` subclass: not a {@link LeaseRefusal}.
 */
export class LeaseUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LeaseUsageError";
    Object.setPrototypeOf(this, LeaseUsageError.prototype);
  }
}

/**
 * An external destination refused a write carrying an outdated epoch.
 *
 * Raised by {@link EpochGuardedDestination}. It is the destination's own
 * refusal, not ours -- which is what `ACCEPTANCE.md` section 2 requires for
 * an external effect, since our rows cannot tell an effect that completed
 * from one that never started.
 */
export class DestinationRejectedStaleToken extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DestinationRejectedStaleToken";
    Object.setPrototypeOf(this, DestinationRejectedStaleToken.prototype);
  }
}

// --------------------------------------------------------------------------
// message rendering (D-0017)
// --------------------------------------------------------------------------

/** One `lease` row, rendered the way `_describe` renders it in the source. */
function describeLease(lease: Lease | undefined): string {
  if (lease === undefined) {
    return "absent";
  }
  return (
    `holder=${pythonRepr(lease.holder)} epoch=${lease.epoch} ` +
    `acquired_at_ms=${lease.acquiredAtMs} expires_at_ms=${lease.expiresAtMs}`
  );
}

// --------------------------------------------------------------------------
// argument checks -- defined here because the destination register below is
// built at import time and validates itself with them
// --------------------------------------------------------------------------

function requireIdentifier(field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LeaseUsageError(`${field} must be a non-empty string, got ${pythonRepr(value)}`);
  }
}

function requireInt(field: string, value: unknown): void {
  // A bool fails `typeof value !== "number"` on its own in TypeScript, unlike
  // Python where `bool` is an `int` subclass and needs an explicit exclusion.
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LeaseUsageError(
      `${field} must be an int of epoch milliseconds, got ${pythonRepr(value)}`,
    );
  }
}

// --------------------------------------------------------------------------
// the lease itself
// --------------------------------------------------------------------------

/**
 * A held lease, and the fencing token that goes with it.
 *
 * The token is `(resource, holder, epoch)`. The timestamps are carried for
 * evidence and for {@link claimedTimeline}; they are never what a write
 * validates.
 *
 * Frozen at construction (`Object.freeze`), mirroring the source's
 * `@dataclass(frozen=True)` -- lesson: a runtime guarantee the source has
 * must stay a runtime guarantee, and `readonly` alone is erased at emit.
 */
export class Lease {
  readonly resource: string;
  readonly holder: string;
  readonly epoch: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;

  constructor(
    resource: string,
    holder: string,
    epoch: number,
    acquiredAtMs: number,
    expiresAtMs: number,
  ) {
    this.resource = resource;
    this.holder = holder;
    this.epoch = epoch;
    this.acquiredAtMs = acquiredAtMs;
    this.expiresAtMs = expiresAtMs;
    Object.freeze(this);
  }

  /**
   * Whether this lease had not expired at `nowMs`, by the caller's clock.
   *
   * **Never gate a write on this.** It is the check half of the
   * check-then-write shape `ACCEPTANCE.md` section 2 rules out: the lease
   * can expire, or be taken over, between this returning `true` and the
   * write landing. It exists for reporting and for tests that need to say
   * what a clock *believed*; {@link protectedWrite} validates the epoch
   * inside the write instead.
   */
  looksLiveAt(nowMs: number): boolean {
    return this.expiresAtMs > nowMs;
  }
}

/**
 * Take `resource` for `holder` until `nowMs + ttlMs`, or refuse.
 *
 * One statement, not a read followed by a write: an upsert whose update half
 * is conditional on the existing lease having expired at the caller's clock.
 * Two claimants racing therefore cannot both win -- the loser's update matches
 * no row rather than overwriting the winner.
 *
 * **Every takeover raises the epoch, including a re-acquisition by the same
 * holder.** A holder that was paused past its expiry and comes back must come
 * back with a *new* token; if re-acquiring preserved the old epoch, the writes
 * it had in flight under the old one would validate again.
 *
 * @throws {LeaseHeld} if the resource has a live holder at `nowMs`.
 */
export function acquire(
  connection: SqliteDatabase,
  options: {
    readonly resource: string;
    readonly holder: string;
    readonly nowMs: number;
    readonly ttlMs: number;
  },
): Lease {
  const { resource, holder, nowMs, ttlMs } = options;

  requireIdentifier("resource", resource);
  requireIdentifier("holder", holder);
  requireInt("now_ms", nowMs);
  requireInt("ttl_ms", ttlMs);
  if (ttlMs <= 0) {
    throw new LeaseUsageError(
      `ttl_ms must be positive, got ${ttlMs}; a lease that expires at or before the ` +
        "instant it is taken is not a lease",
    );
  }

  const params = {
    resource,
    holder,
    now_ms: nowMs,
    expires_at_ms: nowMs + ttlMs,
  };

  let current: Lease | undefined;
  let taken = 0;
  withImmediate(connection, () => {
    const info = connection
      .prepare(
        `
            INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)
            VALUES (:resource, :holder, 1, :now_ms, :expires_at_ms)
            ON CONFLICT(resource) DO UPDATE
               SET holder = :holder,
                   epoch = lease.epoch + 1,
                   acquired_at_ms = :now_ms,
                   expires_at_ms = :expires_at_ms
             WHERE lease.expires_at_ms <= :now_ms
            `,
      )
      .run(params);
    taken = info.changes;
    current = readLease(connection, resource);
  });

  if (!taken) {
    throw new LeaseHeld(
      current !== undefined
        ? `lease ${pythonRepr(resource)} is held by ${pythonRepr(current.holder)} at epoch ` +
            `${current.epoch} until ${current.expiresAtMs} (now_ms=${nowMs}); ` +
            `${pythonRepr(holder)} did not take it`
        : `lease ${pythonRepr(resource)} was not taken by ${pythonRepr(holder)}`,
    );
  }
  if (current === undefined) {
    // the upsert reported a change, so the row exists
    throw new Error("unreachable: acquire() reported a change but the lease row is absent");
  }
  return current;
}

/**
 * Extend `lease` to `nowMs + ttlMs`, keeping its epoch, or refuse.
 *
 * A renewal by the holder keeps its epoch, as it must: re-acquiring is what
 * invalidates a token, and a renewal that bumped the epoch would invalidate
 * the holder's own writes in flight. The statement matches on the whole token
 * **and** on the lease still being live, so a lease that expired while the
 * holder was paused is not renewable -- the holder has to re-acquire, and
 * re-acquiring hands it a new epoch.
 *
 * @throws {LeaseNotHeld} if the token is no longer the live one.
 * @throws {ClockSkewRefused} if the new expiry would land at or before the
 *   acquisition, which needs the clock skewed backwards past it.
 */
export function renew(
  connection: SqliteDatabase,
  lease: Lease,
  options: { readonly nowMs: number; readonly ttlMs: number },
): Lease {
  const { nowMs, ttlMs } = options;

  requireInt("now_ms", nowMs);
  requireInt("ttl_ms", ttlMs);
  if (ttlMs <= 0) {
    throw new LeaseUsageError(`ttl_ms must be positive, got ${ttlMs}`);
  }

  const expiresAtMs = nowMs + ttlMs;
  if (expiresAtMs <= lease.acquiredAtMs) {
    throw new ClockSkewRefused(
      `renewing ${pythonRepr(lease.resource)} at now_ms=${nowMs} for ${ttlMs}ms would expire it ` +
        `at ${expiresAtMs}, at or before it was acquired (${lease.acquiredAtMs}); the clock ` +
        "has moved backwards past the acquisition and the renewal is refused rather than " +
        "written",
    );
  }

  let current: Lease | undefined;
  let renewed = 0;
  withImmediate(connection, () => {
    const info = connection
      .prepare(
        `
            UPDATE lease
               SET expires_at_ms = :expires_at_ms
             WHERE resource = :resource
               AND holder = :holder
               AND epoch = :epoch
               AND expires_at_ms > :now_ms
            `,
      )
      .run({
        resource: lease.resource,
        holder: lease.holder,
        epoch: lease.epoch,
        now_ms: nowMs,
        expires_at_ms: expiresAtMs,
      });
    renewed = info.changes;
    current = readLease(connection, lease.resource);
  });

  if (!renewed) {
    throw new LeaseNotHeld(
      `${pythonRepr(lease.holder)} cannot renew ${pythonRepr(lease.resource)} at epoch ` +
        `${lease.epoch} (now_ms=${nowMs}): the live row is ${describeLease(current)}`,
    );
  }
  if (current === undefined) {
    throw new Error("unreachable: renew() reported a change but the lease row is absent");
  }
  return current;
}

/**
 * Give `lease` up by expiring it at `nowMs`, or refuse.
 *
 * Releasing is **never** a `DELETE`. A deleted row would let the next
 * acquisition restart the epoch at 1 and hand a returning stale holder a
 * token that validates; the schema blocks the `DELETE` outright and this is
 * the supported way to end a lease early.
 *
 * **A release only ever shortens.** The new expiry is
 * `MIN(expires_at_ms, MAX(acquired_at_ms + 1, nowMs))`. Both clamps earn
 * their place: the inner one keeps a clock skewed behind the acquisition from
 * violating the row's own `expires_at_ms > acquired_at_ms` `CHECK`, and the
 * outer one keeps a *late* release from pushing the expiry of an
 * already-expired lease **forward** -- which would make the releasing
 * holder's own token read live again over the interval it had already lost,
 * and would withhold the resource from a claimant whose clock falls inside
 * it. Giving a lease up may never be the thing that extends it.
 *
 * Releasing an already-expired lease is therefore allowed and is a no-op on
 * the row, as long as nobody has taken it over. The inner clamp still leaves
 * at most a one-millisecond window in which a just-released lease reads as
 * live, which is the safe direction: it withholds the resource rather than
 * handing it to a second claimant.
 *
 * @throws {LeaseNotHeld} if the token is not the one the row carries.
 */
export function release(
  connection: SqliteDatabase,
  lease: Lease,
  options: { readonly nowMs: number },
): Lease {
  const { nowMs } = options;
  requireInt("now_ms", nowMs);

  let current: Lease | undefined;
  let released = 0;
  withImmediate(connection, () => {
    const info = connection
      .prepare(
        `
            UPDATE lease
               SET expires_at_ms = MIN(lease.expires_at_ms,
                                       MAX(lease.acquired_at_ms + 1, :now_ms))
             WHERE resource = :resource
               AND holder = :holder
               AND epoch = :epoch
            `,
      )
      .run({
        resource: lease.resource,
        holder: lease.holder,
        epoch: lease.epoch,
        now_ms: nowMs,
      });
    released = info.changes;
    current = readLease(connection, lease.resource);
  });

  if (!released) {
    throw new LeaseNotHeld(
      `${pythonRepr(lease.holder)} cannot release ${pythonRepr(lease.resource)} at epoch ` +
        `${lease.epoch}: the live row is ${describeLease(current)}`,
    );
  }
  if (current === undefined) {
    throw new Error("unreachable: release() reported a change but the lease row is absent");
  }
  return current;
}

/**
 * The lease row for `resource`, or `undefined` if it has never been taken
 * (D-0007: an absent row is `undefined`, never `null`).
 *
 * A read, and only a read: nothing in this module treats its result as
 * permission to write.
 */
export function readLease(connection: SqliteDatabase, resource: string): Lease | undefined {
  const row = connection
    .prepare<
      { resource: string },
      {
        resource: string;
        holder: string;
        epoch: number;
        acquired_at_ms: number;
        expires_at_ms: number;
      }
    >(
      `
        SELECT resource, holder, epoch, acquired_at_ms, expires_at_ms
          FROM lease
         WHERE resource = :resource
        `,
    )
    .get({ resource });
  if (row === undefined) {
    return undefined;
  }
  return new Lease(row.resource, row.holder, row.epoch, row.acquired_at_ms, row.expires_at_ms);
}

// --------------------------------------------------------------------------
// the protected write
// --------------------------------------------------------------------------

/**
 * The key that makes {@link FencedStatement} constructible from here and
 * nowhere else.
 */
const _BUILDER: unique symbol = Symbol("lease.FencedStatement issuer");

/**
 * SQL that {@link fencedUpdate} or {@link fencedInsert} produced.
 *
 * A type, and not a substring check, because a substring check cannot tell a
 * fence that **gates** the write from one parked somewhere harmless. `UPDATE
 * t SET x = CASE WHEN <fence> THEN 1 ELSE 2 END WHERE id = :id` contains
 * {@link FENCE_SQL} verbatim, changes its row under a stale token, and
 * reports a positive `changes` count -- a protected write that silently is
 * not one.
 *
 * Only the builders can produce an instance; constructing one directly is
 * refused. That leaves the shape of every protected statement decided in one
 * place, where the fence is appended to the write's own predicate and
 * nowhere else.
 *
 * Extends the built-in `String`, mirroring the source's `class
 * FencedStatement(str)`: instances answer `.startsWith`, template
 * interpolation and every other string-shaped read the same way a plain
 * string would, while `instanceof FencedStatement` still tells a builder-
 * issued statement apart from caller text -- something a plain `string`
 * cannot do. `typeof` a `FencedStatement` is `"object"`, not `"string"`, so
 * it is converted with `String(...)` at the one place it is actually run
 * ({@link protectedWrite}).
 */
export class FencedStatement extends String {
  constructor(sql: string, issuedBy?: typeof _BUILDER) {
    if (issuedBy !== _BUILDER) {
      throw new UnfencedStatement(
        "a FencedStatement is issued by fenced_update() or fenced_insert(), never " +
          "constructed from SQL text. The builders put the fence in the write's own " +
          "predicate; a hand-written statement can carry FENCE_SQL somewhere that does " +
          "not gate the write at all, and no check over the text can tell the two apart",
      );
    }
    super(sql);
  }
}

/**
 * One fenced write, and the record its refusal would be kept as.
 *
 * `statement` must be a {@link FencedStatement} from {@link fencedUpdate} or
 * {@link fencedInsert}. Those builders are also where the `writer_epoch`
 * stamp is checked: both protected tables in the spike schema carry the
 * column, and a write that does not stamp it from `:fence_epoch` leaves a
 * history nobody can read the single-writer property out of afterwards.
 *
 * `kind` and `idempotencyKey` identify the effect, and they are what a
 * refusal is recorded under, so they must be meaningful for an attempt that
 * never landed. Because the spike `action` table has no resource column
 * (`Q-0001` was open on this schema; D-0029 has since answered it in the
 * production schema, section 4.2), `kind` is also what scopes the write
 * history to one leased resource -- build it with {@link effectKind} rather
 * than by hand.
 *
 * `exactlyOnceMechanism` is the answer `ACCEPTANCE.md` section 2 requires
 * every handler to give; there is no default, because "the handler did not
 * say" is the case the requirement exists to catch.
 *
 * Frozen at construction, mirroring the source's `@dataclass(frozen=True)`;
 * `params` is frozen too (source: `MappingProxyType`).
 */
export class ProtectedWrite {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly statement: FencedStatement;
  readonly exactlyOnceMechanism: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly runId: string | null;
  readonly incidentId: string | null;

  constructor(options: {
    readonly kind: string;
    readonly idempotencyKey: string;
    readonly statement: FencedStatement;
    readonly exactlyOnceMechanism: string;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly runId?: string | null;
    readonly incidentId?: string | null;
  }) {
    requireIdentifier("kind", options.kind);
    requireIdentifier("idempotency_key", options.idempotencyKey);
    if (!(EXACTLY_ONCE_MECHANISMS as readonly string[]).includes(options.exactlyOnceMechanism)) {
      throw new LeaseUsageError(
        `exactly_once_mechanism must be one of ${pythonTuple(EXACTLY_ONCE_MECHANISMS)}, got ` +
          `${pythonRepr(options.exactlyOnceMechanism)}; ACCEPTANCE.md section 2 asks every handler ` +
          "to name its mechanism, and an unnamed one is a human gate (D-0004) rather than an " +
          "automatic retry",
      );
    }
    if (!(options.statement instanceof FencedStatement)) {
      throw new UnfencedStatement(
        `the statement for ${pythonRepr(options.kind)} was not issued by fenced_update() or ` +
          "fenced_insert(). A protected write validates the fencing token as part of the " +
          "write; checking the lease first and writing afterwards leaves exactly the race " +
          "ACCEPTANCE.md section 2 rules out -- and so does a statement that mentions the " +
          "fence without letting it decide whether the row changes",
      );
    }

    this.kind = options.kind;
    this.idempotencyKey = options.idempotencyKey;
    this.statement = options.statement;
    this.exactlyOnceMechanism = options.exactlyOnceMechanism;
    this.params = Object.freeze({ ...(options.params ?? {}) });
    this.runId = options.runId ?? null;
    this.incidentId = options.incidentId ?? null;

    const collisions = Object.keys(this.params)
      .filter((key) => (FENCE_PARAMS as readonly string[]).includes(key))
      .sort();
    if (collisions.length > 0) {
      throw new LeaseUsageError(
        `parameters [${collisions.map((c) => `'${c}'`).join(", ")}] are bound by the fence ` +
          "itself; a caller value under those names would replace the fence's own resource, " +
          "holder, epoch or clock and leave a statement that still looks fenced",
      );
    }
    Object.freeze(this);
  }
}

// --------------------------------------------------------------------------
// the typed predicate builder -- no raw SQL crosses this line
// --------------------------------------------------------------------------
//
// S6 shipped the builders taking SQL text fragments and grew three rounds of
// defence around them: a substring scan, then builder-issued types, then a
// literal-stripping lexer with a closed table set. Each round hardened the
// synthesis without removing the recurring surface itself -- caller-supplied
// SQL text. What follows is the residual `docs/lease-fencing.md` recorded as
// the fully structural answer (#42): callers compose statements from typed
// column / operator / value objects, the builder renders every character of
// SQL itself, and the lexer-based defences are unnecessary by construction
// because there is no caller text left to scan.

/**
 * What a column or parameter name may look like. An identifier is a name, not
 * a fragment: nothing matching this pattern can close a parenthesis, open a
 * comment, or smuggle a quote, so identity checks replace the retired lexer.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireColumn(field: string, name: unknown): string {
  // `typeof name === "string"` alone is the exact-type gate here: unlike
  // Python, where a `str` subclass passes `isinstance` while its own
  // `__format__`/`replace` stay its author's code, JavaScript primitives
  // cannot be subclassed at all -- a `class Sneaky extends String {}`
  // instance has `typeof` `"object"`, not `"string"`, and fails this check
  // on its own. See FencedStatement's own doc comment for the same property
  // used the other way round.
  if (typeof name !== "string" || !IDENTIFIER.test(name)) {
    throw new LeaseUsageError(
      `${field} must be a bare column name (a built-in str identifier), got ${pythonRepr(name)}; ` +
        "the builder renders every character of SQL itself, so a name is a name and never a " +
        "fragment",
    );
  }
  return name;
}

/** Exact-type gate: `value.constructor === ctor`, refusing every subclass instance. */
function isExact<T>(ctor: new (...args: never[]) => T, value: unknown): value is T {
  return typeof value === "object" && value !== null && (value as object).constructor === ctor;
}

/** The fence's own epoch, as an assignable value. See {@link fenceEpoch}. */
class _FenceEpoch {
  // pragma: no cover - repr only, kept for structural parity with the source
  toString(): string {
    return "fence_epoch";
  }
}

/**
 * The one way a statement refers to the fence's epoch. A caller cannot name
 * `:fence_epoch` directly -- {@link Param} refuses every name in
 * {@link FENCE_PARAMS} -- so the stamp is a sentinel the builder recognises
 * structurally rather than a spelling a regex has to find.
 */
export const fenceEpoch: _FenceEpoch = new _FenceEpoch();

/** A named placeholder, bound at execution time. Build with {@link param}. */
export class Param {
  readonly name: string;

  constructor(name: string) {
    requireColumn("a parameter name", name);
    if ((FENCE_PARAMS as readonly string[]).includes(name)) {
      throw new LeaseUsageError(
        `parameter ${pythonRepr(name)} is bound by the fence itself; use fence_epoch to stamp the ` +
          "writer epoch, and never bind the fence's resource, holder or clock from a caller " +
          "value",
      );
    }
    this.name = name;
    Object.freeze(this);
  }
}

/**
 * A constant the builder renders as a SQL literal. Build with {@link value}.
 *
 * Only `string`, `number` (an integer) and `null` are accepted. The
 * rendering is the builder's, by SQLite's own quoting rules, so a constant
 * containing quotes, parentheses or comment markers is inert text in the
 * statement -- there is no structural scan left for it to walk past.
 */
export class Value {
  readonly constant: string | number | null;

  constructor(constant: string | number | null) {
    if (
      typeof constant === "boolean" ||
      !(typeof constant === "string" || typeof constant === "number" || constant === null)
    ) {
      throw new LeaseUsageError(
        `a value() constant must be a str, an int or None, got ${pythonRepr(constant)}; anything ` +
          "richer is bound as a param() at execution time instead of rendered into the " +
          "statement",
      );
    }
    if (typeof constant === "number" && !Number.isInteger(constant)) {
      throw new LeaseUsageError(
        `a value() constant must be a str, an int or None, got ${pythonRepr(constant)}; anything ` +
          "richer is bound as a param() at execution time instead of rendered into the " +
          "statement",
      );
    }
    if (typeof constant === "string" && constant.includes("\0")) {
      throw new LeaseUsageError(
        "a value() constant may not contain a NUL character: the SQL text is NUL-terminated " +
          "on its way into SQLite, so the refusal belongs here, where it names the constant, " +
          "rather than at execution time where it names the whole statement",
      );
    }
    this.constant = constant;
    Object.freeze(this);
  }
}

/** `column = column + by`, for counters. Build with {@link increment}. */
export class Increment {
  readonly column: string;
  readonly by: number;

  constructor(column: string, by: number) {
    requireColumn("increment() column", column);
    if (typeof by !== "number" || !Number.isInteger(by)) {
      throw new LeaseUsageError(`increment() by must be an int, got ${pythonRepr(by)}`);
    }
    this.column = column;
    this.by = by;
    Object.freeze(this);
  }
}

export function param(name: string): Param {
  return new Param(name);
}

export function value(constant: string | number | null): Value {
  return new Value(constant);
}

export function increment(column: string, by = 1): Increment {
  return new Increment(column, by);
}

/** `column = operand` or `column <> operand`. Build with {@link eq} / {@link ne}. */
export class Comparison {
  readonly column: string;
  readonly operator: "=" | "<>";
  readonly operand: Param | Value | _FenceEpoch;

  constructor(column: string, operator: "=" | "<>", operand: Param | Value | _FenceEpoch) {
    requireColumn("a comparison column", column);
    if (operator !== "=" && operator !== "<>") {
      throw new LeaseUsageError(
        `a comparison operator is '=' or '<>', got ${pythonRepr(operator)}`,
      );
    }
    if (!isExact(Param, operand) && !isExact(Value, operand) && operand !== fenceEpoch) {
      throw new UnfencedStatement(
        `the operand for ${pythonRepr(column)} must be param(...), value(...) or fence_epoch ` +
          `itself, got ${pythonRepr(operand)}; a predicate is composed from the builder's own ` +
          "typed objects, never from a subclass of them and never from SQL text",
      );
    }
    if (isExact(Value, operand) && operand.constant === null) {
      // "= NULL" and "<> NULL" are UNKNOWN for every row in SQL: the
      // predicate would match nothing, and the protected write would
      // silently become a no-op rather than the null test it looks like.
      throw new LeaseUsageError(
        `comparing ${pythonRepr(column)} against value(None) never matches any row in SQL; use ` +
          "is_null() for the null test",
      );
    }
    this.column = column;
    this.operator = operator;
    this.operand = operand;
    Object.freeze(this);
  }
}

/** `column IS NULL`. Build with {@link isNull}. */
export class IsNull {
  readonly column: string;

  constructor(column: string) {
    requireColumn("an IS NULL column", column);
    this.column = column;
    Object.freeze(this);
  }
}

/** Predicates ANDed together. Build with {@link and_}. */
export class Conjunction {
  readonly predicates: readonly Predicate[];

  constructor(predicates: readonly Predicate[]) {
    if (predicates.length === 0) {
      throw new LeaseUsageError(
        "and_() needs at least one predicate; a write whose own WHERE matches everything " +
          "should say so with an explicit predicate, not with an empty conjunction",
      );
    }
    for (const predicate of predicates) {
      requirePredicate("a conjunct", predicate);
    }
    this.predicates = Object.freeze([...predicates]);
    Object.freeze(this);
  }
}

export type Predicate = Comparison | IsNull | Conjunction;

/** The predicate `column = operand`. */
export function eq(column: string, operand: Param | Value | _FenceEpoch): Comparison {
  return new Comparison(column, "=", operand);
}

/** The predicate `column <> operand`. */
export function ne(column: string, operand: Param | Value | _FenceEpoch): Comparison {
  return new Comparison(column, "<>", operand);
}

/** The predicate `column IS NULL`. */
export function isNull(column: string): IsNull {
  return new IsNull(column);
}

/** `predicates`, all of which must hold. */
export function and_(...predicates: readonly Predicate[]): Conjunction {
  return new Conjunction(predicates);
}

function requirePredicate(field: string, predicate: unknown): void {
  // Exact types, not instanceof: a predicate subclass would pass every
  // construction-time check and still render through its author's own
  // attribute reads.
  if (
    !isExact(Comparison, predicate) &&
    !isExact(IsNull, predicate) &&
    !isExact(Conjunction, predicate)
  ) {
    throw new UnfencedStatement(
      `${field} must be composed with eq(), ne(), is_null() and and_(), got ${pythonRepr(predicate)}. ` +
        "The builders take no SQL text from a caller -- and no subclass either: a raw " +
        "fragment is exactly the surface #42 retired",
    );
  }
}

function renderOperand(expression: unknown): string {
  // The gate every rendering path shares, so no shape -- the insert values in
  // particular -- can reach the template strings below with an object whose
  // own methods would decide what the statement says. Exact types, and for
  // the sentinel identity, never instanceof: a *subclass* of Param or Value
  // is its author's code wearing the builder's name, free to answer
  // construction-time validation with one text and rendering with another.
  if (!isExact(Param, expression) && !isExact(Value, expression) && expression !== fenceEpoch) {
    throw new UnfencedStatement(
      `a rendered value must be param(...), value(...) or fence_epoch itself, got ` +
        `${pythonRepr(expression)}. The builders take no SQL text from a caller -- and no ` +
        "subclass either: a raw fragment is exactly the surface #42 retired",
    );
  }
  if (expression === fenceEpoch) {
    return ":fence_epoch";
  }
  // Construction-time validation is repeated here, on the field as it stands
  // at rendering: what is validated is what is rendered, at the moment it is
  // rendered. (In the source this guards against `object.__setattr__` on a
  // frozen dataclass; `Object.freeze` makes that mutation impossible here,
  // so this re-check is unreachable in practice, kept only for structural
  // parity with the source -- see the module's fidelity notes.)
  if (isExact(Param, expression)) {
    const name = requireColumn("a parameter name", expression.name);
    if ((FENCE_PARAMS as readonly string[]).includes(name)) {
      throw new LeaseUsageError(
        `parameter ${pythonRepr(name)} is bound by the fence itself and cannot be rendered from a ` +
          "caller node",
      );
    }
    return `:${name}`;
  }
  // Only Value and the fence_epoch sentinel remain here; the sentinel case
  // returned above and Param is handled above too, so this is a Value.
  const constant = (expression as Value).constant;
  if (constant === null) {
    return "NULL";
  }
  if (
    typeof constant === "boolean" ||
    !(typeof constant === "number" || typeof constant === "string")
  ) {
    throw new LeaseUsageError(
      `a value() constant must be a built-in str, an int or None at rendering time, got ` +
        `${pythonRepr(constant)}`,
    );
  }
  if (typeof constant === "number") {
    return String(Math.trunc(constant));
  }
  if (constant.includes("\0")) {
    throw new LeaseUsageError("a value() constant may not contain a NUL character");
  }
  // SQLite's own escape: the quote is doubled, and nothing else in a string
  // literal is structural. Rendered here, by the builder, so the constant is
  // data however it is spelled.
  return `'${constant.replace(/'/g, "''")}'`;
}

function renderAssignment(column: string, expression: unknown): string {
  if (isExact(Increment, expression)) {
    if (requireColumn("increment() column", expression.column) !== column) {
      throw new LeaseUsageError(
        `increment(${pythonRepr(expression.column)}) assigned to ${pythonRepr(column)}: a counter is ` +
          "incremented in place, so the two names must agree",
      );
    }
    const by = expression.by;
    if (typeof by !== "number" || !Number.isInteger(by)) {
      throw new LeaseUsageError(`increment() by must be an int, got ${pythonRepr(by)}`);
    }
    return `${column} = ${column} + ${Math.trunc(by)}`;
  }
  // renderOperand's own exact-type gate refuses everything else, subclasses
  // of the builder's types included.
  return `${column} = ${renderOperand(expression)}`;
}

function renderPredicate(predicate: unknown): string {
  // Exact-type dispatch with the fields revalidated as they are rendered --
  // see renderOperand for why construction-time validation is not enough.
  if (isExact(Conjunction, predicate)) {
    const conjuncts = predicate.predicates;
    if (conjuncts.length === 0) {
      throw new LeaseUsageError("and_() needs at least one predicate");
    }
    return conjuncts.map((p) => renderPredicate(p)).join(" AND ");
  }
  if (isExact(IsNull, predicate)) {
    return `${requireColumn("an IS NULL column", predicate.column)} IS NULL`;
  }
  if (!isExact(Comparison, predicate)) {
    throw new UnfencedStatement(
      `a predicate must be composed with eq(), ne(), is_null() and and_(), got ${pythonRepr(predicate)}`,
    );
  }
  const column = requireColumn("a comparison column", predicate.column);
  const operator = predicate.operator;
  if (operator !== "=" && operator !== "<>") {
    throw new LeaseUsageError(`a comparison operator is '=' or '<>', got ${pythonRepr(operator)}`);
  }
  const operand = predicate.operand;
  if (isExact(Value, operand) && operand.constant === null) {
    throw new LeaseUsageError(
      `comparing ${pythonRepr(column)} against value(None) never matches any row in SQL; use ` +
        "is_null() for the null test",
    );
  }
  return `${column} ${operator} ${renderOperand(operand)}`;
}

/**
 * An `UPDATE` whose own `WHERE` ends in the fence. See {@link FENCE_SQL}.
 *
 * `set` maps column names to typed values -- {@link param}, {@link value},
 * {@link increment} or {@link fenceEpoch} -- and `where` is a typed
 * predicate from {@link eq}, {@link ne}, {@link isNull} and {@link and_}.
 * No SQL text crosses the boundary: the builder renders every character, so
 * the fence gates the write by construction rather than by a scan over
 * caller-supplied fragments.
 *
 * The caller's predicate is parenthesised and ANDed with the fence, so the
 * fence decides whether the row changes -- it is not merely present in the
 * text.
 *
 * `stampsWriterEpoch` requires `writer_epoch` to be assigned
 * {@link fenceEpoch}, and nothing else. Turn it off only for a target that
 * genuinely has no such column, or for an update that must leave a row's
 * existing stamp in place, and expect to say which: without the stamp the
 * row leaves no trace of the epoch it was written under, and the
 * single-writer property becomes unprovable after the fact rather than
 * false.
 */
export function fencedUpdate(
  table: string,
  options: {
    readonly set: Readonly<Record<string, unknown>>;
    readonly where: Predicate;
    readonly stampsWriterEpoch?: boolean;
  },
): FencedStatement {
  const stampsWriterEpoch = options.stampsWriterEpoch ?? true;
  const validTable = requireTable(table);
  requirePredicate("where", options.where);
  const assignments = requireAssignments(validTable, options.set, stampsWriterEpoch);
  const forbidden = Object.keys(assignments)
    .filter((column) => (EVIDENCE_COLUMNS as readonly string[]).includes(column))
    .sort();
  if (forbidden.length > 0) {
    throw new UnfencedStatement(
      `a protected write may not assign [${forbidden.map((c) => `'${c}'`).join(", ")}] on ` +
        `${validTable}: those columns are what a row in the history is attributed by, and a ` +
        "write that rewrites them replaces evidence rather than adding to it",
    );
  }
  const rendered = Object.entries(assignments)
    .map(([column, expression]) => renderAssignment(column, expression))
    .join(", ");
  // An applied action row is finished evidence. Without this an update could
  // land on one and restamp its epoch under a later lease, which would
  // rewrite the very attribution write_history() reads the single-writer
  // property out of. Composed here rather than asked of the caller: a guard
  // the caller has to remember is not a guard.
  const guard = validTable === "action" ? " AND applied_at_ms IS NULL" : "";
  return new FencedStatement(
    `UPDATE ${validTable}\n` +
      `   SET ${rendered}\n` +
      ` WHERE (${renderPredicate(options.where)})${guard}\n` +
      `   AND ${FENCE_SQL}`,
    _BUILDER,
  );
}

/**
 * An `INSERT ... SELECT` whose `WHERE` is the fence. See {@link FENCE_SQL}.
 *
 * `INSERT ... VALUES` cannot carry a `WHERE` clause, so a fenced insert is an
 * `INSERT ... SELECT`: the row is produced only if the token is live, in the
 * same statement that inserts it.
 *
 * `values` maps column names to typed values, exactly as
 * {@link fencedUpdate}'s `set` does ({@link increment} excepted -- a new row
 * has no prior value to count from). `stampsWriterEpoch` requires a
 * `writer_epoch` column whose value is {@link fenceEpoch} -- see
 * {@link fencedUpdate}.
 */
export function fencedInsert(
  table: string,
  options: {
    readonly values: Readonly<Record<string, unknown>>;
    readonly stampsWriterEpoch?: boolean;
  },
): FencedStatement {
  const stampsWriterEpoch = options.stampsWriterEpoch ?? true;
  const validTable = requireTable(table);
  const assignments = requireAssignments(validTable, options.values, stampsWriterEpoch);
  for (const [column, expression] of Object.entries(assignments)) {
    if (isExact(Increment, expression)) {
      throw new LeaseUsageError(
        `increment() is not a value for an INSERT (${pythonRepr(column)}): a new row has no prior ` +
          "value to add to; use value() or param()",
      );
    }
  }
  return new FencedStatement(
    `INSERT INTO ${validTable} (${Object.keys(assignments).join(", ")})\n` +
      `SELECT ${Object.values(assignments)
        .map((v) => renderOperand(v))
        .join(", ")}\n` +
      ` WHERE ${FENCE_SQL}`,
    _BUILDER,
  );
}

/**
 * The tables a protected write may target: S5's six, and nothing else. The
 * table name is interpolated into the statement, and a name is not a
 * fragment the caller gets to compose -- `"action (x) SELECT 1 WHERE 1 /*"`
 * would comment out the builder's own columns, values and fence, leaving a
 * statement that inserts under a stale token. A closed set is the check that
 * cannot be walked past by a cleverer string.
 */
export const PROTECTED_TABLES = Object.freeze([
  "run",
  "session",
  "lease",
  "outbox",
  "incident",
  "action",
] as const);

/**
 * What a row is *identified and attributed by*. A protected write may not
 * assign any of them: rewriting the kind of a row already in the history
 * replaces the attribution {@link writeHistory} is read out of, and the
 * identity columns are frozen by the schema's own triggers for the same
 * reason -- refused here too, where the message says which rule was broken
 * rather than which trigger fired.
 *
 * Lifecycle columns are deliberately absent. `status`, `delivered_at_ms` and
 * `applied_at_ms` are what a protected write is usually *for*; the schema
 * keeps those forward-only and set-once, which is a different question from
 * whether a row may be re-attributed.
 */
const EVIDENCE_COLUMNS = Object.freeze([
  "action_id",
  "kind",
  "idempotency_key",
  "message_id",
  "dedup_key",
]);

function requireTable(table: unknown): (typeof PROTECTED_TABLES)[number] {
  // Compared by VALUE, because Python's `table not in PROTECTED_TABLES` uses
  // `==`: a `str` subclass that compares equal to a protected name is ACCEPTED
  // there and then canonicalised by the `.index()` lookup below. A strict
  // `indexOf` on the raw argument refuses a `String` object outright -- the
  // opposite answer, and it would leave the canonicalisation on the next line
  // as dead code, so the comment explaining why it exists would stop being true.
  //
  // The primitive is taken with the BUILT-IN `valueOf`, called explicitly, not
  // with `String(table)`. `String()` dispatches through the object's own
  // `toString`, and a hostile subclass overriding `toString` is precisely the
  // attack this function exists to stop -- the source's own test subclass does
  // exactly that. Python's `str.__eq__` compares the underlying buffer and
  // cannot be reached through `__str__` either, so the built-in call is the
  // faithful analogue as well as the safe one.
  const candidate =
    typeof table === "string"
      ? table
      : table instanceof String
        ? String.prototype.valueOf.call(table)
        : table;
  const index = (PROTECTED_TABLES as readonly unknown[]).indexOf(candidate);
  if (index === -1) {
    throw new UnfencedStatement(
      `${pythonRepr(table)} is not one of the protected tables ${pythonTuple(PROTECTED_TABLES)}. The ` +
        "table name is interpolated into the statement, so it is chosen from a closed set " +
        "rather than validated as text -- a name carrying its own SQL can comment the " +
        "builder's fence out of the statement entirely",
    );
  }
  // The closed set's own string, not the caller's object: a str subclass
  // that compares equal to a protected name would otherwise be the thing
  // the template string formats, through methods that are its author's, not
  // ours.
  return PROTECTED_TABLES[index] as (typeof PROTECTED_TABLES)[number];
}

/**
 * Validate one typed column-to-value mapping, and the writer-epoch stamp.
 *
 * A mapping, not clause text: duplicate assignment -- SQLite's "SET
 * writer_epoch = :fence_epoch, writer_epoch = 1" applies the *last* one -- is
 * impossible by construction here too, because a plain object holds one
 * value per key.
 */
function requireAssignments(
  table: string,
  assignments: unknown,
  stampsWriterEpoch: boolean,
): Record<string, unknown> {
  if (typeof assignments !== "object" || assignments === null || Array.isArray(assignments)) {
    throw new UnfencedStatement(
      `a protected write to ${table} takes a mapping of column names to typed values, got ` +
        `${pythonRepr(assignments)}. The builders take no SQL text from a caller: a raw fragment ` +
        "is exactly the surface #42 retired",
    );
  }
  // Snapshotted into an object of our own before anything is checked: the
  // caller's mapping is the caller's object, and one that answered the
  // validation differently from the rendering would carry an unvalidated
  // name or an unstamped epoch into the statement. Everything below -- and
  // the rendering in the builders -- reads only this copy.
  const snapshot: Record<string, unknown> = { ...(assignments as Record<string, unknown>) };
  if (Object.keys(snapshot).length === 0) {
    throw new LeaseUsageError(`a protected write to ${table} assigns no column at all`);
  }
  for (const column of Object.keys(snapshot)) {
    requireColumn(`a column assigned on ${table}`, column);
  }

  const stamp = snapshot.writer_epoch;
  if (stampsWriterEpoch) {
    // The single-writer property is read back out of the epoch each row was
    // written under, so a row that carries no epoch -- or one a caller
    // chose -- is refused here rather than found unprovable later. Identity
    // with the sentinel, not instanceof: a foreign _FenceEpoch instance is
    // an object of the caller's, and the caller does not get to mint the
    // stamp.
    if (stamp !== fenceEpoch) {
      throw new UnfencedStatement(
        `a protected write to ${table} must assign fence_epoch to writer_epoch, and this one ` +
          `assigns ${pythonRepr(stamp)}. Pass stamps_writer_epoch=False if the target genuinely ` +
          "has no such column",
      );
    }
  } else if (Object.hasOwn(snapshot, "writer_epoch")) {
    throw new UnfencedStatement(
      `stamps_writer_epoch=False declares that this write to ${table} leaves writer_epoch ` +
        "alone -- a target without the column, or a row keeping the stamp it was written " +
        "under -- and the statement assigns one anyway; the two claims cannot both be true",
    );
  }
  return snapshot;
}

/**
 * The `action.kind` for `effect` performed under the lease on `resource`.
 *
 * The spike `action` table has **no resource column** -- which component
 * owns which state item (the writer assignment) was `Q-0001` and open on
 * this schema; D-0029 has since answered that part in the production
 * schema's writer table, section 4.2. It has not answered the *column*:
 * production `action` (`migrations/0001_initial.sql`) has no resource
 * column either, so nothing in a row -- spike or production -- says which
 * lease its `writer_epoch` was allocated by. Two resources' histories share
 * a table and their epochs are independent, which would make any comparison
 * across them meaningless.
 *
 * Encoding the resource in `kind` is the spike's way out, and it is a
 * workaround rather than a design: a real schema would carry the resource
 * as a column. {@link writeHistory} filters on the composed kind, and
 * {@link appliedEpochRegressions} refuses a history that mixes kinds at
 * all.
 */
export function effectKind(resource: string, effect: string): string {
  requireIdentifier("resource", resource);
  requireIdentifier("effect", effect);
  if (effect.includes("@")) {
    throw new LeaseUsageError(
      `effect ${pythonRepr(effect)} may not contain '@'; it is the separator this kind is composed ` +
        "with, and an effect that used it would make the resource unrecoverable from the row",
    );
  }
  return `${effect}@${resource}`;
}

/**
 * The resource {@link effectKind} composed `kind` for.
 *
 * @throws {LeaseUsageError} if `kind` was not composed by {@link effectKind}.
 *   A row whose kind does not name a resource cannot say which lease
 *   allocated its epoch, and the spike `action` table has no other column
 *   that could (`Q-0001` was open on this schema; D-0029 has since answered
 *   it in the production schema, section 4.2).
 */
export function resourceOfKind(kind: string): string {
  requireIdentifier("kind", kind);
  const at = kind.indexOf("@");
  const effect = at === -1 ? kind : kind.slice(0, at);
  const resource = at === -1 ? "" : kind.slice(at + 1);
  if (at === -1 || effect === "" || resource === "") {
    throw new LeaseUsageError(
      `kind ${pythonRepr(kind)} was not composed by effect_kind(resource, effect), so nothing in ` +
        "the row says which lease its writer_epoch came from",
    );
  }
  return resource;
}

/**
 * Run `write` under `lease`, refusing and recording a stale token.
 *
 * The validation is not a step before the write; it is a clause *of* the
 * write, evaluated by SQLite in the same statement under the same
 * transaction. Between the token being live and the row changing there is
 * no instant for the lease to expire in.
 *
 * The transaction is `BEGIN IMMEDIATE`, so the write lock is held from
 * before the statement runs until after the outcome has been classified.
 * That is what makes the classification honest: when the statement changes
 * no row, the fence is re-evaluated to tell "the token was stale" from "the
 * caller's own WHERE matched nothing", and no other connection can have
 * moved the lease in between.
 *
 * @returns the number of rows the statement changed (never zero -- a zero is
 *   one of the two refusals).
 * @throws {StaleWriterRefused} the token was not live. An `action` row in
 *   status `refused` is committed **before** this is raised.
 * @throws {ProtectedWriteMissed} the token was live and the caller's WHERE
 *   matched nothing. Nothing is recorded.
 */
export function protectedWrite(
  connection: SqliteDatabase,
  lease: Lease,
  write: ProtectedWrite,
  options: { readonly nowMs: number; readonly attemptId?: string | null },
): number {
  const { nowMs, attemptId = null } = options;
  requireInt("now_ms", nowMs);
  if (resourceOfKind(write.kind) !== lease.resource) {
    // Without this, one kind could accumulate epochs allocated by several
    // different leases, and the history read back under that kind would be
    // two unrelated sequences with no way left to tell them apart.
    throw new LeaseUsageError(
      `kind ${pythonRepr(write.kind)} names resource ${pythonRepr(resourceOfKind(write.kind))} but ` +
        `the token is for ${pythonRepr(lease.resource)}; a kind is how an action row records ` +
        "which lease its epoch was allocated by, so the two may not disagree",
    );
  }
  const fence = {
    fence_resource: lease.resource,
    fence_holder: lease.holder,
    fence_epoch: lease.epoch,
    fence_now_ms: nowMs,
  };
  const params = { ...write.params, ...fence };
  let refusal: {
    readonly actionId: string;
    readonly reason: string;
    readonly observed: Lease | undefined;
  } | null = null;
  let changed = 0;

  withImmediate(connection, () => {
    // The boxed primitive is taken with the BUILT-IN `valueOf`, not with
    // `String()`. `String()` dispatches through the object's own `toString` or
    // `Symbol.toPrimitive`, both of which a caller can replace on a
    // builder-issued statement (or on the exported class's prototype) -- so the
    // `instanceof FencedStatement` gate above would still pass while this line
    // executed arbitrary UNFENCED SQL, which is the one thing this module
    // exists to make impossible.
    //
    // The source has no such hole to close: Python passes `write.statement`
    // straight to `execute()`, so no `__str__` is ever called. The hook is
    // introduced by boxing the statement in a String subclass, so the fix
    // belongs here.
    const sql = String.prototype.valueOf.call(write.statement);
    const info = connection.prepare(sql).run(params);
    changed = info.changes;
    if (changed <= 0) {
      // Read positionally: the SELECT list is a CASE expression, not a bare
      // column reference (D-0007 lesson: any non-plain-column read must use
      // .pluck()/.raw()).
      const fenceHolds = Boolean(
        connection.prepare(`SELECT CASE WHEN ${FENCE_SQL} THEN 1 ELSE 0 END`).pluck().get(fence),
      );
      const observed = readLease(connection, lease.resource);
      if (fenceHolds) {
        // Raising here rolls the transaction back, which discards nothing:
        // the statement changed no row, and no refusal is recorded for a
        // write that was never rejected.
        throw new ProtectedWriteMissed(
          `${pythonRepr(write.kind)} changed no row although the fencing token (${pythonRepr(lease.resource)}, ` +
            `${pythonRepr(lease.holder)}, epoch ${lease.epoch}) was live at now_ms=${nowMs}; the ` +
            "statement's own WHERE matched nothing. No refusal was recorded -- this is not a " +
            "rejected writer",
        );
      }
      const reason =
        `stale fencing token: ${pythonRepr(lease.holder)} presented epoch ${lease.epoch} for ` +
        `${pythonRepr(lease.resource)} at now_ms=${nowMs}; the lease row is ${describeLease(observed)}`;
      const actionId = recordRefusal(connection, write, lease, { nowMs, reason, attemptId });
      refusal = { actionId, reason, observed };
    }
  });

  if (refusal !== null) {
    const { actionId, reason, observed } = refusal as {
      actionId: string;
      reason: string;
      observed: Lease | undefined;
    };
    throw new StaleWriterRefused(
      `${pythonRepr(write.kind)} was refused and the refusal recorded as action ${pythonRepr(actionId)}: ${reason}`,
      { actionId, observed },
    );
  }
  return changed;
}

/**
 * Write the durable record of a refused writer, and return its id.
 *
 * **Unfenced on purpose.** The refusal exists precisely because the writer's
 * token was not live, so a fenced insert here could never land -- the
 * rejection would be silently dropped, which is the one thing
 * `ACCEPTANCE.md` section 2 forbids of it. It rides inside the caller's
 * transaction, so the attempt and its record commit together.
 *
 * The row is `status = 'refused'`, which the schema's
 * `action_one_effect_per_key` index excludes: a writer that keeps coming
 * back is recorded every time without any of those records becoming the
 * thing that admits a second effect.
 */
function recordRefusal(
  connection: SqliteDatabase,
  write: ProtectedWrite,
  lease: Lease,
  options: { readonly nowMs: number; readonly reason: string; readonly attemptId: string | null },
): string {
  const { nowMs, reason, attemptId } = options;
  // `attemptId || ...`, not `??`: the source's `attempt_id or f"refusal-{...}"`
  // is a Python truthiness test, and an empty-string attempt_id is exactly
  // as falsy in JavaScript's `||` as it is in Python's `or` -- so both
  // `null`/`undefined` *and* `""` fall through to the generated id, matching
  // the source exactly (D-0021 lesson: do not narrow `or` into `??`).
  const actionId = attemptId || `refusal-${leaseSeams.uuid4Hex()}`;
  connection
    .prepare(
      `
        INSERT INTO action (action_id, run_id, incident_id, kind, idempotency_key,
                            exactly_once_mechanism, status, refusal_reason,
                            writer_epoch, created_at_ms)
        VALUES (:action_id, :run_id, :incident_id, :kind, :idempotency_key,
                :exactly_once_mechanism, 'refused', :refusal_reason,
                :writer_epoch, :created_at_ms)
        `,
    )
    .run({
      action_id: actionId,
      run_id: write.runId,
      incident_id: write.incidentId,
      kind: write.kind,
      idempotency_key: write.idempotencyKey,
      exactly_once_mechanism: write.exactlyOnceMechanism,
      refusal_reason: reason,
      writer_epoch: lease.epoch,
      created_at_ms: nowMs,
    });
  return actionId;
}

// --------------------------------------------------------------------------
// reading the property back
// --------------------------------------------------------------------------

/** What one lease row claimed, in wall-clock terms, while it stood. */
export class Claim {
  readonly resource: string;
  readonly holder: string;
  readonly epoch: number;
  readonly fromMs: number;
  readonly untilMs: number;

  constructor(resource: string, holder: string, epoch: number, fromMs: number, untilMs: number) {
    this.resource = resource;
    this.holder = holder;
    this.epoch = epoch;
    this.fromMs = fromMs;
    this.untilMs = untilMs;
    Object.freeze(this);
  }
}

/**
 * When one epoch could actually write, ordered by epoch rather than clock.
 *
 * `untilMs` is `null` for the last epoch observed: its authority ends at its
 * expiry, but which instant that is depends on whose clock is asked, and
 * this type does not pick one.
 */
export class Authority {
  readonly resource: string;
  readonly holder: string;
  readonly epoch: number;
  readonly fromMs: number;
  readonly untilMs: number | null;

  constructor(
    resource: string,
    holder: string,
    epoch: number,
    fromMs: number,
    untilMs: number | null,
  ) {
    this.resource = resource;
    this.holder = holder;
    this.epoch = epoch;
    this.fromMs = fromMs;
    this.untilMs = untilMs;
    Object.freeze(this);
  }
}

/**
 * What each lease row claimed, in the clock terms it was written in.
 *
 * For rows written by {@link acquire} these windows are disjoint by
 * construction -- a takeover is stamped at or after the previous holder's
 * expiry, in the taker's own frame -- so {@link overlappingClaims} over a
 * whole timeline is a real check that every recorded instant had one holder.
 *
 * It is emphatically **not** a check that no two processes ever ran at once.
 * Under skew the frames differ, and a true-time overlap does not appear in
 * the rows at all; the suite shows that case. Reporting the recorded windows
 * for what they are is the point -- the exclusion that holds regardless is
 * {@link authorityTimeline}'s.
 */
export function claimedTimeline(observations: readonly Lease[]): readonly Claim[] {
  return Object.freeze(
    byEpoch(observations).map(
      (lease) =>
        new Claim(lease.resource, lease.holder, lease.epoch, lease.acquiredAtMs, lease.expiresAtMs),
    ),
  );
}

/**
 * When each epoch held write authority, from the rows themselves.
 *
 * The exclusion this shows is the one that actually holds: an epoch's
 * authority ends the instant the next epoch exists, whatever either clock
 * said, because from then on the older token matches nothing. Ordering is
 * by epoch and never by timestamp -- under skew the acquisition timestamps
 * can go backwards while the epochs go forwards, and {@link
 * epochRegressions} is where that is reported rather than smoothed over.
 *
 * `observations` is every state the lease row passed through, in any order.
 * The spike schema keeps one row per resource and no history table -- which
 * table records lease history is `Q-0001` and still open. Production schema
 * section 4.2's writer table lists `lease` as "in-place (CAS)" with no
 * history table beside it, and section 12's known holes does not name this
 * question either, so it has not been answered anywhere -- the caller
 * collects the rows as they are written. What is durable, and readable from
 * SQLite alone afterwards, is {@link writeHistory}.
 */
export function authorityTimeline(observations: readonly Lease[]): readonly Authority[] {
  const ordered = byEpoch(observations);
  const timeline: Authority[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const lease = ordered[index] as Lease;
    const successor = index + 1 < ordered.length ? ordered[index + 1] : undefined;
    timeline.push(
      new Authority(
        lease.resource,
        lease.holder,
        lease.epoch,
        lease.acquiredAtMs,
        successor === undefined ? null : successor.acquiredAtMs,
      ),
    );
  }
  return Object.freeze(timeline);
}

/**
 * Pairs of claims by different holders whose recorded windows overlap.
 *
 * Empty is the expected answer for rows this module wrote. A non-empty
 * answer means some claimant took a lease it had not seen expire -- a
 * lease row mutated outside {@link acquire}, or a second implementation of
 * the takeover that dropped the expiry condition from its WHERE.
 */
export function overlappingClaims(claims: readonly Claim[]): readonly (readonly [Claim, Claim])[] {
  const overlaps: (readonly [Claim, Claim])[] = [];
  const ordered = [...claims].sort((a, b) =>
    a.epoch - b.epoch !== 0 ? a.epoch - b.epoch : a.fromMs - b.fromMs,
  );
  for (let index = 0; index < ordered.length; index += 1) {
    const first = ordered[index] as Claim;
    for (let j = index + 1; j < ordered.length; j += 1) {
      const second = ordered[j] as Claim;
      if (first.holder === second.holder) {
        continue;
      }
      if (first.fromMs < second.untilMs && second.fromMs < first.untilMs) {
        overlaps.push(Object.freeze([first, second]));
      }
    }
  }
  return Object.freeze(overlaps);
}

/**
 * Consecutive epochs whose acquisition timestamps run backwards.
 *
 * Empty for rows this module wrote, and for the same reason
 * {@link overlappingClaims} is: a takeover is stamped at or after the
 * previous expiry, which is itself after the previous acquisition, so the
 * stamps are non-decreasing however skewed each individual clock is.
 *
 * Not a violation of the exclusion if it does fire -- the epoch is the
 * order, and the epoch never goes back -- but evidence that the timeline
 * was assembled from rows some other writer produced, which is worth
 * surfacing rather than averaging away.
 */
export function epochRegressions(
  timeline: readonly Authority[],
): readonly (readonly [Authority, Authority])[] {
  const regressions: (readonly [Authority, Authority])[] = [];
  for (let index = 0; index + 1 < timeline.length; index += 1) {
    const first = timeline[index] as Authority;
    const second = timeline[index + 1] as Authority;
    if (second.fromMs < first.fromMs) {
      regressions.push(Object.freeze([first, second]));
    }
  }
  return Object.freeze(regressions);
}

/**
 * Every fenced write attempt recorded in `action`, oldest first.
 *
 * This is the durable half of "at most one live holder": the lease table
 * keeps only the current row, but every attempt that reached a protected
 * table is stamped with the epoch it was written under, and a refused one is
 * stamped with the epoch that was refused. {@link appliedEpochRegressions}
 * reads the single-writer property out of it by query (D-0001: from SQLite
 * alone).
 *
 * Filter by `resource`, which is what the single-writer property is about:
 * one lease's epochs, across every effect taken under it. Epochs belong to a
 * resource and two resources allocate theirs independently, so an unfiltered
 * history is several sequences shuffled together and no ordering claim over
 * it means anything -- which is why the regression check refuses a history
 * spanning more than one resource. `kind` narrows further, to a single
 * effect.
 *
 * Rows come back in the database's own insertion order (`rowid`, exposed as
 * `write_seq`), never in the caller's clock order -- see
 * {@link WRITE_HISTORY_QUERY}.
 *
 * **This reads `action`, and only `action`.** A protected write to another
 * table -- S7's `outbox` is the case in point -- stamps `writer_epoch` on
 * *its own* row, and its history is read there by the same shape of query.
 * Nothing here synthesises an action row per protected write, and that is
 * deliberate: `action` is the exactly-once *effect* record, guarded by
 * `action_one_effect_per_key`, and manufacturing a row for a write that is
 * not an effect would corrupt the evidence gate item 4 is read out of. What
 * `action` does carry for every table is the **refusals**, because a
 * refused write has no row of its own to be stamped on.
 *
 * Rows come back exactly as read -- the database's own snake_case column
 * names, unfrozen individually, matching the source's plain `dict` rows
 * (only the outer tuple is immutable, mirrored here with `Object.freeze` on
 * the returned array).
 */
export function writeHistory(
  connection: SqliteDatabase,
  options?: { readonly resource?: string | null; readonly kind?: string | null },
): readonly Readonly<Record<string, unknown>>[] {
  const rows = connection
    .prepare(WRITE_HISTORY_QUERY)
    .all({ kind: options?.kind ?? null, resource: options?.resource ?? null }) as Record<
    string,
    unknown
  >[];
  return Object.freeze(rows);
}

/**
 * Applied writes, in time order, whose epoch goes backwards.
 *
 * Any pair returned is a rejected writer that got in anyway: its row landed
 * between two rows written under a later epoch, which is exactly the
 * interleaving `ACCEPTANCE.md` section 2 asks the history not to contain.
 * Refused rows are ignored -- they are the record that the writer was kept
 * out, so their epochs are expected to be lower than what surrounds them.
 *
 * The order is the rows' own insertion order, not their timestamps: the
 * clock is the caller's and the suite skews it on purpose.
 *
 * @throws {LeaseUsageError} if `history` spans more than one leased
 *   resource, or contains a kind {@link effectKind} did not compose. Epochs
 *   are allocated per resource and two resources' sequences are unrelated,
 *   so comparing them would report a valid epoch 2 for one resource
 *   followed by a valid epoch 1 for another as a violation -- and would
 *   hide real interleavings behind the noise. Several *effects* under the
 *   same lease do belong in one history, and are kept together.
 */
export function appliedEpochRegressions(
  history: readonly Readonly<Record<string, unknown>>[],
): readonly (readonly [Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>])[] {
  const resources = new Set(history.map((row) => resourceOfKind(row.kind as string)));
  if (resources.size > 1) {
    throw new LeaseUsageError(
      `this history spans resources ${pythonList([...resources].sort())}, whose epochs were ` +
        "allocated under different leases and are not comparable. Filter with " +
        "write_history(resource=...) -- one leased resource at a time, across every effect " +
        "taken under it",
    );
  }

  const applied = history.filter((row) => row.status === "applied");
  const regressions: (readonly [
    Readonly<Record<string, unknown>>,
    Readonly<Record<string, unknown>>,
  ])[] = [];
  for (let index = 0; index + 1 < applied.length; index += 1) {
    const first = applied[index] as Readonly<Record<string, unknown>>;
    const second = applied[index + 1] as Readonly<Record<string, unknown>>;
    if ((second.writer_epoch as number) < (first.writer_epoch as number)) {
      regressions.push(Object.freeze([first, second]));
    }
  }
  return Object.freeze(regressions);
}

// --------------------------------------------------------------------------
// external destinations
// --------------------------------------------------------------------------

/**
 * What one place an effect lands can do about a stale token.
 *
 * Named for the property and not for the place, because S7's `Destination`
 * is the *place*: a delivery target with a receipt. This is a register
 * entry about one -- whether a stale epoch can be refused there, and what is
 * left over when it cannot.
 *
 * `ACCEPTANCE.md` section 2 asks that where a destination can enforce a
 * stale token it does, and where it cannot, that this is written down
 * rather than assumed away. This type is that sentence made unskippable: a
 * destination that cannot enforce must carry a *residual*, and one that can
 * must not pretend to carry one.
 */
export class DestinationFencing {
  readonly name: string;
  readonly enforcesStaleToken: boolean;
  readonly note: string;
  readonly residual: string | null;

  constructor(options: {
    readonly name: string;
    readonly enforcesStaleToken: boolean;
    readonly note: string;
    readonly residual?: string | null;
  }) {
    requireIdentifier("name", options.name);
    requireIdentifier("note", options.note);
    const residual = options.residual ?? null;
    if (options.enforcesStaleToken && residual !== null) {
      throw new LeaseUsageError(
        `destination ${pythonRepr(options.name)} enforces the token, so it has no residual to ` +
          "record; a residual here would read as a known gap where there is none",
      );
    }
    if (!options.enforcesStaleToken && (residual ?? "").trim() === "") {
      throw new LeaseUsageError(
        `destination ${pythonRepr(options.name)} cannot enforce the fencing token and records no ` +
          "residual. ACCEPTANCE.md section 2 requires the gap to be written down rather than " +
          "assumed away, so the register refuses the entry rather than accepting a silent one",
      );
    }
    this.name = options.name;
    this.enforcesStaleToken = options.enforcesStaleToken;
    this.note = options.note;
    this.residual = residual;
    Object.freeze(this);
  }
}

function register(
  ...destinations: readonly DestinationFencing[]
): Readonly<Record<string, DestinationFencing>> {
  const table: Record<string, DestinationFencing> = {};
  for (const destination of destinations) {
    if (Object.hasOwn(table, destination.name)) {
      throw new LeaseUsageError(`duplicate destination ${pythonRepr(destination.name)}`);
    }
    table[destination.name] = destination;
  }
  return Object.freeze(table);
}

/**
 * Where the spike's protected effects land, and what each does about a
 * stale token. `docs/lease-fencing.md` carries the same table for a reader,
 * and the suite asserts the two agree -- a written-down residual that
 * drifts from the code is a residual nobody is holding any more.
 */
export const DESTINATIONS: Readonly<Record<string, DestinationFencing>> = register(
  new DestinationFencing({
    name: "control_plane_sqlite",
    enforcesStaleToken: true,
    note:
      "The fence is a clause of the write itself, evaluated by SQLite in the same statement, " +
      "so a stale epoch changes no row and the refusal is recorded as an action row.",
  }),
  new DestinationFencing({
    name: "reference_epoch_guarded_destination",
    enforcesStaleToken: true,
    note:
      "EpochGuardedDestination: keeps its own highest-epoch-seen record per resource and " +
      "rejects anything below it, and deduplicates by effect key. Its own record is the " +
      "evidence, which is what ACCEPTANCE.md section 2 requires of an external effect.",
  }),
  new DestinationFencing({
    name: "session_provider_child_process",
    enforcesStaleToken: false,
    note:
      "A spawned claude -p child takes no token and keeps no effect record. Its own " +
      "duplicate refusal is not a substitute: U27 measures an admission window in which two " +
      "writers both exited 0 and both wrote, and U32 finds no exclusion at all on the " +
      "--resume path (investigation/pre-spawn-fence-search.md section 5.3).",
    residual:
      "Effects on it must be transactional_with_record -- the control-plane row and the " +
      "spawn decision commit together -- or a human gate (D-0004). Nothing in the spike " +
      "treats the provider's own refusal as a fence.",
  }),
  new DestinationFencing({
    name: "worktree_filesystem",
    enforcesStaleToken: false,
    note:
      "A file write carries no epoch, and the filesystem has no idempotency surface to " +
      "reject one with.",
    residual:
      "The control-plane row is written under the fence first and the file write is derived " +
      "from it, so a stale writer never reaches the filesystem; a write that must happen the " +
      "other way round is a human gate (D-0004). Gate item 7 covers the worktree lifecycle " +
      "itself and is not answered here.",
  }),
);

/**
 * A reference external destination that enforces the fencing token itself.
 *
 * Two properties, and they are separate: it refuses an epoch below the
 * highest it has seen for a resource (the fence), and it applies each
 * effect key once (idempotency). Both are read out of **its own** record,
 * never ours -- `ACCEPTANCE.md` section 2 is explicit that a case
 * certifying exactly-once for an external effect from our rows alone does
 * not count.
 *
 * In-process and deliberately trivial: it stands in for a destination with
 * an idempotency surface so the enforcing half of the criterion is
 * demonstrated rather than asserted.
 */
export class EpochGuardedDestination {
  readonly name: string;
  private readonly highestEpochByResource = new Map<string, number>();
  private readonly effects = new Map<string, unknown>();
  readonly rejected: Array<readonly [string, string, number]> = [];

  constructor(name = "reference_epoch_guarded_destination") {
    this.name = name;
  }

  /**
   * Apply `payload` under `effectKey`, or reject the epoch.
   *
   * @returns `true` if this call produced the effect, `false` if the key
   *   had already been applied -- a duplicate delivery, absorbed.
   * @throws {DestinationRejectedStaleToken} if `epoch` is below the highest
   *   this destination has accepted for `resource`.
   */
  apply(options: {
    readonly resource: string;
    readonly holder: string;
    readonly epoch: number;
    readonly effectKey: string;
    readonly payload: unknown;
  }): boolean {
    const { resource, holder, epoch, effectKey, payload } = options;
    // Python annotates `epoch: int`, and an `int` cannot be NaN -- so a caller
    // obeying the source's type cannot reach the hazard below. TypeScript's
    // `number` DOES include NaN, so the port's type admits a value the
    // source's does not, and the widening is what makes the check necessary
    // here and unnecessary there.
    //
    // Left unchecked, the first NaN is stored by `Math.max` and every later
    // comparison `epoch < NaN` is false, so this destination's fencing is
    // permanently disabled for that resource -- silently, and for exactly the
    // resource an attacker chose.
    if (!Number.isInteger(epoch) || epoch < 1) {
      throw new LeaseUsageError(
        `epoch must be a positive int, got ${pythonRepr(epoch)}; a non-integer epoch would ` +
          "poison this destination's watermark and disable the fencing it advertises",
      );
    }
    const highest = this.highestEpochByResource.get(resource);
    if (highest !== undefined && epoch < highest) {
      this.rejected.push([resource, holder, epoch]);
      throw new DestinationRejectedStaleToken(
        `${this.name} rejects epoch ${epoch} for ${pythonRepr(resource)} from ${pythonRepr(holder)}: it ` +
          `has already accepted epoch ${highest}`,
      );
    }
    this.highestEpochByResource.set(resource, Math.max(epoch, highest ?? 0));
    if (this.effects.has(effectKey)) {
      return false;
    }
    this.effects.set(effectKey, payload);
    return true;
  }

  /** How many times `effectKey` landed. The destination's own record. */
  effectCount(effectKey: string): number {
    return this.effects.has(effectKey) ? 1 : 0;
  }

  /** The highest epoch this destination has accepted for `resource`. */
  highestEpoch(resource: string): number | undefined {
    return this.highestEpochByResource.get(resource);
  }
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * Own a `BEGIN IMMEDIATE` transaction for the duration of `body`.
 *
 * Immediate rather than deferred: the write lock is taken before the first
 * statement, so a second connection cannot slip a lease change between the
 * write and the classification of its outcome. Owning it also means the
 * caller may not already be in a transaction -- a lease operation nested
 * inside somebody else's transaction would commit on their schedule, and
 * the refusal record would then be as durable as whatever they decide to do
 * next.
 *
 * Self-contained: unlike `txn.ts`'s `transaction()`, which *joins* an
 * already-open transaction, this module's own `_immediate` -- mirrored here
 * -- refuses one, matching the source exactly. The two are deliberately
 * different functions: this module imports nothing from `txn.ts`.
 */
function withImmediate(connection: SqliteDatabase, body: () => void): void {
  if (connection.inTransaction) {
    throw new LeaseUsageError(
      "this connection is already in a transaction. A lease operation owns its transaction: " +
        "the atomic validation, and the durability of a recorded refusal, are both properties " +
        "of the transaction it commits",
    );
  }
  connection.exec("BEGIN IMMEDIATE");
  try {
    body();
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
  connection.exec("COMMIT");
}

function byEpoch(observations: readonly Lease[]): readonly Lease[] {
  const resources = new Set(observations.map((lease) => lease.resource));
  if (resources.size > 1) {
    throw new LeaseUsageError(
      `a timeline covers one resource; got ${pythonList([...resources].sort())}`,
    );
  }
  const ordered = [...observations].sort((a, b) => a.epoch - b.epoch);
  // Renewals restate an epoch. The last state an epoch was seen in is the
  // one that stood when the next epoch took over, so it is the one the
  // timeline is built from.
  const seen = new Map<number, Lease>();
  for (const lease of ordered) {
    seen.set(lease.epoch, lease);
  }
  return [...seen.keys()].sort((a, b) => a - b).map((epoch) => seen.get(epoch) as Lease);
}
