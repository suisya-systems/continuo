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
 * about 0.5% of the time and have no contention problem to solve. So does a run
 * given any argument at all, on Windows too, loudly -- see the note where that
 * is decided.
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
 * a 2400s `timeout-minutes` cap). On Linux, whole suite minus the file D-1003
 * already skips on Windows: 58.6s unchanged, 112.4s with the spawning set at one
 * worker (1.92x), 71.1s with it at two workers (1.21x) -- which made one worker
 * look unaffordable on the worst Windows job, and is why the count is a variable
 * at all.
 *
 * On the Windows cell itself it did not cost that. Ten green jobs at one worker
 * (D-0048): p90 job wall 1017s against 930s before, 42% of the cap, and the
 * worst green job *fell* from 1864s to 1054s; `conformance.test.ts` went from a
 * p90 of 161s to 57.1s. The Linux ratio was an upper bound rather than a
 * prediction, because part of what serialization removes on Windows is the
 * contention that made each file slow to begin with.
 *
 * So one worker is the default and CI passes nothing.
 * `CONTINUO_SPAWN_TEST_WORKERS` stays for the comparison a different runner
 * would make worth taking again.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
  "test/gate/endpoint-relay.test.ts", // 1, the built endpoint over real stdio
  "test/gate_item11/no-provider-detail-leaks.test.ts", // sync, via registry.ts
  "test/gate_item11/registry-availability.test.ts", // sync, via registry.ts
  "test/gate_item11/substitution-scenarios.test.ts", // 16
  "test/gate_item11/suite-runs-unchanged.test.ts", // sync, via support/run.ts
  "test/gate_item2/mediated-real-provider.test.ts", // 6
  "test/gate_item2/session-driver-harness.test.ts", // 12
  "test/lap/cli.test.ts", // 8, via src/workspace/git.ts and a fenced child
  "test/lap/endpoint-lease.test.ts", // 6, via src/workspace/git.ts (no claude child)
  "test/lap/teardown.test.ts", // 6, via src/workspace/git.ts (no claude child)
  "test/measurement/cli.test.ts", // sync
  "test/messagebus/endpoint-lease-renewal.test.ts", // 2
  "test/messagebus/endpoint.test.ts", // 1 + sync
  "test/messagebus/stale-readout.test.ts", // 2
  "test/session/claude-cli-provider.test.ts", // 39
  "test/session/stub-provider.test.ts", // 29
  "test/settings/sandbox-symlink-deny.test.ts", // sync
  "test/workspace/materializer.test.ts", // sync, via src/workspace/git.ts
];

/**
 * Test files that reach `child_process` without starting one, each with the
 * reason it is not in `SPAWNING_TESTS`.
 *
 * The guard below follows every test file's imports *within `test/`* and demands
 * that one which reaches the name `child_process` -- in its own text or a
 * helper's -- appear in one of these two lists. A test that starts spawning
 * children, directly or through a helper that already does, therefore has to say
 * so here rather than joining the parallel pass silently and putting back the
 * contention this file exists to remove.
 *
 * The walk stops at `test/`'s edge. Following it into `src/` would classify by
 * what a module *could* do rather than what a case does: `src/control_plane/lease.ts`
 * names a spawn that most of its callers never reach, and the closure through it
 * covers a third of the suite. The files here that do spawn through `src/` --
 * the session providers and `gate_item2` -- are in `SPAWNING_TESTS` on the
 * measurement described above, which is the evidence a closure cannot give.
 */
const REACHES_CHILD_PROCESS_WITHOUT_SPAWNING = new Map([
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
  [
    "test/fault_injection/manifest.test.ts",
    "takes three pure string helpers from controller.ts (case titles, a repro line); no case " +
      "here starts a run",
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
 * Every relative import a file under `test/` makes, resolved to a file under
 * `test/` and nothing else.
 *
 * Textual rather than a syntax tree, deliberately: this runs before every
 * Windows suite run, and the one parser available here is the TypeScript 7
 * compiler, which would mean spawning a child process to decide which tests
 * spawn child processes. The cost of the imprecision is bounded in the safe
 * direction -- a specifier this misses can only move a file into the pass that
 * is already the default, and the classification it feeds is a demand for an
 * answer in this file, not an automatic verdict.
 */
function localImports(file, inTree) {
  const specifiers = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  const found = new Set();
  for (const match of inTree.get(file).matchAll(specifiers)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) {
      continue;
    }
    const base = resolve(join(REPO_ROOT, file), "..", specifier);
    // `.js` in the specifier, `.ts` on disk: the convention this tree is written
    // in. The bare and index forms cover the `.mjs` helpers and any directory.
    const candidates = [
      base,
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.js$/, ".mts"),
      `${base}.ts`,
      join(base, "index.ts"),
    ];
    for (const candidate of candidates) {
      const key = relative(REPO_ROOT, candidate).split("\\").join("/");
      if (inTree.has(key)) {
        found.add(key);
        break;
      }
    }
  }
  return found;
}

/** Every file under `test/` that could hold code, by repo-relative path. */
function testTreeSources() {
  const sources = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(ts|mts|mjs|js)$/.test(entry)) {
        sources.set(relative(REPO_ROOT, path).split("\\").join("/"), readFileSync(path, "utf8"));
      }
    }
  };
  walk(TEST_ROOT);
  return sources;
}

