/**
 * The fault-runner contract: what every role driver must satisfy.
 *
 * Ported from interlock `tests/fault_injection/contract.py` at `65f36c5`.
 *
 * Design section 6.2. This module is the **durable** side of the seam. It owns
 * the vocabulary -- checkpoint names, operation names, protocol messages, fault
 * kinds, invariant observable names, the driver CLI -- and it knows nothing
 * about the implementation of the day. When the spike implementation is
 * discarded (interlock D-0026) the next adapter is written against this file
 * unchanged.
 *
 * Two version numbers travel with every run:
 *
 * `FAULT_RUNNER_CONTRACT_VERSION`
 *     Bumped by any change to the checkpoint vocabulary, the protocol messages
 *     or the driver CLI. Controller and driver refuse a mismatch at the
 *     handshake.
 *
 * `PROTOCOL_VERSION`
 *     The wire format of the two-phase barrier itself (design section 3.1). It
 *     is carried in the spawn handshake and is part of the contract version
 *     above.
 *
 * Nothing here imports `src/` -- deliberately, and asserted by
 * `import-graph.test.ts`.
 */

import { createHash } from "node:crypto";

/** Bumped by any change to the checkpoint vocabulary, the protocol messages or the driver CLI. */
export const FAULT_RUNNER_CONTRACT_VERSION = 3;

/** The wire format of the two-phase barrier (design 3.1). */
export const PROTOCOL_VERSION = 1;

/**
 * A driver, a case or a controller broke the contract itself.
 *
 * The source spells this an `AssertionError` subclass, because a contract
 * violation is a harness fault and the design is explicit that a harness fault
 * must be attributable as such rather than reported as a component failure.
 * JavaScript has no assertion-error hierarchy to subclass, so the marker is the
 * class itself: every site that distinguishes a harness fault from a component
 * failure tests for this type, which is what the source's `except
 * AssertionError` chain relies on the subclassing for.
 */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}

// ---------------------------------------------------------------------------
// checkpoint vocabulary -- design 6.2
// ---------------------------------------------------------------------------
//
// These four names are the contract's, not the outbox's. Today they are
// textually equal to `src/control_plane/outbox.ts`'s constants and the spike
// adapter's conformance battery asserts that equality (design 2.2); when the
// spike is discarded the names here survive and the next adapter maps its
// internals onto them.

export const CHECKPOINT_BEFORE_DURABLE_WRITE = "before_durable_write";
export const CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT = "after_record_before_effect";
export const CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD = "after_effect_before_record";
export const CHECKPOINT_DELIVERED_BEFORE_ACK = "delivered_before_ack";

/**
 * The three ACCEPTANCE.md section 2 mid-flight points plus the fourth the
 * outbox rows add, in the order a delivery passes them.
 */
export const CHECKPOINTS = [
  CHECKPOINT_BEFORE_DURABLE_WRITE,
  CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  CHECKPOINT_DELIVERED_BEFORE_ACK,
] as const;

// ---------------------------------------------------------------------------
// roles and operations -- design 2.1
// ---------------------------------------------------------------------------

export const ROLE_SUPERVISOR = "sup";
export const ROLE_DISPATCHER = "disp";
export const ROLE_SECRETARY = "sec";

/** Ordered so that a `targets` set has one canonical spelling. */
export const ROLES = [ROLE_SUPERVISOR, ROLE_DISPATCHER, ROLE_SECRETARY] as const;

export const OPERATION_LEASE_ACQUIRE = "lease-acquire";
export const OPERATION_LEASE_RENEW = "lease-renew";
export const OPERATION_LEASE_RELEASE = "lease-release";
export const OPERATION_BIND = "bind";
export const OPERATION_ENQUEUE = "enqueue";
export const OPERATION_ATTEMPT = "attempt";
export const OPERATION_ACK = "ack";
/**
 * The watcher's read of a worker, and the classification it produces
 * (interlock D-0005, D-0006). It is one durable write with no external effect,
 * exactly like `bind`: the observation is read through a seam the fault can
 * break, and the fact state it yields is written to the `incident` table.
 */
export const OPERATION_OBSERVE = "observe";
/**
 * Gate item 2's commit-before-spawn walk: the session<->run binding is
 * committed durably, the provider process is spawned, and the identity the
 * provider actually assigned is read back and committed. Unlike `bind` -- a
 * single durable write -- this is a record -> effect -> result path whose
 * effect is a *process creation*, so it carries the two mid-call windows:
 * `after_record_before_effect` is "between the commit and the spawn" and
 * `after_effect_before_record` is "between the spawn and the identity
 * read-back's own commit". The fourth injection point ("after the read-back")
 * is {@link SYNC_IDENTITY_READBACK_COMMITTED}.
 */
export const OPERATION_SESSION_START = "session-start";

export const OPERATIONS = [
  OPERATION_LEASE_ACQUIRE,
  OPERATION_LEASE_RENEW,
  OPERATION_LEASE_RELEASE,
  OPERATION_BIND,
  OPERATION_ENQUEUE,
  OPERATION_ATTEMPT,
  OPERATION_ACK,
  OPERATION_OBSERVE,
  OPERATION_SESSION_START,
] as const;

/**
 * Which checkpoint windows each operation physically has (design 3.1).
 *
 * The two mid-call windows exist only on a record -> effect -> result path, so
 * only `attempt` carries all four. Every other operation is a single durable
 * write with nothing external after it, and exposes the window immediately
 * before that write commits and the window immediately after it committed --
 * named `after_record_before_effect` because that is what it is: the record is
 * durable and no effect follows.
 *
 * Manifest validation refuses a case arming a window its operation does not
 * have, so an unreachable barrier is a collection-time error and never a CI
 * timeout.
 */
