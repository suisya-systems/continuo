import type { Database as SqliteDatabase } from "better-sqlite3";

import * as leaseModule from "./control_plane/lease.js";
import {
  effectKind,
  fencedInsert,
  fenceEpoch,
  type Lease,
  ProtectedWrite,
  param,
  protectedWrite,
  StaleWriterRefused,
  value,
} from "./control_plane/lease.js";
import * as sessionBinding from "./control_plane/session_binding.js";
import {
  PHASE_IDENTITY_CONFIRMED,
  PHASE_PREPARED,
  PHASE_SPAWNED,
  type SessionBinding,
} from "./control_plane/session_binding.js";
import {
  Failure,
  FailureKind,
  Observation,
  Ok,
  type SessionProvider,
  type SessionReadout,
  StartRequest,
} from "./session/provider.js";

/**
 * Lease-before-spawn orchestration across the crash window (gate item 2).
 *
 * Ported from interlock `src/claude_org_runtime/supervisor/session_orchestrator.py`
 * at `65f36c5`.
 *
 * This module is the Interlock-mediated path issue `#18` is graded on. Under
 * C2 the provider supplies **no exclusion**: the `--session-id` refusal has a
 * measured admission window in which two writers both exited 0 and both wrote
 * (U27), and `--resume` excludes nothing at all (U32). The only exclusion in
 * the system is Interlock's own fencing token, validated atomically as part
 * of each protected write (`ACCEPTANCE.md` section 2, D-0027 part 3) -- and
 * this module is where that token is put *in front of* the process, so the
 * shapes the provider is known to admit never reach a spawn.
 *
 * **D-0801: `start()` and `recover()` are `async`.** The source's five
 * provider verbs are blocking calls the Python interpreter can wait on
 * directly; D-0301 made continuo's `SessionProvider` verbs `Promise`-returning
 * instead, because Node has no synchronous way to wait for a child to exit.
 * Everything in this module that calls a verb -- `start`, `resume`,
 * `readState`, `stop` -- therefore has to be awaited, which makes `start()`
 * and `recover()` themselves `async` and every private helper downstream of a
 * verb call `async` with them. This is the one structural change the port
 * makes to the walk; the fenced-write ordering, the seam placement and the
 * refusal semantics are otherwise the source's, statement for statement.
 *
 * D-0009: this module lives in the supervisor join layer. It imports the S1
 * contract (not the C2 implementation) and the control plane; `session/` is
 * unchanged by it and `control_plane` still imports no session backend.
 */

/**
 * The injection seams of the commit-before-spawn walk, named for the fault
 * harness (issue #18's four points). A `seam` callback passed at construction
 * is invoked with each name as the walk crosses it; the fault driver maps
 * them onto its barrier anchors, and production wiring passes nothing. A seam
 * is a place to *stop*, never a place to decide -- nothing in this module
 * reads anything back from the callback.
 */
export const SEAM_BEFORE_ADMISSION_COMMIT = "before-admission-commit";
export const SEAM_AFTER_ADMISSION_BEFORE_SPAWN = "after-admission-before-spawn";
export const SEAM_AFTER_SPAWN_BEFORE_READBACK_COMMIT = "after-spawn-before-readback-commit";
export const SEAM_AFTER_READBACK_COMMIT = "after-readback-commit";
export const SEAMS: readonly string[] = Object.freeze([
  SEAM_BEFORE_ADMISSION_COMMIT,
  SEAM_AFTER_ADMISSION_BEFORE_SPAWN,
  SEAM_AFTER_SPAWN_BEFORE_READBACK_COMMIT,
  SEAM_AFTER_READBACK_COMMIT,
]);

/** Sentinel distinguishing "not given" (paced default) from an explicit `null`. */
const DEFAULT_WAIT = Symbol("default-wait");

type Wait = (() => void | Promise<void>) | null;

