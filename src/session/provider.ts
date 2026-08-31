/**
 * S1 -- the **provisional** `SessionProvider` interface.
 *
 * **This file is spike scaffold, not a settled contract (D-0021).** It was
 * written during the provider spike so that gate item 11 has something to
 * substitute against; interlock's `docs/proposals/agent-view-gate-scaffold.md`
 * records that until this file exists, item 11 has nothing to measure. It is
 * promoted to a settled contract **only by a later `D-` entry** -- not by being
 * imported, not by an implementation depending on it, and not by having
 * survived a gate run. Nothing here is load-bearing by inertia.
 *
 * What the interface carries, and why each piece is here:
 *
 * - **five verbs (D-0009)**: `start`, `listSessions`, `readState`, `stop`,
 *   `resume`. D-0009 names these five and only these five for top-level worker
 *   sessions, with no signatures, no state model and no error contract -- which
 *   is precisely the hole this file fills. See {@link D0009_VERBS}.
 * - **a provider-neutral lifecycle / availability readout**:
 *   {@link SessionReadout} carries the backend's **own** state string,
 *   uninterpreted, plus an explicit *could not observe* case
 *   ({@link Observation}). The interface deliberately does not enumerate
 *   provider states: an enumeration written from one provider's vocabulary is
 *   an Agent-View-shaped (or `claude -p`-shaped) assumption smuggled into a
 *   provider-neutral contract.
 * - **a typed error / unavailable result that is never an empty one (R4)**:
 *   {@link Ok} / {@link Failure}. R4 records that the v1 reader collapsed a read
 *   failure into an *empty result*, which made "could not observe" and
 *   "observed nothing happening" indistinguishable downstream. Here the two are
 *   different types, and neither can be constructed empty.
 * - **a capability / version probe with a fail-closed spawn precondition
 *   (D-0010)**: {@link SessionProvider.probeCapabilities} plus
 *   {@link checkSpawnPrecondition}. On an incompatible -- or simply
 *   **unprobed** -- provider, a new spawn is *refused*, not attempted with
 *   degraded assumptions.
 *
 * Two prohibitions, both load-bearing, both mechanically asserted in
 * `test/session/provider-contract.test.ts`:
 *
 * **No fact-state vocabulary appears in this file.** interlock's D-0005 fixes a
 * closed set of watcher fact names whose predicates and precedence `Q-0012`
 * leaves open. Folding a provider's own lifecycle words into that set inside a
 * provisional interface would either lose information or answer `Q-0012` by
 * implementation. Conversion from provider lifecycle to watcher fact belongs to
 * the detector layer, where it is fixture-testable and versioned (D-0005,
 * D-0007, Q-0009). The test reads the closed set out of this repository's
 * `DECISIONS.md` -- D-0302, which restates interlock's set so the lint has an
 * oracle here -- and asserts none of its names occurs in this module's source.
 *
 * Note what that costs the author of this file, because it is easy to break by
 * accident: the check is an unanchored, case-insensitive regular expression
 * over the **whole source text**, comments included, and one of the six names
 * is a single ordinary English word. Prose here says "finished" and "could not
 * observe" where a first draft would reach for a forbidden spelling.
 *
 * **No message-delivery verb appears in this file, and the absence is
 * deliberate.** Delivery, ack, dedup and message identity are `MessageBus`'s
 * under D-0009 and are built as S8; binding delivery to the session backend is
 * exactly the v1 coupling D-0009 exists to break. What S1 records for delivery
 * is therefore the *absence* of the verb -- the property gate items 6 and 11
 * exist to check. See {@link DELIVERY_ABSENCE_IS_DELIBERATE} and
 * {@link CAPABILITY_ASSIGNMENTS}.
 *
 * Ported from interlock `src/claude_org_runtime/session/provider.py` at
 * `65f36c5`. The Python module is pure -- no process, filesystem, clock or
 * network work anywhere in it -- so the only shape that changes here is the one
 * D-0301 imposes from below: the five verbs are `Promise`-returning, while the
 * probe, its precondition and the observer fan-out stay synchronous.
 */

import { pyRepr } from "../fencing/pyrepr.js";
import { pyStrip } from "../fencing/pysemantics.js";

// --------------------------------------------------------------------------
// Provisional marking (D-0021)
// --------------------------------------------------------------------------

/** This interface is spike scaffold. See the module documentation and D-0021. */
export const PROVISIONAL = true;

/** What it takes to make this a settled contract. Nothing weaker counts. */
export const PROMOTION_REQUIRES =
  "a later D- entry in DECISIONS.md that promotes S1 to a settled contract " +
  "(D-0021). Use by an implementation, by the gate, or by the control plane " +
  "does not promote it.";

// --------------------------------------------------------------------------
// The result type (R4)
// --------------------------------------------------------------------------

/**
 * A value this interface forbids was constructed. Never recovered from.
 *
 * Raised at construction time rather than checked by the caller, because the
 * failure R4 names is silent: an empty result that reads as a successful
 * observation of nothing. A caller that could have checked would not have known
 * to.
 *
 * `ValueError` in the source, so `except ValueError` catches it there. Nothing
 * in the ported subsystem relies on that base -- every `except ValueError` in
 * `stub_provider.py` and `claude_cli_provider.py` is catching a *stdlib*
 * `ValueError` (a NUL in a path, a malformed record), never this class -- so
 * the port extends `Error` and keeps the two exception families distinct by
 * class alone. {@link SpawnRefused} is `RuntimeError` in the source for the same
 * reason: the two are deliberately not catchable as one thing.
 *
 * `Object.setPrototypeOf` for the reason every other error class in this
 * repository carries it: extending a built-in under a downlevel emit target
 * loses the prototype chain, and `instanceof` then silently reports false --
 * which would turn every `expectRefusal(..., ContractViolation)` in the battery
 * into an assertion that passes for the wrong reason.
 */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
    Object.setPrototypeOf(this, ContractViolation.prototype);
  }
}

/**
 * Python's `repr()`, for the values that reach a refusal message here.
 *
 * {@link pyRepr} covers the JSON-shaped domain exactly -- so `got 'x'`,
 * `got None` and `['session.resume']` come out byte for byte as CPython writes
 * them, which is the majority of the interpolations in this file. What it does
 * not cover is the domain this file adds: a class instance, a function, an
 * exception. CPython renders those with a memory address (`<_Broken object at
 * 0x7f...>`), which is not reproducible and not worth reproducing, so the port
 * renders the identifying half and drops the address.
 *
 * No case in the ported battery asserts any of these strings; they exist so a
 * human reading a refusal can tell what was handed in. The divergence is
 * recorded rather than hidden because the alternative -- a helper that claims to
 * be `repr()` and silently is not -- is how a later parity check gets written
 * against the wrong oracle.
 */
function reprOf(value: unknown): string {
  if (value instanceof Error) {
    // CPython: `RuntimeError('observer blew up')`. Reproduced exactly, except
    // that JavaScript's error class name lives on the instance.
    return `${value.name}(${pyRepr(value.message)})`;
  }
  if (typeof value === "function") {
    return `<function ${value.name === "" ? "<anonymous>" : value.name}>`;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name !== "" && name !== "Object") {
      return `<${name} object>`;
    }
  }
  return pyRepr(value);
}

// --------------------------------------------------------------------------
// Two things Python's runtime gives this module for free
// --------------------------------------------------------------------------

