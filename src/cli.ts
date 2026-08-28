#!/usr/bin/env node
/**
 * The unified `continuo` CLI.
 *
 * Subcommands:
 *
 * - `measure report ...` -> `src/measurement/cli.ts`
 *
 * Ported from interlock `src/claude_org_runtime/cli.py` at `65f36c5`, which
 * mounts six subtrees. **Five of them are not here**, and their absence is not
 * an omission this file should be read as hiding: `dispatcher`, `settings`,
 * `sandbox`, `attention` and `migrate` mount modules that continuo has not
 * ported yet, so mounting a subcommand for them would put a command in `--help`
 * that cannot run. Each arrives with its own lane, and the shape this file
 * establishes -- the subtree's own module owns its parser, this file only mounts
 * it -- is what keeps the flags in lock-step when they do.
 *
 * The subcommand re-uses the same parser builder the per-module CLI exposes, so
 * `continuo measure report --db ...` and the module's own parser cannot drift.
 *
 * **ASCII only**, for the reason `measurement/cli.ts` gives: every string here
 * reaches `--help` on a cp932 console.
 */

import { pathToFileURL } from "node:url";

import { TOOL_VERSION } from "./about.js";
import { ArgumentParser, dispatch } from "./cli/parser.js";
import * as measurementCli from "./measurement/cli.js";
import { PACKAGE_NAME } from "./meta.js";

/** The top-level parser, with every ported subtree mounted on it. */
export function buildParser(): ArgumentParser {
  const parser = new ArgumentParser({
    prog: "continuo",
    description:
      "TypeScript runtime for the Interlock control plane: the read-only " + "measurement harness.",
  });
  parser.addArgument({
    flag: "--version",
    kind: "version",
    version: `${PACKAGE_NAME} ${TOOL_VERSION}`,
    help: "show the build's version and exit.",
  });
  const sub = parser.addSubparsers();

  // measure (the read-only measurement harness, docs/measurement-harness.md)
  const measure = sub.addParser("measure", {
    help:
      "Measurement harness over a production control plane: AC-9 figures " +
      "with the section 6 provenance header. Read-only by capability.",
  });
  measurementCli.addSubparsers(measure.addSubparsers());

  return parser;
}

/** Parse `argv` and run the named command. */
export function main(argv: readonly string[]): number {
  return dispatch(buildParser(), argv, {
    out: (text) => {
      // Routed through the measurement module's write seam rather than to
      // `process.stdout` directly, so that the ported cases read one stream
      // whichever entry point they drove -- the source's `capsys` sees both
      // without being told which one wrote.
      measurementCli.cliSeams.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
  });
}

// Run only when this file *is* the process's entry point, so the suite can
// import it without a command running. Compared as a resolved file URL rather
// than by name: a basename match would fire for any entry script that happened
// to be called `cli.js`, which on Windows includes the drive-letter and
// separator differences that make a raw string compare wrong as well.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
