/**
 * The suite entry point (`npm test`), and the one place that knows Windows
 * runs the child-process-spawning tests apart from everything else.
 *
 * Why this file exists at all
 * --------------------------
 * On `windows-latest` the `double-green` cell fails roughly one run in five,
 * and about two thirds of those failures are timeouts or budget overruns
 * rather than assertions (continuo #83). The measured signature is starvation:
 * a job that trips a watchdog is already running slower than the *median green
 * job* on the same cell. D-1003 named the mechanism -- several vitest workers
 * each spawning their own child processes on a small runner -- and skipped one
 * file as a stopgap. This is the general form of that fix: the files that
 * spawn children do not run alongside each other.
 *
 * Linux is left exactly as it was. `npm test` there still runs `vitest run`
 * with the arguments it was given and nothing else; the ubuntu cells fail
 * about 0.5% of the time and have no contention problem to solve.
 *
 * Why two passes rather than a `projects` split
 * ---------------------------------------------
 * `fileParallelism` is a root-level option in vitest 4 -- the per-project
 * `poolOptions.*.fileParallelism` is deprecated -- so a `projects` split cannot
 * give one project workers and the other a single worker. Two invocations of
 * the runner can, and they cost one extra vitest startup (about 1s) to do it.
 *
 * What this does NOT change
 * -------------------------
 * The double-green rule (D-0005) and the seed it is given: each pass reads
 * `CONTINUO_TEST_SEED` and shuffles under it exactly as a single run would, and
 * CI still calls this script twice per cell with two distinct seeds. No time
 * budget moves (D-0602's manifest is untouched), and no cell's required status
 * changes.
 *
 * The cost, measured
 * ------------------
 * Serialization buys contention relief with wall time, and the Windows cell is
 * the one with the least of it to spend (worst observed green job 1864s against
 * a 2400s `timeout-minutes` cap). Measured on Linux, whole suite minus the file
 * D-1003 already skips on Windows: 58.6s unchanged, 112.4s with the spawning
 * set at one worker (1.92x), 71.1s with it at two workers (1.21x). Those ratios
 * are an upper bound for Windows rather than a prediction -- part of what
 * serialization removes on Windows is the contention that makes each file slow
 * in the first place -- but they are the reason `CONTINUO_SPAWN_TEST_WORKERS`
 * exists: the choice between one worker and two is a measurement on the Windows
 * cell, not an opinion.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_ROOT = join(REPO_ROOT, "test");
const VITEST_ENTRY = join(REPO_ROOT, "node_modules/vitest/vitest.mjs");

/**
 * The test files that start child processes, and therefore the ones that run
 * one at a time on Windows.
 *
 * How this list was derived, so that it can be re-derived rather than argued
 * about: `ChildProcess.prototype.spawn` was wrapped in a setup file and the
 * whole suite run, which records every *asynchronous* spawn against the file
 * that caused it (89 files, 193 spawns); the synchronous entry points
 * (`spawnSync`, `execFileSync`, `execSync`) cannot be intercepted that way --
 * they take no shared object -- so those were taken from their call sites under
 * `test/`, including the ones reached through a helper (`gate_item11/registry.ts`,
 * `gate_item11/support/run.ts`, `fault_injection/conformance.ts`).
 *
 * Deliberately NOT in this list: the dozen structural checks that parse syntax
 * trees through `scripts/lib/ts-ast.mjs`. Those do spawn a child -- the
 * TypeScript 7 compiler is a separate program now -- but exactly one, long-lived
 * and shut down per file by `test/helpers/parser-lifecycle.ts`, so their
 * subprocess demand is already bounded by the worker count. Serializing them
 * would roughly double the serial pass to relieve contention they do not create.
 *
 * The count in the trailing comment is that file's measured async spawns;
 * `sync` marks a file whose children come from a synchronous entry point and so
 * do not appear in that count.
 */
