/**
 * The `cli_args` allowlist: which complete argument vectors a role may run with.
 *
 * `D-0088` inverts `D-0086`. `D-0086` named twenty-four flags and refused them,
 * and said in as many words what the shape could not do: a denylist over an
 * option surface this repository does not own is a list of the attacks somebody
 * already thought of, and every spelling nobody thought of -- an attached-value
 * form, a camelCase alias, a short-flag bundle, a flag added by a future release
 * of the child CLI -- passes it. This module is the other side of that: an
 * admitted run's `cli_args` must EQUAL, element by element and in order, one of
 * the complete vectors this document authorises for its role, and everything
 * else is refused. What a name-based rule could not enumerate, an
 * equality-based rule does not have to.
 *
 * **The document authorises nothing as shipped.** Its entry list is empty, and
 * that is the measured lap-1 answer (`D-0088`, decision D1) rather than a
 * placeholder: no lap this repository has ever performed submitted an operator
 * argument, so the honest allowlist is the empty one and every addition is a
 * reviewed edit with a written reason attached. `reason` is a required,
 * non-empty field for exactly that: `deviations`-style free text nothing reads
 * records nothing, and a test can see a structured field. The corpus test in
 * `test/contract/` reads this document and fails an entry whose vector contains
 * a fence-altering flag name unless its `reason` names that flag.
 *
 * This module does NOT own the whole `cli_args` rule. `FENCE_OWNED_FLAGS` and
 * the bare `--` refusal stay in `LapRunIntent`'s constructor and in the
 * materialiser, unchanged and unmoved: the owned flags are *this build's own
 * output*, closed by construction and role-independent, so refusing them is a
 * fact about the record's shape that needs no document to decide. The allowlist
 * is deliberately absent from that constructor for the opposite reason -- the
 * constructor also runs at `lap perform`, through `readLapRunIntent`, so a
 * document-aware constructor would make an already admitted run *unreadable*
 * the moment its authorising entry was removed, and unreadable means the run
 * cannot be reported or closed either (`D-0088`, decision D5).
 *
 * The refusal is a `string` detail rather than a thrown error because the three
 * enforcement points each raise their own subsystem's refusal type -- admission
 * throws a `ControlPlaneRefusal`, the lap and the materialiser their own -- and
 * a shared exception class would have forced one of them to catch and retype.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pyRepr } from "./pyrepr.js";

/** One authorised whole-vector entry, as this build reads it off disk. */
export interface CliArgsAllowEntry {
  readonly role: string;
  readonly cliArgs: readonly string[];
  readonly reason: string;
}

/**
 * The document is missing, undecodable, unparseable, or not the shape this
 * build reads.
 *
 * Deliberately NOT `FenceRefusal`. `FenceRefusal` carries interlock's ported
 * refusal reasons, and `document-unreadable` there means *the carried
 * `roles.json`* could not be read -- a claim the ledger and the breach battery
 * both compare against. This document is continuo's own, introduced by
 * `D-0088`, and giving its read failures interlock's refusal code would make a
 * continuo-only condition indistinguishable from a ported one in every place
 * that groups by code.
 *
 * Every caller treats it as fatal, which is the fail-closed direction: an
 * allowlist that cannot be read authorises nothing, so a corrupt document stops
 * runs rather than admitting them.
 */
export class CliArgsAllowlistUnreadable extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CliArgsAllowlistUnreadable";
    Object.setPrototypeOf(this, CliArgsAllowlistUnreadable.prototype);
  }
}

/**
 * Where the bundled `cli_args_allow.json` lives relative to this module.
 *
 * `fileURLToPath`, never `URL.pathname`, for the reason `bundledDocumentPath`
 * in `renderer.ts` spells out at length: `.pathname` is the URL's *encoded*
 * path component, so on Windows it yields a leading-slash form
 * (`/C:/checkout/cli_args_allow.json`) that `readFileSync` rejects, and on
 * every platform a checkout under a directory containing a space resolves to
 * `.../my%20worker/cli_args_allow.json` and opens with ENOENT. Here the
 * consequence is worse than a bad refusal message: the document would be
 * unreadable, so `cliArgsRefusal` would throw for every non-empty vector and no
 * run carrying operator arguments could be admitted anywhere.
 *
 * `tsc` does not copy data files, so `scripts/copy-cli-args-allow-document.mjs`
 * is what puts the document beside the compiled module in `dist/`.
 */
