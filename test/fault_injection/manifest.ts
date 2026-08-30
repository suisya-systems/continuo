/**
 * The case matrix: an explicit, checked-in enumeration (design 4).
 *
 * Ported from interlock `tests/fault_injection/manifest.py` at `65f36c5`.
 *
 * Injection points are never sampled. The Issue reads as if the seed selected
 * them; it does not, and design section 4 says why: if it did, adding a case,
 * reordering an enumeration or a different hash seed would silently change what
 * every seed means. The matrix is a frozen literal in `manifest.json`,
 * {@link buildCases} is the generator that must reproduce it exactly, and
 * `manifest.test.ts` asserts the two agree -- so adding or pruning a case is
 * always a reviewable diff and never a side effect of an enumeration change.
 *
 * The seed's authority is payload and schedule only (design 4.3).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as contract from "./contract.js";
import {
  ArmedAnchor,
  BARRIER_ALIGNED,
  BARRIER_STAGGERED,
  CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  CHECKPOINT_BEFORE_DURABLE_WRITE,
  CHECKPOINT_DELIVERED_BEFORE_ACK,
  CHECKPOINTS,
  ContractViolation,
  DESTINATION_INVARIANTS,
  EFFECT_BEARING_CHECKPOINTS,
  LANE_LINUX,
  LANE_PORTABLE,
  OPERATION_ACK,
  OPERATION_ATTEMPT,
  OPERATION_BIND,
  OPERATION_ENQUEUE,
  OPERATION_LEASE_ACQUIRE,
  OPERATION_LEASE_RENEW,
  OPERATION_OBSERVE,
  ROLE_DISPATCHER,
  ROLE_SECRETARY,
  ROLE_SUPERVISOR,
  ROLES,
  SQL_INVARIANTS,
  SYNC_LEASE_ACQUIRED,
  SYNC_OBSERVED,
} from "./contract.js";

/** The frozen matrix, beside this module exactly as the source keeps it. */
export const MANIFEST_PATH = fileURLToPath(new URL("./manifest.json", import.meta.url));

/**
 * The adapters a case may route to. Names only -- importing the adapter objects
 * here would put the implementation under test into the durable half
 * (`import-graph.test.ts` forbids exactly that); the objects are resolved in
 * `policy.ts`.
 */
export const ADAPTER_NAMES: ReadonlySet<string> = new Set(["spike", "session"]);

/**
 * Bumped on any semantic change to the matrix. A failure report carries it
 * alongside the contract version (design 4.2, 4.4).
 *
 * The version is stamped into every case entry and mixed into every per-case
 * seed, so a bump also re-rolls the payload bytes and schedule jitter of every
 * existing case. That is the intended meaning of a semantic change to the
 * matrix: evidence recorded against an earlier manifest is not silently
 * re-labelled.
 */
export const MANIFEST_VERSION = 3;

/**
 * A fixed constant, not a wall-clock reading: the injected clock's base
 * (design 7).
 */
export const CLOCK_BASE_MS = 1_700_000_000_000;

/** Lease geometry the boundary-relative skew magnitudes are resolved against. */
export const TTL_MS = 30_000;

/**
 * The harness engineering budgets (design 9). These are **not** acceptance
 * thresholds -- they are enforced CI budgets, revisable by an ordinary reviewed
 * diff, and reading one *as* gate evidence would be a ruling.
 */
export const PROFILES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  fast: {
    runs_on: "every PR push, Linux job only (plus the portable lane everywhere)",
    max_cases: 25,
    per_case_timeout_s: 15,
    combination_case_timeout_s: 15,
    suite_timeout_s: 240,
    barrier_timeout_s: 10,
  },
  full: {
    runs_on: "nightly and gate runs (I-11/I-13/I-15), Linux conformance lane",
    max_cases: 200,
    per_case_timeout_s: 30,
    combination_case_timeout_s: 60,
    suite_timeout_s: 1500,
    barrier_timeout_s: 20,
  },
});

/**
 * The two collapse rules ACCEPTANCE.md section 2 names without choosing between
 * them (Q-0002). The matrix must cover both; this file expresses no preference.
 */
export const COLLAPSE_RULES = ["increment-in-place", "open-linked"] as const;

/** The faults whose subject is the incident packet rather than the delivery. */
export const INCIDENT_FAULTS = ["incident-repeat", "incident-replay"] as const;

/**
 * Recorded rather than left implicit (design 5): scale is controlled by policy,
 * not by product, and anything pruned is listed.
 */
export const PRUNING_RULE =
  "Aligned combination cases cover the multi-role subsets against a curated " +
  "set of (operation, checkpoint) pairs -- the delivery loop's windows where " +
  "roles genuinely interact -- and not the full cross-product. Pruned " +
  "deliberately: (a) the 7-subset x 4-checkpoint x 7-operation product, of " +
  "which only the pairs listed here are kept; (b) single-role sigkill cases " +
  "on operations other than the three named non-attempt seeds; (c) staggered " +
  "sequences beyond the two the acceptance surface cares most about. I-11 " +
  "extends this set deliberately, never by product.";

/** A manifest case, as a mutable record while it is being built. */
type CaseEntry = Record<string, unknown>;

interface CaseOptions {
  targets: readonly string[];
  operation: string;
  checkpoint: string;
  fault: string;
  variant?: string | null;
  lane: string;
  profiles: readonly string[];
  arms: Readonly<Record<string, readonly string[]>>;
  barrier?: string;
  killOrder?: readonly string[] | null;
  restartOrder?: readonly string[] | null;
  expected: {
    queries?: readonly string[];
    destination?: readonly string[];
    recovery_owner?: string | null;
  };
  messages?: number;
  behaviours?: readonly string[];
  claimant?: Readonly<Record<string, unknown>> | null;
  skew?: Readonly<Record<string, unknown>> | null;
  releaseAfterBarrier?: boolean;
  restartAfter?: boolean;
  staggered?: readonly Readonly<Record<string, unknown>>[] | null;
  incidentParams?: Readonly<Record<string, unknown>> | null;
  observation?: { mode: string; escalate_on?: readonly string[] } | null;
  unavailableAttempts?: number | null;
  adapter?: string;
}

/**
 * One manifest entry. Every field a case needs that the id does not carry.
 *
 * `case_id + manifest_version` denotes exactly one fully-specified case, which
 * is what the re-run and failure-report contracts rely on (design 4.1).
 */
