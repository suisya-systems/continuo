import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { pyStrip } from "../../src/fencing/pysemantics.js";
import {
  ABSTRACT_METHODS,
  CAPABILITY_ASSIGNMENTS,
  CapabilityReport,
  type CapabilityReportFields,
  ContractViolation,
  checkSpawnPrecondition,
  D0009_VERBS,
  DELIVERY_ABSENCE_IS_DELIBERATE,
  Failure,
  FailureKind,
  Observation,
  Ok,
  OWNER_MESSAGE_BUS,
  OWNER_NEITHER_CONTRACT,
  OWNER_SESSION_PROVIDER,
  PROMOTION_REQUIRES,
  PROVISIONAL,
  type ProviderResult,
  REQUIRED_CAPABILITIES,
  SessionProvider,
  SessionReadout,
  SpawnRefused,
  StartRequest,
  VERB_DOCS,
  VERB_IMPLEMENTATION_HOOKS,
  WorkspaceDecision,
  type WorkspaceLifecycleObserver,
  WorkspaceTransition,
  WorkspaceVerdict,
} from "../../src/session/provider.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";

/**
 * The mechanical half of S1's acceptance criteria (interlock issue #10).
 *
 * Ported from interlock `tests/session/test_provider_contract.py` at `65f36c5`.
 * Every case here maps to one source node id; the eleven target-only cases at
 * the end map to none and are declared as such in the ledger.
 *
 * Seven of those eleven exist because a mutation showed something here was
 * unpinned: a hand-written enum member list, a `Object.freeze` on a `Set` that
 * seals nothing, a defensive copy handed out mutably, a port-added shape guard,
 * an erased `private constructor`, two exception families that could be
 * collapsed into one, and -- for rule 0's ceiling -- an assertion that had been
 * living inside a ported case and asserting more than its source does.
 *
 * Four of the criteria are properties of the *file*, not of any implementation,
 * and each is asserted here rather than trusted to review:
 *
 * - the file says of itself that it is provisional and that promotion needs a
 *   `D-` entry (D-0021);
 * - **no fact-state vocabulary appears anywhere in S1** -- and the forbidden set
 *   is read out of `DECISIONS.md` rather than copied here, so that a seventh
 *   state added by a future `D-` entry is covered the day it is written;
 * - **no delivery verb**, with the absence documented as deliberate (D-0009);
 * - the typed result can never be constructed as an empty success (R4).
 *
 * The rest exercise the two behavioural properties the interface itself
 * implements: the fail-closed spawn precondition (D-0010) and the fail-closed
 * workspace veto.
 *
 * ## What the port had to move, and where the seams are
 *
 * Nothing here spawns, waits, kills or reads a clock -- the source imports only
 * `inspect`, `re` and `pathlib`, and this file's only host dependencies are the
 * same two file reads: `DECISIONS.md`, and the module under test's **own source
 * text**. Three source constructs have no runtime form in TypeScript and are
 * named at their case:
 *
 * - `__doc__`, both the module's and each method's -- replaced by reading this
 *   file's own JSDoc blocks, which is the idiom the source already uses for
 *   `S1_SOURCE`, plus the `VERB_DOCS` registry;
 * - `__abstractmethods__` -- replaced by the `ABSTRACT_METHODS` registry, which
 *   {@link SessionProvider}'s constructor consults, so it cannot drift into
 *   being a description of nothing;
 * - `__init_subclass__` -- the gate refusal moves from class-definition time to
 *   first-instantiation time, which is the whole of that adaptation.
 *
 * Read against `docs/test-translation-conventions.md` rule 9: three of the
 * source's refusals are enforced by a Python **type** (`FailureKind` is an
 * `Enum`, `CapabilityReport` is a class, `frozenset` is not a `set`). A string
 * union or a plain object type in the port would make those refusals unreachable
 * and the cases that name them permanently green, so the implementation brands
 * all three -- and the cases below hand in exactly the impostor the source hands
 * in, so that the branding is what is under test rather than an assumption.
 */

// -- the two file reads, which are the source's own ----------------------

/**
 * The module under test, read as **source text**.
 *
 * `Path(s1.__file__).read_text()` in the source. It must be the `.ts` file and
 * never a build artefact: a lint over `dist/` would be reading transpiled output
 * with the comments -- which are half of what the lint is about -- stripped out,
 * and would pass no matter what this file's prose said. That is rule 10's shape
 * exactly: the case would go green because its subject became unreachable.
 */
const S1_PATH = fileURLToPath(new URL("../../src/session/provider.ts", import.meta.url));
const S1_SOURCE = readFileSync(S1_PATH, "utf8");

/** `REPO_ROOT / "DECISIONS.md"`, reached the same way: two levels up from here. */
const DECISIONS = readFileSync(
  fileURLToPath(new URL("../../DECISIONS.md", import.meta.url)),
  "utf8",
);

/**
 * The heading whose body carries the closed fact-state set.
 *
 * The source splits interlock's `DECISIONS.md` on `## D-0005 -`, with an em
 * dash. **This repository's D-0005 is a different decision** -- the double-green
 * rule -- so a mechanical port would parse an entry with no such bullets and
 * fail on the source's own plausibility guard. D-0302 restates the set here for
 * exactly this reason, and this is the heading the parse is re-pointed at.
 *
 * Written with an escape rather than the character so that this file stays
 * ASCII, as every other source file in the repository is; the escape is the
 * character the heading actually contains, and the parse fails loudly if it ever
 * stops being.
 */
const CLOSED_SET_HEADING = "## D-0302 \u2014";

/**
 * Read D-0302's closed set out of `DECISIONS.md`.
 *
 * Copying the six names into this test would make it stale the moment a `D-`
 * entry adds a seventh -- and both D-0005 (there) and D-0302 (here) say such an
 * entry is exactly how the set may grow. Parsing fails loudly rather than
 * silently checking nothing: an empty or implausible parse is a test failure.
 *
 * The split reproduces Python's `str.split(sep, 1)`: the first occurrence only.
 * A plain `String.prototype.split` would additionally fail if the heading ever
 * appeared twice, which is a different question from the one the source asks.
 */
