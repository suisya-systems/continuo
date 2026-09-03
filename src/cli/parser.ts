/**
 * `argparse`, for the whole of the `continuo` command line.
 *
 * One parser serves the unified CLI (`D-0030`). Two of them landed here from
 * two lanes -- a transcription of CPython's `argparse` written for the settings
 * generator (`D-0213`) and a purpose-built parser written for the measurement
 * harness (`D-0112`) -- and this file is the first, extended with the three
 * argparse features the second needed and this one had not yet had a caller
 * for. `D-0030` records why the transcription is the one that survived and what
 * the other side cost.
 *
 * ## Why a transcription, and not the one `hook.mjs` already has
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
 * print, and a single eager sweep gets that wrong. It covers what the CLI
 * declares: long options with one argument or none, `--opt=value`, prefix
 * abbreviation with the ambiguity report, `choices`, `required`, `type=int`,
 * `action="version"`, `--`, the auto-added `-h`/`--help`, and nested
 * subparsers.
 *
 * What it deliberately does NOT model, because this CLI declares none of them
 * and an unexercised branch is a branch nobody checked: positionals other than
 * the subcommand, `nargs` other than 0 and 1, short options that take an
 * argument, `type=` other than `int`, and mutually exclusive groups.
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
 * `-1.5` and `-` are values; `-x`, `-12abc` and `--1` are not. The measurement
 * harness depends on the same rule for `--grace-ms -1`, which has to reach the
 * window model's refusal rather than the parser's.
 *
 * ## The two places it is deliberately NOT CPython
 *
 * Both come from `D-0112`, both are opt-in per declaration so that nothing the
 * settings and sandbox surfaces are measured against changes, and both are
 * pinned as divergences rather than as parity:
 *
 * - **`type: "int"` accepts ASCII digits only.** Python's `int()` takes any
 *   Unicode decimal digit, so a full-width `12` is `12` there. See
 *   {@link parseInteger} for why decoding it is the wrong repair.
 * - **`refuseRepeat` refuses a flag given twice** where argparse silently keeps
 *   the last value. Declared only on the measurement report's flags, which is
 *   where `D-0112` put it and why: a command line naming one flag twice with
 *   two values is one whose author believes something about it that is not
 *   true, and the report it produces carries no sign of which half won.
 *
 * **ASCII only**, in this file as in the CLI modules it serves: every string
 * here reaches `--help` on a cp932 console, where a character the console
 * cannot encode is a crash rather than a smudge (`D-0113`). {@link helpStrings}
 * is the walk that polices it, and it lives here rather than in the test so
 * that the traversal and the structure it traverses cannot drift apart.
 *
 * Exit is modelled as {@link ArgparseExit} rather than `process.exit`, because
 * the source's `main` does not catch `SystemExit` either -- the ported case
 * asserts `info.value.code != 0`, which is an exception with a code, not a dead
 * process. {@link dispatch} is the one place that turns it back into an exit
 * code, at the process boundary, the way CPython's runtime does.
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
  /**
   * `action="version"`: the text to print, then `SystemExit(0)`.
   *
   * Its own field rather than another boolean, because the action IS its
   * payload. argparse gives the action `default=SUPPRESS`, so a `version` spec
   * puts no key in the namespace at all -- see {@link ArgumentParser.parseArgs}.
   */
  readonly version?: string;
  /**
   * `type=int`.
   *
   * Only `int`, because it is the only converter the ported CLIs declare and an
   * unexercised branch is a branch nobody checked. Applied BEFORE `choices`,
   * which is the order `_get_values` runs `_get_value` and `_check_value` in.
   */
  readonly type?: "int";
  /**
   * Refuse this flag when it is given twice (`D-0112`).
   *
   * **A divergence from argparse, and opt-in for that reason.** argparse keeps
   * the last value silently. Declared only where `D-0112` put it -- the
   * measurement report's flags -- so that the settings and sandbox surfaces,
   * which are measured against CPython, keep answering exactly as CPython does.
   */
  readonly refuseRepeat?: boolean;
}

/** The parsed namespace. `func` is `set_defaults(func=...)`. */
export interface Namespace {
  [key: string]: unknown;
  func?: (args: Namespace) => number;
}

/**
 * `parser.add_subparsers()`'s return, as the mounting modules see it.
 *
 * Named rather than inlined because it is the seam every subtree is mounted
 * through: `measurement/cli.ts` and `settings/cli.ts` each take one of these
 * and hang their own commands off it, so `src/cli.ts` mounts a subtree without
 * knowing any of its flags.
 */