function makeCase(options: CaseOptions): CaseEntry {
  const variant = options.variant ?? null;
  const segments = [
    options.targets.join("+"),
    options.operation,
    options.checkpoint,
    options.fault,
  ];
  if (variant) {
    segments.push(variant);
  }
  const caseId = segments.join("__");
  const killOrder = options.killOrder ?? options.targets;
  const arms: Record<string, string[]> = {};
  for (const [role, anchors] of Object.entries(options.arms)) {
    arms[role] = [...anchors];
  }
  return {
    case_id: caseId,
    targets: [...options.targets],
    operation: options.operation,
    checkpoint: options.checkpoint,
    fault: options.fault,
    variant,
    lane: options.lane,
    profiles: [...options.profiles],
    barrier: options.barrier ?? BARRIER_ALIGNED,
    arms,
    kill_order: [...killOrder],
    // Design section 5: "restart_order -- explicit ordered list (default: same
    // as kill_order)". Defaulting to targets instead would silently give a case
    // with an explicit kill order a restart order its author never declared.
    restart_order: [...(options.restartOrder ?? killOrder)],
    expected: {
      queries: [...(options.expected.queries ?? [])],
      destination: [...(options.expected.destination ?? [])],
      recovery_owner: options.expected.recovery_owner ?? null,
    },
    messages: options.messages ?? 1,
    behaviours: [...(options.behaviours ?? [])],
    claimant: options.claimant ? cloneJson(options.claimant) : null,
    skew: options.skew ? cloneJson(options.skew) : null,
    release_after_barrier: options.releaseAfterBarrier ?? false,
    restart_after: options.restartAfter ?? true,
    staggered: options.staggered ? options.staggered.map((step) => cloneJson(step)) : null,
    incident_params: options.incidentParams ? cloneJson(options.incidentParams) : null,
    // Normalised to JSON's own types, so the frozen literal and the generator
    // compare equal.
    observation: options.observation
      ? {
          mode: options.observation.mode,
          escalate_on: [...(options.observation.escalate_on ?? [])],
        }
      : null,
    unavailable_attempts: options.unavailableAttempts ?? null,
    // Which adapter's driver executes this case. The harness stays one durable
    // half over N adapters (design 2.2); a case says which seam it runs
    // through, so routing is manifest data rather than a global.
    adapter: options.adapter ?? "spike",
    ttl_ms: TTL_MS,
    clock_base_ms: CLOCK_BASE_MS,
    manifest_version: MANIFEST_VERSION,
  };
}

/**
 * A deep copy through JSON's own types.
 *
 * The source's `_case` normalises tuples to lists on the way in so that the
 * generator's output and the frozen literal compare equal. TypeScript has no
 * tuple/list distinction to normalise, but it does have the same hazard one
 * level down: a nested array shared with the caller would let a later mutation
 * of the generator's input reach a built case. Copying is the same defence the
 * source's `dict(...)`/`list(...)` calls provide.
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const KILL_QUERIES: readonly string[] = [
  contract.INVARIANT_NO_UNOWNED_OUTBOX,
  contract.INVARIANT_RETRY_COUNT_DURABLE,
  contract.INVARIANT_LINEAR_WRITER_HISTORY,
  contract.INVARIANT_NO_PENDING_ACTION,
];
const KILL_DESTINATION: readonly string[] = [
  contract.INVARIANT_ONE_EFFECT_PER_KEY,
  contract.INVARIANT_DELIVERED_IMPLIES_EFFECT,
];
const TAKEOVER_QUERIES: readonly string[] = [
  contract.INVARIANT_LINEAR_WRITER_HISTORY,
  contract.INVARIANT_RECORDED_REFUSALS,
  contract.INVARIANT_LEASE_SINGLE_HOLDER,
];

/**
 * Produce the candidate matrix. The frozen literal is the authority.
 *
 * A test asserts this equals `manifest.json`'s `cases`; the generator is a
 * convenience for producing a diff, never a collection-time enumeration.
 */