function factStateNames(): readonly string[] {
  const at = DECISIONS.indexOf(CLOSED_SET_HEADING);
  expect(at, "the closed fact-state entry was not found in DECISIONS.md").toBeGreaterThanOrEqual(0);
  const afterHeading = DECISIONS.slice(at + CLOSED_SET_HEADING.length);
  const body = afterHeading.split("\n## ")[0] ?? afterHeading;
  const names = [...body.matchAll(/^- `([A-Z][A-Z_]+)`$/gm)].map((match) => match[1] as string);
  expect(
    names.length,
    `implausible fact-state parse from the closed-set entry: ${JSON.stringify(names)}`,
  ).toBeGreaterThanOrEqual(6);
  return names;
}

// -- reading this file's own documentation, since JSDoc is not on the object --

/**
 * A JSDoc block, unwrapped to one whitespace-collapsed line.
 *
 * Python's `__doc__` is a string on the object; JSDoc is a comment and is gone
 * before anything runs. So the three assertions the source makes about
 * docstrings are re-pointed at the source text, and this is the unwrapping they
 * share. Collapsing whitespace is what makes the comparison survive the
 * hundred-column wrap: the recorded sentence in `VERB_DOCS` is one line and the
 * block it came from may be three.
 */
function unwrapDocBlock(block: string): string {
  return block
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The module documentation block, which opens the file. */
function moduleDocBlock(source: string): string {
  expect(
    source.startsWith("/**"),
    "provider.ts must open with its module documentation block",
  ).toBe(true);
  const end = source.indexOf("*/");
  expect(end, "provider.ts's module documentation block is unterminated").toBeGreaterThan(0);
  return unwrapDocBlock(source.slice(0, end + 2));
}

/**
 * The documentation block immediately preceding a declaration.
 *
 * "Immediately" is checked, not assumed: only whitespace may sit between the
 * block's `*` + `/` and the declaration. Without that check the search would
 * happily return some *earlier* declaration's block, and a case asserting "this
 * method is documented" would be reading another method's documentation.
 */
function docBlockBefore(source: string, declaration: RegExp): string {
  const at = source.search(declaration);
  expect(at, `declaration not found in provider.ts: ${String(declaration)}`).toBeGreaterThan(0);
  const closed = source.lastIndexOf("*/", at);
  expect(closed, `no documentation block precedes ${String(declaration)}`).toBeGreaterThan(0);
  const opened = source.lastIndexOf("/**", closed);
  expect(opened, `no documentation block precedes ${String(declaration)}`).toBeGreaterThan(0);
  expect(
    source.slice(closed + 2, at).trim(),
    `the documentation block before ${String(declaration)} is not adjacent to it`,
  ).toBe("");
  return unwrapDocBlock(source.slice(opened, closed + 2));
}

/** The class declaration, for {@link docBlockBefore}. */
const SESSION_PROVIDER_DECLARATION = /^export abstract class SessionProvider/m;

/**
 * A method declaration inside the class body, for {@link docBlockBefore}.
 *
 * Anchored to the start of a two-space-indented line so that `start(` cannot
 * match `_startSession(`, and so that a method **name** appearing in a data
 * literal -- `D0009_VERBS` holds `stop` twice -- cannot be mistaken for its
 * declaration.
 */
function methodDeclaration(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^ {2}(?:protected )?(?:abstract )?${escaped}\\(`, "m");
}

/**
 * `inspect.getmembers(SessionProvider, callable)`, filtered to public names.
 *
 * `getmembers` walks the whole MRO. The prototype chain is the analogue, and it
 * is walked rather than read once because the abstract verbs and the concrete
 * ones could in principle live on different links -- reading
 * `SessionProvider.prototype`'s own properties would answer a narrower question
 * than the source's.
 *
 * Two boundaries are deliberate. `constructor` is dropped: Python has no
 * equivalent public entry, and while it matches none of the forbidden words,
 * leaving it in would be a silent difference rather than a decided one. The walk
 * stops at `Object.prototype`, whose members (`hasOwnProperty`, `valueOf`, ...)
 * are the JavaScript analogue of what Python's `object` contributes -- and
 * Python's own filter removes every one of those, because they are all dunder.
 * Including them would put six names on the surface that are not this class's.
 *
 * Descriptors rather than property reads, so that a future accessor on the
 * prototype is classified without being invoked.
 */
function publicSurfaceOf(cls: abstract new (...args: never[]) => unknown): string[] {
  const names: string[] = [];
  let proto: object | null = cls.prototype as object;
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || name.startsWith("_") || names.includes(name)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor !== undefined && typeof descriptor.value === "function") {
        names.push(name);
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return names;
}

/** `getattr(SessionProvider, name)`, resolved through the prototype chain. */
function resolveOnProvider(name: string): unknown {
  return (SessionProvider.prototype as unknown as Record<string, unknown>)[name];
}

// -- the cases -----------------------------------------------------------

test("test_file_marks_itself_provisional_and_names_what_promotes_it", () => {
  // D-0021: provisional *in the file itself*, promoted only by a D- entry.
  expect(PROVISIONAL).toBe(true);
  expect(PROMOTION_REQUIRES).toContain("D-0021");
  expect(PROMOTION_REQUIRES).toContain("D-");
  // The two docstring halves, re-pointed at the source text. Note that the
  // module block is extracted rather than the whole file being searched: the
  // whole file contains the word through PROMOTION_REQUIRES, so a file-wide
  // search would pass without the module documentation saying anything.
  const moduleDoc = moduleDocBlock(S1_SOURCE);
  expect(moduleDoc.toLowerCase()).toContain("provisional");
  expect(moduleDoc).toContain("D-0021");
  const classDoc = docBlockBefore(S1_SOURCE, SESSION_PROVIDER_DECLARATION);
  expect(classDoc.toLowerCase()).toContain("provisional");
});

test("test_no_fact_state_vocabulary_appears_anywhere_in_s1", () => {
  // D-0005 / D-0302 / D-0021: conversion belongs to the detector layer, not
  // here. Checked against the whole source text, including comments, and
  // against the prose spelling of each name as well as the token -- writing a
  // fact-state name into a comment maps the interface onto the fact-state set
  // just as surely as importing the constant would.
  //
  // The pattern construction is the source's, character for character: each
  // underscore becomes a one-character class of underscore, space or hyphen,
  // the search is case-insensitive, and there are no word boundaries -- so one
  // of the six names matches inside longer English words. That is not an
  // accident of the regex; it is what makes the lint reach prose.
  const offenders: string[] = [];
  for (const name of factStateNames()) {
    const pattern = new RegExp(name.replace(/_/g, "[_ -]"), "i");
    if (pattern.test(S1_SOURCE)) {
      offenders.push(name);
    }
  }
  expect(
    offenders,
    `fact-state vocabulary in S1: ${JSON.stringify(offenders)}. Provider lifecycle is ` +
      "carried uninterpreted; conversion belongs to the detector layer.",
  ).toEqual([]);
});

test("test_no_delivery_verb_and_the_absence_is_documented", () => {
  // D-0009: delivery is MessageBus's, and S1 records its absence.
  const deliveryWords = /deliver|send|dispatch|publish|enqueue|message|notify|prompt|keystroke/i;
  const publicMethods = publicSurfaceOf(SessionProvider);
  const offenders = publicMethods.filter((name) => deliveryWords.test(name));
  expect(
    offenders,
    `delivery-shaped method on SessionProvider: ${JSON.stringify(offenders)}`,
  ).toEqual([]);

  expect(DELIVERY_ABSENCE_IS_DELIBERATE).toContain("MessageBus");
  expect(DELIVERY_ABSENCE_IS_DELIBERATE).toContain("D-0009");
});

test("test_exactly_the_five_d0009_verbs_and_no_sixth", () => {
  // Five verbs, the probe as a precondition, and nothing else to implement.
  //
  // ADAPTED. `__abstractmethods__` and per-method `__doc__` have no runtime form
  // in TypeScript, so `abstract` reads the ABSTRACT_METHODS registry and the
  // docstring half reads VERB_DOCS. Both registries are hand-maintained and both
  // carry a target-only liveness case below, because a registry that has drifted
  // from the class satisfies every assertion made about it.
  expect(D0009_VERBS.size).toBe(5);
  for (const [verb, method] of D0009_VERBS) {
    expect(typeof resolveOnProvider(method), verb).toBe("function");
    expect(VERB_DOCS.get(method), `${method} has no recorded documentation`).toBeTruthy();
  }

  const abstract = ABSTRACT_METHODS;
  const hooks = new Set(VERB_IMPLEMENTATION_HOOKS.values());
  for (const hook of hooks) {
    expect(abstract.has(hook), `${hook} is a verb hook but is not abstract`).toBe(true);
  }
  expect([...abstract].filter((name) => !hooks.has(name))).toEqual(["probeCapabilities"]);
  expect(VERB_DOCS.get("probeCapabilities")).toBeTruthy();
  // start is the one verb whose public half is concrete: it is the gate.
  expect(abstract.has("start")).toBe(false);
  // `_start_session` in the source. Method names are camelCase in this port
  // (D-0201); the underscore prefix is kept because it is what keeps the hook
  // off the public surface the delivery-verb case walks.
  expect(VERB_IMPLEMENTATION_HOOKS.get("start")).toBe("_startSession");
});

test("test_three_capabilities_each_have_a_named_owner", () => {
  // D-0021: assigned explicitly, including the 'belongs to neither' answer.
  const assignments = CAPABILITY_ASSIGNMENTS;
  expect(assignments.length).toBe(3);
  const owners = new Set(assignments.map((assignment) => assignment.owner));
  expect(owners).toEqual(
    new Set([OWNER_MESSAGE_BUS, OWNER_NEITHER_CONTRACT, OWNER_SESSION_PROVIDER]),
  );
  for (const assignment of assignments) {
    // `assignment.capability.strip()` in the source, and `pyStrip` rather than
    // `String.prototype.trim` because this repository has already measured that
    // the two are different functions (`src/fencing/pysemantics.ts`): Python
    // strips U+001C..U+001F and U+0085, JavaScript does not. A capability of
    // "\u001c" is falsy after `.strip()` and truthy after `.trim()`, so the
    // naive spelling is a case that passes where the source's fails.
    expect(pyStrip(assignment.capability)).toBeTruthy();
    expect(pyStrip(assignment.reason)).toBeTruthy();
  }
  const byOwner = new Map(assignments.map((assignment) => [assignment.owner, assignment]));
  // Owning a capability and putting it in S1 are different things.
  expect(byOwner.get(OWNER_MESSAGE_BUS)?.inThisInterface).toBe(false);
  expect(byOwner.get(OWNER_NEITHER_CONTRACT)?.inThisInterface).toBe(false);
  expect(byOwner.get(OWNER_SESSION_PROVIDER)?.inThisInterface).toBe(true);
});

// -- R4: the typed result is never an empty one ---------------------------

test("test_ok_cannot_carry_nothing", () => {
  // `Ok(None)` in the source. `null` is the direct translation; the second
  // nothing JavaScript has is a target-only case below, because Python cannot
  // express it and this slot belongs to the source's case.
  expectRefusal(() => new Ok(null), ContractViolation);
});

test("test_ok_may_carry_an_empty_collection", () => {
  // Zero sessions is a fact the provider reported, not a failure.
  expect(new Ok([]).value).toEqual([]);
});

parametrize(
  "test_failure_must_say_why",
  [
    // The ids are pytest's, verbatim from the inventory: the empty string
    // produces `[]` and three spaces produce `[   ]`, unsanitised. They look
    // like typography and they are node ids.
    ["", ""],
    ["   ", "   "],
  ],
  (detail: string) => {
    expectRefusal(() => new Failure(FailureKind.BACKEND_UNREACHABLE, detail), ContractViolation);
  },
);

test("test_failure_kind_comes_from_the_closed_vocabulary", () => {
  // The member's own `.value` string is not the member. This is the case that
  // makes the branding load-bearing: modelled as a string union or a TypeScript
  // string enum, the argument below would BE a FailureKind at runtime and this
  // case could never fail. The cast is how a JavaScript caller -- or any caller
  // reading a value out of JSON -- reaches the guard.
  expectRefusal(
    () => new Failure("backend-unreachable" as unknown as FailureKind, "provider not reachable"),
    ContractViolation,
  );
});

// -- the readout, including its "could not observe" case ------------------

test("test_observed_readout_carries_the_providers_own_state_word", () => {
  const readout = new SessionReadout({
    sessionId: "s-1",
    observation: Observation.OBSERVED,
    providerState: "running",
  });
  expect(readout.providerState).toBe("running");
  // `is None` in the source. The port normalises the omitted field to `null`,
  // which is the dataclass default, so this stays an identity check.
  expect(readout.couldNotObserveReason).toBeNull();
});

test("test_observed_readout_without_a_state_is_refused", () => {
  expectRefusal(
    () => new SessionReadout({ sessionId: "s-1", observation: Observation.OBSERVED }),
    ContractViolation,
  );
});

test("test_could_not_observe_must_say_why_and_must_not_invent_a_state", () => {
  expectRefusal(
    () => new SessionReadout({ sessionId: "s-1", observation: Observation.COULD_NOT_OBSERVE }),
    ContractViolation,
  );
  // Both a state and a reason: refused for the state, because that check runs
  // first. One case, three parts, kept in one test as the source has it.
  expectRefusal(
    () =>
      new SessionReadout({
        sessionId: "s-1",
        observation: Observation.COULD_NOT_OBSERVE,
        providerState: "running",
        couldNotObserveReason: "no parseable output yet",
      }),
    ContractViolation,
  );
  const readout = new SessionReadout({
    sessionId: "s-1",
    observation: Observation.COULD_NOT_OBSERVE,
    couldNotObserveReason: "child alive, nothing parseable emitted yet",
  });
  expect(readout.providerState).toBeNull();
});

// -- D-0010: the capability probe and its fail-closed spawn precondition ---

/** `_report(**overrides)`: a compatible report unless a field is overridden. */
function report(overrides: Partial<CapabilityReportFields> = {}): CapabilityReport {
  const fields: CapabilityReportFields = {
    providerVersion: "test-provider 1.0",
    supported: new Set(REQUIRED_CAPABILITIES),
    ...overrides,
  };
  return new CapabilityReport(fields);
}

test("test_a_compatible_probe_is_the_only_case_that_permits_a_spawn", () => {
  // The source writes `report = check = check_spawn_precondition(...)` -- a
  // chained assignment, so both names are the same object and the two-name
  // spelling is a rewrite that never happened. One variable here; no assertion
  // was dropped.
  const check = checkSpawnPrecondition(new Ok(report()));
  expect(check.compatible).toBe(true);
  expect(check.missing.size).toBe(0);
});

test("test_an_unprobed_provider_refuses_the_spawn", () => {
  // Fail closed means the absence of an answer refuses (D-0010).
  expectRefusal(() => checkSpawnPrecondition(null), SpawnRefused);
});

test("test_a_failed_probe_refuses_the_spawn", () => {
  expectRefusal(
    () => checkSpawnPrecondition(new Failure(FailureKind.BACKEND_UNREACHABLE, "CLI not found")),
    SpawnRefused,
  );
});

test("test_a_probe_missing_any_required_capability_refuses_the_spawn", () => {
  const partial = new Set(REQUIRED_CAPABILITIES);
  partial.delete("session.resume");
  // The source asserts the substring only, so the port is free on quoting -- but
  // the missing names must be sorted, or the message is nondeterministic.
  expectRefusal(
    () => checkSpawnPrecondition(new Ok(report({ supported: partial }))),
    SpawnRefused,
    "session.resume",
  );
});

test("test_an_unidentified_provider_cannot_even_report_capabilities", () => {
  // A ContractViolation, not a SpawnRefused: the report cannot be constructed at
  // all, so the refusal happens one layer earlier than the spawn precondition.
  //
  // The two exception families are distinct on purpose -- but note what this
  // case does NOT check. `expectRefusal(..., ContractViolation)` here and
  // `expectRefusal(..., SpawnRefused)` next door both keep passing if the port
  // collapses the two into one class: measured, both with
  // `export const SpawnRefused = ContractViolation` and with
  // `class SpawnRefused extends ContractViolation`. The disjointness has a
  // target-only case of its own below; an earlier comment here claimed this
  // pair would notice, and it would not.
  expectRefusal(() => report({ providerVersion: "" }), ContractViolation);
});

/**
 * A provider that does nothing except answer the probe as told.
 *
 * The only "provider" in the file, and the only variable in it is what its probe
 * returns. `started` is a static, written through `this.constructor` so that it
 * lands on the **most derived** class -- which is why the two subclasses in the
 * gate case each redeclare it, and why the refused half and the permitted half
 * cannot contaminate each other.
 *
 * The four unexercised verbs throw, as the source's raise `NotImplementedError`.
 * They are `Promise`-returning per D-0301, and throwing synchronously from them
 * is deliberate: if one is ever reached, the failure should arrive as a thrown
 * error at the call site rather than as an unhandled rejection somewhere else.
 */
class Provider extends SessionProvider {
  static started = false;

  readonly #probeResult: ProviderResult<CapabilityReport>;

  constructor(probeResult: ProviderResult<CapabilityReport>) {
    super();
    this.#probeResult = probeResult;
  }

  probeCapabilities(): ProviderResult<CapabilityReport> {
    return this.#probeResult;
  }

  protected _startSession(request: StartRequest): Promise<ProviderResult<SessionReadout>> {
    (this.constructor as unknown as { started: boolean }).started = true;
    return Promise.resolve(
      new Ok(
        new SessionReadout({
          sessionId: request.sessionId,
          observation: Observation.COULD_NOT_OBSERVE,
          couldNotObserveReason: "just created, nothing emitted yet",
        }),
      ),
    );
  }

  listSessions(): Promise<ProviderResult<readonly SessionReadout[]>> {
    throw new Error("not exercised here");
  }

  readState(_sessionId: string): Promise<ProviderResult<SessionReadout>> {
    throw new Error("not exercised here");
  }

  stop(_sessionId: string): Promise<ProviderResult<SessionReadout>> {
    throw new Error("not exercised here");
  }

  resume(_sessionId: string): Promise<ProviderResult<SessionReadout>> {
    throw new Error("not exercised here");
  }
}

test("test_require_spawnable_is_the_contracts_own_gate_not_each_implementations", () => {
  expect(new Provider(new Ok(report())).requireSpawnable().compatible).toBe(true);
  expectRefusal(
    () =>
      new Provider(
        new Failure(FailureKind.INCOMPATIBLE_PROVIDER, "unknown build"),
      ).requireSpawnable(),
    SpawnRefused,
  );
});

// -- the workspace lifecycle surface (item 7's capability) ----------------

/** `_transition()`. The path is inert data; nothing here touches a filesystem. */
function transition(): WorkspaceTransition {
  return new WorkspaceTransition({ sessionId: "s-1", workspace: "/w/one", kind: "remove-tree" });
}

test("test_no_observers_allows_the_transition", () => {
  const decision = new Provider(new Ok(report())).evaluateWorkspaceTransition(transition());
  expect(decision.verdict).toBe(WorkspaceVerdict.ALLOW);
});

test("test_any_observer_may_veto_and_a_veto_always_says_why", () => {
  const provider = new Provider(new Ok(report()));

  class Vetoer {
    onWorkspaceTransition(): WorkspaceDecision {
      return new WorkspaceDecision(WorkspaceVerdict.VETO, "unsaved artifacts present");
    }
  }

  // A duck-typed plain class, not a subclass of anything: the observer protocol
  // is structural in the source and registration checks nothing.
  provider.registerWorkspaceObserver(new Vetoer());
  const decision = provider.evaluateWorkspaceTransition(transition());
  expect(decision.verdict).toBe(WorkspaceVerdict.VETO);
  expect(decision.reason).toContain("unsaved");

  expectRefusal(() => new WorkspaceDecision(WorkspaceVerdict.VETO), ContractViolation);
});

parametrize(
  "test_a_broken_observer_vetoes_rather_than_letting_the_transition_through",
  [
    ["raises", "raises"],
    ["returns-nonsense", "returns-nonsense"],
  ],
  (bad: string) => {
    // An observer whose own failure allowed the transition is worse than none.
    const provider = new Provider(new Ok(report()));

    class Broken {
      onWorkspaceTransition(): WorkspaceDecision {
        if (bad === "raises") {
          throw new Error("observer blew up");
        }
        // The whole point of the second half: something that is not a decision.
        // TypeScript's return type is what the source's annotation is -- advice,
        // not enforcement -- and the cast is how a JavaScript caller arrives.
        return "sure, go ahead" as unknown as WorkspaceDecision;
      }
    }

    provider.registerWorkspaceObserver(new Broken());
    const decision = provider.evaluateWorkspaceTransition(transition());
    expect(decision.verdict).toBe(WorkspaceVerdict.VETO);
    expect(decision.reason).toBeTruthy();
  },
);

test("test_start_is_gated_by_the_base_class_not_by_the_implementation", async () => {
  // The provider is never asked to create anything on an unusable backend.
  class Refusing extends Provider {
    static override started = false;
  }

  const refusing = new Refusing(new Failure(FailureKind.BACKEND_UNREACHABLE, "CLI not found"));
  // `start` is not an `async` function, so the gate's refusal is thrown on the
  // calling turn exactly as the source raises it -- which is also what makes
  // `started === false` below evidence that the gate ran *first* rather than
  // evidence that an await never happened.
  expectRefusal(
    () => refusing.start(new StartRequest({ sessionId: "s-1", workspace: "/w", role: "worker" })),
    SpawnRefused,
  );
  expect(Refusing.started, "the spawn happened despite a failed probe").toBe(false);

  class Usable extends Provider {
    static override started = false;
  }

  const result = await new Usable(new Ok(report())).start(
    new StartRequest({ sessionId: "s-1", workspace: "/w", role: "worker" }),
  );
  expect(Usable.started).toBe(true);
  // `instanceof`, which requires Ok to be a real class rather than a tagged
  // plain object.
  expect(result).toBeInstanceOf(Ok);
});

/**
 * The two gate names, as node id and as the method this port calls them.
 *
 * The ids are the source's Python spellings, verbatim from the inventory; the
 * values are the camelCase names D-0201 gives them here. Keeping the two columns
 * apart is the whole reason `parametrize` takes an explicit id.
 */
const GATE_CASES = [
  ["start", "start"],
  ["require_spawnable", "requireSpawnable"],
] as const;

parametrize("test_a_subclass_cannot_override_the_gate_away", GATE_CASES, (gate: string) => {
  // ADAPTED. The source refuses at **class-definition** time, via
  // `__init_subclass__`; JavaScript has no hook there at all, so the port
  // refuses at first instantiation. What is checked is unchanged.
  //
  // `type("_Ungated", (_Provider,), {gate: ...})` puts the override in the new
  // class's own dictionary. `defineProperty` on the subclass prototype is the
  // same move, and it is the only way to name the member from a parameter.
  class Ungated extends Provider {}
  Object.defineProperty(Ungated.prototype, gate, {
    value: () => null,
    writable: true,
    configurable: true,
  });

  expectRefusal(() => new Ungated(new Ok(report())), ContractViolation);
});

parametrize(
  "test_a_mixin_earlier_in_the_mro_cannot_override_the_gate_away",
  GATE_CASES,
  (gate: string) => {
    // ADAPTED, twice over. The refusal moves to first instantiation, as above;
    // and `class P(Mixin, Base)` -- a bypass that is invisible in `P.__dict__`
    // because it comes from earlier in the MRO -- has no direct analogue in a
    // language with one prototype chain and no C3 linearisation. Its shape here
    // is a mixin *function*: the override lands on a link of the chain that
    // `Bypassing` itself does not own.
    //
    // That is the case's whole subject. `Bypassing.prototype` has no own
    // `start`, so a check that read own properties would wave the bypass
    // through; both the source's `getattr(cls, gate)` and the port's
    // `newTarget.prototype[gate]` resolve through the chain, which is why both
    // catch it.
    //
    // That property is deliberately NOT asserted here. The source case is a
    // docstring and two statements; it says nothing about `__dict__`, and rule
    // 0's ceiling makes a case that asserts more than its source wrong in the
    // same way as one that asserts less. The assertion is worth having, so it
    // has its own target-only case below rather than this one's slot.
    function mixin(base: typeof Provider): typeof Provider {
      class Mixed extends base {}
      Object.defineProperty(Mixed.prototype, gate, {
        value: () => "ungated",
        writable: true,
        configurable: true,
      });
      return Mixed;
    }

    class Bypassing extends mixin(Provider) {}
    expectRefusal(() => new Bypassing(new Ok(report())), ContractViolation);
  },
);

parametrize(
  "test_a_probe_result_that_is_neither_ok_nor_failure_refuses_the_spawn",
  [
    ["not a result at all", "not a result at all" as unknown],
    // `object()` in the source. pytest cannot render it, so it falls back to the
    // argument name plus the parameter set's index -- hence the id `bogus1`,
    // which is hard-coded here because it is a node id and not a description.
    ["bogus1", {} as unknown],
  ],
  (bogus: unknown) => {
    expectRefusal(
      () => checkSpawnPrecondition(bogus as ProviderResult<CapabilityReport>),
      SpawnRefused,
    );
  },
);

test("test_an_ok_carrying_something_that_is_not_a_report_refuses_the_spawn", () => {
  // A duck-typed stand-in must not spawn just because it says it is compatible.
  //
  // This is the case that makes CapabilityReport's nominality load-bearing. The
  // impostor answers every question the precondition would ask, and in
  // TypeScript it is structurally a report; only the runtime brand refuses it.
  class LooksCompatible {
    readonly compatible = true;
    readonly missing: ReadonlySet<string> = new Set();
    readonly providerVersion = "impostor 1.0";
  }

  expectRefusal(
    () =>
      checkSpawnPrecondition(
        new Ok(new LooksCompatible()) as unknown as ProviderResult<CapabilityReport>,
      ),
    SpawnRefused,
  );
});

test("test_every_observer_is_asked_even_after_a_veto", () => {
  // The surface carries observation as well as veto; order must not decide.
  const provider = new Provider(new Ok(report()));
  const seen: string[] = [];

  class Recording implements WorkspaceLifecycleObserver {
    constructor(
      readonly name: string,
      readonly verdict: WorkspaceVerdict,
    ) {}

    onWorkspaceTransition(): WorkspaceDecision {
      seen.push(this.name);
      if (this.verdict === WorkspaceVerdict.VETO) {
        return new WorkspaceDecision(WorkspaceVerdict.VETO, `${this.name} objects`);
      }
      return new WorkspaceDecision(WorkspaceVerdict.ALLOW);
    }
  }

  provider.registerWorkspaceObserver(new Recording("first", WorkspaceVerdict.VETO));
  provider.registerWorkspaceObserver(new Recording("second", WorkspaceVerdict.ALLOW));
  provider.registerWorkspaceObserver(new Recording("third", WorkspaceVerdict.VETO));

  const decision = provider.evaluateWorkspaceTransition(transition());
  // The fan-out is synchronous (D-0301), so this ordering carries no "sequential
  // await, never Promise.all" caveat: there is no await to get wrong.
  expect(seen).toEqual(["first", "second", "third"]);
  expect(decision.verdict).toBe(WorkspaceVerdict.VETO);
  expect(decision.reason).toContain("first objects");
  expect(decision.reason).toContain("1 further veto");
});

parametrize(
  "test_a_non_string_reason_is_this_interfaces_own_error",
  // Derived from the members rather than listed, as `list(s1.WorkspaceVerdict)`
  // is, so a third verdict would expand this case on the day it is added. The
  // ids are `str(member)` -- `WorkspaceVerdict.ALLOW`, not `ALLOW` -- which is
  // what Python 3.11's `Enum.__str__` produces and what the inventory records.
  WorkspaceVerdict.members.map((verdict) => [String(verdict), verdict] as const),
  (verdict: WorkspaceVerdict) => {
    // `None` for BOTH verdicts, including ALLOW, where a reason is otherwise
    // optional. An omitted argument must still construct, which is why the
    // implementation defaults the parameter before checking its type.
    expectRefusal(
      () => new WorkspaceDecision(verdict, null as unknown as string),
      ContractViolation,
    );
  },
);

// -- target-only: what this port has that the source cannot express -------

test("Ok refuses the second nothing, and refuses nothing else (target-only)", () => {
  // Python has one nullish value and forbids exactly it. JavaScript has two, and
  // `undefined` is what an omitted argument, a missing property and an
  // `await undefined` all produce -- so it means here what `null` means and is
  // refused too. No source case can construct it.
  expectRefusal(() => new Ok(undefined), ContractViolation);

  // The other half of the same decision, and the reason the guard is written as
  // two identity comparisons rather than `if (!value)`: every falsy value the
  // source accepts must still construct. A truthiness check would refuse four
  // values `Ok` exists to carry, and `test_ok_may_carry_an_empty_collection`
  // alone would not notice, because an empty array is truthy.
  expect(new Ok(0).value).toBe(0);
  expect(new Ok("").value).toBe("");
  expect(new Ok(false).value).toBe(false);
  expect(new Ok([]).value).toEqual([]);
});

test("checkSpawnPrecondition reads undefined as unprobed, not as malformed (target-only)", () => {
  // D-0301 leaves this function synchronous while the verbs become
  // Promise-returning, and `await undefined` is `undefined` -- so a provider
  // whose probe forgot to return hands in the second nothing. Both refuse; the
  // point is that they refuse with the same message, so the reader is not sent
  // looking for a malformed result when what happened is a missing one.
  const unprobed = expectRefusal(() => checkSpawnPrecondition(null), SpawnRefused);
  const undefinedProbe = expectRefusal(() => checkSpawnPrecondition(undefined), SpawnRefused);
  expect(undefinedProbe.message).toBe(unprobed.message);
  expect(undefinedProbe.message).toContain("no capability probe has been run");
});

test("ABSTRACT_METHODS is consulted, not merely declared (target-only)", () => {
  // The liveness guard for a hand-maintained registry, in the shape D-0014
  // requires for a seam: without it, ABSTRACT_METHODS could name a set that has
  // nothing to do with the class and every assertion made about it above would
  // still pass. `__abstractmethods__` cannot drift, because ABCMeta derives it;
  // this can, so the constructor is made to depend on it and the dependency is
  // pinned here.
  //
  // The refusal lands where Python's does: ABCMeta refuses at instantiation, not
  // at class definition.
  // Declared `abstract` so that TypeScript accepts the omission: an abstract
  // class may leave inherited abstract members unimplemented, and it still emits
  // an ordinary constructor. That is precisely the caller the runtime check is
  // for -- a class the compiler was never asked to complete, reached through a
  // cast or from JavaScript.
  abstract class Incomplete extends SessionProvider {
    probeCapabilities(): ProviderResult<CapabilityReport> {
      return new Ok(report());
    }

    protected _startSession(_request: StartRequest): Promise<ProviderResult<SessionReadout>> {
      throw new Error("not exercised here");
    }

    listSessions(): Promise<ProviderResult<readonly SessionReadout[]>> {
      throw new Error("not exercised here");
    }

    readState(_sessionId: string): Promise<ProviderResult<SessionReadout>> {
      throw new Error("not exercised here");
    }

    resume(_sessionId: string): Promise<ProviderResult<SessionReadout>> {
      throw new Error("not exercised here");
    }
    // `stop` is deliberately absent. TypeScript would refuse this class, so the
    // declaration is removed from the type as well -- which is exactly the
    // JavaScript caller the runtime check exists for.
  }

  const refusal = expectRefusal(
    () => new (Incomplete as unknown as new () => SessionProvider)(),
    ContractViolation,
  );
  expect(refusal.message).toContain("stop");
});

test("VERB_DOCS quotes this file's own documentation blocks (target-only)", () => {
  // The other hand-maintained registry, and the more fragile of the two: the
  // ported assertion only asks whether the recorded text is non-empty, and the
  // text lives in the same file. Delete a method's JSDoc block and nothing above
  // would notice. So each recorded sentence is required to appear in the block
  // that actually precedes the method it names.
  expect(VERB_DOCS.size).toBeGreaterThan(0);
  for (const [method, doc] of VERB_DOCS) {
    const block = docBlockBefore(S1_SOURCE, methodDeclaration(method));
    expect(block, `${method}'s recorded documentation is not in its own JSDoc block`).toContain(
      doc.replace(/\s+/g, " ").trim(),
    );
  }
});

