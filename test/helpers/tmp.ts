import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { onTestFinished } from "vitest";

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