export function buildCases(): CaseEntry[] {
  const cases: CaseEntry[] = [];

  // -- kill at each of the four windows, for each role separately ---------
  //
  // Gate item 4 requires all three ACCEPTANCE.md section 2 windows for *each*
  // of the three components, plus the fourth the outbox rows add. Every role
  // reaches all four through its own `attempt`-driven action, which is why the
  // Supervisor and Secretary scripts carry one (design 2.1).
  for (const role of ROLES) {
    for (const checkpoint of CHECKPOINTS) {
      const fast = role === ROLE_DISPATCHER;
      cases.push(
        makeCase({
          targets: [role],
          operation: OPERATION_ATTEMPT,
          checkpoint,
          fault: "sigkill",
          lane: LANE_PORTABLE,
          profiles: fast ? ["fast", "full"] : ["full"],
          arms: { [role]: [`${OPERATION_ATTEMPT}@${checkpoint}:1`] },
          expected: {
            queries: KILL_QUERIES,
            destination: KILL_DESTINATION,
            recovery_owner: role,
          },
        }),
      );
    }
  }

  // -- kill on the operations that are not the delivery loop --------------
  for (const [role, operation, checkpoint] of [
    [ROLE_SUPERVISOR, OPERATION_BIND, CHECKPOINT_BEFORE_DURABLE_WRITE],
    [ROLE_SECRETARY, OPERATION_ENQUEUE, CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT],
    [ROLE_DISPATCHER, OPERATION_LEASE_ACQUIRE, CHECKPOINT_BEFORE_DURABLE_WRITE],
  ] as const) {
    // A kill at the first step of a script leaves nothing durable behind, so it
    // names no recovery owner: what it proves is that a restart from a cold
    // start is clean, not that recovery repaired anything.
    const fromCold =
      operation === contract.ROLE_SCRIPTS[role]?.[0] &&
      checkpoint === CHECKPOINT_BEFORE_DURABLE_WRITE;
    cases.push(
      makeCase({
        targets: [role],
        operation,
        checkpoint,
        fault: "sigkill",
        lane: LANE_LINUX,
        profiles: ["full"],
        arms: { [role]: [`${operation}@${checkpoint}:1`] },
        expected: {
          queries: KILL_QUERIES,
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: fromCold ? null : role,
        },
      }),
    );
  }

  // -- the same checkpoint, a later occurrence ----------------------------
  //
  // A loop passes the same point repeatedly, so the occurrence index is part of
  // the arming and gets its own variant slug (design 4.1).
  cases.push(
    makeCase({
      targets: [ROLE_DISPATCHER],
      operation: OPERATION_ATTEMPT,
      checkpoint: CHECKPOINT_BEFORE_DURABLE_WRITE,
      fault: "sigkill",
      variant: "occ2",
      lane: LANE_LINUX,
      profiles: ["full"],
      arms: {
        [ROLE_DISPATCHER]: [`${OPERATION_ATTEMPT}@${CHECKPOINT_BEFORE_DURABLE_WRITE}:2`],
      },
      messages: 2,
      expected: {
        queries: KILL_QUERIES,
        destination: KILL_DESTINATION,
        recovery_owner: ROLE_DISPATCHER,
      },
    }),
  );

  // -- clock skew, both directions, across the expiry boundary ------------
  //
  // Two supported shapes only (design 7): cross-role skew, where the target is
  // blocked while a *sibling's* offset moves and the sibling acts under its new
  // clock; and same-role skew, observed by the script's *next* operation. A
  // case whose expectation depends on an in-flight call seeing a mid-call skew
  // is invalid by construction and refused at validation.
  //
  // Backward skew is observed by a *renewal* being refused, so a backward case
  // is only meaningful for a role whose script renews. The Secretary's does not
  // -- it releases instead -- so it carries a forward case.
  for (const [role, direction, profiles] of [
    [ROLE_SUPERVISOR, "backward", ["fast", "full"]],
    [ROLE_DISPATCHER, "forward", ["fast", "full"]],
    [ROLE_DISPATCHER, "backward", ["full"]],
    [ROLE_SECRETARY, "forward", ["full"]],
  ] as const) {
    const forward = direction === "forward";
    cases.push(
      makeCase({
        targets: [role],
        operation: OPERATION_LEASE_ACQUIRE,
        checkpoint: SYNC_LEASE_ACQUIRED,
        fault: forward ? "clock-fwd" : "clock-back",
        lane: LANE_PORTABLE,
        profiles,
        arms: { [role]: [`${OPERATION_LEASE_ACQUIRE}@${SYNC_LEASE_ACQUIRED}:1`] },
        restartAfter: false,
        releaseAfterBarrier: !forward,
        // Forward skew is the cross-role shape: a claimant on the same resource
        // whose clock has crossed the holder's expiry takes the lease over while
        // the holder is frozen at its barrier.
        claimant: forward
          ? { role, holder_suffix: "b", clock: "forward", observation: "sibling" }
          : null,
        // Backward skew is the same-role shape: the offset lands while the
        // process is blocked, and the *next* operation observes it.
        skew: forward ? null : { role, direction: "backward", observation: "next-operation" },
        expected: {
          queries: forward
            ? TAKEOVER_QUERIES
            : [
                contract.INVARIANT_LEASE_SINGLE_HOLDER,
                contract.INVARIANT_LINEAR_WRITER_HISTORY,
                // The backward direction's whole observable: the renewal that
                // would have landed at or before its own acquisition is refused,
                // and the refusal is recorded.
                contract.INVARIANT_RECORDED_REFUSALS,
              ],
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: null,
        },
      }),
    );
  }

  // -- SIGSTOP: pause a holder, let its lease lapse, resume it ------------
  //
  // Anchored at a sync point, never at a bare sleep: the controller sends
  // SIGSTOP only while the holder is provably blocked at that barrier, already
  // holding its lease and between operations. Being stopped, it cannot consume
  // the `continue` until it is resumed, so pause / takeover / return is a
  // deterministic sequence rather than a scheduling accident (design 4.1).
  for (const [role, profiles] of [
    [ROLE_DISPATCHER, ["fast", "full"]],
    [ROLE_SUPERVISOR, ["full"]],
  ] as const) {
    cases.push(
      makeCase({
        targets: [role],
        operation: OPERATION_LEASE_ACQUIRE,
        checkpoint: SYNC_LEASE_ACQUIRED,
        fault: "sigstop-expire",
        lane: LANE_LINUX,
        profiles,
        arms: { [role]: [`${OPERATION_LEASE_ACQUIRE}@${SYNC_LEASE_ACQUIRED}:1`] },
        restartAfter: false,
        claimant: { role, holder_suffix: "b", clock: "forward", observation: "sibling" },
        expected: {
          queries: TAKEOVER_QUERIES,
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: null,
        },
      }),
    );
  }

  // -- delivery-surface faults --------------------------------------------
  //
  // Anchored like every other fault, but the fault is at the delivery surface
  // rather than at the process: the barrier is a pass-through here, used to pin
  // the moment rather than to kill.
  for (const [role, checkpoint, fault, behaviour, messages] of [
    [ROLE_DISPATCHER, CHECKPOINT_BEFORE_DURABLE_WRITE, "drop-delivery", "drop-delivery", 1],
    [ROLE_SECRETARY, CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, "dup-delivery", "dup-delivery", 2],
    [ROLE_SUPERVISOR, CHECKPOINT_DELIVERED_BEFORE_ACK, "lost-ack", "lost-ack", 1],
  ] as const) {
    cases.push(
      makeCase({
        targets: [role],
        operation: OPERATION_ATTEMPT,
        checkpoint,
        fault,
        lane: LANE_PORTABLE,
        profiles: ["fast", "full"],
        arms: { [role]: [`${OPERATION_ATTEMPT}@${checkpoint}:1`] },
        messages,
        behaviours: [behaviour],
        releaseAfterBarrier: true,
        expected: {
          queries: [
            contract.INVARIANT_NO_UNOWNED_OUTBOX,
            contract.INVARIANT_RETRY_COUNT_DURABLE,
            contract.INVARIANT_SINGLE_ACKED_STATE,
          ],
          destination: KILL_DESTINATION,
          recovery_owner: role,
        },
        // Q-0002 (incident collapse semantics) and Q-0003 (reconcile interval)
        // stay open: the schema carries the parameters and nothing here fixes a
        // value (design 10).
        incidentParams: { collapse: null, reconcile_interval_ms: null },
      }),
    );
  }

  // -- staggered kills -----------------------------------------------------
  //
  // Not barrier-simultaneous: A is killed at its checkpoint, B keeps operating
  // against the survivor state, then B is killed at a later armed checkpoint.
  // Strictly enumerated, each naming its full sequence (design 5).
  cases.push(
    makeCase({
      targets: [ROLE_DISPATCHER, ROLE_SECRETARY],
      operation: OPERATION_ATTEMPT,
      checkpoint: CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
      fault: "staggered-sigkill",
      variant: "killorder-ds",
      lane: LANE_LINUX,
      profiles: ["full"],
      barrier: BARRIER_STAGGERED,
      arms: {
        [ROLE_DISPATCHER]: [`${OPERATION_ATTEMPT}@${CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD}:1`],
        [ROLE_SECRETARY]: [`${OPERATION_ACK}@${CHECKPOINT_BEFORE_DURABLE_WRITE}:1`],
      },
      killOrder: [ROLE_DISPATCHER, ROLE_SECRETARY],
      restartOrder: [ROLE_DISPATCHER, ROLE_SECRETARY],
      staggered: [
        { wait: ROLE_DISPATCHER, kill: ROLE_DISPATCHER },
        { wait: ROLE_SECRETARY, kill: ROLE_SECRETARY },
      ],
      expected: {
        queries: KILL_QUERIES,
        destination: KILL_DESTINATION,
        recovery_owner: ROLE_SECRETARY,
      },
    }),
  );
  cases.push(
    makeCase({
      targets: [ROLE_SUPERVISOR, ROLE_DISPATCHER],
      operation: OPERATION_LEASE_ACQUIRE,
      checkpoint: CHECKPOINT_BEFORE_DURABLE_WRITE,
      fault: "staggered-sigkill",
      variant: "killorder-sd",
      lane: LANE_LINUX,
      profiles: ["full"],
      barrier: BARRIER_STAGGERED,
      arms: {
        [ROLE_SUPERVISOR]: [`${OPERATION_LEASE_ACQUIRE}@${CHECKPOINT_BEFORE_DURABLE_WRITE}:1`],
        [ROLE_DISPATCHER]: [`${OPERATION_ENQUEUE}@${CHECKPOINT_BEFORE_DURABLE_WRITE}:1`],
      },
      killOrder: [ROLE_SUPERVISOR, ROLE_DISPATCHER],
      restartOrder: [ROLE_SUPERVISOR, ROLE_DISPATCHER],
      staggered: [
        { wait: ROLE_SUPERVISOR, kill: ROLE_SUPERVISOR },
        { wait: ROLE_DISPATCHER, kill: ROLE_DISPATCHER },
      ],
      expected: {
        queries: KILL_QUERIES,
        destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
        recovery_owner: ROLE_DISPATCHER,
      },
    }),
  );

  // =====================================================================
  // The rest of the ACCEPTANCE.md section 2 table.
  //
  // Everything above is the seed set -- one case per fault kind, per
  // checkpoint, per lane, plus the combination seeds. Everything below closes
  // the gap between that set and the six-row table, and each block names the
  // row and the injected phrase it discharges so the table can be checked
  // against this file without opening the manifest.
  // =====================================================================

  // -- Lease row: "kill the lease holder without release" -----------------
  //
  // The holder dies mid-script without ever releasing, a claimant whose clock
  // has crossed the expiry takes the resource over, and the restarted holder
  // comes back to find the lease gone. It is refused at `acquire` and the
  // refusal is recorded -- which is the observable this row asks for, obtained
  // at the point a SIGKILLed process can actually be refused. (A killed process
  // keeps no epoch in memory, so it cannot present a stale token the way the
  // SIGSTOP cases' holder does; that half of the row is theirs.)
  for (const [role, operation, checkpoint, profiles] of [
    [ROLE_DISPATCHER, OPERATION_LEASE_RENEW, CHECKPOINT_BEFORE_DURABLE_WRITE, ["fast", "full"]],
    [ROLE_SUPERVISOR, OPERATION_LEASE_RENEW, CHECKPOINT_BEFORE_DURABLE_WRITE, ["full"]],
  ] as const) {
    cases.push(
      makeCase({
        targets: [role],
        operation,
        checkpoint,
        fault: "sigkill-expire",
        lane: LANE_LINUX,
        profiles,
        arms: { [role]: [`${operation}@${checkpoint}:1`] },
        claimant: { role, holder_suffix: "b", clock: "forward", observation: "sibling" },
        expected: {
          queries: TAKEOVER_QUERIES,
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: role,
        },
      }),
    );
  }

  // -- Single-writer row: "two writers race for the same state item" ------
  //
  // They cannot both be live writers, and that is the finding rather than a
  // limitation: `acquire` only replaces a lapsed row, so the second claimant is
  // refused at the resource boundary. "A stale writer is rejected, not merged"
  // is observed exactly there. The incumbent is held at a barrier for the whole
  // race so the racer provably meets a *live* lease.
  for (const [role, profiles] of [
    [ROLE_DISPATCHER, ["fast", "full"]],
    [ROLE_SECRETARY, ["full"]],
  ] as const) {
    cases.push(
      makeCase({
        targets: [role],
        operation: OPERATION_LEASE_ACQUIRE,
        checkpoint: SYNC_LEASE_ACQUIRED,
        fault: "writer-race",
        lane: LANE_LINUX,
        profiles,
        arms: { [role]: [`${OPERATION_LEASE_ACQUIRE}@${SYNC_LEASE_ACQUIRED}:1`] },
        restartAfter: false,
        claimant: {
          role,
          holder_suffix: "race",
          clock: "forward",
          observation: "sibling",
          // Refused at acquire *and then carrying on* with a token the lease row
          // rejects. Without this the racer contributes no write at all, and
          // section 2's "the state item's history is a linear sequence with no
          // interleaving from the rejected writer" would be true of every run --
          // including a run in which atomic fencing had stopped working.
          behaviours: ["stale-writer"],
        },
        expected: {
          queries: [
            contract.INVARIANT_LINEAR_WRITER_HISTORY,
            contract.INVARIANT_RECORDED_REFUSALS,
            contract.INVARIANT_LEASE_SINGLE_HOLDER,
          ],
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: null,
        },
      }),
    );
  }

  // -- Single-writer row: "a write is attempted concurrently from a resumed
  //    process and its replacement" ---------------------------------------
  //
  // Same mechanic as the lease row above, anchored mid-write instead of at the
  // lease boundary: the resumed process is the restarted generation and the
  // replacement is the claimant that took the resource over while it was gone.
  cases.push(
    makeCase({
      targets: [ROLE_DISPATCHER],
      operation: OPERATION_ENQUEUE,
      checkpoint: CHECKPOINT_BEFORE_DURABLE_WRITE,
      fault: "resumed-writer-race",
      lane: LANE_LINUX,
      profiles: ["fast", "full"],
      arms: {
        [ROLE_DISPATCHER]: [`${OPERATION_ENQUEUE}@${CHECKPOINT_BEFORE_DURABLE_WRITE}:1`],
      },
      // The *resumed* process is the stale writer here: it comes back with no
      // epoch, is refused at acquire, and carries on believing it holds the
      // lease -- which is what makes its writes race the replacement's rather
      // than simply not happening. Inert in the first generation, which acquires
      // cleanly, and inert for the replacement, which is never refused.
      behaviours: ["stale-writer"],
      claimant: {
        role: ROLE_DISPATCHER,
        holder_suffix: "b",
        clock: "forward",
        observation: "sibling",
        // The replacement is held here, still alive and still holding, while the
        // resumed process comes back and writes. "A write is attempted
        // concurrently from a resumed process and its replacement" needs both to
        // exist at once; a replacement that had already exited would leave the
        // resumed process racing a lease row rather than a writer.
        arms: [`${OPERATION_ATTEMPT}@${CHECKPOINT_DELIVERED_BEFORE_ACK}:1`],
      },
      expected: {
        queries: TAKEOVER_QUERIES,
        destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
        recovery_owner: ROLE_DISPATCHER,
      },
    }),
  );

  // -- Outbox-resend row: "hold the recipient unavailable across several
  //    retry attempts" ---------------------------------------------------
  //
  // The invariant this row names is that the retry count is "monotonically
  // increasing, restart-surviving", so the case has to contain a restart -- a
  // run without one could not observe the surviving half at all. The refusal
  // budget lives in the destination's own attempt log, so it keeps counting
  // across the kill instead of starting again.
  for (const [role, profiles] of [
    [ROLE_DISPATCHER, ["fast", "full"]],
    [ROLE_SECRETARY, ["full"]],
  ] as const) {
    cases.push(
      makeCase({
        targets: [role],
        operation: OPERATION_ATTEMPT,
        checkpoint: CHECKPOINT_DELIVERED_BEFORE_ACK,
        fault: "recipient-unavailable",
        lane: LANE_LINUX,
        profiles,
        arms: { [role]: [`${OPERATION_ATTEMPT}@${CHECKPOINT_DELIVERED_BEFORE_ACK}:1`] },
        behaviours: ["recipient-unavailable"],
        unavailableAttempts: 3,
        expected: {
          queries: [
            contract.INVARIANT_NO_UNOWNED_OUTBOX,
            contract.INVARIANT_RETRY_COUNT_DURABLE,
            contract.INVARIANT_SINGLE_ACKED_STATE,
            contract.INVARIANT_NO_PENDING_ACTION,
          ],
          destination: KILL_DESTINATION,
          recovery_owner: role,
        },
      }),
    );
  }

  // -- Ack row: "duplicate the ack", "ack an already-acked message",
  //    "deliver the ack after the sender has restarted" -------------------
  //
  // All three used to happen in every case and therefore in no case: the ack
  // step acked twice unconditionally, so a regression in either shape had
  // nowhere to show. The repeat is behaviour-driven now and these are the cases
  // that ask for it. The observable is section 2's own: "message identity in
  // SQLite shows exactly one acked state regardless of ack multiplicity; the
  // recipient's effect count is one".
  for (const [role, fault, behaviour, profiles] of [
    [ROLE_DISPATCHER, "dup-ack", "dup-ack", ["fast", "full"]],
    [ROLE_SECRETARY, "dup-ack", "dup-ack", ["full"]],
    [ROLE_SUPERVISOR, "re-ack", "re-ack", ["fast", "full"]],
    [ROLE_DISPATCHER, "re-ack", "re-ack", ["full"]],
  ] as const) {
    cases.push(
      makeCase({
        targets: [role],
        operation: OPERATION_ACK,
        checkpoint: CHECKPOINT_BEFORE_DURABLE_WRITE,
        fault,
        lane: LANE_LINUX,
        profiles,
        arms: { [role]: [`${OPERATION_ACK}@${CHECKPOINT_BEFORE_DURABLE_WRITE}:1`] },
        releaseAfterBarrier: true,
        restartAfter: false,
        expected: {
          queries: [
            contract.INVARIANT_SINGLE_ACKED_STATE,
            contract.INVARIANT_NO_UNOWNED_OUTBOX,
            contract.INVARIANT_NO_PENDING_ACTION,
            // Without this the case would pass whether or not the second ack was
            // ever issued: an idempotent ack leaves the state it found, so
            // "exactly one acked state" reads the same after one ack as after
            // two. The ignored ack's ledger row is the evidence that the
            // injection happened.
            contract.INVARIANT_RECORDED_REFUSALS,
          ],
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: null,
        },
        behaviours: [behaviour],
        incidentParams: { collapse: null, reconcile_interval_ms: null },
      }),
    );
  }

  // The late ack: the sender dies after delivery and before the ack is
  // recorded, and the ack lands only in the generation that comes back. "A lost
  // ack causes a resend (safe), never a lost message", and the late ack changes
  // nothing.
  for (const [role, profiles] of [
    [ROLE_DISPATCHER, ["fast", "full"]],
    [ROLE_SUPERVISOR, ["full"]],
  ] as const) {
    cases.push(
      makeCase({
        targets: [role],
        operation: OPERATION_ATTEMPT,
        checkpoint: CHECKPOINT_DELIVERED_BEFORE_ACK,
        fault: "late-ack",
        lane: LANE_LINUX,
        profiles,
        arms: { [role]: [`${OPERATION_ATTEMPT}@${CHECKPOINT_DELIVERED_BEFORE_ACK}:1`] },
        expected: {
          queries: [
            contract.INVARIANT_NO_UNOWNED_OUTBOX,
            contract.INVARIANT_SINGLE_ACKED_STATE,
            contract.INVARIANT_RETRY_COUNT_DURABLE,
            contract.INVARIANT_NO_PENDING_ACTION,
          ],
          destination: KILL_DESTINATION,
          recovery_owner: role,
        },
      }),
    );
  }

  // -- Dedup row: "raise the same incident condition repeatedly within a
  //    window", "replay a persisted incident packet" ---------------------
  //
  // This is the block Q-0002 governs, and the shape is dictated by what section
  // 2 asks for rather than by what would be convenient: "tests must parameterise
  // both rather than hard-code either". So every case names its collapse rule
  // and its re-notification window, the driver implements both rules and is told
  // which to apply, and the matrix-level check refuses a matrix that has drifted
  // onto one rule or one window. Nothing here decides Q-0002; the matrix covers
  // it.
  //
  // The window is made to *do* something, too. A parameter that is carried but
  // never changes an outcome is indistinguishable from a hard-coded one, so one
  // case declares a window its own raises fall outside of and expects no
  // collapse at all.
  //
  // `expect_collapse` is declared rather than derived. Deriving it would mean
  // comparing the window against this harness's step interval inside the
  // assertion, which bakes an implementation detail of the driver into the thing
  // that is supposed to be checking the driver.
  for (const [fault, collapse, windowMs, expectCollapse, profiles] of [
    ["incident-repeat", "increment-in-place", 5_000, true, ["fast", "full"]],
    ["incident-repeat", "open-linked", 60_000, true, ["full"]],
    // The window is too small for the second raise to fall inside it, so the
    // repeat is not a repeat *within a window* and nothing is collapsed.
    ["incident-repeat", "open-linked", 10, false, ["full"]],
    ["incident-replay", "increment-in-place", 60_000, true, ["fast", "full"]],
    ["incident-replay", "open-linked", 5_000, true, ["full"]],
  ] as const) {
    const replay = fault === "incident-replay";
    const variant = `${collapse}-${expectCollapse ? "in" : "out"}`;
    cases.push(
      makeCase({
        targets: [ROLE_SUPERVISOR],
        operation: OPERATION_OBSERVE,
        checkpoint: SYNC_OBSERVED,
        fault,
        variant,
        lane: LANE_LINUX,
        profiles,
        arms: { [ROLE_SUPERVISOR]: [`${OPERATION_OBSERVE}@${SYNC_OBSERVED}:1`] },
        releaseAfterBarrier: true,
        restartAfter: false,
        behaviours: replay ? ["incident-replay"] : [],
        observation: { mode: contract.OBSERVATION_SILENT, escalate_on: [] },
        incidentParams: {
          // Case data, never composed by the driver: Q-0002 asks what composes
          // an incident dedup key, and the two spellings below differ in
          // composition on purpose so no case can be relying on one shape.
          dedup_key: expectCollapse
            ? `observe/${fault}/${collapse}`
            : `${fault}:${collapse}:outside`,
          repeats: 2,
          collapse,
          renotify_window_ms: windowMs,
          expect_collapse: expectCollapse,
          // Q-0003, not Q-0002. Named so it is visibly unset rather than absent,
          // and refused a value by validation.
          reconcile_interval_ms: null,
        },
        expected: {
          queries: [
            contract.INVARIANT_INCIDENT_COLLAPSE,
            contract.INVARIANT_UNRESOLVED_INCIDENTS,
            contract.INVARIANT_OBSERVATION_CLASSIFIED,
            contract.INVARIANT_NO_ANOMALY_ESCALATION,
          ],
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: null,
        },
      }),
    );
  }

  // -- Observation-outage row (interlock D-0006) --------------------------
  //
  // "Make the observation path fail or return nothing while the worker is
  // genuinely healthy." Two distinct injections, because the whole of D-0006 is
  // that they are distinct: a read that *fails* is `OBSERVATION_UNAVAILABLE` and
  // a read that *returns nothing* is `NO_ACTIVITY_EVIDENCE`, and neither is an
  // anomaly.
  //
  // Each case also declares an escalation policy naming the very state the
  // injection produces. That is what makes the second half of the row
  // falsifiable: the driver is *asked* to escalate and must refuse, so
  // `no-anomaly-escalation` counts a row a broken driver would have written
  // rather than a row nothing in the tree can write.
  for (const [mode, lane, profiles] of [
    // The off-Linux add-on has a 20-case budget of its own (design 9) and this
    // fills the last slot deliberately: the read-failure injection is the row's
    // headline, it touches no signal, and D-0006 is a control-plane property
    // worth proving on every OS. The silent-read injection runs on the
    // conformance lane, which is where the gate evidence is read from in any
    // case.
    [contract.OBSERVATION_UNREADABLE, LANE_PORTABLE, ["fast", "full"]],
    [contract.OBSERVATION_SILENT, LANE_LINUX, ["fast", "full"]],
  ] as const) {
    cases.push(
      makeCase({
        targets: [ROLE_SUPERVISOR],
        operation: OPERATION_OBSERVE,
        checkpoint: SYNC_OBSERVED,
        fault: "observation-outage",
        variant: mode,
        lane,
        profiles,
        arms: { [ROLE_SUPERVISOR]: [`${OPERATION_OBSERVE}@${SYNC_OBSERVED}:1`] },
        releaseAfterBarrier: true,
        restartAfter: false,
        observation: {
          mode,
          escalate_on: [contract.OBSERVATION_FACT_STATES[mode] as string],
        },
        expected: {
          queries: [
            contract.INVARIANT_OBSERVATION_CLASSIFIED,
            contract.INVARIANT_NO_ANOMALY_ESCALATION,
            contract.INVARIANT_RECORDED_REFUSALS,
            // The packet is in the row and not in anyone's context (interlock
            // D-0003, D-0007), so it is readable from SQLite alone after the
            // fact -- which is what gate item 4's "work resumes from unresolved
            // incidents" rests on.
            contract.INVARIANT_UNRESOLVED_INCIDENTS,
          ],
          destination: [contract.INVARIANT_ONE_EFFECT_PER_KEY],
          recovery_owner: null,
        },
      }),
    );
  }

  // -- aligned combinations ------------------------------------------------
  for (const targets of [
    [ROLE_SUPERVISOR, ROLE_DISPATCHER],
    [ROLE_DISPATCHER, ROLE_SECRETARY],
    [ROLE_SUPERVISOR, ROLE_SECRETARY],
    [ROLE_SUPERVISOR, ROLE_DISPATCHER, ROLE_SECRETARY],
  ] as const) {
    for (const checkpoint of [
      CHECKPOINT_BEFORE_DURABLE_WRITE,
      CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
    ]) {
      const arms: Record<string, string[]> = {};
      for (const role of targets) {
        arms[role] = [`${OPERATION_ATTEMPT}@${checkpoint}:1`];
      }
      cases.push(
        makeCase({
          targets,
          operation: OPERATION_ATTEMPT,
          checkpoint,
          fault: "sigkill",
          lane: LANE_LINUX,
          profiles: ["full"],
          arms,
          expected: {
            queries: KILL_QUERIES,
            destination: KILL_DESTINATION,
            recovery_owner: targets[targets.length - 1] as string,
          },
        }),
      );
    }
  }

  // -- the session-start crash window, on the real components --------------
  //
  // Gate item 2's four injection points, one case each, routed to the session
  // adapter. Three are checkpoint windows; "after the read-back" is the sync
  // point, because the read-back commit is the last write of the walk. The
  // destination observables are the ones only a process count and a captured
  // stream can supply -- ACCEPTANCE.md section 2: a spawned process is an
  // external effect SQLite alone cannot certify.
  for (const anchor of [
    CHECKPOINT_BEFORE_DURABLE_WRITE,
    CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
    CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
    contract.SYNC_IDENTITY_READBACK_COMMITTED,
  ]) {
    cases.push(
      makeCase({
        targets: [ROLE_SUPERVISOR],
        operation: contract.OPERATION_SESSION_START,
        checkpoint: anchor,
        fault: "sigkill",
        lane: LANE_LINUX,
        profiles: ["full"],
        arms: {
          [ROLE_SUPERVISOR]: [`${contract.OPERATION_SESSION_START}@${anchor}:1`],
        },
        expected: {
          queries: [contract.INVARIANT_ONE_BINDING_PER_RUN],
          destination: [
            contract.INVARIANT_LIVE_PROCESSES_PER_SESSION,
            contract.INVARIANT_TRANSCRIPT_SINGLE_WRITER,
          ],
          recovery_owner: ROLE_SUPERVISOR,
        },
        adapter: "session",
      }),
    );
  }

  return cases;
}