/**
 * `frozenset`, which JavaScript does not have and which this module needs.
 *
 * The obvious spelling -- `Object.freeze(new Set([...]))` -- is a no-op for the
 * only property anyone wants from it. `Object.freeze` seals an object's own
 * *properties*; a `Set`'s contents live in an internal slot, so `add`, `delete`
 * and `clear` all keep working on a "frozen" set. It reads as immutability and
 * is not, which is worse than a bare `new Set`: the seal is exactly what stops a
 * reader looking any further. Measured on the two constants below --
 * `REQUIRED_CAPABILITIES.add("session.evil")` succeeded and left the set at
 * seven; `ABSTRACT_METHODS.clear()` left {@link SessionProvider}'s
 * abstract-method gate accepting any subclass at all.
 *
 * So the mutators are overridden to refuse. This is not decoration on a
 * constant: {@link ABSTRACT_METHODS} is read by the constructor on **every**
 * instantiation, and {@link CapabilityReport.supported} decides `compatible` on
 * a report `checkSpawnPrecondition` may already have returned.
 *
 * Two implementation details, both of which the obvious spelling gets wrong:
 *
 * - the constructor is `super()` plus `super.add`, never `super(values)`. The
 *   `Set` constructor populates itself by calling `this.add`, which resolves to
 *   the override below -- so the direct spelling makes a frozen set refuse its
 *   own construction.
 * - `Object.freeze(this)` still earns its place, for a different reason than the
 *   one it fails at above: a frozen object is non-extensible, and
 *   `Object.setPrototypeOf` on a non-extensible object throws. Without it, the
 *   overrides are removable by re-pointing the instance at `Set.prototype`.
 *
 * What it does **not** close, stated rather than left to be discovered:
 * `Reflect.apply(Set.prototype.add, frozen, ["x"])` reaches the internal slot
 * past the override and mutates the set. Python's `frozenset` has no such hole.
 * The guard closes every spelling a caller reaches for by accident and none that
 * a caller reaches for on purpose, and that is the whole of the claim.
 */
class FrozenSet<T> extends Set<T> {
  constructor(values: Iterable<T>) {
    super();
    for (const value of values) {
      super.add(value);
    }
    Object.freeze(this);
  }

  override add(value: T): this {
    throw new ContractViolation(
      `cannot add ${reprOf(value)}: this set is frozen, as the frozenset it ` +
        "ports is. A caller that needs a different set builds one.",
    );
  }

  override delete(value: T): boolean {
    throw new ContractViolation(
      `cannot delete ${reprOf(value)}: this set is frozen, as the frozenset ` +
        "it ports is. A caller that needs a different set builds one.",
    );
  }

  override clear(): void {
    throw new ContractViolation(
      "cannot clear a frozen set, as the frozenset it ports cannot be cleared",
    );
  }
}

/**
 * The capability to mint a member of one of the three closed vocabularies.
 *
 * `private constructor` is a compile-time marking and nothing else. It is
 * erased before anything runs, and the constructor stays reachable through the
 * instances the class exports:
 * `new (Object.getPrototypeOf(FailureKind.BACKEND_UNREACHABLE).constructor)("MADE_UP", "made-up")`
 * mints a seventh `FailureKind` that {@link Failure} then accepts, because
 * `FailureKind.is` asks about the brand and the mint has one.
 *
 * That is the same reachability argument this file makes for every other
 * runtime guard it carries -- a JavaScript caller, a cast, or a value that
 * arrived as `unknown` -- so it gets the same answer rather than a weaker one.
 * The token is module-private and unexported, so the only code that can mint a
 * member is the code in this file that declares them, and `Enum`'s "these
 * members and no others" survives erasure.
 */
const ENUM_MINT = Symbol("closed vocabulary mint");

/**
 * `list(SomeEnum)`, derived from the class instead of listed beside it.
 *
 * `EnumMeta` derives Python's member list, so `list(s1.WorkspaceVerdict)` -- a
 * parametrize axis in the battery -- grows the day a member is added. A literal
 * array beside the members does not: measured, adding a third `WorkspaceVerdict`
 * and leaving the array alone kept the ported axis at two cases while the
 * source's would have collected three. A hand-written list of a class's own
 * members is a registry that can drift out of agreement with the class and go on
 * satisfying every assertion made about it, which is the failure mode D-0014
 * records for a seam production stopped routing through.
 *
 * Descriptors, not property reads, and `value` specifically: `members` is itself
 * an accessor on each of these classes, and reading it here would recurse until
 * the stack ran out.
 */
function derivedMembers<T>(cls: object, isMember: (value: unknown) => value is T): readonly T[] {
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
  // Own string keys come back in insertion order, and a class's static fields
  // are installed in declaration order -- so this is `list(Enum)`'s order, and
  // it does not depend on where in the class body `members` itself is declared.
  return Object.freeze(found);
}

/**
 * Closed vocabulary for *why* a call did not produce a value.
 *
 * Provider-neutral by construction: these classify Interlock's relationship to
 * the provider, not the provider's own words for its own states. A provider's
 * raw text belongs in {@link Failure.providerDetail}, never folded into one of
 * these names.
 *
 * **Why this is a class and not a string union or a TypeScript `enum`.** The
 * source is a real `Enum`, and `Failure.__post_init__` does
 * `isinstance(kind, FailureKind)` -- so `Failure("backend-unreachable", ...)`
 * is refused there even though the string is the member's own value. A string
 * union or a string `enum` erases at runtime, which makes that refusal
 * unreachable and turns
 * `test_failure_kind_comes_from_the_closed_vocabulary` into a case that can
 * never fail. So each member is a frozen instance of a class carrying a private
 * brand, the registry is frozen, and the constructor is private: identity
 * (`is` in the source) ports to `===`, and a string can no longer impersonate a
 * member.
 *
 * The three closed vocabularies here ({@link FailureKind}, {@link Observation},
 * {@link WorkspaceVerdict}) each declare their **own** brand rather than sharing
 * a base class. A shared base would make the brand a single declaration, and
 * TypeScript would then consider the three mutually assignable -- so
 * `new WorkspaceDecision(Observation.OBSERVED)` would type-check. The
 * duplication is the nominality.
 *
 * The vocabulary is closed at runtime as well as at compile time; see
 * {@link ENUM_MINT} for the spelling that reaches an erased `private
 * constructor`, and {@link derivedMembers} for why `members` is not a list.
 */
export class FailureKind {
  readonly #failureKind: string;

  /** The wire spelling. `checkSpawnPrecondition` interpolates it into a refusal. */
  readonly value: string;

  private constructor(mint: symbol, memberName: string, value: string) {
    if (mint !== ENUM_MINT) {
      throw new ContractViolation(
        `${reprOf(value)} is not a valid FailureKind: the vocabulary is closed, ` +
          "and its members are minted here and nowhere else",
      );
    }
    this.#failureKind = memberName;
    this.value = value;
    Object.freeze(this);
  }

  /** `str(member)` in Python 3.11+, which is `ClassName.MEMBER`. */
  toString(): string {
    return `FailureKind.${this.#failureKind}`;
  }

  /** `isinstance(value, FailureKind)`. */
  static is(value: unknown): value is FailureKind {
    return typeof value === "object" && value !== null && #failureKind in value;
  }

  /** The provider could not be reached, or answered in a way not parseable. */
  static readonly BACKEND_UNREACHABLE = new FailureKind(
    ENUM_MINT,
    "BACKEND_UNREACHABLE",
    "backend-unreachable",
  );
  /** The capability / version probe says this provider is not usable (D-0010). */
  static readonly INCOMPATIBLE_PROVIDER = new FailureKind(
    ENUM_MINT,
    "INCOMPATIBLE_PROVIDER",
    "incompatible-provider",
  );
  /** The named session is not one this provider knows about. */
  static readonly UNKNOWN_SESSION = new FailureKind(
    ENUM_MINT,
    "UNKNOWN_SESSION",
    "unknown-session",
  );
  /** The provider refused the operation (permissions, its own preconditions). */
  static readonly REFUSED_BY_PROVIDER = new FailureKind(
    ENUM_MINT,
    "REFUSED_BY_PROVIDER",
    "refused-by-provider",
  );
  /** The call did not complete within the caller's bound. */
  static readonly TIMED_OUT = new FailureKind(ENUM_MINT, "TIMED_OUT", "timed-out");
  /** The provider answered, but not in a shape this interface can interpret. */
  static readonly UNINTERPRETABLE_RESPONSE = new FailureKind(
    ENUM_MINT,
    "UNINTERPRETABLE_RESPONSE",
    "uninterpretable-response",
  );
  /**
   * The identity read back contradicts the one committed before the spawn
   * (continuo D-0047; target-only, no interlock member corresponds).
   *
   * Still provider-neutral, and deliberately *narrower* than
   * {@link UNINTERPRETABLE_RESPONSE}: that one covers every shape this
   * interface cannot read -- a line that is not JSON, a `result` event naming
   * no outcome, a capture file that cannot be opened -- and an orchestrator
   * that split on it would be classifying broken output as an identity
   * conflict. This member says the one thing U27 makes mandatory to tell
   * apart: two writers claiming one id, or one writer claiming another's. It
   * is the discriminator the caller is entitled to read *as a type*, so no
   * caller has to match on `detail`'s prose to find it.
   */
  static readonly IDENTITY_INCIDENT = new FailureKind(
    ENUM_MINT,
    "IDENTITY_INCIDENT",
    "identity-incident",
  );

