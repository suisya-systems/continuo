import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterAll, expect, onTestFinished } from "vitest";
import { getCurrentSuite } from "vitest/suite";

/**
 * Per-test temporary directory.
 *
 * The isolation contract for the port (D-0005) is: file and test order are
 * shuffled, tests are not concurrent within a file, and no test shares
 * filesystem state with another. Under a shuffled order, a fixed path such as
 * `./tmp/test.db` produces failures that depend on which test ran first -- the
 * exact class of bug the random ordering exists to expose, arriving as noise
 * instead of signal.
 *
 * The directory is removed when the test finishes, pass or fail.
 */
export function createTempDir(label = "case"): string {
  // The worker id disambiguates directories across parallel test *files*;
  // mkdtemp's own suffix disambiguates within a file.
  const worker = process.env["VITEST_WORKER_ID"] ?? "0";
  const prefix = join(tmpdir(), `continuo-${sanitize(label)}-w${worker}-`);
  const dir = mkdtempSync(prefix);

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

/** Keep the label usable as a path segment on every matrix cell, Windows included. */
function sanitize(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "case";
}

/** Path to a fresh database file inside a per-test temporary directory. */
export function tempDatabasePath(label = "db"): string {
  return join(createTempDir(label), "continuo.sqlite");
}

/**
 * Suite-scoped temporary directory: one per test **file**, removed when that
 * file's tests are done.
 *
 * ("Suite" here means the test file. Vitest's own vocabulary uses "suite" for a
 * `describe` block, so the two do not line up; the name follows the vocabulary
 * this helper was asked for, and this line is the note that the mismatch was
 * seen rather than missed.)
 *
 * This is the companion to {@link createTempDir}, not a replacement for it. The
 * two answer different questions, and picking the wrong one is the failure this
 * helper exists to prevent:
 *
 * - {@link createTempDir} is where a test's *own* state goes. It is removed
 *   when that test finishes, which is what keeps a shuffled order honest.
 * - This is where material shared by the whole file goes -- specifically a
 *   fixture that is expensive to build and identical for every case, such as a
 *   migrated control plane used as a copy template. Building one per file and
 *   copying it per case is measured at about 90x cheaper than migrating per
 *   case (87.5ms against 0.97ms, N=30, on one Linux box).
 *
 * The sharing is deliberately narrow, and does not loosen D-0005's isolation
 * contract:
 *
 * - The directory is scoped to one file, and `isolate: true` gives each file
 *   its own worker, so nothing here crosses a worker boundary.
 * - What belongs in it is build-once, read-only material. A test that writes
 *   still writes inside its own {@link createTempDir}; the intended use is a
 *   template that is copied, never one that is opened for writing.
 *
 * **Must be called from the top level of the test file** -- not from inside a
 * running test, and not from inside a `describe` body either. Both restrictions
 * exist because of where this helper's `afterAll` lands, and both were measured
 * on Vitest 4.1.11 rather than assumed:
 *
 * - *Once the file's tests have started* -- from a test body, or from a teardown
 *   hook -- Vitest accepts the `afterAll` and then never runs it, so the
 *   directory would silently outlive the whole run.
 * - *From inside a `describe` body*, the `afterAll` binds to that `describe`
 *   rather than to the file, so the directory is removed when that block
 *   finishes -- while a sibling block, or a later top-level test, is still using
 *   it. That is the per-case-root failure this helper exists to remove, put back
 *   one level up, and under a shuffled order it would surface as an `ENOENT`
 *   in whichever test happened to run afterwards.
 *
 * Both therefore fail here, loudly, instead of leaking there, quietly.
 */
export function createSuiteDir(label = "suite"): string {
  // Set once the file's first test starts, and never cleared afterwards, so this
  // catches a call from a test body and a call from a teardown hook alike --
  // the hook case reports the last test seen rather than a test that is
  // literally running, which is why the message says "most recent" and not
  // "current".
  const started = expect.getState().currentTestName;
  if (started !== undefined) {
    throw new Error(
      `createSuiteDir(${JSON.stringify(label)}) was called after this file's tests had started ` +
        `running (most recent test: ${JSON.stringify(started)}). It must be called at collection ` +
        `time, from the top level of the test file, because it registers its cleanup with ` +
        `afterAll, and an afterAll registered once the tests are under way never runs. Move the ` +
        `call to the top level of the file, or use createTempDir() if what you wanted is ` +
        `per-test state.`,
    );
  }

  // The file's own collector is the only one whose `afterAll` outlives every
  // test in the file, and the only one with no parent. The parent is what is
  // tested, not the name: Vitest leaves the file collector's name empty, but
  // `describe("")` is legal and produces a nested collector with an empty name
  // too, so a name check would wave through the one call shape most likely to
  // be written by someone parametrising a block title.
  const collector = getCurrentSuite();
  if ("suite" in collector) {
    const where =
      collector.name === ""
        ? "an unnamed describe block"
        : `describe(${JSON.stringify(collector.name)})`;
    throw new Error(
      `createSuiteDir(${JSON.stringify(label)}) was called inside ${where}. It must be called ` +
        `from the top level of the test file: an afterAll registered inside a describe runs when ` +
        `that block finishes, so the directory would be removed while a sibling block, or a ` +
        `later top-level test, was still using it. Move the call to the top level of the file.`,
    );
  }

  // Same disambiguation as createTempDir, with the scope in the name: a leaked
  // directory should say which scope failed to clean it up.
  const worker = process.env["VITEST_WORKER_ID"] ?? "0";
  const dir = mkdtempSync(join(tmpdir(), `continuo-suite-${sanitize(label)}-w${worker}-`));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}