export const CHECKPOINT_APPLICABILITY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [OPERATION_LEASE_ACQUIRE]: [
    CHECKPOINT_BEFORE_DURABLE_WRITE,
    CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  ],
  [OPERATION_LEASE_RENEW]: [CHECKPOINT_BEFORE_DURABLE_WRITE, CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT],
  [OPERATION_LEASE_RELEASE]: [
    CHECKPOINT_BEFORE_DURABLE_WRITE,
    CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  ],
  [OPERATION_BIND]: [CHECKPOINT_BEFORE_DURABLE_WRITE, CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT],
  [OPERATION_ENQUEUE]: [CHECKPOINT_BEFORE_DURABLE_WRITE, CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT],
  [OPERATION_ATTEMPT]: CHECKPOINTS,
  [OPERATION_ACK]: [CHECKPOINT_BEFORE_DURABLE_WRITE, CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT],
  [OPERATION_OBSERVE]: [CHECKPOINT_BEFORE_DURABLE_WRITE, CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT],
  // Three of gate item 2's four injection points are these windows; the fourth
  // -- after the read-back's own commit -- is a sync point, because there is no
  // further write for a checkpoint to sit in front of.
  [OPERATION_SESSION_START]: [
    CHECKPOINT_BEFORE_DURABLE_WRITE,
    CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
    CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  ],
});

// ---------------------------------------------------------------------------
// sync points -- design 3.1
// ---------------------------------------------------------------------------
//
// Barrier-capable like a checkpoint, but marking script progress rather than a
// durable-write window. They exist so a fault can be anchored to a known state
// when no write window is the right anchor; the SIGSTOP cases require one.

export const SYNC_LEASE_ACQUIRED = "lease-acquired";
export const SYNC_SCRIPT_COMPLETE = "script-complete";
/**
 * The observation has been read and classified but nothing downstream has acted
 * on it yet -- the anchor an escalation-policy fault needs.
 */
export const SYNC_OBSERVED = "observed";
/**
 * Gate item 2's fourth injection point: the provider's identity read-back has
 * been committed to SQLite ("after the read-back" is defined as after *this*
 * commit, never as after the answer was merely seen in memory).
 */
export const SYNC_IDENTITY_READBACK_COMMITTED = "identity-readback-committed";

export const SYNC_POINTS = [
  SYNC_LEASE_ACQUIRED,
  SYNC_SCRIPT_COMPLETE,
  SYNC_OBSERVED,
  SYNC_IDENTITY_READBACK_COMMITTED,
] as const;

/**
 * Everything a case may arm. Design 4.1: *every* fault is anchored; there is no
 * unanchored kind.
 */
export const ARMABLE_ANCHORS: readonly string[] = [...CHECKPOINTS, ...SYNC_POINTS];

/**
 * The operation script each role runs (design 2.1). The three are deliberately
 * different shapes over different tables, rows and leases, so a combination
 * case exercises a cross-role interleaving a single renamed process could not
 * produce. Supervisor and Secretary each carry one `attempt`-driven action
 * precisely so that all four mandated windows are reachable for every role --
 * the two mid-call windows exist nowhere else.
 */
export const ROLE_SCRIPTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [ROLE_SUPERVISOR]: [
    OPERATION_LEASE_ACQUIRE,
    OPERATION_BIND,
    // The Supervisor binds the session, so the Supervisor is the role that
    // observes it. Only this script carries the step; disp and sec are
    // unchanged, which is what keeps the observation row a Supervisor concern
    // rather than a property of every role.
    OPERATION_OBSERVE,
    OPERATION_LEASE_RENEW,
    OPERATION_ENQUEUE,
    OPERATION_ATTEMPT,
    OPERATION_ACK,
  ],
  // The delivery loop: hold the writer lease across the whole run, renewing
  // rather than releasing, and take rows through record -> effect -> result.
  [ROLE_DISPATCHER]: [
    OPERATION_LEASE_ACQUIRE,
    OPERATION_LEASE_RENEW,
    OPERATION_ENQUEUE,
    OPERATION_ATTEMPT,
    OPERATION_ACK,
  ],
  // The intake/ack side: enqueue, deliver, ack, and then hand the resource
  // back. The release is not decoration -- it is the step neither other script
  // performs, so the Secretary's write-set ends on a lease-row mutation the
  // Dispatcher never makes and the two scripts are not one function under two
  // names (design 2.1 item 5).
  [ROLE_SECRETARY]: [
    OPERATION_LEASE_ACQUIRE,
    OPERATION_ENQUEUE,
    OPERATION_ATTEMPT,
    OPERATION_ACK,
    OPERATION_LEASE_RELEASE,
  ],
});

// ---------------------------------------------------------------------------
// fault kinds and lanes -- design 4.1, 5, 8.1
// ---------------------------------------------------------------------------