  /** `list(FailureKind)`, in declaration order and derived (see {@link derivedMembers}). */
  static get members(): readonly FailureKind[] {
    return derivedMembers(FailureKind, FailureKind.is);
  }
}

/**
 * A call that produced a value. The value is always present.
 *
 * `Ok(null)` is a {@link ContractViolation}: "succeeded, and here is nothing" is
 * the shape R4 forbids. An *empty collection* is still a legal value --
 * `new Ok([])` from {@link SessionProvider.listSessions} means the provider was
 * reached and holds zero sessions, which is a fact, not a failure. The
 * distinction is the whole point: emptiness is only ever expressible as an
 * explicit success carrying an empty collection, and can never be the
 * representation of a failure, because failures are a different type that
 * cannot be constructed without a reason.
 *
 * **Two nullish values, not one.** Python forbids `None` and nothing else, so
 * `Ok(0)`, `Ok("")`, `Ok(False)` and `Ok(())` all construct -- the check is
 * `is None`, never a truthiness test, and a port that wrote `if (!value)` would
 * refuse four values the source accepts. JavaScript has a second nothing:
 * `undefined` is what an omitted argument, a missing property and an
 * `await undefined` all produce, and it means here exactly what `null` means.
 * Both are refused. The `undefined` half has no source case -- Python cannot
 * express it -- so it is pinned by a target-only case.
 */
export class Ok<T> {
  readonly #ok = true;

  readonly value: T;

  constructor(value: T) {
    if (value === null || value === undefined) {
      throw new ContractViolation(
        "Ok(null) and Ok(undefined) are forbidden (R4): a call that produced " +
          "nothing is a Failure with a reason, not an empty success",
      );
    }
    this.value = value;
    Object.freeze(this);
  }

  /** `isinstance(value, Ok)`. */
  static is(value: unknown): value is Ok<unknown> {
    return typeof value === "object" && value !== null && #ok in value;
  }
}

/**
 * A call that did not produce a value, and always says why.
 *
 * Never empty: {@link Failure.kind} comes from a closed vocabulary and
 * {@link Failure.detail} must carry text a human can act on. `providerDetail`
 * holds the backend's own words verbatim -- including anything it wrote to
 * `stderr` -- so that a failure carries the raw evidence forward instead of
 * summarising it away.
 */
export class Failure {
  readonly #failure = true;

  readonly kind: FailureKind;
  readonly detail: string;
  readonly providerDetail: Readonly<Record<string, unknown>>;

  constructor(
    kind: FailureKind,
    detail: string,
    // `field(default_factory=dict)` in the source: a **fresh** mapping per
    // instance. A default parameter is evaluated per call, so this matches; a
    // shared module-level `EMPTY = {}` would not, and one caller's mutation
    // would reach every other failure ever constructed.
    providerDetail: Readonly<Record<string, unknown>> = {},
  ) {
    // Order matters and is the source's: a `Failure(kind="x", detail="")`
    // reports the *kind* error, not the detail one.
    if (!FailureKind.is(kind)) {
      throw new ContractViolation(`kind must be a FailureKind, got ${reprOf(kind)}`);
    }
    if (typeof detail !== "string" || pyStrip(detail) === "") {
      throw new ContractViolation(
        "Failure.detail must be non-empty (R4): a failure without a " +
          "reason is the empty result this interface exists to forbid",
      );
    }
    this.kind = kind;
    this.detail = detail;
    this.providerDetail = providerDetail;
    Object.freeze(this);
  }

  /** `isinstance(value, Failure)`. */
  static is(value: unknown): value is Failure {
    return typeof value === "object" && value !== null && #failure in value;
  }
}

/**
 * What every verb returns. Callers discriminate on the type, not on emptiness.
 *
 * A `Union` in the source, and re-exported by `session/__init__.py` as a
 * **value** because a Python type alias is one. Here it is a type alias and
 * therefore erases; a barrel re-exporting it must do so with `export type`.
 */
export type ProviderResult<T> = Ok<T> | Failure;

// --------------------------------------------------------------------------
// The provider-neutral lifecycle / availability readout
// --------------------------------------------------------------------------

/**
 * Whether the provider's state for a session could be observed at all.
 *
 * Two values, and the second is the one that matters: D-0006 requires the
 * system to tolerate degraded observation rather than restore fidelity by
 * reaching into internals (D-0010), so "could not observe" must be
 * representable as a *readout*, not only as a failed call. A child that is alive
 * but has emitted nothing parseable is exactly this case, and collapsing it into
 * an error or an empty result is the R4 defect again.
 *
 * Branded for the reason {@link FailureKind} is branded, and with its own brand
 * for the reason recorded there.
 */
export class Observation {
  readonly #observation: string;

  /** The wire spelling. */
  readonly value: string;

  private constructor(mint: symbol, memberName: string, value: string) {
    if (mint !== ENUM_MINT) {
      throw new ContractViolation(
        `${reprOf(value)} is not a valid Observation: the vocabulary is closed, ` +
          "and its members are minted here and nowhere else",
      );
    }
    this.#observation = memberName;
    this.value = value;
    Object.freeze(this);
  }

  /** `str(member)` in Python 3.11+, which is `ClassName.MEMBER`. */
  toString(): string {
    return `Observation.${this.#observation}`;
  }

  /** `isinstance(value, Observation)`. */
  static is(value: unknown): value is Observation {
    return typeof value === "object" && value !== null && #observation in value;
  }

  static readonly OBSERVED = new Observation(ENUM_MINT, "OBSERVED", "observed");
  static readonly COULD_NOT_OBSERVE = new Observation(
    ENUM_MINT,
    "COULD_NOT_OBSERVE",
    "could-not-observe",
  );

  /** `list(Observation)`, in declaration order and derived (see {@link derivedMembers}). */
  static get members(): readonly Observation[] {
    return derivedMembers(Observation, Observation.is);
  }
}

/** Keyword arguments of the `SessionReadout` dataclass, in field order. */
export interface SessionReadoutFields {
  readonly sessionId: string;
  readonly observation: Observation;
  readonly providerState?: string | null | undefined;
  readonly couldNotObserveReason?: string | null | undefined;
  readonly providerDetail?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One session as the provider currently reports it.
 *
 * {@link SessionReadout.providerState} is the backend's **own** state word,
 * carried uninterpreted. This interface neither enumerates nor ranks those
 * words: it has no closed set of its own to offer, and inventing one would bake
 * a single provider's vocabulary into a provider-neutral contract. Anything that
 * needs a judgement -- lifecycle, waiting, finished -- gets it from the detector
 * layer, which is versioned and fixture-tested, not from here.
 *
 * Constructed from a fields object because the source constructs it by keyword
 * everywhere; the validation runs in the source's order, which is observable
 * whenever an input trips more than one rule at once.
 */
export class SessionReadout {
  readonly sessionId: string;
  readonly observation: Observation;
  readonly providerState: string | null;
  readonly couldNotObserveReason: string | null;
  readonly providerDetail: Readonly<Record<string, unknown>>;

