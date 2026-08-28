/**
 * The command's three mechanisms, each tested where it could actually break.
 *
 * Ported from interlock `tests/measurement/test_measurement_cli.py` at
 * `65f36c5`. Every case here maps to one source node id; the mapping, the
 * systematic translations and the deliberate divergences are recorded in
 * `parity/measurement.cli.ledger.json`.
 *
 * **It cannot acquire a writable handle.** Asserting that would be easy to fake
 * -- a test that replaced `openForMeasurement` and asserted it was called proves
 * only that one code path used it, and says nothing about the error path, the
 * fixture loader, or a future edit that opens a second connection to "just check
 * something". So "the command opens no writable connection" replaces the
 * **driver module** for the whole file and asserts that *every* database the
 * process opened under the command was opened with the read-only flag. It is an
 * assertion about the call path, and a writable handle opened anywhere under the
 * command fails it no matter who opened it.
 *
 * **It reads the clock once.** The clock seam is replaced by a counter, and the
 * count is asserted: exactly one read without `--now-ms`, and **zero** with it.
 * A module that read a clock below the boundary would still produce a plausible
 * report -- with the cohort selected at one instant and the header stamped at
 * another -- and only the count catches that.
 *
 * **Its help text survives a cp932 console.** Two cases, because the two ways
 * this breaks are different: every help string is checked in-process (which
 * catches the string), and `--help` is run in a real subprocess whose bytes are
 * checked (which catches the *stream*). Both are adapted: Node has no cp932
 * **encoder** to check a string against, and no `PYTHONIOENCODING` to make a
 * child's stdout cp932. `D-0113` records what the port asserts instead and why
 * ASCII is the property that carries the source's intent here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { helpStrings } from "../../src/cli/parser.js";
import * as topLevelCli from "../../src/cli.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import * as measurementCli from "../../src/measurement/cli.js";
import { FINGERPRINT_AGGREGATE } from "../../src/measurement/provenance.js";
import { ControlPlaneRefusal } from "../../src/measurement/reader.js";
import { cell } from "../../src/measurement/render.js";
import { WindowRefusal } from "../../src/measurement/windows.js";
import { caseRoot, rawConnection, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";
import {
  isAscii,
  parseMarkdown,
  parseReportJson,
  REPORT_CLOCK,
  VERDICT_WORDS,
  walkJson,
} from "./report-reading.js";

const { GENERATED_AT, PERIOD_END, PERIOD_START, T0 } = REPORT_CLOCK;

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/**
 * Every database this process opens, recorded at the driver.
 *
 * The port of the source's `monkeypatch.setattr(sqlite3, "connect", ...)`. ESM
 * bindings cannot be rebound from outside the module that holds them, so the
 * interception is at the module boundary instead: `vi.mock` replaces the driver
 * for **every** importer in this file's module graph, which is the property the
 * source case depends on -- it is not asking whether `openForMeasurement` was
 * called, it is asking what the process did.
 *
 * `vi.hoisted` because the mock factory is hoisted above the imports and would
 * otherwise close over a binding that does not exist yet.
 */
const driver = vi.hoisted(() => ({
  opened: [] as { readonly path: unknown; readonly options: unknown }[],
}));

vi.mock("better-sqlite3", async (importOriginal) => {
  // The CJS driver reaches ESM as a namespace whose `default` is the
  // constructor; the published types describe the constructor itself, so the
  // namespace shape is spelled out here rather than borrowed from them.
  const actual = (await importOriginal()) as {
    readonly default: typeof Database;
    readonly [key: string]: unknown;
  };
  const Actual = actual.default;
  // A subclass rather than a wrapper function, so `instanceof` and every
  // property of the real driver survive the recording. The real constructor
  // still runs: this records what was opened, it does not change it.
  class Recording extends Actual {
    constructor(path: string, options?: Database.Options) {
      super(path, options);
      driver.opened.push({ path, options });
    }
  }
  return { ...actual, default: Recording };
});

afterEach(() => {
  driver.opened.length = 0;
});

const productionTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/**
 * The source's `db` fixture: a migrated production control plane holding one
 * completed run inside the report period.
 */
function db(label = "cli"): string {
  const path = productionTemplate.copyInto(caseRoot(label));
  const cp = rawConnection(path);
  cp.pragma("foreign_keys = ON");
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES ('run-1', 'completed', ?, ?)",
  ).run(PERIOD_START + 1_000, PERIOD_START + 2_000);
  cp.close();
  return path;
}

function argvFor(path: string, ...extra: string[]): string[] {
  return [
    "report",
    "--db",
    path,
    "--period-start-ms",
    String(PERIOD_START),
    "--period-end-ms",
    String(PERIOD_END),
    "--now-ms",
    String(GENERATED_AT),
    ...extra,
  ];
}

