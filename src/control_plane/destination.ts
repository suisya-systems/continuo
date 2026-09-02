import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pythonJsonDocumentSorted } from "./python_json.js";
import { pythonRepr } from "./python_repr.js";

/**
 * S7 -- the destination, and the idempotency record that is **not ours**.
 *
 * **Spike scaffold, throwaway by default (D-0026), and unchanged by the
 * endpoint's move onto the production schema.** Nothing in this module is
 * promoted by being depended on, by being imported, or by having survived a
 * gate run. That sentence used to open with "like the S5 schema it sits on",
 * and that clause has stopped being true: `src/messagebus/endpoint.ts` opens
 * its control plane through `openProductionControlPlane`, so the outbox whose
 * handler reaches this destination is a production one under migration 0003's
 * status lattice. `Q-0001` was open when this module was written and D-0029
 * has since resolved it in the production schema
 * (`docs/production-schema.md` section 4.2,
 * `control_plane/migrations/0001_initial.sql`).
 *
 * The database moving does not promote what is here, because the two were
 * never provisional for the same reason. The S5 schema was a *draft* of a
 * thing we now have; {@link KeyedDropbox} is a *stand-in* for a thing we do
 * not -- a directory of files is not a transport, and the section below on
 * what the filesystem implementation stands in for is deliberate about which
 * single property of a real destination it models and how little else. So the
 * destination side is now the scaffold left on this path, and replacing it
 * with a real keyed destination is the next thing to do. Until that happens
 * the honest reading of a green gate run is that the *mechanism* holds against
 * a counterparty chosen to be small, not that delivery is built.
 *
 * Why this module exists at all, and why it is a separate file from the
 * handler that uses it.
 *
 * `ACCEPTANCE.md` section 2 draws a line that most of the outbox does not have
 * to care about, and that this file is entirely about:
 *
 * **SQLite alone cannot distinguish "the side effect completed" from "the side
 * effect never started"**, because by construction the result was not
 * recorded. *A case that asserts exactly-once for an external effect using
 * only our own rows does not pass.*
 *
 * That last sentence is a rule about **evidence**, and it is the acceptance
 * criterion of Issue `#14` that is easiest to satisfy by accident and hardest
 * to satisfy honestly. Our `action` table has a unique index on
 * `idempotency_key`; it is trivially possible to write a test that inserts one
 * row, fails to insert a second, and declares exactly-once proven. Such a test
 * proves that *we did not record two effects*. It does not prove that *two
 * effects did not happen* -- and those two statements come apart at exactly
 * the injection point the gate cares about, the kill after the effect but
 * before its result is recorded.
 *
 * So the counterparty is a real, separate, durable store with **its own**
 * deduplication, reached through {@link Destination}, and the exactly-once
 * evidence is read back out of that store. It lives in its own module rather
 * than beside the handler so that the separation is structural and visible: a
 * reader looking for "where do we cheat?" can see that the ledger the
 * assertions read is not written by the same transaction that writes our
 * rows. The strongest form of that, which the suite exercises, is to **delete
 * the control-plane database entirely** and ask the destination how many
 * effects it applied. The answer is still one.
 *
 * **What the filesystem implementation stands in for.** {@link KeyedDropbox}
 * is a spike stand-in for a destination that supports an idempotency key --
 * the shape of an HTTP API taking an `Idempotency-Key` header, or a queue that
 * refuses a duplicate `MessageDeduplicationId`. It models the property the
 * gate turns on, which is that **the destination**, not the sender, refuses
 * the second effect. Concretely the exclusion comes from `O_EXCL`: the
 * operating system, not our code and not our transaction, decides which of two
 * racing applies created the key. Nothing else about a real destination is
 * modelled and nothing here should be mistaken for a transport.
 *
 * **Publishing is one atomic step, because a reservation is a trap.** The
 * obvious implementation reserves the key with `O_EXCL` and then fills the
 * record in, and it is wrong in both directions. A reservation that is
 * *treated as an effect* loses the message when its creator dies before
 * writing -- every later attempt is deduplicated against a promise nobody
 * kept. A reservation that is *treated as abandoned* is worse: a second caller
 * cannot distinguish "the creator died" from "the creator has not written
 * yet", so it truncates a file another process is actively writing and two
 * effects proceed at once, which is the exclusion this class exists to
 * provide failing silently.
 *
 * So there is no reservation. The record is written **complete** to a private
 * temporary file, fsynced, and then published with `fs.linkSync`, which fails
 * with `EEXIST` if the key is already taken. Link is atomic and exclusive, so
 * the key file is complete from the instant it is visible and an apply that
 * dies mid-flight leaves nothing but a temporary file -- no effect, and
 * nothing blocking the next attempt. `_COMPLETION_SENTINEL` survives as an
 * integrity check on *read* rather than as a lifecycle state.
 *
 * **The fencing token, where the destination can enforce it.**
 * `ACCEPTANCE.md` section 2 does not stop at deduplication: *external
 * destinations must reject a stale token where they can enforce it*. The
 * window this closes is the one no SQLite statement can -- our writer
 * validates its lease inside its own write, then is paused, and by the time it
 * reaches the destination the lease belongs to someone else. Nothing on our
 * side can refuse that effect, because our side is the thing that was paused.
 * So {@link KeyedDropbox.apply} takes the writer's lease epoch, records the
 * highest one it has honoured, and refuses anything below it: a returning
 * stale writer is turned away by the counterparty, which is the only party
 * still running.
 *
 * **Checking the token and publishing the effect are one critical section.**
 * Separately they are a check-then-write, and the race is not hypothetical: a
 * token-1 writer passes the check, pauses, a token-2 writer advances the fence
 * and publishes, and the first writer resumes and publishes an effect under a
 * token the destination has already superseded. That is the same defect the
 * lease in `spike_schema.sql` avoids by validating its epoch *inside* the
 * protected write rather than in front of it, and it has to be avoided here
 * for the same reason. A real destination would hold both in one server-side
 * transaction; this stand-in holds an `O_EXCL` lock across the pair
 * ({@link KeyedDropbox._locked}). Where it cannot take the lock it **refuses**
 * rather than proceeding unserialised -- the message stays due, which the
 * outbox already handles, and no timeout-based guess about a dead lock holder
 * is made here. Choosing such a timeout is `Q-0003`'s business, not this
 * file's.
 */

