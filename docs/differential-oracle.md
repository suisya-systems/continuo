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

## 2. The implemented faces

The pilot implemented two: **control-plane database state** (2a) and **statement completeness**
(2b). The measurement belt added a third, **fixed-point number rendering** (2c). The fencing lane
added a fourth, **CPython library semantics** (2d), which is the widest of them: the fence is
*defined* by standard-library behaviour that JavaScript has no equivalent for, so that behaviour had
to be transcribed, and every transcription needs the same check. The settings lane widened that
into a fifth, **`os.path` in both namespaces** (2e), and the attention belt added a sixth,
**CPython's format-string machinery** (2f), for the same reason one layer up: the string being
formatted is one the OPERATOR wrote.

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

### 2c. Fixed-point number rendering

`src/measurement/format.ts` reimplements Python's `format(v, '.Nf')`, because
`Number.prototype.toFixed` is not the same function: on an **exact tie** Python rounds to even and
JavaScript rounds away from zero, so `0.125` renders as `0.12` in one and `0.13` in the other
(`D-0104`). interlock#74's acceptance criterion 3 makes rendered figures a parity surface, and every
figure the measurement harness prints is `count / count * 100` -- which reaches ties.

Like the `sqlite3_complete` transcription, this is an artefact that reads correct and is not, so it
has its own oracle:

- `scripts/oracle/dump_fixed_format.py` asks CPython for its answer on every corpus input at four
  widths (0, 1, 2, 4) and writes them to `parity/oracle/fixed-format-vector.json`.
- `test/measurement/format.test.ts` rebuilds the corpus and asserts the reimplementation matches at
  every position.

The corpus is **rebuilt, not committed**, as 2b's is, and for the same reason. It is therefore built
with no RNG at all: Python's Mersenne Twister is not reproducible in JavaScript, so a sampled corpus
could not be reconstructed on the other side. It is 4,795 values -- every tie class enumerated
exhaustively rather than sampled, and each probed one ULP either side, since a tie and a value that
merely looks like one are the only places the two languages disagree -- and a
committed corpus length turns "somebody edited the corpus" into an explicit instruction to regenerate
rather than an off-by-one comparison against the wrong answers.

This face needs **no interlock checkout** either: the oracle is CPython itself. It is the cheapest of
the three to regenerate.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/oracle/dump_fixed_format.py \
  parity/oracle/fixed-format-vector.json
```

It earned its place twice over, and the second time is the more instructive: see section 6c.

### 2d. CPython library semantics

The fence is not merely *implemented* with `fnmatch`, `shlex`, `posixpath`, `re` and `json` -- it is
**defined** by them. `fencing/rules.py` decides whether a tool call is denied with
`fnmatch.fnmatchcase` over a path it normalised with `os.path.expanduser` + `posixpath.normpath`;
`fencing/renderer.py` builds the hook command line with `shlex.quote`, parses it back with
`shlex.split`, and compiles **author-supplied** `forbidden_allow_regex` patterns with `re`; every
durable fencing artefact is written with `json.dumps` and compared across a restart **by bytes**.
None of those has a Node equivalent that agrees with CPython everywhere, so `src/fencing/` carries a
transcription of each (`D-0200`, `D-0203`).

The failure mode is the reason the face exists: a matcher that matches *less* than CPython's makes a
rule that denies less than interlock denies, with **no probe and no error**, because the breach
battery synthesizes its probes from the same rule text and a rule that fails to match its own
subject fails identically on both sides of the check. Green suite, open fence.

- `scripts/oracle/dump_fnmatch_shlex.py` asks CPython for its answer on every input in
  `parity/oracle/fnmatch-shlex-corpus.json` and writes `parity/oracle/fnmatch-shlex-vector.json`.
- `test/fencing/fnmatch-shlex-oracle.test.ts` rebuilds the corpus in the same order and asserts the
  transcriptions agree at every position -- collecting **all** mismatches before failing, and naming
  the input that diverged, because the first divergence is rarely the informative one and a whole
  class of them is what points at the branch that is wrong.

The corpus is **committed, not rebuilt**, unlike 2b's and 2c's: its inputs are hand-authored
adversarial cases rather than derivations from files already in the repository, and it carries
`$comment_*` keys saying why each class of input is present -- a corpus is a claim about coverage as
much as the vector is a claim about correctness (section 6c).

Three kinds of answer are recorded, and the second and third are what keep the face honest:

1. **The answer**: what matched, what the tokens were, what the bytes were.
2. **The refusal**: an input CPython *rejects* is recorded as its exception message rather than
   dropped. "Both sides refuse this" is as much a parity claim as "both sides agree on the tokens",
   and the error paths are where a transcription drifts most easily.
3. **The accepted deviation**: a place where the two genuinely differ -- `~someuser` (Node cannot
   read the `pwd` database), an integral float *written as a literal in code* (a Python `1.0` and a
   JavaScript `1` are one double with no document behind them to say which was meant; an integral
   float that came from a DOCUMENT round-trips exactly, and `pyjson.number_documents` is where that
   is measured), `IGNORECASE` folding, the constructs the regex translator refuses rather than
   guess at. Each is
   listed in the corpus with the reason, and asserted in **both directions**: continuo must produce
   the deviating answer *and* CPython must still produce a different one, so an entry that goes
   stale fails loudly instead of licensing a divergence that no longer exists. A deviation deleted
   from the corpus is a deviation nobody can see.

Regenerate with, from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/oracle/dump_fnmatch_shlex.py \
  parity/oracle/fnmatch-shlex-vector.json
```

