# The differential oracle

Authority: [`DECISIONS.md`](../DECISIONS.md) `D-0018`.
Python half: [`scripts/oracle/dump_control_plane.py`](../scripts/oracle/dump_control_plane.py).
TypeScript half: [`test/oracle/control-plane-dump.ts`](../test/oracle/control-plane-dump.ts).
The comparison:
[`test/control_plane/differential-oracle.test.ts`](../test/control_plane/differential-oracle.test.ts).
The vector: `parity/oracle/control-plane-state.json`.

## 1. What the oracle claims that the ported tests do not

A translated case asserts that continuo behaves as *interlock's test* required. That is the
specification, and translating it faithfully is the whole discipline of this port
([`docs/test-translation-conventions.md`](./test-translation-conventions.md)). But it has a ceiling
that no amount of translation raises:

> A ported test can only catch a divergence that interlock's suite already had an assertion for.

Everything the Python suite never thought to assert -- because in Python it was true by
construction, or because it was a property of the runtime rather than of the code -- translates into
a TypeScript test that is equally silent. Both suites go green and the two systems differ anyway.

The oracle makes the other claim:

> Given the same fixed input vector, the artefact the Python implementation *produces* and the
> artefact the TypeScript implementation produces are the same artefact, compared on every field,
> including the fields nobody wrote a test about.

It is a comparison against the real other implementation, not against a test's idea of it. That is
why it is worth having even where the SQL was copied across verbatim: copying fixes the *text* of
the statements. It says nothing about the order they execute in, where the transaction boundaries
fall, which pragmas are in force while they run, whether a statement was reached at all, or how two
different drivers represent the values that come back. Each of those can differ while both suites
stay green, and each of them changes the database on disk.

## 2. The two implemented faces

The pilot implements two: **control-plane database state** (this section) and
**statement completeness** (section 2b).

### 2a. Control-plane database state

Both halves do the same three things:

1. Migrate an **empty** database to head through their own migrator
   (`create_production_control_plane` / `createProductionControlPlane`), in a fresh temporary
   directory, with the clock pinned to `NOW_MS = 1700000000000`.
2. Read the resulting database back out as a normalised JSON document (section 3).
3. Emit it with the same key order and the same two-space indentation.

The Python half writes its document to `parity/oracle/control-plane-state.json`. The test builds the
TypeScript document and asserts equality -- field by field first, so a failure names the face that
diverged instead of printing a hundred-kilobyte object diff, and then over the whole object, so no
field escapes by not having been listed.

A second test asserts the vector is **not vacuous**: more than 50 schema objects, more than 10
tables, exactly 3 `schema_migration` rows, and a non-empty `policy_revision`. A golden file that had
been regenerated from a failed or empty run would otherwise let the comparison pass while comparing
nothing.

### 2b. Statement completeness

`src/sqlite/complete-statement.ts` transcribes SQLite's `sqlite3_complete()`, because
better-sqlite3 exposes none and the migrator needs one to split a step file into statements
(`D-0013`). A transcription is exactly the kind of artefact that reads correct and is not, so it has
its own oracle:

- `scripts/oracle/dump_complete_statement.py` asks Python's `sqlite3.complete_statement` -- SQLite's
  own function -- for its answer on every corpus input, and writes the boolean vector to
  `parity/oracle/complete-statement-vector.json`.
- `test/sqlite/complete-statement.test.ts` rebuilds the corpus and asserts the transcription matches
  at every position.

The corpus is **rebuilt, not committed**: every cumulative line-prefix of the shipped migration
files, which are already in the repository, plus the adversarial cases in
`parity/oracle/complete-statement-corpus.json`. The prefixes of an 85 KB file come to tens of
megabytes; rebuilding them from committed files is exact and costs nothing. A corpus-length check
turns "someone edited a step file" into an explicit instruction to regenerate rather than a silent
drift.

Regenerate with, from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/oracle/dump_complete_statement.py \
  parity/oracle/complete-statement-vector.json
