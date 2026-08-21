# SQLite value-representation contract

Authority: [`DECISIONS.md`](../DECISIONS.md) `D-0007`.
Executable form: [`test/contract/sqlite-values.test.ts`](../test/contract/sqlite-values.test.ts).

Every mapping on this page was **measured** on better-sqlite3 `13.0.3` (bundled SQLite `3.53.4`)
running on Node `v22.17.0`, on 2026-08-22. None of it is copied from documentation. The
accompanying test file is the version that fails when a dependency upgrade changes any of it; this
page is the version that explains why each row is what it is.

## 1. Storage class to JavaScript type

| SQLite storage class | JavaScript value read back | Notes |
|---|---|---|
| `INTEGER` | `number` | **Lossy beyond 2^53** -- see section 3. |
| `REAL` | `number` | |
| `TEXT` | `string` | |
| `BLOB` | `Buffer` | A Node `Buffer`, which is also a `Uint8Array`. |
| `NULL` | `null` | Never `undefined` -- see section 2. |

## 2. Absence: `null` and `undefined` are not interchangeable

Three different situations, three different values. Conflating them is how a "missing" row and a
row holding NULL become the same bug.

| Situation | Value |
|---|---|
| Column exists in the result and holds SQL `NULL` | `null` (and the key **is** present on the row object) |
| Column is not part of the result at all | `undefined` (and the key is **absent**) |
| `.get()` matched no row | `undefined` |
| `.all()` matched no rows | `[]` -- an empty array, not `undefined` |

`exactOptionalPropertyTypes` (`D-0004`) is what keeps the type system able to state this
difference rather than collapsing `T | undefined` into "optional".

## 3. Hazard: INTEGER precision is lost silently

SQLite stores a full signed 64-bit integer. JavaScript's `number` carries 53 bits of integer
precision. better-sqlite3's default read converts to `number` **and raises no error when the value
does not fit**:

```
INSERT INTO t VALUES (9007199254740993);
-- On the SQLite side, stored exactly:  SELECT i = 9007199254740993  -> 1
-- Read into JavaScript as a number:                                 -> 9007199254740992
```

There is no warning, no exception, and no flag on the returned row. A value that has silently
changed compares unequal to the value that was written, and the failure surfaces far from its
cause.

**Rule.** A column that can hold a value beyond `Number.MAX_SAFE_INTEGER` -- an int64 identifier, a
nanosecond timestamp, a hash stored as an integer -- must be read on a connection with safe
integers enabled, and the module that does so states it in its own tests.

```ts
db.defaultSafeIntegers(true);   // whole connection
// or, per statement:
db.prepare("SELECT i FROM t").safeIntegers(true);
```

Safe integers are **all-or-nothing on the connection**: enabling them turns *every* `INTEGER` into a
`bigint`, including `1n` where the suite expects `1`. That is why it is an opt-in and not the
default (`D-0007` Alternatives). Note also that `JSON.stringify` throws on a `bigint`, so anything
serializing such a row needs an explicit replacer.

## 4. Hazard: `undefined` binds as NULL

Measured behaviour of parameter binding:

| Bound value | Result |
|---|---|
| `undefined` | **Bound as SQL `NULL`.** No error. |
| missing parameter (wrong arity) | Throws `Too few parameter values were provided` |
| `true` / `{}` / a symbol | Throws `SQLite3 can only bind numbers, strings, bigints, buffers, and null` |
| `null` | Bound as SQL `NULL` |
| `bigint` within `number` range | Accepted; reads back as a `number` unless safe integers are on |

So a misspelled property (`row.stauts`) evaluates to `undefined` and reaches the database as NULL,
where a NOT NULL constraint may catch it -- or, on a nullable column, may not. Values entering a
write path are therefore not permitted to be `undefined`: either the caller passes `null`
deliberately, or the property is omitted and the statement does not bind it.

## 5. What is deliberately not decided here

No row-mapping or ORM layer is introduced at bootstrap. Statements return plain row objects with the
types above. Interposing a mapping layer later, once the ported modules have shown what they
actually need, is cheaper than removing one that was added on speculation.