export const FAULT_KINDS = [
  // -- the seed set -----------------------------------------------------
  "sigkill",
  "sigstop-expire",
  "clock-fwd",
  "clock-back",
  "drop-delivery",
  "dup-delivery",
  "lost-ack",
  "staggered-sigkill",
  // -- the rest of the ACCEPTANCE.md section 2 matrix --------------------
  //
  // Each name below is one injection the section 2 table asks for by name, and
  // nothing else. They are grouped by the row they discharge so a reader can
  // check the table against this tuple without opening the manifest.
  //
  // Lease row: "kill the lease holder without release".
  "sigkill-expire",
  // Outbox-resend row: "hold the recipient unavailable across several retry
  // attempts".
  "recipient-unavailable",
  // Ack row: "duplicate the ack", "deliver the ack after the sender has
  // restarted", "ack an already-acked message".
  "dup-ack",
  "late-ack",
  "re-ack",
  // Dedup row: "raise the same incident condition repeatedly within a window",
  // "replay a persisted incident packet".
  "incident-repeat",
  "incident-replay",
  // Single-writer row: "two writers race for the same state item", "a write is
  // attempted concurrently from a resumed process and its replacement".
  "writer-race",
  "resumed-writer-race",
  // Observation-outage row: "make the observation path fail or return nothing
  // while the worker is genuinely healthy".
  "observation-outage",
] as const;

/**
 * The faults in which a second claimant *takes the resource over* -- the
 * incumbent is gone or fenced out and the claimant's epoch is the one that
 * wins. They are the cases where the destination-side statement is "the
 * superseded holder reached the destination zero times".
 *
 * `writer-race` is deliberately not one of them: there the incumbent is alive
 * and holds a live lease, so the *racer* is the one refused. Reading the two
 * shapes the same way would assert that the winner produced nothing.
 */
export const TAKEOVER_FAULTS: readonly string[] = [
  "sigstop-expire",
  "clock-fwd",
  "sigkill-expire",
  "resumed-writer-race",
];

/**
 * The kill-shaped faults. Three separate places used to spell this membership
 * out as a literal tuple -- `executeCase`'s dispatch, the `atKill`
 * window-landing gate and the kill-shaped branch of the invariant assertions --
 * and two of them fail *silently* when a new kill-shaped kind is not added to
 * all three. Naming the set once is what stops a new fault kind from quietly
 * asserting nothing.
 */
export const KILL_FAULTS: readonly string[] = [
  "sigkill",
  "staggered-sigkill",
  "sigkill-expire",
  "recipient-unavailable",
  "late-ack",
  "resumed-writer-race",
];

// ---------------------------------------------------------------------------
// the watcher's fact state and the observation seam -- interlock D-0005, D-0006
// ---------------------------------------------------------------------------
//
// interlock D-0005 fixes the *names* and D-0006 fixes one relation between two
// of them. Neither fixes any per-state semantics or detection predicate -- that
// is Q-0012, and it stays open. So the contract carries the closed set as a
// vocabulary to validate against, and carries **no** mapping from a fact state
// to a verdict. The only rule encoded here is the one D-0006 actually decides.

export const FACT_ACTIVE_EVIDENCE = "ACTIVE_EVIDENCE";
export const FACT_KNOWN_WAIT = "KNOWN_WAIT";
export const FACT_EXPLICIT_BLOCK = "EXPLICIT_BLOCK";
export const FACT_NO_ACTIVITY_EVIDENCE = "NO_ACTIVITY_EVIDENCE";
export const FACT_OBSERVATION_UNAVAILABLE = "OBSERVATION_UNAVAILABLE";
export const FACT_TERMINAL = "TERMINAL";

/**
 * The closed set (interlock D-0005). A seventh state is a `D-` entry, not a
 * code change, so this tuple is a vocabulary check and never a place to add
 * one.
 */
export const FACT_STATES = [
  FACT_ACTIVE_EVIDENCE,
  FACT_KNOWN_WAIT,
  FACT_EXPLICIT_BLOCK,
  FACT_NO_ACTIVITY_EVIDENCE,
  FACT_OBSERVATION_UNAVAILABLE,
  FACT_TERMINAL,
] as const;

/**
 * The two states interlock D-0006 settles are **not** anomalies.
 *
 * A case declares an escalation policy -- which fact states it would escalate
 * on -- as ordinary case data, and the observation cases deliberately name the
 * very state their injection produces. The driver must then **refuse** to
 * escalate and record that refusal. Asking for the escalation is the point: it
 * is what makes "no termination or restart recommendation is produced from it"
 * an assertion about a row a broken driver would have written, rather than a
 * count over rows nothing in the tree can write. A case that never asked would
 * pass whether or not the rule held.
 *
 * Nothing here says what either state *means*; Q-0012 stays open.
 */
export const ESCALATION_REFUSED_FACT_STATES: readonly string[] = [
  FACT_OBSERVATION_UNAVAILABLE,
  FACT_NO_ACTIVITY_EVIDENCE,
];

/**
 * What the observation seam is made to do. The fault acts on the *reader*, not
 * on the classifier and not on the assertion: `unreadable` makes the read
 * raise, `silent` makes it return a well-formed observation carrying no
 * activity, and `healthy` is the control. Collapsing the first two into one
 * outcome is precisely the defect interlock D-0006 exists to police, so they
 * are distinct modes producing distinct fact states.
 */
export const OBSERVATION_HEALTHY = "healthy";
export const OBSERVATION_SILENT = "silent";
export const OBSERVATION_UNREADABLE = "unreadable";

export const OBSERVATION_MODES = [
  OBSERVATION_HEALTHY,
  OBSERVATION_SILENT,
  OBSERVATION_UNREADABLE,
] as const;

/**
 * The fact state each observation mode must yield. Read the mapping in the
 * direction it is written: it says what the *reader's outcome* is called, not
 * what it means. An outage reads as `OBSERVATION_UNAVAILABLE` and a silent but
 * readable worker reads as `NO_ACTIVITY_EVIDENCE`; asserting a disjunction of
 * the two would pass exactly the confusion interlock D-0006 forbids.
 */