// --------------------------------------------------------------------------
// the module's replaceable internals (D-0014)
// --------------------------------------------------------------------------

/**
 * The module's replaceable internal: the id generator behind a staging file's
 * disambiguating suffix.
 *
 * `test_outbox.py` patches nothing here -- no case needs a fixed staging
 * filename -- so this seam exists per D-0014's own reasoning rather than to
 * satisfy a translated case: "a seam nothing routes through is worse than
 * none". Both internal call sites ({@link KeyedDropbox._applyLocked} and
 * {@link KeyedDropbox._honourToken}) go through it.
 *
 * Not re-exported from `src/index.ts`: a testing seam, not public API.
 */
export const destinationSeams = {
  /** `uuid.uuid4().hex`: a lower-case 32-character hex string, no dashes. */
  uuid4Hex: (): string => randomUUID().replace(/-/g, ""),
};

// --------------------------------------------------------------------------
// constants
// --------------------------------------------------------------------------

/**
 * Suffix of one effect record. One file per idempotency key, and the key is
 * hashed into the name because an idempotency key is an opaque string that may
 * contain separators, may be longer than a path component, and may differ from
 * another key only in case on a case-insensitive filesystem.
 */
export const EFFECT_SUFFIX = ".effect.json";

/**
 * The append-only record of every `apply` call, deduplicated or not.
 *
 * The effect ledger alone cannot distinguish "one attempt, one effect" from
 * "four attempts, one effect", and the second is the interesting one: it is
 * what proves the destination *refused* the duplicates rather than never
 * having been offered them. A test that shows one effect without showing the
 * attempts that were turned away has not shown deduplication happening.
 */
export const ATTEMPT_LOG_NAME = "attempts.log";

/**
 * The lock serialising the fence check against effect publication. Held for
 * the duration of two local filesystem operations and no external I/O, so it
 * is uncontended in practice.
 */
