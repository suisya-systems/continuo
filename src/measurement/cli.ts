/**
 * `continuo measure report` -- the harness's only entry point.
 *
 * Mounted into the top-level CLI by `src/cli.ts`. Ported from interlock
 * `src/claude_org_runtime/measurement/cli.py` at `65f36c5`; the case mapping and
 * every divergence are recorded in `parity/measurement.cli.ledger.json`.
 *
 * Four failures shape this module, and each one is closed by a mechanism rather
 * than by a rule an operator has to remember.
 *
 * **1. A report tool that writes.** `measurement-harness.md` section 1 records
 * where this comes from: v1's `tools/org_metrics_report.py` documents that the
 * ordinary connect helper applies `journal_mode=WAL` and "would happily run
 * forward migrations", both of which are writes -- so a report run against
 * production mutated production. This module therefore imports
 * {@link openForMeasurement} and **nothing else that opens a database**: it does
 * not import `better-sqlite3`, does not know the open flags, and has no path
 * that could ask for a writable handle. `ACCEPTANCE.md` section 3 condition 5
 * asks for read-only by capability, and a CLI that could construct a writable
 * connection has a convention instead.
 *
 * **2. A clock read below the boundary.** `time-base-policy.md` section 2 rule 2
 * puts the clock in the caller's hands. It is read **once**, in {@link run}, and
 * injected downwards; every function under it takes `nowMs`.  A second read
 * would put two instants in one report -- the cohort selected at one, the
 * provenance header stamped at another -- and the report would name neither.
 * {@link requireEpochMs} holds the same line `migrator`'s own guard holds,
 * because `--now-ms` reaches it from a string an operator typed.
 *
 * **3. A per-report declaration silently defaulted.** The grace value, the v1
 * shadow input, the labelled corpus and the fingerprint mode are declared per
 * report (sections 3.5, 3.3, 6). Each is an explicit argument here. Where one
 * can be derived -- grace from the policy revision's reconcile period -- the
 * derivation is stamped as its source in the report rather than presented as a
 * declaration, and where one cannot be derived, its absence is stated in words
 * that travel in the rendered output.
 *
 * **ASCII only.** Every string in this file, help text included, reaches
 * `--help` on a cp932 console. A single em-dash there is a crash on the console
 * this report is read from, and an in-process capture cannot see it, so the
 * suite asserts every help string is ASCII *and* runs `--help` in a real
 * subprocess.
 *
 * **4. A report over a database that moved while it was being read.** Every read
 * this command makes happens inside one snapshot, opened by
 * {@link buildMeasurementReport} (`measurement-harness.md` section 6): without
 * it the cohort, the AC-9 aggregation and the `db_fingerprint` would each see
 * their own state of the database, and the header would attest content the
 * figures never came from. **The operational cost is real and is stated in
 * `--help`**: the production databases here are not in WAL, so the report holds
 * a SQLite SHARED lock and every writer on the control plane -- watcher,
 * dispatcher, CI ingest -- blocks with "database is locked" until the report
 * finishes. Run a long period against a copy, or at a quiet moment.
 *
 * **No verdict.** `Q-0005` is open (section 7). This command prints measurements
 * and returns 0 when it produced a report; the exit code is "the report was
 * produced", never "the numbers were acceptable".
 */

import { readFileSync } from "node:fs";
import { addJsonArgument, jsonRequested } from "../cli/json_output.js";
import {
  ArgparseExit,
  type ArgparseStreams,
  ArgumentParser,
  dispatch,
  type Namespace,
  type Subparsers,
} from "../cli/parser.js";
import { loadCorpus } from "./fixtures.js";
import {
  FINGERPRINT_CONTENT,
  FINGERPRINT_MODES,
  FixtureSuiteRef,
  fixtureSuiteRef,
} from "./provenance.js";
import { ControlPlaneRefusal, openForMeasurement } from "./reader.js";
import {
  buildMeasurementReport,
  JSON_RENDERING,
  MARKDOWN,
  type MeasurementReport,
  RENDERINGS,
  render,
  V1ShadowInput,
} from "./render.js";

