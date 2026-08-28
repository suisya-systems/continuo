#!/usr/bin/env node
/**
 * The unified `continuo` CLI.
 *
 * Subcommands:
 *
 * - `measure report ...` -> `src/measurement/cli.ts`
 *
 * Ported from interlock `src/claude_org_runtime/cli.py` at `65f36c5`, which
 * mounts six subtrees. **Five of them are not here**, and the reason differs
 * between them, which it did not when this file was written:
 *
 * - `dispatcher`, `attention` and `migrate` mount modules continuo has not
 *   ported yet, so mounting a subcommand for them would put a command in
 *   `--help` that cannot run. Each arrives with its own lane, and the shape this
 *   file establishes -- the subtree's own module owns its parser, this file only
 *   mounts it -- is what keeps the flags in lock-step when they do.
 * - **`settings` and `sandbox` ARE ported** (D-0213, D-0214) and are still not
 *   mounted, which is a gap rather than a policy: `continuo sandbox doctor` is
 *   unreachable from the published binary today, and the preflight is only
 *   callable through the library surface or the module's own parser. It is
 *   recorded here rather than fixed in passing because the fix is a decision
 *   this file cannot take on its own. Those two subtrees declare their flags
 *   with `src/settings/argparse.ts` -- a transcription of CPython's `argparse`
 *   (D-0213), whose exact two-pass behaviour eleven ported cases pin, including
 *   the `--` separator and the negative-number classification -- while this file
 *   parses with `src/cli/parser.ts`, the purpose-built parser D-0112 chose
 *   precisely because it is NOT an argparse port. Re-declaring the flags here
 *   would duplicate a security-relevant surface in a second parser with
 *   different semantics and let the two drift; delegating raw argv instead needs
 *   a passthrough `src/cli/parser.ts` does not have, since `dispatch` consumes
 *   the whole vector. Either is a cross-lane change with a real choice in it.
 *
 * The subcommand re-uses the same parser builder the per-module CLI exposes, so
 * `continuo measure report --db ...` and the module's own parser cannot drift.
 *
 * **ASCII only**, for the reason `measurement/cli.ts` gives: every string here
 * reaches `--help` on a cp932 console.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
