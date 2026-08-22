/**
 * Interlock's `PreToolUse` deny hook, ported from
 * `src/claude_org_runtime/fencing/hook.py` at interlock `65f36c5`.
 *
 * Read A6 of interlock's `investigation/pre-spawn-fence-search.md` (U35) before
 * changing anything here. A6 observed a hook that exited **1** being
 * *absorbed*: the CLI fell back to its own default logic and the session
 * completed normally. A hook whose failure is swallowed is not a fence. Two
 * consequences are wired into this file and must stay wired:
 *
 * 1. **The decision is carried in the hook's stdout JSON**, as an explicit
 *    `permissionDecision: "deny"`, and the blocking exit status is **2**, not
 *    1. Exit 1 is the status A6 watched get absorbed.
 * 2. **This hook never reports its own health as a pass.** Nothing downstream
 *    may read the exit status as evidence that the fence worked -- the evidence
 *    is that the forbidden operation did not happen.
 *
 * Fail-closed, in every direction it can fail:
 *
 * - fence file missing, unreadable, malformed, or empty  -> deny
 * - stdin absent, not JSON, or missing `tool_name`       -> deny
 * - any unexpected exception at all                      -> deny
 *
 * F2/V15/V16 record the lineage's habit of ignore-and-continue on bad input,
 * and `investigation/u1-session-id-bg-experiment.md` section 5.2 shows the same
 * shape on the CLI: exit 0 is not evidence of anything. So the catch-all here
 * denies rather than re-raising into an absorbed non-zero exit.
 *
 * ## Why this one file is hand-written JavaScript
 *
 * Every other module in `src/fencing/` is TypeScript. This one is `.mjs`,
 * deliberately, because it is the only module in the subsystem that is launched
 * **as a process, by path**: the rendered `roles.json` hook command is
 * `{python} {hook_script} --role R --fence F`, and `renderer.ts`'s
 * `checkCommandResolves` refuses to render unless that script token names a
 * file that exists *now*. Node 22 -- a required CI cell, and the floor in
 * `package.json`'s `engines` -- cannot execute a `.ts` file at all
 * (`ERR_UNKNOWN_FILE_EXTENSION`), so a TypeScript hook would be a hook that
 * fails to start. It would fail in the one direction that is silent: a hook
 * that cannot start exits non-zero without a payload, which is the absorbed
 * shape A6 measured.
 *
 * The loss of compile-time checking is mitigated with JSDoc types rather than
 * accepted. This file is intentionally **not** in `tsconfig.json`'s program,
 * and must not be converted back to TypeScript without first removing the
 * by-path launch it exists to serve.
 *
 * ## The import guard, transcribed into ESM
 *
 * Python's hook wraps its own imports in `try/except`, records `_IMPORT_ERROR`,
 * and checks it in `main()`, which denies. The reason is stated in the source:
 * a hook that cannot import itself would raise at *import* time and exit 1, the
 * absorbed status -- so "there is no path through this file that reaches the
 * interpreter's own error handling."
 *
 * ESM makes that harder, not easier: a static `import` that fails is a
 * link-time error, raised before any statement in this module runs, and it
 * cannot be caught from inside the module it breaks. So the fence logic is
 * pulled in through a **dynamic `import()` inside `try/catch`**
 * ({@link loadDependencies}), and a failure there is turned into exactly the
 * deny payload Python's `_IMPORT_ERROR` branch emits. The only static imports
 * in this file are Node built-ins, which cannot fail to resolve.
 *
 * Three further guards keep Node's own error handling unreachable when this
 * file is the process entry point: the promise returned by {@link main} has a
 * rejection handler, and `uncaughtException` / `unhandledRejection` are both
 * bound to a handler that denies. Node's default for all three is exit 1.
 *
 * ## Where the fence logic is loaded from
 *
 * `state.js`, `pyrepr.js` and `pyjson.js` are looked for in two fixed places
 * relative to *this file*: beside it (a built `dist/fencing/`, which is how a packaged
 * install runs) and at `../../dist/fencing/` (this file in the source tree,
 * next to the `.ts` sources Node cannot load, with a build present at the
 * repository root).
 *
 * Both are fixed relative paths, and that is a security property rather than an
 * oversight. An environment variable naming the directory would be the obvious
 * convenience, and it would be a fence bypass: the environment is inherited by
 * the very child this hook fences, so a worker could point its own deny hook at
 * a permissive stub. Nothing outside this file's own directory layout may
 * decide which code the fence runs.
 *
 * A source-tree run therefore requires `npm run build` first. That is loud
 * (deny, exit 2, a reason on stderr) rather than silent, which is the direction
 * this subsystem is allowed to fail in.
 */