/**
 * Stated in the report when no labelled corpus was named.
 *
 * `FixtureSuiteRef` refuses an unexplained absence for the reason this sentence
 * exists: a missing corpus reference reads as a report that forgot to record
 * one.
 */
export const NO_CORPUS_REASON =
  "no labelled corpus was named on the command line (--fixture-corpus), and " +
  "this report measures no recall figure that one would qualify";

/**
 * Stated in the report when no v1 shadow input was named.
 *
 * `D-0013` leaves no v1-owned run in this database, so an empty `v1_owned`
 * bucket with no note is a claim about v1 that this database cannot support.
 */
export const NO_SHADOW_REASON =
  "no v1 shadow input was named on the command line (--v1-shadow-run-ids), so " +
  "the v1_owned exclusion bucket is empty for want of an input rather than " +
  "because v1 owned no run in this period";

// ASCII only: these reach --help on a cp932 console.
const DB_HELP =
  "path to the production control plane database. Opened read-only by " +
  "capability (the driver's read-only open flag plus PRAGMA query_only) and " +
  "never migrated. The report is read inside one held transaction so that its " +
  "figures and its fingerprint come from one state of the database; these " +
  "databases are not in WAL, so that transaction blocks every writer on the " +
  "control plane for as long as the report runs. Report a long period against " +
  "a copy.";
const PERIOD_START_HELP = "start of the report period, epoch milliseconds, inclusive.";
const PERIOD_END_HELP =
  "end of the report period, epoch milliseconds, exclusive. The period is " +
  "half-open [start, end).";
const NOW_HELP =
  "the clock, epoch milliseconds, stamped as generated_at_ms and used to " +
  "check the period has closed. Read once from the system clock when omitted; " +
  "nothing below this command reads a clock.";
const FINGERPRINT_HELP =
  "database fingerprint mode. 'content' (default) hashes the ordered rows of " +
  "every table read and establishes identity of content. 'aggregate' is the " +
  "weaker form: it hashes counts and maxima only, it does NOT establish " +
  "identity of content (an in-place UPDATE moves no count), and a report made " +
  "with it is stamped as such in both renderings.";
const GRACE_HELP =
  "observation-window grace in milliseconds, declared for this report. " +
  "Omitted, it is resolved from the policy revision in force as one reconcile " +
  "period and the report records that this is where it came from. A negative " +
  "value is refused: it shortens the observation window below the budget the " +
  "detector is held to.";
const SHADOW_HELP =
  "path to a JSON file holding the v1 shadow input: a list of v1-owned run " +
  "ids, or an object with a 'run_ids' list. Those runs are excluded from the " +
  "AC-9 cohort as v1_owned. Omitted, the report states that it had no shadow " +
  "input rather than reporting an empty bucket unexplained.";
const CORPUS_HELP =
  "path to the labelled fixture corpus root, recorded in the header as " +
  "fixture_suite_ref. Requires --fixture-commit.";
const COMMIT_HELP =
  "commit of the checkout the labelled corpus came from. Not derived: a " +
  "commit read from whatever tree this process runs in would name the wrong " +
  "cases.";
const FORMAT_HELP =
  "rendering to write. Both carry the same facts, including the section 6 " +
  "provenance header; 'markdown' also carries the human narrative as fenced " +
  "blocks and 'json' as string fields.";

/**
 * The two effects this module has on the world, as a replaceable record.
 *
 * Interlock's suite reaches `measurement_cli.time.time` with `monkeypatch` and
 * counts the reads; ESM bindings cannot be rebound from outside, so the clock is
 * reached through this record instead and the cases replace the entry. `write`
 * is here for the same reason `capsys` exists on the source side -- the ported
 * cases read what the command printed -- and keeping both on one record means
 * the module has exactly one place a reader has to check for an effect.
 *
 * Not re-exported from `src/index.ts`: a seam for the tests that own this
 * module, not public API.
 */
export const cliSeams = {
  /**
   * The only clock read in the harness, in epoch milliseconds.
   *
   * Interlock spells this `int(time.time() * 1000)`; `Date.now()` is already an
   * integer count of milliseconds, so the multiply and the truncation that
   * could disagree about a boundary are both gone rather than reproduced.
   */
  nowMs: (): number => Date.now(),
  /** Where a rendered report goes. */
  write: (text: string): void => {
    process.stdout.write(text);
  },
};

