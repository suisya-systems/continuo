/**
 * The watcher's closed fact-state vocabulary, as continuo's detector layer holds it.
 *
 * Six names, carried from interlock `D-0005` and restated in this repository's `DECISIONS.md`
 * at `D-0302`. `D-0302` restated them for one purpose only -- to give the S1 vocabulary lint an
 * oracle -- and said so: "a restatement for the oracle's sake, not an adoption". `D-0901`
 * supersedes that limitation and adopts the six as the set the detector layer uses. This module
 * is where the adoption lands.
 *
 * **What this module deliberately does not contain.** No predicate, no classification logic, no
 * per-state semantics, and no mapping from anything to a fact state. interlock `Q-0012` -- what
 * each state *means*, and when it holds -- is open, and a port does not close an upstream
 * question by shipping an implementation of it. So the surface is a type, a list and a refusal:
 * enough to say "this is one of the six" and nothing at all about which one anything is.
 *
 * A seventh name is added by a new `D-` entry, never by editing this list. That rule is the
 * procedural half of interlock `D-0005`, carried with the names, and it is why three other
 * copies of the set exist in this repository rather than one import: they were written against
 * different subjects (a fixture label, an acceptance contract, a decision record) and each has
 * its own reason to be where it is. `test/contract/fact-state-vocabulary.test.ts` is what keeps
 * them from drifting apart.
 */

/** One of the six. A `string` that is not one of them is not a fact state. */
export type FactState =
  | "ACTIVE_EVIDENCE"
  | "KNOWN_WAIT"
  | "EXPLICIT_BLOCK"
  | "NO_ACTIVITY_EVIDENCE"
  | "OBSERVATION_UNAVAILABLE"
  | "TERMINAL";

/**
 * The closed set, in `D-0302`'s order.
 *
 * Frozen because TypeScript's `readonly` is a compile-time claim and every other copy of this
 * vocabulary in the repository is closed at runtime too (`src/measurement/fixtures.ts` freezes
 * its list; `test/fault_injection/contract.ts` freezes its map). A consumer that could push a
 * seventh name onto this array would have added a fact state without a `D-` entry, which is the
 * one way the set is not allowed to grow.
 */
export const FACT_STATES: readonly FactState[] = Object.freeze([
  "ACTIVE_EVIDENCE",
  "KNOWN_WAIT",
  "EXPLICIT_BLOCK",
  "NO_ACTIVITY_EVIDENCE",
  "OBSERVATION_UNAVAILABLE",
  "TERMINAL",
]);

/**
 * Refuse anything that is not one of the six.
 *
 * A membership check and nothing more -- it does not know what any of the names mean, and it is
 * not a place to teach it. The message names the closed set and the rule that governs it, so a
 * caller reading the refusal learns why a near-miss spelling is not accepted rather than only
 * that it was rejected.
 */
export function assertFactState(value: unknown): asserts value is FactState {
  if (typeof value !== "string" || !FACT_STATES.includes(value as FactState)) {
    throw new TypeError(
      `fact_state=${JSON.stringify(value)} is not one of D-0901's closed set ` +
        `(${FACT_STATES.join(", ")}); a seventh state is a new D- entry, not a value`,
    );
  }
}