export const OBSERVATION_FACT_STATES: Readonly<Record<string, string>> = Object.freeze({
  [OBSERVATION_HEALTHY]: FACT_ACTIVE_EVIDENCE,
  [OBSERVATION_SILENT]: FACT_NO_ACTIVITY_EVIDENCE,
  [OBSERVATION_UNREADABLE]: FACT_OBSERVATION_UNAVAILABLE,
});

export const LANE_LINUX = "linux";
export const LANE_PORTABLE = "portable";
export const LANES = [LANE_LINUX, LANE_PORTABLE] as const;

/** Barrier modes (design 5). */
export const BARRIER_ALIGNED = "aligned";
export const BARRIER_STAGGERED = "staggered";
export const BARRIER_MODES = [BARRIER_ALIGNED, BARRIER_STAGGERED] as const;

// ---------------------------------------------------------------------------
// protocol messages -- design 3.1
// ---------------------------------------------------------------------------
//
// Line-oriented JSON, one object per line, over two inherited pipes: the
// controller writes commands to the driver's control pipe and reads events from
// its event pipe. The driver's stderr is never part of the protocol -- it is a
// diagnostic channel the controller captures to a file and attaches to a failed
// case.

export const EVENT_HELLO = "hello";
export const EVENT_CHECKPOINT = "checkpoint";
export const EVENT_SYNC = "sync";
export const EVENT_STEP = "step";
export const EVENT_CLOCK_OFFSET = "clock_offset";
export const EVENT_RECOVERY_COMPLETE = "recovery_complete";
export const EVENT_DONE = "done";
export const EVENT_ERROR = "error";

/**
 * Every protocol event name, as one closed tuple.
 *
 * **Ported dead data, deliberately.** `contract.py` defines `EVENTS` and nothing in
 * interlock reads it; the individual `EVENT_*` constants are what the controller
 * and the driver use. It is the vocabulary written down in one place, which is
 * what makes the set closed.
 *
 * The `@parityonly` tag excludes it from knip's dead-export analysis (`knip.json`).
 * That exclusion is deliberately narrow: it marks THIS export as unused-in-the-
 * source-too, rather than switching the check off, so a genuinely dead export
 * added later still turns the gate red.
 *
 * @parityonly
 */
export const EVENTS = [
  EVENT_HELLO,
  EVENT_CHECKPOINT,
  EVENT_SYNC,
  EVENT_STEP,
  EVENT_CLOCK_OFFSET,
  EVENT_RECOVERY_COMPLETE,
  EVENT_DONE,
  EVENT_ERROR,
] as const;

export const CMD_CONTINUE = "continue";
export const CMD_SET_CLOCK_OFFSET = "set_clock_offset";

/**
 * Every controller-to-driver command name, as one closed tuple.
 *
 * **Ported dead data, deliberately**, for the same reason as {@link EVENTS}.
 *
 * The `@parityonly` tag excludes it from knip's dead-export analysis (`knip.json`).
 * That exclusion is deliberately narrow: it marks THIS export as unused-in-the-
 * source-too, rather than switching the check off, so a genuinely dead export
 * added later still turns the gate red.
 *
 * @parityonly
 */
export const COMMANDS = [CMD_CONTINUE, CMD_SET_CLOCK_OFFSET] as const;

// ---------------------------------------------------------------------------
// the driver CLI -- design 6.2
// ---------------------------------------------------------------------------

/**
 * The long options every role driver must accept.
 *
 * Kept as data so the conformance battery can assert an adapter's parser
 * against the contract rather than against a prose list. A driver may add
 * options; it may not drop one of these or change its meaning.
 */
export function driverCliArguments(): readonly string[] {
  return [
    "--role",
    "--db",
    "--case-id",
    "--suite-seed",
    "--armed",
    "--clock-base-ms",
    "--clock-offset-ms",
    "--restart-generation",
    "--control-fd",
    "--event-fd",
    // The observation seam (interlock D-0006) and the incident parameters the
    // ACCEPTANCE.md section 2 dedup row requires to be parameterised rather
    // than hard-coded (Q-0002, Q-0003). A driver that cannot be told which
    // collapse rule to apply would be answering an open question by inertia,
    // which is the one thing the matrix may not do.
    "--observation-mode",
    "--escalate-on",
    "--incident-dedup-key",
    "--incident-repeats",
    "--incident-collapse",
    "--incident-renotify-window-ms",
    "--incident-reconcile-interval-ms",
    "--unavailable-attempts",
  ];
}

// ---------------------------------------------------------------------------
// seeds -- design 4.3
// ---------------------------------------------------------------------------

/**
 * The per-case seed: `sha256(manifest_version || case_id || suite_seed)`.
 *
 * Order-independent and platform-independent by construction. Adding a case
 * does not shift any other case's stream, and Python's hash randomisation is
 * irrelevant because no `hash()` is involved -- which is equally true here, and
 * for the same reason: the derivation is a digest, not a hash-table hash. The
 * three fields are joined by NUL exactly as the source joins them, so the
 * digest is byte-identical to interlock's for the same inputs.
 *
 * Returns a **`bigint`**. The source's `int.from_bytes(digest[:8], "big")`
 * yields a 64-bit value, and the pinned expectation in the source's own test is
 * `0x574FF7BDD408EA49` -- larger than `Number.MAX_SAFE_INTEGER`, so a `number`
 * return would silently round the contract's own pinned constant. The same
 * boundary rule this repository draws elsewhere for SQLite integers (interlock
 * D-0007) applies to the derivation itself.
 *
 * The seed's authority is payload and schedule only (design 4.3): it never
 * chooses the checkpoint, the fault, the target set or the kill order -- those
 * are the case's identity and they live in the manifest.
 */
