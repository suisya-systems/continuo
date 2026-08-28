/**
 * The small argument parser the two CLI modules share.
 *
 * Python's `argparse` is a standard-library module; Node has no equivalent, and
 * `node:util`'s `parseArgs` deliberately stops short of the two things the
 * ported CLI is built on -- subcommands and generated `--help`. So this module
 * exists, and it exists **only** to carry the surface `measurement/cli.ts` and
 * `cli.ts` actually use (`D-0112`). It is not an argparse port: no positional
 * arguments, no prefix matching, no `nargs`, no argument groups, no `argv[0]`
 * inference of `prog`.
 *
 * Two properties of `argparse` are load-bearing for the ported cases and are
 * therefore reproduced deliberately rather than incidentally:
 *
 * **The parser is introspectable.** Interlock's suite walks `parser._actions`
 * and a subparsers action's `choices` to collect *every* help string reachable
 * from a parser, and asserts each one survives a cp932 console. A check written
 * against a hand-kept list of strings would police the strings whoever wrote it
 * remembered; the walk polices the ones that exist. {@link helpStrings} is that
 * walk, and it is part of this module rather than of the test so that the
 * traversal and the structure it traverses cannot drift apart.
 *
 * **`--help` writes and stops.** `argparse` raises `SystemExit(0)`; a parser
 * that returned a namespace with nothing in it would run the command with no
 * arguments instead. {@link HelpRequested} is that stop, carried as a value so
 * the boundary that owns stdout is the one that writes it -- there is no
 * `process.exit` in this module, because a library that exits cannot be tested
 * in-process and a test that spawns a subprocess for every case is a test nobody
 * runs.
 *
 * **ASCII only**, in this file as in the CLI modules it serves: every string
 * here reaches `--help` on a cp932 console, where a character the console cannot
 * encode is a crash rather than a smudge.
 */

/** Raised for a command line this parser cannot accept. */
export class UsageError extends Error {
  /** The parser's usage text, so the boundary can print it beside the reason. */
  readonly usage: string;

  constructor(message: string, usage: string) {
    super(message);
    this.name = "UsageError";
    this.usage = usage;
  }
}

/**
 * Thrown when `-h`/`--help` was given: the text to print, and nothing else.
 *
 * A sentinel rather than a return value, because every caller between the flag
 * and the boundary would otherwise have to remember to check for it, and the one
 * that forgot would run the command.
 */
export class HelpRequested extends Error {
  readonly text: string;

  constructor(text: string) {
    super("help requested");
    this.name = "HelpRequested";
    this.text = text;
  }
}

/** Thrown when a `version` flag was given: the text to print, and nothing else. */
export class VersionRequested extends Error {
  readonly text: string;

  constructor(text: string) {
    super("version requested");
    this.name = "VersionRequested";
    this.text = text;
  }
}

/** One `--flag` this parser accepts. */
export interface OptionSpec {
  /** The long flag as an operator types it, `--period-start-ms`. */
  readonly flag: string;
  /**
   * `value` (the default) takes the next token; `version` takes none and stops
   * the parse the way `--help` does.
   *
   * Two kinds and no more. `argparse` has a dozen actions and this port needs
   * exactly the two the source's parsers use, so the rest are absent rather
   * than written speculatively (`D-0112`).
   */
  readonly kind?: "value" | "version";
  /** The help string. Reaches `--help`; ASCII only. */
  readonly help: string;
  /** Refuse a command line that omits this flag. */
  readonly required?: boolean;
  /**
   * `int` parses with the same rule Python's `type=int` applies, and refuses
   * anything else rather than handing on a `NaN` -- see {@link parseInteger}.
   */
  readonly type?: "string" | "int";
  /** The accepted values, refused by name when the given one is not among them. */
  readonly choices?: readonly string[];
  /** The value when the flag is absent. Defaults to `null`. */
  readonly fallback?: string | number | null;
  /** What a `version` flag prints. Ignored by every other kind. */
  readonly version?: string;
}

/** The parsed command line: one property per flag, plus the resolved handler. */
export interface Namespace {
  [key: string]: unknown;
}

/**
 * `--period-start-ms` becomes `periodStartMs`.
 *
 * The source reaches its parsed values as `args.period_start_ms`; the port's
 * naming convention is camel case, and the mapping is done here, once, rather
 * than by every reader spelling out a string key.
 */