export function buildManifest(): Record<string, unknown> {
  return {
    manifest_version: MANIFEST_VERSION,
    contract_version: contract.FAULT_RUNNER_CONTRACT_VERSION,
    clock_base_ms: CLOCK_BASE_MS,
    ttl_ms: TTL_MS,
    clock_guard_ms: contract.CLOCK_GUARD_MS,
    pruning_rule: PRUNING_RULE,
    profiles: Object.fromEntries(
      Object.entries(PROFILES).map(([name, values]) => [name, { ...values }]),
    ),
    cases: buildCases(),
  };
}

/** Read the frozen matrix. Validation runs at collection, never at run. */
export function loadManifest(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
  validateManifest(manifest);
  return manifest;
}

/**
 * The cases a run of `profile` on `lanes` executes.
 *
 * **Ported dead code, deliberately.** `manifest.py` exports `profile_cases` in its
 * `__all__` and nothing in interlock calls it: the collection path goes through
 * `conftest.profile_selected_cases`, which deliberately does NOT filter by lane
 * (design 8.1 wants the item collected everywhere and skipped with its lane named).
 * Carried across because a parity port reproduces its source's public surface
 * rather than curating it.
 *
 * The `@parityonly` tag excludes it from knip's dead-export analysis (`knip.json`).
 * That exclusion is deliberately narrow: it marks THIS export as unused-in-the-
 * source-too, rather than switching the check off, so a genuinely dead export
 * added later still turns the gate red.
 *
 * @parityonly
 */
