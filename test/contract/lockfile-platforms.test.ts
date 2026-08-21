import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The lockfile must describe every required CI platform, not just the one it
 * was last generated on.
 *
 * How this breaks, and it has: regenerating with `npm install --package-lock-only`
 * while a platform-pruned `node_modules` is present rewrites the lockfile from
 * that tree, silently dropping every optional dependency for other platforms.
 * The result installs and tests green on the machine that produced it, and then
 * `npm ci` on the Windows cell leaves Vite/Vitest without its native binding --
 * so the runner dies during startup, before a single test runs, with an error
 * about a missing module rather than about the lockfile.
 *
 * Windows is a required cell (D-0003, D-0005), so this is a merge-gate concern
 * and belongs in a test rather than in a habit.
 */

const LOCKFILE = fileURLToPath(new URL("../../package-lock.json", import.meta.url));

/**
 * One representative native binding per required platform. Named rather than
 * derived, so that a dependency dropping a platform is a visible failure here
 * instead of a quietly shrinking set.
 */
const REQUIRED_BINDINGS = [
  "node_modules/@rolldown/binding-linux-x64-gnu",
  "node_modules/@rolldown/binding-win32-x64-msvc",
  "node_modules/lightningcss-linux-x64-gnu",
  "node_modules/lightningcss-win32-x64-msvc",
];

describe("package-lock.json platform coverage", () => {
  const lock = JSON.parse(readFileSync(LOCKFILE, "utf8")) as {
    lockfileVersion: number;
    packages: Record<string, { engines?: Record<string, string> }>;
  };

  it("is a lockfileVersion npm ci understands", () => {
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
  });

  it.each(REQUIRED_BINDINGS)("records %s", (name) => {
    expect(Object.keys(lock.packages)).toContain(name);
  });

  it("agrees with package.json about the supported Node range", () => {
    // `npm ci` does NOT reject a mismatch in this root metadata, so a stale
    // range here would go unnoticed while lockfile-consuming tooling reads it.
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { engines?: Record<string, string> };

    expect(lock.packages[""]?.engines?.["node"]).toBe(pkg.engines?.["node"]);
  });
});