/**
 * The members a closed vocabulary class actually declares, walked here.
 *
 * Deliberately the same walk the implementation's `derivedMembers` does, and
 * that is not circular: what it pins is that `members` is a **function of the
 * class** rather than a list beside it. Replace the getter with a literal array
 * and this stays green until a member is added -- which is precisely the moment
 * the drift matters, because that is when the source's parametrize axis grows
 * and the port's does not.
 */
function declaredMembers<T>(cls: object, isMember: (value: unknown) => value is T): T[] {
  const found: T[] = [];
  for (const name of Object.getOwnPropertyNames(cls)) {
    const descriptor = Object.getOwnPropertyDescriptor(cls, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      continue;
    }
    if (isMember(descriptor.value)) {
      found.push(descriptor.value);
    }
  }
  return found;
}

test("the closed vocabularies derive their member list from the class (target-only)", () => {
  // `list(SomeEnum)` is derived by EnumMeta, so `list(s1.WorkspaceVerdict)` --
  // a parametrize axis in the battery -- grows the day a member is added. A
  // hand-written array does not: measured, adding a third WorkspaceVerdict and
  // leaving the array alone kept the ported axis at two cases while the
  // source's would have collected three, and the axis's own comment claimed it
  // tracked the class.
  //
  // Each pair is asserted with the walk on one side, so a member that exists on
  // the class but not in `members` fails here; the `toContain` lines keep a
  // vacuous walk (both sides empty) from satisfying the equality.
  expect(declaredMembers(FailureKind, FailureKind.is)).toContain(FailureKind.TIMED_OUT);
  expect([...FailureKind.members]).toEqual(declaredMembers(FailureKind, FailureKind.is));

  expect(declaredMembers(Observation, Observation.is)).toContain(Observation.OBSERVED);
  expect([...Observation.members]).toEqual(declaredMembers(Observation, Observation.is));

  expect(declaredMembers(WorkspaceVerdict, WorkspaceVerdict.is)).toContain(WorkspaceVerdict.VETO);
  expect([...WorkspaceVerdict.members]).toEqual(
    declaredMembers(WorkspaceVerdict, WorkspaceVerdict.is),
  );

  // Declaration order, which is what pytest generates the node ids from and
  // what the inventory records. `list(Enum)` is ordered; a set-shaped or
  // sorted derivation would satisfy everything above and reorder the ids.
  //
  // Stated as a relative order of two known members rather than as the whole
  // list, deliberately: a seventh member must expand the axis, not fail this
  // case. Pinning the exact list would make the derivation's own purpose --
  // growing with the class -- something the suite refuses.
  const verdictNames = WorkspaceVerdict.members.map((verdict) => String(verdict));
  expect(verdictNames.indexOf("WorkspaceVerdict.ALLOW")).toBeLessThan(
    verdictNames.indexOf("WorkspaceVerdict.VETO"),
  );
  const kindNames = FailureKind.members.map((kind) => String(kind));
  expect(kindNames.indexOf("FailureKind.BACKEND_UNREACHABLE")).toBeLessThan(
    kindNames.indexOf("FailureKind.TIMED_OUT"),
  );
});