export function bundledCliArgsAllowPath(): string {
  return fileURLToPath(new URL("./cli_args_allow.json", import.meta.url));
}

/** `describe`, for the exception text this module interpolates. */
function describe(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys an entry may carry. Anything else is a document this build cannot read. */
const ENTRY_KEYS: readonly string[] = ["role", "cli_args", "reason"];

/**
 * Read, decode, parse and schema-check the document.
 *
 * The schema is strict in both directions -- a missing key and an unknown key
 * are equally fatal -- and that is the point rather than fussiness. A lenient
 * reader silently ignores the key it does not recognise, so a document written
 * against a later schema (say one that grew an `expires` field) would be read
 * by this build as an *unconditional* authorisation, which is the widening this
 * whole decision exists to prevent. Failing closed on the unknown key turns a
 * version skew into a stop instead of a silent grant.
 */
export function loadCliArgsAllowlist(path?: string): readonly CliArgsAllowEntry[] {
  const target = path ?? bundledCliArgsAllowPath();
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch (exc) {
    throw new CliArgsAllowlistUnreadable(`${target}: ${describe(exc)}`, { cause: exc });
  }
  // Read the bytes and decode them separately, with the STRICT decoder --
  // `readFileSync(target, "utf-8")` and `Buffer.toString("utf8")` under it
  // substitute U+FFFD for every undecodable byte and never fail. `renderer.ts`
  // makes the same split for the same reason, and here the consequence is a
  // vector that compares unequal to itself: an entry authorising
  // `--allowedTools` with one stray byte inside it becomes
  // `--allowedTo\uFFFDols`, which no submitted argument can ever equal, so the
  // entry silently authorises nothing. That direction is fail-closed and would
  // therefore go unnoticed until an operator is refused a vector the document
  // visibly contains -- and the mirror-image byte, one inside the SUBMITTED
  // vector, cannot arise here because it never left this process. A byte the
  // decoder cannot read is a stop, not a substitution.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (exc) {
    throw new CliArgsAllowlistUnreadable(`${target}: ${describe(exc)}`, { cause: exc });
  }
  let document: unknown;
  try {
    // `JSON.parse`, not `pyJsonLoads`: nothing about this document's behaviour
    // depends on its source key order. It is continuo's own document, read into
    // a fixed three-field shape, and no refusal message reprs a mapping out of
    // it -- which is the only thing `pyJsonLoads` buys `renderer.ts`.
    document = JSON.parse(text);
  } catch (exc) {
    throw new CliArgsAllowlistUnreadable(`${target}: ${describe(exc)}`, { cause: exc });
  }
  if (!isPlainObject(document)) {
    throw new CliArgsAllowlistUnreadable(
      `${target}: document must be a JSON object, got ${pyRepr(document)}`,
    );
  }
  const topKeys = Object.keys(document);
  if (topKeys.length !== 1 || topKeys[0] !== "entries") {
    throw new CliArgsAllowlistUnreadable(
      `${target}: document must have exactly one key 'entries', got ${pyRepr(topKeys)}`,
    );
  }
  const raw = document["entries"];
  if (!Array.isArray(raw)) {
    throw new CliArgsAllowlistUnreadable(
      `${target}: 'entries' must be an array, got ${pyRepr(raw)}`,
    );
  }
  const entries: CliArgsAllowEntry[] = [];
  for (const [index, item] of raw.entries()) {
    // The index is in every message below because an operator editing this
    // document has to find the offending line, and a bare "entry is malformed"
    // over a list of near-identical vectors names nothing.
    if (!isPlainObject(item)) {
      throw new CliArgsAllowlistUnreadable(
        `${target}: entry ${index} must be a JSON object, got ${pyRepr(item)}`,
      );
    }
    const keys = Object.keys(item).sort();
    const expected = [...ENTRY_KEYS].sort();
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
      throw new CliArgsAllowlistUnreadable(
        `${target}: entry ${index} must have exactly the keys ` +
          `${pyRepr(expected)}, got ${pyRepr(keys)}`,
      );
    }
    const role = item["role"];
    if (typeof role !== "string" || role.length === 0) {
      throw new CliArgsAllowlistUnreadable(
        `${target}: entry ${index} 'role' must be a non-empty string, got ${pyRepr(role)}`,
      );
    }
    const cliArgs = item["cli_args"];
    if (!Array.isArray(cliArgs) || cliArgs.some((arg) => typeof arg !== "string")) {
      throw new CliArgsAllowlistUnreadable(
        `${target}: entry ${index} 'cli_args' must be an array of strings, got ` +
          `${pyRepr(cliArgs)}`,
      );
    }
    const reason = item["reason"];
    // Trimmed, because `reason` exists to be READ by the reviewer of the edit
    // that adds an entry and by the corpus test that gates a fence-altering
    // flag on it. A whitespace-only string satisfies "present and a string"
    // while recording exactly as much as an absent one.
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new CliArgsAllowlistUnreadable(
        `${target}: entry ${index} 'reason' must be a non-empty string, got ${pyRepr(reason)}`,
      );
    }
    entries.push({ role, cliArgs: [...(cliArgs as string[])], reason });
  }
  return entries;
}