  constructor(fields: SessionReadoutFields) {
    const { sessionId, observation } = fields;
    // `?? null` is the dataclass field default, not a coercion. The source's
    // default is `None` and its checks are `is None` / `is not None`; an
    // omitted argument here arrives as `undefined`, so without this an omitted
    // `providerState` would slip past `!== null` and a COULD_NOT_OBSERVE
    // readout would be refused for carrying a state it does not carry.
    const providerState = fields.providerState ?? null;
    const couldNotObserveReason = fields.couldNotObserveReason ?? null;
    const providerDetail = fields.providerDetail ?? {};

    if (typeof sessionId !== "string" || pyStrip(sessionId) === "") {
      throw new ContractViolation("SessionReadout.sessionId must be non-empty");
    }
    if (!Observation.is(observation)) {
      throw new ContractViolation(`observation must be an Observation, got ${reprOf(observation)}`);
    }
    if (observation === Observation.OBSERVED) {
      if (typeof providerState !== "string" || pyStrip(providerState) === "") {
        throw new ContractViolation(
          "an observed readout must carry the provider's own state " +
            "string; an observation of nothing is COULD_NOT_OBSERVE",
        );
      }
      if (couldNotObserveReason !== null) {
        throw new ContractViolation(
          "an observed readout must not also carry a reason for not observing",
        );
      }
    } else {
      // Order is load-bearing: a readout that both carries a state and gives a
      // reason is refused for the *state*, which is what
      // `test_could_not_observe_must_say_why_and_must_not_invent_a_state`
      // pins by constructing exactly that pair.
      if (providerState !== null) {
        throw new ContractViolation(
          "a readout that could not observe must not carry a provider " +
            "state: an unobserved state is not a state",
        );
      }
      if (typeof couldNotObserveReason !== "string" || pyStrip(couldNotObserveReason) === "") {
        throw new ContractViolation(
          "COULD_NOT_OBSERVE must say why (R4): a bare could-not-observe " +
            "is indistinguishable from an empty result",
        );
      }
    }

    this.sessionId = sessionId;
    this.observation = observation;
    this.providerState = providerState;
    this.couldNotObserveReason = couldNotObserveReason;
    this.providerDetail = providerDetail;
    Object.freeze(this);
  }
}

/** Keyword arguments of the `StartRequest` dataclass, in field order. */
export interface StartRequestFields {
  readonly sessionId: string;
  readonly workspace: string;
  readonly role: string;
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * What a caller must supply to start a top-level worker session.
 *
 * Deliberately minimal and provider-neutral. `sessionId` is the caller's to
 * choose, because an identity assigned by the provider after the spawn cannot be
 * committed before it; `settings` carries whatever per-role configuration the
 * provider takes, opaque to this interface.
 */
export class StartRequest {
  readonly sessionId: string;
  readonly workspace: string;
  readonly role: string;
  readonly settings: Readonly<Record<string, unknown>>;

  constructor(fields: StartRequestFields) {
    const { sessionId, workspace, role } = fields;
    // The source loops `("session_id", "workspace", "role")` and the first
    // offender in that order wins the message, so the pairs are listed rather
    // than checked one by one: the order is data, and it is the source's.
    const required = [
      ["sessionId", sessionId],
      ["workspace", workspace],
      ["role", role],
    ] as const;
    for (const [name, value] of required) {
      if (typeof value !== "string" || pyStrip(value) === "") {
        throw new ContractViolation(`StartRequest.${name} must be non-empty`);
      }
    }
    this.sessionId = sessionId;
    this.workspace = workspace;
    this.role = role;
    this.settings = fields.settings ?? {};
    Object.freeze(this);
  }
}

// --------------------------------------------------------------------------
// The capability / version probe and its fail-closed spawn precondition (D-0010)
// --------------------------------------------------------------------------

/**
 * Capabilities a provider must expose *through its public surface* for this
 * interface to be usable.
 *
 * Named after the five verbs plus the structured readout they depend on.
 * D-0010: a capability the public surface does not expose is out of scope or a
 * gate failure -- never a reason to reach into internals.
 */
export const REQUIRED_CAPABILITIES: ReadonlySet<string> = new FrozenSet([
  "session.start",
  "session.list",
  "session.read-state",
  "session.stop",
  "session.resume",
  "session.structured-readout",
]);

/** Keyword arguments of the `CapabilityReport` dataclass, in field order. */
export interface CapabilityReportFields {
  readonly providerVersion: string;
  readonly supported: ReadonlySet<string>;
  readonly detail?: string | undefined;
}

/**
 * What a probe of the provider's public surface found.
 *
 * {@link CapabilityReport.providerVersion} is recorded rather than parsed:
 * version *churn* is what D-0010 is defending against, so the report says which
 * build was seen and lets the capability set, not a version comparison, decide
 * usability. There is no version comparison anywhere in this file.
 *
 * **Why this is a class.** `check_spawn_precondition` refuses an `Ok` whose
 * value is not a report, and the case that pins it hands in an object with
 * `compatible = True`, `missing = frozenset()` and a `provider_version` -- an
 * impostor that is *structurally* a report. TypeScript's structural typing
 * accepts such an object into an interface-typed slot, so only a runtime nominal
 * check can refuse it; hence a class, a private brand and an `instanceof`-shaped
 * predicate.
 */
export class CapabilityReport {
  readonly #capabilityReport = true;

  readonly providerVersion: string;
  readonly supported: ReadonlySet<string>;
  readonly detail: string;

  constructor(fields: CapabilityReportFields) {
    const { providerVersion, supported } = fields;
    if (typeof providerVersion !== "string" || pyStrip(providerVersion) === "") {
      throw new ContractViolation(
        "CapabilityReport.providerVersion must be non-empty: an " +
          "unidentified provider is an unusable one (D-0010)",
      );
    }
    // The source demands a `frozenset` exactly, so a plain `set` or a `list` is
    // refused. `ReadonlySet` is a compile-time view of the same `Set` and erases,
    // so the shape half of the guard is enforced here: an array, a plain object
    // or a string is refused, and the refusal path the source's guard protects
    // stays reachable from JavaScript, from a cast, and from anything that
    // arrived as `unknown`. The message keeps the source's word because the
    // record is the source's. The branch is port-added in the sense that the
    // source's own `isinstance` guard has no case upstream either; the
    // target-only case that reaches it is what keeps it from being decoration.
    if (!(supported instanceof Set)) {
      throw new ContractViolation("CapabilityReport.supported must be a frozenset");
    }
    this.providerVersion = providerVersion;
    // Copied *and* frozen, which are two separate holes and were closed one at a
    // time. A caller's `Set` can change under the report, so the copy closes the
    // alias; but a copy handed out as a public field on a shallowly-frozen
    // instance is itself mutable, and `report.supported.delete("session.resume")`
    // flipped `compatible` from true to false on a report
    // `checkSpawnPrecondition` had already returned. A `frozenset` makes both
    // states unreachable, no source case can construct either, and none forbids
    // them -- which is exactly the class of divergence the port has to close
    // deliberately rather than describe.
    this.supported = new FrozenSet(supported);
    this.detail = fields.detail ?? "";
    Object.freeze(this);
  }

  /**
   * Required capabilities this provider did not report.
   *
   * `frozenset(REQUIRED_CAPABILITIES - self.supported)` in the source, so the
   * returned set is frozen here too. Nothing stores this value, so a mutable
   * one would harm nothing today -- it is frozen because the source's is, and
   * because a reader who sees one of this class's two capability sets refuse a
   * mutation and the other accept it will reasonably conclude the difference
   * means something.
   */
  get missing(): ReadonlySet<string> {
    const absent: string[] = [];
    for (const capability of REQUIRED_CAPABILITIES) {
      if (!this.supported.has(capability)) {
        absent.push(capability);
      }
    }
    return new FrozenSet(absent);
  }

  /**
   * True only when nothing required is missing. Silence is not consent.
   *
   * Note the direction: `REQUIRED - supported`. Capabilities beyond the required
   * six are permitted and ignored.
   */
  get compatible(): boolean {
    return this.missing.size === 0;
  }

  /** `isinstance(value, CapabilityReport)`. */
  static is(value: unknown): value is CapabilityReport {
    return typeof value === "object" && value !== null && #capabilityReport in value;
  }
}

/**
 * A new spawn was refused because the provider is not known to be usable.
 *
 * D-0010 scopes fail-closed to *new* spawns and says nothing about sessions
 * already running; what an incompatible probe implies for those is open
 * (`Q-0020`) and this interface does not answer it by implementation.
 *
 * `RuntimeError` in the source, deliberately not the `ValueError` that
 * {@link ContractViolation} is: a refused spawn is a refusal to act, not a
 * forbidden value.
 *
 * Two cases in the battery name the two classes at the same call site, one each
 * -- but neither would notice if the port collapsed them: `expectRefusal(...,
 * ContractViolation)` and `expectRefusal(..., SpawnRefused)` both keep passing
 * if one class becomes an alias or a subclass of the other. Measured, both
 * spellings. So a target-only case pins the disjointness in both directions,
 * and this comment claims only what that case checks.
 */
export class SpawnRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnRefused";
    Object.setPrototypeOf(this, SpawnRefused.prototype);
  }
}