/**
 * Base for this module's own refusals.
 *
 * Lease-layer refusals (`LeaseHeld`, `StaleWriterRefused`, ...) are raised as
 * themselves wherever they already say everything; these types exist for the
 * decisions that are this layer's own.
 */
export class OrchestrationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationRefused";
  }
}

/** The provider verb returned a `Failure`; nothing was admitted twice. */
export class ProviderStartFailed extends OrchestrationRefused {
  readonly failure: Failure;

  constructor(message: string, failure: Failure) {
    super(message);
    this.name = "ProviderStartFailed";
    this.failure = failure;
  }
}

/**
 * The committed identity did not read back within the allowed attempts.
 *
 * The binding stays honestly at `spawned` -- never confirmed on trust -- and
 * the last thing the provider said rides along for the record.
 */
export class IdentityUnconfirmed extends OrchestrationRefused {
  readonly lastAnswer: unknown;

  constructor(message: string, lastAnswer: unknown) {
    super(message);
    this.name = "IdentityUnconfirmed";
    this.lastAnswer = lastAnswer;
  }
}

/**
 * A claimant lost its lease inside the spawn-admission critical section.
 *
 * A fenced write was refused (`StaleWriterRefused`), so the process this
 * claimant had created was ordered stopped immediately. The refusal is
 * already durable (an `action` row, written by the lease module); this
 * exception carries the stop verdict and the measured latency, and it never
 * overstates them: `stopConfirmed` is the provider's own answer, and a stop
 * the provider could not confirm (S1's `stop` contract: acceptance is not
 * evidence the session stopped) is surfaced as exactly that rather than
 * reported as a termination that happened.
 */
export class LoserTerminated extends OrchestrationRefused {
  readonly sessionId: string;
  readonly refusal: StaleWriterRefused;
  readonly detectedAtMs: number;
  readonly terminatedAtMs: number;
  readonly stopAnswer: unknown;
  readonly stopConfirmed: boolean;
  /**
   * `false` when the loser deliberately did not fire: the run's binding was
   * already confirmed by the takeover writer, so a session-level stop could
   * have killed the *winner's* adopted worker. The loser's possibly-rogue
   * process is then an unresolved hazard this exception surfaces, never a
   * termination that is claimed.
   */
  readonly stopAttempted: boolean;

  constructor(
    message: string,
    options: {
      readonly sessionId: string;
      readonly refusal: StaleWriterRefused;
      readonly detectedAtMs: number;
      readonly terminatedAtMs: number;
      readonly stopAnswer: unknown;
      readonly stopConfirmed: boolean;
      readonly stopAttempted?: boolean;
    },
  ) {
    super(message);
    this.name = "LoserTerminated";
    this.sessionId = options.sessionId;
    this.refusal = options.refusal;
    this.detectedAtMs = options.detectedAtMs;
    this.terminatedAtMs = options.terminatedAtMs;
    this.stopAnswer = options.stopAnswer;
    this.stopConfirmed = options.stopConfirmed;
    this.stopAttempted = options.stopAttempted ?? true;
  }

  /** Detection to the provider's stop answer -- not a claim beyond it. */
  get terminationLatencyMs(): number {
    return this.terminatedAtMs - this.detectedAtMs;
  }
}

/** What one mediated start/recovery actually did, read back durably. */
export class OrchestrationOutcome {
  readonly sessionId: string;
  /**
   * `started` (fresh admission), `respawned` (recovery re-ran a spawn that
   * never happened), `resumed` (recovery went through the provider's resume
   * -- which itself adopts a surviving process rather than spawning).
   */
  readonly path: string;
  readonly binding: SessionBinding;
  readonly readout: SessionReadout;

  constructor(fields: {
    readonly sessionId: string;
    readonly path: string;
    readonly binding: SessionBinding;
    readonly readout: SessionReadout;
  }) {
    this.sessionId = fields.sessionId;
    this.path = fields.path;
    this.binding = fields.binding;
    this.readout = fields.readout;
    Object.freeze(this);
  }
}