export const LOCK_NAME = "fence.lock";

/**
 * Where the highest honoured fencing token is kept, **per fence scope**.
 *
 * One entry per scope rather than one per key: a lease fences a *writer*, not
 * an individual effect, so a token that has been superseded is stale for
 * everything that writer might send. But epochs from different leases are
 * different sequences, and a single destination-wide maximum silently
 * conflates them -- after a writer on one resource applies at epoch 10, a
 * perfectly live writer on another resource at epoch 1 would be refused
 * forever. The scope is the lease resource the token was drawn from, so each
 * sequence is compared only against itself.
 */
export const FENCE_NAME = "fence.json";

/**
 * A record ends with this byte. Records are published complete (see the
 * module docstring), so a file without it is a damaged read rather than a
 * lifecycle state -- and it is still refused, because a partial record is not
 * evidence.
 */
const _COMPLETION_SENTINEL = "\n";

/** How many times {@link KeyedDropbox._locked} retries before refusing. */
const _LOCK_ATTEMPTS = 2000;

/** The stored name of a fence scope. `null` is its own scope, not a wildcard. */
function _scopeKey(fenceScope: string | null): string {
  return fenceScope === null ? "" : fenceScope;
}

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/**
 * The destination refused an apply outright.
 *
 * Distinct from deduplication, which is a *success*: the effect is present and
 * the caller may stop. A refusal means the destination will not carry the
 * effect at all, and the caller must not record it as applied.
 */
export class DestinationRefusal extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DestinationRefusal";
    Object.setPrototypeOf(this, DestinationRefusal.prototype);
  }
}

/**
 * The apply carried a fencing token the destination has already superseded.
 *
 * The refusal `ACCEPTANCE.md` section 2 asks external destinations to make
 * *"where they can enforce it"*. It is the only rejection available once our
 * own writer has been paused past its lease: SQLite cannot refuse a statement
 * that is never issued, so the counterparty has to.
 */
export class StaleTokenRefused extends DestinationRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StaleTokenRefused";
    Object.setPrototypeOf(this, StaleTokenRefused.prototype);
  }
}

// --------------------------------------------------------------------------
// the receipt and the protocol
// --------------------------------------------------------------------------

/**
 * What the destination says about one `apply` call.
 *
 * This is the artifact the exactly-once claim is grounded in, so it names its
 * own origin: {@link destination} and {@link receiptRef} together are a handle
 * an operator can follow to the destination's record without going through any
 * table of ours.
 *
 * Frozen at construction, mirroring the source's `@dataclass(frozen=True)`.
 */
export class DeliveryReceipt {
  /** The key the destination deduplicated on. */
  readonly idempotencyKey: string;
  /**
   * `true` when the destination recognised the key and did **not** apply a
   * second effect. The caller's correct response is to proceed exactly as if
   * it had applied one -- that is what makes replay safe.
   */
  readonly deduplicated: boolean;
  /** The destination's identity, for the record we keep of what we talked to. */
  readonly destination: string;
  /** The destination's **own** reference to its idempotency record. */
  readonly receiptRef: string;
  /**
   * `true` when the key was already present under a *different* payload. The
   * destination still applies nothing -- an idempotency key names an effect,
   * so the same key with new content is a caller bug, not a new effect -- but
   * it is surfaced rather than swallowed, because silently deduplicating a
   * payload the caller did not send before would hide a dedup-key collision
   * behind an exactly-once guarantee.
   */
  readonly payloadConflict: boolean;
  /**
   * The fencing token the destination honoured for this apply, if one was
   * offered. Recorded so that "the destination accepted this writer" is an
   * assertable fact rather than an inference from the effect existing.
   */
  readonly fencingToken: number | null;

  constructor(options: {
    readonly idempotencyKey: string;
    readonly deduplicated: boolean;
    readonly destination: string;
    readonly receiptRef: string;
    readonly payloadConflict?: boolean;
    readonly fencingToken?: number | null;
  }) {
    this.idempotencyKey = options.idempotencyKey;
    this.deduplicated = options.deduplicated;
    this.destination = options.destination;
    this.receiptRef = options.receiptRef;
    this.payloadConflict = options.payloadConflict ?? false;
    this.fencingToken = options.fencingToken ?? null;
    Object.freeze(this);
  }
}