export function caseSeed(options: {
  manifestVersion: number;
  caseId: string;
  suiteSeed: number;
}): bigint {
  // The source joins the three fields with NUL. Written as an escape rather
  // than as a raw byte so the file stays free of control characters.
  const nul = "\u0000";
  const material = [
    String(Math.trunc(options.manifestVersion)),
    options.caseId,
    String(Math.trunc(options.suiteSeed)),
  ].join(nul);
  const digest = createHash("sha256").update(material, "utf8").digest();
  return digest
    .subarray(0, 8)
    .reduce((accumulator, byte) => (accumulator << 8n) | BigInt(byte), 0n);
}

// ---------------------------------------------------------------------------
// clock model -- design 7
// ---------------------------------------------------------------------------

/**
 * The single named constant the boundary-relative skew magnitudes are built
 * from. Forward skew is `ttlMs + CLOCK_GUARD_MS` (guaranteed to cross
 * `expires_at_ms` from inside the lease); backward skew is
 * `-(elapsed + CLOCK_GUARD_MS)` (guaranteed to land before `acquired_at_ms`).
 */
export const CLOCK_GUARD_MS = 1_000;

/**
 * Resolve a symbolic clock programme to milliseconds (design 7).
 *
 * Symbolic in the manifest, resolved at run time from the case's `ttlMs`, and
 * recorded in the reproduction line -- so a failure replays exactly while the
 * manifest stays meaningful when a case's TTL changes.
 */
export function resolveSkewMs(
  direction: string,
  options: { ttlMs: number; elapsedMs: number },
): number {
  if (direction === "forward") {
    return Math.trunc(options.ttlMs) + CLOCK_GUARD_MS;
  }
  if (direction === "backward") {
    return -(Math.trunc(options.elapsedMs) + CLOCK_GUARD_MS);
  }
  throw new ContractViolation(
    `unknown clock direction ${JSON.stringify(direction)}; the manifest carries ` +
      "'forward' or 'backward', never a raw millisecond count",
  );
}

// ---------------------------------------------------------------------------
// invariant observables -- design 6.2
// ---------------------------------------------------------------------------
//
// Two kinds, both named and both required. The durable tests assert through
// these names; the adapter maps them to the schema of the day, so when the
// spike schema is thrown away the queries are re-bound and the assertions are
// not rewritten.

export const INVARIANT_NO_UNOWNED_OUTBOX = "no-unowned-outbox";
export const INVARIANT_RETRY_COUNT_DURABLE = "retry-count-durable";
export const INVARIANT_SINGLE_ACKED_STATE = "single-acked-state";
export const INVARIANT_LINEAR_WRITER_HISTORY = "linear-writer-history";
export const INVARIANT_RECORDED_REFUSALS = "recorded-refusals";
export const INVARIANT_NO_PENDING_ACTION = "no-pending-action";
export const INVARIANT_LEASE_SINGLE_HOLDER = "lease-single-holder";

/**
 * Every incident row in the scope, so the assertion can group by dedup key and
 * check whichever collapse rule the case declared. Neither Q-0002 rule is
 * expressed in the SQL -- that is the point.
 */
export const INVARIANT_INCIDENT_COLLAPSE = "incident-collapse";

/**
 * The incidents still open. Gate item 4 asks that "work resumes from unresolved
 * incidents", and the spike schema indexes exactly this question
 * (`incident_unresolved`, commented with that sentence). It is also fed into
 * the controller's recoverable-state set, so an incident open at the kill counts
 * as something the restart had to recover.
 */
export const INVARIANT_UNRESOLVED_INCIDENTS = "unresolved-incidents";

/**
 * What the observation path was classified as. Asserted against the closed
 * interlock D-0005 set and, per injection, against exactly one member of it.
 */
export const INVARIANT_OBSERVATION_CLASSIFIED = "observation-classified";

/**
 * The termination/restart recommendations produced in the scope. Always returns
 * exactly one row (a count), so "none were produced" is a pass rather than an
 * empty result -- and a driver that escalated on an interlock D-0006 state would
 * move the count, which is what makes the assertion falsifiable.
 */
export const INVARIANT_NO_ANOMALY_ESCALATION = "no-anomaly-escalation";

/**
 * Destination-side observables. ACCEPTANCE.md section 2 is explicit that SQLite
 * alone cannot prove exactly-once for an external effect, so every case that
 * kills inside or after an effect window **must** name one of these -- manifest
 * validation enforces it.
 */
export const INVARIANT_ONE_EFFECT_PER_KEY = "one-effect-per-key";
export const INVARIANT_DELIVERED_IMPLIES_EFFECT = "delivered-implies-effect";

/**
 * Exactly one active session binding for the case's run after recovery. The
 * partial unique index makes "at most one" the database's; the non-empty half of
 * "exactly one" is this assertion's, made only after a restart has run -- a
 * recovery that ends with no binding re-identified nothing.
 */
export const INVARIANT_ONE_BINDING_PER_RUN = "one-binding-per-run";

/**
 * Destination-side (a process is an external effect): at no point after the
 * recovery may two provider processes be live against one session id. The
 * observer counts real processes, out of process with the killed role; an
 * adapter supplying this name must expose `liveProcessReport()` returning
 * `{sessionUuid: liveProcessCount}`.
 */
