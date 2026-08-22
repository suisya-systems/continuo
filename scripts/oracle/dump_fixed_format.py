"""Ask Python how it renders a fixed-point number, for every input in the corpus.

The Python half of the fixed-format oracle (`docs/differential-oracle.md`,
continuo `D-0104`). `src/measurement/format.ts` reimplements Python's
`format(value, '.Nf')` because `Number.prototype.toFixed` disagrees with it on
exact ties -- Python rounds half to even, JavaScript rounds half away from zero
-- and interlock#74's acceptance criterion 3 makes rendered figures a parity
surface rather than presentation.

A reimplementation is exactly the kind of artefact that reads correct and is
not, so it is pinned against the thing it reimplements rather than against a
handful of examples somebody thought of. This is the same argument, and the same
shape, as the `sqlite3_complete` transcription and its corpus (`D-0013`).

Unlike the control-plane oracle this needs **no interlock checkout**: the oracle
is CPython's own formatter, reached through the standard library. It is
therefore cheap to regenerate, and the corpus is built here rather than
committed separately.

Regenerate from the continuo repository root:

    PYTHONDONTWRITEBYTECODE=1 python3 scripts/oracle/dump_fixed_format.py \\
      parity/oracle/fixed-format-vector.json

Then review the diff and commit it. The test never writes this file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

#: Bumped whenever the corpus construction below changes, so a vector produced
#: by an older script is recognisable as one rather than silently compared.
CORPUS_VERSION = 1

#: The widths the harness actually formats at, plus 0 and 1 to exercise the
#: carry into the integer part and the single-digit tie.
WIDTHS = (0, 1, 2, 4)


def corpus() -> list[float]:
    """Every input the vector covers, in a fixed order.

    **Deterministic, and rebuilt rather than transported.** The TypeScript side
    reconstructs this exact list from the same rules, so the committed vector
    carries only the rendered strings. That is the shape the
    `sqlite3_complete` corpus already uses (`D-0013`), and the reason is the
    same: a corpus that has to be committed alongside its answers is a corpus
    that gets truncated for size. There is deliberately no RNG here -- Python's
    Mersenne Twister is not reproducible in JavaScript, so a sampled corpus
    could not be rebuilt on the other side.

    Three groups, each for a reason:

    * **The ties, exhaustively.** A tie is the only place the two languages
      disagree, so every tie class is enumerated rather than sampled. At two
      decimal places the exact ties are the fractional parts .125/.375/.625/.875
      (nothing else is both a tie and exactly representable as a double); .05
      and .5 are the ties at one place and zero. Each appears against several
      integer parts, because half-to-even depends on the parity of the digit
      being kept and that digit changes with the integer part at width 0.
    * **Real report shapes.** Every rate this harness prints is
      ``count / count * 100``, so the corpus sweeps exactly that. The
      denominators include the powers of two and their decimal multiples, which
      are the only ones that can produce an exact tie -- 1/800 = 0.125 percent
      is a tie a hand-written list would not think of.
    * **A deterministic spread.** A fixed arithmetic walk over a wide range,
      to catch a rounding bug that is not about ties at all.
    """

    values: list[float] = []

    for whole in (0, 1, 2, 3, 4, 5, 12, 99, 100, 12345):
        for fraction in (
            0.0, 0.005, 0.015, 0.025, 0.05, 0.1, 0.125, 0.25, 0.375, 0.5,
            0.625, 0.75, 0.875, 0.995, 0.9995,
        ):
            values.append(whole + fraction)
            values.append(-(whole + fraction))

    # Rates: k out of n as a percentage, which is the only arithmetic that
    # produces a figure in this harness.
    for n in range(1, 25):
        for k in range(0, n + 1):
            values.append(k / n * 100)
    # The tie-capable denominators: a percentage k/n*100 can land on an exact
    # tie only when n divides a power of two times a power of ten.
    for n in (32, 50, 64, 80, 100, 128, 160, 200, 250, 256, 400, 500, 800):
        for k in range(0, n + 1):
            values.append(k / n * 100)

    # A deterministic spread: a walk with an irrational-ish stride so the
    # values do not share a common decimal structure.
    value = -1000.0
    for _ in range(600):
        values.append(value)
        value += 3.3391304347826085
    for step in range(400):
        values.append(step / 7919.0)

    values.extend([0.0, -0.0, 1e-9, -1e-9, 1e15, -1e15])
    return values


def main(destination: str) -> None:
    values = corpus()
    # Only the rendered strings are committed: the TypeScript side rebuilds the
    # corpus from the same rules, and a length check turns "somebody changed the
    # corpus" into an explicit instruction to regenerate rather than a silent
    # drift. Stored as one array per width, which is the compact shape -- the
    # vector is read in full by every test run.
    document = {
        "source": {
            "producer": "scripts/oracle/dump_fixed_format.py",
            "oracle": "CPython str.format, which is what src/measurement/format.ts reimplements",
            "python_version": sys.version.split()[0],
            "corpus_version": CORPUS_VERSION,
            "corpus_length": len(values),
            "widths": list(WIDTHS),
        },
        "rendered": {
            str(width): [format(value, f".{width}f") for value in values]
            for width in WIDTHS
        },
    }
    Path(destination).write_text(
        json.dumps(document, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {len(values)} values x {len(WIDTHS)} widths to {destination}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: dump_fixed_format.py <destination.json>")
    main(sys.argv[1])