/**
 * `capsys`: run the command and return what it wrote.
 *
 * The write seam is replaced rather than `process.stdout` intercepted, because
 * the seam is what the module actually writes through and a test that spied on
 * the stream would keep passing if a later edit wrote somewhere else.
 */
function captured(action: () => number): { readonly code: number; readonly out: string } {
  const chunks: string[] = [];
  patchSeam(measurementCli.cliSeams, "write", (text: string) => {
    chunks.push(text);
  });
  const code = action();
  return { code, out: chunks.join("") };
}

/**
 * `capsys` over the TOP-LEVEL parser's own output.
 *
 * A second capture, because after `D-0030` there is a second seam: the unified
 * CLI writes what the top-level parser itself prints -- `--help`, `--version`,
 * a refusal -- through its own record rather than through the measurement
 * module's, which is what it did while `measure` was the only thing mounted.
 * A mounted command still writes its report through `measurementCli.cliSeams`,
 * so a case that reads a report keeps using {@link captured}; both seams are
 * replaced here so that either one is visible whichever wrote.
 */
function capturedTop(action: () => number): { readonly code: number; readonly out: string } {
  const chunks: string[] = [];
  patchSeam(topLevelCli.cliSeams, "out", (text: string) => {
    chunks.push(text);
  });
  patchSeam(measurementCli.cliSeams, "write", (text: string) => {
    chunks.push(text);
  });
  const code = action();
  return { code, out: chunks.join("") };
}

// --------------------------------------------------------------------------
// end to end
// --------------------------------------------------------------------------

describe("end to end", () => {
  test("the subcommand runs end to end and renders Markdown", () => {
    const path = db();

    const { code, out } = captured(() => measurementCli.main(argvFor(path)));

    expect(code).toBe(0);
    const facts = parseMarkdown(out);
    // Through `cell`, not against the raw path. `D-0109` escapes every value
    // this report prints, and a Windows path is made of backslashes, so the
    // report carries `C:\\Users\\...` where the raw string has one backslash
    // each. The raw comparison passed on Linux -- where a temp path has nothing
    // to escape -- and failed on both Windows cells. `cell` is the renderer's
    // own spelling of a value, so this asks what the report prints rather than
    // restating the escaping rule here.
    expect(facts.get("header.db_path")).toBe(cell(path));
    expect(facts.get("header.period_start_ms")).toBe(String(PERIOD_START));
    expect(facts.get("header.generated_at_ms")).toBe(String(GENERATED_AT));
    expect(facts.get("sections.ac9.facts.cohort.denominator")).toBe("1");
  });

  test("the JSON rendering carries the same facts from the command", () => {
    // The two renderings of one command invocation, compared to each other.
    const path = db();

    const fromMarkdown = parseMarkdown(captured(() => measurementCli.main(argvFor(path))).out);
    const fromJson = walkJson(
      parseReportJson(captured(() => measurementCli.main(argvFor(path, "--format", "json"))).out),
    );

    expect(fromMarkdown).toEqual(fromJson);
  });

  test("the command is mounted on the top-level CLI", () => {
    const path = db();

    const { code, out } = captured(() => topLevelCli.main(["measure", ...argvFor(path)]));

    expect(code).toBe(0);
    expect(out).toContain("interlock-measurement-report");
  });

  test("the command emits no verdict", () => {
    const path = db();

    const { out } = captured(() => measurementCli.main(argvFor(path)));

    const found = [...out.matchAll(VERDICT_WORDS)].map((match) => match[0]);
    expect(found, `verdict vocabulary on stdout: ${[...new Set(found)].sort().join(", ")}`).toEqual(
      [],
    );
  });

  test("aggregate mode is stamped weaker on the command output", () => {
    const path = db();

    const weaker = captured(() =>
      measurementCli.main(argvFor(path, "--fingerprint", FINGERPRINT_AGGREGATE)),
    ).out;
    expect(weaker).toContain("does NOT establish identity of content");

    const content = captured(() => measurementCli.main(argvFor(path))).out;
    expect(content).not.toContain("does NOT establish identity of content");
  });
});

// --------------------------------------------------------------------------
// read-only by capability, asserted on the call path
// --------------------------------------------------------------------------