export function profileCases(
  manifest: Record<string, unknown>,
  options: { profile: string; lanes: readonly string[] },
): CaseEntry[] {
  const profiles = manifest["profiles"] as Record<string, unknown>;
  if (!(options.profile in profiles)) {
    throw new ContractViolation(`${JSON.stringify(options.profile)} is not a manifest profile`);
  }
  return (manifest["cases"] as CaseEntry[]).filter(
    (entry) =>
      (entry["profiles"] as string[]).includes(options.profile) &&
      options.lanes.includes(entry["lane"] as string),
  );
}

// ---------------------------------------------------------------------------
// validation -- refused at collection, never as a timeout in CI
// ---------------------------------------------------------------------------

/** Every rule design section 4/5/6/7 states as manifest-enforced. */
export function validateCase(entry: CaseEntry): void {
  const caseId = (entry["case_id"] as string | undefined) ?? "<unnamed>";

  const targets = entry["targets"] as string[];
  if (targets.length === 0) {
    throw new ContractViolation(`${caseId}: a case names at least one target`);
  }
  if (targets.some((role) => !ROLES.includes(role as (typeof ROLES)[number]))) {
    throw new ContractViolation(
      `${caseId}: ${JSON.stringify(targets)} is not a subset of ${JSON.stringify(ROLES)}`,
    );
  }
  const canonical = ROLES.filter((role) => targets.includes(role));
  if (targets.join(",") !== canonical.join(",")) {
    throw new ContractViolation(
      `${caseId}: targets are written in the contract's role order so a subset has one ` +
        "canonical spelling",
    );
  }

  if (!contract.LANES.includes(entry["lane"] as (typeof contract.LANES)[number])) {
    throw new ContractViolation(`${caseId}: ${JSON.stringify(entry["lane"])} is not a lane`);
  }
  if (!ADAPTER_NAMES.has(entry["adapter"] as string)) {
    throw new ContractViolation(
      `${caseId}: ${JSON.stringify(entry["adapter"])} is not a registered adapter ` +
        `(${JSON.stringify([...ADAPTER_NAMES].sort())}); an unknown adapter must refuse at ` +
        "collection, never surface as a spawn failure",
    );
  }
  if (!contract.FAULT_KINDS.includes(entry["fault"] as (typeof contract.FAULT_KINDS)[number])) {
    throw new ContractViolation(`${caseId}: ${JSON.stringify(entry["fault"])} is not a fault kind`);
  }
  if (
    !contract.BARRIER_MODES.includes(entry["barrier"] as (typeof contract.BARRIER_MODES)[number])
  ) {
    throw new ContractViolation(
      `${caseId}: ${JSON.stringify(entry["barrier"])} is not a barrier mode`,
    );
  }

  // SIGSTOP is Linux-only, and what does not run on an OS is enumerable
  // (design 8.1) -- so the lane is checked against the fault, not inferred.
  if (entry["fault"] === "sigstop-expire" && entry["lane"] !== LANE_LINUX) {
    throw new ContractViolation(`${caseId}: SIGSTOP cases are Linux-lane only (design 8.1)`);
  }
  if (entry["fault"] === "staggered-sigkill" && entry["barrier"] !== BARRIER_STAGGERED) {
    throw new ContractViolation(`${caseId}: a staggered kill declares staggered mode`);
  }
  if (entry["barrier"] === BARRIER_STAGGERED && !entry["staggered"]) {
    // The controller dispatches on the barrier mode, so a case that declares
    // staggered without naming its sequence would have no sequence to run.
    throw new ContractViolation(`${caseId}: staggered mode names its full sequence (design 5)`);
  }
  if (entry["staggered"] && entry["barrier"] !== BARRIER_STAGGERED) {
    throw new ContractViolation(`${caseId}: a staggered sequence is only run in staggered mode`);
  }

  const arms = entry["arms"] as Record<string, string[]>;
  for (const [role, anchors] of Object.entries(arms)) {
    if (!ROLES.includes(role as (typeof ROLES)[number])) {
      throw new ContractViolation(`${caseId}: ${JSON.stringify(role)} is not a role`);
    }
    if (anchors.length === 0) {
      throw new ContractViolation(
        `${caseId}: ${role} is armed with nothing; every fault is anchored (design 4.1)`,
      );
    }
    for (const wire of anchors) {
      const armed = ArmedAnchor.parse(wire);
      if (contract.SYNC_POINTS.includes(armed.anchor as (typeof contract.SYNC_POINTS)[number])) {
        continue;
      }
      const operation = armed.operation;
      if (operation === null) {
        throw new ContractViolation(
          `${caseId}: a checkpoint arming names its operation, so the applicability matrix ` +
            "can be checked",
        );
      }
      const applicable = contract.CHECKPOINT_APPLICABILITY[operation];
      if (applicable === undefined || !applicable.includes(armed.anchor)) {
        throw new ContractViolation(
          `${caseId}: ${operation} has no ${armed.anchor} window (it has ` +
            `${JSON.stringify(applicable)}); a barrier that cannot be reached is a manifest ` +
            "error, not a CI timeout",
        );
      }
    }
  }

  const armedRoles = Object.keys(arms).sort();
  if (armedRoles.join(",") !== [...targets].sort().join(",") && entry["claimant"] === null) {
    throw new ContractViolation(`${caseId}: every target is armed and only targets are`);
  }
  if ((entry["kill_order"] as string[]).some((role) => !targets.includes(role))) {
    throw new ContractViolation(`${caseId}: kill_order names a non-target`);
  }
  const restartOrder = entry["restart_order"];
  if (
    restartOrder !== "concurrent" &&
    (restartOrder as string[]).some((role) => !targets.includes(role))
  ) {
    throw new ContractViolation(`${caseId}: restart_order names a non-target`);
  }

  const expected = entry["expected"] as {
    queries: string[];
    destination: string[];
    recovery_owner: string | null;
  };
  for (const name of expected.queries) {
    if (!SQL_INVARIANTS.includes(name)) {
      throw new ContractViolation(`${caseId}: ${JSON.stringify(name)} is not a SQL invariant`);
    }
  }
  for (const name of expected.destination) {
    if (!DESTINATION_INVARIANTS.includes(name)) {
      throw new ContractViolation(
        `${caseId}: ${JSON.stringify(name)} is not a destination invariant`,
      );
    }
  }
  if (expected.queries.length === 0 && expected.destination.length === 0) {
    throw new ContractViolation(`${caseId}: a case asserts something`);
  }

  // ACCEPTANCE.md section 2: a case that asserts exactly-once for an external
  // effect using only our own rows does not pass. So a case anchored inside or
  // after an effect window must name a destination assertion.
  const anchoredInEffectWindow =
    EFFECT_BEARING_CHECKPOINTS.includes(entry["checkpoint"] as string) ||
    Object.values(arms).some((anchors) =>
      anchors.some((wire) => EFFECT_BEARING_CHECKPOINTS.includes(ArmedAnchor.parse(wire).anchor)),
    );
  if (anchoredInEffectWindow && expected.destination.length === 0) {
    throw new ContractViolation(
      `${caseId}: armed inside or after an effect window, where SQLite alone cannot tell a ` +
        "completed effect from one that never started -- name a destination assertion. The " +
        "check reads the armed anchors and not only the case-id classification, because in a " +
        "combination case a secondary role can be the one armed in the effect window",
    );
  }

  if (
    expected.recovery_owner !== null &&
    !ROLES.includes(expected.recovery_owner as (typeof ROLES)[number])
  ) {
    throw new ContractViolation(
      `${caseId}: ${JSON.stringify(expected.recovery_owner)} is not a role`,
    );
  }
  // A kill at the very first durable write of a role's script leaves nothing
  // behind: no lease row, no message, no action. Such a case is worth having --
  // it proves a restart from a cold start is clean -- but it has no recovery to
  // name, and naming one would be an assertion satisfied by an empty set. So the
  // rule runs both ways.
  const nothingWasWritten =
    targets.length === 1 &&
    entry["checkpoint"] === contract.CHECKPOINT_BEFORE_DURABLE_WRITE &&
    entry["operation"] === contract.ROLE_SCRIPTS[targets[0] as string]?.[0];
  if (entry["restart_after"] && expected.recovery_owner === null && !nothingWasWritten) {
    throw new ContractViolation(
      `${caseId}: a case that restarts names the role whose recovery it asserts; 'somebody ` +
        "recovered it' is not an assertion (design 5)",
    );
  }
  if (entry["restart_after"] && expected.recovery_owner !== null && nothingWasWritten) {
    throw new ContractViolation(
      `${caseId}: the kill lands before this role's first durable write, so the restart has ` +
        "nothing to recover and the case may not name a recovery owner",
    );
  }

  const skew = entry["skew"] as Record<string, unknown> | null;
  if (skew !== null && skew["observation"] !== "next-operation") {
    throw new ContractViolation(
      `${caseId}: a same-role skew is observed by the script's next operation; an expectation ` +
        "that depends on an in-flight call seeing a mid-call skew is invalid by construction " +
        "(design 7)",
    );
  }
  const claimant = entry["claimant"] as Record<string, unknown> | null;
  if (claimant !== null && claimant["observation"] !== "sibling") {
    throw new ContractViolation(
      `${caseId}: a cross-role skew is observed by the sibling acting under its new clock ` +
        "(design 7)",
    );
  }

  if (INCIDENT_FAULTS.includes(entry["fault"] as (typeof INCIDENT_FAULTS)[number])) {
    const parameters = entry["incident_params"] as Record<string, unknown> | null;
    if (parameters === null) {
      throw new ContractViolation(`${caseId}: an incident case carries its Q-0002 parameters`);
    }
    // A case carries a value, and the discipline moves up one level -- to
    // `validateIncidentParameterisation`, which refuses a matrix that has
    // quietly settled on one rule or one window. Neither this function nor that
    // one expresses a preference between the rules, and Q-0002 stays open.
    if (!COLLAPSE_RULES.includes(parameters["collapse"] as (typeof COLLAPSE_RULES)[number])) {
      throw new ContractViolation(
        `${caseId}: ${JSON.stringify(parameters["collapse"])} is not one of the collapse rules ` +
          `${JSON.stringify(COLLAPSE_RULES)}; an incident case names the rule it runs under so ` +
          "the matrix can cover both",
      );
    }
    const window = parameters["renotify_window_ms"];
    if (typeof window !== "number" || !Number.isInteger(window) || window <= 0) {
      throw new ContractViolation(
        `${caseId}: the re-notification window is the *other* half of Q-0002 and is stated in ` +
          `absolute time, so a case names a positive value; got ${JSON.stringify(window)}`,
      );
    }
    const repeats = parameters["repeats"];
    if (typeof repeats !== "number" || !Number.isInteger(repeats) || repeats < 2) {
      throw new ContractViolation(
        `${caseId}: 'raise the same condition repeatedly' needs at least two raises`,
      );
    }
    if (typeof parameters["expect_collapse"] !== "boolean") {
      throw new ContractViolation(
        `${caseId}: a case says whether its raises fall inside its own window; deriving it from ` +
          "the window would bake this harness's step interval into the assertion",
      );
    }
    if (!parameters["dedup_key"]) {
      throw new ContractViolation(
        `${caseId}: the dedup key is case data. Q-0002 asks what composes it, and a driver-side ` +
          "formula would answer that by inertia -- exactly as a role-to-resource table would " +
          "answer Q-0001",
      );
    }
    if (!("reconcile_interval_ms" in parameters)) {
      throw new ContractViolation(`${caseId}: incident_params omits 'reconcile_interval_ms'`);
    }
    if (parameters["reconcile_interval_ms"] !== null) {
      throw new ContractViolation(
        `${caseId}: reconcile_interval_ms is Q-0003, not Q-0002, and nothing in this task ` +
          "settles it; leave it unset",
      );
    }
  }

  if (["drop-delivery", "dup-delivery", "lost-ack"].includes(entry["fault"] as string)) {
    if (!entry["release_after_barrier"]) {
      throw new ContractViolation(
        `${caseId}: a delivery-surface fault anchors at a pass-through barrier and declares ` +
          "release_after_barrier",
      );
    }
    const parameters = entry["incident_params"] as Record<string, unknown> | null;
    if (parameters === null) {
      throw new ContractViolation(
        `${caseId}: the dedup row of ACCEPTANCE.md section 2 requires both Q-0002 (collapse ` +
          "semantics) and Q-0003 (reconcile interval) to be parameterised rather than " +
          "hard-coded; carry them as manifest fields, unset",
      );
    }
    for (const key of ["collapse", "reconcile_interval_ms"]) {
      if (!(key in parameters)) {
        throw new ContractViolation(`${caseId}: incident_params omits ${JSON.stringify(key)}`);
      }
      if (parameters[key] !== null) {
        throw new ContractViolation(
          `${caseId}: ${JSON.stringify(key)} is fixed to ${JSON.stringify(parameters[key])}; ` +
            "nothing here fixes a value for an open question (design 10)",
        );
      }
    }
  }

  if ((entry["ttl_ms"] as number) <= 0 || (entry["clock_base_ms"] as number) <= 0) {
    throw new ContractViolation(`${caseId}: the lease geometry is positive`);
  }
  for (const profile of entry["profiles"] as string[]) {
    if (!(profile in PROFILES)) {
      throw new ContractViolation(`${caseId}: ${JSON.stringify(profile)} is not a profile`);
    }
  }
}

