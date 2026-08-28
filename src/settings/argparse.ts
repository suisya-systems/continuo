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
 * argument, `type=` conversion failures, and mutually exclusive groups.
 *
 * `_negative_number_matcher` IS modelled, and the first draft of this file said
 * it had no subject -- a misreading worth recording, because it is the kind that
 * looks like scoping. The matcher's subject is the ARGUMENT token (`--out -1`),
 * not the option strings; what the option strings decide is
 * `_has_negative_number_optionals`, the CONDITION under which argparse honours
 * it. This parser declares none that look like a number, so the condition holds
 * and the matcher is live: without it `--out -1` is classified as an unknown
 * option and `--out` fails with `expected one argument`, where CPython accepts
 * `-1` as the filename. Measured against CPython 3.12.3 on this parser: `-1`,
 * `-1.5` and `-` are values; `-x`, `-12abc` and `--1` are not.
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
  /**
   * `action="store_false"`.
   *
   * Its own flag, not `storeTrue` with an inverted constant, because the two
   * differ in their DEFAULT as well as in what they store: argparse's
   * `_StoreFalseAction` defaults to `True`. Collapsing them would leave
   * `--no-probe-bwrap` defaulting to `false` -- the live bwrap canary silently
   * off for every run that did not ask to turn it off, which is the direction
   * that reports a clean preflight it never performed.
   */
  readonly storeFalse?: boolean;
  /**
   * `action="append"`.
   *
   * `_AppendAction` starts from `_copy_items(None) == []`, so an unpassed
   * appending option is `None` and a passed one is a list -- never a bare
   * string. `--settings` is `required=True`, so the `None` case cannot reach
   * `run`; the shape is still modelled rather than flattened, because `run`
   * itself accepts both (the source's own `if not isinstance(requested, list)`)
   * and a parser that could only ever produce one of them would make that
   * branch untestable through the parser.
   */
  readonly append?: boolean;
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

/**
 * `argparse._negative_number_matcher`, transcribed.
 *
 * Python's `\d` on a `str` pattern is the Unicode category `Nd`, not `[0-9]`,
 * so it is spelled `\p{Nd}` here -- the same equivalence `pyregex.ts` documents
 * and `hook.mjs` carries for the identical reason.
 */
const NEGATIVE_NUMBER = /^-\p{Nd}+$|^-\p{Nd}*\.\p{Nd}+$/u;

/**
 * Whether the action consumes a following token.
 *
 * `store_true` and `store_false` are both `nargs=0`. Asking this question in
 * one place is what keeps the usage line, the help body and the consumption
 * loop from disagreeing -- an earlier draft answered it three times and a
 * `store_false` flag rendered as `--no-probe-bwrap PROBE_BWRAP` in `--help`
 * while parsing correctly, so nothing went red.
 */
