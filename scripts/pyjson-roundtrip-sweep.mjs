/**
 * The JSON number round trip, swept against CPython.
 *
 * `D-0210` recovers what `JSON.parse` destroys about a JSON number -- whether
 * the document spelled an `int` or a `float`, and the exact digits of an
 * integer past `2**53` -- by recording the source spelling on the number's
 * CONTAINER SLOT. Both properties reach artefacts that `D-0201` compares BY
 * BYTES across a restart, so "agrees with CPython except for one shape" is not
 * a rounding error: it is a permanent, unclearable "the fence changed".
 *
 * `parity/oracle/fnmatch-shlex-corpus.json` pins 32 hand-chosen documents in
 * the suite, and that is the durable check -- it runs in `npm test` on every
 * cell. This script is the wide, cheap complement: it generates every document
 * in a product of numeric literals and container shapes, asks CPython what it
 * makes of each one, and compares. It exists as a FILE rather than as a number
 * quoted in a commit message because the number quoted in `D-0210`'s commit
 * message (91,775 comparisons over 18,355 documents) could not be reproduced
 * when the lane restarted: the harness that produced it was never committed, so
 * the only evidence left was the sentence claiming it. See `D-0211`.
 *
 * Five comparisons per document, because these are the five spellings the
 * subsystem actually persists or asserts on:
 *
 *   1. `json.dumps(x)`                            -- the default form
 *   2. `json.dumps(x, sort_keys=True)`            -- every durable artefact
 *   3. `json.dumps(x, sort_keys=True, indent=2)`  -- the fence and the settings file
 *   4. `json.dumps(x, sort_keys=True, separators=(",", ":"))` -- the digest input
 *   5. `type(v).__name__` at every number, in document order -- what a refusal says
 *
 * It is NOT wired into `npm run verify` or into CI, for the reason the oracle
 * scripts under `scripts/oracle/` are not either: the matrix cells have no
 * CPython to compare against, which is the whole point of committing a vector
 * instead. Run it when `pyjson.ts` or `pysemantics.ts` changes.
 *
 * Run: `node scripts/pyjson-roundtrip-sweep.mjs` (needs `python3` and a build).
 * Exit 0 and a count, or exit 1 and the first divergences.
 *
 * Measured on 2026-08-28 at the tip of this lane: no divergence over
 * 4,800 documents / 24,000 comparisons.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";

import { pyJsonDumps, pyJsonLoads } from "../dist/fencing/pyjson.js";
import { pyKeys, pyTypeNameOf } from "../dist/fencing/pysemantics.js";

/**
 * The numeric literals, chosen so that every axis the spelling record has to
 * carry appears: the int/float split, both sides of `2**53`, exponents in
 * every spelling CPython accepts, and the two zeroes Python distinguishes.
 */
const LITERALS = [
  // integers, including the exact-digit boundary
  "0",
  "-0",
  "1",
  "-1",
  "2",
  "10",
  "42",
  "255",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "-9007199254740993",
  "18446744073709551617",
  "123456789012345678901234567890",
  "-123456789012345678901234567890",
  // integral floats -- the shape a JavaScript literal cannot express
  "0.0",
  "-0.0",
  "1.0",
  "-1.0",
  "2.0",
  "10.0",
  "1000000.0",
  "9007199254740992.0",
  "1e0",
  "1E0",
  "1e2",
  "1E2",
  "1e+2",
  "1e-2",
  "-1e2",
  "1.5e3",
  "1.5E3",
  "0e0",
  "-0e0",
  // non-integral floats, including the repr edges `pyrepr` already pins
  "0.1",
  "-0.1",
  "0.5",
  "1.5",
  "3.141592653589793",
  "1e16",
  "1e17",
  "1e-7",
  "5e-324",
  "1.7976931348623157e308",
  "2.2250738585072014e-308",
  "1e300",
  "1e-300",
  "123456789.123456789",
];