/**
 * Q-0002 is parameterised by the matrix, not answered by it.
 *
 * Per-case validation lets a case name a rule. This is what stops the matrix as
 * a whole from having quietly picked one: every rule in the vocabulary must
 * appear, and more than one window must appear, so no single value can be
 * load-bearing on a pass. A matrix that drifted onto one rule fails at
 * collection with the drift named, rather than passing and reading as though
 * the question were settled.
 *
 * Q-0003 is a different question and stays out of it: `reconcile_interval_ms`
 * is refused a value by {@link validateCase}.
 */
function validateIncidentParameterisation(manifest: Record<string, unknown>): void {
  const incidentCases = (manifest["cases"] as CaseEntry[]).filter((entry) =>
    INCIDENT_FAULTS.includes(entry["fault"] as (typeof INCIDENT_FAULTS)[number]),
  );
  if (incidentCases.length === 0) {
    throw new ContractViolation(
      "the dedup row of ACCEPTANCE.md section 2 names two injections -- a repeated incident " +
        "condition and a replayed packet -- and the matrix has no case for either",
    );
  }
  const rules = new Set(
    incidentCases.map(
      (entry) => (entry["incident_params"] as Record<string, unknown>)["collapse"] as string,
    ),
  );
  const wantedRules = [...COLLAPSE_RULES].sort().join(",");
  if ([...rules].sort().join(",") !== wantedRules) {
    throw new ContractViolation(
      `the incident cases run under ${JSON.stringify([...rules].sort())}; Q-0002 is open, so ` +
        `the matrix covers every rule in ${JSON.stringify([...COLLAPSE_RULES].sort())} rather ` +
        "than settling on one by omission",
    );
  }
  const windows = new Set(
    incidentCases.map(
      (entry) =>
        (entry["incident_params"] as Record<string, unknown>)["renotify_window_ms"] as number,
    ),
  );
  if (windows.size < 2) {
    throw new ContractViolation(
      `every incident case declares the same re-notification window ` +
        `(${JSON.stringify([...windows].sort())}); one window cannot show that the assertion ` +
        "does not depend on its value, which is what parameterising it means",
    );
  }
  if (
    !incidentCases.some(
      (entry) => (entry["incident_params"] as Record<string, unknown>)["expect_collapse"] === false,
    )
  ) {
    throw new ContractViolation(
      "no incident case declares a window its own raises fall outside of, so the window is " +
        "carried but never does anything -- an inert parameter is indistinguishable from a " +
        "hard-coded one",
    );
  }
}