/**
 * Reject a clock value that is not an integer count of milliseconds.
 *
 * The same guard `migrator`'s `requireEpochMs` applies to a write, applied here
 * to a read for the same reason -- and for one more that is the port's own.
 * Python excludes `float` and `str` by type and has to exclude `bool` by hand,
 * because `bool` is an `int` there and `now_ms=True` is the instant 1 ms after
 * the epoch. TypeScript's `number` excludes `bool` and `str` at the type level
 * and admits `NaN`, `Infinity` and `1.5`, which Python's `int` does not (rule 9
 * of `docs/test-translation-conventions.md`). `Number.isInteger` is what closes
 * the three the port opened, and the `typeof` check is what closes the two the
 * type only closes for callers who type-check.
 */
function requireEpochMs(nowMs: number): void {
  if (typeof nowMs !== "number" || !Number.isInteger(nowMs)) {
    throw new TypeError(
      `nowMs must be an int of epoch milliseconds, got ${describeType(nowMs)}; ` +
        `the clock is read once at this boundary and injected, never read ` +
        `again below it`,
    );
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * The v1 run ids in `path`, as a list or under a `run_ids` key.
 *
 * Both shapes are accepted and neither is guessed at: anything else refuses,
 * because a file this function could not read as run ids would otherwise become
 * an empty shadow input, which is the flattering answer arriving as absent data.
 */
function readShadowRunIds(path: string): readonly string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // REPAIRED, not inherited (`D-0023`). The source reads and parses bare, so a
    // path with a typo in it leaves the command with a `FileNotFoundError` and a
    // malformed file with a `JSONDecodeError` -- neither of them the refusal
    // family this function documents two lines above, and the missing file is
    // the likeliest operator error there is. Only the read and the parse are
    // inside the try, so a refusal raised below still travels as itself.
    throw new ControlPlaneRefusal(
      `${path} could not be read as the v1 shadow input: ${describe(error)}`,
      { cause: error },
    );
  }
  if (isPlainObject(payload)) {
    // The key is this module's own literal, not a caller's, so the inherited-key
    // hazard rule 9 names for caller-keyed lookups does not arise; `Object.hasOwn`
    // is used anyway so that a document carrying no `run_ids` cannot be answered
    // by `Object.prototype`.
    payload = Object.hasOwn(payload, "run_ids") ? payload["run_ids"] : undefined;
  }
  if (!Array.isArray(payload) || !payload.every((item) => typeof item === "string")) {
    throw new ControlPlaneRefusal(
      `${path} does not hold the v1 shadow input: expected a JSON list of run ` +
        `id strings, or an object with a 'run_ids' list of them`,
    );
  }
  return payload as readonly string[];
}

/** An error's message, for interpolation into a refusal. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON object, told apart from the array and the null that share its `typeof`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The arguments this command reads, named as the parser leaves them. */
export interface ReportArgs extends Namespace {
  readonly db: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly nowMs?: number | null;
  readonly fingerprint?: string | null;
  readonly graceMs?: number | null;
  readonly v1ShadowRunIds?: string | null;
  readonly fixtureCorpus?: string | null;
  readonly fixtureCommit?: string | null;
  readonly format?: string | null;
  readonly json?: boolean;
}

function fixtureSuite(args: ReportArgs): FixtureSuiteRef {
  const corpus = args.fixtureCorpus ?? null;
  const commit = args.fixtureCommit ?? null;
  if (corpus === null && commit === null) {
    return FixtureSuiteRef.absent(NO_CORPUS_REASON);
  }
  if (corpus === null || commit === null) {
    // Half a reference is worse than none: a commit with no corpus names a tree
    // nothing was read from, and a corpus with no commit names cases nobody can
    // find again.
    throw new ControlPlaneRefusal(
      "--fixture-corpus and --fixture-commit are given together or not at " +
        "all; a corpus without its commit cannot be found again, and a commit " +
        "without a corpus names a tree this report read nothing from",
    );
  }
  return fixtureSuiteRef(loadCorpus(String(corpus)), { commit: String(commit) });
}