import { Buffer } from "node:buffer";
import { readSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * @typedef {Readonly<Record<string, unknown>>} ToolInput
 *
 * @typedef {object} Decision
 * @property {boolean} denied
 * @property {string | null} ruleId
 * @property {string | null} layer
 * @property {string} reason
 *
 * @typedef {object} Fence
 * @property {string} role
 * @property {(toolName: string, toolInput: ToolInput) => Decision} decide
 *
 * @typedef {(path: string) => Fence | Promise<Fence>} ReadFence
 *
 * @typedef {object} Dependencies
 * @property {ReadFence} readFence
 * @property {new (...args: never[]) => Error} FenceStateError
 * @property {(value: unknown) => string} pyRepr
 * @property {(value: unknown) => string} pyJsonDumps
 */

/**
 * The CLI treats exit 2 as a blocking error for `PreToolUse`. Exit 1 is what A6
 * watched get absorbed, so it is never used to mean "deny".
 */
export const EXIT_DENY = 2;
export const EXIT_NO_OPINION = 0;

export const DENY_SELF_CHECK = "fence-unavailable";

/**
 * Where {@link loadDependencies} looks for the compiled fence logic, in order.
 * See the module header for why this list is fixed and why no environment
 * variable may extend it.
 */
const DEPENDENCY_DIRECTORIES = Object.freeze([
  // Packaged / built layout: dist/fencing/hook.mjs beside dist/fencing/state.js.
  new URL("./", import.meta.url),
  // Source-tree layout: src/fencing/hook.mjs, with the build at <root>/dist.
  new URL("../../dist/fencing/", import.meta.url),
]);

/** @type {Dependencies | null} */
let loadedDependencies = null;

/**
 * Load the fence logic, or throw the failure so `main` can deny with it.
 *
 * The success path also *fills the seam record*, and only where the entry is
 * still absent: a test that patched `hookSeams.readFence` before calling
 * `main()` must not have its patch overwritten by the first successful load.
 * The fill runs on the cached path too, because `patchSeam`'s teardown deletes
 * the key it added and the next call has to restore the real function.
 *
 * @returns {Promise<Dependencies>}
 */
async function loadDependencies() {
  if (loadedDependencies === null) {
    /** @type {unknown} */
    let lastError = new Error("no candidate directory for the fence logic was tried");
    for (const directory of DEPENDENCY_DIRECTORIES) {
      try {
        // Imported by URL, never by a bare path string: on Windows a path such
        // as `C:\...` is read as a URL scheme by `import()`, and the module
        // would fail to load on exactly one platform.
        const state = await import(new URL("state.js", directory).href);
        const pyrepr = await import(new URL("pyrepr.js", directory).href);
        const pyjson = await import(new URL("pyjson.js", directory).href);
        if (
          typeof state.readFence !== "function" ||
          typeof state.FenceStateError !== "function" ||
          typeof pyrepr.pyRepr !== "function" ||
          typeof pyjson.pyJsonDumps !== "function"
        ) {
          // A directory that resolved but does not carry what this hook calls
          // is a broken install, not a candidate to fall back from silently.
          throw new Error(
            `the fence logic at ${directory.href} does not export readFence, ` +
              "FenceStateError, pyRepr and pyJsonDumps",
          );
        }
        loadedDependencies = {
          readFence: state.readFence,
          FenceStateError: state.FenceStateError,
          pyRepr: pyrepr.pyRepr,
          pyJsonDumps: pyjson.pyJsonDumps,
        };
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (loadedDependencies === null) {
      throw lastError;
    }
  }
  if (hookSeams.readFence === undefined) {
    hookSeams.readFence = loadedDependencies.readFence;
  }
  return loadedDependencies;
}

/**
 * The seam record (D-0014), reproducing `monkeypatch.setattr` on a module
 * internal.
 *
 * `test_an_internal_error_denies_instead_of_escaping_as_a_traceback` patches
 * the hook module's own `read_fence` and asserts that `main()` returns
 * `EXIT_DENY`. Python's late binding makes that work through the module dict;
 * ESM bindings are fixed at link time, so every internal call site here goes
 * through this record instead -- `hookSeams.readFence(...)`, never the loaded
 * function directly. Replacing an entry therefore changes what production code
 * actually calls, which is the point: a seam nothing routes through is
 * decoration, and every case that replaces it would stay green while reaching
 * nothing. That property needs its own target-only liveness test.
 *
 * `loadDependencies` is a seam for a second reason: it is the only way to
 * exercise the import guard without physically breaking the build tree.
 *
 * Not re-exported from `src/index.ts`: this is a testing seam, not public
 * surface.
 *
 * @type {{ readFence: ReadFence | undefined, loadDependencies: () => Promise<Dependencies> }}
 */
export const hookSeams = {
  // Filled by the first successful `loadDependencies()`; see above for why it
  // starts absent rather than holding a statically imported binding.
  readFence: undefined,
  loadDependencies,
};

/**
 * Evaluate one `PreToolUse` event against the persisted fence.
 *
 * `role` is the role the *renderer* wired into this command line. It is checked
 * against the fence actually on disk, because the fence path is
 * publish-and-replace: two roles accidentally sharing a path would mean a later
 * spawn silently re-points the earlier one at somebody else's rules, and a
 * worker would quietly lose denials the curator never had.
 *
 * Asynchronous where the source is synchronous, and only because the fence
 * logic arrives through `import()`. The event, the fence and the decision are
 * all the same values the source computes.
 *
 * @param {string} fencePath
 * @param {Readonly<Record<string, unknown>>} event
 * @param {{ role?: string | null }} [options]
 * @returns {Promise<[Decision, Record<string, unknown>]>}
 */
export async function decidePayload(fencePath, event, options = {}) {
  const role = options.role ?? null;
  const dependencies = await hookSeams.loadDependencies();

  /** @type {Fence} */
  let fence;
  try {
    // Through the seam, never through `dependencies.readFence`: see hookSeams.
    fence = await /** @type {ReadFence} */ (hookSeams.readFence)(fencePath);
  } catch (error) {
    if (!isFenceStateError(error, dependencies)) {
      // Anything that is not a fence-state failure is a defect rather than an
      // unreadable fence. The source lets it propagate to `main`'s catch-all,
      // which denies with a different reason -- and that distinction is what
      // the seam case above asserts.
      throw error;
    }
    const decision = denySelfCheck(
      "Interlock cannot read its own fence, so it cannot tell whether this " +
        `call is permitted: ${errorText(error)}`,
    );
    return [decision, hookOutput(decision)];
  }

  if (role !== null && fence.role !== role) {
    const decision = denySelfCheck(
      `fence at ${fencePath} carries role ${dependencies.pyRepr(fence.role)} but this hook was ` +
        `rendered for ${dependencies.pyRepr(role)}; denied rather than enforcing another role's rules`,
    );
    return [decision, hookOutput(decision)];
  }

  // Read as own properties. `event.get(...)` on a Python dict never consults a
  // prototype, and a JSON document that carries a key shadowing one on
  // `Object.prototype` must not be answered from the prototype here either.
  const toolName = ownProperty(event, "tool_name");
  let toolInput = ownProperty(event, "tool_input");
  if (typeof toolName !== "string" || toolName === "") {
    const decision = denySelfCheck(
      "PreToolUse event carried no tool_name; denied rather than guessed",
    );
    return [decision, hookOutput(decision)];
  }
  if (!isMapping(toolInput)) {
    // `isinstance(tool_input, Mapping)`: a JSON array or scalar is not one.
    toolInput = {};
  }

  const decision = fence.decide(toolName, /** @type {ToolInput} */ (toolInput));
  return [decision, hookOutput(decision)];
}

/**
 * The hook's stdout payload for one decision. Empty for "no opinion".
 *
 * Wire keys are verbatim (D-0201): `hookSpecificOutput`, `permissionDecision`
 * and `permissionDecisionReason` are the CLI's own vocabulary, and `rule_id` is
 * interlock's.
 *
 * @param {Decision} decision
 * @returns {Record<string, unknown>}
 */
function hookOutput(decision) {
  if (!decision.denied) {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
    // The pre-`hookSpecificOutput` shape, emitted alongside the current one.
    // Which of the two a given CLI build honours is not something a fence
    // should depend on knowing.
    decision: "block",
    reason: decision.reason,
    interlock: { rule_id: decision.ruleId, layer: decision.layer },
  };
}

/**
 * A `Decision` this hook makes about *itself* rather than about a rule.
 *
 * Built here as a plain frozen record rather than through `rules.ts`'s
 * `makeDecision`. `Decision` is an interface in the port, not a class -- there
 * is no identity to preserve and nothing anywhere does an `instanceof` on it --
 * so this constructs the same value while removing one more module from the set
 * that has to load before this file can deny. In a file whose whole job is to
 * work when something else is broken, every import is a way to fail.
 *
 * @param {string} reason
 * @returns {Decision}
 */
function denySelfCheck(reason) {
  return Object.freeze({
    denied: true,
    ruleId: DENY_SELF_CHECK,
    layer: "hook",
    reason,
  });
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

const PROG = "interlock-fence-hook";
const USAGE = `usage: ${PROG} [-h] --fence FENCE [--role ROLE]`;
/**
 * The full `--help` text.
 *
 * A literal rather than a rendering of the parser, and wrapped exactly where
 * `argparse` wraps it: the source declares one `description=` string and lets
 * `argparse` fold it to the terminal width it assumes (79 columns), so
 * reproducing the parser's layout by hand is the only way this stays the same
 * text. It is checked by diffing against CPython's output, not by eye.
 */
const HELP_TEXT = `${USAGE}

Interlock PreToolUse deny hook. Reads the hook event on stdin, evaluates it
against the persisted per-role fence, and denies on stdout with exit 2. Fails
closed on every error.

options:
  -h, --help     show this help message and exit
  --fence FENCE  path to the persisted fence JSON
  --role ROLE    role this hook was rendered for; the persisted fence must
                 match it
`;

/**
 * `argparse.ArgumentError`, and the `parser.error()` calls that are not routed
 * through one, share this type: both end at `error(message)`, which prints the
 * usage line plus `prog: error: message` to stderr and exits 2 -- which is also
 * {@link EXIT_DENY}.
 */
class HookUsageError extends Error {}

/** `-h` / `--help`: `argparse` prints to stdout and exits 0. */
class HelpRequested extends Error {}

/**
 * `argparse.ArgumentError`, rendered the way `ArgumentError.__str__` renders
 * it: `argument <names>: <message>`, where `<names>` is
 * `_get_action_name(action)` -- for an optional, its option strings joined with
 * `/`, so the help action reports itself as `-h/--help` and not as whichever
 * spelling the caller used.
 *
 * @param {HookAction} action
 * @param {string} message
 * @returns {HookUsageError}
 */
function argumentError(action, message) {
  return new HookUsageError(`argument ${action.optionStrings.join("/")}: ${message}`);
}

/** The parser's only `prefix_chars` entry. */
const PREFIX = "-";

/**
 * One entry of `parser._actions`.
 *
 * `nargs` is `0` for the help action (argparse's `_HelpAction` declares
 * `nargs=0`) and `1` for the two `store` actions, whose `nargs=None` means
 * exactly one argument. No other arity exists in this parser, so
 * {@link matchArgument} is the whole of `_match_argument` that can be reached.
 *
 * @typedef {object} HookAction
 * @property {"help" | "fence" | "role"} dest
 * @property {readonly string[]} optionStrings
 * @property {0 | 1} nargs
 * @property {boolean} required
 */

/** @type {HookAction} */
const HELP_ACTION = Object.freeze({
  dest: "help",
  optionStrings: Object.freeze(["-h", "--help"]),
  nargs: 0,
  required: false,
});
/** @type {HookAction} */
const FENCE_ACTION = Object.freeze({
  dest: "fence",
  optionStrings: Object.freeze(["--fence"]),
  nargs: 1,
  required: true,
});
/** @type {HookAction} */
const ROLE_ACTION = Object.freeze({
  dest: "role",
  optionStrings: Object.freeze(["--role"]),
  nargs: 1,
  required: false,
});

/**
 * `parser._actions`, in declaration order. Only the order matters here: it is
 * the order the missing-required report lists names in.
 *
 * @type {readonly HookAction[]}
 */
const ACTIONS = Object.freeze([HELP_ACTION, FENCE_ACTION, ROLE_ACTION]);

/**
 * `parser._option_string_actions`, in insertion order.
 *
 * A list rather than a `Map` because the order is load-bearing twice over:
 * `_get_option_tuples` iterates this dict, so it fixes the order of the
 * candidates in an `ambiguous option: ... could match ...` message, and
 * CPython's dicts preserve insertion order. `-h` precedes `--help` because
 * `add_argument` registers the short spelling first.
 *
 * @type {readonly (readonly [string, HookAction])[]}
 */
const OPTION_STRING_ACTIONS = Object.freeze([
  Object.freeze(/** @type {const} */ (["-h", HELP_ACTION])),
  Object.freeze(/** @type {const} */ (["--help", HELP_ACTION])),
  Object.freeze(/** @type {const} */ (["--fence", FENCE_ACTION])),
  Object.freeze(/** @type {const} */ (["--role", ROLE_ACTION])),
]);

/**
 * `arg_string in self._option_string_actions`.
 *
 * @param {string} name
 * @returns {HookAction | undefined}
 */
function lookupOptionString(name) {
  for (const [optionString, action] of OPTION_STRING_ACTIONS) {
    if (optionString === name) {
      return action;
    }
  }
  return undefined;
}

/**
 * `argparse._negative_number_matcher`, transcribed.
 *
 * Python's `\d` on a `str` pattern is the Unicode category `Nd`, not `[0-9]`
 * -- `--fence -` followed by U+0661 U+0662 (the Arabic-Indic digits one and
 * two) is a *value* to argparse, not an option -- so it is spelled `\p{Nd}`
 * here, the same equivalence `pyregex.ts` documents. The parser this file
 * reproduces declares no option string that looks like a negative number,
 * which is the condition (`_has_negative_number_optionals` being empty) under
 * which argparse honours this.
 */
const NEGATIVE_NUMBER = /^-\p{Nd}+$|^-\p{Nd}*\.\p{Nd}+$/u;

/**
 * One classification result: `argparse`'s four-tuple
 * `(action, option_string, sep, explicit_arg)`.
 *
 * `action: null` is argparse's "looks like an option, but this parser has no
 * such option" tuple -- the token is still classified `O`, which is why a
 * bogus `--flag` swallows nothing that follows it and is reported at
 * end-of-parse as an extra rather than as a positional.
 *
 * @typedef {object} OptionTuple
 * @property {HookAction | null} action
 * @property {string} optionString
 * @property {"" | "=" | null} sep
 * @property {string | null} explicitArg
 */

/**
 * `argparse._get_option_tuples`: every option string this token could be an
 * abbreviation of.
 *
 * @param {string} token A token of at least two characters starting with `-`.
 * @returns {OptionTuple[]}
 */
function getOptionTuples(token) {
  /** @type {OptionTuple[]} */
  const result = [];
  if (token[1] === PREFIX) {
    // `--...`: split only at the `=`, then prefix-match the head.
    const equals = token.indexOf("=");
    const optionPrefix = equals === -1 ? token : token.slice(0, equals);
    /** @type {"=" | null} */
    const sep = equals === -1 ? null : "=";
    const explicitArg = equals === -1 ? null : token.slice(equals + 1);
    for (const [optionString, action] of OPTION_STRING_ACTIONS) {
      if (optionString.startsWith(optionPrefix)) {
        result.push({ action, optionString, sep, explicitArg });
      }
    }
    return result;
  }
  // `-x...`: a single-character option may carry its argument glued on, so the
  // first two characters are tried as a complete option string before the
  // whole token is tried as a long-option prefix.
  const shortOptionPrefix = token.slice(0, 2);
  const shortExplicitArg = token.slice(2);
  for (const [optionString, action] of OPTION_STRING_ACTIONS) {
    if (optionString === shortOptionPrefix) {
      result.push({ action, optionString, sep: "", explicitArg: shortExplicitArg });
    } else if (optionString.startsWith(token)) {
      result.push({ action, optionString, sep: null, explicitArg: null });
    }
  }
  return result;
}

/**
 * `argparse._parse_optional`: is this token an option, and if so which one?
 *
 * This runs over *every* token before any action is taken, which is the whole
 * point of the two-pass shape. An ambiguous abbreviation is reported from
 * here, at classification time -- so `-h --=` is a usage error and never
 * prints help, even though `-h` comes first.
 *
 * @param {string} token
 * @returns {OptionTuple | null} `null` when the token is a value (`A`).
 */
function parseOptional(token) {
  if (token === "") {
    return null;
  }
  if (token[0] !== PREFIX) {
    return null;
  }
  const exact = lookupOptionString(token);
  if (exact !== undefined) {
    return { action: exact, optionString: token, sep: null, explicitArg: null };
  }
  if (token.length === 1) {
    // A bare `-` is a value, by long-standing convention.
    return null;
  }
  const equals = token.indexOf("=");
  if (equals !== -1) {
    const head = token.slice(0, equals);
    const action = lookupOptionString(head);
    if (action !== undefined) {
      return { action, optionString: head, sep: "=", explicitArg: token.slice(equals + 1) };
    }
  }
  const tuples = getOptionTuples(token);
  if (tuples.length > 1) {
    const matches = tuples.map((tuple) => tuple.optionString).join(", ");
    throw new HookUsageError(`ambiguous option: ${token} could match ${matches}`);
  }
  const only = tuples[0];
  if (only !== undefined) {
    return only;
  }
  if (NEGATIVE_NUMBER.test(token)) {
    return null;
  }
  if (token.includes(" ")) {
    // A token that merely starts with a dash, such as `"- x"`.
    return null;
  }
  return { action: null, optionString: token, sep: null, explicitArg: null };
}

/**
 * `argparse._match_argument`, for the two arities this parser declares.
 *
 * The `nargs=None` pattern is `(A)` once the `-*` groups are stripped (they
 * are, for every optional action), so it matches only when the next classified
 * token is a value. That is why `--fence -x` is a usage error rather than a
 * fence path of `-x`: a fence path argparse refuses must not be smuggled past
 * this parser, where it would be resolved against the child's own working
 * directory.
 *
 * @param {HookAction} action
 * @param {string} pattern The classification pattern from the current offset.
 * @returns {0 | 1}
 */
function matchArgument(action, pattern) {
  if (action.nargs === 0) {
    return 0;
  }
  if (pattern.startsWith("A")) {
    return 1;
  }
  throw argumentError(action, "expected one argument");
}

/**
 * `repr()` of a `str`, for the one message that interpolates one.
 *
 * Used only when {@link parseArguments} is called without the real `pyRepr`
 * -- `main` passes the loaded one, so the production path uses the same
 * renderer every other refusal message does. Kept ASCII-only, escapes rather
 * than raw bytes, like the rest of `src/`.
 *
 * @param {string} value
 * @returns {string}
 */
function fallbackRepr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    if (ch === quote || ch === "\\") {
      out += `\\${ch}`;
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else {
      const code = /** @type {number} */ (ch.codePointAt(0));
      if (code < 0x20 || code === 0x7f) {
        out += `\\x${code.toString(16).padStart(2, "0")}`;
      } else {
        out += ch;
      }
    }
  }
  return out + quote;
}

/**
 * The source's `build_parser().parse_args()`, reproduced as argparse's two
 * passes rather than as a single eager sweep.
 *
 * A single-pass parser gets the common shapes right and the uncommon ones
 * wrong in both directions, and a differential over 900 random one-to-three
 * token vectors measured the cost: 123 exit-code divergences, 14 of them
 * *fail-open* -- the port exiting 0 where interlock exits 2. Every one of the
 * 14 had the same shape, a help token ahead of an ambiguous `--...=` token,
 * because argparse classifies `--=` as ambiguous *before* `-h` gets to run.
 * A hook that exits 0 is a hook that permitted the call.
 *
 * So this is argparse's structure, not an approximation of its results:
 *
 * 1. classify every token (`_parse_optional`), which is where an ambiguous
 *    abbreviation is reported and where `--` ends the options;
 * 2. consume, alternating optionals and positionals -- of which this parser
 *    declares none, so every unclaimed token becomes an extra;
 * 3. report missing required actions, then the extras, at end-of-parse.
 *
 * `argparse` accepts an unambiguous prefix of a long option (`--fen`), so this
 * does too: a caller relying on that would otherwise get a usage error here
 * and a working hook in interlock, and the difference would show up as a fence
 * that refuses everything on one implementation only.
 *
 * @param {readonly string[]} argv
 * @param {{ repr?: (value: string) => string }} [options]
 * @returns {{ fence: string, role: string | null }}
 */
export function parseArguments(argv, options = {}) {
  const repr = options.repr ?? fallbackRepr;
  const tokens = [...argv];

  // -- pass 1: classify ----------------------------------------------------
  // `O` for a token that names an option (known or not), `A` for a value, `-`
  // for the end-of-options marker. Everything after `--` is a value without
  // being classified at all, which is why `-- --=` does not raise ambiguity.
  /** @type {Map<number, OptionTuple>} */
  const optionTuples = new Map();
  /** @type {string[]} */
  const patternParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = /** @type {string} */ (tokens[index]);
    if (token === "--") {
      patternParts.push("-");
      for (let rest = index + 1; rest < tokens.length; rest += 1) {
        patternParts.push("A");
      }
      break;
    }
    const tuple = parseOptional(token);
    if (tuple === null) {
      patternParts.push("A");
    } else {
      optionTuples.set(index, tuple);
      patternParts.push("O");
    }
  }
  const pattern = patternParts.join("");

  // -- pass 2: consume -----------------------------------------------------
  /** @type {string[]} */
  const extras = [];
  /** @type {Set<HookAction>} */
  const seen = new Set();
  /** @type {{ fence: string | null, role: string | null }} */
  const values = { fence: null, role: null };

  /**
   * `take_action`. The help action is `_HelpAction`, which prints and exits,
   * so it leaves through {@link HelpRequested} in *positional order* -- after
   * the tokens before it have been consumed, and never if classification
   * already failed.
   *
   * @param {HookAction} action
   * @param {readonly string[]} args
   * @returns {void}
   */
  const takeAction = (action, args) => {
    seen.add(action);
    if (action === HELP_ACTION) {
      throw new HelpRequested();
    }
    values[/** @type {"fence" | "role"} */ (action.dest)] = /** @type {string} */ (args[0]);
  };

  /**
   * `consume_optional`.
   *
   * @param {number} startIndex
   * @returns {number} The index at which this option's arguments stopped.
   */
  const consumeOptional = (startIndex) => {
    const tuple = /** @type {OptionTuple} */ (optionTuples.get(startIndex));
    let action = tuple.action;
    let optionString = tuple.optionString;
    let sep = tuple.sep;
    let explicitArg = tuple.explicitArg;
    /** @type {[HookAction, readonly string[]][]} */
    const actionTuples = [];
    let stop = startIndex + 1;
    for (;;) {
      if (action === null) {
        // Classified as an option, but this parser has no such option. It is
        // an extra, and it consumes nothing after it.
        extras.push(/** @type {string} */ (tokens[startIndex]));
        return startIndex + 1;
      }
      if (explicitArg !== null) {
        const argCount = matchArgument(action, "A");
        if (argCount === 0 && optionString[1] !== PREFIX && explicitArg !== "") {
          // A single-dash option that takes no argument, with a tail: argparse
          // tries to read the tail as further single-dash options, so `-hx` is
          // `-h` followed by an unrecognized `-x`.
          if (sep !== null && sep !== "") {
            throw argumentError(action, `ignored explicit argument ${repr(explicitArg)}`);
          }
          if (explicitArg[0] === PREFIX) {
            throw argumentError(action, `ignored explicit argument ${repr(explicitArg)}`);
          }
          actionTuples.push([action, []]);
          const char = /** @type {string} */ (optionString[0]);
          optionString = char + /** @type {string} */ (explicitArg[0]);
          const next = lookupOptionString(optionString);
          if (next === undefined) {
            extras.push(char + explicitArg);
            stop = startIndex + 1;
            break;
          }
          action = next;
          explicitArg = explicitArg.slice(1);
          if (explicitArg === "") {
            sep = null;
            explicitArg = null;
          } else if (explicitArg[0] === "=") {
            sep = "=";
            explicitArg = explicitArg.slice(1);
          } else {
            sep = "";
          }
          continue;
        }
        if (argCount === 1) {
          stop = startIndex + 1;
          actionTuples.push([action, [explicitArg]]);
          break;
        }
        // A long option that takes no argument, given one anyway.
        throw argumentError(action, `ignored explicit argument ${repr(explicitArg)}`);
      }
      const start = startIndex + 1;
      const argCount = matchArgument(action, pattern.slice(start));
      stop = start + argCount;
      actionTuples.push([action, tokens.slice(start, stop)]);
      break;
    }
    for (const [pending, args] of actionTuples) {
      takeAction(pending, args);
    }
    return stop;
  };

  // The main alternation. `consume_positionals` is omitted rather than
  // stubbed: this parser declares no positional actions, so
  // `_match_arguments_partial` over an empty action list returns an empty
  // count list and leaves `start_index` where it was, every time. Its two
  // call sites therefore reduce to "everything unclaimed is an extra".
  let startIndex = 0;
  let maxOptionStringIndex = -1;
  for (const index of optionTuples.keys()) {
    if (index > maxOptionStringIndex) {
      maxOptionStringIndex = index;
    }
  }
  while (startIndex <= maxOptionStringIndex) {
    let nextOptionStringIndex = maxOptionStringIndex;
    for (const index of optionTuples.keys()) {
      if (index >= startIndex && index < nextOptionStringIndex) {
        nextOptionStringIndex = index;
      }
    }
    if (!optionTuples.has(startIndex)) {
      for (const extra of tokens.slice(startIndex, nextOptionStringIndex)) {
        extras.push(extra);
      }
      startIndex = nextOptionStringIndex;
    }
    startIndex = consumeOptional(startIndex);
  }
  for (const extra of tokens.slice(startIndex)) {
    extras.push(extra);
  }

  // -- end of parse --------------------------------------------------------
  // The required check lives in `_parse_known_args` and the extras check in
  // `parse_args`, so a command line that is missing `--fence` *and* carries
  // junk reports the missing option, not the junk. The order is observable.
  const missing = ACTIONS.filter((action) => action.required && !seen.has(action)).map((action) =>
    action.optionStrings.join("/"),
  );
  if (missing.length > 0) {
    throw new HookUsageError(`the following arguments are required: ${missing.join(", ")}`);
  }
  if (extras.length > 0) {
    // Every extra, not just the first: `--bogus 1` reports both tokens.
    throw new HookUsageError(`unrecognized arguments: ${extras.join(" ")}`);
  }
  return { fence: /** @type {string} */ (values.fence), role: values.role };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Decide one event and report it. Never throws, and never returns 1.
 *
 * @param {readonly string[]} [argv] Defaults to the process arguments.
 * @returns {Promise<number>} {@link EXIT_DENY} or {@link EXIT_NO_OPINION}.
 */
export async function main(argv = process.argv.slice(2)) {
  try {
    /** @type {Dependencies | null} */
    let dependencies = null;
    try {
      // The load is forced here, before anything else, so that its failure is
      // reported by the branch below rather than by whichever call site would
      // otherwise have been first.
      dependencies = await hookSeams.loadDependencies();
    } catch (error) {
      // The `_IMPORT_ERROR` branch. Nothing in this module is usable, so the
      // deny is emitted literally rather than through machinery that failed to
      // load. Reaching the interpreter's own error handling here would exit 1,
      // the status i04 section 4 measured being absorbed.
      const reason =
        "Interlock deny hook could not load its own fence logic and denied " +
        `by default: ${formatError(error)}`;
      writeStdout(dumps(literalDenyPayload(reason)));
      writeStderr(`${reason}\n`);
      return EXIT_DENY;
    }

    /** @type {{ fence: string, role: string | null }} */
    let args;
    try {
      // The loaded `pyRepr` is handed in rather than reached for, so the one
      // message that interpolates `%r` renders through the same `repr()` every
      // other refusal message in the subsystem does.
      args = parseArguments(argv, { repr: dependencies.pyRepr });
    } catch (error) {
      if (error instanceof HelpRequested) {
        // `argparse` prints help on stdout and exits 0. A hook invoked with
        // `--help` was asked a question about itself, not about a tool call, so
        // this is the one non-deny exit that carries no decision.
        writeStdout(HELP_TEXT);
        return EXIT_NO_OPINION;
      }
      // `argparse` writes usage plus the error to stderr and exits 2 -- which
      // is `EXIT_DENY`, so a malformed command line blocks the tool call
      // exactly as the source's does, and for the same reason.
      writeStderr(`${USAGE}\n${PROG}: error: ${errorText(error)}\n`);
      return EXIT_DENY;
    }

    /** @type {Decision} */
    let decision;
    /** @type {Record<string, unknown>} */
    let payload;
    try {
      let raw;
      try {
        // Synchronous and to EOF, like `sys.stdin.read()`. A closed or
        // otherwise unreadable stdin throws here and is treated as empty
        // input, which denies below.
        raw = readStdinToEnd();
      } catch {
        raw = "";
      }
      /** @type {unknown} */
      let event;
      try {
        event = raw.trim() === "" ? {} : JSON.parse(raw);
      } catch {
        // `json.JSONDecodeError`: not JSON at all is an empty event, and an
        // empty event carries no `tool_name`, which denies.
        event = {};
      }
      if (!isMapping(event)) {
        event = {};
      }
      [decision, payload] = await decidePayload(args.fence, event, { role: args.role });
    } catch (error) {
      // Anything at all, including a bug in this file, denies. An unhandled
      // throw would exit 1, and A6 measured exit 1 being absorbed.
      decision = denySelfCheck(
        `Interlock deny hook failed and denied by default: ${formatError(error)}`,
      );
      payload = hookOutput(decision);
    }

    if (!decision.denied) {
      return EXIT_NO_OPINION;
    }
    writeStdout(dumps(payload));
    writeStderr(`${decision.reason}\n`);
    return EXIT_DENY;
  } catch (error) {
    // Last resort: a failure in the deny path itself, including in the writes
    // above. There is no state left worth reporting accurately, and the one
    // thing that must still hold is that this call does not raise and does not
    // resolve to 1.
    writeStderr(`Interlock deny hook failed while denying: ${formatError(error)}\n`);
    return EXIT_DENY;
  }
}

/**
 * The deny payload, built with nothing but built-ins.
 *
 * Used where the fence logic could not be loaded, so it must not reference
 * anything that arrives through `import()`.
 *
 * @param {string} reason
 * @returns {Record<string, unknown>}
 */
function literalDenyPayload(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    decision: "block",
    reason,
    interlock: { rule_id: DENY_SELF_CHECK, layer: "hook" },
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/**
 * How long one `EAGAIN` retry waits before looking at fd 0 again, and how far
 * that wait is allowed to grow.
 *
 * CPython does not poll at all -- `sys.stdin.read()` blocks in the kernel at
 * 0% CPU. This loop exists only because fd 0 is in NON-BLOCKING mode by the
 * time the hook reads it, so there is no blocking read to make. A fixed 1 ms
 * retry was measured burning ~6% of a core on a pipe that is opened, partly
 * written and never closed -- a wedged hook holding 6% of a core indefinitely,
 * where interlock holds none.
 *
 * So the wait backs off: quick while the writer is merely a little behind
 * (which is the common case and where latency matters), then geometrically up
 * to a ceiling once it is clear nothing is coming soon. Hang behaviour is
 * unchanged and deliberate -- both implementations block forever on a pipe that
 * is never closed, which the module header states is intended -- but the idle
 * cost approaches CPython's instead of sitting at 6%.
 */
const STDIN_RETRY_MILLISECONDS = 1;
const STDIN_RETRY_CEILING_MILLISECONDS = 50;

/** The read size per `readSync`; a pipe hands over at most its buffer anyway. */
const STDIN_CHUNK_BYTES = 65536;

/**
 * `sys.stdin.read()`: consume fd 0 to end of file and decode it as UTF-8.
 *
 * Emphatically **not** `readFileSync(0, "utf8")`, which is what this used to
 * be and which loses events over roughly 64KB whenever stdin is a pipe -- the
 * way the CLI actually invokes a hook.
 *
 * The failure mode, measured: by the time `main` reaches this point, the three
 * `await import()` calls in `loadDependencies` have run the event loop, and
 * touching fd 0 through libuv leaves it in **non-blocking** mode. A pipe
 * carrying more than one pipe buffer therefore drains mid-read, `readSync`
 * raises `EAGAIN`, `readFileSync` turns that into a throw, and the caller's
 * catch-all turned the whole event into `""`. `""` becomes `{}`, `{}` carries
 * no `tool_name`, and a permitted call was denied. It is a race against the
 * writer, so it was intermittent: at 70,000 bytes of `command` the port denied
 * calls interlock allowed on 10 runs out of 10, while the same bytes
 * *redirected from a file* always worked.
 *
 * So `EAGAIN`/`EWOULDBLOCK` means "the writer has not caught up yet", and is
 * waited out rather than reported. Python's `sys.stdin.read()` blocks until
 * EOF and this reproduces that, including the fact that it will wait forever
 * on a pipe nobody ever closes.
 *
 * The distinction the old code lost is kept: genuine end of file is
 * `readSync` returning **0 bytes**, which yields `""` and denies -- interlock
 * denies there too, and it must stay that way. Every other error still
 * propagates to the caller's catch, so an unreadable stdin also still denies.
 *
 * @returns {string}
 */
function readStdinToEnd() {
  /** @type {Buffer[]} */
  const chunks = [];
  const buffer = Buffer.allocUnsafe(STDIN_CHUNK_BYTES);
  let retryWait = STDIN_RETRY_MILLISECONDS;
  for (;;) {
    /** @type {number} */
    let bytesRead;
    try {
      // `position: null` reads from the descriptor's own offset, which is the
      // only meaningful position for a pipe and the right one for a file.
      bytesRead = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") {
        // EINTR shares this arm deliberately. libuv retries EINTR internally so
        // it is hard to reach, but an unthrottled `continue` on it would be a
        // genuine hot spin if it ever did fire repeatedly -- the one arm in
        // this loop that could burn a core with nothing to show for it.
        sleepSync(retryWait);
        retryWait = Math.min(retryWait * 2, STDIN_RETRY_CEILING_MILLISECONDS);
        continue;
      }
      if (code === "EOF") {
        // Windows reports the read end of a closed pipe this way rather than
        // as a zero-length read.
        break;
      }
      throw error;
    }
    if (bytesRead === 0) {
      break;
    }
    // The writer is keeping up, so the next stall should wait briefly again
    // rather than inheriting a ceiling reached earlier in this read.
    retryWait = STDIN_RETRY_MILLISECONDS;
    // Copied out: `buffer` is reused by the next iteration.
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  // Decoded once, over the joined bytes: a multi-byte character split across
  // two reads would otherwise decode to two replacement characters.
  //
  // `{ fatal: true }`, NOT `Buffer.toString("utf8")`. The difference is a
  // fail-OPEN hole, and it was found by an adversarial review after the
  // chunk-boundary fix above introduced it:
  //
  //   `Buffer.toString("utf8")` substitutes U+FFFD for every undecodable byte
  //   and never fails. An event carrying a byte sequence that is not valid
  //   UTF-8 -- a filename with raw bytes on a Linux filesystem is the
  //   realistic source -- would therefore PARSE, arrive with its `tool_name`
  //   intact and a MANGLED `tool_input`, and be evaluated against the fence.
  //   interlock does the opposite: `sys.stdin.read()` on a strict UTF-8 stdin
  //   raises `UnicodeDecodeError`, `hook.py`'s bare `except` sets `raw = ""`,
  //   and the empty event carries no `tool_name`, which DENIES.
  //
  // Measured before the fix, on a fence denying `Bash(git push *)`, with
  // `"command": "echo \xff\xfe hi"` on stdin: interlock exit 2, continuo exit
  // 0. Same for a lone surrogate and for a truncated 3-byte character.
  //
  // The `TypeError` this throws is caught by `main`'s existing stdin catch,
  // which sets `raw = ""` -- reproducing interlock's path exactly, rather than
  // inventing a new one. `state.ts` already reasons this way about the fence
  // file; the same discipline belongs on the stdin path.
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * Is this a `FenceStateError`, whichever copy of `state` it came from?
 *
 * `instanceof` alone is not enough here, and the reason is structural rather
 * than defensive. This file loads `state.js` from the BUILT tree (`dist/`),
 * because it has to run as a bare script with no compiler. A test that imports
 * `FenceStateError` from `src/fencing/state.ts` and hands it to a patched
 * `hookSeams.readFence` is therefore holding a DIFFERENT class object with the
 * same name: `instanceof` is false, the error takes the `throw` branch, and an
 * in-process caller that is not `main` gets an exception instead of a deny.
 *
 * A reviewer reproduced exactly that. The failure is silent in the worst way --
 * the case still "fails closed" when routed through `main`, so it looks correct
 * until someone asserts on the refusal REASON and gets
 * "failed and denied by default" instead of "cannot read its own fence".
 *
 * So the name is accepted as well as the identity. That is not a weakening:
 * Python has one class here and the check is asking the question Python asks;
 * it is JavaScript's dual module registry, not the fence's semantics, that
 * makes one predicate insufficient.
 *
 * @param {unknown} error
 * @param {{ FenceStateError: Function }} dependencies
 * @returns {boolean}
 */
function isFenceStateError(error, dependencies) {
  if (error instanceof dependencies.FenceStateError) {
    return true;
  }
  return error instanceof Error && error.name === "FenceStateError";
}

/**
 * Block this thread for `milliseconds`, with no event loop turn.
 *
 * `Atomics.wait` on a value that never changes is the only synchronous sleep
 * Node has. It must stay synchronous: yielding to the event loop here would
 * reintroduce the interleaving that put fd 0 in non-blocking mode to begin
 * with.
 *
 * @param {number} milliseconds
 * @returns {void}
 */
function sleepSync(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // `SharedArrayBuffer` or blocking waits unavailable: spin instead. Busy
    // waiting is wasteful and correct; not waiting at all would spin the
    // `EAGAIN` branch at full speed, which is also correct but far worse.
    const until = Date.now() + milliseconds;
    while (Date.now() < until) {
      // Intentionally empty.
    }
  }
}

/**
 * `json.dumps`, with Python's defaults.
 *
 * Not `JSON.stringify`: `json.dumps` separates items with `", "` and keys from
 * values with `": "`, and escapes every non-ASCII character (`ensure_ascii`).
 * `JSON.stringify` does neither, so the two produce different bytes for the
 * same payload -- and a deny reason carrying a non-ASCII path would reach the
 * CLI as raw UTF-8 rather than as the `\uXXXX` escapes interlock emits.
 *
 * Falls back to `JSON.stringify` only where `pyjson.js` is not loaded, which is
 * exactly the broken-install path: a payload with Node's spacing is still a
 * payload, and refusing to emit one because the pretty-printer is missing would
 * turn the deny into silence.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function dumps(payload) {
  if (loadedDependencies !== null) {
    try {
      return loadedDependencies.pyJsonDumps(payload);
    } catch {
      // A defect in the serialiser must not swallow the decision.
    }
  }
  return JSON.stringify(payload);
}

/**
 * `isinstance(value, Mapping)`: `typeof null` is `"object"` and an array is an
 * object, and Python's test is true for neither.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Readonly<Record<string, unknown>>} object
 * @param {string} key
 * @returns {unknown}
 */
function ownProperty(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * `str(exc)`: the message alone, which is what the source interpolates into the
 * unreadable-fence reason.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return safeString(error);
}

/**
 * `repr(exc)`: the class name and the quoted message, which is what the source
 * interpolates into both self-check reasons.
 *
 * Python's own `repr` is not reachable from here -- `pyRepr` lives in the
 * module set that may be the thing that failed to load -- so this is a local
 * rendering of the same shape. The text is diagnostic, read by an operator on
 * stderr; the wire-visible half of the payload is the `permissionDecision`,
 * and that is identical.
 *
 * @param {unknown} error
 * @returns {string}
 */
function formatError(error) {
  if (!(error instanceof Error)) {
    return safeString(error);
  }
  const name = typeof error.name === "string" && error.name !== "" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : "";
  const quoted = message
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `${name}('${quoted}')`;
}

/**
 * `String(value)` that cannot itself throw.
 *
 * A thrown value with a hostile `toString` -- or a symbol, where `String` on
 * the value is fine but template interpolation is not -- would otherwise turn
 * the deny path into the throw it exists to prevent.
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeString(value) {
  try {
    return String(value);
  } catch {
    return "<unprintable error>";
  }
}

/** Set once a payload has reached stdout, so the fatal handler cannot double it. */
let payloadWritten = false;

/**
 * @param {string} text
 * @returns {void}
 */
function writeStdout(text) {
  payloadWritten = true;
  try {
    process.stdout.write(text);
  } catch {
    // A closed pipe (EPIPE) must not become a throw: the exit status still
    // denies, and denying with no readable payload beats a traceback and exit
    // 1. The source has no equivalent guard, and inherits the traceback.
  }
}

/**
 * @param {string} text
 * @returns {void}
 */
function writeStderr(text) {
  try {
    process.stderr.write(text);
  } catch {
    // As above. stderr is diagnostic only.
  }
}

/**
 * Is this file the process entry point?
 *
 * Compared through `realpath` because the rendered hook command may name the
 * script through a symlink (an installed `node_modules` tree commonly does),
 * and a string comparison would then decide that a hook running as a hook is
 * merely being imported -- so it would decide nothing and exit 0.
 *
 * @returns {boolean}
 */
function invokedAsScript() {
  try {
    const entry = process.argv[1];
    if (entry === undefined) {
      return false;
    }
    return realpathSafe(entry) === realpathSafe(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function realpathSafe(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The handler of last resort for the two ways Node ends a process at exit 1
 * without asking this file anything.
 *
 * @param {unknown} error
 * @returns {void}
 */
/**
 * Whether a fatal error has already forced a deny.
 *
 * A deny is never downgraded. Once this is set, the exit status is EXIT_DENY for
 * the life of the process, whatever else finishes afterwards.
 */
let fatalDeny = false;

function denyAndExit(error) {
  const reason = `Interlock deny hook failed and denied by default: ${formatError(error)}`;
  if (!payloadWritten) {
    writeStdout(dumps(literalDenyPayload(reason)));
  }
  writeStderr(`${reason}\n`);
  // Latched, and the latch is the point. A fatal error can fire while `main()`
  // is still pending -- and `main()` may then resolve normally with
  // EXIT_NO_OPINION, for a tool call the fence genuinely had no opinion about.
  // Without the latch that resolution overwrites this deny and the process exits
  // 0: the hook hit a fatal error and told the CLI to proceed anyway, which is
  // exactly the fail-open these handlers exist to prevent.
  fatalDeny = true;
  process.exitCode = EXIT_DENY;
}

if (invokedAsScript()) {
  // Installed only on the by-path launch, so importing this module for its
  // exports does not silently take over the host process's error handling.
  process.on("uncaughtException", denyAndExit);
  process.on("unhandledRejection", denyAndExit);
  main().then(
    (code) => {
      // `process.exitCode`, never `process.exit`: `process.exit` can truncate a
      // pending write to a pipe, and the payload on stdout *is* the decision.
      // A hook that exits 2 with a truncated payload is a hook whose reason the
      // CLI cannot parse.
      //
      // And never over a fatal deny -- see the latch in `denyAndExit`. A
      // `main()` that resolves with EXIT_NO_OPINION after an uncaught exception
      // has already denied would otherwise turn the fatal error into a permit.
      if (!fatalDeny) {
        process.exitCode = code;
      }
    },
    (error) => {
      denyAndExit(error);
    },
  );
}