export function destinationOf(flag: string): string {
  const bare = flag.replace(/^--/, "");
  return bare.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Python's `int(text)`, near enough for a flag an operator typed.
 *
 * `Number(text)` is the mapping to reach for and it is wrong three ways that all
 * arrive silently: it accepts `1.5`, it accepts `0x10`, and it turns the empty
 * string into `0`. A period boundary that is quietly `0` is the epoch, and every
 * window check below would compare against it without complaint.
 */
function parseInteger(flag: string, text: string, usage: string): number {
  if (!/^[+-]?\d+$/.test(text.trim())) {
    throw new UsageError(`${flag} takes an integer, got '${text}'`, usage);
  }
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value)) {
    throw new UsageError(
      `${flag} takes an integer this runtime can hold exactly, got '${text}'`,
      usage,
    );
  }
  return value;
}

/** A subcommand table: the `choices` a source case walks to reach nested help. */
export class Subparsers {
  readonly parsers = new Map<string, ArgumentParser>();
  private readonly parent: ArgumentParser;

  constructor(parent: ArgumentParser) {
    this.parent = parent;
  }

  /** Mount a subcommand and return its parser. */
  addParser(name: string, options: { readonly help: string }): ArgumentParser {
    if (this.parsers.has(name)) {
      throw new Error(`the subcommand '${name}' is mounted twice`);
    }
    const parser = new ArgumentParser({
      prog: `${this.parent.prog} ${name}`,
      description: options.help,
    });
    this.parsers.set(name, parser);
    return parser;
  }
}

/** A parser for one command or subcommand. */
export class ArgumentParser {
  readonly prog: string;
  readonly description: string;
  readonly options: OptionSpec[] = [];
  subparsers: Subparsers | null = null;

  private defaults: Namespace = {};

  constructor(fields: { readonly prog: string; readonly description: string }) {
    this.prog = fields.prog;
    this.description = fields.description;
  }

  addArgument(spec: OptionSpec): void {
    if (!spec.flag.startsWith("--")) {
      throw new Error(`${spec.flag} is not a long flag; this parser takes no others`);
    }
    this.options.push(spec);
  }

  /** Mount a required subcommand table. */
  addSubparsers(): Subparsers {
    if (this.subparsers !== null) {
      throw new Error(`${this.prog} already has a subcommand table`);
    }
    this.subparsers = new Subparsers(this);
    return this.subparsers;
  }

  /** Values that reach the namespace without an operator naming them. */
  setDefaults(values: Namespace): void {
    this.defaults = { ...this.defaults, ...values };
  }

  /** The `--help` text: the usage line, the description, then every flag. */
  formatHelp(): string {
    const lines = [this.formatUsage(), "", this.description, ""];
    if (this.subparsers !== null) {
      lines.push("commands:");
      for (const [name, parser] of this.subparsers.parsers) {
        lines.push(`  ${name}`);
        lines.push(...wrap(parser.description, 4));
      }
      lines.push("");
    }
    lines.push("options:");
    lines.push("  -h, --help");
    lines.push(...wrap("show this help message and exit", 4));
    for (const option of this.options) {
      lines.push(`  ${option.flag} ${placeholderFor(option)}`.trimEnd());
      lines.push(...wrap(option.help, 4));
    }
    return `${lines.join("\n")}\n`;
  }

  /** The one-line usage, used by `--help` and by every refusal. */
  formatUsage(): string {
    const parts = [`usage: ${this.prog}`];
    for (const option of this.options) {
      const body = `${option.flag} ${placeholderFor(option)}`.trimEnd();
      parts.push(option.required === true ? body : `[${body}]`);
    }
    if (this.subparsers !== null) {
      parts.push(`{${[...this.subparsers.parsers.keys()].join(",")}} ...`);
    }
    // Wrapped, because this line is as long as the flag list and a console that
    // soft-wraps it mid-flag is where an operator misreads which value belongs
    // to which name.
    const head = parts[0] as string;
    const margin = " ".repeat("usage: ".length);
    const lines: string[] = [head];
    for (const part of parts.slice(1)) {
      const last = lines[lines.length - 1] as string;
      if (last.length + 1 + part.length <= 79) {
        lines[lines.length - 1] = `${last} ${part}`;
      } else {
        lines.push(margin + part);
      }
    }
    return lines.join("\n");
  }