function takesNoArgument(spec: ArgumentSpec): boolean {
  return spec.storeTrue === true || spec.storeFalse === true;
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
      const body = takesNoArgument(spec) ? flag : `${flag} ${this.#metavar(spec)}`;
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
      const body = takesNoArgument(spec) ? flag : `${flag} ${this.#metavar(spec)}`;
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
   * `parser._has_negative_number_optionals`: does any DECLARED option string
   * look like a negative number?
   *
   * Derived rather than asserted false, because it is the condition the matcher
   * is gated on, and a later `--1`-shaped flag would have to turn it off.
   */
  #hasNegativeNumberOptionals(): boolean {
    return this.#optionStrings.some(([optionString]) => NEGATIVE_NUMBER.test(optionString));
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
    // `if self._negative_number_matcher.match(arg_string): if not
    // self._has_negative_number_optionals: return None` -- and it runs BEFORE
    // the space test, which is the order CPython runs them in.
    if (NEGATIVE_NUMBER.test(token) && !this.#hasNegativeNumberOptionals()) {
      return null;
    }
    // A token containing a space is a value to argparse.
    if (token.includes(" ")) {
      return null;
    }
    return { spec: null, optionString: token, explicit: null };
  }

  /**
   * `parser.parse_args`: `parse_known_args`, then report the leftovers.
   *
   * The split is not decoration. A subparser action puts the tokens IT could
   * not place into `namespace._UNRECOGNIZED_ARGS_ATTR`, and it is the ROOT
   * `parse_args` that reports them -- which is why CPython answers
   * `claude-org-runtime --bogus settings generate ...` with
   * `claude-org-runtime: error: unrecognized arguments: --bogus` (measured),
   * naming the root's prog for an extra found on either side of the subcommand.
   * Reporting extras inside `#parseKnown` instead would let the subparser path
   * return before the check ever ran, and an unknown option ahead of a valid
   * subcommand would then be silently ignored -- the CLI would generate a
   * settings file for a command line it did not understand.
   */
  parseArgs(argv: readonly string[], streams: ArgparseStreams): Namespace {
    const [namespace, extras] = this.#parseKnown(argv, streams);
    if (extras.length > 0) {
      this.#error(streams, `unrecognized arguments: ${extras.join(" ")}`);
    }
    return namespace;
  }

  /** `parser.parse_known_args`: the namespace, and what it could not place. */
  #parseKnown(
    argv: readonly string[],
    streams: ArgparseStreams,
  ): [namespace: Namespace, extras: string[]] {
    const namespace: Namespace = { ...this.#defaults };
    for (const spec of this.#specs) {
      if (spec === HELP_SPEC) {
        continue;
      }
      if (spec.storeTrue === true) {
        namespace[spec.dest] = false;
      } else if (spec.storeFalse === true) {
        // `_StoreFalseAction`'s default is `True`; the source spells it out at
        // both call sites, and so does this, so a spec that forgets it is a
        // missing `defaultValue` rather than a silent `null`.
        namespace[spec.dest] = spec.defaultValue ?? true;
      } else {
        namespace[spec.dest] = spec.defaultValue ?? null;
      }
    }

    // Pass 1: classify every token before any of them is acted on.
    const tokens = [...argv];
    const classified = new Map<number, ClassifiedToken | null>();
    // The first `--` stops option classification; every later one is an
    // ordinary value, so the INDEX is remembered rather than the token.
    //
    // What is NOT done here is remove it. `_get_values` drops the separator
    // only when a POSITIONAL consumed it, and this parser declares none except
    // the subcommand -- whose `nargs=PARSER` is on the short list `_get_values`
    // does not drop it for. Measured against CPython 3.12.3: a trailing `--` is
    // `unrecognized arguments: --`, and `claude-org-runtime -- settings` is
    // `argument command: invalid choice: '--'`. Both fall out of leaving the
    // token in place as an ordinary value; skipping it produced neither.
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
          // The child's own extras travel UP rather than being reported here;
          // the root reports them, with the root's prog. @see parseArgs.
          const [inner, innerExtras] = child.#parseKnown(tokens.slice(index + 1), streams);
          return [{ ...namespace, ...inner }, [...extras, ...innerExtras]];
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
      if (takesNoArgument(spec)) {
        if (option.explicit !== null) {
          this.#error(streams, `argument ${option.optionString}: ignored explicit argument`);
        }
        namespace[spec.dest] = spec.storeTrue === true;
        seen.add(spec.dest);
        index += 1;
        continue;
      }
      let value: string;
      if (option.explicit !== null) {
        value = option.explicit;
        index += 1;
      } else {
        // `_match_argument`. Two things exclude a token from being the value,
        // and both are reachable:
        //
        // - **the `--` separator.** `_get_nargs_pattern` strips the `-` from the
        //   pattern when the action is an OPTIONAL ("if this is an optional
        //   action, `--` is not allowed"), so an optional's argument can never
        //   be the separator -- not even with a value after it. Measured
        //   against CPython 3.12.3 on this parser: `--worker-dir --` and
        //   `--worker-dir -- /wd` are BOTH `expected one argument`. Treating
        //   `--` as an ordinary value instead -- which is what it looks like,
        //   since everything from the separator on is classified as a value --
        //   parses `--worker-dir --` into a worker_dir of `"--"`, and renders a
        //   settings file anchored on a directory nobody named.
        // - **a token classified as an OPTION.** An option following `--role`
        //   is not its argument.
        const next = index + 1;
        if (
          next >= tokens.length ||
          next === firstDoubleDash ||
          (classified.get(next) ?? null) !== null
        ) {
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
      if (spec.append === true) {
        // `_AppendAction`: `_copy_items(getattr(namespace, dest, None))` then
        // `append`. `_copy_items(None)` is `[]`, and the copy is why repeated
        // parses with one shared spec object cannot accumulate into each other.
        const existing = namespace[spec.dest];
        namespace[spec.dest] = [...(Array.isArray(existing) ? existing : []), value];
      } else {
        namespace[spec.dest] = value;
      }
      seen.add(spec.dest);
    }

    // End of parse: required actions here, with THIS parser's prog, because a
    // missing `--role` is the child's error even when the extras are the
    // root's. Measured: `settings show --` reports
    // `claude-org-runtime settings show: error: the following arguments are
    // required: --role, ...` while `--bogus settings generate ...` reports
    // `claude-org-runtime: error: unrecognized arguments: --bogus`.
    const missing = this.#specs
      .filter((spec) => spec.required === true && !seen.has(spec.dest))
      .map((spec) => spec.optionStrings[0] as string);
    if (missing.length > 0) {
      this.#error(streams, `the following arguments are required: ${missing.join(", ")}`);
    }
    if (this.#subparsers !== null) {
      this.#error(streams, `the following arguments are required: ${this.#subparsers.dest}`);
    }
    return [namespace, extras];
  }
}