/**
 * Refuse a new spawn unless the probe positively says the provider is usable.
 *
 * Fail closed means the *absence* of a good answer refuses, so every one of
 * these refuses: never probed (`null`), a probe that failed, a probe whose
 * result is not one of this interface's two result types, one carrying something
 * that is not a {@link CapabilityReport}, and one that is a report but reports
 * something required as missing. Only the last case -- a real report with
 * nothing missing -- returns, and it returns the report so the caller records
 * which build it committed to.
 *
 * The type checks are not belt-and-braces. Python's annotations are not enforced
 * at runtime, so without them a duck-typed object whose `compatible` happens to
 * be true would spawn, and a malformed result would raise `AttributeError` -- an
 * exception the caller is not told to expect and may handle as an ordinary
 * error. TypeScript's annotations are enforced at compile time and erased after
 * it, which changes *who* can reach the bad input, not whether it is reachable:
 * a JavaScript caller, a cast, or a value that arrived as `unknown` all still
 * get here. Both are ways for the one precondition D-0010 puts in the way of a
 * spawn to be stepped over silently.
 *
 * **`undefined` counts as "never probed".** D-0301 makes the verbs
 * `Promise`-returning while this stays synchronous, and `await undefined` is
 * `undefined` -- so a provider whose probe forgot to return would hand this
 * function the second nothing rather than the first. Treating only `null` as
 * unprobed would let that provider fall through to the "neither Ok nor Failure"
 * branch, which refuses too, but with a message that sends the reader looking
 * for a malformed result instead of a missing one.
 *
 * @throws {SpawnRefused} in every case except a compatible report.
 */
export function checkSpawnPrecondition(
  probe: ProviderResult<CapabilityReport> | null | undefined,
): CapabilityReport {
  if (probe === null || probe === undefined) {
    throw new SpawnRefused(
      "no capability probe has been run; a spawn is refused rather than " +
        "attempted on an unknown provider (D-0010)",
    );
  }
  if (Failure.is(probe)) {
    throw new SpawnRefused(`capability probe failed (${probe.kind.value}): ${probe.detail}`);
  }
  if (!Ok.is(probe)) {
    throw new SpawnRefused(
      `capability probe returned ${reprOf(probe)}, which is neither Ok nor ` +
        "Failure; an uninterpretable probe refuses the spawn",
    );
  }
  const report = probe.value;
  if (!CapabilityReport.is(report)) {
    throw new SpawnRefused(
      `capability probe returned Ok(${reprOf(report)}), which is not a ` +
        "CapabilityReport; a spawn is refused rather than trusting it",
    );
  }
  // `sorted(...)` in the source, so the refusal names the missing capabilities
  // in a deterministic order out of an unordered set. The default comparator
  // sorts by UTF-16 code unit where CPython sorts by code point; the two agree
  // here because `missing` is a subset of REQUIRED_CAPABILITIES, which is six
  // fixed ASCII strings.
  if (!report.compatible) {
    throw new SpawnRefused(
      `provider ${reprOf(report.providerVersion)} is missing required ` +
        `capabilities: ${reprOf([...report.missing].sort())}`,
    );
  }
  return report;
}

// --------------------------------------------------------------------------
// Workspace lifecycle: observe, and veto (D-0021's third capability)
// --------------------------------------------------------------------------

/**
 * Whether a workspace lifecycle transition may proceed.
 *
 * Branded for the reason {@link FailureKind} is branded, and with its own brand
 * for the reason recorded there.
 */
export class WorkspaceVerdict {
  readonly #workspaceVerdict: string;

  /** The wire spelling. */
  readonly value: string;

  private constructor(mint: symbol, memberName: string, value: string) {
    if (mint !== ENUM_MINT) {
      throw new ContractViolation(
        `${reprOf(value)} is not a valid WorkspaceVerdict: the vocabulary is ` +
          "closed, and its members are minted here and nowhere else",
      );
    }
    this.#workspaceVerdict = memberName;
    this.value = value;
    Object.freeze(this);
  }

  /**
   * `str(member)` in Python 3.11+, which is `ClassName.MEMBER`.
   *
   * Not decoration: `list(s1.WorkspaceVerdict)` is a parametrize axis in the
   * source, and pytest names those cases `[WorkspaceVerdict.ALLOW]` /
   * `[WorkspaceVerdict.VETO]` from exactly this string. The ported ids are those
   * node ids verbatim.
   */
  toString(): string {
    return `WorkspaceVerdict.${this.#workspaceVerdict}`;
  }

  /** `isinstance(value, WorkspaceVerdict)`. */
  static is(value: unknown): value is WorkspaceVerdict {
    return typeof value === "object" && value !== null && #workspaceVerdict in value;
  }

  static readonly ALLOW = new WorkspaceVerdict(ENUM_MINT, "ALLOW", "allow");
  static readonly VETO = new WorkspaceVerdict(ENUM_MINT, "VETO", "veto");

  /**
   * `list(WorkspaceVerdict)`, in declaration order and derived.
   *
   * Derived and not listed, and here that is load-bearing rather than tidy:
   * `list(s1.WorkspaceVerdict)` is a parametrize **axis** in the battery, so a
   * third member has to produce a third node id on its own. See
   * {@link derivedMembers} for the measurement.
   */
  static get members(): readonly WorkspaceVerdict[] {
    return derivedMembers(WorkspaceVerdict, WorkspaceVerdict.is);
  }
}

/** Keyword arguments of the `WorkspaceTransition` dataclass, in field order. */
export interface WorkspaceTransitionFields {
  readonly sessionId: string;
  readonly workspace: string;
  readonly kind: string;
  readonly providerDetail?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A workspace lifecycle transition the provider is about to make.
 *
 * `kind` is the provider's own word for the transition (creating a tree,
 * removing one, moving a worker onto another), carried uninterpreted for the
 * same reason {@link SessionReadout} carries provider states uninterpreted.
 */
export class WorkspaceTransition {
  readonly sessionId: string;
  readonly workspace: string;
  readonly kind: string;
  readonly providerDetail: Readonly<Record<string, unknown>>;

  constructor(fields: WorkspaceTransitionFields) {
    const { sessionId, workspace, kind } = fields;
    const required = [
      ["sessionId", sessionId],
      ["workspace", workspace],
      ["kind", kind],
    ] as const;
    for (const [name, value] of required) {
      if (typeof value !== "string" || pyStrip(value) === "") {
        throw new ContractViolation(`WorkspaceTransition.${name} must be non-empty`);
      }
    }
    this.sessionId = sessionId;
    this.workspace = workspace;
    this.kind = kind;
    this.providerDetail = fields.providerDetail ?? {};
    Object.freeze(this);
  }
}

/**
 * A verdict, and -- when it is a veto -- always a reason.
 *
 * Constructed positionally, as the source is. The `reason` parameter carries the
 * source's default of `""` rather than being optional-typed, because the source
 * refuses an *explicit* non-string (including `None`) for **both** verdicts while
 * accepting the omitted argument: a bare `typeof reason !== "string"` on an
 * untyped parameter would refuse `new WorkspaceDecision(WorkspaceVerdict.ALLOW)`,
 * which the source accepts. An explicit `undefined` therefore also takes the
 * default -- the one shape Python cannot express, and the only place the two
 * spellings of nothing part company here.
 */
export class WorkspaceDecision {
  readonly #workspaceDecision = true;

  readonly verdict: WorkspaceVerdict;
  readonly reason: string;

  constructor(verdict: WorkspaceVerdict, reason: string = "") {
    if (!WorkspaceVerdict.is(verdict)) {
      throw new ContractViolation(`verdict must be a WorkspaceVerdict, got ${reprOf(verdict)}`);
    }
    // Unconditional, and before the veto rule: the source checks the *type* of
    // the reason for an ALLOW too, so `WorkspaceDecision(ALLOW, None)` is
    // refused. Both halves of that parametrized case exist because of it.
    if (typeof reason !== "string") {
      throw new ContractViolation(
        `reason must be a string, got ${reprOf(reason)}. Checked before it ` +
          "is read, so a malformed reason is this interface's own error " +
          "rather than an AttributeError from somewhere downstream.",
      );
    }
    if (verdict === WorkspaceVerdict.VETO && pyStrip(reason) === "") {
      throw new ContractViolation(
        "a veto must say why: an unexplained veto is an empty result " +
          "wearing a decision's clothes (R4)",
      );
    }
    this.verdict = verdict;
    this.reason = reason;
    Object.freeze(this);
  }