test("the module's two closed sets refuse mutation rather than sealing nothing (target-only)", () => {
  // `Object.freeze(new Set([...]))` is a no-op for the only property anyone
  // wants from it: it seals own properties, and a Set's contents are in an
  // internal slot. Measured on both constants before the repair --
  // `REQUIRED_CAPABILITIES.add("session.evil")` succeeded and left the set at
  // seven, and `ABSTRACT_METHODS.clear()` left SessionProvider's
  // abstract-method gate accepting a subclass that implements nothing.
  //
  // ABSTRACT_METHODS is the serious half: the constructor consults it on every
  // instantiation, so an emptied set silently disarms the D-0010 gate's
  // neighbour rather than merely mis-describing it.
  expectRefusal(
    () => (REQUIRED_CAPABILITIES as Set<string>).add("session.evil"),
    ContractViolation,
  );
  expectRefusal(
    () => (REQUIRED_CAPABILITIES as Set<string>).delete("session.resume"),
    ContractViolation,
  );
  expect(REQUIRED_CAPABILITIES.size).toBe(6);

  expectRefusal(() => (ABSTRACT_METHODS as Set<string>).clear(), ContractViolation);
  expectRefusal(() => (ABSTRACT_METHODS as Set<string>).delete("stop"), ContractViolation);
  expect(ABSTRACT_METHODS.has("stop")).toBe(true);

  // The seal that does still earn its place: a non-extensible object refuses
  // `setPrototypeOf`, so the refusing methods cannot be removed by re-pointing
  // the instance at `Set.prototype`.
  expect(() => Object.setPrototypeOf(REQUIRED_CAPABILITIES, Set.prototype)).toThrow(TypeError);
});

