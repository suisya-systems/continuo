import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * One transaction, taken up front, shared by every writer on the spine.
 *
 * `docs/production-schema.md` section 5.4 and `D-0030` do not say "these
 * writes should be atomic"; they say the append **is** one transaction --
 * the event, the per-consumer `event_consumption` rows, the `outbox` row for
 * every delivery subscriber and any typed side table commit together or
 * none of them do. That is what removes v1's push-vs-poll duplication: an
 * event that exists with no delivery record is exactly the window the
 * second delivery path was invented to paper over. So the boundary itself
 * has to be a single, named, reviewable thing rather than a `BEGIN` that
 * each module spells its own way.
 *
 * Three properties are load-bearing, and each is here rather than in a
 * convention.
 *
 * **`BEGIN IMMEDIATE`, not `BEGIN`.** A deferred transaction takes the
 * write lock at its first *write*, so two appenders can both start, both
 * read the subscription table, and only then discover the conflict -- one
 * of them having already made decisions from a snapshot that the other
 * invalidated. Taking the lock up front makes the collision happen at the
 * first statement, where the loser has decided nothing yet. Section 5.4
 * requires the subscriber `SELECT` to be inside the same transaction as the
 * fan-out write for precisely this reason, and a deferred `BEGIN` would
 * make that requirement satisfiable in letter while leaving the race in
 * place.
 *
 * **Autocommit is checked, not assumed -- adapted, because the driver has
 * no equivalent state to check.** Python's `sqlite3` opens a transaction of
 * its own before a DML statement and commits it at the next DDL or at
 * `connection.commit()` *unless* `isolation_level` is `None`; the source
 * refuses any connection where it is not. better-sqlite3 has no
 * `isolation_level` and no such implicit-transaction mode at all --
 * measured directly (see `test/contract/better-sqlite3-transaction-state.
 * test.ts`): every statement outside an explicit `BEGIN` is autocommit,
 * unconditionally, for the lifetime of the connection. So the hazard the
 * Python check exists to catch -- a driver silently committing a step of a
 * multi-statement invariant on its own -- cannot occur on this driver at
 * all, and there is no analogous flag to read back. {@link inAutocommit} is
 * kept as the identity function it already is under better-sqlite3, for
 * call-site parity with code that carries it over from the Python source
 * (`transaction(inAutocommit(connection))`), and {@link
 * TransactionUsageError} is kept for the one place this module *can* still
 * refuse a caller: a body that does not run to completion synchronously
 * (below). The property this preserves -- a caller cannot get a
 * half-committed multi-statement invariant -- holds unconditionally on this
 * driver rather than conditionally on a flag, which is a stronger
 * guarantee than the source's, not a weaker one.
 *
 * **Nesting joins rather than nests.** SQLite has no nested transactions
 * (only savepoints), and operations that compose -- `markSkipped`, which
 * settles a consumption *and* appends the `consumption_skipped` event that
 * makes the skip distinguishable from a consumer quietly dropping work --
 * must land in one transaction, not two. So an inner {@link transaction}
 * call on a connection that is already in a transaction joins the outer
 * one: it does not `BEGIN`, does not `COMMIT`, and lets an exception travel
 * outward to the owner that will roll the whole thing back. The
 * alternative -- an inner `COMMIT` -- would publish half of an invariant
 * the outer block was still building.
 *
 * **A fourth property has no Python counterpart: the translation itself can
 * introduce an async hazard, and D-0103 is the standing answer.** Python's
 * `transaction` is a `@contextmanager` used with `with`, whose body cannot
 * "return early and carry on later" -- the scope ends when the body ends.
 * The TypeScript form is a callback, and a callback *can* return a pending
 * `Promise` and carry on: an `async` body would make {@link transaction}
 * commit or roll back before the body's own writes had actually run, which
 * is silently the exact defect this module exists to prevent, arriving
 * through the mechanism meant to prevent it. So a deferred body -- an
 * `async` function, a generator, or a plain function that *returns* a
 * `Promise` or an iterator -- is refused rather than awaited or drained, at
 * both compile time (the body's return type collapses to `never` for a
 * `Promise`) and at runtime, exactly as `measurementSnapshot` in
 * `src/measurement/reader.ts` does for the same reason. Nothing in the
 * control plane is asynchronous: better-sqlite3 is a synchronous driver,
 * and every statement in this module and in `events.ts` is a synchronous
 * call.
 *
 * Nothing anywhere else in the control plane calls `connection.exec("COMMIT")`
 * or `connection.exec("ROLLBACK")` outside a migration step. The commit is
 * here, once.
 */

