import { existsSync } from "node:fs";
import process from "node:process";

import { describe, expect, test } from "vitest";

import { caseRoot, databasePath, sidecars, writeStep } from "./cases.js";
import { chdirForTest } from "./cwd.js";
import { expectRefusal, expectSqliteError } from "./errors.js";
import { recordingSink } from "./logsink.js";
import { skipIf, xfail } from "./marks.js";
import { parametrize, product } from "./parametrize.js";
import { patchSeam, patchSeams } from "./seams.js";

/**
 * The testkit's own contract.
 *
 * **These are target-only tests.** They translate no source case, they are not
 * counted in the parity ledger, and they must never be read as ported coverage.
 * They exist because the testkit is frozen when this pilot merges: a helper
 * whose semantics are assumed rather than pinned is a helper the next belt will
 * change by accident, and the tests it supports would go quietly wrong rather
 * than red.
 *
 * Three of the eight dangerous translation patterns -- non-strict/strict
 * `xfail`, `skip` semantics, and a `caplog`-equivalent sink -- have **no source
 * case anywhere in the subsystem this pilot ports**. Their mapping rules are
 * written down in `docs/test-translation-conventions.md`, and this file is
 * where each rule gets its one worked example. Inventing a source case to
 * translate would have put a node id in the ledger that does not exist in
 * interlock, which is a worse outcome than a documented gap.
 */

describe("seam patching reproduces monkeypatch.setattr", () => {
  // The record under test is a stand-in for a module's seam record. It is
  // module-level so that a leak across tests would be visible: every test here
  // asserts it is back to its original value on entry.
  const seams = { tunable: 5_000, fn: () => "original" };

  test("a patch is undone when the test finishes", () => {
    expect(seams.tunable).toBe(5_000);
    patchSeam(seams, "tunable", 250);
    expect(seams.tunable).toBe(250);
  });

  test("the previous test's patch did not survive", () => {
    expect(seams.tunable).toBe(5_000);
  });

  test("re-patching the same key restores the value from before the FIRST patch", () => {
    // This is the shape the verify-reopen-gap cases use: a wrapper is installed,
    // and the wrapper re-patches the key from inside itself to disarm after one
    // call. pytest's monkeypatch records the value present at each setattr and
    // undoes them in reverse, so the original is what survives. A helper that
    // snapshotted only once, or restored in registration order, would leave the
    // wrapper installed for every later test in the file.
    const original = seams.fn;
    patchSeam(seams, "fn", () => {
      patchSeam(seams, "fn", original);
      return "wrapper";
    });
    expect(seams.fn()).toBe("wrapper");
    expect(seams.fn()).toBe("original");
  });

  test("the re-patched key is also fully restored", () => {
    expect(seams.fn()).toBe("original");
  });

  test("patchSeams applies a group and undoes the whole group", () => {
    patchSeams(seams, { tunable: 1, fn: () => "grouped" });
    expect(seams.tunable).toBe(1);
    expect(seams.fn()).toBe("grouped");
  });

  test("the group did not survive either", () => {
    expect(seams.tunable).toBe(5_000);
    expect(seams.fn()).toBe("original");
  });
});

describe("temp directories are per test, not per file", () => {
  const seen = new Set<string>();

  test("first case gets its own root", () => {
    const root = caseRoot("contract");
    expect(seen.has(root)).toBe(false);
    seen.add(root);
    expect(existsSync(root)).toBe(true);
    // The database path is a name, not a file: the cases that assert nothing
    // was created depend on this.
    expect(existsSync(databasePath(root))).toBe(false);
  });

  test("second case gets a different root", () => {
    const root = caseRoot("contract");
    expect(seen.has(root)).toBe(false);
  });

  test("sidecars lists journal files beside a database and nothing else", () => {
    const root = caseRoot("sidecar");
    const db = databasePath(root);
    writeStep(root, "production.sqlite3", "");
    expect(sidecars(db)).toEqual([]);
    writeStep(root, "production.sqlite3-journal", "");
    // A file whose name merely starts the same way is not a sidecar of it.
    writeStep(root, "production.sqlite3x", "");
    expect(sidecars(db).map((path) => path.endsWith("-journal"))).toEqual([true]);
  });
});

describe("chdir is restored", () => {
  const before = process.cwd();

  test("the working directory changes inside the test", () => {
    const root = caseRoot("cwd");
    chdirForTest(root);
    // Compared by realpath-insensitive suffix: macOS resolves the temp
    // directory through /private, so an equality assertion on the raw string
    // fails there for a reason that has nothing to do with the helper.
    expect(process.cwd().endsWith(root.split(/[\\/]/).pop() as string)).toBe(true);
  });

  test("and is back afterwards", () => {
    expect(process.cwd()).toBe(before);
  });
});