/**
 * An external effect target that deduplicates on an idempotency key.
 *
 * The mechanism `'destination_idempotency_key'` in `ACCEPTANCE.md` section 2
 * is exactly "there is one of these behind the handler". A handler declaring
 * that mechanism without a counterparty implementing this interface is
 * declaring something it cannot support.
 *
 * The source expresses this as a `runtime_checkable Protocol` and checks it
 * with `isinstance`; {@link isDestination} is the structural check that stands
 * in for that here (D-0007's kin: TypeScript has no runtime protocol check of
 * its own).
 */
export interface Destination {
  /** Stable identity, recorded on the receipt. */
  readonly name: string;

  /**
   * Apply the effect, or recognise that it is already applied.
   *
   * Must be safe to call any number of times with the same key: that is the
   * entire content of the guarantee the handler is allowed to claim.
   *
   * *fencingToken* is the caller's lease epoch. A destination that can enforce
   * it must refuse a token below one it has already honoured
   * ({@link StaleTokenRefused}); one that cannot must ignore it rather than
   * pretend, since a token accepted without being checked is worse than no
   * token at all.
   *
   * *fenceScope* names the sequence the token was drawn from -- in practice
   * the lease resource. Tokens from different leases are different sequences
   * and comparing them against one another rejects live writers, so a
   * destination that enforces tokens must keep one maximum per scope.
   */
  apply(
    idempotencyKey: string,
    payload: string,
    fencingToken?: number | null,
    fenceScope?: string | null,
  ): DeliveryReceipt;

  /**
   * How many completed effects the destination holds for *idempotencyKey*.
   *
   * The number the gate reads. Anything other than `1` after a delivery has
   * been acked is a failure of item 4, whatever our own rows say.
   */
  effectCount(idempotencyKey: string): number;

  /** How many times `apply` was called for *idempotencyKey*, deduplicated or not. */
  attemptCount(idempotencyKey: string): number;
}

/**
 * Structural stand-in for `isinstance(x, Destination)` against the
 * `runtime_checkable Protocol` the source declares. Checks the presence of
 * every member the protocol names, not their types -- exactly what a
 * `runtime_checkable` Protocol's own `isinstance` does.
 */
export function isDestination(candidate: unknown): candidate is Destination {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const value = candidate as Record<string, unknown>;
  // Presence only, not types. `isinstance(x, Destination)` against a
  // `runtime_checkable` Protocol checks that the attributes EXIST; it does not
  // check what they are. Requiring `typeof name === "string"` would refuse an
  // object Python accepts, which is the port being stricter than its source
  // (criterion 5) in the one place the source's own test drives a
  // deliberately-odd stand-in.
  return "name" in value && "apply" in value && "effectCount" in value && "attemptCount" in value;
}

// --------------------------------------------------------------------------
// KeyedDropbox
// --------------------------------------------------------------------------

/**
 * A directory as a destination with its own idempotency ledger.
 *
 * One file per idempotency key, created with `O_EXCL` so that the exclusion
 * belongs to the operating system rather than to a check-then-write in this
 * process -- the same reason the lease in `spike_schema.sql` validates its
 * epoch inside the protected write rather than before it.
 */
export class KeyedDropbox implements Destination {
  readonly name: string;
  private readonly _root: string;

  constructor(root: string, name = "keyed-dropbox") {
    this.name = name;
    this._root = root;
    fs.mkdirSync(this._root, { recursive: true });
  }

  // -- the protocol -----------------------------------------------------

