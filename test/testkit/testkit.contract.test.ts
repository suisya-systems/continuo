import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

import { afterAll, describe, expect, test } from "vitest";

import { caseRoot, databasePath, sidecars, suiteRoot, suiteTemplate, writeStep } from "./cases.js";
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

// File top level, which is the only place these may be taken -- an afterAll
// registered inside a describe is undone when that block ends, not when the
// file does. `builds` lives here too, so a build that ran twice is visible from
// either test whichever order they run in.
let builds = 0;
const template = suiteTemplate("template.sqlite3", (path) => {
  builds += 1;
  writeFileSync(path, "migrated");
  // A sidecar beside the template. The control plane leaves none (D-0012), so
  // this is the case that pins the behaviour anyway: a template that DID leave
  // a WAL must not be copied without it.
  writeFileSync(`${path}-journal`, "journal");
});

describe("a suite template is built once and outlives the case that built it", () => {
  const copies: string[] = [];

  // Two symmetric cases. Under `sequence.shuffle.tests` either may run first,
  // so neither may assert anything that depends on being the one that ran
  // first; what the pair must show is asserted once, after both, in afterAll.
  for (const name of ["first", "second"]) {
    test(`the ${name} case gets a copy of the template`, () => {
      const copy = template.copyInto(caseRoot("suite-template"));
      copies.push(copy);

      expect(readFileSync(copy, "utf8")).toBe("migrated");
      // The copy is the case's own file: writing to it is safe, and is what
      // the next assertion checks did not reach the template.
      writeFileSync(copy, `touched by ${name}`);
      // Exactly one build has happened by the time any case has copied.
      expect(builds).toBe(1);
    });
  }

  afterAll(() => {
    // The property the pair exists to show, and the one a per-case root cannot
    // satisfy: both cases got a copy, from a single build, and the copies were
    // distinct files.
    expect(builds).toBe(1);
    expect(copies).toHaveLength(2);
    expect(new Set(copies).size).toBe(2);
  });

  test("sidecars beside the template travel with the copy, renamed to match", () => {
    const root = caseRoot("suite-template-sidecar");
    const copy = template.copyInto(root, "renamed.sqlite3");
    expect(basename(copy)).toBe("renamed.sqlite3");
    expect(sidecars(copy).map((path) => basename(path))).toEqual(["renamed.sqlite3-journal"]);
    expect(readFileSync(`${copy}-journal`, "utf8")).toBe("journal");
  });
});

describe("the same template in a caseRoot does not survive -- the failure this replaces", () => {
  /**
   * The negative control.
   *
   * A template built in a per-case root is exactly what was tried first, and it
   * fails on the *second* case: the first case's root is removed when that case
   * finishes, taking the template with it. Pinning it here means the helper
   * above is measured against a construction that is known to break, rather
   * than against nothing.
   */
  let built: string | undefined;
  const outcomes: string[] = [];

  function caseScopedTemplate(): string {
    if (built === undefined) {
      built = join(caseRoot("broken-template"), "template.sqlite3");
      writeFileSync(built, "migrated");
    }
    return built;
  }

  for (const name of ["first", "second"]) {
    test(`the ${name} case tries to copy a case-scoped template`, () => {
      const source = caseScopedTemplate();
      const target = join(caseRoot("broken-copy"), "production.sqlite3");
      try {
        copyFileSync(source, target);
        outcomes.push("copied");
      } catch (error) {
        // The reason matters, not just the failure: ENOENT on the template is
        // the symptom the 236 cases hit, and a different code here would mean
        // this control is pinning something else.
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
        outcomes.push("enoent");
      }
    });
  }

  afterAll(() => {
    // Whichever ran first copied; whichever ran second found the template gone.
    // Two "copied" would mean the per-case root stopped being per-case, and the
    // helper above would no longer be solving a real problem.
    expect([...outcomes].sort()).toEqual(["copied", "enoent"]);
  });
});

/** Taken at the file's top level, which is where the helper requires it. */
const collected = suiteRoot("collected");

/**
 * The same call from inside a `describe` body, which is a refusal.
 *
 * Taken here, during collection, because that is the only place the mistake can
 * actually be made; the message is asserted from a test above. Before the guard
 * existed this call succeeded and handed back a directory that was removed when
 * this block finished -- measured, then fixed.
 */
let describeScoped = "no refusal";
let unnamedDescribeScoped = "no refusal";

describe("named", () => {
  try {
    suiteRoot("in-describe");
  } catch (error) {
    describeScoped = (error as Error).message;
  }

  test("the attempt above refused, so this block has no suite directory", () => {
    expect(describeScoped).not.toBe("no refusal");
  });
});

describe("", () => {
  try {
    suiteRoot("in-unnamed-describe");
  } catch (error) {
    unnamedDescribeScoped = (error as Error).message;
  }

  test("an unnamed block refused as well", () => {
    expect(unnamedDescribeScoped).not.toBe("no refusal");
  });
});

describe("a suite-scoped directory must be taken at the top level of the file", () => {
  test("calling it from inside a running test fails, and says why", () => {
    // Vitest accepts an afterAll registered from inside a test and then never
    // runs it, so the directory would silently outlive the run. Measured, not
    // assumed -- and this is the assertion that keeps the guard in place.
    expectRefusal(() => suiteRoot("too-late"), Error, /must be called at collection time/);
  });

  test("calling it from inside a describe body fails too", () => {
    // The subtler half, and the one that reads as working: an afterAll
    // registered inside a describe is undone when that BLOCK ends, so the
    // directory is removed while a sibling block is still copying from it. The
    // call below is inside a test rather than inside a collecting describe, so
    // what it can pin is that the guard exists and names the block; the
    // lifetime itself is what `describeScoped` below measures.
    expect(describeScoped).toMatch(/was called inside describe\("named"\)/);
  });

  test("an unnamed describe is a describe too", () => {
    // Vitest leaves the FILE collector's name empty, and `describe("")` is
    // legal, so a guard that discriminated on the name would wave this one
    // through -- and it is the shape someone parametrising a block title writes
    // by accident. The guard tests for a parent collector instead.
    expect(unnamedDescribeScoped).toMatch(/was called inside an unnamed describe block/);
  });

  test("and at the top level it yields a directory that exists", () => {
    expect(existsSync(collected)).toBe(true);
  });
});
