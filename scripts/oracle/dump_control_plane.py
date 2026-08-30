"""The Python half of the differential oracle.

Migrates an empty database to head through *interlock's* migrator, with the
same fixed clock as ``test/oracle/control-plane-dump.ts``, and prints the same
normalised JSON. ``parity/oracle/control-plane-state.json`` holds the vector this
side produced, and ``test/control_plane/differential-oracle.test.ts`` compares
continuo's dump against it.

Interlock's head IS the shared migration history: interlock is a frozen source,
so its ledger is the terminus continuo's half stops at
(``SHARED_HEAD_VERSION``). This script therefore needs no version bound of its
own -- there is nothing above the shared terminus on this side to exclude.

This script is not run in CI -- it needs an interlock checkout, which CI does
not have. It is run by hand when the vector is (re)generated, and the command
is recorded in ``docs/differential-oracle.md`` so the vector is reproducible
rather than trusted.

Usage::

    PYTHONPATH=<interlock>/src python3 scripts/oracle/dump_control_plane.py [output.json]

ASCII only: this file prints to stdout and the repository's output policy
(DECISIONS.md D-0006) applies to anything that reaches a console.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

from claude_org_runtime.control_plane.migrator import create_production_control_plane

# The clock every dump is taken at. Fixed so two dumps are comparable.
NOW_MS = 1_700_000_000_000

# The interlock revision this vector attests to. Update it in the same commit
# that regenerates the vector against a different checkout.
SOURCE_REVISION = "65f36c5"

# Ordering for schema objects, as the generated reading aid uses.
KIND_ORDER = {"table": 0, "view": 1, "index": 2, "trigger": 3}


def dump() -> dict:
    directory = Path(tempfile.mkdtemp(prefix="continuo-oracle-"))
    path = directory / "production.sqlite3"
    connection = create_production_control_plane(path, now_ms=NOW_MS)
    try:
        schema = sorted(
            (
                {"type": row[0], "name": row[1], "sql": row[2].strip()}
                for row in connection.execute(
                    "SELECT type, name, sql FROM sqlite_master "
                    "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
                )
            ),
            key=lambda row: (KIND_ORDER.get(row["type"], 9), row["name"]),
        )

        table_names = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
        ]

        tables = {}
        for name in table_names:
            columns = [
                {
                    "name": column[1],
                    "type": column[2],
                    # sqlite3 hands these back as ints; better-sqlite3 does the
                    # same, so no coercion is needed on either side.
                    "notnull": column[3],
                    "dflt_value": column[4],
                    "pk": column[5],
                }
                for column in connection.execute(f"PRAGMA table_info({name})")
            ]
            order = ", ".join(f'"{column["name"]}"' for column in columns)
            cursor = connection.execute(f'SELECT * FROM "{name}" ORDER BY {order}')
            keys = [description[0] for description in cursor.description]
            rows = [dict(zip(keys, row, strict=True)) for row in cursor.fetchall()]
            tables[name] = {"columns": columns, "row_count": len(rows), "rows": rows}

        return {
            # Stamped into the vector itself, not left to a document beside it:
            # the vector is evidence of parity against ONE interlock revision,
            # and a comparison against a vector whose provenance is unknown is
            # not a comparison at all.
            "source": {
                "repository": "suisya-systems/interlock",
                "revision": SOURCE_REVISION,
            },
            "application_id": connection.execute("PRAGMA application_id").fetchone()[0],
            "user_version": connection.execute("PRAGMA user_version").fetchone()[0],
            "foreign_keys": connection.execute("PRAGMA foreign_keys").fetchone()[0],
            "integrity_check": [
                row[0] for row in connection.execute("PRAGMA integrity_check")
            ],
            "foreign_key_check": [
                dict(zip(["table", "rowid", "parent", "fkid"], row, strict=True))
                for row in connection.execute("PRAGMA foreign_key_check")
            ],
            "schema": schema,
            "tables": tables,
        }
    finally:
        connection.close()
        shutil.rmtree(directory, ignore_errors=True)


def main() -> None:
    text = json.dumps(dump(), indent=2, ensure_ascii=False) + "\n"
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(text, encoding="utf-8")
        sys.stderr.write(f"wrote {sys.argv[1]}\n")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