export const INVARIANT_LIVE_PROCESSES_PER_SESSION = "live-processes-per-session";

/**
 * Destination-side: the captured event streams (the C2 transcript stand-in) for
 * every session the case touched name exactly one identity and carry no
 * duplicated turn. An adapter supplying this name must expose
 * `transcriptReport()`.
 */
export const INVARIANT_TRANSCRIPT_SINGLE_WRITER = "transcript-single-writer";

export const SQL_INVARIANTS: readonly string[] = [
  INVARIANT_NO_UNOWNED_OUTBOX,
  INVARIANT_RETRY_COUNT_DURABLE,
  INVARIANT_SINGLE_ACKED_STATE,
  INVARIANT_LINEAR_WRITER_HISTORY,
  INVARIANT_RECORDED_REFUSALS,
  INVARIANT_NO_PENDING_ACTION,
  INVARIANT_LEASE_SINGLE_HOLDER,
  INVARIANT_INCIDENT_COLLAPSE,
  INVARIANT_UNRESOLVED_INCIDENTS,
  INVARIANT_OBSERVATION_CLASSIFIED,
  INVARIANT_NO_ANOMALY_ESCALATION,
  INVARIANT_ONE_BINDING_PER_RUN,
];

export const DESTINATION_INVARIANTS: readonly string[] = [
  INVARIANT_ONE_EFFECT_PER_KEY,
  INVARIANT_DELIVERED_IMPLIES_EFFECT,
  INVARIANT_LIVE_PROCESSES_PER_SESSION,
  INVARIANT_TRANSCRIPT_SINGLE_WRITER,
];

export const INVARIANT_NAMES: readonly string[] = [...SQL_INVARIANTS, ...DESTINATION_INVARIANTS];

/**
 * The named parameters each SQL invariant binds. The contract fixes the names so
 * a durable test can supply them without knowing the schema behind them; the
 * adapter's SQL must use exactly these and no others, and the conformance
 * battery checks that it does.
 *
 * `scope` is deliberately not `resource`. The spike schema's effect table has no
 * resource column at all -- a known limit recorded in interlock's
 * `docs/lease-fencing.md` -- so an adapter must be free to scope a history query
 * by whatever its schema actually carries. Naming the parameter after the
 * *question* ("this role's own write scope") rather than after one schema's
 * answer is what keeps the durable assertion re-bindable.
 */
export const INVARIANT_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [INVARIANT_NO_UNOWNED_OUTBOX]: ["resource", "now_ms"],
  [INVARIANT_RETRY_COUNT_DURABLE]: ["holder_prefix"],
  [INVARIANT_SINGLE_ACKED_STATE]: ["holder_prefix"],
  [INVARIANT_LINEAR_WRITER_HISTORY]: ["scope"],
  [INVARIANT_RECORDED_REFUSALS]: ["resource", "holder"],
  [INVARIANT_NO_PENDING_ACTION]: ["scope"],
  [INVARIANT_LEASE_SINGLE_HOLDER]: ["now_ms"],
  [INVARIANT_INCIDENT_COLLAPSE]: ["scope"],
  [INVARIANT_UNRESOLVED_INCIDENTS]: ["scope"],
  [INVARIANT_OBSERVATION_CLASSIFIED]: ["scope"],
  [INVARIANT_NO_ANOMALY_ESCALATION]: ["scope"],
  [INVARIANT_ONE_BINDING_PER_RUN]: ["scope"],
});

/**
 * The checkpoints after which an external effect may already have happened. A
 * case anchored at one of these must name a destination assertion.
 */
export const EFFECT_BEARING_CHECKPOINTS: readonly string[] = [
  CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  CHECKPOINT_DELIVERED_BEFORE_ACK,
];

// ---------------------------------------------------------------------------
// the wire types -- design 3.1, 6.2
// ---------------------------------------------------------------------------

/**
 * One armed barrier: an anchor name and which occurrence of it to hold at.
 *
 * A loop passes the same point repeatedly, so the occurrence index is part of
 * the arming, not an afterthought (design 3.1). Occurrences are 1-based.
 *
 * The source is a frozen dataclass, which gives it value equality for free; the
 * port keeps the fields `readonly` and adds {@link ArmedAnchor.equals} rather
 * than relying on identity. The source's own round-trip case compares
 * `ArmedAnchor.parse(anchor.wire()) == anchor`, which is a value comparison, so
 * losing it would turn that case into a tautology about two distinct objects.
 */
export class ArmedAnchor {
  readonly anchor: string;
  readonly occurrence: number;
  readonly operation: string | null;

  constructor(options: { anchor: string; occurrence?: number; operation?: string | null }) {
    const occurrence = options.occurrence ?? 1;
    const operation = options.operation ?? null;
    if (!ARMABLE_ANCHORS.includes(options.anchor)) {
      throw new ContractViolation(
        `${JSON.stringify(options.anchor)} is not an armable anchor; the contract's ` +
          `anchors are ${JSON.stringify(ARMABLE_ANCHORS)}`,
      );
    }
    if (occurrence < 1) {
      throw new ContractViolation("occurrence indices are 1-based");
    }
    if (operation !== null && !OPERATIONS.includes(operation as (typeof OPERATIONS)[number])) {
      throw new ContractViolation(`${JSON.stringify(operation)} is not a contract operation`);
    }
    this.anchor = options.anchor;
    this.occurrence = occurrence;
    this.operation = operation;
  }