/** Whole-matrix rules: identity, versions and the profile budgets. */
export function validateManifest(manifest: Record<string, unknown>): void {
  if (manifest["contract_version"] !== contract.FAULT_RUNNER_CONTRACT_VERSION) {
    throw new ContractViolation(
      `the manifest targets fault-runner contract ${manifest["contract_version"]}, this build ` +
        `is ${contract.FAULT_RUNNER_CONTRACT_VERSION}`,
    );
  }

  const seen = new Set<string>();
  for (const entry of manifest["cases"] as CaseEntry[]) {
    const caseId = entry["case_id"] as string;
    if (seen.has(caseId)) {
      // A duplicate fails the run before any case executes, because the case id
      // is the re-run key, the manifest key and the failure-report key all at
      // once (design 4.1).
      throw new ContractViolation(`duplicate case_id ${JSON.stringify(caseId)}`);
    }
    seen.add(caseId);
    validateCase(entry);
  }

  // Growth in the matrix forces an explicit budget diff instead of silent CI
  // creep (design 9).
  for (const [name, profile] of Object.entries(manifest["profiles"] as Record<string, unknown>)) {
    const budget = (profile as Record<string, number>)["max_cases"] as number;
    const count = (manifest["cases"] as CaseEntry[]).filter((entry) =>
      (entry["profiles"] as string[]).includes(name),
    ).length;
    if (count > budget) {
      throw new ContractViolation(
        `profile ${JSON.stringify(name)} holds ${count} cases, over its ${budget}-case budget: ` +
          "raise the budget in an explicit diff or prune the matrix",
      );
    }
  }

  // The off-Linux add-on is its own budget (design 9).
  const portable = (manifest["cases"] as CaseEntry[]).filter(
    (entry) => entry["lane"] === LANE_PORTABLE,
  ).length;
  if (portable > 20) {
    throw new ContractViolation(
      `the portable lane holds ${portable} cases, over its 20-case off-Linux budget`,
    );
  }

  validateIncidentParameterisation(manifest);

  // Coverage the design requires the matrix to seed: one case per fault kind,
  // per checkpoint, per lane.
  const faults = new Set((manifest["cases"] as CaseEntry[]).map((entry) => entry["fault"]));
  const missingFaults = contract.FAULT_KINDS.filter((kind) => !faults.has(kind));
  if (missingFaults.length > 0 || faults.size !== contract.FAULT_KINDS.length) {
    throw new ContractViolation(
      `the seed set misses fault kinds ${JSON.stringify(missingFaults.sort())}`,
    );
  }
  const anchors = new Set((manifest["cases"] as CaseEntry[]).map((entry) => entry["checkpoint"]));
  const missingCheckpoints = CHECKPOINTS.filter((checkpoint) => !anchors.has(checkpoint));
  if (missingCheckpoints.length > 0) {
    throw new ContractViolation(
      `the seed set misses checkpoints ${JSON.stringify(missingCheckpoints.sort())}`,
    );
  }
  const lanes = new Set((manifest["cases"] as CaseEntry[]).map((entry) => entry["lane"]));
  const missingLanes = contract.LANES.filter((lane) => !lanes.has(lane));
  if (missingLanes.length > 0 || lanes.size !== contract.LANES.length) {
    throw new ContractViolation(`the seed set misses lanes ${JSON.stringify(missingLanes.sort())}`);
  }
}