function shadowInput(args: ReportArgs): V1ShadowInput {
  const path = args.v1ShadowRunIds ?? null;
  if (path === null) {
    return V1ShadowInput.absent(NO_SHADOW_REASON);
  }
  const target = String(path);
  return V1ShadowInput.observed(target, readShadowRunIds(target));
}

/**
 * Open the database read-only, build the report, close the handle.
 *
 * `nowMs` is a required option and is never defaulted here: this function is
 * below the boundary, and the boundary is {@link run}.
 *
 * The read snapshot is not opened here: it belongs to
 * {@link buildMeasurementReport}, which holds it across every read including the
 * fingerprint. This function only opens and closes the handle, so there is no
 * ordering for a caller of this module to get wrong -- and no way to obtain the
 * pre-snapshot behaviour by forgetting something.
 *
 * The connection comes from {@link openForMeasurement} and from nowhere else.
 * That is the whole of condition 5's enforcement in this command: there is no
 * other opener imported, so there is no code path -- including an error path --
 * on which this process holds a handle that can write.
 */
export function buildReportFromArgs(
  args: ReportArgs,
  options: { readonly nowMs: number },
): MeasurementReport {
  requireEpochMs(options.nowMs);
  const connection = openForMeasurement(String(args.db));
  try {
    return buildMeasurementReport(connection, {
      dbPath: String(args.db),
      periodStartMs: args.periodStartMs,
      periodEndMs: args.periodEndMs,
      nowMs: options.nowMs,
      fixtureSuite: fixtureSuite(args),
      v1Shadow: shadowInput(args),
      graceMs: args.graceMs ?? undefined,
      fingerprintMode: args.fingerprint ?? FINGERPRINT_CONTENT,
    });
  } finally {
    connection.close();
  }
}

/**
 * Refuse a command line the way the parser refuses one: usage, then the reason.
 *
 * This is a check the parser cannot make for itself -- it is about two flags
 * agreeing, and the parser validates one flag at a time -- but it is still a
 * refusal of the COMMAND LINE rather than of the control plane, so an operator
 * who gets it should read the same three lines they get for `--format json
 * --format markdown`: the usage block, `<prog>: error: <reason>`, and status 2.
 * Reproducing those bytes here rather than routing them through a domain
 * refusal is what keeps the two kinds of mistake looking alike on the console.
 *
 * Written to `process.stderr` directly for the reason {@link defaultStreams}
 * gives for not putting stderr on the seam: a refusal is the parser's output,
 * the parser's stream is handed in at dispatch time and is no longer in reach
 * by the time a handler runs, and both entry points -- this module's `main` and
 * the top-level CLI's -- end their stderr at `process.stderr.write`, so the
 * bytes an operator sees are the same either way.
 *
 * `ArgparseExit` rather than `process.exit`, for `control_plane/cli.ts`'s
 * reason: the process boundary is `main`, and both of this command's `main`s
 * turn the exit into a status.
 */
function refuseCommandLine(parser: ArgumentParser, message: string): never {
  process.stderr.write(parser.usage());
  process.stderr.write(`${parser.prog}: error: ${message}\n`);
  throw new ArgparseExit(2, message);
}

/**
 * Which rendering to write, given `--format` and `--json`.
 *
 * **`--json` is a spelling of `--format json` and nothing more.** It exists
 * because a host driving this CLI as a subprocess asks every verb for machine
 * output with one flag, and having to remember that one verb of the fifteen spells
 * it differently is the whole of the cost this flag removes. What it
 * deliberately does NOT do is wrap the report in the `{"schema","ok","db"}`
 * envelope the other verbs answer in: the suite pins that the markdown and the
 * json rendering of one invocation carry identical facts, and an envelope would
 * put three facts in one rendering that the other cannot carry. The report's own
 * `report_kind` field already does the envelope's identifying job, and the
 * report's header already carries the database path.
 *
 * **A contradiction is refused rather than resolved.** `--json --format
 * markdown` asks for both renderings at once, and there is no reading of it
 * that is more likely than the other. Last-one-wins is exactly what
 * `addArguments` refuses for a repeated flag, and for the same reason: the
 * report that came out would carry no sign of which half of the command line
 * won. `--json --format json` is not a contradiction -- the two agree -- and is
 * accepted, because a host that always passes `--json` should not have to strip
 * it from a command line an operator already wrote.
 *
 * The `--format` flag deliberately declares no `defaultValue`, and this
 * function is why: with one, an absent `--format` and an explicit `--format
 * markdown` arrive in the namespace as the same string, so the contradiction
 * above would be undetectable and `--json` would have to silently override an
 * explicit choice. Absent, `--format` is `null` here and the default is applied
 * at this one point -- which is where {@link run} applied it before this flag
 * existed, so no rendering changes.
 */