```

Note this half needs **no interlock checkout** -- the oracle is SQLite itself, reached through
Python's standard library -- so it is cheaper to regenerate than the database-state vector.

This face also earned its place immediately: see section 6.

## 3. What is normalised, and why each part is there

The dump is not "whatever the database happens to return". Every element of the shape is a decision
about what must be compared and what cannot be.

| Emitted | Why it is in the dump |
|---|---|
| `application_id`, `user_version`, `foreign_keys` | Pragmas are file state. A migrator that forgot to stamp the file, or left foreign keys off, produces a database that behaves differently from the one whose SQL it shares. |
| `integrity_check`, `foreign_key_check` | Cheap, and they turn a structurally corrupt result into a mismatch rather than a subtly wrong comparison. |
| `schema` -- `type`, `name`, `sql` for every non-`sqlite_%` object | The one place a retyped statement becomes visible. See section 6. |
| `tables[*].columns` from `PRAGMA table_info` | Declared type, `notnull`, `dflt_value` and `pk` are what SQLite actually derived from the DDL -- affinity and defaults, not the text that produced them. |
| `tables[*].row_count` and `rows` | The seeded data. Verbatim SQL guarantees the seed statements exist; it does not guarantee they were reached. |

And the normalisation proper:

- **Schema objects are sorted by `(kind, name)`**, kind ordered table, view, index, trigger. Neither
  runtime promises an order for `sqlite_master`, and comparing an incidental one produces failures
  that are about the driver rather than about the schema.
- **`sql` is `.strip()`ed / `.trim()`ed.** Leading and trailing whitespace around a stored statement
  is not a property of the schema. Interior whitespace is deliberately *not* touched -- see
  section 6 for why that matters.
- **Rows are ordered by every column** (`ORDER BY "c1", "c2", ...`), built from `table_info` so the
  clause is identical on both sides. Without an explicit `ORDER BY` neither driver promises
  anything, and an accidental agreement between the two is worse than a mismatch, because it is a
  comparison that will start failing on an unrelated day.
- **`applied_at_ms` is fixed, not stripped.** The clock is injected as `now_ms` / `nowMs` and the
  timestamp stays in the dump. Stripping the field would be easier and would hide exactly the bug
  worth catching: a migrator that ignores the caller's clock and reads its own. Fixing it makes that
  a mismatch.
- **Nothing path-dependent is emitted.** The database lives under `mkdtemp`, whose name differs on
  every run and between the two runtimes; no filename, directory or absolute path reaches the
  document.
- **Integer columns are left as integers on both sides.** `sqlite3` hands `table_info` flags back as
  ints and better-sqlite3 does the same, so no coercion is applied -- and no coercion is applied
  anywhere else either, because a coercion is a place where a real representational difference
  (`D-0007`, [`docs/sqlite-value-contract.md`](./sqlite-value-contract.md)) could be normalised
  away.

## 4. Regenerating the vector

The Python half needs an interlock checkout, so it does not run in CI and is not wired into any npm
script. Run it by hand, from the **continuo repository root**, against an interlock checkout at
revision `65f36c5`:

```bash
PYTHONPATH=<interlock-checkout>/src PYTHONDONTWRITEBYTECODE=1 \
  python3 scripts/oracle/dump_control_plane.py parity/oracle/control-plane-state.json
