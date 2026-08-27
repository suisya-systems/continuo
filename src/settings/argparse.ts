/**
 * `argparse`, for the settings CLI's option set.
 *
 * ## Why a second transcription, and not the one `hook.mjs` already has
 *
 * `src/fencing/hook.mjs` carries a full transcription of CPython's
 * `_parse_known_args` / `_parse_optional` / `_get_option_tuples` /
 * `_match_argument`, measured against CPython 3.12.3 at **0 divergences over
 * 5,332 argv vectors** (`DECISIONS.md` D-0207). Generalising that file's parser
 * to serve this one would put the fence's argv surface -- the surface whose
 * only fail-open instance is what made D-0207 reject a waiver -- behind a
 * helper written for a different caller's needs. That is precisely the shape
 * `docs/test-translation-conventions.md` rule 11 names: a generalisation
 * replacing N copies is new code that acquires input classes none of the copies
 * had, and it would acquire them in the one file where a wrong answer means a
 * denied call was permitted. The hook is left alone.
 *
 * ## What this is, and what it is not
 *
 * It is the same two-pass STRUCTURE -- classify every token, then consume --
 * because that shape is what makes `-h --=` a usage error rather than a help
 * print, and a single eager sweep gets that wrong. It covers what the settings
 * CLI declares: long options with one argument or none, `--opt=value`, prefix
 * abbreviation with the ambiguity report, `choices`, `required`, `--`, the
 * auto-added `-h`/`--help`, and one level of subparsers.
 *
 * What it deliberately does NOT model, because this CLI declares none of them
 * and an unexercised branch is a branch nobody checked: positionals other than
 * the subcommand, `nargs` other than 0 and 1, short options that take an
 * argument, option strings that look like negative numbers (so
 * `_negative_number_matcher` and `_has_negative_number_optionals` have no
 * subject), `type=` conversion failures, and mutually exclusive groups. Each of
 * those is a `throw`, not a silent fallthrough, wherever the parser could reach
 * it.
 *
 * Exit is modelled as {@link ArgparseExit} rather than `process.exit`, because
 * the source's `main` does not catch `SystemExit` either -- the ported case
 * asserts `info.value.code != 0`, which is an exception with a code, not a dead
 * process.
 */

/** `SystemExit`, as raised by `parser.exit()` and `parser.error()`. */
export class ArgparseExit extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ArgparseExit";
    this.code = code;
    Object.setPrototypeOf(this, ArgparseExit.prototype);
  }
}

/** One `add_argument` declaration, narrowed to the forms this CLI uses. */
export interface ArgumentSpec {
  /** `option_strings`, in the order `add_argument` received them. */
  readonly optionStrings: readonly string[];
  /** `dest`, spelled as the namespace key. */
  readonly dest: string;
  /** `action="store_true"` when true; `action="store"` otherwise. */
  readonly storeTrue?: boolean;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  /** `default=`. `undefined` means the argparse default of `None`. */
  readonly defaultValue?: unknown;
  readonly help: string;
  /** Placeholder in the usage line; argparse derives it from `dest`. */
  readonly metavar?: string;
}

/** The parsed namespace. `func` is `set_defaults(func=...)`. */
export interface Namespace {
  [key: string]: unknown;
  func?: (args: Namespace) => number;
}

/** Where a written line goes, so a test can read it (`sys.stdout` is patchable). */
export interface ArgparseStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** `argparse._parse_optional`'s four-tuple, minus the separator it never reads twice. */
interface ClassifiedToken {
  /** `null` is argparse's "looks like an option, but this parser has no such one". */
  readonly spec: ArgumentSpec | null;
  readonly optionString: string;
  readonly explicit: string | null;
}

const HELP_SPEC: ArgumentSpec = {
  optionStrings: ["-h", "--help"],
  dest: "help",
  storeTrue: true,
  help: "show this help message and exit",
};

export class ArgumentParser {
  readonly prog: string;
  readonly description: string;
  readonly #specs: ArgumentSpec[] = [];
  /** `parser._option_string_actions`, in insertion order -- see the note below. */
  readonly #optionStrings: [string, ArgumentSpec][] = [];
  readonly #defaults: Record<string, unknown> = {};
  #subparsers: { readonly dest: string; readonly parsers: Map<string, ArgumentParser> } | null =
    null;

  constructor(prog: string, description: string) {
    this.prog = prog;
    this.description = description;
    // argparse adds `-h`/`--help` first, so it is first in the usage line and
    // first among the candidates of an ambiguous abbreviation.
    this.addArgument(HELP_SPEC);
  }