function resolveRendering(parser: ArgumentParser, args: ReportArgs): string {
  const requested = args.format ?? null;
  if (!jsonRequested(args)) {
    return requested ?? MARKDOWN;
  }
  if (requested !== null && requested !== JSON_RENDERING) {
    refuseCommandLine(
      parser,
      `argument --json: another spelling of --format ${JSON_RENDERING}, so it ` +
        `contradicts --format ${requested}; give one of the two`,
    );
  }
  return JSON_RENDERING;
}

/**
 * The clock boundary: read it once here, inject it, render, write.
 *
 * Returns 0 when a report was produced. That is a statement about this process
 * and not about the numbers in the report -- `Q-0005` is open, and an exit code
 * that meant "acceptable" would answer it (module docstring).
 *
 * `parser` is taken so that a command line this handler refuses -- the one
 * disagreement between `--json` and `--format` that no single flag's validation
 * can see -- refuses with the parser's own usage block and prog. It is the
 * parser this handler was mounted on, bound in {@link addArguments}, so a
 * command run through the top-level CLI names `continuo measure report` and one
 * run through this module's own `main` names it too.
 */
export function run(args: ReportArgs, parser: ArgumentParser): number {
  // Before the clock is read and before the database is opened: a command line
  // that contradicts itself should cost nothing and hold no lock.
  const rendering = resolveRendering(parser, args);
  // The only clock read in the harness. Everything below takes it as an
  // argument, so a report cannot be stamped at one instant and selected at
  // another.
  const nowMs = args.nowMs ?? cliSeams.nowMs();
  const report = buildReportFromArgs(args, { nowMs });
  cliSeams.write(render(report, rendering));
  return 0;
}

/**
 * Mount the `report` flags. Every per-report declaration is explicit.
 *
 * `refuseRepeat` on every one of them is `D-0112`'s deliberate divergence from
 * argparse, carried through the consolidation rather than dropped: argparse
 * keeps the last value silently, and a report produced from
 * `--format json --format markdown` carries no sign of which half won. It is
 * declared per flag because the parser is otherwise measured against CPython
 * and the settings and sandbox surfaces must keep answering as CPython does.
 */
