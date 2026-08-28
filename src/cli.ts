#!/usr/bin/env node
/**
 * The unified `continuo` CLI -- the only one (`D-0030`).
 *
 * Subcommands, each declared by the module that implements it and only mounted
 * here:
 *
 * - `measure report ...`   -> `src/measurement/cli.ts`
 * - `settings generate|show ...` -> `src/settings/cli.ts`
 * - `sandbox doctor ...`   -> `src/settings/cli.ts`
 *
 * Ported from interlock `src/claude_org_runtime/cli.py` at `65f36c5`, which
 * mounts six subtrees. Three of them are not here -- `dispatcher`, `attention`
 * and `migrate` mount modules continuo has not ported yet, so mounting a
 * subcommand for them would put a command in `--help` that cannot run. Each
 * arrives with its own lane, and the shape this file establishes -- the
 * subtree's own module owns its parser, this file only mounts it -- is what
 * keeps the flags in lock-step when they do.
 *
 * **What `D-0030` closed.** Two lanes each landed a parser and a unified CLI:
 * this file (prog `continuo`, mounting `measure`, parsing with a purpose-built
 * parser) and `settings/cli.ts`'s `buildRuntimeParser` (prog
 * `claude-org-runtime`, mounting `settings` and `sandbox`, parsing with a
 * transcription of CPython's `argparse`). The second was reachable from no bin
 * at all, so `continuo sandbox doctor` -- a preflight whose whole job is to say
 * whether a worker's sandbox will actually launch -- could not be run from the
 * published binary. Re-declaring those flags here in the other parser would
 * have duplicated a security-relevant surface across two implementations with
 * different semantics; there is now one parser (`src/cli/parser.ts`) and one
 * declaration of each flag, in the module that owns it.
 *
 * **ASCII only**, for the reason `measurement/cli.ts` gives: every string here
 * reaches `--help` on a cp932 console, and the walk in `helpStrings` now
 * reaches all three subtrees from this parser.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TOOL_VERSION } from "./about.js";
import { type ArgparseStreams, ArgumentParser, dispatch } from "./cli/parser.js";
import * as measurementCli from "./measurement/cli.js";
import { PACKAGE_NAME } from "./meta.js";
import { addSandboxSubparsers, addSettingsSubparsers } from "./settings/cli.js";

/**
 * Where this file's own output goes.
 *
 * Its own record rather than a borrowed one. Before the consolidation this file
 * wrote the top-level `--help` and `--version` through the *measurement*
 * module's write seam, which was defensible while `measure` was the only thing
 * mounted and is not now: `continuo settings --help` would have gone out
 * through the measurement harness's stdout. Each mounted command still writes
 * its own output through its own module's seam; this record is only for what
 * the top-level parser itself prints.
 */
export const cliSeams = {
  out: (text: string): void => {
    process.stdout.write(text);
  },
  err: (text: string): void => {
    process.stderr.write(text);
  },
};

/** `sys.stdout` / `sys.stderr` for the top-level parser, read through the seam. */
function defaultStreams(): ArgparseStreams {
  return {
    stdout: (text: string): void => {
      cliSeams.out(text);
    },
    stderr: (text: string): void => {
      cliSeams.err(text);
    },
  };
}

/** The top-level parser, with every ported subtree mounted on it. */
export function buildParser(): ArgumentParser {
  const parser = new ArgumentParser(
    "continuo",
    "TypeScript runtime for the Interlock control plane: the read-only " +
      "measurement harness, the worker settings generator, and the sandbox " +
      "preflight.",
  );
  parser.addArgument({
    optionStrings: ["--version"],
    dest: "version",
    version: `${PACKAGE_NAME} ${TOOL_VERSION}`,
    help: "show the build's version and exit.",
  });
  const sub = parser.addSubparsers("command");

  // measure (the read-only measurement harness, docs/measurement-harness.md)
  const measure = sub.addParser(
    "measure",
    "Measurement harness over a production control plane: AC-9 figures " +
      "with the section 6 provenance header. Read-only by capability.",
  );
  measurementCli.addSubparsers(measure.addSubparsers("cmd"));

  // settings / sandbox (the per-role fencing surface, D-0213 / D-0214)
  addSettingsSubparsers(sub);
  addSandboxSubparsers(sub);

  return parser;
}

/** Parse `argv` and run the named command. */
export function main(argv: readonly string[]): number {
  return dispatch(buildParser(), argv, defaultStreams());
}

/**
 * Is this file the process's entry point?
 *
 * Asked so the suite can import the module without a command running, and
 * answered through `realpathSync` on **both** sides, because the normal way this
 * CLI is invoked goes through a symlink: npm publishes a `bin` as
 * `node_modules/.bin/continuo` pointing at `dist/cli.js`, and Node sets
 * `process.argv[1]` to the link it was handed while resolving `import.meta.url`
 * to the real file. Comparing the two unresolved is false for every installed
 * user, and the failure is silent -- the process exits 0 having run no command
 * and printed nothing.
 *
 * Resolved *paths* rather than URLs, because that is what `realpathSync`
 * returns. The URL form is what made the symlink case look like it worked.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that will not resolve is not this file. Nothing here is worth
    // failing a process over: the caller asked to run a command, not to have
    // this question answered.
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