test("CapabilityReport neither aliases nor exposes its capability set (target-only)", () => {
  // Two holes, closed one at a time, and each with its own mutation.
  //
  // The alias: `this.supported = supported` leaves the caller holding the set
  // the report answers `compatible` from. Nothing pinned the copy -- measured,
  // restoring the alias kept the suite green.
  const supplied = new Set(REQUIRED_CAPABILITIES);
  const built = new CapabilityReport({ providerVersion: "test-provider 1.0", supported: supplied });
  supplied.delete("session.resume");
  expect(built.compatible, "the caller's set is still the report's").toBe(true);
  expect(built.supported.has("session.resume")).toBe(true);

  // The exposure: a defensive copy handed out as a public field on a shallowly
  // frozen instance is itself mutable. Measured before the repair,
  // `report.supported.delete("session.resume")` flipped `compatible` from true
  // to false on a report `checkSpawnPrecondition` had already returned -- the
  // exact state a Python frozenset makes unreachable.
  const returned = checkSpawnPrecondition(new Ok(built));
  expectRefusal(
    () => (returned.supported as Set<string>).delete("session.resume"),
    ContractViolation,
  );
  expect(returned.compatible, "an already-returned report changed its verdict").toBe(true);

  // `missing` is a frozenset in the source too, and is returned fresh per call.
  expectRefusal(() => (built.missing as Set<string>).add("session.start"), ContractViolation);
});