Like 2b and 2c it needs **no interlock checkout** -- the oracle is CPython itself. What it does need
is that the environment stays out of the answer: `HOME`, `USERPROFILE` and `USERNAME` are pinned to
the corpus's values on both sides for the calls that read them, since an oracle that read the
generating machine's home directory would be comparing two environments and calling it a comparison
of two implementations.

This face has now earned its place four times: the bracket-expression bug in `D-0200`, the missing
astral coverage that the same entry records, the JSON number round trip of `D-0210` (the corpus
section that measures it went in with the repair, and the two things it pins -- an integral float's
spelling and an integer past 2**53 -- were both invisible to every other case in the suite), and -- when the corpus was extended to the regex, JSON
and value-semantics transcriptions -- a variable-width lookbehind that CPython **rejected** and this
port compiled, which is the "interlock refuses, continuo renders" direction. That one is now fixed:
`src/fencing/pyregex.ts` refuses a lookbehind body it cannot prove fixed-width, and the corpus entry
moved from the deviation list into the ordinary refusal comparison. All three are recorded in
`D-0200`.

### The wide sweep beside the committed vector

The corpus is hand-chosen and it is checked on every cell, which is the trade it makes: a
committed vector needs no CPython at test time, and a hand-chosen corpus covers what someone
thought of. `scripts/pyjson-roundtrip-sweep.mjs` is the other half for the one transcription whose
output is compared BY BYTES -- it generates the product of 48 numeric literals and six container
shapes and compares five spellings of each against CPython, on demand (52 literals, 5,616
documents, 28,080 comparisons at the time of writing). It is **not** wired into
`npm run verify` or CI, for the same reason `scripts/oracle/` is not: the matrix cells have no
Python, which is why a vector is committed instead. Run it when `pyjson.ts` or `pysemantics.ts`
changes; the durable check stays `pyjson.number_documents`.

`D-0211` records why it is a file rather than a number in a commit message, and what a sweep run
only over the SHIPPED role document failed to see.

### 2e. `os.path`, both namespaces

2d covers the `posixpath` half the FENCE needs -- `normpath` and `expanduser`, the two functions
`rules._normalize_path` composes. The SETTINGS generator reads far more of `os.path` than that, and
its decisions turn on the answers rather than merely being implemented with them:

- `_is_inside_root` decides whether a Layer 3 deny entry escaped the sandbox read roots by composing
  `normpath` with an `os.sep` boundary test. A `normpath` that keeps a trailing separator makes the
  equality half of that test stop firing, and the entry is then silently kept -- or, one branch
  over, silently dropped. A dropped deny is a credential file that stopped being denied.
- `_kept_entry_string` emits `os.path.join(anchor_base, path)` as the literal string that lands in
  `settings.local.json`, which the bwrap launcher consumes as a concrete path.
- `_absolute_symlink_in_chain` walks a path with `splitdrive`, `join`, `dirname`, `os.sep` and
  `os.altsep`, and its answer decides whether a deny path is rewritten to its realpath or left in a
  form that aborts the sandbox launch. A failed launch is not fail-closed: Claude Code's documented
  response is to retry the command with `dangerouslyDisableSandbox`.

`os.path` is a **platform choice** -- Python binds the name to `posixpath` or `ntpath` at import
time -- so `src/fencing/pypath.ts` transcribes both and dispatches on `process.platform` at call
time, exactly as `expanduser` already did (`D-0200`, `D-0213`).

