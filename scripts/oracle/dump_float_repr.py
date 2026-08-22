"""Ask Python how it spells a float, for every input in the corpus.

The float half of the rendering oracle (`docs/differential-oracle.md`, continuo
`D-0104`). `src/measurement/format.ts` reimplements Python's `repr(float)`
because `String(number)` disagrees with it in three ways that reach a report:

* **An integral float keeps its `.0`.** `repr(1.0)` is `'1.0'` and
  `String(1)` is `'1'`, and `json.dumps` carries the difference through -- so a
  coverage ratio of exactly 1.0 renders as `1.0` in interlock's header and would
  render as `1` here.
* **The two languages switch to exponential notation at different
  magnitudes.** Python leaves fixed notation above 1e16 and below 1e-4;
  JavaScript at 1e21 and 1e-7. Between those bounds the same double prints two
  different strings.
* **The exponent is spelled differently.** Python pads it to two digits with a
  sign (`1e-05`); JavaScript does not (`1e-7`).

`provenance.py` reaches all three. It hashes a REAL column as `repr(value)`
inside the database fingerprint -- the field whose entire claim is that two
reports carrying one digest saw one content -- and it renders `coverage.ratio`
through `json.dumps`. A digest that disagreed with interlock's over the same
rows would make the two ports' reports incomparable in exactly the field that
exists to compare them.

A reimplementation is the kind of artefact that reads correct and is not, so it
is pinned against the thing it reimplements rather than against a handful of
examples somebody thought of. Same argument and same shape as the fixed-format
oracle next to it, and as the `sqlite3_complete` transcription (`D-0013`).

Unlike the control-plane oracle this needs **no interlock checkout**: the oracle
is CPython's own float formatter, reached through the standard library. It is
therefore cheap to regenerate, and the corpus is built here rather than
committed separately.

Regenerate from the continuo repository root:

    PYTHONDONTWRITEBYTECODE=1 python3 scripts/oracle/dump_float_repr.py \\
      parity/oracle/float-repr-vector.json

Then review the diff and commit it. The test never writes this file.
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

#: Bumped whenever the corpus construction below changes, so a vector produced
#: by an older script is recognisable as one rather than silently compared.
CORPUS_VERSION = 1


def bits_of(value: float) -> int:
    return struct.unpack(">Q", struct.pack(">d", value))[0]


def float_of(bits: int) -> float:
    return struct.unpack(">d", struct.pack(">Q", bits & 0xFFFF_FFFF_FFFF_FFFF))[0]


def neighbours(value: float) -> list[float]:
    """*value* and its two bit-adjacent doubles.

    Stepping the 64-bit pattern rather than calling `math.nextafter`, because
    the TypeScript side has to reproduce the same three doubles exactly and a
    bit step is the one construction both languages spell identically. Skipped
    for the non-finite values, whose neighbours are not doubles a report can
    hold.
    """

    if not math.isfinite(value):
        return [value]
    bits = bits_of(value)
    return [value, float_of(bits + 1), float_of(bits - 1)]


def corpus() -> list[float]:
    """Every input the vector covers, in a fixed order.

    **Deterministic, and rebuilt rather than transported.** The TypeScript side
    reconstructs this exact list from the same rules, so the committed vector
    carries only the rendered strings -- the shape the fixed-format and
    `sqlite3_complete` corpora already use, and for the same reason: a corpus
    that has to be committed alongside its answers is a corpus that gets
    truncated for size. There is deliberately no RNG: Python's Mersenne Twister
    is not reproducible in JavaScript, so a sampled corpus could not be rebuilt
    on the other side.

    Five groups, each for a reason:

    * **Every decade, and one bit either side of it.** The decade is where the
      fixed/exponential decision is made, and the two neighbours are what catch
      a threshold written as `<` where it should be `<=`. `1e16` prints
      exponential and `9999999999999998.0` -- one bit below it -- prints fixed.
    * **Integral values.** The `.0` suffix, across the magnitudes where it is
      still printed at all.
    * **The ratios this harness computes.** `coverage.ratio` is `covered/total`,
      so the corpus sweeps exactly that arithmetic.
    * **Subnormals and the extremes.** The smallest positive double prints as
      `5e-324` -- seventeen significant digits are not needed and must not be
      printed -- and the largest as `1.7976931348623157e+308`.
    * **The non-finite values.** `inf`, `-inf` and `nan` are what SQLite returns
      for a REAL column holding them, and Python spells all three without the
      `float()` wrapper JavaScript's `String` would give.
    """

    values: list[float] = []

    # Decades, with a bit either side. Built by parsing a decimal literal on
    # both sides, which is exact: both languages round the literal to the
    # nearest double, and there is only one nearest.
    for exponent in range(-323, 309):
        values.extend(neighbours(float(f"1e{exponent}")))
        values.extend(neighbours(float(f"-1e{exponent}")))

    # Integral values: the `.0` suffix and where it stops.
    for whole in range(0, 25):
        values.append(float(whole))
        values.append(-float(whole))
    for power in range(0, 63):
        values.extend(neighbours(float(2**power)))

    # The ratios: covered / total, which is the only float this harness derives.
    for total in range(1, 25):
        for covered in range(0, total + 1):
            values.append(covered / total)

    # Subnormals, by bit pattern, and the extremes.
    for bits in (1, 2, 3, 7, 1 << 20, 1 << 40, (1 << 52) - 1, 1 << 52):
        values.append(float_of(bits))
        values.append(-float_of(bits))
    values.extend(
        [
            sys.float_info.max,
            -sys.float_info.max,
            sys.float_info.min,
            -sys.float_info.min,
            sys.float_info.epsilon,
            0.0,
            -0.0,
        ]
    )

    # A deterministic spread with no shared decimal structure. The stride is
    # `math.pi`, which is the same double in both languages, so the walk lands
    # on the same values on both sides.
    value = -500.0
    for _ in range(500):
        values.append(value)
        value += math.pi
    for step in range(1, 400):
        values.append(step / 7919.0)

    # The non-finite values, last so the finite corpus keeps its indices if
    # these ever move.
    values.extend([math.inf, -math.inf, math.nan])
    return values


def main(destination: str) -> None:
    values = corpus()
    # Only the rendered strings are committed: the TypeScript side rebuilds the
    # corpus from the same rules, and a length check turns "somebody changed the
    # corpus" into an explicit instruction to regenerate rather than a silent
    # drift.
    document = {
        "source": {
            "producer": "scripts/oracle/dump_float_repr.py",
            "oracle": "CPython repr(float), which is what src/measurement/format.ts reimplements",
            "python_version": sys.version.split()[0],
            "corpus_version": CORPUS_VERSION,
            "corpus_length": len(values),
        },
        "rendered": [repr(value) for value in values],
        # json.dumps is the second consumer -- the header's coverage.ratio goes
        # through it. It agrees with repr on every finite value and diverges on
        # the three that are not: `allow_nan` defaults to True, so CPython emits
        # the bare tokens `Infinity`, `-Infinity` and `NaN`, which are not JSON
        # any parser is obliged to accept. Recorded rather than skipped, because
        # "the port must reproduce this" and "the port need not reach this" are
        # different statements and only the vector can tell them apart.
        "json_dumps": [json.dumps(value) for value in values],
    }
    Path(destination).write_text(
        json.dumps(document, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    print(f"wrote {len(values)} rendered floats to {destination}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: dump_float_repr.py <destination.json>")
    main(sys.argv[1])