/**
 * `undefined` when `role` may run with `cliArgs`; otherwise the one-line ASCII
 * refusal detail the caller interpolates into its own refusal type.
 *
 * **The document is loaded on every call, deliberately.** A cached allowlist
 * would let a run admitted while an entry existed still perform after the entry
 * was removed, and `lap perform` re-asks precisely because the document can be
 * narrowed after admission -- caching would give it the admitted-time answer
 * and quietly delete the second of the three enforcement points. The document
 * is a few hundred bytes read at most three times per lap.
 */
export function cliArgsRefusal(
  role: string,
  cliArgs: readonly string[],
  path?: string,
): string | undefined {
  // A zero-length vector is authorised unconditionally, by a RULE and not by an
  // entry (`D-0088`, decision D10), and it is checked before anything is read
  // so that a broken document cannot refuse it either.
  //
  // It is a rule because exact matching against an absent entry list matches
  // nothing: a literal implementation would refuse the no-argument run every
  // lap this repository has ever performed, which is every lap. And it is not
  // spelled as an entry (`{"role": ..., "cli_args": [], ...}` per role) because
  // that would make a deletable line load-bearing -- somebody tidying an entry
  // list they read as "the exceptions" would stop the whole system, and a role
  // added to the roster without its matching `[]` entry could never run at all.
  // The absence of operator arguments is not an argument, so it needs no
  // authorisation.
  if (cliArgs.length === 0) {
    return undefined;
  }
  const target = path ?? bundledCliArgsAllowPath();
  const entries = loadCliArgsAllowlist(target);
  for (const entry of entries) {
    if (entry.role !== role) {
      continue;
    }
    // Exact whole-vector equality: same length, then element by element, in
    // order. Not a subset, not a window, not a per-flag rule.
    //
    // A fragment matched against a window was rejected because fragments
    // compose: two individually reviewed fragments can be concatenated,
    // reordered and repeated into an argv nobody reviewed, and CLI options
    // interact in ways this decision rests on refusing to model. A flag NAME
    // plus an arity was rejected for the same reason from the other end -- a
    // name and a count is a model of the child CLI's option grammar, and
    // `D-0086` is the record of this repository deciding it does not own that
    // grammar. Whole vectors have no composition rule to get wrong, and they
    // dissolve the questions a name-based rule cannot answer: an attached-value
    // spelling (`--allowedTools=Edit`), a camelCase alias and a short-flag
    // bundle are all simply different byte sequences, and none of them equals
    // an authorised vector.
    if (entry.cliArgs.length !== cliArgs.length) {
      continue;
    }
    if (entry.cliArgs.every((arg, index) => arg === cliArgs[index])) {
      return undefined;
    }
  }
  // `pyRepr` for both the role and the vector, never raw interpolation: an
  // argument is operator-supplied text, and one carrying a newline or a quote
  // would otherwise forge a second line of CLI output that reads like the
  // tool's own (`docs/cli-output-policy.md`, `D-0006`). `pyRepr` escapes both
  // into a single unambiguous line.
  //
  // The detail names the DOCUMENT as well as the role and the vector, because
  // an operator who is refused needs to know where the answer is authored --
  // "this is not authorised" without a path is a refusal nobody can act on, and
  // under the shipped empty document that is every non-empty vector.
  return (
    `cli_args ${pyRepr([...cliArgs])} is not authorised for role ${pyRepr(role)} ` +
    `by ${target}; an admitted run's cli_args must equal an authorised vector exactly`
  );
}