- `scripts/oracle/dump_ospath.py` asks CPython for `normpath`, `isabs`, `split`, `splitdrive`,
  `dirname`, `basename` and `join` over every input in `parity/oracle/ospath-corpus.json`, **from
  both namespaces**, and writes `parity/oracle/ospath-vector.json`.
- `test/settings/ospath-oracle.test.ts` asserts both halves at every position, **on every matrix
  cell**. That is the point of dumping both from one interpreter: `ntpath` is importable on Linux
  and its answers do not depend on the host, so a Windows-only check would leave the half this port
  ships to Windows unverified on the cells where most runs happen.

The corpus is committed and hand-authored, like 2d's, and carries the shapes where the two
namespaces disagree -- drive letters, UNC roots, `\\?\` prefixes, mixed separators, the leading
`//` POSIX reserves -- because a corpus on which they never differ would let one transcription stand
in for the other. The vector's own vacuity guard asserts exactly that: `ntpath` and `posixpath` must
disagree somewhere in `normpath`, `splitdrive` and `join`.

Regenerate with, from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/oracle/dump_ospath.py \
  parity/oracle/ospath-vector.json
```

**What this face deliberately does not cover: `realpath`.** It is a function of the filesystem, and a
static vector cannot pin one. `posixRealpath` is a transcription of `posixpath.realpath`'s non-strict
algorithm; `ntRealpath` is an **adaptation**, because `ntpath.realpath` is written on
`nt._getfinalpathname`, a Win32 API with no user-space equivalent to transcribe -- the structure of
CPython's non-strict walk-back is reproduced around Node's `fs.realpathSync.native`, and what is not
reproduced is listed at the function. It is pinned by the settings suite instead, which builds a real
directory and, where the layout has to be a symlinked one, injects `realpathFn` exactly as
interlock's own tests do.

### 2f. CPython's format-string machinery

`notify.render_text` is the one place in the attention subsystem that formats a string **the
operator wrote**. It reads `attention.json`'s `templates`, asks which placeholders each template
names, checks those against the design's section 6 allowlist, and renders. Three CPython functions
are load-bearing in that sentence -- `string.Formatter().parse`, `str.format_map` and
`str.__format__` -- and `src/attention/pyformat.ts` transcribes all three (`D-0952`).

What a near-miss costs falls on the operator in both directions, and neither direction is loud:

- a parser that misses the name in `{summary!r:>10}` hands the allowlist the wrong set, so a
  template reaches a field the design forbids; one that reads `{{pr}}` as a reference to `pr`
  renders `42` where CPython renders the literal text `{pr}`.
- a renderer that refuses what CPython accepts replaces the operator's own template with the
  bundled English default -- **silently**, because the whole contract of this path is that a
  misspelled template must not crash the watcher. One that accepts what CPython refuses is that
  crash.

- `scripts/oracle/dump_pyformat.py` asks CPython, for every template in
  `parity/oracle/pyformat-corpus.json`: which placeholders `_placeholders` finds, which of them are
  outside the allowlist, what `format_map` renders, and -- when it raises -- the exception's class
  **and its message text**. It writes `parity/oracle/pyformat-vector.json`.
- `test/attention/pyformat-oracle.test.ts` rebuilds the same corpus in the same order and asserts
  agreement on every field at every position.

The corpus is committed and hand-authored, grouped by what each group asks: literals and brace
escapes, the six allowed names, names outside the allowlist including the attribute and index
reaches, positional and auto-numbered fields, the three conversions, the format specs a `str`
accepts, the ones it refuses, nested specs, and templates that do not parse at all. Every group
carries at least one input that renders and one that raises, so a half-implemented answer cannot
pass by refusing everything or by rendering everything -- and the vector's own not-vacuous cases
assert that, rather than leaving it to the corpus author's care.

**The message text is compared, and that is not thoroughness for its own sake.** It caught the
fifth of the five divergences below, where the exception class was already right.

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

The same reasoning is why `parity/oracle/**` is excluded from Biome in `biome.json`. A vector is
**generated output**, not source: its bytes are whatever the Python half emitted. Letting the
formatter rewrite them would make the committed file differ from what the generator produces, so the
next regeneration would show a diff that is pure formatting -- and a vector whose diff is noise is a
vector nobody reads. The exclusion is scoped to that directory, and nothing under it is hand-edited.

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

### 6c. Fixed-point rendering: what the corpus caught, and what it did not

The fixed-format corpus agreed with CPython on all of its values at all four widths on its first run.
What failed was a hand-written case sitting beside it, which asserted
`formatFixed(99.995, 2) === "99.99"` -- reading `99.995` as a tie that half-to-even sends down.

It is not a tie. The nearest double to `99.995` is
`99.99500000000000454747350886464118957519531250`, strictly *above* the halfway point, so it rounds
up on any rule at all and CPython prints `100.00`.

This is a smaller finding than 6a and 6b and it is worth recording for a different reason: it is the
oracle correcting the **test author** rather than the implementation. A suite of hand-picked
examples would have encoded that misunderstanding as the expected answer and then failed a correct
implementation -- which is the failure mode of pinning a reimplementation with examples somebody
reasoned their way to.

**And then the review found what the corpus had not.** The first implementation classified ties from
a `toFixed(20)` expansion, which is not exact: `toFixed` rounds, so a value merely *close* to a tie is
rendered as one. `0.00005` at four places is the case -- its double is strictly above the halfway
point, CPython rounds it up to `0.0001`, and the transcription rounded it half-to-even down to
`0.0000`. The corpus was green because it contained no near-tie values.

The fix was exact `BigInt` arithmetic over the IEEE 754 decomposition, and the corpus now probes one
ULP either side of every tie. The lesson is the one worth carrying to the next face: **an oracle is
necessary and it is not sufficient.** It answers only for the inputs somebody thought to put in the
corpus, so "the oracle is green" is a claim about coverage as much as about correctness, and the
corpus deserves the same adversarial attention as the code.

### 6d. Format strings: five divergences in a transcription written from CPython's source

`src/attention/pyformat.ts` was not guessed at. It was written from `Objects/stringlib/
unicode_format.h` and `Python/formatter_unicode.c`, with the C read alongside the TypeScript. Its
first draft still disagreed with CPython on five of the corpus's inputs, and **review had found none
of them**:

1. `{}` and `{0}` raise `ValueError("Format string contains positional fields")`, not `IndexError`.
   `format_map` passes **no** positional argument tuple at all, and `get_field_object` tests for
   that before it tests any index. The draft reasoned "an empty tuple, so the index is out of range"
   and reached a class CPython never raises here.
2. `{pr:010}` **renders**, as `4200000000`. A leading `0` sets the fill character and takes the `=`
   alignment branch only when the type's own `default_align` is `>`, which is the numeric types'
   default and not `str`'s. Reading the published grammar, which documents `0` as implying `=`,
   makes this a refusal.
3. `{pr:0}` renders `42`, for the same reason and with the same wrong first answer.
4. `{pr:{}}` follows from (1).
5. an unprintable presentation type is **escaped** in the refusal message -- `Unknown format code
   '\xa' for object of type 'str'`. A `%c` transcription puts a literal newline in the middle of an
   operator's warning line. Only the message comparison could catch this: the class was right.

A sixth arrived on the integration tip, and it is the most instructive of them because it was
**the port's own regression and the oracle did not catch it either**. The repair for (2) removed
two guards in one edit when only one was wrong: an explicit fill character wins over the `0`, so
`format("ab", "*>010")` is `"********ab"` and the port rendered `"00000000ab"`. The corpus carried
`{pr:*^10}` and `{pr:010}` and nothing that combined them. **An oracle is only as good as the
combinations its corpus asks about, and a repair is a new combination** -- so widening the corpus
belongs in the same change as the repair, not in the next one that happens to think of it.

Five of the six would have shipped as a silent behaviour difference in an operator-facing path.
After the repairs, all 101 templates agree on every compared field.

**A finding about the SOURCE fell out of (1).** interlock's own `except (ValueError, IndexError)`
around `_format_with_event` has an unreachable half: that function only ever calls `format_map`, and
`format_map` raises `ValueError` for every positional field, so no template can produce the
`IndexError` the catch names. Nothing about the port's behaviour differs; the observation is about
interlock, and it is the kind of thing a differential vector notices and a reading does not.

## 7. Faces designed but not implemented here

The oracle generalises to any surface where both implementations can be driven from the same fixed
input vector and their output normalised. Three further faces were designed and left unbuilt by the
pilot, which was scoped to establishing conventions rather than to coverage. **The CLI-results face
is the measurement belt's target**, because interlock#74's acceptance criterion 3 is stated in
exactly those terms -- the same figures and fields on the shared fixture corpus -- and 2c is the
first piece of it: a report cannot render the same figures if the two runtimes do not render a
number the same way.

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
