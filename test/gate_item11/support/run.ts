import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTempDir } from "../../helpers/tmp.js";
import { PROVIDER_ENV } from "./provider-plugin.js";

/**
 * Two subprocess runs of `test/control_plane`'s suite, one plain, one with
 * `support/provider-plugin.ts`'s `globalSetup` binding a live provider first.
 *
 * Ported from interlock `tests/gate_item11/test_suite_runs_unchanged.py`'s
 * `_run` plus `tests/gate_item11/outcome_recorder.py` at `65f36c5` (D-1002).
 *
 * The source needed a pytest plugin (`outcome_recorder.py`) to get per-phase
 * outcomes and a file digest out of a run it did not control the format of.
 * Vitest's own `--reporter=json` already carries both: a `status` per test
 * *and* per file (`testResults[].status`), and `testResults[].name` for every
 * file the run actually collected from -- so this module reads that output
 * directly rather than porting a second reporter. What that buys, and what it
 * does not, is D-1002's own decision; see `suite-runs-unchanged.test.ts`.
 */

const REPORT_ENV = "CONTINUO_ITEM11_REPORT";

/** `Path(__file__).resolve().parents[2]` -- this file's own three ancestors up. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const CONFIG_PATH = join(REPO_ROOT, "test/gate_item11/support/suite-runs-unchanged.config.ts");
const VITEST_ENTRY = join(REPO_ROOT, "node_modules/vitest/vitest.mjs");

/** Long enough for a subprocess double-run of `test/control_plane` (measured ~7s unbound). */
const RUN_TIMEOUT_MS = 300_000;

interface JsonReporterFile {
  readonly name: string;
  readonly status: string;
  readonly assertionResults: readonly { readonly fullName: string; readonly status: string }[];
}

interface JsonReporterOutput {
  readonly success: boolean;
  readonly testResults: readonly JsonReporterFile[];
}

/** One test id's outcome, both at the assertion level and at its file's level. */
export interface Outcome {
  readonly test: string;
  readonly file: string;
}

export interface RunResult {
  readonly provider: string | null;
  readonly outcomes: Readonly<Record<string, Outcome>>;
  readonly artifact: Readonly<Record<string, string>>;
  readonly stdout: string;
  readonly stderr: string;
  readonly returncode: number;
}

function buildOutcomes(raw: JsonReporterOutput): Record<string, Outcome> {
  const outcomes: Record<string, Outcome> = {};
  for (const file of raw.testResults) {
    for (const assertion of file.assertionResults) {
      outcomes[`${file.name}::${assertion.fullName}`] = {
        test: assertion.status,
        file: file.status,
      };
    }
  }
  return outcomes;
}

function buildArtifact(raw: JsonReporterOutput): Record<string, string> {
  const artifact: Record<string, string> = {};
  for (const file of raw.testResults) {
    artifact[basename(file.name)] = createHash("sha256")
      .update(readFileSync(file.name))
      .digest("hex");
  }
  return artifact;
}

async function run(options: { readonly provider: string | null }): Promise<RunResult> {
  const label = options.provider ?? "unbound";
  const reportDir = createTempDir(`gate-item11-suite-run-${label}`);
  const report = join(reportDir, `${label}.json`);

  const environment: NodeJS.ProcessEnv = { ...process.env };
  environment[REPORT_ENV] = report;
  delete environment[PROVIDER_ENV];
  if (options.provider !== null) {
    environment[PROVIDER_ENV] = options.provider;
  }

  const completed = spawnSync(process.execPath, [VITEST_ENTRY, "run", "--config", CONFIG_PATH], {
    cwd: REPO_ROOT,
    env: environment,
    encoding: "utf-8",
    timeout: RUN_TIMEOUT_MS,
  });

  const stdout = completed.stdout ?? "";
  const stderr = completed.stderr ?? "";
  const returncode = completed.status ?? 1;

  if (!existsSync(report)) {
    throw new Error(
      `the ${label} run wrote no report; vitest exited ${returncode}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  const raw = JSON.parse(readFileSync(report, "utf-8")) as JsonReporterOutput;

  return {
    provider: options.provider,
    outcomes: buildOutcomes(raw),
    artifact: buildArtifact(raw),
    stdout,
    stderr,
    returncode,
  };
}

let unboundRunPromise: Promise<RunResult> | undefined;

/** The suite as it stands, with no session backend anywhere near it. Cached: run once. */
export function unboundRun(): Promise<RunResult> {
  unboundRunPromise ??= run({ provider: null });
  return unboundRunPromise;
}

const boundRunPromises = new Map<string, Promise<RunResult>>();

/** The same suite, with `providerId` live for its whole duration. Cached per provider. */
export function boundRun(providerId: string): Promise<RunResult> {
  let promise = boundRunPromises.get(providerId);
  if (promise === undefined) {
    promise = run({ provider: providerId });
    boundRunPromises.set(providerId, promise);
  }
  return promise;
}

/** Every test id in `run` whose outcome (at either level) was a failure. */
export function failed(run: RunResult): Record<string, Outcome> {
  const result: Record<string, Outcome> = {};
  for (const [id, outcome] of Object.entries(run.outcomes)) {
    if (outcome.test === "failed" || outcome.file === "failed") {
      result[id] = outcome;
    }
  }
  return result;
}