```

`PYTHONPATH` points at interlock's `src/` so `claude_org_runtime.control_plane.migrator` is
importable without installing anything. `PYTHONDONTWRITEBYTECODE=1` keeps the run from depositing
`__pycache__` directories inside the read-only reference checkout.

Then review the diff and commit it.

The revision is **stamped into the vector itself**, as a top-level `source` object, rather than
being recorded only in this document. The vector is evidence of parity against one interlock
revision, and a comparison against a vector whose provenance is unknown is not a comparison at all.
`SOURCE_REVISION` in the script is what stamps it; update it in the same commit that regenerates
against a different checkout. The test asserts the stamp matches the revision recorded in
`parity/control-plane.ledger.json`, so the two cannot drift apart silently.

## 5. Why regeneration is deliberate and never automatic

A golden vector that regenerates itself asserts nothing. The moment the suite can rewrite its own
expectation, every divergence becomes a silently updated file and the oracle is decoration.

Two properties keep that from happening:

- **The test cannot write the vector from the TypeScript side under normal operation.** It reads the
  file and compares; there is no "update snapshots" path and no `--update` flag reaches it.
- **The escape hatch fails.** `CONTINUO_ORACLE_WRITE=1` overwrites the file and then **throws**, so
  the run is red. It exists only to inspect what the TypeScript side currently produces while
  debugging a mismatch. Because it can never produce a green run, it cannot be left armed in a
  workflow, in a shell profile, or in someone's local environment and quietly disarm the check.

The consequence is the intended one: a change to the vector appears in review as a change to the
oracle -- a line someone has to justify -- rather than as a test that kept passing.

## 6. What the oracle caught on its first run

Both faces failed on their first run, and neither failure was reachable from the ported tests.

### 6a. Statement completeness: a wrong cell in the transcribed state table

The corpus disagreed with SQLite on **42 of 2,203 inputs**. One cell of the transcribed state table
was wrong -- state 6 (`TRIGGER`) on a `SEMI` token said "complete" where SQLite says "keep going" --
so the machine treated the first semicolon *inside* a `CREATE TRIGGER ... BEGIN ... END` body as a
statement terminator.

The production DDL is largely triggers, so the effect would have been a migrator that executed the
front half of a trigger definition and then failed on the rest, or silently applied a truncated
schema object. Every one of the 42 disagreements was a trigger body in the shipped ledger.

Nothing else in the suite could have found it, because a transcription is only checkable against the
thing it transcribes. Reviewing an 8x8 table of integers by eye is exactly the task human review is
worst at.

### 6b. Database state: a retyped bootstrap DDL

The migrator-owned bootstrap DDL -- the `CREATE TABLE schema_migration` statement and its two
guard triggers, which live in the migrator itself rather than in a numbered migration file -- had
been **retyped** during the port rather than copied byte for byte from interlock. The two versions
were semantically identical: same columns, same types, same constraints, same triggers, same
behaviour, and every ported migrator test passed against both.

They were not textually identical, and SQLite stores the `CREATE` statement **verbatim** in
`sqlite_master.sql`. It does not reformat, canonicalise or re-emit the DDL; whatever text was
submitted is what is stored and what is returned. So the two databases had schemas that differed as
text while agreeing on every behaviour any test asked about.

This is the exact class the oracle exists for. No assertion in interlock's suite compares the
literal text of its own bootstrap DDL -- in interlock there is only one copy of it, so the property
is true by construction and there is nothing to assert. Translate that suite perfectly and the
divergence is still invisible. The fix was to copy the statements verbatim, which is what
"verbatim migration" was supposed to mean all along; the finding is that "verbatim" is a claim
somebody has to check, not one the translation process delivers on its own.

It also settles a small design question in the dump: interior whitespace in `sql` is deliberately
not normalised. Had it been, this would have compared equal.

## 7. Faces designed but not implemented here

The oracle generalises to any surface where both implementations can be driven from the same fixed
input vector and their output normalised. Three further faces are designed and deliberately left
unbuilt in this pilot, which is scoped to establishing conventions rather than to coverage:

- **CLI results.** Run the same argument vector through both CLIs and compare exit code, stdout and
  stderr after normalising paths, timings and any deliberate presentation difference. Blocked mainly
  on deciding what counts as presentation (a policy question,
  [`docs/cli-output-policy.md`](./cli-output-policy.md)) rather than on mechanism.
- **State transitions.** Drive both implementations through the same ordered sequence of
  control-plane operations and compare the database dump *after each step*, not only at the end.
  This is strictly stronger than the implemented face, which compares a single terminal state and
  so cannot see two paths that converge.
- **Exception classification.** Feed both implementations the same malformed or refused inputs and
  compare which error class is raised and which refusal message is produced, rather than only that
  something failed. Needs an agreed Python-exception-to-TypeScript-error mapping first; without one
  the comparison is between two naming schemes.

Each is a later belt, and each follows the same two rules this face establishes: the vector is
produced by the Python side and committed, and the TypeScript side may only compare.