/**
 * Refuse to run a split whose two halves are not the whole suite.
 *
 * Every failure mode here is silent otherwise: a renamed file drops out of the
 * serial list and back into the parallel pass, and a new test that spawns
 * children -- itself or through a helper that already does -- joins the parallel
 * pass with nothing to notice it.
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

  const sources = testTreeSources();
  const reaches = new Map();
  const walk = (file, seen) => {
    const known = reaches.get(file);
    if (known !== undefined) {
      return known;
    }
    if (seen.has(file)) {
      return false;
    }
    seen.add(file);
    let found = sources.get(file).includes("child_process");
    if (!found) {
      for (const imported of localImports(file, sources)) {
        if (walk(imported, seen)) {
          found = true;
          break;
        }
      }
    }
    seen.delete(file);
    reaches.set(file, found);
    return found;
  };

  const serial = new Set(SPAWNING_TESTS);
  for (const file of files) {
    if (serial.has(file) || REACHES_CHILD_PROCESS_WITHOUT_SPAWNING.has(file)) {
      continue;
    }
    if (walk(file, new Set())) {
      fail(
        `${file} reaches child_process, itself or through a helper, but is not classified in ` +
          "scripts/run-suite.mjs. Add it to SPAWNING_TESTS if it starts a child process, or to " +
          "REACHES_CHILD_PROCESS_WITHOUT_SPAWNING with the reason it does not.",
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

if (!shouldSerialize()) {
  process.exit(runVitest(forwarded));
}

// An argument means a person asking for something other than "the suite": a
// filter (`npm test -- test/messagebus`), a reporter, a bail. The split cannot
// honour those and stay honest -- a filter would be reinterpreted as the whole
// suite, a `--reporter=json --outputFile=report.json` would be written twice and
// the second write would leave a green report holding half the suite -- and it
// is not the runner's place to guess which. So it steps aside, and says so: a
// person who asked for a subset can see they got one pass, and CI, which passes
// nothing, never takes this branch.
if (forwarded.length > 0) {
  process.stderr.write(
    "run-suite: arguments given, so the suite runs in one pass and the child-process tests are " +
      "NOT serialized. Drop the arguments, or run each pass by hand, to get the Windows split.\n",
  );
  process.exit(runVitest(forwarded));
}

const files = allTestFiles();
checkPartition(files);

// Each pass also writes a JSON report, so that the two can be checked to cover
// the suite between them. `--reporter=default` is passed alongside because
// naming a reporter replaces the default one rather than adding to it.
const reportDir = mkdtempSync(join(tmpdir(), "continuo-run-suite-"));
// On the way out, by whichever exit is taken -- both early returns on a red
// pass, the coverage check's own failure, and the green path. `npm test` is run
// often enough locally that a directory left behind each time is a leak, and
// the reports are worth nothing once they have been read.
process.on("exit", () => {
  try {
    rmSync(reportDir, { recursive: true, force: true });
  } catch {
    // A report directory that cannot be removed is not a reason to fail a run
    // that has already decided its own outcome.
  }
});
const reportFlags = (name) => [
  "--reporter=default",
  "--reporter=json",
  `--outputFile.json=${join(reportDir, name)}`,
];

const workers = serialWorkers();
process.stderr.write(
  `run-suite: splitting the suite -- ${files.length - SPAWNING_TESTS.length} files in parallel, ` +
    `then ${SPAWNING_TESTS.length} child-process tests at ${workers} worker(s)\n`,
);

// The parallel pass first: it is the cheap one, so a breakage that is not about
// contention surfaces before the slow half has been paid for.
const parallelStatus = runVitest([
  ...reportFlags("parallel.json"),
  ...SPAWNING_TESTS.flatMap((file) => ["--exclude", file]),
]);
if (parallelStatus !== 0) {
  process.exit(parallelStatus);
}

const serialArgs = workers === 1 ? ["--no-file-parallelism"] : [`--maxWorkers=${workers}`];
const serialStatus = runVitest([...reportFlags("serial.json"), ...serialArgs, ...SPAWNING_TESTS]);
if (serialStatus !== 0) {
  process.exit(serialStatus);
}

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
