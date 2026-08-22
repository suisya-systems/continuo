/**
 * Python's immutable containers, as the port's containers.
 *
 * Interlock's report objects are `@dataclass(frozen=True)` holding `tuple`s and
 * `MappingProxyType`s, and every one of those is immutable **at runtime**, not
 * merely by convention: a caller who tries to mutate one gets an exception.
 *
 * The obvious translation loses that. `Object.freeze(this)` on a class holding
 * plain arrays and a plain `Map` is **shallow** -- the instance's own properties
 * cannot be reassigned, but `report.appliedTerminate.push(id)` and
 * `report.adjudications.set(...)` both still succeed. A `readonly` type
 * annotation and a `ReadonlyMap` type are compile-time only and vanish for any
 * JavaScript consumer, which is precisely the audience this package has once it
 * is published.
 *
 * That matters here beyond tidiness. A false-termination report's numerator,
 * denominator and three verdict buckets are a **partition**: mutate one and the
 * rate no longer describes the itemisation printed beside it, and nothing
 * anywhere notices. Interlock cannot reach that state; without these helpers,
 * continuo could.
 *
 * Two helpers, matching the two Python containers:
 *
 * - {@link frozenList} for `tuple`.
 * - {@link readOnlyMap} for `MappingProxyType`.
 *
 * Both **copy** their input, so a report cannot be changed through the array or
 * map the caller still holds a reference to. `MappingProxyType` is a live view
 * rather than a copy, so this is marginally stricter than the source; stricter
 * in the direction of "the report cannot change after it is built", which is
 * the property the source's immutability exists to provide.
 */

/** Python's `tuple(...)`: a copy nothing can append to, pop from, or reassign. */
export function frozenList<T>(items: Iterable<T>): readonly T[] {
  return Object.freeze([...items]);
}

/**
 * Python's `MappingProxyType(...)`: a read-only mapping.
 *
 * Returned as a `ReadonlyMap` whose mutators are absent rather than present and
 * throwing. TypeScript's `ReadonlyMap` does not declare `set` / `delete` /
 * `clear`, so typed code cannot reach them, and an untyped caller reaching for
 * `.set` finds `undefined` and fails at the call rather than silently editing a
 * published report.
 *
 * A `Map` subclass overriding the mutators to throw was the alternative. This
 * shape is preferred because `instanceof Map` then stays false, which is honest:
 * this is not a `Map`, and code that branches on `instanceof Map` to decide
 * whether it may write should take the other branch.
 */
export function readOnlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const backing = new Map<K, V>(entries as Iterable<[K, V]>);
  const view: ReadonlyMap<K, V> = {
    get size(): number {
      return backing.size;
    },
    get: (key: K) => backing.get(key),
    has: (key: K) => backing.has(key),
    keys: () => backing.keys(),
    values: () => backing.values(),
    entries: () => backing.entries(),
    forEach: (callback, thisArg) => {
      for (const [key, value] of backing) {
        callback.call(thisArg, value, key, view);
      }
    },
    [Symbol.iterator]: () => backing[Symbol.iterator](),
  };
  return Object.freeze(view);
}