const SPAWNING_TESTS = [
  "test/control_plane/outbox.test.ts", // sync
  "test/control_plane/spike-schema.test.ts", // sync
  "test/fault_injection/cases.test.ts", // 37
  "test/fault_injection/conformance.test.ts", // 33 + sync
  "test/fault_injection/protocol.test.ts", // 8 + sync
  "test/fencing/deny-hook.test.ts", // sync
  "test/gate_item11/no-provider-detail-leaks.test.ts", // sync, via registry.ts
  "test/gate_item11/registry-availability.test.ts", // sync, via registry.ts
  "test/gate_item11/substitution-scenarios.test.ts", // 16
  "test/gate_item11/suite-runs-unchanged.test.ts", // sync, via support/run.ts
  "test/gate_item2/mediated-real-provider.test.ts", // 6
  "test/gate_item2/session-driver-harness.test.ts", // 12
  "test/measurement/cli.test.ts", // sync
  "test/messagebus/endpoint.test.ts", // 1 + sync
  "test/messagebus/stale-readout.test.ts", // 2
  "test/session/claude-cli-provider.test.ts", // 39
  "test/session/stub-provider.test.ts", // 29
  "test/settings/sandbox-symlink-deny.test.ts", // sync
];

/**
 * Test files that name `child_process` without starting one, each with the
 * reason it is not in `SPAWNING_TESTS`.
 *
 * The guard below reads every test file and demands that one naming
 * `child_process` appear in one of these two lists. A test that starts spawning
 * children therefore has to say so here, rather than joining the parallel pass
 * silently and putting back the contention this file exists to remove.
 */
const NAMES_CHILD_PROCESS_WITHOUT_SPAWNING = new Map([
  [
    "test/attention/notify.test.ts",
    "the notifier's `spawnSync` is a seam; every case patches it (test/testkit/seams.ts)",
  ],
  [
    "test/secretary/structural.test.ts",
    "`execSync`/`execFileSync`/`spawnSync` appear as the names of a banned call, in string " +
      "literals and in hand-written snippets the detector is run against",
  ],
  [
    "test/control_plane/lease.test.ts",
    "reads its own source text to assert on it; the spawn in src/control_plane/lease.ts is " +
      "not reached by any case here",
  ],
]);

/** Environment variable that forces the split on or off, whatever the platform. */
const SERIALIZE_ENV = "CONTINUO_SERIALIZE_SPAWN_TESTS";

/** Environment variable carrying the worker count for the serialized pass. */
const WORKERS_ENV = "CONTINUO_SPAWN_TEST_WORKERS";

function fail(message) {
  process.stderr.write(`run-suite: ${message}\n`);
  process.exit(1);
}

/** Every file the suite's `include` glob matches, repo-relative and sorted. */
function allTestFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".test.ts")) {
        found.push(relative(REPO_ROOT, path).split("\\").join("/"));
      }
    }
  };
  walk(TEST_ROOT);
  return found;
}

/**
 * Refuse to run a split whose two halves are not the whole suite.
 *
 * Every failure mode here is silent otherwise: a renamed file drops out of the
 * serial list and back into the parallel pass, and a new test that spawns
 * children joins the parallel pass with nothing to notice it.
 */
function checkPartition(files) {
  const present = new Set(files);
  for (const file of SPAWNING_TESTS) {
    if (!present.has(file)) {
      fail(
        `${file} is listed as a child-process-spawning test but no such test file exists. ` +
          "Update SPAWNING_TESTS in scripts/run-suite.mjs.",
      );
    }
  }
  const serial = new Set(SPAWNING_TESTS);
  for (const file of files) {
    if (serial.has(file) || NAMES_CHILD_PROCESS_WITHOUT_SPAWNING.has(file)) {
      continue;
    }
    if (readFileSync(join(REPO_ROOT, file), "utf8").includes("child_process")) {
      fail(
        `${file} names child_process but is not classified in scripts/run-suite.mjs. Add it to ` +
          "SPAWNING_TESTS if it starts a child process, or to " +
          "NAMES_CHILD_PROCESS_WITHOUT_SPAWNING with the reason it does not.",
      );
    }
  }
}