/**
 * The mutable state of the transaction currently open on a connection.
 *
 * A caller sometimes has to know whether two calls are in *the same*
 * transaction -- section 5.4's back-fill covers "a subscription added in
 * the same transaction as the registration", which is a question about the
 * boundary, not about whether some transaction happens to be open.
 * Answering it from `connection.inTransaction` is wrong in exactly one
 * reachable way: two consecutive {@link transaction} blocks on one
 * connection both report `true` inside, so state left by the first would
 * be read by the second as if it were its own.
 *
 * So the scope is created by the block that issues `BEGIN IMMEDIATE` and
 * removed by the same block in its `finally`: it cannot outlive its
 * transaction, and there is no clearing step elsewhere that could be
 * forgotten.
 *
 * Keyed by the connection object itself in a `WeakMap`, not by an
 * identity-hash the way the source keys by `id(connection)`. That is a
 * genuine strengthening rather than a stylistic swap: Python's `id()` reuse
 * hazard (an id can be reused once its object is freed) is discussed in the
 * source only to be dismissed as unreachable while the connection is held
 * alive by the running block -- a `WeakMap` keyed by the object has no such
 * hazard to dismiss in the first place, and needs no argument for why it is
 * safe.
 */
const _SCOPES = new WeakMap<SqliteDatabase, Record<string, unknown>>();

/**
 * Return the mutable state of the transaction open on `connection`.
 *
 * `undefined` when no {@link transaction} block is open -- and,
 * deliberately, the *same* object for an inner block that joined an outer
 * one, which is what makes "were these two calls in one transaction?"
 * answerable at all. Keys belong to the module that writes them; prefix
 * them so two callers sharing a transaction cannot collide.
 */
export function currentScope(connection: SqliteDatabase): Record<string, unknown> | undefined {
  return _SCOPES.get(connection);
}

/**
 * The connection cannot carry an explicit {@link transaction} as it is
 * configured, or as it was called.
 *
 * A programming error rather than a runtime condition, raised before any
 * statement runs. In interlock this is raised for exactly one reason -- an
 * `isolation_level` that is not `None` -- which has no reachable analogue
 * on better-sqlite3 (see the module comment above). In this port it is
 * raised for the hazard the callback translation itself introduces: a
 * {@link transaction} body that does not run to completion synchronously
 * (D-0103).
 */
export class TransactionUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionUsageError";
    Object.setPrototypeOf(this, TransactionUsageError.prototype);
  }
}

/**
 * Return `connection`, unchanged, for chaining.
 *
 * In interlock this puts the connection into autocommit mode
 * (`connection.isolation_level = None`), which is what lets {@link
 * transaction} own every boundary; outside a {@link transaction} block each
 * statement is then its own SQLite transaction. better-sqlite3 has no
 * `isolation_level` and is already, unconditionally, in that state for the
 * whole life of a connection -- there is no implicit-transaction mode to
 * turn off. So this function has nothing to do on this driver and is kept
 * only as the identity it already is, for call-site parity with source-
 * derived code such as `transaction(inAutocommit(connection))`.
 */
export function inAutocommit(connection: SqliteDatabase): SqliteDatabase {
  return connection;
}