test("a capability set that is not a Set is refused (target-only)", () => {
  // The port-added half of `isinstance(self.supported, frozenset)`. The source's
  // own guard has no case upstream either, so this is not a parity gap -- but
  // measured, `if (false)` in its place left the suite green, and every other
  // port-added guard in this module carries a case that reaches it. An array is
  // how a JavaScript caller, a cast, or a value read out of JSON arrives:
  // `ReadonlySet` is erased and enforces nothing at that boundary.
  const asArray = [...REQUIRED_CAPABILITIES] as unknown as ReadonlySet<string>;
  expectRefusal(
    () => new CapabilityReport({ providerVersion: "test-provider 1.0", supported: asArray }),
    ContractViolation,
    "frozenset",
  );
});

test("the closed vocabularies cannot be extended at runtime (target-only)", () => {
  // `private constructor` is a compile-time marking and is erased, so the
  // constructor stays reachable through the members the class exports.
  // Measured before the repair:
  // `new (Object.getPrototypeOf(FailureKind.BACKEND_UNREACHABLE).constructor)("MADE_UP", "made-up")`
  // minted a seventh FailureKind that `Failure` then accepted, because
  // `FailureKind.is` asks about the brand and a mint has one. In the source
  // these are Enums and `FailureKind("made-up")` raises.
  //
  // This is the same reachability argument the module makes for its other
  // runtime guards, so it gets the same answer rather than a weaker one.
  const mintOf = (member: object): (new (...args: unknown[]) => unknown) =>
    Object.getPrototypeOf(member).constructor as new (
      ...args: unknown[]
    ) => unknown;

  const mintFailureKind = mintOf(FailureKind.BACKEND_UNREACHABLE);
  expectRefusal(() => new mintFailureKind("MADE_UP", "made-up"), ContractViolation);
  expectRefusal(() => new (mintOf(Observation.OBSERVED))("MADE_UP", "made-up"), ContractViolation);
  expectRefusal(() => new (mintOf(WorkspaceVerdict.ALLOW))("DEFER", "defer"), ContractViolation);

  // The consequence, spelled out: a minted kind is what `Failure` would have
  // accepted, so the vocabulary stays closed where it is actually read.
  expect(FailureKind.members.length).toBe(6);
});