  /** `isinstance(value, WorkspaceDecision)`. */
  static is(value: unknown): value is WorkspaceDecision {
    return typeof value === "object" && value !== null && #workspaceDecision in value;
  }
}

/**
 * Anything that wants a say before a workspace transition happens.
 *
 * A `@runtime_checkable` `Protocol` in the source, which is structural -- and
 * {@link SessionProvider.registerWorkspaceObserver} never checks it anyway, it
 * just appends. A TypeScript interface is structural at compile time and absent
 * at runtime, so nothing is lost: the fan-out's fail-closed handling is what
 * copes with an object that does not honour the shape.
 */
export interface WorkspaceLifecycleObserver {
  /** Return a {@link WorkspaceDecision}. Raising is treated as a veto. */
  onWorkspaceTransition(transition: WorkspaceTransition): WorkspaceDecision;
}

// --------------------------------------------------------------------------
// Where the three previously-unassigned capabilities landed (D-0021)
// --------------------------------------------------------------------------

export const OWNER_MESSAGE_BUS = "MessageBus (D-0009; built as S8, issue #19)";
export const OWNER_SESSION_PROVIDER = "SessionProvider -- this interface (S1, issue #10)";
export const OWNER_NEITHER_CONTRACT = "neither contract -- no owner exists";

/** Keyword arguments of the `CapabilityAssignment` dataclass, in field order. */
export interface CapabilityAssignmentFields {
  readonly capability: string;
  readonly owner: string;
  readonly inThisInterface: boolean;
  readonly reason: string;
}

/**
 * One capability, its named owner, and whether it lives in this file.
 *
 * Owning a capability and putting it in S1 are different things, and the
 * difference is the point: message delivery has an owner and is *absent* here.
 *
 * No validation, exactly as the source has none: the non-empty check on
 * `capability` and `reason` lives only in the test.
 */
export class CapabilityAssignment {
  readonly capability: string;
  readonly owner: string;
  readonly inThisInterface: boolean;
  readonly reason: string;

  constructor(fields: CapabilityAssignmentFields) {
    this.capability = fields.capability;
    this.owner = fields.owner;
    this.inThisInterface = fields.inThisInterface;
    this.reason = fields.reason;
    Object.freeze(this);
  }
}

/**
 * The three capabilities D-0021 records as belonging to neither contract as
 * written. Each gets a named owner here rather than being settled by inertia.
 */
export const CAPABILITY_ASSIGNMENTS: readonly CapabilityAssignment[] = Object.freeze([
  new CapabilityAssignment({
    capability: "deliver a message to a worker (gate item 6)",
    owner: OWNER_MESSAGE_BUS,
    inThisInterface: false,
    reason:
      "D-0009 separates delivery from session management because v1 bound " +
      "them together -- messages travelled as keystrokes into a pane, so a " +
      "shadow observer could not watch delivery without stealing it. " +
      "Delivery is therefore MessageBus's and is built as S8. What S1 " +
      "records is the absence of the verb, which is the property gate " +
      "items 6 and 11 exist to check.",
  }),
  new CapabilityAssignment({
    capability:
      "read back a session's effective permission / sandbox / hook " +
      "configuration (gate item 3)",
    owner: OWNER_NEITHER_CONTRACT,
    inThisInterface: false,
    // The one edit to a carried reason: the source names the Python package
    // path `src/claude_org_runtime/fencing/`, and this sentence is a pointer a
    // reader follows. In this repository that code is `src/fencing/`. The issue
    // and stage identifiers stay interlock's, because they identify the
    // decision, not a directory.
    reason:
      "No public surface returns a session's effective configuration, so " +
      "the capability cannot be placed in either contract without " +
      "inventing a surface that does not exist -- and D-0010 forbids " +
      "reaching into internals to manufacture one. Recorded as unowned. " +
      "What exists instead is a deliberate weakening accepted by a human " +
      "under D-0023: the permission mode alone has a partial readback via " +
      "the provider's own structured startup event, and hooks and sandbox " +
      "have only the behavioural breach-probe battery. Both live in " +
      "src/fencing/ (S10, issue #9), which narrows the " +
      "gap rather than closing it -- diffing our own rendered inputs " +
      "proves what we wrote, not what the provider loaded.",
  }),
  new CapabilityAssignment({
    capability: "observe or veto a workspace lifecycle transition (gate item 7)",
    owner: OWNER_SESSION_PROVIDER,
    inThisInterface: true,
    reason:
      "Genuinely the provider's: only the party that manages workspaces " +
      "can announce a transition before making it. It is carried here as " +
      "an observation / veto surface -- not as a sixth verb, since D-0009 " +
      "names five. Under the current provider no other party owns the " +
      "working tree, so the surface may have no producer at all; it exists " +
      "so that a provider with its own supervisor can be adopted without " +
      "the capability silently having nowhere to go.",
  }),
]);

/** Delivery's absence is a designed property of this interface, not an omission. */
export const DELIVERY_ABSENCE_IS_DELIBERATE =
  "This interface has no verb that sends anything to a worker. Delivery, ack, " +
  "dedup and message identity belong to MessageBus (D-0009) and are built as " +
  "S8. Adding a delivery verb here would rebuild the v1 coupling in which " +
  "replacing the session backend also changed delivery semantics -- and it " +
  "would make gate items 6 and 11 unmeasurable, since what they check is " +
  "precisely that no such edge exists.";

/**
 * D-0009's five verbs, mapped to the public method that renders each one.
 *
 * The mapping is data so that "exactly these five, no more" can be asserted
 * mechanically. `start` is public but not abstract: it carries the fail-closed
 * gate and delegates to the abstract `_startSession`, which is the half an
 * implementation writes (see {@link VERB_IMPLEMENTATION_HOOKS}).
 *
 * A `Map`, not an object literal, and for two reasons that are both properties
 * of the source's `dict`. A `dict` preserves insertion order and has no
 * inherited keys; a JavaScript object literal hoists integer-like keys to the
 * front and reads `constructor` and `__proto__` off `Object.prototype`. Neither
 * hazard is reachable through these five fixed keys, but the second reason is:
 * {@link VERB_IMPLEMENTATION_HOOKS} is built by copying this and re-setting one
 * existing key, and `Map.set` keeps that key in place exactly as
 * `dict(D0009_VERBS, start=...)` does -- so `start` stays first on both sides.
 */
export const D0009_VERBS: ReadonlyMap<string, string> = new Map([
  ["start", "start"],
  ["list", "listSessions"],
  ["obtain structured state of", "readState"],
  ["stop", "stop"],
  ["resume", "resume"],
]);

/**
 * The method a subclass implements for each verb. Identical to
 * {@link D0009_VERBS} except for `start`, whose public half is the gate.
 */
export const VERB_IMPLEMENTATION_HOOKS: ReadonlyMap<string, string> = new Map(D0009_VERBS).set(
  "start",
  "_startSession",
);

/**
 * The methods a concrete provider must supply.
 *
 * `SessionProvider.__abstractmethods__` in the source, which `ABCMeta` computes
 * and which the battery reads directly. TypeScript's `abstract` is erased before
 * anything runs, so there is nothing to read -- the registry replaces it, and is
 * hand-maintained.
 *
 * A hand-maintained registry can drift out of agreement with the class and go on
 * satisfying every assertion made about it, which is the same failure mode
 * D-0014 records for a seam that production stopped routing through. So this one
 * is not a description: {@link SessionProvider}'s constructor **consults** it and
 * refuses to build an instance that leaves any of these names unimplemented, and
 * a target-only case builds exactly such a subclass to prove the refusal is
 * reachable. That also puts the refusal where Python puts it -- `ABCMeta`
 * refuses at *instantiation*, not at class definition.
 */
export const ABSTRACT_METHODS: ReadonlySet<string> = new FrozenSet([
  "probeCapabilities",
  "_startSession",
  "listSessions",
  "readState",
  "stop",
  "resume",
]);

