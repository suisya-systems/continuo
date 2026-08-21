# CLI output policy: ASCII only

Authority: [`DECISIONS.md`](../DECISIONS.md) `D-0006`.
Executable form: [`test/contract/ascii-output-policy.test.ts`](../test/contract/ascii-output-policy.test.ts).

## The rule

**Every byte continuo writes to stdout or stderr is ASCII** (U+0020..U+007E, plus tab and newline).

## Why

Inherited from the Python lineage, where it recurred. A Windows console running the cp932 code page
cannot encode characters outside it. A single em dash (`U+2014`) in an `argparse` help string is
enough to crash `--help` with `UnicodeEncodeError` -- and the crash is invisible to the test suite,
because the harness captures stdout as UTF-8 and never touches the console encoder. It appears only
on a real terminal, on a user's machine, usually at the least convenient moment.

Windows is a **required** CI cell (`D-0003`), so the platform where this matters is on the merge
path rather than in a nightly job.

## Scope

| Covered | Not covered |
|---|---|
| `src/`, `scripts/`, `test/` | `docs/`, `README.md`, `DECISIONS.md`, `CHANGELOG` |
| Anything continuo prints | Text that continuo only reads, stores, or passes through |

The mechanical check is **wider than the rule it protects**: it rejects any non-ASCII codepoint
anywhere in a covered file, including comments and test names, not only in strings that are
demonstrably printed. This is on purpose. "Is this string ever printed?" cannot be decided by
looking at it, and the cost of not typing an em dash in a comment is zero.

Prose files are exempt because they are read in a browser or an editor, never written to a console.

## Working within it

- Write `--` where you want an em dash, `...` for an ellipsis, `->` for an arrow, `"` for curly
  quotes.
- Test data that must contain non-ASCII bytes is **constructed**, not typed:
  `Buffer.from([0xe3, 0x81, 0x82])`, or `"あ"`. The source file stays ASCII; the value at
  runtime does not have to be.
- Values that continuo receives from outside (a repository path, a commit message, a user-supplied
  label) may of course be non-ASCII. This policy governs what continuo *authors*, not what it
  handles. Any code path that echoes external text to a console has to deal with encoding on its
  own terms -- that problem is real, and it is not this policy.