/**
 * Run `body` as one SQLite transaction, `BEGIN IMMEDIATE` .. `COMMIT`.
 *
 * Commits on clean return, rolls back on any exception -- including one
 * thrown by the caller's own code inside `body`, which is how a typed
 * refusal (a stale fencing epoch, a duplicate fact) unwinds every row the
 * block had written so far without the caller having to undo anything by
 * hand.
 *
 * If `connection` is already inside a transaction the call **joins** it: no
 * `BEGIN`, no `COMMIT`, and exceptions propagate to whoever owns the
 * outermost call. Composed operations therefore commit once, at the outer
 * boundary, and a failure anywhere in them leaves nothing behind.
 *
 * `body` must run to completion synchronously and return an ordinary
 * value. See the module comment (D-0103) for why: this is a hazard the
 * callback translation of Python's `@contextmanager` introduces, not one
 * that exists in the source.
 *
 * @throws {TransactionUsageError} if `body` is a deferred function (async,
 *   generator, async generator) or returns a thenable or an iterator.
 */
export function transaction<T>(
  connection: SqliteDatabase,
  body: (connection: SqliteDatabase) => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  // Before anything is opened, so a refused call takes no lock at all.
  if (isLazyFunction(body)) {
    throw new TransactionUsageError(deferredBodyMessage());
  }

  if (connection.inTransaction) {
    // Joined, not nested: the owner of the outermost call commits or rolls
    // back, and this call must not do either on its behalf. It owns the
    // scope too, so this call neither creates nor drops one.
    return invoke(connection, body);
  }

  const scope: Record<string, unknown> = {};
  _SCOPES.set(connection, scope);
  connection.exec("BEGIN IMMEDIATE");
  try {
    let result: T;
    try {
      result = invoke(connection, body);
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
    // COMMIT sits OUTSIDE the block ROLLBACK answers for, mirroring the
    // source's `except: ROLLBACK / else: COMMIT`. Python's `else` clause runs
    // only when the body did not raise, so a COMMIT that *itself* fails is not
    // followed by a ROLLBACK there -- and it must not be here either. Issuing
    // one would be a second statement against a transaction whose state the
    // failed COMMIT already decided, and it would replace the COMMIT's error
    // with the ROLLBACK's, hiding the diagnosis the caller needs.
    connection.exec("COMMIT");
    return result;
  } finally {
    // Dropped by the block that made it, on every exit path, so no scope
    // can be read by the next transaction on this connection.
    if (_SCOPES.get(connection) === scope) {
      _SCOPES.delete(connection);
    }
  }
}

/**
 * Call `body`, and refuse a result that shows it did not run to completion.
 *
 * Split out of {@link transaction} so both the joined and owning paths
 * apply the same after-invocation check. This is containment and a report,
 * not prevention: by the time a returned `Promise` or iterator is in hand,
 * `body` has already run past whatever it was going to run past, and
 * nothing here can un-run it. It exists anyway because a plain function
 * that *returns* a `Promise` or an iterator is not caught by {@link
 * isLazyFunction} (D-0103).
 */
function invoke<T>(connection: SqliteDatabase, body: (connection: SqliteDatabase) => T): T {
  const result = body(connection);
  if (isThenable(result)) {
    // A NATIVE promise gets a no-op rejection handler, and only a native
    // one -- the caller of transaction() never receives this value, so
    // nothing will ever attach a handler to it, and an unhandled rejection
    // terminates Node by default. A merely structural thenable's `then` is
    // arbitrary user code and is deliberately left untouched: calling it
    // here would run that code synchronously, inside a transaction this
    // call is about to roll back.
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
    throw new TransactionUsageError(deferredBodyMessage());
  }
  if (isIterator(result)) {
    throw new TransactionUsageError(deferredBodyMessage());
  }
  return result;
}

/**
 * The same deferred-callback guard {@link transaction} applies to its body,
 * for any other callback this package invokes *inside* a transaction.
 *
 * `@internal` -- not part of the package surface (it is absent from
 * `src/index.ts`), and exported only so a sibling module can apply one guard
 * rather than grow a second copy of it (D-0101 for the marking convention,
 * D-0017 rule 4 for the "one renderer" instinct this follows).
 *
 * The hazard is the callback translation's, not the source's: Python's
 * equivalents are plain callables and cannot be `async`. A deferred callback
 * returns at its first `await` having done none of its writes, the surrounding
 * transaction then COMMITs, and a later rejection has nothing left to roll
 * back -- so the fact would be recorded without the side table row that is
 * supposed to be the same fact recorded twice.
 *
 * @throws {TransactionUsageError} if `callback` is a deferred function.
 */
export function refuseDeferredCallback(what: string, callback: unknown): void {
  if (isLazyFunction(callback)) {
    throw new TransactionUsageError(deferredCallbackMessage(what));
  }
}

/**
 * The after-invocation half of {@link refuseDeferredCallback}, for a plain
 * function that *returns* a promise or an iterator.
 *
 * `@internal`, as above. Containment and a report rather than prevention: the
 * callback has already run past whatever it was going to run past.
 */
export function refuseDeferredResult(what: string, result: unknown): void {
  if (isThenable(result)) {
    // Only a NATIVE promise gets the no-op rejection handler, for the reason
    // given in `invoke`: a structural thenable's `then` is arbitrary user code
    // and calling it here would run it inside a transaction about to unwind.
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
    throw new TransactionUsageError(deferredCallbackMessage(what));
  }
  if (isIterator(result)) {
    throw new TransactionUsageError(deferredCallbackMessage(what));
  }
}

function deferredCallbackMessage(what: string): string {
  return (
    `${what} must run to completion synchronously; it returned or is a ` +
    `deferred value (a promise, an async function, or a generator). The ` +
    `surrounding transaction would COMMIT before the deferred work ran, and a ` +
    `later failure could no longer roll it back.`
  );
}

/**
 * Is `value` a thenable? Structural, not `instanceof Promise`: a body may
 * return a Promise from another realm or a userland thenable, and both
 * suspend exactly the same way.
 */
function isThenable(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

/**
 * The kinds of function whose body does not run to completion when called,
 * decidable without calling it: `async`, `function*`, `async function*`.
 * `Object.prototype.toString` reads the function's internal class, which
 * the syntax sets and no userland property can forge.
 */
function isLazyFunction(body: unknown): boolean {
  const kind = Object.prototype.toString.call(body);
  return (
    kind === "[object AsyncFunction]" ||
    kind === "[object GeneratorFunction]" ||
    kind === "[object AsyncGeneratorFunction]"
  );
}

/**
 * Is `value` an iterator -- something whose work happens when it is
 * *drained*? A callable `next` **and** a self-iteration protocol, which
 * together distinguish a lazy iterator from an ordinary already-evaluated
 * iterable (an array, a `Set`) that a body might legitimately return.
 */
function isIterator(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  const candidate = value as {
    next?: unknown;
    [Symbol.iterator]?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };
  return (
    typeof candidate.next === "function" &&
    (typeof candidate[Symbol.iterator] === "function" ||
      typeof candidate[Symbol.asyncIterator] === "function")
  );
}

/** The one refusal text, so the two guards above cannot drift apart. */
function deferredBodyMessage(): string {
  return (
    "transaction() was given a deferred body -- an async function, a " +
    "generator, or a callback returning a promise or an iterator. A " +
    "transaction is one synchronous scope: a deferred body returns before " +
    "its writes have run, the transaction would be committed or rolled " +
    "back there, and every write after it would run outside the boundary " +
    "this call exists to hold. Nothing in the control plane is " +
    "asynchronous (better-sqlite3 is a synchronous driver); build the " +
    "transaction body synchronously"
  );
}
