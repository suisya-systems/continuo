"""The Python half of the fnmatch/shlex differential vector.

``src/fencing/fnmatch.ts`` and ``src/fencing/shlex.ts`` transcribe CPython's
``fnmatch`` and ``shlex`` because ``fencing/rules.py`` and
``fencing/renderer.py`` call them, which makes their exact behaviour part of the
fence rather than an implementation detail of it. A transcription that is 99%
right is a fence with a hole in it, and the hole is silent: a rule that matches
less than its source denies less than its source, with no probe and no error to
say so.

So the transcription is checked against the original rather than reviewed by
eye -- the discipline ``D-0013`` established for ``sqlite3_complete``, applied
for the same reason. Reviewing a character-class parser by reading it is the
task human review is worst at.

This script emits the vector: for every input in
``parity/oracle/fnmatch-shlex-corpus.json``, what CPython answers.
``test/fencing/fnmatch-shlex-oracle.test.ts`` rebuilds the same corpus in the
same order and asserts the transcription agrees at every position.

Not run in CI -- it needs no interlock checkout, but it does need Python, and a
vector the suite can regenerate for itself asserts nothing (see
``docs/differential-oracle.md`` section 5). Run it by hand and commit the result.

Usage, from the continuo repository root::

    python3 scripts/oracle/dump_fnmatch_shlex.py parity/oracle/fnmatch-shlex-vector.json

ASCII only: this file prints to stdout and the repository's output policy
(DECISIONS.md D-0006) applies to anything that reaches a console.
"""

from __future__ import annotations

import fnmatch
import json
import os
import platform
import posixpath
import shlex
import sys
from pathlib import Path

CORPUS = Path("parity/oracle/fnmatch-shlex-corpus.json")


def main() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))

    # The product is built pattern-outer, name-inner, and the TypeScript side
    # rebuilds it the same way. Order is part of the contract: a vector compared
    # positionally against a differently ordered rebuild would report failures
    # everywhere and mean nothing.
    patterns = corpus["fnmatch"]["patterns"]
    names = corpus["fnmatch"]["names"]
    fnmatch_expected = [
        bool(fnmatch.fnmatchcase(name, pattern)) for pattern in patterns for name in names
    ]

    # `translate` is recorded as well as `fnmatchcase`, even though only the
    # match result is load-bearing. When the two implementations disagree about
    # a match, the question is immediately "which of the two regexes is wrong",
    # and without this the answer costs a debugging session. It is compared
    # loosely -- see the test -- because JavaScript has no atomic group and no
    # `\Z`, so the two sources are deliberately not identical.
    fnmatch_translate = [fnmatch.translate(pattern) for pattern in patterns]

    # An input CPython rejects is recorded as a refusal rather than skipped.
    # "Both sides refuse this" is as much a parity claim as "both sides return
    # these tokens", and dropping the rejections would leave the error paths --
    # which is where a lexer transcription most easily drifts -- unchecked.
    split_expected = []
    for text in corpus["shlex_split"]:
        try:
            split_expected.append({"tokens": shlex.split(text)})
        except ValueError as exc:
            split_expected.append({"error": str(exc)})

    quote_expected = [shlex.quote(text) for text in corpus["shlex_quote"]]

    # `posixpath.normpath` decides whether a sandbox deny rule covers a
    # candidate path, and Node's `path.posix.normalize` disagrees with it on
    # trailing slashes and on a leading `//`. Both differences move a rule's
    # coverage, so both are pinned here rather than reasoned about.
    normpath_expected = [posixpath.normpath(p) for p in corpus["pypath"]["normpath"]]

    # `expanduser` reads `HOME`, so it is pinned to the corpus's value for the
    # duration of the dump. Without this the vector would record the generating
    # machine's home directory and the comparison would be between two
    # environments rather than between two implementations.
    oracle_home = corpus["pypath"]["oracle_home"]
    previous_home = os.environ.get("HOME")
    os.environ["HOME"] = oracle_home
    try:
        expanduser_expected = [
            posixpath.expanduser(p) for p in corpus["pypath"]["expanduser"]
        ]
    finally:
        if previous_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = previous_home

    # `repr` shapes refusal message text, which the ported tests assert on. The
    # non-string values are named rather than embedded, because JSON cannot
    # express the int/float distinction that changes what `repr` prints.
    repr_values = {
        "none": None,
        "true": True,
        "false": False,
        "int_0": 0,
        "int_42": 42,
        "int_neg1": -1,
        "list_empty": [],
        "list_abc": ["a", "b", "c"],
        "dict_empty": {},
        "dict_ab": {"a": 1, "b": "x"},
    }
    pystr_repr = [repr(text) for text in corpus["pystr"]["repr"]]
    pystr_repr_nonstring = [repr(repr_values[name]) for name in corpus["pystr"]["repr_nonstring"]]
    pystr_strip = [text.strip() for text in corpus["pystr"]["strip"]]

    vector = {
        "$comment": (
            "Generated by scripts/oracle/dump_fnmatch_shlex.py. Do not edit by hand. "
            "See docs/differential-oracle.md."
        ),
        "python_version": platform.python_version(),
        "fnmatch": {
            "patterns": len(patterns),
            "names": len(names),
            "count": len(fnmatch_expected),
            "translate": fnmatch_translate,
            "expected": fnmatch_expected,
        },
        "shlex_split": {
            "count": len(split_expected),
            "expected": split_expected,
        },
        "shlex_quote": {
            "count": len(quote_expected),
            "expected": quote_expected,
        },
        "pypath": {
            "oracle_home": oracle_home,
            "normpath": {
                "count": len(normpath_expected),
                "expected": normpath_expected,
            },
            "expanduser": {
                "count": len(expanduser_expected),
                "expected": expanduser_expected,
            },
        },
        "pystr": {
            "repr": {"count": len(pystr_repr), "expected": pystr_repr},
            "repr_nonstring": {
                "count": len(pystr_repr_nonstring),
                "expected": pystr_repr_nonstring,
            },
            "strip": {"count": len(pystr_strip), "expected": pystr_strip},
        },
    }

    text = json.dumps(vector, indent=2) + "\n"
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(text, encoding="utf-8")
        sys.stderr.write(
            f"wrote {sys.argv[1]} "
            f"({len(fnmatch_expected)} fnmatch, {len(split_expected)} split, "
            f"{len(quote_expected)} quote, {len(normpath_expected)} normpath, "
            f"{len(expanduser_expected)} expanduser)\n"
        )
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