test("ContractViolation and SpawnRefused are not catchable as one thing (target-only)", () => {
  // The module says the two families are deliberately not one, and two ported
  // cases name one class each -- but neither would notice a collapse, because
  // `expectRefusal(..., X)` keeps passing when X is an alias or a base of the
  // other. Measured, both spellings stayed green:
  // `export const SpawnRefused = ContractViolation`, and
  // `class SpawnRefused extends ContractViolation`.
  //
  // Both directions, from real refusals rather than from bare constructors, so
  // this also pins that each call site still raises its own family.
  const violation = expectRefusal(() => report({ providerVersion: "" }), ContractViolation);
  const refusal = expectRefusal(() => checkSpawnPrecondition(null), SpawnRefused);

  expect(violation, "a forbidden value was reported as a refused spawn").not.toBeInstanceOf(
    SpawnRefused,
  );
  expect(refusal, "a refused spawn was reported as a forbidden value").not.toBeInstanceOf(
    ContractViolation,
  );
});

test("the mixin bypass is invisible in the leaf class's own properties (target-only)", () => {
  // The assertion that used to live inside
  // `test_a_mixin_earlier_in_the_mro_cannot_override_the_gate_away`, moved here
  // because the source case is a docstring and two statements and says nothing
  // about `__dict__` (rule 0's ceiling).
  //
  // It is worth having as its own case: it is what makes that case's subject
  // real. If `Bypassing` ever came to own the gate directly, the ported case
  // would still refuse -- but it would be refusing the *previous* case's
  // scenario, and the MRO-shaped bypass it names would no longer be under test.
  // That is rule 10's shape: green, and watching the wrong thing.
  for (const [, gate] of GATE_CASES) {
    function mixin(base: typeof Provider): typeof Provider {
      class Mixed extends base {}
      Object.defineProperty(Mixed.prototype, gate, {
        value: () => "ungated",
        writable: true,
        configurable: true,
      });
      return Mixed;
    }

    class Bypassing extends mixin(Provider) {}

    // Absent from the leaf's own properties ...
    expect(Object.getOwnPropertyNames(Bypassing.prototype), gate).not.toContain(gate);
    // ... and present through the chain, which is the pair that makes this the
    // MRO bypass rather than an ordinary override.
    const resolved = (Bypassing.prototype as unknown as Record<string, unknown>)[gate];
    const canonical = (SessionProvider.prototype as unknown as Record<string, unknown>)[gate];
    expect(typeof resolved, gate).toBe("function");
    expect(resolved, gate).not.toBe(canonical);
  }
});