/**
 * Is this readout a *positive* identity read-back?
 *
 * Conservative on purpose. The C2 provider withholds `OBSERVED` until an
 * event named the committed identity -- with one exception: a child that
 * exited without emitting anything is reported as its process disposition
 * (`exited-N`), which observed an exit, not an identity. Confirming on that
 * word would put "the process died" into SQLite as "the identity read back",
 * so it is excluded here. A provider whose vocabulary differs can be given a
 * different policy at construction; withholding confirmation is the safe
 * direction either way (the binding simply stays `spawned`).
 */
export function defaultIdentityConfirmation(readout: SessionReadout): boolean {
  if (readout.observation !== Observation.OBSERVED) {
    return false;
  }
  const state = readout.providerState ?? "";
  return !state.startsWith("exited-");
}

export interface SessionOrchestratorOptions {
  readonly runId: string;
  readonly holder: string;
  readonly workspace: string;
  readonly role: string;
  readonly nowMs: () => number;
  readonly sessionUuidFactory: () => string;
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  readonly providerName?: string;
  readonly ttlMs?: number;
  readonly resource?: string | undefined;
  readonly identityConfirmed?: (readout: SessionReadout) => boolean;
  readonly readbackAttempts?: number;
  readonly wait?: Wait;
  readonly attemptIdFactory?: (() => string | null) | undefined;
  readonly seam?: ((name: string) => void) | undefined;
}

/**
 * One run's lease-before-spawn walk, injectable end to end.
 *
 * Time is the caller's (`nowMs`), identity is the caller's
 * (`sessionUuidFactory` -- the generated UUID itself is passed to the
 * provider as `StartRequest.sessionId`, so the provider-neutral identity and
 * the C2 `--session-id` value are one string and no C2 derivation leaks into
 * this layer), and waiting is the caller's (`wait`).
 */
export class SessionOrchestrator {
  readonly #connection: SqliteDatabase;
  readonly #provider: SessionProvider;
  readonly #runId: string;
  readonly #holder: string;
  readonly #workspace: string;
  readonly #role: string;
  readonly #nowMs: () => number;
  readonly #uuidFactory: () => string;
  readonly #settings: Readonly<Record<string, unknown>>;
  readonly #providerName: string;
  readonly #ttlMs: number;
  readonly #resource: string;
  readonly #identityConfirmed: (readout: SessionReadout) => boolean;
  readonly #readbackAttempts: number;
  readonly #wait: Wait;
  readonly #attemptIdFactory: (() => string | null) | undefined;
  readonly #seam: ((name: string) => void) | undefined;
  #gateSequence = 0;

  constructor(
    connection: SqliteDatabase,
    provider: SessionProvider,
    options: SessionOrchestratorOptions,
  ) {
    if ((options.readbackAttempts ?? 50) < 1) {
      throw new RangeError("readbackAttempts must be at least 1");
    }
    this.#connection = connection;
    this.#provider = provider;
    this.#runId = options.runId;
    this.#holder = options.holder;
    this.#workspace = options.workspace;
    this.#role = options.role;
    this.#nowMs = options.nowMs;
    this.#uuidFactory = options.sessionUuidFactory;
    this.#settings = options.settings ?? {};
    this.#providerName = options.providerName ?? "claude-cli";
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#resource = options.resource ?? `session-run:${options.runId}`;
    this.#identityConfirmed = options.identityConfirmed ?? defaultIdentityConfirmation;
    this.#readbackAttempts = options.readbackAttempts ?? 50;
    const wait = Object.hasOwn(options, "wait") ? options.wait : DEFAULT_WAIT;
    if (wait === DEFAULT_WAIT) {
      // A real provider answers start() the instant spawn returns, long
      // before the child has emitted its identity; back-to-back polls would
      // exhaust every attempt against a healthy child. The default is
      // therefore paced -- IO pacing against a live subprocess, never a
      // timestamp and never a measured admission figure (U34). Pass
      // wait: null for a deterministic in-memory provider, or your own
      // callable for a different policy.
      this.#wait = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
    } else {
      this.#wait = wait as Wait;
    }
    this.#attemptIdFactory = options.attemptIdFactory;
    this.#seam = options.seam;
  }