/**
 * The first sentence of each contract method's documentation.
 *
 * The battery asserts that every verb and the probe carry a docstring, reading
 * `SessionProvider.<method>.__doc__`. JSDoc is a comment: it is not on the
 * function at runtime and there is nothing to read. This registry is what the
 * ported assertion reads instead.
 *
 * Like {@link ABSTRACT_METHODS}, it is hand-maintained and therefore able to
 * stay green while the thing it describes is deleted -- worse here, because the
 * assertion is only that the text is non-empty, and this file is where the text
 * lives. Its liveness guard is a target-only case that extracts the JSDoc block
 * preceding each of these methods from this file's own source and requires the
 * recorded sentence to appear in it. Delete a JSDoc block and the guard fails;
 * paraphrase one and it fails too.
 */
export const VERB_DOCS: ReadonlyMap<string, string> = new Map([
  ["probeCapabilities", "Ask the provider's **public surface** what it is and what it supports."],
  ["start", "Start one top-level worker session. **The verb, and the gate.**"],
  ["_startSession", "Create the session. Called by `start` **after** the gate passes."],
  ["listSessions", "List the sessions this provider currently holds."],
  ["readState", "Obtain the structured state of one session."],
  ["stop", "Stop one session, and report what the provider says about it afterwards."],
  ["resume", "Re-enter an existing session after a worker or supervisor restart."],
]);

// --------------------------------------------------------------------------
// The interface
// --------------------------------------------------------------------------

/**
 * Start, list, read the state of, stop and resume top-level worker sessions.
 *
 * **Provisional (D-0021).** See the module documentation; promotion requires a
 * `D-` entry.
 *
 * Five verbs, and no sixth. {@link SessionProvider.probeCapabilities} is not a
 * verb -- it is the precondition D-0010 requires before any of them may spawn
 * anything, and it is abstract because a provider that cannot say what it
 * supports cannot be used fail-closed.
 *
 * Every verb returns a {@link ProviderResult}: an {@link Ok} carrying a value, or
 * a {@link Failure} carrying a reason. No verb signals failure by returning an
 * empty collection, and none raises to report an ordinary provider-side problem;
 * exceptions are reserved for programmer error ({@link ContractViolation}) and
 * for the refused spawn ({@link SpawnRefused}), which is a refusal to act rather
 * than a failed action.
 *
 * **What D-0301 changes, and what it deliberately does not.** The five verbs are
 * `Promise`-returning because Node has no synchronous way to wait for a child to
 * exit; the probe, its precondition, the observer registration and the observer
 * fan-out stay synchronous, because `spawnSync` is an exact analogue of the
 * `subprocess.run(timeout=)` the probe is written against and because a
 * synchronous fan-out keeps "every observer is asked, in registration order"
 * true without a "sequential await, never `Promise.all`" caveat hanging off it.
 *
 * {@link SessionProvider.start} is the one place the two halves meet, and it is
 * deliberately **not** an `async` function: the gate runs synchronously, so a
 * refused spawn throws where the source raises, and only the provider's own half
 * is awaited. Written as `async`, the refusal would arrive as a rejected promise
 * -- still a refusal, but one that a caller who never awaits the result would
 * see as an unhandled rejection instead of a throw, and one that no longer
 * proves the gate ran before anything was created.
 */
export abstract class SessionProvider {
  /** Observers registered for workspace lifecycle transitions. */
  protected readonly _workspaceObservers: WorkspaceLifecycleObserver[] = [];

  /**
   * Refuse a provider that overrides a gate rather than implementing it, and one
   * that leaves the contract half-written.
   *
   * {@link SessionProvider.start} carries the fail-closed spawn precondition
   * (D-0010) and {@link SessionProvider.requireSpawnable} carries the check
   * itself; a provider that replaces either has removed the precondition while
   * still presenting as a `SessionProvider`. The source refuses that in
   * `__init_subclass__`, at **class-definition** time, because the failure is
   * silent at runtime: such a provider behaves correctly in every test that does
   * not deliberately break the probe.
   *
   * JavaScript has no `__init_subclass__` and no hook of any kind at class
   * definition, so the port moves the refusal to **first instantiation**. That
   * is later than the source's, and it is the whole of the adaptation -- what is
   * checked, and how, is unchanged.
   *
   * The check is on the method the **prototype chain resolves**, not on the
   * subclass's own properties, and that is the source's own hard-won detail:
   * `class P(StartMixin, SessionProvider)` puts no `start` in `P.__dict__` at
   * all, yet the mixin's `start` is the one that runs, so a dict-only check
   * would wave through the very bypass it exists to stop. `new.target.prototype`
   * resolves through the chain for the same reason, so the JavaScript spelling
   * of that bypass -- `class Bypassing extends Mixin(Provider) {}` -- is caught
   * by the same read.
   *
   * The gate check runs before the abstract-method check. In the source the two
   * live at different times entirely (definition, then instantiation), and the
   * gate is the earlier of the two; keeping that order means a subclass that
   * both bypasses the gate and forgets a verb reports the bypass, which is the
   * more serious of the two.
   */
  constructor() {
    const target = new.target as unknown as {
      readonly name?: string;
      readonly prototype?: unknown;
    };
    const resolvedFrom = (target.prototype ?? null) as Record<string, unknown> | null;
    const canonical = SessionProvider.prototype as unknown as Record<string, unknown>;
    const targetName =
      typeof target.name === "string" && target.name !== "" ? target.name : "<anonymous>";

    for (const gate of ["start", "requireSpawnable"] as const) {
      const resolved = resolvedFrom === null ? undefined : resolvedFrom[gate];
      if (resolved !== canonical[gate]) {
        throw new ContractViolation(
          `${targetName} resolves ${gate}() to ${reprOf(resolved)} rather ` +
            "than the one carrying the fail-closed spawn precondition " +
            "(D-0010) -- whether by overriding it directly or by " +
            "inheriting an override earlier in the prototype chain. Implement " +
            "_startSession() instead.",
        );
      }
    }

    // `ABCMeta`'s refusal, reproduced at the point Python makes it. A name is
    // unimplemented when what the chain resolves is still this class's own
    // placeholder -- the JavaScript stand-in for a function that is still
    // `__isabstractmethod__`.
    const unimplemented: string[] = [];
    for (const name of ABSTRACT_METHODS) {
      const resolved = resolvedFrom === null ? undefined : resolvedFrom[name];
      if (typeof resolved !== "function" || resolved === canonical[name]) {
        unimplemented.push(name);
      }
    }
    if (unimplemented.length > 0) {
      throw new ContractViolation(
        `cannot instantiate ${targetName}: SessionProvider leaves these abstract, ` +
          `and it does not implement them: ${unimplemented.sort().join(", ")}`,
      );
    }
  }

  // -- the capability probe and its precondition (D-0010) ----------------

  /**
   * Ask the provider's **public surface** what it is and what it supports.
   *
   * Public surface only (D-0010): no internal state directories, no private
   * sockets, no unpublished formats. An implementation that cannot answer from
   * the public surface returns a {@link Failure} -- which refuses the next spawn
   * -- rather than guessing.
   *
   * Synchronous, and that is a measurement rather than a preference (D-0301):
   * `subprocess.run(..., timeout=)` has an exact analogue in `spawnSync`, on
   * both branches the source distinguishes.
   */
  abstract probeCapabilities(): ProviderResult<CapabilityReport>;

  /**
   * Probe, and refuse to spawn unless the answer says the provider is usable.
   *
   * Concrete on purpose: fail-closed is a property of the contract, not of each
   * implementation's diligence, so implementations of {@link SessionProvider.start}
   * call this rather than re-deriving it. See {@link checkSpawnPrecondition} for
   * the cases.
   *
   * @throws {SpawnRefused} on an unusable, unreachable or unprobed provider.
   */
  requireSpawnable(): CapabilityReport {
    return checkSpawnPrecondition(this.probeCapabilities());
  }

  // -- the five verbs (D-0009) -------------------------------------------

