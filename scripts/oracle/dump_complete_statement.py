"""The Python half of the ``sqlite3_complete`` differential corpus.

``src/sqlite/complete-statement.ts`` transcribes SQLite's ``sqlite3_complete()``
because better-sqlite3 exposes no equivalent and interlock's migrator depends on
one to split a step file into statements. A transcription that is 99% right is a
transcription that silently truncates trigger DDL, so it is checked against the
original rather than reviewed by eye.

This script emits the vector: for every input in the corpus, what Python's
``sqlite3.complete_statement`` -- that is, SQLite's own ``sqlite3_complete`` --
answers. ``test/sqlite/complete-statement.test.ts`` rebuilds the same corpus and
asserts the transcription agrees at every position.

The corpus is **reconstructible, not committed**: it is every cumulative
line-prefix of the shipped migration files, plus the adversarial cases in
``parity/oracle/complete-statement-corpus.json``. Committing 75 MB of prefixes to
assert 2,271 booleans would be absurd, and rebuilding them from the files that
are already committed is exact.

Not run in CI -- it needs no interlock checkout, but it does need Python. Run it
by hand when the migration ledger changes, and commit the result.

Usage::

    python3 scripts/oracle/dump_complete_statement.py \\
        parity/oracle/complete-statement-vector.json

ASCII only: this file prints to stdout and the repository's output policy
(DECISIONS.md D-0006) applies to anything that reaches a console.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

MIGRATIONS = Path("src/control_plane/migrations")
CORPUS = Path("parity/oracle/complete-statement-corpus.json")


def corpus() -> list[str]:
    """Every input, in the order the TypeScript side rebuilds them."""

    inputs: list[str] = []
    # Cumulative line-prefixes of each shipped step, in file-name order. This is
    # exactly the sequence of buffers the migrator's statement splitter tests,
    # so the corpus covers the real question rather than a synthetic one.
    for path in sorted(MIGRATIONS.glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        buffer = ""
        for line in text.splitlines(keepends=True):
            buffer += line
            inputs.append(buffer)
    inputs.extend(json.loads(CORPUS.read_text(encoding="utf-8"))["adversarial"])
    return inputs


def main() -> None:
    inputs = corpus()
    vector = {
        "sqlite_version": sqlite3.sqlite_version,
        "count": len(inputs),
        "expected": [bool(sqlite3.complete_statement(text)) for text in inputs],
    }
    text = json.dumps(vector, indent=2) + "\n"
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(text, encoding="utf-8")
        sys.stderr.write(f"wrote {sys.argv[1]} ({len(inputs)} inputs)\n")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
