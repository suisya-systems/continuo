// Native-load smoke test for better-sqlite3.
//
// Why this exists as a standalone script rather than only as a Vitest test:
// a native addon can fail to load for reasons that also break the test runner's
// worker bootstrap (missing prebuilt binary for this Node ABI, wrong platform
// triple, a toolchain-less machine falling back to a source build that failed
// half-way). When that happens the runner's own error is about workers, not
// about SQLite. This script is run before the suite in CI so the log names the
// actual cause.
//
// ASCII-only output: see docs/cli-output-policy.md. This runs on the Windows
// matrix cell, where a cp932 console cannot encode non-ASCII characters.

import process from "node:process";

const steps = [];

async function step(name, fn) {
  // The name is recorded only after the step actually succeeds, so `steps ok:`
  // in the failure report names the last step that completed, not the one that
  // threw.
  const value = await fn();
  steps.push(name);
  return value;
}

let db;
try {
  const { default: Database } = await step("import better-sqlite3", () =>
    import("better-sqlite3"),
  );

  db = await step("open in-memory database", () => new Database(":memory:"));

  const row = await step("SELECT 1", () => db.prepare("SELECT 1 AS one").get());
  if (!row || row.one !== 1) {
    throw new Error(
      `SELECT 1 returned ${JSON.stringify(row)}, expected { one: 1 }`,
    );
  }

  const version = await step("read sqlite_version()", () =>
    db.prepare("SELECT sqlite_version() AS v").get().v,
  );

  await step("close", () => db.close());
  db = undefined;

  process.stdout.write(
    `better-sqlite3 native load OK` +
      ` (node ${process.version}, ${process.platform}-${process.arch},` +
      ` sqlite ${version})\n`,
  );
} catch (error) {
  // Fail closed and loudly: name the last step that succeeded, so the log
  // distinguishes "the addon never loaded" from "it loaded and then misbehaved".
  const done = steps.length > 0 ? steps.join(" -> ") : "(nothing)";
  process.stderr.write(
    `better-sqlite3 native load FAILED\n` +
      `  node:     ${process.version}\n` +
      `  platform: ${process.platform}-${process.arch}\n` +
      `  steps ok: ${done}\n` +
      `  error:    ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    db?.close();
  } catch {
    // Already closed, or never opened. The primary error is the one reported.
  }
}