  /**
   * Start one top-level worker session. **The verb, and the gate.**
   *
   * This method is deliberately *not* the one implementations write. It runs
   * {@link SessionProvider.requireSpawnable} first and only then delegates to
   * `_startSession`, so that the provider is never asked to create anything on
   * an unprobed, unreachable or incompatible backend (D-0010).
   *
   * Making it a helper an implementation is asked to call would have made
   * fail-closed a property of each implementation's diligence, which is exactly
   * what it must not be: the one implementation that forgets is the one that
   * spawns against a provider nobody has checked, and it would pass every test
   * that only exercises the happy path. The constructor refuses a subclass that
   * overrides this method, so the gate cannot be removed by accident either.
   *
   * A successful start returns the readout the provider gives for the session it
   * just created, which may legitimately be
   * {@link Observation.COULD_NOT_OBSERVE} -- a session can exist before it has
   * said anything about itself.
   *
   * @throws {SpawnRefused} synchronously, before the provider is asked to create
   * anything. The gate is not awaited and this function is not `async`, so the
   * ordering the source gets from a single statement sequence survives: the
   * refusal is raised on the calling turn, and `_startSession` is reached only
   * when it is not.
   */
  start(request: StartRequest): Promise<ProviderResult<SessionReadout>> {
    this.requireSpawnable();
    return this._startSession(request);
  }

  /**
   * Create the session. Called by `start` **after** the gate passes.
   *
   * This is the `start` verb's implementation half. It may assume the capability
   * probe has just succeeded, and must not be called directly by anything
   * outside this class -- calling it directly is how a caller would spawn past
   * the precondition.
   *
   * The one `_`-prefixed name on this class, and the prefix is load-bearing
   * twice over: the battery's delivery-verb scan filters the public surface by
   * it, and {@link VERB_IMPLEMENTATION_HOOKS} names it as the half an
   * implementation writes.
   */
  protected abstract _startSession(request: StartRequest): Promise<ProviderResult<SessionReadout>>;

  /**
   * List the sessions this provider currently holds.
   *
   * `new Ok([])` means the provider was reached and holds none. A provider that
   * could not be reached returns {@link Failure} -- the two must stay
   * distinguishable (R4), because in v1 they were not.
   */
  abstract listSessions(): Promise<ProviderResult<readonly SessionReadout[]>>;

  /**
   * Obtain the structured state of one session.
   *
   * A session that exists but cannot be read yields {@link Ok} carrying an
   * {@link Observation.COULD_NOT_OBSERVE} readout with its reason -- not a
   * {@link Failure}, since the call itself succeeded, and not an empty value.
   * {@link Failure} is for a call that did not happen or whose answer could not
   * be interpreted.
   */
  abstract readState(sessionId: string): Promise<ProviderResult<SessionReadout>>;

  /**
   * Stop one session, and report what the provider says about it afterwards.
   *
   * The readout is returned rather than a bare acknowledgement because a
   * provider's acceptance of a stop is not evidence that the session stopped.
   */
  abstract stop(sessionId: string): Promise<ProviderResult<SessionReadout>>;

  /**
   * Re-enter an existing session after a worker or supervisor restart.
   *
   * This interface makes no exclusivity promise for resume: whether the provider
   * prevents a second concurrent re-entry is a property of the provider, and the
   * control plane's lease -- not this call -- is what keeps a run single-writer.
   * An implementation must be correct with any provider-side refusal assumed
   * absent.
   */
  abstract resume(sessionId: string): Promise<ProviderResult<SessionReadout>>;

  // -- workspace lifecycle (not a verb; see CAPABILITY_ASSIGNMENTS) -------

  /**
   * Register a party that may veto workspace lifecycle transitions.
   *
   * Appends. No validation, no de-duplication, and registration order is
   * preserved and observable -- all three as the source has them.
   */
  registerWorkspaceObserver(observer: WorkspaceLifecycleObserver): void {
    this._workspaceObservers.push(observer);
  }

  /**
   * Ask every observer, and let any one of them veto.
   *
   * Fail closed in the same shape as the spawn precondition: an observer that
   * raises, or returns something that is not a {@link WorkspaceDecision}, vetoes.
   * An observer whose own failure let a transition through would be worse than no
   * observer, because its presence is what the caller is relying on.
   *
   * **Every observer is asked, including after a veto has been recorded.** The
   * capability this surface carries is *observe or veto* -- an observer that
   * keeps its own record of attempted transitions is doing the first half, and
   * short-circuiting on the first veto would make what it sees depend on the
   * registration order of parties it knows nothing about. The first veto is the
   * one returned; later ones are still collected so the decision can say how many
   * parties objected.
   */
  evaluateWorkspaceTransition(transition: WorkspaceTransition): WorkspaceDecision {
    let firstVeto: WorkspaceDecision | null = null;
    let vetoCount = 0;
    for (const observer of this._workspaceObservers) {
      let decision: unknown;
      try {
        decision = observer.onWorkspaceTransition(transition);
      } catch (exc) {
        // The source catches `Exception`, not `BaseException`, so a
        // `KeyboardInterrupt` or a `SystemExit` still propagates. JavaScript has
        // no such split -- `catch` takes everything a `throw` can carry -- so
        // this is wider than the source by exactly the class of interruption
        // Python reserves, and there is nothing to narrow it against.
        decision = new WorkspaceDecision(
          WorkspaceVerdict.VETO,
          `observer ${observerName(observer)} raised ${reprOf(exc)}`,
        );
      }
      // Deliberately after the catch, and therefore re-checking the decision
      // just synthesized -- which always passes. The source is written this way
      // and the shape matters: a synthesized veto and a returned one take the
      // same path from here.
      if (!WorkspaceDecision.is(decision)) {
        decision = new WorkspaceDecision(
          WorkspaceVerdict.VETO,
          `observer ${observerName(observer)} returned ${reprOf(decision)}, ` +
            "which is not a WorkspaceDecision",
        );
      }
      const outcome = decision as WorkspaceDecision;
      if (outcome.verdict === WorkspaceVerdict.VETO) {
        vetoCount += 1;
        if (firstVeto === null) {
          firstVeto = outcome;
        }
      }
    }
    if (firstVeto === null) {
      return new WorkspaceDecision(WorkspaceVerdict.ALLOW);
    }
    // Exactly one veto returns the observer's **own** decision object, unchanged
    // and by identity. Only two or more get the summarising rewrite.
    if (vetoCount === 1) {
      return firstVeto;
    }
    return new WorkspaceDecision(
      WorkspaceVerdict.VETO,
      `${firstVeto.reason} (and ${vetoCount - 1} further veto(es))`,
    );
  }
}

/**
 * `type(observer).__name__`, which never fails in Python.
 *
 * In JavaScript it can: an object from `Object.create(null)` has no
 * `constructor`, and a class expression assigned to nothing has an empty `name`.
 * Neither string is asserted by any case; the fallback exists so that a veto
 * reason is still a sentence when it happens.
 */
function observerName(observer: unknown): string {
  const name = (observer as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && name !== "" ? name : "<anonymous>";
}

/**
 * Give every abstract method a real function on the prototype.
 *
 * `abstractmethod` leaves a callable on the Python class -- one that raises when
 * called -- which is why `getattr(SessionProvider, "list_sessions")` is callable
 * and why `inspect.getmembers` finds it. TypeScript's `abstract` declares a type
 * and emits nothing, so without this the class's own prototype would carry only
 * `start`, `requireSpawnable`, `registerWorkspaceObserver` and
 * `evaluateWorkspaceTransition`, and two cases in the battery would be asking
 * their questions of a four-name surface instead of a nine-name one -- passing,
 * and proving nothing.
 *
 * The placeholders are also the marker the constructor's abstract-method check
 * reads: a name is unimplemented exactly when the prototype chain still resolves
 * to the one installed here.
 *
 * The set it iterates is frozen for the same reason: `ABSTRACT_METHODS.clear()`
 * would leave both this loop and the constructor's gate iterating nothing, and
 * every assertion in the battery would still hold.
 *
 * Non-enumerable, because that is what a class body's methods are, and
 * `Object.getOwnPropertyNames` -- which is what the battery's surface walk uses,
 * for this reason -- reports them either way.
 */
for (const name of ABSTRACT_METHODS) {
  Object.defineProperty(SessionProvider.prototype, name, {
    value: function abstractMember(): never {
      throw new ContractViolation(
        `${name}() is abstract on SessionProvider; this instance reached the ` +
          "declaration rather than an implementation of it",
      );
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