  addArgument(spec: ArgumentSpec): void {
    this.#specs.push(spec);
    for (const optionString of spec.optionStrings) {
      this.#optionStrings.push([optionString, spec]);
    }
  }

  setDefaults(values: Readonly<Record<string, unknown>>): void {
    Object.assign(this.#defaults, values);
  }

  addSubparsers(dest: string): {
    addParser: (name: string, description: string) => ArgumentParser;
  } {
    const parsers = new Map<string, ArgumentParser>();
    this.#subparsers = { dest, parsers };
    return {
      addParser: (name: string, description: string): ArgumentParser => {
        const child = new ArgumentParser(`${this.prog} ${name}`, description);
        parsers.set(name, child);
        return child;
      },
    };
  }

  /** `parser.format_usage()`, for the line every error prints first. */
  usage(): string {
    const parts: string[] = [];
    for (const spec of this.#specs) {
      const flag = spec.optionStrings[0] as string;
      const body = spec.storeTrue === true ? flag : `${flag} ${this.#metavar(spec)}`;
      parts.push(spec.required === true ? body : `[${body}]`);
    }
    if (this.#subparsers !== null) {
      parts.push(`{${[...this.#subparsers.parsers.keys()].join(",")}} ...`);
    }
    return `usage: ${this.prog} ${parts.join(" ")}\n`;
  }

  /** `parser.format_help()`. */
  help(): string {
    const lines = [this.usage(), "", `${this.description}`, "", "options:"];
    for (const spec of this.#specs) {
      const flag = spec.optionStrings.join(", ");
      const body = spec.storeTrue === true ? flag : `${flag} ${this.#metavar(spec)}`;
      lines.push(`  ${body}`, `      ${spec.help}`);
    }
    if (this.#subparsers !== null) {
      lines.push("", "subcommands:");
      for (const [name, parser] of this.#subparsers.parsers) {
        lines.push(`  ${name}`, `      ${parser.description}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  #metavar(spec: ArgumentSpec): string {
    return spec.metavar ?? spec.dest.toUpperCase();
  }

  /** `parser.error(message)`: usage to stderr, then exit 2. */
  #error(streams: ArgparseStreams, message: string): never {
    streams.stderr(this.usage());
    streams.stderr(`${this.prog}: error: ${message}\n`);
    throw new ArgparseExit(2, message);
  }

  /**
   * `argparse._get_option_tuples`: every option string this token could
   * abbreviate.
   *
   * Order follows `#optionStrings`, which is insertion order, because that
   * fixes the order of the candidates in an `ambiguous option` message exactly
   * as CPython's insertion-ordered dict does.
   */
  #optionTuples(
    token: string,
  ): { spec: ArgumentSpec; optionString: string; explicit: string | null }[] {
    const result: { spec: ArgumentSpec; optionString: string; explicit: string | null }[] = [];
    if (token[1] === "-") {
      const equals = token.indexOf("=");
      const prefix = equals === -1 ? token : token.slice(0, equals);
      const explicit = equals === -1 ? null : token.slice(equals + 1);
      for (const [optionString, spec] of this.#optionStrings) {
        if (optionString.startsWith(prefix)) {
          result.push({ spec, optionString, explicit });
        }
      }
      return result;
    }
    // `-x...`: the first two characters are tried as a complete option string
    // before the whole token is tried as a long-option prefix.
    const shortPrefix = token.slice(0, 2);
    const shortExplicit = token.slice(2);
    for (const [optionString, spec] of this.#optionStrings) {
      if (optionString === shortPrefix) {
        result.push({ spec, optionString, explicit: shortExplicit === "" ? null : shortExplicit });
      } else if (optionString.startsWith(token)) {
        result.push({ spec, optionString, explicit: null });
      }
    }
    return result;
  }

  /**
   * `argparse._parse_optional`: is this token an option, and if so which one?
   *
   * `null` means the token is a value. A `spec` of `null` inside a result is
   * argparse's "looks like an option, this parser has no such option" tuple:
   * still classified as an option, so it swallows nothing that follows it and
   * is reported at end-of-parse as an extra.
   */
  #classify(streams: ArgparseStreams, token: string): ClassifiedToken | null {
    if (token === "" || !token.startsWith("-")) {
      return null;
    }
    for (const [optionString, spec] of this.#optionStrings) {
      if (optionString === token) {
        return { spec, optionString: token, explicit: null };
      }
    }
    if (token.length === 1) {
      return null;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      const head = token.slice(0, equals);
      for (const [optionString, spec] of this.#optionStrings) {
        if (optionString === head) {
          return { spec, optionString: head, explicit: token.slice(equals + 1) };
        }
      }
    }
    const tuples = this.#optionTuples(token);
    if (tuples.length > 1) {
      const names = tuples.map((tuple) => tuple.optionString).join(", ");
      this.#error(streams, `ambiguous option: ${token} could match ${names}`);
    }
    if (tuples.length === 1) {
      const only = tuples[0] as {
        spec: ArgumentSpec;
        optionString: string;
        explicit: string | null;
      };
      return only;
    }
    // A token containing a space is a negative-number-ish value to argparse.
    if (token.includes(" ")) {
      return null;
    }
    return { spec: null, optionString: token, explicit: null };
  }

  parseArgs(argv: readonly string[], streams: ArgparseStreams): Namespace {
    const namespace: Namespace = { ...this.#defaults };
    for (const spec of this.#specs) {
      if (spec === HELP_SPEC) {
        continue;
      }
      namespace[spec.dest] = spec.storeTrue === true ? false : (spec.defaultValue ?? null);
    }

    // Pass 1: classify every token before any of them is acted on.
    const tokens = [...argv];
    const classified = new Map<number, ClassifiedToken | null>();
    // argparse removes the FIRST `--` and treats every later one as an
    // ordinary value, so the index is remembered rather than the token.
    let firstDoubleDash = -1;
    for (const [index, token] of tokens.entries()) {
      if (firstDoubleDash !== -1) {
        classified.set(index, null);
        continue;
      }
      if (token === "--") {
        firstDoubleDash = index;
        classified.set(index, null);
        continue;
      }
      classified.set(index, this.#classify(streams, token));
    }

    // Pass 2: consume.
    const seen = new Set<string>();
    const extras: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index] as string;
      if (index === firstDoubleDash) {
        index += 1;
        continue;
      }
      const option = classified.get(index) ?? null;
      if (option === null) {
        if (this.#subparsers !== null) {
          // `nargs=PARSER`: the subcommand token and everything after it goes
          // to the child, which is why a misspelled option AFTER the
          // subcommand is the child's error and not this parser's.
          const child = this.#subparsers.parsers.get(token);
          if (child === undefined) {
            const names = [...this.#subparsers.parsers.keys()].map((n) => `'${n}'`).join(", ");
            this.#error(
              streams,
              `argument ${this.#subparsers.dest}: invalid choice: '${token}' (choose from ${names})`,
            );
          }
          namespace[this.#subparsers.dest] = token;
          const inner = child.parseArgs(tokens.slice(index + 1), streams);
          return { ...namespace, ...inner };
        }
        extras.push(token);
        index += 1;
        continue;
      }
      if (option.spec === null) {
        extras.push(token);
        index += 1;
        continue;
      }
      const spec = option.spec;
      if (spec === HELP_SPEC) {
        streams.stdout(this.help());
        throw new ArgparseExit(0, "help");
      }
      if (spec.storeTrue === true) {
        if (option.explicit !== null) {
          this.#error(streams, `argument ${option.optionString}: ignored explicit argument`);
        }
        namespace[spec.dest] = true;
        seen.add(spec.dest);
        index += 1;
        continue;
      }
      let value: string;
      if (option.explicit !== null) {
        value = option.explicit;
        index += 1;
      } else {
        const next = index + 1;
        // `_match_argument`: the next token has to exist AND be classified as a
        // value. An option following `--role` is not its argument.
        if (next >= tokens.length || (classified.get(next) ?? null) !== null) {
          this.#error(streams, `argument ${option.optionString}: expected one argument`);
        }
        value = tokens[next] as string;
        index += 2;
      }
      if (spec.choices !== undefined && !spec.choices.includes(value)) {
        const names = spec.choices.map((choice: string) => `'${choice}'`).join(", ");
        this.#error(
          streams,
          `argument ${option.optionString}: invalid choice: '${value}' (choose from ${names})`,
        );
      }
      namespace[spec.dest] = value;
      seen.add(spec.dest);
    }

    // End of parse: required actions, then all extras -- in that order, and
    // both AFTER consumption, which is what makes a missing `--role` outrank a
    // stray positional.
    const missing = this.#specs
      .filter((spec) => spec.required === true && !seen.has(spec.dest))
      .map((spec) => spec.optionStrings[0] as string);
    if (missing.length > 0) {
      this.#error(streams, `the following arguments are required: ${missing.join(", ")}`);
    }
    if (this.#subparsers !== null) {
      this.#error(streams, `the following arguments are required: ${this.#subparsers.dest}`);
    }
    if (extras.length > 0) {
      this.#error(streams, `unrecognized arguments: ${extras.join(" ")}`);
    }
    return namespace;
  }
}