describe("read-only by capability", () => {
  test("the command opens no writable connection", () => {
    const path = db();
    // Cleared after the fixture and before the command, exactly where the
    // source installs its recorder: the fixture's own writable connection is
    // what puts the run in the database, and it is not the subject.
    driver.opened.length = 0;

    captured(() => measurementCli.main(argvFor(path)));

    expect(driver.opened.length, "the command opened no database at all").toBeGreaterThan(0);
    for (const { path: opened, options } of driver.opened) {
      // ADAPTED. The source asserts a `file:...?mode=ro` URI opened with
      // `uri=True`; better-sqlite3 does not accept URI filenames, so continuo's
      // first read-only mechanism is the driver's own open flag (`D-0100`).
      // The claim is unchanged -- every handle this process opened is one that
      // cannot write -- and it is asserted on the same call path.
      expect(options, `${String(opened)} was opened writable`).toMatchObject({ readonly: true });
    }
  });

  test("the command module imports no other opener", () => {
    // Belt to the previous case's braces: the recorder proves no writable handle
    // was opened on the path a passing run takes, and this proves the module
    // holds no opener that an error path or a later edit could reach.
    //
    // ADAPTED. The source asks the imported module object
    // (`not hasattr(measurement_cli, "sqlite3")`, then
    // `open_for_measurement.__module__`); an ES module object exposes only what
    // it exports, so neither question can be put to it at runtime. The same two
    // questions are put to the module's **text** instead, which is where an
    // import lives in this language.
    const source = readModule("src/measurement/cli.ts");
    const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map(
      (match) => match[1] as string,
    );

    expect(imports).toContain("./reader.js");
    for (const specifier of imports) {
      expect(
        OPENERS.some((opener) => specifier.includes(opener)),
        `${specifier} is an opener, and this module imports exactly one`,
      ).toBe(false);
    }
    expect(source).not.toMatch(/new Database\b/);
  });

  test("a database the reader refuses is not reported over", () => {
    const absent = join(caseRoot("absent"), "nothing.sqlite3");

    expectRefusal(() => measurementCli.main(argvFor(absent)), ControlPlaneRefusal);
  });
});

/**
 * Every module in this package that can hand back a handle capable of writing.
 *
 * Named rather than pattern-matched, so a module added to this list is a
 * deliberate edit by someone who read the case above it. `./reader.js` is
 * absent because it is the one opener this command is allowed to reach.
 */
const OPENERS: readonly string[] = [
  "better-sqlite3",
  "sqlite/open.js",
  "control_plane/connection.js",
  "control_plane/migrator.js",
  "./connection.js",
  "./migrator.js",
];

function readModule(relative: string): string {
  const path = join(REPO_ROOT, relative);
  expect(existsSync(path), `${relative} is not where this case expects it`).toBe(true);
  return readFileSync(path, "utf8");
}

// --------------------------------------------------------------------------
// the clock is read once, at the boundary
// --------------------------------------------------------------------------

describe("the clock is read once, at the boundary", () => {
  test("the clock is read exactly once when it is not given", () => {
    const path = db();
    const reads: number[] = [];
    patchSeam(measurementCli.cliSeams, "nowMs", () => {
      reads.push(1);
      return PERIOD_END + 5_000;
    });

    const { out } = captured(() =>
      measurementCli.main([
        "report",
        "--db",
        path,
        "--period-start-ms",
        String(PERIOD_START),
        "--period-end-ms",
        String(PERIOD_END),
      ]),
    );

    const facts = parseMarkdown(out);
    expect(reads.length).toBe(1);
    expect(facts.get("header.generated_at_ms")).toBe(String(PERIOD_END + 5_000));
  });

  test("the clock is not read at all when it is given", () => {
    const path = db();
    patchSeam(measurementCli.cliSeams, "nowMs", () => {
      throw new Error("the command read the system clock even though --now-ms named one");
    });

    const { out } = captured(() => measurementCli.main(argvFor(path)));

    expect(out).not.toBe("");
  });

  parametrize<unknown>(
    "a clock that is not epoch milliseconds is refused",
    [
      ["true", true],
      ["1.5", 1.5],
      ['"1700000000000"', "1700000000000"],
    ],
    (value) => {
      // `True` is an `int` in Python and would be the instant
      // 1970-01-01T00:00:00.001Z, which is why the source lists it first. The
      // port's `number` closes `true` and `"..."` at the type level and opens
      // `1.5`, `NaN` and `Infinity` that Python's `int` closed (rule 9), so the
      // guard has to hold both halves and the case reaches it through the same
      // `unknown` a runtime caller would.
      const path = db();
      const args = {
        db: path,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        graceMs: null,
        fingerprint: "content",
        fixtureCorpus: null,
        fixtureCommit: null,
        v1ShadowRunIds: null,
      } as unknown as measurementCli.ReportArgs;

      expectRefusal(
        () => measurementCli.buildReportFromArgs(args, { nowMs: value as number }),
        TypeError,
      );
    },
  );
});

// --------------------------------------------------------------------------
// the per-report declarations
// --------------------------------------------------------------------------