describe("expectRefusal keeps both halves of pytest.raises", () => {
  class Base extends Error {}
  class Specific extends Base {}
  class Sibling extends Base {}

  test("passes when the class and the message both match", () => {
    const error = expectRefusal(
      () => {
        throw new Specific("the ledger is not contiguous");
      },
      Specific,
      /not contiguous/,
    );
    expect(error).toBeInstanceOf(Specific);
  });

  test("a subclass satisfies an assertion on its base, as isinstance does", () => {
    expectRefusal(() => {
      throw new Specific("boom");
    }, Base);
  });

  test("the class half really is checked -- a sibling with the right message fails", () => {
    // The point of the helper. `expect(fn).toThrow(/boom/)` is green here, and
    // that is the silent fidelity loss it exists to prevent.
    expect(() =>
      expectRefusal(
        () => {
          throw new Sibling("boom");
        },
        Specific,
        /boom/,
      ),
    ).toThrow();
  });

  test("a test that throws nothing at all is a failure, not a pass", () => {
    expect(() => expectRefusal(() => undefined, Specific)).toThrow();
  });

  test("match is a search, not a full match, as pytest's is", () => {
    expectRefusal(
      () => {
        throw new Specific("prefix and then the interesting part and a suffix");
      },
      Specific,
      /the interesting part/,
    );
  });

  test("expectSqliteError asserts the result code, not the message text", () => {
    const error = Object.assign(new Error("no such table: nope"), { code: "SQLITE_ERROR" });
    expectSqliteError(
      () => {
        throw error;
      },
      { code: "SQLITE_ERROR" },
    );
    expect(() =>
      expectSqliteError(
        () => {
          throw error;
        },
        { code: "SQLITE_BUSY" },
      ),
    ).toThrow();
  });
});

describe("parametrize reproduces pytest node ids", () => {
  parametrize(
    "an explicit id becomes the bracket suffix",
    [
      ["0002-fix.sql", "0002-fix.sql"],
      ["two_fix.sql", "two_fix.sql"],
    ],
    (value) => {
      expect(typeof value).toBe("string");
    },
  );

  test("the cartesian product joins ids the way stacked decorators do", () => {
    const rows = product(
      [
        ["outer1", "a"],
        ["outer2", "b"],
      ],
      [
        ["inner1", 1],
        ["inner2", 2],
      ],
    );
    // Measured against pytest 9.1.1, not reasoned about: the id puts the
    // decorator closest to the function FIRST, while the axis that varies
    // FASTEST is the outer one. The two pull in opposite directions, so this
    // is the assertion that keeps the helper honest.
    expect(rows.map(([id]) => id)).toEqual([
      "inner1-outer1",
      "inner1-outer2",
      "inner2-outer1",
      "inner2-outer2",
    ]);
    expect(rows.map(([, value]) => value)).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
      ["b", 2],
    ]);
  });
});

describe("skip and xfail mappings (target-only: no source case exists)", () => {
  let skippedBodyRan = false;

  // The condition is evaluated here, at declaration time, which is pytest's
  // collection time -- not inside the body.
  skipIf(true, "the condition is true, so this must not run")(
    "a skipped test's body does not execute",
    () => {
      skippedBodyRan = true;
    },
  );

  test("the skipped body really did not run", () => {
    expect(skippedBodyRan).toBe(false);
  });

  skipIf(false, "not applicable")("a non-skipped test still runs normally", () => {
    expect(true).toBe(true);
  });

  xfail({ strict: true, reason: "pinned as strictly expected to fail" })(
    "a strict xfail maps to test.fails",
    () => {
      expect(1).toBe(2);
    },
  );

  xfail({ strict: false, reason: "tolerated either way" })(
    "a non-strict xfail stays green when the body fails",
    () => {
      expect(1).toBe(2);
    },
  );

  xfail({ strict: false, reason: "tolerated either way" })(
    "a non-strict xfail also stays green when the body unexpectedly passes",
    () => {
      // pytest reports XPASS here and does not fail the run. `test.fails` would
      // fail it, which is why the two strictness levels get different mappings.
      expect(1).toBe(1);
    },
  );
});

describe("the log sink captures records, not rendered text", () => {
  test("level, logger and order all survive", () => {
    const sink = recordingSink();
    sink.emit({ level: "info", logger: "control_plane.migrator", message: "started" });
    sink.emit({ level: "error", logger: "control_plane.migrator", message: "refused" });

    expect(sink.records.map((record) => record.level)).toEqual(["info", "error"]);
    expect(sink.at("error").map((record) => record.message)).toEqual(["refused"]);
    expect(sink.records[0]?.logger).toBe("control_plane.migrator");
    // The property a console spy cannot give: the level is a field, so an
    // assertion about severity does not depend on how the line is formatted.
    expect(sink.messages).toEqual(["started", "refused"]);
  });

  test("an attached error travels with its record", () => {
    const sink = recordingSink();
    const cause = new Error("underlying");
    sink.emit({ level: "error", logger: "x", message: "wrapped", error: cause });
    expect(sink.at("error")[0]?.error).toBe(cause);
  });
});