  apply(
    idempotencyKey: string,
    payload: string,
    fencingToken: number | null = null,
    fenceScope: string | null = null,
  ): DeliveryReceipt {
    if (!idempotencyKey) {
      // An empty key is not a key: every effect would deduplicate against
      // every other one, which is the failure mode that looks most like
      // success.
      throw new DestinationRefusal("an idempotency key may not be empty");
    }

    const effectPath = this._effectPath(idempotencyKey);
    const digest = createHash("sha256").update(payload, "utf-8").digest("hex");
    this._logAttempt(idempotencyKey, digest, fencingToken);

    // Everything from here to the publish is one critical section. Checking
    // the token and then publishing would be a check-then-write, and the
    // race it leaves is the whole point of a fence: a superseded writer that
    // passed the check while paused would publish anyway.
    return this._locked(() =>
      this._applyLocked(idempotencyKey, payload, digest, effectPath, fencingToken, fenceScope),
    );
  }

  private _applyLocked(
    idempotencyKey: string,
    payload: string,
    digest: string,
    effectPath: string,
    fencingToken: number | null,
    fenceScope: string | null,
  ): DeliveryReceipt {
    // The fence is honoured before anything else, and before the
    // already-applied shortcut: a stale writer must be told it is stale even
    // when the effect it carries happens to be present, or it would read a
    // deduplicated success as evidence that it is still the live holder.
    this._honourToken(fencingToken, fenceScope);

    const existing = this._readRecord(effectPath);
    if (existing !== null) {
      // A completed record. The effect is present; applying again is the
      // thing this destination exists to refuse.
      return new DeliveryReceipt({
        idempotencyKey,
        deduplicated: true,
        destination: this.name,
        receiptRef: path.basename(effectPath),
        payloadConflict: existing.payload_sha256 !== digest,
        fencingToken,
      });
    }

    const record = pythonJsonDocumentSorted({
      idempotency_key: idempotencyKey,
      payload_sha256: digest,
      payload,
      fencing_token: fencingToken,
    });

    // Written complete to a private file, then published by link. There is
    // deliberately no reservation step: see the module docstring on why a
    // half-written key file is a trap in both directions.
    const staging = path.join(this._root, `.${process.pid}.${destinationSeams.uuid4Hex()}.staging`);
    try {
      const handle = fs.openSync(
        staging,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        fs.writeSync(handle, record + _COMPLETION_SENTINEL, null, "utf-8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }

      try {
        fs.linkSync(staging, effectPath);
      } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        // Another apply published this key first. Link is atomic, so what is
        // there is complete -- there is no window in which a concurrent
        // writer is still filling it in.
        const settled = this._readRecord(effectPath);
        if (settled === null) {
          throw new DestinationRefusal(
            `${path.basename(effectPath)} exists at ${pythonRepr(this.name)} but does not read ` +
              "back as a complete record; refusing rather than applying a second effect " +
              "against a damaged one",
          );
        }
        return new DeliveryReceipt({
          idempotencyKey,
          deduplicated: true,
          destination: this.name,
          receiptRef: path.basename(effectPath),
          payloadConflict: settled.payload_sha256 !== digest,
          fencingToken,
        });
      }
    } finally {
      // A crash before this leaves a staging file and nothing else: no
      // effect, and nothing blocking the next attempt. Routed through
      // `_unlinkIgnoringMissing` rather than a try/catch written out here:
      // an unexpected (non-ENOENT) error still propagates and still
      // overwrites whatever the try block above was doing, exactly as
      // Python's `except FileNotFoundError: pass` inside a `finally` does --
      // only indirected through a function call so the throw is not
      // syntactically inside this `finally` block.
      _unlinkIgnoringMissing(staging);
    }

    this._fsyncRoot();
    return new DeliveryReceipt({
      idempotencyKey,
      deduplicated: false,
      destination: this.name,
      receiptRef: path.basename(effectPath),
      fencingToken,
    });
  }

  /**
   * Hold an `O_EXCL` lock for the fence-check-and-publish pair.
   *
   * Bounded spin, then a refusal. A lock that could be *stolen* after some
   * interval would need that interval chosen, and choosing it is `Q-0003`
   * (tolerable detection latency) rather than this file's call -- so a lock
   * that cannot be taken is reported as a refusal, the message stays due, and
   * nothing is guessed about whoever holds it.
   */
  private _locked<T>(body: () => T): T {
    const lock = path.join(this._root, LOCK_NAME);
    let handle: number | null = null;
    for (let attempt = 0; attempt < _LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = fs.openSync(
          lock,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
        break;
      } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
    if (handle === null) {
      throw new DestinationRefusal(
        `${pythonRepr(this.name)} is busy: could not serialise the fence check against effect ` +
          `publication after ${_LOCK_ATTEMPTS} attempts`,
      );
    }
    try {
      return body();
    } finally {
      fs.closeSync(handle);
      _unlinkIgnoringMissing(lock);
    }
  }

  /** The highest fencing token accepted for *fenceScope*, if any. */
  honouredToken(fenceScope: string | null = null): number | null {
    return this._fence()[_scopeKey(fenceScope)] ?? null;
  }

  private _fence(): Record<string, number> {
    const fence = path.join(this._root, FENCE_NAME);
    if (!fs.existsSync(fence)) {
      return Object.create(null) as Record<string, number>;
    }
    const raw = JSON.parse(fs.readFileSync(fence, "utf-8")) as Record<string, unknown>;
    // A NULL-prototype map, because Python's `dict` has no inherited keys and a
    // JavaScript object literal does. The scope this is keyed by is the
    // caller's lease RESOURCE -- an unconstrained constructor argument -- so a
    // resource named `constructor`, `toString`, `valueOf`, `hasOwnProperty` or
    // `__proto__` would otherwise read a value off `Object.prototype` and
    // change what the fence decides, with no counterpart in the source.
    // Lesson 14: Python's type excludes the value, TypeScript's does not.
    const result: Record<string, number> = Object.create(null);
    for (const [scope, token] of Object.entries(raw)) {
      result[String(scope)] = Number(token);
    }
    return result;
  }

  effectCount(idempotencyKey: string): number {
    return this._readRecord(this._effectPath(idempotencyKey)) !== null ? 1 : 0;
  }

  attemptCount(idempotencyKey: string): number {
    return this.attempts().filter(([key]) => key === idempotencyKey).length;
  }

  // -- reading the ledger back, which is what the assertions do ---------

  /** Every idempotency key the destination holds a completed effect for. */
  effects(): readonly string[] {
    const keys: string[] = [];
    const entries = fs.existsSync(this._root)
      ? fs.readdirSync(this._root).filter((name) => name.endsWith(EFFECT_SUFFIX))
      : [];
    entries.sort();
    for (const entry of entries) {
      const record = this._readRecord(path.join(this._root, entry));
      if (record !== null) {
        keys.push(String(record.idempotency_key));
      }
    }
    return Object.freeze(keys);
  }

  /** The payload the *first* completed apply carried, or `null`. */
  payloadOf(idempotencyKey: string): string | null {
    const record = this._readRecord(this._effectPath(idempotencyKey));
    return record === null ? null : String(record.payload);
  }

  /** `[idempotencyKey, payloadSha256]` for every apply, in order. */
  attempts(): readonly (readonly [string, string])[] {
    const log = path.join(this._root, ATTEMPT_LOG_NAME);
    if (!fs.existsSync(log)) {
      return Object.freeze([]);
    }
    const rows: (readonly [string, string])[] = [];
    for (const line of fs.readFileSync(log, "utf-8").split("\n")) {
      if (!line) {
        continue;
      }
      const entry = JSON.parse(line) as { idempotency_key: unknown; payload_sha256: unknown };
      rows.push([String(entry.idempotency_key), String(entry.payload_sha256)]);
    }
    return Object.freeze(rows);
  }

  // -- internals --------------------------------------------------------

  private _effectPath(idempotencyKey: string): string {
    const stem = createHash("sha256").update(idempotencyKey, "utf-8").digest("hex");
    return path.join(this._root, `${stem}${EFFECT_SUFFIX}`);
  }

  /**
   * The record at *effectPath* if it is complete, else `null`.
   *
   * Incompleteness is not corruption: it is an apply that died after
   * reserving the key. Reporting it as absent is what lets the next attempt
   * finish the effect instead of being deduplicated against a promise nobody
   * kept.
   */
  private _readRecord(effectPath: string): Record<string, unknown> | null {
    let raw: string;
    try {
      raw = fs.readFileSync(effectPath, "utf-8");
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return null;
    }
    if (!raw.endsWith(_COMPLETION_SENTINEL)) {
      return null;
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private _logAttempt(idempotencyKey: string, digest: string, fencingToken: number | null): void {
    const line = pythonJsonDocumentSorted({
      idempotency_key: idempotencyKey,
      payload_sha256: digest,
      fencing_token: fencingToken,
    });
    // Appended before the effect is applied, so an attempt that dies
    // mid-apply is still counted. An attempt log that only recorded successes
    // could not distinguish a duplicate that was refused from one that was
    // never made.
    const handle = fs.openSync(
      path.join(this._root, ATTEMPT_LOG_NAME),
      fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY,
      0o600,
    );
    try {
      fs.writeSync(handle, `${line}\n`, null, "utf-8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  /**
   * Refuse a token below the highest one already honoured *for its scope*.
   *
   * An apply carrying no token is not fenced and is let through unchanged:
   * pretending to check one that was never offered would be the "token
   * accepted without being checked" the protocol warns about. Once a token
   * *is* offered, it is recorded, and every later apply in the same scope is
   * measured against it -- so the transition from unfenced to fenced is
   * one-way, per scope.
   */
  protected _honourToken(fencingToken: number | null, fenceScope: string | null): void {
    if (fencingToken === null) {
      return;
    }
    // Python annotates `fencing_token: int | None`, and an `int` is neither
    // fractional nor NaN nor Infinity -- so a caller obeying the source's type
    // cannot reach what follows. TypeScript's `number` admits all three, and
    // `Destination.apply` is public API, so the widening is what makes this
    // check necessary here and unnecessary there (lesson 14).
    //
    // Unchecked, a fractional 1.5 persists as this scope's watermark and then
    // refuses the legitimate epoch 1 as stale; NaN and Infinity get as far as
    // creating a staging file before failing in JSON rendering, leaving a
    // partial write behind for a value that was never admissible.
    if (!Number.isInteger(fencingToken) || fencingToken < 1) {
      throw new DestinationRefusal(
        `a fencing token must be a positive int, got ${pythonRepr(fencingToken)}; a token that is ` +
          "not one would become this scope's watermark and refuse the epochs that follow it",
      );
    }
    const scope = _scopeKey(fenceScope);
    const fence = this._fence();
    const highest = Object.hasOwn(fence, scope) ? fence[scope] : undefined;
    if (highest !== undefined && fencingToken < highest) {
      throw new StaleTokenRefused(
        `${pythonRepr(this.name)} has honoured fencing token ${highest} for scope ` +
          `${pythonRepr(scope)} and refuses ${fencingToken}: the writer offering it was ` +
          "superseded while it was away",
      );
    }
    if (highest === undefined || fencingToken > highest) {
      fence[scope] = fencingToken;
      const staging = path.join(this._root, `.${process.pid}.${destinationSeams.uuid4Hex()}.fence`);
      fs.writeFileSync(staging, pythonJsonDocumentSorted(fence), "utf-8");
      // Replace rather than rewrite in place: a torn fence file would read
      // back as no fence at all, which is the one failure that silently
      // re-admits every stale writer.
      fs.renameSync(staging, path.join(this._root, FENCE_NAME));
    }
  }

  protected _fsyncRoot(): void {
    // A record whose file exists only in the directory cache is a durable
    // claim that is not durable -- the same reason schema.ts sets
    // `synchronous = FULL`. Directory fsync is POSIX-only; on Windows the
    // handle fsync above is what there is.
    let handle: number;
    try {
      handle = fs.openSync(this._root, fs.constants.O_RDONLY);
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EACCES" || code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP") {
        return;
      }
      throw error;
    }
    try {
      fs.fsyncSync(handle);
    } catch {
      // platform dependent; not every filesystem supports fsync on a
      // directory handle
    } finally {
      fs.closeSync(handle);
    }
  }
}

/**
 * `fs.unlinkSync`, tolerating "already gone". Mirrors the two `except
 * FileNotFoundError: pass` blocks the source runs at cleanup time -- a lock
 * or staging file that is already gone by the time cleanup runs is not an
 * error, and anything else still propagates.
 */
function _unlinkIgnoringMissing(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