export interface Subparsers {
  addParser: (name: string, description: string) => ArgumentParser;
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
 * `store_true`, `store_false` and `version` are all `nargs=0`. Asking this
 * question in one place is what keeps the usage line, the help body and the
 * consumption loop from disagreeing -- an earlier draft answered it three times
 * and a `store_false` flag rendered as `--no-probe-bwrap PROBE_BWRAP` in
 * `--help` while parsing correctly, so nothing went red.
 */
function takesNoArgument(spec: ArgumentSpec): boolean {
  return spec.storeTrue === true || spec.storeFalse === true || spec.version !== undefined;
}

/**
 * Python's `int(text)`, near enough for a flag an operator typed.
 *
 * `Number(text)` is the mapping to reach for and it is wrong three ways that
 * all arrive silently: it accepts `1.5`, it accepts `0x10`, and it turns the
 * empty string into `0`. A period boundary that is quietly `0` is the epoch,
 * and every window check below it would compare against that without
 * complaint. Measured against CPython 3.12.3: all three are
 * `invalid int value`.
 *
 * `null` means "not an integer by Python's rule"; the caller renders argparse's
 * message. The two refusals this port adds beyond that rule are returned as
 * their own reasons, because a divergence that wore parity's wording would be
 * read as parity.
 */
function parseInteger(text: string): { readonly value: number } | { readonly reason: string } {
  const bare = text.trim();
  // Python's own spelling rule, underscores included: a single underscore is
  // allowed BETWEEN digits and nowhere else, so `1_700_000_000_000` is
  // 1700000000000 and `_1`, `1_` and `1__0` are all errors. Reproduced rather
  // than refused because the source's parser accepts it -- `int("1_0")` is 10 --
  // and a port that refused a command line interlock runs would be wrong in the
  // direction that is hardest to notice: it only fails for the operator who
  // spelled a long timestamp readably. Leading and trailing whitespace is
  // accepted for the same reason: `int(" 12 ")` is 12.
  //
  // **`\d` here is ASCII, deliberately, and this is a divergence** (`D-0112`).
  // Python's `int()` accepts any Unicode decimal digit: a full-width "12"
  // (U+FF11 U+FF12) is 12 there, and so is a Devanagari one (U+0967 U+0968).
  // Refused rather than decoded because the value is an epoch millisecond that
  // the report prints in its header, and a full-width `--period-start-ms` would
  // produce a document saying `12` that the operator cannot get back by copying
  // what they typed. Decoding it correctly needs a Unicode digit-value table --
  // NFKD folds the full-width forms and not the Devanagari ones -- and a table
  // written here would be new code with no source to underwrite it, whose
  // failure mode is a silently wrong number rather than an error (rule 11). The
  // refusal is fail-visible and says which rule it applied, which is the right
  // answer on the Japanese console `D-0113` is about, where an IME left in
  // full-width mode is the likely cause.
  //
  // The digits are named by code point rather than written here because this
  // repository's own ASCII-output contract forbids a non-ASCII byte in this
  // file -- which is the same policy, one layer down.
  if (/^[+-]?\p{Nd}(?:_?\p{Nd})*$/u.test(bare) && !/^[+-]?\d(?:_?\d)*$/.test(bare)) {
    return {
      reason:
        "this port's integer flags take ASCII digits only, where Python's int() takes any Unicode decimal digit",
    };
  }
  if (!/^[+-]?\d(?:_?\d)*$/.test(bare)) {
    return { reason: "" };
  }
  const value = Number(bare.replaceAll("_", ""));
  if (!Number.isSafeInteger(value)) {
    // Python's `int` is arbitrary precision and CPython accepts this; a
    // JavaScript `number` past 2**53 is no longer the integer that was typed.
    // Refused rather than rounded, because the rounded value would be printed
    // in the report's header as though it were the boundary the operator gave
    // (rule 9).
    return {
      reason:
        "this runtime holds integers exactly only up to 2**53-1, where Python's int() is arbitrary precision",
    };
  }
  return { value };
}

/**
 * The column `--help` and the usage line wrap at.
 *
 * Fixed rather than read from the terminal, so that what a case reads does not
 * depend on the window it ran in. 79 is the width the measurement lane's parser
 * used before the consolidation, so no help screen got wider with it.
 */
const WIDTH = 79;

/** Greedy wrap of one help string, indented by `indent` spaces. */
function wrap(text: string, indent: number): string[] {
  const margin = " ".repeat(indent);
  const width = WIDTH - indent;
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

  addSubparsers(dest: string): Subparsers {
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

  /**
   * `parser.format_usage()`, for the line every error prints first.
   *
   * Wrapped, and that is not decoration either. `measure report` declares ten
   * flags with metavars; unwrapped they are a 260-column line, and a console
   * that soft-wraps it mid-flag is where an operator misreads which value
   * belongs to which name. CPython wraps this too, aligning the continuation
   * under the first part.
   *
   * **A simplification, stated as one.** CPython's `_format_usage` groups
   * optionals and positionals and re-wraps each group; this wraps the parts in
   * order at a fixed {@link WIDTH} rather than at the terminal's. No ported
   * case reads the wrapping -- what they read is the first line, which is the
   * same either way -- and a width taken from the terminal would make the
   * output of a test depend on the window it ran in.
   */
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
    const head = `usage: ${this.prog}`;
    const margin = " ".repeat(head.length + 1);
    const lines: string[] = [head];
    for (const part of parts) {
      const last = lines[lines.length - 1] as string;
      if (last.length + 1 + part.length <= WIDTH) {
        lines[lines.length - 1] = `${last} ${part}`;
      } else {
        lines.push(margin + part);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  /** `parser.format_help()`. */
  help(): string {
    // The description is wrapped for the same reason the help bodies are:
    // `_fill_text` wraps it in CPython, this module's own descriptions are one
    // line and the mounted subtrees' are paragraphs, and an unwrapped one is
    // the first thing on the screen.
    const lines = [this.usage(), "", ...wrap(this.description, 0), "", "options:"];
    for (const spec of this.#specs) {
      const flag = spec.optionStrings.join(", ");
      const body = takesNoArgument(spec) ? flag : `${flag} ${this.#metavar(spec)}`;
      lines.push(`  ${body}`, ...wrap(spec.help, 6));
    }
    if (this.#subparsers !== null) {
      lines.push("", "subcommands:");
      for (const [name, parser] of this.#subparsers.parsers) {
        lines.push(`  ${name}`, ...wrap(parser.description, 6));
      }
    }
    return `${lines.join("\n")}\n`;
  }

  /**
   * `_get_action_name` / `_metavar_formatter`: what the usage line calls the
   * value.
   *
   * `choices` renders as `{a,b}` when no `metavar` was declared, which is
   * argparse's own default and not decoration: it is the only place `--help`
   * says what the accepted values ARE. An earlier draft of this transcription
   * answered `dest.toUpperCase()` for every action, so consolidating the
   * measurement CLI onto it would have turned `--fingerprint {aggregate,content}`
   * into `--fingerprint FINGERPRINT` and taken the list off the screen.
   */
  #metavar(spec: ArgumentSpec): string {
    if (spec.metavar !== undefined) {
      return spec.metavar;
    }
    if (spec.choices !== undefined) {
      return `{${spec.choices.join(",")}}`;
    }
    return spec.dest.toUpperCase();
  }

  /**
   * Every help and description string reachable from this parser.
   *
   * The port of the source suite's `_help_strings`, which walks
   * `parser._actions` and recurses into a subparsers action's `choices`. It
   * lives on the parser rather than in the test because it is a traversal of
   * THIS module's structure: a parser that grew a third place to keep a string
   * would need the walk updated, and a walk kept next to the structure is one a
   * reader of that structure can see (`D-0113`).
   *
   * `prog` is collected too, because a subcommand's name reaches `--help` as
   * part of its usage line.
   */
  helpStrings(): string[] {
    const found: string[] = [this.description, this.prog];
    for (const spec of this.#specs) {
      found.push(spec.help);
    }
    if (this.#subparsers !== null) {
      for (const child of this.#subparsers.parsers.values()) {
        found.push(...child.helpStrings());
      }
    }
    return found;
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
      // `-h` and `action="version"` both carry `default=SUPPRESS`, so neither
      // puts a key in the namespace.
      if (spec === HELP_SPEC || spec.version !== undefined) {
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
          // `msg = _('ignored explicit argument %r')`, and `%r` is the value.
          // REPAIRED, not inherited: this transcription dropped the value, so
          // `--version=json` and `--no-probe-bwrap=0` refused without naming
          // what they refused. Measured against CPython 3.12.3:
          // `continuo: error: argument --version: ignored explicit argument 'x'`.
          // `hook.mjs` -- the 0-divergence transcription -- carries the repr,
          // which is what made the gap visible when the two files met.
          this.#error(
            streams,
            `argument ${option.optionString}: ignored explicit argument '${option.explicit}'`,
          );
        }
        if (spec.version !== undefined) {
          // `_VersionAction`: print and `parser.exit()`. Not a namespace key --
          // argparse gives the action `default=SUPPRESS`.
          streams.stdout(`${spec.version}\n`);
          throw new ArgparseExit(0, "version");
        }
        namespace[spec.dest] = spec.storeTrue === true;
        seen.add(spec.dest);
        index += 1;
        continue;
      }
      if (spec.refuseRepeat === true && seen.has(spec.dest)) {
        // The one divergence from argparse in the consumption loop, opt-in per
        // declaration (`D-0112`). argparse keeps the last value silently.
        this.#error(streams, `argument ${option.optionString}: given more than once`);
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
      // `_get_values` converts with `type=` BEFORE `_check_value` tests
      // `choices`, so a value that is neither an integer nor a listed choice is
      // reported as the integer failure. No declared flag has both today; the
      // order is the source's rather than this file's so that one which does
      // cannot make it a question.
      let converted: unknown = value;
      if (spec.type === "int") {
        const parsed = parseInteger(value);
        if ("reason" in parsed) {
          this.#error(
            streams,
            `argument ${option.optionString}: invalid int value: '${value}'` +
              (parsed.reason === "" ? "" : ` (${parsed.reason})`),
          );
        }
        converted = parsed.value;
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
        namespace[spec.dest] = [...(Array.isArray(existing) ? existing : []), converted];
      } else {
        namespace[spec.dest] = converted;
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

/**
 * Every help and description string reachable from `parser`.
 *
 * A free function over the method, so a caller reads the walk the way the
 * source suite's `_help_strings(parser)` reads.
 */
export function helpStrings(parser: ArgumentParser): string[] {
  return parser.helpStrings();
}

/**
 * Run `parser` over `argv` and return the process exit code.
 *
 * The one place `ArgparseExit` becomes an exit code, because it is the one
 * place that is a process boundary. Below it the exit stays an exception: the
 * settings generator's `main` deliberately lets it escape, because its ported
 * case asserts an exception with a code rather than a return value, and CPython
 * behaves the same way -- `SystemExit` propagates out of `main` and the runtime
 * turns it into a status at the top. This function is that runtime.
 *
 * The codes are argparse's: 0 when the command ran or `--help` printed, 2 for a
 * command line the parser refused.
 */
export function dispatch(
  parser: ArgumentParser,
  argv: readonly string[],
  streams: ArgparseStreams,
): number {
  const status = run(parser, argv, streams, false);
  if (typeof status !== "number") {
    // Unreachable: `run` refuses an asynchronous command before calling its
    // handler, and a handler not declared asynchronous returning a promise is a
    // declaration that disagrees with its own implementation. Checked anyway,
    // because the alternative is returning a promise as an exit status.
    throw new Error(`${parser.prog}: the command's handler returned a promise unannounced`);
  }
  return status;
}

/**
 * {@link dispatch}, for a command tree that contains an asynchronous handler.
 *
 * The lap's verb (`src/lap/cli.ts`) awaits the orchestrator's walk and the
 * worker's transcript, so its handler returns a promise where every other verb
 * in this CLI returns a number. Both shapes are settled here, so a subtree does
 * not have to know which kind its neighbours are.
 */
export async function dispatchAsync(
  parser: ArgumentParser,
  argv: readonly string[],
  streams: ArgparseStreams,
): Promise<number> {
  return await run(parser, argv, streams, true);
}

/**
 * The namespace key a leaf parser sets to declare its handler asynchronous.
 *
 * A declaration on the parser rather than a property of the returned value,
 * and the difference is the whole of why it exists. An asynchronous handler has
 * already *done* things by the time it returns its promise -- `lap perform`
 * materialises a worktree, publishes a fence and starts a child -- so a
 * synchronous caller that learned the shape from the result would learn it
 * after the work it could not observe had begun. Declared, the refusal comes
 * before the call.
 */
export const ASYNCHRONOUS = "asynchronous";

/**
 * Parse, find the handler, and call it.
 *
 * `awaited` says whether the caller can settle a promise. A command declaring
 * {@link ASYNCHRONOUS} is refused before its handler runs when it cannot.
 */
function run(
  parser: ArgumentParser,
  argv: readonly string[],
  streams: ArgparseStreams,
  awaited: boolean,
): number | Promise<number> {
  let args: Namespace;
  try {
    args = parser.parseArgs(argv, streams);
  } catch (error) {
    if (error instanceof ArgparseExit) {
      return error.code;
    }
    throw error;
  }
  const func = args["func"];
  if (typeof func !== "function") {
    // Unreachable through a mounted subtree, because every leaf parser carries
    // `set_defaults(func=...)` and a parser with a subcommand table refuses a
    // command line that names none. Stated rather than assumed: a subtree
    // mounted without its handler would otherwise exit 0 having run nothing.
    throw new Error(`${parser.prog}: the parsed command names no handler`);
  }
  if (args[ASYNCHRONOUS] === true && !awaited) {
    throw new Error(
      `${parser.prog}: this command is asynchronous and cannot be dispatched ` +
        "synchronously; use dispatchAsync",
    );
  }
  return (func as (values: Namespace) => number | Promise<number>)(args);
}
