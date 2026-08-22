"""The Python half of the fnmatch/shlex differential vector.

``src/fencing/fnmatch.ts`` and ``src/fencing/shlex.ts`` transcribe CPython's
``fnmatch`` and ``shlex`` because ``fencing/rules.py`` and
``fencing/renderer.py`` call them, which makes their exact behaviour part of the
fence rather than an implementation detail of it. A transcription that is 99%
right is a fence with a hole in it, and the hole is silent: a rule that matches
less than its source denies less than its source, with no probe and no error to
say so.

The same argument reaches every other CPython behaviour this port had to
transcribe rather than substitute, so the vector covers them all: the regex
dialect (``src/fencing/pyregex.ts``, which ``renderer.py`` hands
author-supplied ``forbidden_allow_regex`` patterns to), the JSON serialiser and
loader (``src/fencing/pyjson.ts``, whose output is compared BY BYTES across a
restart), the composed ``rules._normalize_path``, and the value semantics
``renderer.py`` is written in (``src/fencing/pysemantics.ts`` -- ``or``,
iteration, ``in``, ``set()``, ``str()`` and ``dict.items()``, every one of which
has a JavaScript near-equivalent that is narrower than the original).

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
import ntpath
import os
import platform
import posixpath
import re
import shlex
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

CORPUS = Path("parity/oracle/fnmatch-shlex-corpus.json")

# The `json.dumps` keyword arguments each option name stands for. Named rather
# than embedded in the corpus because the two sides spell them differently
# (`sort_keys` / `sortKeys`); the test holds the same table under the same
# names, and the corpus is what pairs them.
DUMPS_OPTIONS: dict[str, dict[str, Any]] = {
    "default": {},
    "sorted": {"sort_keys": True},
    "indent2": {"indent": 2},
    "indent2_sorted": {"indent": 2, "sort_keys": True},
    # `indent=0` is NOT `indent=None`: it still puts every item on its own line.
    "indent0_sorted": {"indent": 0, "sort_keys": True},
    "indent4_sorted": {"indent": 4, "sort_keys": True},
    "compact": {"separators": (",", ":")},
    "compact_sorted": {"separators": (",", ":"), "sort_keys": True},
    "raw_unicode": {"ensure_ascii": False},
    "raw_unicode_sorted": {"ensure_ascii": False, "sort_keys": True},
}

# The numbers behind `pyjson.dumps_numbers`. Named for the reason
# `pystr.repr_nonstring` is: JSON cannot express the int/float distinction, and
# this table exists to probe exactly it.
DUMPS_NUMBERS: dict[str, Any] = {
    "int_0": 0,
    "int_neg1": -1,
    "int_max_safe": 9007199254740991,
    "float_neg_zero": -0.0,
    "float_half": 0.5,
    "float_third": 1 / 3,
    "float_1e16": 1e16,
    "float_1e17": 1e17,
    "float_1e21": 1e21,
    "float_1e_minus_4": 1e-4,
    "float_1e_minus_5": 1e-5,
    "float_1e_minus_7": 1e-7,
    "float_max": 1.7976931348623157e308,
    "float_min_subnormal": 5e-324,
    "float_avogadro": 6.02e23,
    "float_1e300": 1e300,
    "float_nan": float("nan"),
    "float_inf": float("inf"),
    "float_neg_inf": float("-inf"),
    # The two entries the port cannot reproduce, listed in the corpus under
    # `dumps_number_accepted_deviations`: an integral float is indistinguishable
    # from an int once `JSON.parse` has read it.
    "float_1e15": 1e15,
    "float_one_point_zero": 1.0,
}

# The values behind `pysemantics.values`. Same convention, same reason -- and
# here the point is sharper still, because the whole module exists for the two
# values JavaScript calls truthy and Python calls falsy.
SEMANTICS_VALUES: dict[str, Any] = {
    "none": None,
    "true": True,
    "false": False,
    "int_0": 0,
    "int_1": 1,
    "int_neg1": -1,
    "str_empty": "",
    "str_abc": "abc",
    "str_0": "0",
    "str_astral": "a\U0001f600b",
    "list_empty": [],
    "list_abc": ["a", "b", "c"],
    "list_nested": ["a", ["b"], {"c": 1}],
    "dict_empty": {},
    "dict_ab": {"a": 1, "b": "x"},
    "float_half": 0.5,
}


@contextmanager
def _pinned_env(**values: str) -> Iterator[None]:
    """Run the block with these environment variables set, then restore them.

    An oracle that read the generating machine's HOME would compare two
    environments and call it a comparison of two implementations.
    """
    previous = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for name, was in previous.items():
            if was is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = was


def _record_key_order(value: Any, path: str, out: list[list]) -> None:
    """Every mapping's keys, in dict order, with the path that reaches it.

    Flat rather than nested so a divergence names the mapping that diverged
    instead of printing the whole document.
    """
    if isinstance(value, dict):
        out.append([path, list(value.keys())])
        for key, child in value.items():
            _record_key_order(child, f"{path}.{key}", out)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _record_key_order(child, f"{path}[{index}]", out)


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

    # `re` is the fence's regex dialect, not an implementation detail of it:
    # `renderer.py:_check_forbidden_allow` compiles author-supplied patterns and
    # runs `search` over every allow entry. For each pattern the vector records
    # EITHER the search result on every subject OR the `re.error` message, so a
    # refusal is a recorded answer rather than a gap.
    #
    # A pattern's row is one STRING rather than a list of cells: 187 patterns x
    # 107 subjects is 20,009 answers, and at one JSON line per answer the vector
    # would be twenty thousand lines nobody reads. Each cell is "" for no match
    # or "start,end" in CODE POINTS (`re` counts code points; JavaScript counts
    # UTF-16 units, and the comparison has to be in the unit both can express).
    regex_expected = []
    for pattern in corpus["pyregex"]["patterns"]:
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            regex_expected.append({"error": str(exc)})
            continue
        cells = []
        for subject in corpus["pyregex"]["subjects"]:
            found = compiled.search(subject)
            cells.append("" if found is None else f"{found.start()},{found.end()}")
        regex_expected.append({"search": "|".join(cells)})

    # `json.dumps` is how every durable fencing artefact reaches disk, and the
    # restart path compares those artefacts by BYTES. The values are given as
    # JSON source texts and parsed here, which is the only way to express a
    # mapping whose keys are integer-like and out of order -- the case a
    # JavaScript object literal cannot hold at all.
    dumps_expected = []
    for text in corpus["pyjson"]["dumps"]:
        value = json.loads(text)
        for option_name in corpus["pyjson"]["dumps_options"]:
            dumps_expected.append(json.dumps(value, **DUMPS_OPTIONS[option_name]))

    # Number formatting is `float.__repr__`, which `String(n)` is close to and
    # not equal to. Named rather than embedded, because this section is
    # precisely about the int/float distinction JSON cannot carry.
    dumps_numbers_expected = [
        json.dumps(DUMPS_NUMBERS[name]) for name in corpus["pyjson"]["dumps_numbers"]
    ]

    # `json.loads` is transcribed for ONE property `JSON.parse` cannot supply:
    # the source key order. So the recorded answer is the key order at every
    # path, plus the round trip, which puts the values under the same lens.
    loads_expected = []
    for text in corpus["pyjson"]["loads"]:
        value = json.loads(text)
        order: list[list] = []
        _record_key_order(value, "$", order)
        loads_expected.append({"key_order": order, "roundtrip": json.dumps(value)})

    # The Python value semantics `renderer.py` is written in. Results go through
    # `repr` so that WHICH value came back is compared rather than "something
    # truthy came back", and so that the int/float distinction survives.
    or_expected = [
        repr(SEMANTICS_VALUES[value] or SEMANTICS_VALUES[fallback])
        for value, fallback in corpus["pysemantics"]["or"]
    ]

    iterate_expected = []
    for name in corpus["pysemantics"]["iterate"]:
        try:
            iterate_expected.append({"items": [repr(item) for item in SEMANTICS_VALUES[name]]})
        except TypeError as exc:
            iterate_expected.append({"error": str(exc)})

    in_expected = []
    for needle, haystack in corpus["pysemantics"]["in"]:
        try:
            in_expected.append({"result": SEMANTICS_VALUES[needle] in SEMANTICS_VALUES[haystack]})
        except TypeError as exc:
            in_expected.append({"error": str(exc)})

    set_expected = []
    for element_names in corpus["pysemantics"]["set"]:
        try:
            # Sorted, because a `set` has no order to compare and CPython's
            # iteration order is not JavaScript's. The reprs are ASCII, so
            # Python's code-point sort and JavaScript's UTF-16 sort agree.
            set_expected.append(
                {
                    "items": sorted(
                        repr(item) for item in {SEMANTICS_VALUES[n] for n in element_names}
                    )
                }
            )
        except TypeError as exc:
            set_expected.append({"error": str(exc)})

    str_expected = [str(SEMANTICS_VALUES[name]) for name in corpus["pysemantics"]["str"]]

    mapping_expected = []
    for text in corpus["pysemantics"]["mapping_texts"]:
        mapping = json.loads(text)
        mapping_expected.append(
            {
                "keys": [key for key in mapping],
                "items": [[key, repr(value)] for key, value in mapping.items()],
            }
        )

    # `rules._normalize_path`, the COMPOSED function. `os.sep` is
    # platform-dependent in the source, so both compositions are recorded and
    # the test picks the one for the platform it runs on. HOME, USERPROFILE and
    # USERNAME are pinned for the same reason `expanduser` above pins HOME.
    oracle_username = corpus["pypath"]["oracle_username"]
    normalize_inputs = corpus["pypath"]["normalize_path"]
    with _pinned_env(HOME=oracle_home, USERPROFILE=oracle_home, USERNAME=oracle_username):
        # posix: `os.sep` is "/", so `replace(os.sep, "/")` is the identity.
        normalize_posix = [
            posixpath.normpath(posixpath.expanduser(p)) for p in normalize_inputs
        ]
        # windows: `os.sep` is "\\", and `ntpath.expanduser` terminates the user
        # field at EITHER separator -- which is what makes "~\\.aws" expand
        # there and stay unexpanded on posix.
        normalize_windows = [
            posixpath.normpath(ntpath.expanduser(p).replace("\\", "/")) for p in normalize_inputs
        ]

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
        "pyregex": {
            "patterns": len(corpus["pyregex"]["patterns"]),
            "subjects": len(corpus["pyregex"]["subjects"]),
            "expected": regex_expected,
        },
        "pyjson": {
            "dumps": {
                "count": len(dumps_expected),
                "expected": dumps_expected,
            },
            "dumps_numbers": {
                "count": len(dumps_numbers_expected),
                "expected": dumps_numbers_expected,
            },
            "loads": {
                "count": len(loads_expected),
                "expected": loads_expected,
            },
        },
        "pysemantics": {
            "or": {"count": len(or_expected), "expected": or_expected},
            "iterate": {"count": len(iterate_expected), "expected": iterate_expected},
            "in": {"count": len(in_expected), "expected": in_expected},
            "set": {"count": len(set_expected), "expected": set_expected},
            "str": {"count": len(str_expected), "expected": str_expected},
            "mapping": {"count": len(mapping_expected), "expected": mapping_expected},
        },
        "normalize_path": {
            "oracle_username": oracle_username,
            "count": len(normalize_inputs),
            "posix": normalize_posix,
            "windows": normalize_windows,
        },
    }

    text = json.dumps(vector, indent=2) + "\n"
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(text, encoding="utf-8")
        sys.stderr.write(
            f"wrote {sys.argv[1]} "
            f"({len(fnmatch_expected)} fnmatch, {len(split_expected)} split, "
            f"{len(quote_expected)} quote, {len(normpath_expected)} normpath, "
            f"{len(expanduser_expected)} expanduser, "
            f"{len(regex_expected)} regex patterns x "
            f"{len(corpus['pyregex']['subjects'])} subjects, "
            f"{len(dumps_expected)} dumps, {len(dumps_numbers_expected)} numbers, "
            f"{len(loads_expected)} loads, {len(normalize_inputs)} normalize_path)\n"
        )
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