export function addArguments(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--db"],
    dest: "db",
    required: true,
    refuseRepeat: true,
    metavar: "DB",
    help: DB_HELP,
  });
  parser.addArgument({
    optionStrings: ["--period-start-ms"],
    dest: "periodStartMs",
    type: "int",
    required: true,
    refuseRepeat: true,
    metavar: "PERIOD_START_MS",
    help: PERIOD_START_HELP,
  });
  parser.addArgument({
    optionStrings: ["--period-end-ms"],
    dest: "periodEndMs",
    type: "int",
    required: true,
    refuseRepeat: true,
    metavar: "PERIOD_END_MS",
    help: PERIOD_END_HELP,
  });
  parser.addArgument({
    optionStrings: ["--now-ms"],
    dest: "nowMs",
    type: "int",
    refuseRepeat: true,
    metavar: "NOW_MS",
    help: NOW_HELP,
  });
  parser.addArgument({
    optionStrings: ["--fingerprint"],
    dest: "fingerprint",
    choices: FINGERPRINT_MODES,
    defaultValue: FINGERPRINT_CONTENT,
    refuseRepeat: true,
    help: FINGERPRINT_HELP,
  });
  parser.addArgument({
    optionStrings: ["--grace-ms"],
    dest: "graceMs",
    type: "int",
    refuseRepeat: true,
    metavar: "GRACE_MS",
    help: GRACE_HELP,
  });
  parser.addArgument({
    optionStrings: ["--v1-shadow-run-ids"],
    dest: "v1ShadowRunIds",
    refuseRepeat: true,
    metavar: "V1_SHADOW_RUN_IDS",
    help: SHADOW_HELP,
  });
  parser.addArgument({
    optionStrings: ["--fixture-corpus"],
    dest: "fixtureCorpus",
    refuseRepeat: true,
    metavar: "FIXTURE_CORPUS",
    help: CORPUS_HELP,
  });
  parser.addArgument({
    optionStrings: ["--fixture-commit"],
    dest: "fixtureCommit",
    refuseRepeat: true,
    metavar: "FIXTURE_COMMIT",
    help: COMMIT_HELP,
  });
  parser.addArgument({
    optionStrings: ["--format"],
    dest: "format",
    choices: RENDERINGS,
    // No `defaultValue`, deliberately: `markdown` is applied by
    // `resolveRendering` instead, so that an absent `--format` arrives here as
    // `null` and can be told apart from an explicit `--format markdown`. A
    // default declared here would make the two indistinguishable and would turn
    // the `--json --format markdown` contradiction into a silent override --
    // the failure `refuseRepeat` exists to prevent, arriving through a
    // different door. The rendering an operator gets for a command line that
    // names neither flag is unchanged.
    refuseRepeat: true,
    help: FORMAT_HELP,
  });
  // Mounted last so that the host-facing spelling reads after the flag it is a
  // spelling of, on the one help screen an operator learns both from.
  addJsonArgument(parser);
  parser.setDefaults({
    // Bound to THIS parser rather than passed as a bare reference, because the
    // handler refuses a self-contradicting command line with the parser's usage
    // and prog. @see run.
    func: ((values: Namespace): number => run(values as ReportArgs, parser)) as (
      values: Namespace,
    ) => number,
  });
}

/** Mount `report` under the caller's `measure` subcommand table. */
export function addSubparsers(sub: Subparsers): void {
  const reportParser = sub.addParser(
    "report",
    "Measure one report period against a production control plane and " +
      "render it. Read-only by capability; states measurements only.",
  );
  addArguments(reportParser);
}

/** The standalone parser, for driving this command without the top-level CLI. */
export function buildParser(): ArgumentParser {
  const parser = new ArgumentParser(
    "continuo measure",
    "Measurement harness for the continuo control plane " +
      "(docs/measurement-harness.md). Read-only by capability.",
  );
  addSubparsers(parser.addSubparsers("cmd"));
  return parser;
}

/**
 * `sys.stdout` / `sys.stderr` for this module's own parser.
 *
 * Both sides go through {@link cliSeams} rather than to `process.stdout`
 * directly, so that the ported cases read one stream whichever entry point they
 * drove -- the source's `capsys` sees both without being told which one wrote.
 * `stderr` is not on the seam because no ported case reads it as this module's
 * output; a refusal is the parser's, and the parser is handed the stream.
 */
function defaultStreams(): ArgparseStreams {
  return {
    stdout: (text: string): void => {
      cliSeams.write(text);
    },
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
  };
}

/**
 * Parse `argv` and run the named command.
 *
 * `dispatch` turns an exit raised by the PARSER into a status; this catch does
 * the same for one raised by the COMMAND, which is what
 * {@link refuseCommandLine} raises for a command line whose `--json` and
 * `--format` disagree. The top-level CLI's `main` already carries the identical
 * catch, for the identical reason -- Node has no top level that turns a
 * `SystemExit` into a status -- and without this one the same refusal would
 * reach an operator driving this module directly as an unhandled error with a
 * stack trace over the message it had just written. No refusal that exists
 * today reaches it: nothing under `run` raised `ArgparseExit` before this
 * change.
 */
export function main(argv: readonly string[]): number {
  try {
    return dispatch(buildParser(), argv, defaultStreams());
  } catch (error) {
    if (error instanceof ArgparseExit) {
      return error.code;
    }
    throw error;
  }
}
