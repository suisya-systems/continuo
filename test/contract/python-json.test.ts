import { describe, expect, test } from "vitest";

import {
  pythonJsonDumpsSorted,
  pythonJsonList,
  pythonJsonObject,
  pythonJsonString,
} from "../../src/control_plane/python_json.js";

/**
 * `src/control_plane/python_json.ts` against CPython's actual answers.
 *
 * The module reimplements `json.dumps` for text this package **persists**, so
 * a divergence is a divergence in stored bytes -- and one that no ported case
 * can see, because every assertion in the suite reads those columns back
 * through `JSON.parse`, which is indifferent to exactly the two things that
 * differ. That is the same shape as the `sqlite3_complete` transcription
 * (`D-0013`) and the fixed-point formatter (`D-0104`): an artefact that reads
 * correct and is not.
 *
 * The expectations below were **measured** by running `json.dumps` on CPython,
 * not derived from documentation. They are written as a contract test rather
 * than a full oracle vector because the surface is small and closed -- this
 * package writes flat objects of strings and numbers into three columns and
 * nothing else.
 *
 * Both differences were found in review, and both had already shipped into a
 * copy of this logic before it was made one function:
 *
 *  1. separators -- `", "` and `": "`, which `JSON.stringify` omits;
 *  2. `ensure_ascii=True` -- everything from `U+007F` up escaped as `\uXXXX`,
 *     which `JSON.stringify` emits raw. Reachable here rather than theoretical:
 *     a gate rationale and a skip reason are operator prose.
 */

describe("python_json (contract)", () => {
  test("a string is escaped as json.dumps escapes it", () => {
    expect(pythonJsonString("ascii")).toBe('"ascii"');
    // ensure_ascii=True: every character from U+007F up, lower-case hex.
    expect(pythonJsonString("caf\u00e9")).toBe('"caf\\u00e9"');
    expect(pythonJsonString("\u65e5\u672c\u8a9e")).toBe('"\\u65e5\\u672c\\u8a9e"');
    // Above the BMP, Python emits a surrogate PAIR -- and a JavaScript string
    // is already UTF-16, so escaping per code unit produces exactly that.
    expect(pythonJsonString("\u{1F600}")).toBe('"\\ud83d\\ude00"');
    // DEL is escaped too: the boundary is >= U+007F, not > U+007F.
    expect(pythonJsonString("\u007f")).toBe('"\\u007f"');
    // C0 controls, quotes and backslashes agree with JSON.stringify already.
    expect(pythonJsonString("\u001f")).toBe('"\\u001f"');
    expect(pythonJsonString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  test("a list carries json.dumps' separator", () => {
    expect(pythonJsonList(["force-push", "abandon"])).toBe('["force-push", "abandon"]');
    expect(pythonJsonList([])).toBe("[]");
    expect(pythonJsonList(["\u65e5\u672c\u8a9e"])).toBe('["\\u65e5\\u672c\\u8a9e"]');
  });

  test("an object keeps insertion order and both separators", () => {
    // Python dicts preserve insertion order and json.dumps follows it, so a
    // payload written as a dict literal is stored in the order it was written
    // -- which here is deliberately NOT alphabetical.
    expect(
      pythonJsonObject([
        ["gate_id", "gate-1"],
        ["gate_type", "worker_escalation"],
        ["stage", "answered"],
        ["outcome", "withdrawn"],
      ]),
    ).toBe(
      '{"gate_id": "gate-1", "gate_type": "worker_escalation", "stage": "answered", "outcome": "withdrawn"}',
    );
  });

  test("sort_keys=True sorts, and numbers are not quoted", () => {
    expect(pythonJsonDumpsSorted({ b: 2, a: "x" })).toBe('{"a": "x", "b": 2}');
  });

  test("a payload shape this package does not write is refused", () => {
    // Rather than silently emitting text json.dumps would not have produced.
    expect(() => pythonJsonDumpsSorted({ a: null as unknown as string })).toThrow(
      /flat string\/number payloads/,
    );
  });
});
