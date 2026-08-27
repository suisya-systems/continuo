import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  normpath,
  ntIsabs,
  ntJoin,
  ntNormpath,
  ntSplit,
  ntSplitdrive,
  posixIsabs,
  posixJoin,
  posixSplit,
  posixSplitdrive,
} from "../../src/fencing/pypath.js";

/**
 * The `os.path` differential oracle.
 *
 * **Target-only.** These cases translate no interlock node id, and could not:
 * in Python `os.path` is the standard library, so interlock's suite asserts
 * nothing about it and everything it does with a path is true by construction.
 * Here it is a transcription (`src/fencing/pypath.ts`), and a transcription is
 * checkable only against the thing it transcribes.
 *
 * The settings generator is what makes this load-bearing rather than tidy.
 * `_is_inside_root` decides whether a Layer 3 deny entry escaped the sandbox by
 * composing `normpath` with an `os.sep` boundary test, and `_kept_entry_string`
 * emits `os.path.join(anchor_base, path)` as the literal string that lands in
 * `settings.local.json`. A `normpath` that keeps a trailing separator makes the
 * equality half of the boundary test stop firing -- a deny entry silently
 * suppressed, or silently kept -- and a `join` that spells a Windows path with
 * the wrong separator writes a deny path bwrap cannot bind.
 *
 * **Both namespaces run on every cell.** `posixpath` and `ntpath` are dumped
 * from one interpreter and asserted from every matrix cell, because the port
 * dispatches on `process.platform`: checking only the half the current platform
 * ships would leave the Windows half unverified on the Linux cells, which is
 * where most runs happen, and the Linux half unverified on the Windows ones.
 *
 * Authority: `DECISIONS.md` D-0213 (and D-0200, which established the practice).
 * Regeneration: `scripts/oracle/dump_ospath.py`, by hand, never from this side.
 */

const ROOT = join(import.meta.dirname, "..", "..");

interface ModuleSection {
  readonly normpath: readonly string[];
  readonly isabs: readonly boolean[];
  readonly split: readonly (readonly string[])[];
  readonly splitdrive: readonly (readonly string[])[];
  readonly dirname: readonly string[];
  readonly basename: readonly string[];
  readonly join: readonly string[];
}

const corpus: {
  readonly paths: readonly string[];
  readonly joins: readonly (readonly string[])[];
} = JSON.parse(readFileSync(join(ROOT, "parity", "oracle", "ospath-corpus.json"), "utf8"));

const vector: {
  readonly python_version: string;
  readonly counts: { readonly paths: number; readonly joins: number };
  readonly posixpath: ModuleSection;
  readonly ntpath: ModuleSection;
} = JSON.parse(readFileSync(join(ROOT, "parity", "oracle", "ospath-vector.json"), "utf8"));

/** The port's half, in the shape the vector records. */
interface Transcription {
  readonly normpath: (p: string) => string;
  readonly isabs: (p: string) => boolean;
  readonly split: (p: string) => [string, string];
  readonly splitdrive: (p: string) => [string, string];
  readonly join: (first: string, ...rest: readonly string[]) => string;
}

const POSIX: Transcription = {
  normpath,
  isabs: posixIsabs,
  split: posixSplit,
  splitdrive: posixSplitdrive,
  join: posixJoin,
};

const NT: Transcription = {
  normpath: ntNormpath,
  isabs: ntIsabs,
  split: ntSplit,
  splitdrive: ntSplitdrive,
  join: ntJoin,
};

describe("the os.path vector is not vacuous", () => {
  /**
   * A vector regenerated from a failed or empty run would let every comparison
   * below pass while comparing nothing. Both existing oracles carry this guard
   * for the same reason.
   */
  test("the corpus is the size the vector was generated at", () => {
    expect(corpus.paths).toHaveLength(vector.counts.paths);
    expect(corpus.joins).toHaveLength(vector.counts.joins);
    for (const section of [vector.posixpath, vector.ntpath]) {
      expect(section.normpath).toHaveLength(vector.counts.paths);
      expect(section.isabs).toHaveLength(vector.counts.paths);
      expect(section.split).toHaveLength(vector.counts.paths);
      expect(section.splitdrive).toHaveLength(vector.counts.paths);
      expect(section.dirname).toHaveLength(vector.counts.paths);
      expect(section.basename).toHaveLength(vector.counts.paths);
      expect(section.join).toHaveLength(vector.counts.joins);
    }
  });

  test("the corpus exercises both answers and both namespaces disagree somewhere", () => {
    // An all-false `isabs` corpus would be satisfied by a predicate that never
    // fires -- the safe-looking direction, and therefore the one that passes
    // unnoticed.
    expect(vector.posixpath.isabs).toContain(true);
    expect(vector.posixpath.isabs).toContain(false);
    expect(vector.ntpath.isabs).toContain(true);
    expect(vector.ntpath.isabs).toContain(false);
    // And a corpus on which the two namespaces never differ would let one
    // transcription stand in for the other, which is the substitution this
    // whole file exists to rule out.
    expect(vector.ntpath.normpath).not.toStrictEqual(vector.posixpath.normpath);
    expect(vector.ntpath.splitdrive).not.toStrictEqual(vector.posixpath.splitdrive);
    expect(vector.ntpath.join).not.toStrictEqual(vector.posixpath.join);
  });

  test("the vector was generated by the CPython the port transcribes", () => {
    expect(vector.python_version.startsWith("3.12.")).toBe(true);
  });
});

for (const [name, port, expected] of [
  ["posixpath", POSIX, vector.posixpath],
  ["ntpath", NT, vector.ntpath],
] as const) {
  describe(`${name} agrees with CPython at every position`, () => {
    test("normpath", () => {
      for (const [index, input] of corpus.paths.entries()) {
        expect(port.normpath(input), `normpath(${JSON.stringify(input)})`).toBe(
          expected.normpath[index],
        );
      }
    });

    test("isabs", () => {
      for (const [index, input] of corpus.paths.entries()) {
        expect(port.isabs(input), `isabs(${JSON.stringify(input)})`).toBe(expected.isabs[index]);
      }
    });

    test("split, and the dirname / basename projected from it", () => {
      for (const [index, input] of corpus.paths.entries()) {
        const [head, tail] = port.split(input);
        expect([head, tail], `split(${JSON.stringify(input)})`).toStrictEqual([
          ...(expected.split[index] as readonly string[]),
        ]);
        // `dirname` and `basename` ARE the two halves in CPython, so asserting
        // them separately is what catches a projection that drifts from the
        // split it claims to be.
        expect(head, `dirname(${JSON.stringify(input)})`).toBe(expected.dirname[index]);
        expect(tail, `basename(${JSON.stringify(input)})`).toBe(expected.basename[index]);
      }
    });

    test("splitdrive", () => {
      for (const [index, input] of corpus.paths.entries()) {
        expect([...port.splitdrive(input)], `splitdrive(${JSON.stringify(input)})`).toStrictEqual([
          ...(expected.splitdrive[index] as readonly string[]),
        ]);
        // CPython's documented invariant: the two halves concatenate back to
        // the input. A transcription that normalised on the way through would
        // pass the pair comparison above only by luck.
        const [drive, tail] = port.splitdrive(input);
        expect(drive + tail).toBe(input);
      }
    });

    test("join", () => {
      for (const [index, args] of corpus.joins.entries()) {
        const [first, ...rest] = args as readonly string[];
        expect(port.join(first as string, ...rest), `join(${JSON.stringify(args)})`).toBe(
          expected.join[index],
        );
      }
    });
  });
}
