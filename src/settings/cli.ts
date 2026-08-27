/**
 * The settings generator's command line.
 *
 * Two parsers, because interlock has two: `generator.build_parser()` is the
 * standalone module CLI (`claude-org-runtime-settings`), and
 * `claude_org_runtime.cli.build_parser()` is the unified entry point whose
 * `settings generate` / `settings show` subcommands attach the same arguments.
 * Six of the 106 ported cases go through the first and five through the second,
 * so both exist here rather than one standing in for the other.
 *
 * **Scope, stated rather than implied.** interlock's unified parser also
 * carries `sandbox doctor` and `state migrate`. Neither is ported here:
 * `sandbox_doctor` is PR 4 of this lane and the state migrator belongs to
 * another. `buildRuntimeParser` therefore declares the `settings` subcommand
 * and nothing else, and a future PR adds its own next to it. That is a smaller
 * parser than interlock's, not a different one -- no ported case reaches the
 * missing subcommands, and the parity ledger records which cases each parser
 * carries.
 */

import { type ArgparseStreams, ArgumentParser, type Namespace } from "./argparse.js";
import {
  generatorSeams,
  ROLE_KIND_TO_SCHEMA_KEY,
  run,
  runShow,
  type SettingsArgs,
  VALID_PATTERNS,
} from "./generator.js";

/** `sys.stdout` / `sys.stderr`, read through the seam so a test can capture. */
export function defaultStreams(): ArgparseStreams {
  return {
    stdout: (text: string): void => {
      generatorSeams.stdout(text);
    },
    stderr: (text: string): void => {
      generatorSeams.stderr(text);
    },
  };
}

/**
 * `generator.add_arguments`: the generator's flags, attached to an existing
 * parser.
 *
 * Used by both the standalone module CLI and the unified entry point, which is
 * why it is a function over a parser rather than a parser of its own.
 */
export function addArguments(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--role"],
    dest: "role",
    required: true,
    help: "worker role name (e.g. default, claude-org-self-edit, doc-audit)",
  });
  parser.addArgument({
    optionStrings: ["--worker-dir"],
    dest: "worker_dir",
    required: true,
    metavar: "WORKER_DIR",
    help: "absolute path that {worker_dir} resolves to",
  });
  parser.addArgument({
    optionStrings: ["--claude-org-path"],
    dest: "claude_org_path",
    required: true,
    metavar: "CLAUDE_ORG_PATH",
    help: "absolute path to the claude-org repo (for hook script paths)",
  });
  parser.addArgument({
    optionStrings: ["--out"],
    dest: "out",
    help: "output file (default: stdout)",
  });
  parser.addArgument({
    optionStrings: ["--schema"],
    dest: "schema",
    help: "schema path override (default: bundled role_configs_schema.json)",
  });
  parser.addArgument({
    optionStrings: ["--role-kind"],
    dest: "role_kind",
    // `choices=sorted(_ROLE_KIND_TO_SCHEMA_KEY)`, so the invalid-choice message
    // lists them in the same order the source does.
    choices: [...ROLE_KIND_TO_SCHEMA_KEY.keys()].sort(),
    defaultValue: "worker",
    metavar: "ROLE_KIND",
    help:
      "schema bucket to look up the role in: 'worker' (default, " +
      "schema['worker_roles']) or 'org' (schema['roles'], for " +
      "secretary / dispatcher / curator). NOTE: 'org' is supported " +
      "by `settings show` for inspection only - `settings generate " +
      "--role-kind org` is rejected because org settings.local.json " +
      "files are hand-maintained.",
  });
  parser.addArgument({
    optionStrings: ["--base-clone"],
    dest: "base_clone",
    metavar: "BASE_CLONE",
    help:
      "Pattern B context: substituted as {base_clone} in entry " +
      "paths and additionalDirectories before realpath evaluation.",
  });
  parser.addArgument({
    optionStrings: ["--task-id"],
    dest: "task_id",
    metavar: "TASK_ID",
    help: "Pattern B context: substituted as {task_id}.",
  });
  parser.addArgument({
    optionStrings: ["--branch-ref"],
    dest: "branch_ref",
    metavar: "BRANCH_REF",
    help: "Pattern B context: substituted as {branch_ref}.",
  });
  parser.addArgument({
    optionStrings: ["--pattern"],
    dest: "pattern",
    choices: [...VALID_PATTERNS],
    help:
      "Dispatch pattern (A|B|C). Required when the selected role " +
      "declares 'sandbox_by_pattern' - the renderer then forwards " +
      "sandbox_by_pattern[<pattern>] as the role's sandbox surface. " +
      "For legacy roles using the single 'sandbox' shape this stays " +
      "informational and is ignored by the renderer.",
  });
}

/** `generator.add_show_arguments`. */
export function addShowArguments(parser: ArgumentParser): void {
  addArguments(parser);
  parser.addArgument({
    optionStrings: ["--explain"],
    dest: "explain",
    storeTrue: true,
    help:
      "Include sandbox suppression metadata (Phase 3 case E) in the " +
      "output. Without --explain only the rendered settings are shown.",
  });
  parser.addArgument({
    optionStrings: ["--json"],
    dest: "json",
    storeTrue: true,
    help: "Emit machine-readable JSON instead of the human-readable text.",
  });
}

/** `generator.build_parser`. */
export function buildParser(): ArgumentParser {
  const parser = new ArgumentParser(
    "claude-org-runtime-settings",
    "Generate <worker_dir>/.claude/settings.local.json from " +
      "role_configs_schema.json -> worker_roles[<role>].",
  );
  addArguments(parser);
  return parser;
}

/** `claude_org_runtime.cli.build_parser`, restricted to `settings`. */
export function buildRuntimeParser(): ArgumentParser {
  const parser = new ArgumentParser(
    "claude-org-runtime",
    "claude-org runtime: fencing, control plane, measurement harness, " +
      "settings generator, state-schema migrate.",
  );
  const sub = parser.addSubparsers("command");
  const settings = sub.addParser("settings", "Worker settings.local.json generator");
  const settingsSub = settings.addSubparsers("cmd");
  const generate = settingsSub.addParser(
    "generate",
    "Render a per-role settings.local.json from the bundled schema.",
  );
  addArguments(generate);
  generate.setDefaults({ func: (args: Namespace) => run(args as unknown as SettingsArgs) });
  const show = settingsSub.addParser(
    "show",
    "Show the rendered settings for a role; with --explain also the sandbox suppression metadata.",
  );
  addShowArguments(show);
  show.setDefaults({ func: (args: Namespace) => runShow(args as unknown as SettingsArgs) });
  return parser;
}

/**
 * `generator.main`.
 *
 * `parse_args` raising `SystemExit` is NOT caught here, because the source does
 * not catch it either: the ported case asserts `info.value.code != 0`, which is
 * an argparse exit escaping `main`, not a return value.
 */
export function main(argv: readonly string[], streams: ArgparseStreams = defaultStreams()): number {
  const parser = buildParser();
  const args = parser.parseArgs(argv, streams);
  return run(args as unknown as SettingsArgs);
}