  /** The `--armed` spelling: `anchor:occurrence` or `op@anchor:occ`. */
  wire(): string {
    if (this.operation === null) {
      return `${this.anchor}:${this.occurrence}`;
    }
    return `${this.operation}@${this.anchor}:${this.occurrence}`;
  }

  /** The frozen dataclass's `==`, kept explicitly. */
  equals(other: ArmedAnchor): boolean {
    return (
      this.anchor === other.anchor &&
      this.occurrence === other.occurrence &&
      this.operation === other.operation
    );
  }

  static parse(text: string): ArmedAnchor {
    let operation: string | null = null;
    let body = text;
    const at = body.indexOf("@");
    if (at >= 0) {
      operation = body.slice(0, at);
      body = body.slice(at + 1);
    }
    // `str.partition(":")`: everything before the first colon, and everything
    // after it. An absent colon leaves the occurrence empty, which defaults to
    // 1 -- the shape `ArmedAnchor.parse("lease-acquired")` relies on.
    const colon = body.indexOf(":");
    const anchor = colon >= 0 ? body.slice(0, colon) : body;
    const occurrence = colon >= 0 ? body.slice(colon + 1) : "";
    return new ArmedAnchor({
      anchor,
      occurrence: occurrence === "" ? 1 : parseOccurrence(occurrence, text),
      operation,
    });
  }
}

/**
 * The occurrence suffix of an armed anchor, parsed the way the source parses it.
 *
 * The source is `int(occurrence)`, which RAISES on anything that is not a whole
 * number. `Number.parseInt` does neither thing it needs to: it accepts a prefix,
 * so `"2junk"` silently becomes 2, and it returns `NaN` for `"abc"` -- and `NaN`
 * slips through an `occurrence < 1` guard, because every comparison with `NaN`
 * is false.
 *
 * Both outcomes are the failure design section 3.1 exists to prevent. A silently
 * changed index arms a different pass through the loop than the one the case
 * declared. A `NaN` index matches no occurrence at all, so the barrier is never
 * reached and the case dies as a CI TIMEOUT -- when the whole point of parsing
 * the arming eagerly is that "a barrier that cannot be reached is a manifest
 * error, not a CI timeout".
 *
 * So the whole suffix is validated. Raised by the review gate on this change.
 */
function parseOccurrence(occurrence: string, wire: string): number {
  if (!/^\d+$/.test(occurrence)) {
    throw new ContractViolation(
      `${JSON.stringify(wire)} has a malformed occurrence ${JSON.stringify(occurrence)}; an ` +
        "armed anchor's occurrence is a positive whole number, and a malformed one is a " +
        "manifest error rather than a barrier that is never reached",
    );
  }
  const parsed = Number(occurrence);
  if (!Number.isSafeInteger(parsed)) {
    throw new ContractViolation(
      `${JSON.stringify(wire)} has an occurrence past the exactly-representable range ` +
        `(${occurrence}); it could not be compared against a real occurrence index`,
    );
  }
  return parsed;
}

/** The spawn handshake, as the controller checks it. */
export class Handshake {
  readonly protocolVersion: number;
  readonly contractVersion: number;
  readonly role: string;
  readonly caseId: string;
  readonly restartGeneration: number;
  readonly extras: Readonly<Record<string, unknown>>;

  constructor(options: {
    protocolVersion: number;
    contractVersion: number;
    role: string;
    caseId: string;
    restartGeneration: number;
    extras?: Readonly<Record<string, unknown>>;
  }) {
    this.protocolVersion = options.protocolVersion;
    this.contractVersion = options.contractVersion;
    this.role = options.role;
    this.caseId = options.caseId;
    this.restartGeneration = options.restartGeneration;
    this.extras = options.extras ?? {};
  }

  check(
    expectations: { expectRole?: string; expectCaseId?: string; expectGeneration?: number } = {},
  ): void {
    // Order is the source's and is load-bearing for the messages the protocol
    // cases match on: identity first, then versions, then vocabulary.
    if (expectations.expectRole !== undefined && this.role !== expectations.expectRole) {
      throw new ContractViolation(
        `the driver answered as ${JSON.stringify(this.role)}, but was spawned as ` +
          `${JSON.stringify(expectations.expectRole)}: every later event is correlated by ` +
          "the slot, so the harness would drive one role and report another",
      );
    }
    if (expectations.expectCaseId !== undefined && this.caseId !== expectations.expectCaseId) {
      throw new ContractViolation(
        `the driver answered for case ${JSON.stringify(this.caseId)}, but was ` +
          `spawned for ${JSON.stringify(expectations.expectCaseId)}`,
      );
    }
    if (
      expectations.expectGeneration !== undefined &&
      this.restartGeneration !== expectations.expectGeneration
    ) {
      throw new ContractViolation(
        `the driver answered as restart generation ${this.restartGeneration}, but was ` +
          `spawned as ${expectations.expectGeneration}: a generation 0 reported as a ` +
          "restart is a recovery that never happened",
      );
    }
    if (this.protocolVersion !== PROTOCOL_VERSION) {
      throw new ContractViolation(
        `driver speaks protocol ${this.protocolVersion}, controller speaks ${PROTOCOL_VERSION}`,
      );
    }
    if (this.contractVersion !== FAULT_RUNNER_CONTRACT_VERSION) {
      throw new ContractViolation(
        `driver targets fault-runner contract ${this.contractVersion}, controller is ` +
          `${FAULT_RUNNER_CONTRACT_VERSION}`,
      );
    }
    if (!ROLES.includes(this.role as (typeof ROLES)[number])) {
      throw new ContractViolation(`${JSON.stringify(this.role)} is not a contract role`);
    }
  }
}