  #cross(seamName: string): void {
    this.#seam?.(seamName);
  }

  // -- the fenced writes ---------------------------------------------------

  #attemptId(): string | null {
    return this.#attemptIdFactory ? this.#attemptIdFactory() : null;
  }

  #acquire(): Lease {
    return leaseModule.acquire(this.#connection, {
      resource: this.#resource,
      holder: this.#holder,
      nowMs: this.#nowMs(),
      ttlMs: this.#ttlMs,
    });
  }

  /**
   * The fenced authority validation around the provider verb.
   *
   * An epoch-stamped `action` row: the fence is evaluated atomically as part
   * of the insert -- never a read-then-decide (S6's rule that expiry
   * discovery alone is insufficient) -- and, deliberately, the *applied* row
   * is itself durable evidence that a claimant at this epoch was actively
   * driving the session. That trace is what lets a refused stale claimant
   * tell "the takeover writer merely holds the lease" apart from "the
   * takeover writer has reached the provider" before deciding whether a
   * session-level stop is safe (see `#refuseAndTerminate`); neither the lease
   * row nor the binding row can say that, because a protected write to
   * another table records no applied action row.
   */
  _postSpawnGate(lease: Lease, options: { readonly moment: string }): void {
    this.#gateSequence += 1;
    const now = this.#nowMs();
    // The holder is part of the key: two orchestrator lives can cross the
    // same gate moment at the same injected-clock instant with the same
    // local sequence, and a collision here would surface as a constraint
    // error instead of the fenced validation it exists to run.
    const key =
      `post_spawn_gate:${this.#runId}:${this.#holder}:${options.moment}:` +
      `${now}:${this.#gateSequence}`;
    const statement = fencedInsert("action", {
      values: {
        action_id: param("action_id"),
        run_id: param("run_id"),
        kind: param("kind"),
        idempotency_key: param("idempotency_key"),
        exactly_once_mechanism: value("transactional_with_record"),
        status: value("applied"),
        applied_at_ms: param("now_ms"),
        writer_epoch: fenceEpoch,
        created_at_ms: param("now_ms"),
      },
    });
    const write = new ProtectedWrite({
      kind: effectKind(lease.resource, "post_spawn_gate"),
      idempotencyKey: key,
      statement,
      exactlyOnceMechanism: "transactional_with_record",
      params: {
        action_id: `gate:${key}`,
        run_id: this.#runId,
        kind: effectKind(lease.resource, "post_spawn_gate"),
        idempotency_key: key,
        now_ms: now,
      },
      runId: this.#runId,
    });
    protectedWrite(this.#connection, lease, write, { nowMs: now, attemptId: this.#attemptId() });
  }

  async #refuseAndTerminate(
    refusal: StaleWriterRefused,
    sessionId: string,
    lease: Lease,
  ): Promise<LoserTerminated> {
    const detected = this.#nowMs();
    // A session-level stop cannot name a process generation, so firing it
    // blind could kill the *winner's* worker: a takeover writer that has
    // already completed its walk (the run's binding is confirmed) may have
    // adopted the very child this loser spawned. The loser therefore stops
    // only while no takeover writer has confirmed the binding; once one has,
    // the loser stands down and surfaces its possibly-rogue process as an
    // unresolved hazard instead -- coordinated with the holder, never a
    // blind kill and never a silent trust.
    //
    // The check-and-stop is serialised against the winner's confirm, not a
    // read-then-stop: the database write lock is held from before the read
    // until after the stop (rolled back, never committed -- this reads, it
    // does not write), so a winner cannot move the binding to confirmed in
    // between (its own confirm blocks on the same lock, within SQLite's busy
    // timeout).
    if (this.#connection.inTransaction) {
      throw new Error("refuse-and-terminate expects an idle connection");
    }
    this.#connection.exec("BEGIN IMMEDIATE");
    let stopAnswer: unknown;
    {
      const binding = sessionBinding.bindingForSession(this.#connection, sessionId);
      const winnerConfirmed =
        binding !== undefined &&
        binding.releasedAtMs === null &&
        binding.bindingPhase === PHASE_IDENTITY_CONFIRMED;
      // A takeover writer that has reached the provider but not yet
      // confirmed leaves exactly one durable trace: its own gate rows,
      // applied under a higher epoch (the gate fires *before* resume, so by
      // the time a winner can have adopted anything its trace is
      // committed). Standing down on that trace is what keeps this from
      // killing a worker the winner adopted between its gate and its
      // confirm -- the one interleaving the phase alone cannot show.
      const newerWriterActive = Boolean(
        this.#connection
          .prepare(
            "SELECT 1 FROM action" +
              " WHERE status = 'applied' AND writer_epoch > :epoch" +
              "   AND kind = :kind LIMIT 1",
          )
          .get({
            epoch: lease.epoch,
            kind: effectKind(lease.resource, "post_spawn_gate"),
          }),
      );
      if (winnerConfirmed || newerWriterActive) {
        const terminated = this.#nowMs();
        this.#connection.exec("ROLLBACK");
        return new LoserTerminated(
          `claimant ${JSON.stringify(this.#holder)} lost the lease on ` +
            `${JSON.stringify(this.#resource)} inside the spawn-admission critical ` +
            `section; a takeover writer has already confirmed the ` +
            `binding for session ${JSON.stringify(sessionId)} or is actively ` +
            "driving it at a newer epoch, so no session-level stop " +
            "was fired (it could kill the winner's adopted worker). " +
            "Any process this claimant created is an UNRESOLVED " +
            "hazard the holder must reconcile",
          {
            sessionId,
            refusal,
            detectedAtMs: detected,
            terminatedAtMs: terminated,
            stopAnswer: null,
            stopConfirmed: false,
            stopAttempted: false,
          },
        );
      }
    }
    // The provider verb is awaited outside the synchronous SQLite critical
    // section above (better-sqlite3 has no async API to hold a transaction
    // open across an `await`), and then the transaction is rolled back --
    // it was only ever a read, never a write.
    try {
      stopAnswer = await this.#provider.stop(sessionId);
    } finally {
      this.#connection.exec("ROLLBACK");
    }
    const terminated = this.#nowMs();
    // The provider's own verdict, never assumed: an Ok is the post-stop
    // readout of a session the provider reports stopped; a Failure means the
    // child may still be live, and saying otherwise here would put a
    // fabricated termination into the very record the residual is read out
    // of.
    const stopConfirmed = stopAnswer instanceof Ok;
    const outcome = stopConfirmed
      ? `was terminated (${terminated - detected} ms after detection)`
      : `was ordered stopped but the stop is NOT confirmed ` +
        `(${terminated - detected} ms after detection): ${describeAnswer(stopAnswer)}`;
    return new LoserTerminated(
      `claimant ${JSON.stringify(this.#holder)} lost the lease on ` +
        `${JSON.stringify(this.#resource)} inside the spawn-admission critical section; ` +
        `the process for session ${JSON.stringify(sessionId)} ${outcome}`,
      {
        sessionId,
        refusal,
        detectedAtMs: detected,
        terminatedAtMs: terminated,
        stopAnswer,
        stopConfirmed,
      },
    );
  }

  /** Post-spawn half of the critical section: refuse-and-terminate. */
  async #validateAfterSpawn(
    lease: Lease,
    sessionId: string,
    options: { readonly moment: string },
  ): Promise<void> {
    try {
      this._postSpawnGate(lease, { moment: options.moment });
    } catch (refusal) {
      if (refusal instanceof StaleWriterRefused) {
        throw await this.#refuseAndTerminate(refusal, sessionId, lease);
      }
      throw refusal;
    }
  }

  /**
   * The walk's final step is always a fenced write, whatever the phase.
   *
   * The naive shape here -- read the phase, skip the commit when it is
   * already `identity_confirmed` -- is an unfenced read-then-decide, and it
   * is wrong in exactly the case that matters: the one writer that finds the
   * phase already confirmed *without having confirmed it* is a stale
   * claimant whose binding was moved by the takeover. So when the confirm
   * itself has nothing left to write, the walk still ends in a fenced gate
   * write: a live holder passes, and a stale one is refused, recorded, and
   * its process terminated -- never returned as success.
   */
  async #commitReadback(lease: Lease, sessionId: string, readout: SessionReadout): Promise<void> {
    const current = sessionBinding.bindingForSession(this.#connection, sessionId);
    try {
      if (current !== undefined && current.bindingPhase === PHASE_SPAWNED) {
        sessionBinding.confirmIdentity(this.#connection, lease, {
          sessionId,
          runId: this.#runId,
          providerState: readout.providerState ?? "",
          nowMs: this.#nowMs(),
          attemptId: this.#attemptId(),
        });
      } else {
        this._postSpawnGate(lease, { moment: "readback-final" });
      }
    } catch (refusal) {
      if (refusal instanceof StaleWriterRefused) {
        throw await this.#refuseAndTerminate(refusal, sessionId, lease);
      }
      throw refusal;
    }
    this.#cross(SEAM_AFTER_READBACK_COMMIT);
  }

  // -- provider answers ----------------------------------------------------

  #unwrap(verb: string, answer: unknown): SessionReadout {
    if (answer instanceof Ok) {
      return answer.value as SessionReadout;
    }
    if (answer instanceof Failure) {
      throw new ProviderStartFailed(
        `provider ${verb} failed: ${answer.kind.value}: ${answer.detail}`,
        answer,
      );
    }
    throw new ProviderStartFailed(
      `provider ${verb} returned neither Ok nor Failure: ${describeAnswer(answer)}`,
      new Failure(
        FailureKind.UNINTERPRETABLE_RESPONSE,
        `unexpected ${verb} answer ${describeAnswer(answer)}`,
      ),
    );
  }

  /**
   * Poll `readState` until the committed identity reads back.
   *
   * Never confirms on trust: exhausting the attempts raises, the binding
   * stays `spawned`, and the last answer rides on the exception. The
   * exhaustion path still ends in a fenced write first -- a claimant whose
   * lease was taken over during a fruitless poll must leave as a refused
   * stale writer (with its child handled), not as a quiet timeout.
   */
  async #awaitIdentity(lease: Lease, sessionId: string): Promise<SessionReadout> {
    let lastAnswer: unknown = null;
    for (let attempt = 0; attempt < this.#readbackAttempts; attempt += 1) {
      const answer = await this.#provider.readState(sessionId);
      lastAnswer = answer;
      if (
        answer instanceof Ok &&
        // The read-back must positively name the committed identity
        // (D-0027): a readout about some other id -- however healthy --
        // confirms nothing about this binding.
        (answer.value as SessionReadout).sessionId === sessionId &&
        this.#identityConfirmed(answer.value as SessionReadout)
      ) {
        return answer.value as SessionReadout;
      }
      if (attempt + 1 < this.#readbackAttempts && this.#wait !== null) {
        await this.#wait();
      }
    }
    try {
      this._postSpawnGate(lease, { moment: "readback-exhausted" });
    } catch (refusal) {
      if (refusal instanceof StaleWriterRefused) {
        throw await this.#refuseAndTerminate(refusal, sessionId, lease);
      }
      throw refusal;
    }
    throw new IdentityUnconfirmed(
      `the identity committed for session ${JSON.stringify(sessionId)} did not read ` +
        `back within ${this.#readbackAttempts} attempts; the binding is ` +
        "left at 'spawned' rather than confirmed on trust",
      lastAnswer,
    );
  }

  // -- the walks -------------------------------------------------------

  /**
   * Fresh admission: lease, commit, spawn, read back, confirm.
   *
   * @throws {LeaseHeld} another claimant's lease is live; nothing written,
   *   nothing spawned.
   * @throws {StaleWriterRefused} the token went stale before the spawn; the
   *   refusal is durable and no process was created.
   * @throws {LoserTerminated} the token went stale inside the critical
   *   section; the just-created process was terminated, measured.
   */
  async start(): Promise<OrchestrationOutcome> {
    const lease = this.#acquire();
    const sessionId = this.#uuidFactory();
    this.#cross(SEAM_BEFORE_ADMISSION_COMMIT);
    // The fence's nowMs is captured *after* the seam: the seam is an
    // arbitrary external delay, and a timestamp taken before it would let a
    // claimant stopped across its own expiry pass the fence's liveness test
    // with a stale clock.
    const now = this.#nowMs();
    sessionBinding.prepareBinding(this.#connection, lease, {
      sessionId,
      runId: this.#runId,
      provider: this.#providerName,
      nowMs: now,
      attemptId: this.#attemptId(),
    });
    return this.#spawnAndConfirm(lease, sessionId, { path: "started", marked: false });
  }

  async #spawnAndConfirm(
    lease: Lease,
    sessionId: string,
    options: { readonly path: string; readonly marked: boolean },
  ): Promise<OrchestrationOutcome> {
    if (!options.marked) {
      // The write-ahead mark: committed under the fence *before* the
      // provider verb, so 'prepared' durably means "no spawn attempted" and
      // a stale claimant is refused before it can create a process.
      sessionBinding.markSpawned(this.#connection, lease, {
        sessionId,
        runId: this.#runId,
        nowMs: this.#nowMs(),
        attemptId: this.#attemptId(),
      });
    }
    this.#cross(SEAM_AFTER_ADMISSION_BEFORE_SPAWN);
    const answer = await this.#provider.start(
      new StartRequest({
        sessionId,
        workspace: this.#workspace,
        role: this.#role,
        settings: this.#settings,
      }),
    );
    this.#cross(SEAM_AFTER_SPAWN_BEFORE_READBACK_COMMIT);
    // The fenced validation runs before the provider's answer is even
    // interpreted: a Failure does not prove no process was created (the C2
    // provider can fail the *readout* after a successful spawn), so a
    // claimant that lost its lease during the verb must be refused -- and
    // its possible child handled -- whatever the verb said.
    await this.#validateAfterSpawn(lease, sessionId, { moment: "after-start" });
    this.#unwrap("start", answer);
    const readout = await this.#awaitIdentity(lease, sessionId);
    await this.#commitReadback(lease, sessionId, readout);
    return this.#outcome(sessionId, options.path, readout);
  }

  /**
   * Re-identify after a crash: exactly one session for the run.
   *
   * The lease is taken first (raising the epoch -- the previous claimant's
   * token is dead from this instant), then the binding row decides the path;
   * the provider's own record decides whether a spawn actually happened, and
   * a surviving process is resolved before any verb that could create a
   * second one.
   */
  async recover(): Promise<OrchestrationOutcome> {
    const lease = this.#acquire();
    const binding = sessionBinding.activeBinding(this.#connection, this.#runId);
    if (binding === undefined) {
      // Nothing was admitted before the crash (the kill landed before the
      // binding commit). This is a fresh admission, not an adoption: any
      // provider-side leftovers under other identities belong to other runs
      // or to no run, and are deliberately not adopted here (no orphan is
      // adopted into a run its binding does not name).
      const sessionId = this.#uuidFactory();
      this.#cross(SEAM_BEFORE_ADMISSION_COMMIT);
      sessionBinding.prepareBinding(this.#connection, lease, {
        sessionId,
        runId: this.#runId,
        provider: this.#providerName,
        nowMs: this.#nowMs(),
        attemptId: this.#attemptId(),
      });
      return this.#spawnAndConfirm(lease, sessionId, { path: "started", marked: false });
    }

    if (binding.provider !== this.#providerName) {
      // Fail closed before any provider verb: recovering another backend's
      // binding through this one could create a child here while the
      // durable row still names the original backend -- a duplicate worker
      // wearing a re-identification's clothes. The mismatch is the caller's
      // wiring to fix, never something to paper over by adopting the row.
      throw new OrchestrationRefused(
        `the active binding for run ${JSON.stringify(this.#runId)} names provider ` +
          `${JSON.stringify(binding.provider)}, but this orchestrator drives ` +
          `${JSON.stringify(this.#providerName)}; recovery through a different ` +
          "provider is refused rather than risked",
      );
    }
    const sessionId = binding.sessionId;
    if (binding.bindingPhase === PHASE_PREPARED) {
      // The write-ahead mark never committed, so the provider verb was
      // never reached; continue the walk from the mark.
      return this.#spawnAndConfirm(lease, sessionId, { path: "respawned", marked: false });
    }

    const known = await this.#provider.readState(sessionId);
    if (known instanceof Failure && known.kind === FailureKind.UNKNOWN_SESSION) {
      // The provider commits its own durable record before it creates a
      // process, so "unknown session" means the spawn never happened -- the
      // mark is a write-ahead, not a receipt. Re-run the spawn under the
      // same committed identity (no fresh identity is minted: the binding
      // row is the identity).
      return this.#spawnAndConfirm(lease, sessionId, { path: "respawned", marked: true });
    }

    // The provider knows the session: recovery goes through resume, never a
    // fresh --session-id claim (U28). The provider resolves a surviving
    // process first -- a live child is adopted, not respawned -- so no
    // second process is created on this id through the mediated path. The
    // gate write brackets the verb exactly as it brackets a spawn.
    this._postSpawnGate(lease, { moment: "before-resume" });
    const answer = await this.#provider.resume(sessionId);
    // Fence first, interpret second -- same reasoning as the start walk: a
    // resume Failure does not prove no process was created.
    await this.#validateAfterSpawn(lease, sessionId, { moment: "after-resume" });
    this.#unwrap("resume", answer);
    const readout = await this.#awaitIdentity(lease, sessionId);
    await this.#commitReadback(lease, sessionId, readout);
    return this.#outcome(sessionId, "resumed", readout);
  }

  #outcome(sessionId: string, path: string, readout: SessionReadout): OrchestrationOutcome {
    const binding = sessionBinding.activeBinding(this.#connection, this.#runId);
    // "Exactly one" is the index's at-most-one plus this non-empty read:
    // recovery that ends without an active, confirmed binding for the very
    // session it drove did not re-identify anything.
    if (binding === undefined || binding.sessionId !== sessionId) {
      throw new Error(
        `run ${JSON.stringify(this.#runId)} ended its walk without an active binding ` +
          `for session ${JSON.stringify(sessionId)}: ${describeAnswer(binding)}`,
      );
    }
    if (binding.bindingPhase !== PHASE_IDENTITY_CONFIRMED) {
      throw new Error(
        `binding for ${JSON.stringify(sessionId)} left at ${JSON.stringify(binding.bindingPhase)}`,
      );
    }
    return new OrchestrationOutcome({ sessionId, path, binding, readout });
  }
}

function describeAnswer(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