describe("the per-report declarations", () => {
  test("a shadow input file is read and named", () => {
    const path = db();
    const shadow = writeShadow(JSON.stringify(["run-9"]));

    const { out } = captured(() =>
      measurementCli.main(argvFor(path, "--v1-shadow-run-ids", shadow)),
    );

    const facts = parseMarkdown(out);
    expect(facts.get("sections.inputs.facts.v1_shadow.source")).toBe(cell(shadow));
    expect(facts.get("sections.inputs.facts.v1_shadow.run_ids")).toBe("run-9");
    expect(facts.get("header.coverage.excluded.v1_owned")).toBe("1");
  });

  test("the object shape of the shadow file is accepted", () => {
    const path = db();
    const shadow = writeShadow(JSON.stringify({ run_ids: ["run-9"] }));

    const { out } = captured(() =>
      measurementCli.main(argvFor(path, "--v1-shadow-run-ids", shadow)),
    );

    expect(parseMarkdown(out).get("sections.inputs.facts.v1_shadow.run_ids")).toBe("run-9");
  });

  parametrize<string>(
    "an unreadable shadow file refuses rather than becoming an empty input",
    [
      ["{}", "{}"],
      ["[1, 2]", "[1, 2]"],
      ['"run-9"', '"run-9"'],
    ],
    (payload) => {
      // The flattering answer here arrives as absent data, so it is refused.
      const path = db();
      const shadow = writeShadow(payload);

      expectRefusal(
        () => measurementCli.main(argvFor(path, "--v1-shadow-run-ids", shadow)),
        ControlPlaneRefusal,
      );
    },
  );

  test("a corpus without its commit is refused", () => {
    const path = db();

    expectRefusal(
      () => measurementCli.main(argvFor(path, "--fixture-corpus", join(caseRoot("c"), "corpus"))),
      ControlPlaneRefusal,
    );
    expectRefusal(
      () => measurementCli.main(argvFor(path, "--fixture-commit", "c0ffee")),
      ControlPlaneRefusal,
    );
  });

  test("the shipped corpus reaches the header", () => {
    const path = db();
    const corpus = join(REPO_ROOT, "test", "fixtures", "labelled");

    const { out } = captured(() =>
      measurementCli.main(argvFor(path, "--fixture-corpus", corpus, "--fixture-commit", "c0ffee")),
    );

    const facts = parseMarkdown(out);
    expect(facts.get("header.fixture_suite_ref.commit")).toBe("c0ffee");
    expect(facts.get("header.fixture_suite_ref.positive")).not.toBe("(none)");
    expect(facts.get("header.fixture_suite_ref.negative")).not.toBe("(none)");
  });

  test("a declared grace reaches the report", () => {
    const path = db();

    const { out } = captured(() => measurementCli.main(argvFor(path, "--grace-ms", "4321")));

    const facts = parseMarkdown(out);
    expect(facts.get("sections.observation_window.facts.grace_ms")).toBe("4321");
    expect(facts.get("sections.observation_window.facts.grace_source")).toBe("declared");
  });

  test("a negative declared grace is refused by the command", () => {
    // --grace-ms -1 must not reach the report's provenance.
    //
    // `episodeWindow` refuses a negative grace because it shortens the detector
    // window below the budget it is held to. A report built with one would stamp
    // section 6 provenance for a configuration the window model itself rejects
    // -- and with no episodes classified (this branch classifies none) nothing
    // downstream would ever raise, so it renders clean. The refusal has to be
    // the window model's own type.
    const path = db();

    expectRefusal(() => measurementCli.main(argvFor(path, "--grace-ms", "-1")), WindowRefusal);
  });
});

function writeShadow(payload: string): string {
  const path = join(caseRoot("shadow"), "v1.json");
  writeFileSync(path, payload, { encoding: "utf8" });
  return path;
}

// --------------------------------------------------------------------------
// cp932
// --------------------------------------------------------------------------