/** Every document, as source TEXT -- which is the only place a spelling exists. */
function documents() {
  const out = [];
  for (const a of LITERALS) {
    out.push(`{"n": ${a}}`);
    out.push(`[${a}]`);
    // Nesting, so a rebuild that carries the record only at the top level is
    // visible: the inner container has a record of its own.
    out.push(`{"a": ${a}, "z": {"b": ${a}, "c": [${a}]}}`);
    // Integer-like keys, where CPython's pure-string sort and JavaScript's
    // enumeration order disagree, carrying numbers as well.
    out.push(`{"10": ${a}, "2": ${a}, "b": ${a}}`);
    for (const b of LITERALS) {
      // Two different spellings in ONE container: a record keyed by slot has to
      // keep them apart, and a record keyed by value could not -- `1` and `1.0`
      // are the same double.
      out.push(`{"p": ${a}, "q": ${b}}`);
      // The same pair in an ARRAY, whose record is keyed by decimal index
      // rather than by property name: a separate branch in every rebuild site.
      out.push(`[${a}, ${b}]`);
    }
  }
  return out;
}

/** `type(x).__name__` at every number, in document order, as `path=name`. */
function typeNames(value, path, into) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === "number") {
        into.push(`${path}[${index}]=${pyTypeNameOf(value, index)}`);
      } else {
        typeNames(item, `${path}[${index}]`, into);
      }
    });
    return into;
  }
  if (value !== null && typeof value === "object") {
    // `pyKeys`, never `Object.keys`: JavaScript hoists integer-like keys to the
    // front, so `{"10": ..., "2": ...}` would be walked in the wrong order and
    // this harness would report a divergence of its OWN making. The same trap
    // `pyjson.ts` exists to close, met while writing the check for it.
    for (const key of pyKeys(value)) {
      const item = value[key];
      if (typeof item === "number") {
        into.push(`${path}.${key}=${pyTypeNameOf(value, key)}`);
      } else {
        typeNames(item, `${path}.${key}`, into);
      }
    }
  }
  return into;
}

const PYTHON = String.raw`
import json, sys

def type_names(value, path, into):
    if isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, bool) or not isinstance(item, (int, float)):
                type_names(item, "%s[%d]" % (path, index), into)
            else:
                into.append("%s[%d]=%s" % (path, index, type(item).__name__))
    elif isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, bool) or not isinstance(item, (int, float)):
                type_names(item, "%s.%s" % (path, key), into)
            else:
                into.append("%s.%s=%s" % (path, key, type(item).__name__))
    return into

out = []
for line in sys.stdin.read().splitlines():
    if not line:
        continue
    value = json.loads(line)
    out.append([
        json.dumps(value),
        json.dumps(value, sort_keys=True),
        json.dumps(value, sort_keys=True, indent=2),
        json.dumps(value, sort_keys=True, separators=(",", ":")),
        "\n".join(type_names(value, "", [])),
    ])
sys.stdout.write(json.dumps(out))
`;

const docs = documents();
const expected = JSON.parse(
  execFileSync("python3", ["-c", PYTHON], {
    input: `${docs.join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  }),
);

const divergences = [];
let comparisons = 0;
docs.forEach((text, index) => {
  const value = pyJsonLoads(text);
  const actual = [
    pyJsonDumps(value),
    pyJsonDumps(value, { sortKeys: true }),
    pyJsonDumps(value, { sortKeys: true, indent: 2 }),
    pyJsonDumps(value, { sortKeys: true, separators: [",", ":"] }),
    typeNames(value, "", []).join("\n"),
  ];
  const want = expected[index];
  actual.forEach((got, slot) => {
    comparisons += 1;
    if (got !== want[slot]) {
      divergences.push({ document: text, slot, cpython: want[slot], continuo: got });
    }
  });
});

const label = `${docs.length} documents / ${comparisons} comparisons`;
if (divergences.length > 0) {
  console.error(`pyjson round trip: ${divergences.length} DIVERGENCES over ${label}`);
  for (const item of divergences.slice(0, 20)) {
    console.error(`  ${item.document} [${item.slot}]`);
    console.error(`    cpython:  ${JSON.stringify(item.cpython)}`);
    console.error(`    continuo: ${JSON.stringify(item.continuo)}`);
  }
  process.exit(1);
}
console.log(`pyjson round trip: no divergence over ${label}`);