// ---------------------------------------------------------------------------
// the seam -- design 6.2, and D-0601's two adapter classes
// ---------------------------------------------------------------------------

/** One row of a named invariant query, as the controller hands it to an assertion. */
export type InvariantRow = Readonly<Record<string, unknown>>;

/**
 * The destination-side evidence interface (design 6.2).
 *
 * It mirrors the outbox's `Destination` protocol deliberately, but the
 * harness's implementation must be **durable across the role kill and
 * out-of-process relative to the killed role**: the controller reads the
 * destination's own store after the kill, so the evidence is the counterparty's
 * record and never a re-derivation from our control-plane rows.
 */
export interface DestinationObserver {
  effectCount(idempotencyKey: string): number;
  attemptCount(idempotencyKey: string): number;
  /**
   * Release any exclusion the killed writer left behind.
   *
   * A destination that serialises its own critical section can be left holding
   * that exclusion forever by a SIGKILL landing inside it, and the process that
   * fired the signal is the only one that knows it happened. A destination with
   * no such section implements this as a no-op.
   */
  unwedge(): void;
  /** Every effect record the destination holds, when it can enumerate them. */
  effects?(): readonly string[];
  /** `{sessionUuid: liveProcessCount}`, for `live-processes-per-session`. */
  liveProcessReport?(): Readonly<Record<string, number | null>>;
  /** Per-session transcript shape, for `transcript-single-writer`. */
  transcriptReport?(): Readonly<Record<string, TranscriptShape>>;
}

export interface TranscriptShape {
  readonly distinct_ids?: readonly string[];
  readonly duplicate_turn_ids?: number;
  readonly streams?: number;
  readonly ledger_starts?: number;
}

/** A manifest case, as the harness passes it around. */
export type FaultCase = Readonly<Record<string, unknown>>;

/**
 * The narrow seam a manifest case's `adapter` field may name (D-0601).
 *
 * A `CaseAdapter` supplies what it takes to *execute* a case: the driver to
 * spawn, the store to bootstrap, the per-role arguments and the evidence
 * readers the case's declared invariants need. It is deliberately not the
 * conformance battery's subject -- see {@link FullFaultAdapter}.
 */
export interface CaseAdapter {
  /** The adapter's registry name, which is what a manifest case's `adapter` field carries. */
  readonly name: string;
  /** Identifies the driver in reports; the source's dotted `-m` module path. */
  readonly driverModule: string;
  /** The command the controller spawns for a role process. */
  driverCommand(): { readonly executable: string; readonly prefixArguments: readonly string[] };
  /** Create the store and whatever rows a role script presupposes. */
  bootstrap(dbPath: string, options: { roles: readonly string[]; nowMs: number }): void;
  /** Extra CLI arguments this adapter's driver needs for `role`. */
  roleArguments(role: string, options: { case: FaultCase; workdir: string }): readonly string[];
  /** The out-of-process destination record for `role`. */
  observer(workdir: string, role: string): DestinationObserver;
  /** Map every name in {@link SQL_INVARIANTS} to SQL for today's schema. */
  invariantQueries(): Readonly<Record<string, string>>;
  /**
   * Which store a named invariant is read from.
   *
   * Usually the control-plane database. It is a method rather than a constant
   * because an adapter may keep a harness-scoped record beside the control
   * plane rather than inside it.
   */
  storePath(name: string, options: { controlPlane: string; workdir: string }): string;
  /**
   * Bind {@link INVARIANT_PARAMETERS} for one role's own rows.
   *
   * The durable tests scope an assertion to a role without knowing what a
   * resource, a holder or an action kind is spelled like in the schema of the
   * day -- that spelling is the adapter's, and only the adapter's.
   */
  queryParameters(role: string, options: { nowMs: number }): Readonly<Record<string, unknown>>;
  /** The destination dedup keys a role's script produces for this case. */
  effectKeys(
    role: string,
    faultCase: FaultCase,
    options?: { holderSuffix?: string },
  ): readonly string[];
  /** The lease holder identity this adapter gives `role`. */
  holderOf(role: string): string;
}

/**
 * A conformance battery subject (D-0601).
 *
 * Every `FullFaultAdapter` the build ships is run through `conformance.ts`
 * unchanged, and an adapter that has not passed it cannot contribute matrix
 * results (design 6.3). The extra member over {@link CaseAdapter} is what the
 * battery needs and a case does not: the adapter's own checkpoint vocabulary,
 * which the battery asserts equals the contract's.
 */
export interface FullFaultAdapter extends CaseAdapter {
  /** The adapter's own window names, asserted equal to {@link CHECKPOINTS}. */
  checkpointVocabulary(): readonly string[];
  /**
   * Parse one driver command line, throwing if it is not accepted.
   *
   * The battery needs this because of a coupling the port loses. The source's
   * driver is an `argparse` parser and its `--help` is GENERATED from that
   * parser, so "the option appears in --help" implies "the parser accepts it"
   * -- which is what makes a substring check over the help text a real
   * assertion there. A hand-written parser with independently hand-written help
   * has no such implication: an option can sit in the help text while its
   * branch is missing, and the substring check would still qualify the adapter.
   *
   * Exposing the parser restores the implication by testing it directly.
   */
  parseDriverArguments(argv: readonly string[]): void;
  /** The driver's source file, which the no-host-clock check parses. */
  readonly driverSourcePath: string;
}