  /**
   * Parse `argv` into a namespace, or refuse it.
   *
   * @throws {HelpRequested} `-h` or `--help` appeared; the text is on the error.
   * @throws {UsageError} anything this parser does not accept.
   */
  parseArgs(argv: readonly string[]): Namespace {
    const usage = this.formatUsage();
    const namespace: Namespace = { ...this.defaults };
    for (const option of this.options) {
      namespace[destinationOf(option.flag)] = option.fallback ?? null;
    }

    const byFlag = new Map(this.options.map((option) => [option.flag, option]));
    const seen = new Set<string>();
    let index = 0;
    while (index < argv.length) {
      const token = argv[index] as string;
      if (token === "-h" || token === "--help") {
        // Checked inside the loop rather than over the whole of `argv`, because
        // `--help` after a subcommand name belongs to the subcommand: a scan of
        // the whole array would answer `measure report --help` with the
        // top-level help, which is the one screen that does not list the flags
        // the operator was asking about.
        throw new HelpRequested(this.formatHelp());
      }
      if (!token.startsWith("--")) {
        break;
      }
      const option = byFlag.get(token);
      if (option === undefined) {
        throw new UsageError(`unrecognized argument: ${token}`, usage);
      }
      if (option.kind === "version") {
        throw new VersionRequested(`${option.version ?? ""}\n`);
      }
      const raw = argv[index + 1];
      if (raw === undefined) {
        throw new UsageError(`${token} expects a value`, usage);
      }
      if (seen.has(token)) {
        // argparse silently keeps the last one. Refused here instead: a command
        // line that names one flag twice with two values is one whose author
        // believes something about it that is not true, and the report it would
        // produce carries no sign of which half won.
        throw new UsageError(`${token} is given more than once`, usage);
      }
      seen.add(token);
      namespace[destinationOf(token)] = coerce(option, raw, usage);
      index += 2;
    }

    for (const option of this.options) {
      if (option.required === true && !seen.has(option.flag)) {
        throw new UsageError(`the following argument is required: ${option.flag}`, usage);
      }
    }

    const rest = argv.slice(index);
    if (this.subparsers === null) {
      if (rest.length > 0) {
        throw new UsageError(`unrecognized arguments: ${rest.join(" ")}`, usage);
      }
      return namespace;
    }

    const name = rest[0];
    if (name === undefined) {
      throw new UsageError(
        `a command is required: ${[...this.subparsers.parsers.keys()].join(", ")}`,
        usage,
      );
    }
    const child = this.subparsers.parsers.get(name);
    if (child === undefined) {
      throw new UsageError(
        `invalid choice: '${name}' (choose from ` +
          `${[...this.subparsers.parsers.keys()].join(", ")})`,
        usage,
      );
    }
    return { ...namespace, ...child.parseArgs(rest.slice(1)) };
  }
}

function coerce(option: OptionSpec, raw: string, usage: string): string | number {
  if (option.choices !== undefined && !option.choices.includes(raw)) {
    throw new UsageError(
      `${option.flag}: invalid choice: '${raw}' (choose from ${option.choices.join(", ")})`,
      usage,
    );
  }
  return option.type === "int" ? parseInteger(option.flag, raw, usage) : raw;
}

function placeholderFor(option: OptionSpec): string {
  if (option.kind === "version") {
    return "";
  }
  if (option.choices !== undefined) {
    return `{${option.choices.join(",")}}`;
  }
  return destinationOf(option.flag).toUpperCase();
}

function wrap(text: string, indent: number): string[] {
  const margin = " ".repeat(indent);
  const width = 79 - indent;
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(margin + current);
      current = word;
    }
  }
  if (current !== "") {
    lines.push(margin + current);
  }
  return lines;
}

/**
 * Every help and description string reachable from `parser`.
 *
 * The port of the source suite's `_help_strings`, which walks `parser._actions`
 * and recurses into a subparsers action's `choices`. It lives here rather than
 * in the test because it is a traversal of *this* module's structure: a parser
 * that grew a third place to keep a string would need the walk updated, and a
 * walk kept next to the structure is one a reader of that structure can see.
 */
export function helpStrings(parser: ArgumentParser): string[] {
  const found: string[] = [parser.description, parser.prog];
  for (const option of parser.options) {
    found.push(option.help);
  }
  if (parser.subparsers !== null) {
    for (const child of parser.subparsers.parsers.values()) {
      found.push(...helpStrings(child));
    }
  }
  return found;
}

/**
 * Run `parser` over `argv`, writing help or a refusal to the right stream.
 *
 * The exit codes are `argparse`'s: 0 when the command ran or `--help` printed,
 * 2 for a command line the parser refused.
 */
export function dispatch(
  parser: ArgumentParser,
  argv: readonly string[],
  streams: { readonly out: (text: string) => void; readonly err: (text: string) => void },
): number {
  let args: Namespace;
  try {
    args = parser.parseArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested || error instanceof VersionRequested) {
      streams.out(error.text);
      return 0;
    }
    if (error instanceof UsageError) {
      streams.err(`${error.usage}\n${parser.prog}: error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const func = args["func"];
  if (typeof func !== "function") {
    throw new Error(`${parser.prog}: the parsed command names no handler`);
  }
  return (func as (values: Namespace) => number)(args);
}