/** The worker count for the serialized pass: 1 unless the environment says otherwise. */
function serialWorkers() {
  const raw = process.env[WORKERS_ENV];
  if (raw === undefined || raw === "") {
    return 1;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    fail(`${WORKERS_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return Number(raw);
}

/** Whether to split the suite. Windows by default; either way the environment wins. */
function shouldSerialize() {
  const raw = process.env[SERIALIZE_ENV];
  if (raw === undefined || raw === "") {
    return process.platform === "win32";
  }
  if (raw !== "0" && raw !== "1") {
    fail(`${SERIALIZE_ENV} must be "0" or "1", got ${JSON.stringify(raw)}.`);
  }
  return raw === "1";
}

/** One vitest run. Returns its exit status. */
function runVitest(args) {
  const completed = spawnSync(process.execPath, [VITEST_ENTRY, "run", ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (completed.error !== undefined) {
    fail(`could not start vitest: ${completed.error.message}`);
  }
  return completed.status ?? 1;
}

/** The files a pass's JSON report says it ran, repo-relative. */
function reportedFiles(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return raw.testResults.map((result) =>
    relative(REPO_ROOT, resolve(result.name)).split("\\").join("/"),
  );
}

const forwarded = process.argv.slice(2);

// A filtered run -- `npm test -- test/messagebus` -- is a person asking for a
// subset by name, and the split would silently reinterpret that as the whole
// suite. Hand those straight to vitest.
const filtered = forwarded.some((arg) => !arg.startsWith("-"));

if (filtered || !shouldSerialize()) {
  process.exit(runVitest(forwarded));
}

const files = allTestFiles();
checkPartition(files);

// The caller's own reporter wins: `npm test -- --reporter=json` must keep
// meaning what it did, so the coverage check below is skipped rather than
// fighting over `--outputFile`.
const callerReports = forwarded.some(
  (arg) => arg.startsWith("--reporter") || arg.startsWith("--outputFile"),
);
const reportDir = callerReports ? undefined : mkdtempSync(join(tmpdir(), "continuo-run-suite-"));
const reportFlags = (name) =>
  reportDir === undefined
    ? []
    : ["--reporter=default", "--reporter=json", `--outputFile.json=${join(reportDir, name)}`];

const workers = serialWorkers();
process.stderr.write(
  `run-suite: splitting the suite -- ${files.length - SPAWNING_TESTS.length} files in parallel, ` +
    `then ${SPAWNING_TESTS.length} child-process tests at ${workers} worker(s)\n`,
);

// The parallel pass first: it is the cheap one, so a breakage that is not about
// contention surfaces before the slow half has been paid for.
const parallelStatus = runVitest([
  ...forwarded,
  ...reportFlags("parallel.json"),
  ...SPAWNING_TESTS.flatMap((file) => ["--exclude", file]),
]);
if (parallelStatus !== 0) {
  process.exit(parallelStatus);
}

const serialArgs = workers === 1 ? ["--no-file-parallelism"] : [`--maxWorkers=${workers}`];
const serialStatus = runVitest([
  ...forwarded,
  ...reportFlags("serial.json"),
  ...serialArgs,
  ...SPAWNING_TESTS,
]);
if (serialStatus !== 0) {
  process.exit(serialStatus);
}

if (reportDir !== undefined) {
  const ran = new Set([
    ...reportedFiles(join(reportDir, "parallel.json")),
    ...reportedFiles(join(reportDir, "serial.json")),
  ]);
  const missed = files.filter((file) => !ran.has(file));
  if (missed.length > 0) {
    fail(
      `${missed.length} test file(s) ran in neither pass: ${missed.join(", ")}. ` +
        "Two green passes that between them skipped a file are not a green suite.",
    );
  }
  process.stderr.write(`run-suite: both passes green, ${ran.size} test files accounted for\n`);
}