describe("cp932", () => {
  test("every help string is ASCII", () => {
    // ADAPTED (`D-0113`). The source encodes each string to cp932 and also
    // asserts `str.isascii()`. Node has no cp932 encoder, and ASCII is a subset
    // of cp932, so the second of the source's two assertions is the one the port
    // makes and it implies the first.
    for (const text of helpStrings(measurementCli.buildParser())) {
      expect(isAscii(text), text).toBe(true);
    }
  });

  test("the help of the mounted subcommand is ASCII", () => {
    for (const text of helpStrings(topLevelCli.buildParser())) {
      // The measure subtree is what this belt added; the rest of the CLI is not
      // this case's to police, so only text from the tree this file mounts is
      // asserted on -- the same filter the source applies.
      if (
        text.includes("measure") ||
        text.includes("measurement") ||
        text.includes("fingerprint")
      ) {
        expect(isAscii(text), text).toBe(true);
      }
    }
  });

  test("help runs in a real console and writes only ASCII bytes", () => {
    // The stream, not the string. ADAPTED (`D-0113`): the source sets
    // `PYTHONIOENCODING=cp932` so the child's stdout raises on a character it
    // cannot encode; Node writes UTF-8 whatever the console is, so there is no
    // encoding to set and no exception to provoke. What is checked instead is
    // the bytes that actually left the process -- ASCII bytes are the same bytes
    // in cp932, so a `--help` that passes this renders identically on the
    // console the source case is about.
    const entry = join(REPO_ROOT, "dist", "cli.js");
    expect(
      existsSync(entry),
      "dist/cli.js is missing: this case drives the built CLI as a subprocess, " +
        "and `npm run pretest` is what builds it",
    ).toBe(true);

    const stdout = execFileSync(process.execPath, [entry, "measure", "report", "--help"], {
      encoding: "buffer",
    });

    expect(stdout.includes(Buffer.from("--fingerprint"))).toBe(true);
    const nonAscii = [...stdout].filter((byte) => byte > 0x7f);
    expect(nonAscii, `--help wrote ${nonAscii.length} non-ASCII byte(s)`).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// target-only -- the parser this port had to write (D-0112)
// --------------------------------------------------------------------------

describe("target-only -- the parser has no source to be underwritten by", () => {
  test("target-only -- the help walk reaches the mounted subcommand's own flags", () => {
    // Rule 10. The two cp932 cases above are a loop over `helpStrings`, and a
    // walk that returned nothing -- or that stopped at the top level -- makes
    // both of them vacuously green. This is the case that says the walk goes all
    // the way down, and it names a string only the innermost parser holds.
    const reachable = helpStrings(topLevelCli.buildParser());

    expect(reachable.some((text) => text.includes("database fingerprint mode"))).toBe(true);
    expect(reachable).toContain("continuo measure report");
  });

  test("target-only -- --help after a subcommand is the subcommand's help", () => {
    // A parser that scanned the whole argv for `--help` would answer
    // `measure report --help` with the top-level screen: the one screen that
    // does not list the flags the operator was asking about, and green under any
    // assertion that only checks the exit code.
    const { code, out } = capturedTop(() => topLevelCli.main(["measure", "report", "--help"]));

    expect(code).toBe(0);
    expect(out).toContain("--fingerprint");
    expect(out).toContain("usage: continuo measure report");
  });

  parametrize<string>(
    "target-only -- a millisecond flag that is not an integer is refused, not coerced",
    [
      ["1.5", "1.5"],
      ["0x10", "0x10"],
      ["empty", ""],
    ],
    (spelling) => {
      // `Number` is the mapping to reach for and it accepts all four: `1.5`
      // rounds nothing and stays fractional, `0x10` becomes 16, the empty string
      // becomes 0 -- a period boundary quietly at the epoch selects every run
      // ever recorded. Measured: with only the `Number.isSafeInteger` half of
      // the guard left, `0x10` and the empty string are both accepted.
      //
      // Surrounding whitespace is deliberately absent from this list. `int(" 12
      // ")` is 12 in Python, so `--period-start-ms " 12 "` is accepted by the
      // source's parser, and refusing it here would make the port stricter than
      // what it is a port of.
      const path = db();

      const refused = captureStderr(() =>
        measurementCli.main([
          "report",
          "--db",
          path,
          "--period-start-ms",
          spelling,
          "--period-end-ms",
          String(PERIOD_END),
        ]),
      );

      expect(refused.code).toBe(2);
      expect(refused.text).toContain(
        `argument --period-start-ms: invalid int value: '${spelling}'`,
      );
    },
  );

  test("target-only -- an integer flag accepts Python's underscore spelling", () => {
    // `int("1_700_000_000_000")` is 1700000000000, so the source's parser takes
    // this command line and a port that refused it would fail only for the
    // operator who spelled a long timestamp readably. The three malformed
    // placements Python refuses are refused here too, because accepting them
    // would be the divergence in the other direction.
    const path = db();

    const { code, out } = captured(() =>
      measurementCli.main([
        "report",
        "--db",
        path,
        "--period-start-ms",
        "1_700_000_000_000",
        "--period-end-ms",
        String(PERIOD_END),
        "--now-ms",
        String(GENERATED_AT),
      ]),
    );

    expect(code).toBe(0);
    expect(parseMarkdown(out).get("header.period_start_ms")).toBe(String(PERIOD_START));

    for (const malformed of ["_1", "1_", "1__0"]) {
      const refused = captureStderr(() =>
        measurementCli.main([
          "report",
          "--db",
          path,
          "--period-start-ms",
          malformed,
          "--period-end-ms",
          String(PERIOD_END),
        ]),
      );
      expect(refused.code, malformed).toBe(2);
      expect(refused.text).toContain(
        `argument --period-start-ms: invalid int value: '${malformed}'`,
      );
    }
  });

  test("target-only -- a nested command's refusal names the nested command", () => {
    // `usage:` and the error line have to name the same parser. With the root's
    // `prog` on the error line, a refusal raised inside `measure report` prints
    // `usage: continuo measure report` above `continuo: error: ...`, which sends
    // the operator to read the flags of a command that has none of them.
    //
    // RE-POINTED by `D-0030`. This case used to drive `--bogus`, which the
    // purpose-built parser refused in the child. CPython does not: an
    // unrecognized token is an EXTRA, collected by whichever parser saw it and
    // reported by the ROOT (`unrecognized arguments: --bogus`, measured against
    // CPython 3.12.3 on this exact command tree, and pinned by the case below).
    // So the subject moves to a refusal argparse does raise in the child -- a
    // value-taking flag with nothing after it -- where the property this case
    // names is still live and still worth guarding.
    const path = db();

    const errors = captureStderr(() =>
      topLevelCli.main(["measure", "report", "--db", path, "--period-start-ms"]),
    );

    expect(errors.code).toBe(2);
    expect(errors.text).toContain("usage: continuo measure report");
    expect(errors.text).toContain("continuo measure report: error:");
    expect(errors.text).not.toContain("\ncontinuo: error:");
  });

  test("target-only -- an unrecognized argument is reported by the root, as CPython does", () => {
    // The other half of the re-pointing above, and the reason it was a
    // behaviour change rather than a wording change. argparse's subparser
    // action hands the tokens it could not place UP to the root, and the root
    // reports them under its own prog -- which is why an unknown option ahead
    // of a valid subcommand cannot be silently dropped. Measured against
    // CPython 3.12.3 on the replica of this command tree:
    // `continuo: error: unrecognized arguments: --bogus`, under
    // `usage: continuo`.
    //
    // The settings suite pins the same property from the other side (`an
    // unrecognized option after the subcommand is reported, not ignored`);
    // this one pins that the consolidated `measure` subtree answers the same
    // way, which before `D-0030` it did not.
    const path = db();

    const errors = captureStderr(() => topLevelCli.main(["measure", ...argvFor(path), "--bogus"]));

    expect(errors.code).toBe(2);
    expect(errors.text).toContain("continuo: error: unrecognized arguments: --bogus");
  });

  test("target-only -- an unreadable shadow file refuses rather than throwing raw", () => {
    // REPAIRED (`D-0023`). The source reads and parses the file bare, so a typo
    // in the path leaves a `FileNotFoundError` and a malformed file a
    // `JSONDecodeError` -- neither of them the refusal family the function
    // documents, and the missing file is the likeliest operator error there is.
    const path = db();

    const missing = expectRefusal(
      () =>
        measurementCli.main(
          argvFor(path, "--v1-shadow-run-ids", join(caseRoot("gone"), "v1.json")),
        ),
      ControlPlaneRefusal,
    );
    expect(missing.message).toContain("could not be read as the v1 shadow input");

    const malformed = expectRefusal(
      () => measurementCli.main(argvFor(path, "--v1-shadow-run-ids", writeShadow("{not json"))),
      ControlPlaneRefusal,
    );
    expect(malformed.message).toContain("could not be read as the v1 shadow input");
    expect(malformed.cause).toBeInstanceOf(SyntaxError);
  });

  test("target-only -- a flag may be written --flag=value", () => {
    // argparse accepts both spellings and they are the same command line, so a
    // port that took only one of them refuses command lines interlock runs.
    // Split at the FIRST `=`, because the value on the right of it may hold
    // more -- pinned here by a commit string that carries one, which a split at
    // the last `=` would truncate to `c0f`.
    const path = db();
    const corpus = join(REPO_ROOT, "test", "fixtures", "labelled");

    const { code, out } = captured(() =>
      measurementCli.main([
        "report",
        `--db=${path}`,
        `--period-start-ms=${PERIOD_START}`,
        `--period-end-ms=${PERIOD_END}`,
        `--now-ms=${GENERATED_AT}`,
        `--fixture-corpus=${corpus}`,
        "--fixture-commit=c0f=fee",
        "--format=markdown",
      ]),
    );

    expect(code).toBe(0);
    const facts = parseMarkdown(out);
    expect(facts.get("header.db_path")).toBe(cell(path));
    expect(facts.get("header.period_start_ms")).toBe(String(PERIOD_START));
    expect(facts.get("header.fixture_suite_ref.commit")).toBe("c0f=fee");
  });

  test.skipIf(process.platform === "win32")(
    "target-only -- the CLI runs when it is invoked through a bin symlink",
    () => {
      // How this command is actually started once it is installed: npm publishes
      // the `bin` as `node_modules/.bin/continuo`, a symlink, and Node sets
      // `process.argv[1]` to the link while resolving `import.meta.url` to the
      // real file. The entry-point guard compared the two unresolved, so through
      // the link it was false and the process exited 0 having run nothing and
      // printed nothing -- a CLI that is silent for every installed user and
      // correct for everyone who runs `node dist/cli.js`.
      //
      // Skipped on Windows because the hazard is not there: npm writes a `.cmd`
      // shim that invokes node with the real path, so argv[1] is already
      // resolved. Approved in parity/measurement.cli.ledger.json.
      const entry = join(REPO_ROOT, "dist", "cli.js");
      expect(existsSync(entry), "dist/cli.js is missing; `npm run pretest` builds it").toBe(true);
      const link = join(caseRoot("bin"), "continuo");
      symlinkSync(entry, link);

      const stdout = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });

      expect(stdout.trim()).toBe("@suisya-systems/continuo 0.0.0");
    },
  );

  test("target-only -- a flag cannot be swallowed as another flag's missing value", () => {
    // The failure this closes is not a rejected command line, it is an ACCEPTED
    // one: `--fixture-commit --format json` recorded `--format` as the commit
    // the labelled corpus came from and rendered in the default format, so the
    // operator got a plausible report whose provenance was false and whose
    // rendering was not the one they asked for. Nothing downstream can catch it
    // -- a commit is an opaque string and the default format is valid.
    const path = db();

    const refused = captureStderr(() =>
      measurementCli.main([...argvFor(path), "--fixture-commit", "--format", "json"]),
    );

    expect(refused.code).toBe(2);
    // argparse's own wording. It names the flag that went without a value and
    // not the token it declined to swallow, so there is deliberately no
    // assertion here that `--format` appears: the usage line lists every flag,
    // so `toContain("--format")` would pass against any refusal at all and
    // would be protecting nothing (rule 10).
    expect(refused.text).toContain("argument --fixture-commit: expected one argument");

    // ...and the escape hatch for a value that really does begin with a dash,
    // which is the one argparse offers too. The parser takes it, so what refuses
    // is the command, for the half-reference -- which is the proof that
    // `--format` arrived as the commit rather than as a flag.
    const inline = expectRefusal(
      () => measurementCli.main([...argvFor(path), "--fixture-commit=--format"]),
      ControlPlaneRefusal,
    );
    expect(inline.message).toContain("--fixture-corpus");
    expect(inline.message).not.toContain("expects a value");
  });

  test("target-only -- a negative number is still a value, not a flag", () => {
    // The exception argparse makes, and the one this CLI depends on: the ported
    // case `a negative declared grace is refused by the command` runs
    // `--grace-ms -1`, and it has to reach the window model's refusal rather
    // than being turned back by the parser -- which would leave that case green
    // for the wrong reason.
    const path = db();

    const refusal = expectRefusal(
      () => measurementCli.main(argvFor(path, "--grace-ms", "-1")),
      WindowRefusal,
    );

    expect(refusal.message).not.toContain("expects a value");
  });

  test("target-only -- a value handed to the version flag is refused, not ignored", () => {
    // argparse's own behaviour, and its own wording. Ignoring the value would
    // make `--version=json` print the version and exit 0, which reads to the
    // operator as though the value was understood.
    const refused = captureStderr(() => topLevelCli.main(["--version=x"]));

    expect(refused.code).toBe(2);
    expect(refused.text).toContain("argument --version: ignored explicit argument 'x'");
  });

  test("target-only -- a non-ASCII decimal digit is refused, not decoded", () => {
    // A DIVERGENCE, pinned so that it is deliberate rather than incidental
    // (`D-0112`). Python's `int()` accepts any Unicode decimal digit: a
    // full-width "12" is 12 there, and so is a Devanagari one. The value is an
    // epoch millisecond the report prints in its header, so decoding one would
    // produce a document the operator cannot reproduce from what they typed, and
    // decoding correctly needs a digit-value table whose failure mode is a
    // silently wrong number rather than an error.
    //
    // Written as escapes, not as characters: this repository's ASCII-output
    // contract forbids a non-ASCII byte in this file, which is the same policy
    // these digits are being refused under.
    const path = db();

    for (const spelling of ["\uFF11\uFF12", "\u0967\u0968", "1\uFF12"]) {
      const refused = captureStderr(() =>
        measurementCli.main([
          "report",
          "--db",
          path,
          "--period-start-ms",
          spelling,
          "--period-end-ms",
          String(PERIOD_END),
        ]),
      );
      expect(refused.code, spelling).toBe(2);
      expect(refused.text).toContain(
        `argument --period-start-ms: invalid int value: '${spelling}'`,
      );
      // The refusal says which rule it applied, so the divergence is legible on
      // the console rather than looking like the parity refusal CPython gives
      // for `1.5`. CPython accepts all three of these spellings.
      expect(refused.text, spelling).toContain("ASCII digits only");
    }
  });

  test.skipIf(process.platform === "win32")(
    "target-only -- a db path that needs escaping is printed escaped",
    () => {
      // This is the Windows failure, made visible on the machines the belt is
      // developed on. `D-0109` escapes every value the report prints, and a
      // Windows path is made of backslashes -- so `header.db_path` carries
      // `C:\\Users\\...` there while a Linux temp path has nothing to escape and
      // comes back byte for byte. Three cases compared against the raw path,
      // passed on every Linux cell, and failed on both Windows cells.
      //
      // A backslash is legal in a POSIX directory name and illegal on Windows,
      // so the reproduction runs only here -- which is the same asymmetry the
      // other way round, and the reason this case is skipped on the platform
      // whose paths it is about. Approved in the ledger.
      const root = join(caseRoot("escape"), "a\\b");
      const path = productionTemplate.copyInto(root);

      const { out } = captured(() =>
        measurementCli.main([
          "report",
          "--db",
          path,
          "--period-start-ms",
          String(PERIOD_START),
          "--period-end-ms",
          String(PERIOD_END),
          "--now-ms",
          String(GENERATED_AT),
        ]),
      );

      const printed = parseMarkdown(out).get("header.db_path");
      expect(printed).toBe(cell(path));
      // Both halves, because the equality above is satisfied by a `cell` that
      // escapes nothing -- which is exactly the state this case exists to
      // detect, and the state every Linux cell is in for an ordinary temp path.
      expect(cell(path), "the path under test escapes nothing").not.toBe(path);
      expect(printed).toContain("\\\\");
    },
  );

  test("target-only -- a required flag that is absent is refused by name", () => {
    const errors = captureStderr(() => measurementCli.main(["report", "--period-start-ms", "1"]));

    expect(errors.code).toBe(2);
    expect(errors.text).toContain("--db");
  });

  test("target-only -- a value outside a flag's choices is refused by name", () => {
    const path = db();

    const errors = captureStderr(() =>
      measurementCli.main(argvFor(path, "--fingerprint", "content-ish")),
    );

    expect(errors.code).toBe(2);
    expect(errors.text).toContain("invalid choice: 'content-ish'");
  });

  test("target-only -- a flag given twice is refused rather than silently last-wins", () => {
    const path = db();

    const errors = captureStderr(() =>
      measurementCli.main(argvFor(path, "--format", "json", "--format", "markdown")),
    );

    expect(errors.code).toBe(2);
    expect(errors.text).toContain("argument --format: given more than once");
  });

  test("target-only -- half a corpus reference is refused for being half", () => {
    // The ported case above is satisfied by the wrong refusal, and so is its
    // source: `--fixture-corpus` naming a directory that does not exist makes
    // `loadCorpus` refuse, and `FixtureRefusal` is a `ControlPlaneRefusal`, so
    // the case stays green with the half-reference guard deleted. Measured.
    //
    // This one hands over a corpus that loads, so nothing below the guard has a
    // reason to refuse, and it reads the message rather than the type -- the
    // refusal has to name the flag that is missing (rule 10: prefer the specific
    // outcome over the class, because the class is what a broken component
    // satisfies for free).
    const path = db();
    const corpus = join(REPO_ROOT, "test", "fixtures", "labelled");

    const noCommit = expectRefusal(
      () => measurementCli.main(argvFor(path, "--fixture-corpus", corpus)),
      ControlPlaneRefusal,
    );
    expect(noCommit.message).toContain("--fixture-commit");

    const noCorpus = expectRefusal(
      () => measurementCli.main(argvFor(path, "--fixture-commit", "c0ffee")),
      ControlPlaneRefusal,
    );
    expect(noCorpus.message).toContain("--fixture-corpus");
  });

  test("target-only -- the merged help screen keeps the choice list and the wrapping", () => {
    // Rule 11, on two defects `D-0030` found by merging rather than by a red
    // case. Both are about the ONE screen an operator reads to learn what a
    // flag takes, and neither was reachable from either lane's own suite.
    //
    // 1. argparse renders a `choices` action's metavar as `{a,b}` when no
    //    metavar is declared, and that is the only place `--help` says what the
    //    accepted values ARE. The transcription answered `dest.toUpperCase()`
    //    for every action; the settings flags all declare a metavar, so nothing
    //    there could see it, and the merge would have turned
    //    `--fingerprint {content,aggregate}` into `--fingerprint FINGERPRINT`.
    // 2. The transcription wrote every help string on one line. Its own are
    //    short; this module's are paragraphs, and `--db`'s alone is 450
    //    characters.
    const { code, out } = capturedTop(() => topLevelCli.main(["measure", "report", "--help"]));

    expect(code).toBe(0);
    expect(out).toContain("--fingerprint {content,aggregate}");
    expect(out).toContain("--format {markdown,json}");
    const tooWide = out.split("\n").filter((line) => line.length > 79);
    expect(tooWide, `${tooWide.length} help line(s) past 79 columns`).toEqual([]);
  });

  test("target-only -- the top-level CLI reports the build's version", () => {
    const { code, out } = capturedTop(() => topLevelCli.main(["--version"]));

    expect(code).toBe(0);
    expect(out.trim()).toBe("@suisya-systems/continuo 0.0.0");
  });
});

function captureStderr(action: () => number): { readonly code: number; readonly text: string } {
  const errors: string[] = [];
  patchSeam(measurementCli.cliSeams, "write", () => {
    throw new Error("a refused command line wrote to stdout");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  try {
    return { code: action(), text: errors.join("") };
  } finally {
    stderr.mockRestore();
  }
}
