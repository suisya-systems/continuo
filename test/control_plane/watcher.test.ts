/**
 * G3 -- watcher liveness: section 8's four distinctions, as tests.
 *
 * Ported from interlock `tests/control_plane/test_watcher.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping is recorded in the parity
 * ledger.
 *
 * `docs/production-schema.md` section 8.1 names four things a single
 * `last_heartbeat_at` column cannot say, each with a v1 incident behind it. Every
 * test below pins one of them, or pins the fence that keeps the answer honest:
 *
 * * **"polled, nothing changed" versus "poll failed"** -- the alternation tests.
 *   `last_success_at_ms` and `last_error_at_ms` are *history* and the table's
 *   constraints on them are implications rather than biconditionals; tying either
 *   both ways would abort the first success-after-error and the first
 *   error-after-success, which is every recovery and every failure.
 * * **A replaced watcher's late heartbeat** -- the refusal tests. Zero rows has
 *   exactly two causes, they are disambiguated by a read rather than assumed, and
 *   the refusal is durable in every case, including the one the DDL trigger turns
 *   into an exception instead of a zero.
 * * **A missing watcher** -- "a registered scope that never heartbeats is
 *   uncovered" and its neighbours. This is `relay_scan.py`'s twenty-day silence:
 *   the trace alone answers "fine" to every question, and only the roster can name
 *   the absence.
 * * **Partial coverage** -- the same query, with one scope of two covered.
 *
 * Plus the property that makes the whole thing non-negotiable: a watcher holding
 * scope B's lease **cannot** heartbeat scope A. The lease resource is derived
 * inside the statement, so the misroute is unrepresentable rather than merely
 * discouraged, and the test asserts both halves -- the write is refused *and* A
 * stays uncovered, because a heartbeat that landed would silence the very
 * predicate the fence protects.
 *
 * Both policy reads bind the effective revision (`D-0031`: a `policy_*` join
 * without a `revision_id` predicate is a defect), so each is tested with **two
 * revisions on record** -- a query that forgot the predicate still returns rows,
 * so only a second revision can tell the two apart.
 *
 * Every timestamp comes from {@link T0} and arithmetic on it. No test here reads a
 * clock; the module does not either, and a suite whose expectations moved with the
 * wall clock could not assert a tolerance boundary at all.
 *
 * Translation notes, each a rule rather than a local choice:
 *
 * * The `cp` fixture is a plain function called inside the test (conventions rule
 *   8), and it registers its `close()` with `onTestFinished` at the point of
 *   acquisition (rule 1) -- which is stricter than the source's `try/finally`,
 *   whose seeding INSERT runs before the `try` and would leak the connection on a
 *   failure there. The database file is named by the testkit (`copyInto` joins
 *   the case directory and the template name with `node:path`), never with a `/`
 *   (rule 6).
 * * The `caseRoot` label is `s8`, the schema section this module answers to
 *   (D-0020). No refusal in this file interpolates a filesystem path, no case
 *   asserts on one, and no assertion literal below occurs in
 *   `<tmp>/continuo-s8-w0-XXXX/production.sqlite3`.
 * * SQL NULL reads back as `null` and a missing row as `undefined` (D-0007), so
 *   the source's single `None` splits in two here: `is None` on a *column* is
 *   `toBeNull()`, and `is None` on a *row* is `toBeUndefined()`.
 * * The incident queries return camelCase projections, so `row["scope_id"]`
 *   becomes `row.scopeId` and `row["silent_for_ms"]` becomes `row.silentForMs`.
 *   Raw table rows read with `SELECT *` keep their snake_case column names,
 *   exactly as the source's `dict(zip(...))` helpers do.
 * * Two cases reach for the Python runtime rather than for the module:
 *   `inspect.signature` and `Path(watcher.__file__).read_text`. Neither has a
 *   runtime analogue here, and both are translated the way `migrator.test.ts`'s
 *   "the module exposes no down migration api" translates `dir(m)` -- a scan over
 *   the module's own source text, with an explicit anti-vacuity assertion so a
 *   scan that matched nothing fails instead of passing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { acquire } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import {
  errorStreakScopes,
  HeartbeatRefused,
  heartbeat,
  registerScope,
  retireScope,
  ScopeNotRegistered,
  scopeLeaseResource,
  silentScopes,
  uncoveredScopes,
  WatcherUsageError,
  watcherSeams,
} from "../../src/control_plane/watcher.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/**
 * One scope's own expected interval. The seeded `watcher_silence` threshold
 * is the multiple 3, so silence begins strictly after 180_000 ms for this scope
 * and at some other figure for any scope registered with another interval --
 * which is the reason the policy row stores a multiple.
 */
const INTERVAL_MS = 60_000;

/** Long enough that no test's arithmetic expires a lease. */
const LONG_TTL_MS = 3_600_000;

/** This module's own source text, for the two introspection cases. */
const MODULE_SOURCE_PATH = fileURLToPath(
  new URL("../../src/control_plane/watcher.ts", import.meta.url),
);

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

/**
 * The migrated database every case starts from, built once for this file.
 *
 * Every case here wants the same thing -- a production control plane created at
 * `T0`, at head, with no `migrationsDir` override -- and creating one costs
 * about 44ms against about 2.8ms to copy one and open it. Building it once per
 * file and handing each case its own copy keeps the per-case fixture identical
 * while removing the migrations this file used to run (D-0027).
 *
 * The repository row stays in `cpFixture` rather than in the template: the
 * template is the migrated schema and nothing else, so every file's copy of this
 * declaration is the same one.
 */
const productionTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/**
 * The source's `db_path` fixture, as a per-test call: a fresh copy of the
 * template in a fresh per-case directory.
 */
function productionDb(): string {
  return productionTemplate.copyInto(caseRoot("s8"));
}

/**
 * The source's `cp` fixture: a production control plane with one repository.
 *
 * The connection now comes from `openProductionControlPlane` over a copy rather
 * than from creating one. Both apply the same two pragmas, and opening verifies
 * the copy is at head -- so a template that failed to build is a refusal here
 * rather than a case that quietly runs against the wrong schema.
 */
function cpFixture(): SqliteDatabase {
  const connection = openProductionControlPlane(productionDb());
  onTestFinished(() => {
    connection.close();
  });
  connection
    .prepare<[number, number]>(
      `
        INSERT INTO repository (repo_id, provider, owner, name, created_at_ms, updated_at_ms)
        VALUES ('repo-1', 'github', 'acme', 'widget', ?, ?)
        `,
    )
    .run(T0, T0);
  return connection;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal setup of each kind
// --------------------------------------------------------------------------

function addScope(
  cp: SqliteDatabase,
  scopeId = "scope-1",
  options: { readonly intervalMs?: number; readonly at?: number } = {},
): string {
  const { intervalMs = INTERVAL_MS, at = T0 } = options;
  registerScope(cp, {
    scopeId,
    scopeKind: "ci_repository",
    expectedIntervalMs: intervalMs,
    registeredAtMs: at,
    repoId: "repo-1",
  });
  return scopeId;
}

/** Take `scopeId`'s lease for `holder` and return the epoch it was given. */
function hold(
  cp: SqliteDatabase,
  scopeId: string,
  options: { readonly holder?: string; readonly at?: number; readonly ttlMs?: number } = {},
): number {
  const { holder = "watcher-1", at = T0, ttlMs = LONG_TTL_MS } = options;
  return acquire(cp, { resource: scopeLeaseResource(scopeId), holder, nowMs: at, ttlMs }).epoch;
}

/** One `watcher_liveness` row, or `undefined` where the source returns `None`. */
interface LivenessRow {
  readonly scope_id: string;
  readonly holder: string;
  readonly holder_epoch: number;
  readonly last_attempt_at_ms: number;
  readonly last_result: string;
  readonly last_success_at_ms: number | null;
  readonly last_change_at_ms: number | null;
  readonly last_error_at_ms: number | null;
  readonly last_error: string | null;
  readonly consecutive_errors: number;
  readonly attempt_count: number;
}

function liveness(cp: SqliteDatabase, scopeId: string): LivenessRow | undefined {
  return cp
    .prepare<[string], LivenessRow>("SELECT * FROM watcher_liveness WHERE scope_id = ?")
    .get(scopeId);
}

/** One `action` row in `status='refused'`. */
interface ActionRow {
  readonly action_id: string;
  readonly kind: string;
  readonly refusal_reason: string | null;
  readonly writer_epoch: number | null;
}

function refusals(cp: SqliteDatabase): ActionRow[] {
  return cp
    .prepare<[], ActionRow>("SELECT * FROM action WHERE status = 'refused' ORDER BY rowid")
    .all();
}

/**
 * A second policy revision, so a policy read that forgot to bind one fails.
 *
 * Each `thresholds` key is an incident class mapped to
 * `[thresholdKind, thresholdValue]`; everything else on the row is carried
 * from the seed, because what these tests vary is the tolerance and not the
 * budget.
 */
function addRevision(
  cp: SqliteDatabase,
  options: {
    readonly note: string;
    readonly effectiveAtMs: number;
    readonly thresholds: Readonly<Record<string, readonly [string, number]>>;
  },
): number {
  const revisionId = cp
    .prepare<[string, string, number]>(
      "INSERT INTO policy_revision (note, decided_by, effective_at_ms) VALUES (?, ?, ?)",
    )
    .run(options.note, "test", options.effectiveAtMs).lastInsertRowid;
  for (const [incidentClass, [thresholdKind, thresholdValue]] of Object.entries(
    options.thresholds,
  )) {
    cp.prepare<[number, string, string, number]>(
      `
            INSERT INTO policy_detection_latency
                (revision_id, incident_class, threshold_kind, threshold_value,
                 reconcile_period_ms, budget_ms, budget_kind)
            VALUES (?, ?, ?, ?, 120000, 600000, 'absolute_ms')
            `,
    ).run(Number(revisionId), incidentClass, thresholdKind, thresholdValue);
  }
  return Number(revisionId);
}

// --------------------------------------------------------------------------
// the roster
// --------------------------------------------------------------------------

describe("the roster", () => {
  test("the scope lease resource is a function of the scope id", () => {
    expect(scopeLeaseResource("scope-1")).toBe("watcher_scope:scope-1");
  });

  test("heartbeat takes no resource argument so a misroute cannot be expressed", () => {
    // Section 8.3 is explicit that a separate resource parameter is the defect,
    // not merely a smell: it lets scope B's holder mark scope A healthy. The
    // behavioural proof is below; this asserts the shape, so that a later
    // "convenience" override has to delete a test that says why it must not.
    //
    // Adapted from `inspect.signature(heartbeat).parameters`, which has no
    // runtime analogue: an options object's keys exist only in the type, so the
    // shape is asserted from the declaration's own source text, plus the
    // function's arity for the positional half a scan cannot see.
    expect(heartbeat.length).toBe(2);

    const source = readFileSync(MODULE_SOURCE_PATH, "utf8");
    const declaration = /export function heartbeat\(([\s\S]*?)\n\): void \{/.exec(source);
    // Anti-vacuity: a declaration the scan failed to find would make every
    // assertion below pass while proving nothing at all.
    expect(declaration).not.toBeNull();
    const signature = declaration?.[1] ?? "";
    const parameters = [...signature.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1]);
    expect(parameters).toContain("scopeId");

    // Exactly the source's assertion -- no PARAMETER named `resource` -- and no
    // more. A regex over the whole signature text would also fail on a
    // parameter named `resourceScope` or a type annotation mentioning one,
    // which is asserting something the source does not. A translation may not
    // be stricter than its source any more than it may be weaker.
    expect(parameters).not.toContain("resource");
  });

  test("a pull request scope must name its pull request", () => {
    const cp = cpFixture();
    expectRefusal(
      () =>
        registerScope(cp, {
          scopeId: "s",
          scopeKind: "ci_pull_request",
          expectedIntervalMs: INTERVAL_MS,
          registeredAtMs: T0,
          repoId: "repo-1",
        }),
      WatcherUsageError,
    );
  });

  test("a repository scope may not name a pull request", () => {
    const cp = cpFixture();
    expectRefusal(
      () =>
        registerScope(cp, {
          scopeId: "s",
          scopeKind: "ci_repository",
          expectedIntervalMs: INTERVAL_MS,
          registeredAtMs: T0,
          repoId: "repo-1",
          prId: "pr-1",
        }),
      WatcherUsageError,
    );
  });

  test("retiring a scope that is not on the roster is refused", () => {
    const cp = cpFixture();
    expectRefusal(
      () => retireScope(cp, { scopeId: "never-registered", retiredAtMs: T0 }),
      ScopeNotRegistered,
    );
  });

  test("retiring a scope keeps its last trace", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_change",
      nowMs: T0,
    });

    retireScope(cp, { scopeId: "scope-1", retiredAtMs: T0 + 1 });

    const row = liveness(cp, "scope-1");
    expect(row).toBeDefined();
    expect(row?.last_change_at_ms).toBe(T0);
    expect(uncoveredScopes(cp)).toEqual([]);
    expect(silentScopes(cp, { nowMs: T0 + 10 * INTERVAL_MS })).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// the trace, and the fence inside it
// --------------------------------------------------------------------------

describe("the trace, and the fence inside it", () => {
  test("the first heartbeat of a scope inserts its row through the same fence", () => {
    // The bootstrap arm. A bare UPDATE would change zero rows here, and zero
    // rows is how a stale writer is refused -- so this case has to be a write
    // and not a refusal, while still requiring the lease.
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");

    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0 + 10,
    });

    const row = liveness(cp, "scope-1");
    expect(row).toBeDefined();
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_result).toBe("observed_no_change");
    expect(row?.last_attempt_at_ms).toBe(T0 + 10);
    expect(row?.last_success_at_ms).toBe(T0 + 10);
    // Nothing changed, so nothing was seen to change. The distinction the
    // single-column form loses.
    expect(row?.last_change_at_ms).toBeNull();
    expect(row?.consecutive_errors).toBe(0);
  });

  test("a heartbeat for an unregistered scope is not a stale writer", () => {
    const cp = cpFixture();
    expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "ghost",
          holder: "watcher-1",
          epoch: 1,
          result: "observed_no_change",
          nowMs: T0,
        }),
      ScopeNotRegistered,
    );
    expect(refusals(cp)).toEqual([]);
  });

  test("a heartbeat without the scope lease is refused and recorded", () => {
    const cp = cpFixture();
    addScope(cp);

    const refused = expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-1",
          holder: "watcher-1",
          epoch: 1,
          result: "observed_change",
          nowMs: T0,
        }),
      HeartbeatRefused,
    );

    expect(refused.cause).toBe("lease_not_held");
    expect(liveness(cp, "scope-1")).toBeUndefined();
    const recorded = refusals(cp);
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.action_id).toBe(refused.actionId);
    expect(recorded[0]?.kind).toBe("watcher_heartbeat@watcher_scope:scope-1");
    expect(recorded[0]?.writer_epoch).toBe(1);
    expect(recorded[0]?.refusal_reason).toContain("watcher_scope:scope-1");
  });

  test("a watcher holding another scopes lease cannot heartbeat this one", () => {
    // Section 8.3's whole argument for deriving the resource, as a test. Scope A
    // has no watcher; the holder of scope B's lease tries to heartbeat A. If the
    // write landed, A would look healthy, watcher_silence would never fire for
    // it, and the uncovered query -- the only thing that can see a missing
    // watcher at all -- would go quiet too.
    const cp = cpFixture();
    addScope(cp, "scope-a");
    addScope(cp, "scope-b");
    const epochB = hold(cp, "scope-b", { holder: "watcher-b" });
    heartbeat(cp, {
      scopeId: "scope-b",
      holder: "watcher-b",
      epoch: epochB,
      result: "observed_no_change",
      nowMs: T0,
    });

    const refused = expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-a",
          holder: "watcher-b",
          epoch: epochB,
          result: "observed_change",
          nowMs: T0,
        }),
      HeartbeatRefused,
    );

    expect(refused.cause).toBe("lease_not_held");
    expect(liveness(cp, "scope-a")).toBeUndefined();
    expect(uncoveredScopes(cp).map((row) => row.scopeId)).toEqual(["scope-a"]);
  });

  test("a replaced watcher returning with its old epoch is refused", () => {
    const cp = cpFixture();
    addScope(cp);
    const oldEpoch = hold(cp, "scope-1", { holder: "watcher-1", ttlMs: 1_000 });
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch: oldEpoch,
      result: "observed_change",
      nowMs: T0,
    });
    // The lease lapses and is taken over, which raises the epoch. That is what
    // invalidates the old token -- not the clock.
    const newEpoch = hold(cp, "scope-1", { holder: "watcher-2", at: T0 + 2_000 });
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-2",
      epoch: newEpoch,
      result: "observed_no_change",
      nowMs: T0 + 2_000,
    });

    const refused = expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-1",
          holder: "watcher-1",
          epoch: oldEpoch,
          result: "observed_change",
          nowMs: T0 + 3_000,
        }),
      HeartbeatRefused,
    );

    expect(refused.cause).toBe("lease_not_held");
    expect(refused.observed?.holder).toBe("watcher-2");
    const row = liveness(cp, "scope-1");
    expect(row).toBeDefined();
    expect([row?.holder, row?.holder_epoch]).toEqual(["watcher-2", newEpoch]);
    expect(row?.attempt_count).toBe(2); // the refusal did not count as an attempt
  });

  test("a liveness row at a higher epoch refuses a live lease holder", () => {
    // The second of the two zero-row causes, and the reason the refusal reads
    // the cause instead of assuming one: here the fence HOLDS, so "the lease is
    // not ours" would be a lie. The row is seeded directly because
    // lease.acquire's own monotonicity means no sequence of this module's calls
    // can produce a liveness epoch above the live lease's -- the branch is
    // defence in depth against a writer that does not come through here.
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1", { holder: "watcher-1" });
    cp.prepare<[number, number, number]>(
      `
        INSERT INTO watcher_liveness (scope_id, holder, holder_epoch, last_attempt_at_ms,
                                      last_result, last_success_at_ms, attempt_count)
        VALUES ('scope-1', 'watcher-1', ?, ?, 'observed_change', ?, 1)
        `,
    ).run(epoch + 5, T0, T0);

    const refused = expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-1",
          holder: "watcher-1",
          epoch,
          result: "observed_change",
          nowMs: T0 + 1,
        }),
      HeartbeatRefused,
    );

    expect(refused.cause).toBe("epoch_superseded");
    const row = liveness(cp, "scope-1");
    expect(row).toBeDefined();
    expect(row?.holder_epoch).toBe(epoch + 5);
    expect(refusals(cp).length).toBe(1);
  });

  test("a different holder at an equal epoch is refused by the trigger and recorded", () => {
    // This one passes `holder_epoch <= :epoch` and is stopped by
    // watcher_liveness_epoch_is_monotonic, so it arrives as an integrity error
    // rather than as zero rows. It is the same stale writer and it gets the same
    // durable refusal -- ACCEPTANCE.md section 2 does not care which mechanism
    // rejected it. Both rows are seeded directly because acquire() raises the
    // epoch on every handover, so an equal-epoch handover cannot be produced
    // through the supported path.
    const cp = cpFixture();
    addScope(cp);
    cp.prepare<[number, number]>(
      "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
        " VALUES ('watcher_scope:scope-1', 'watcher-new', 7, ?, ?)",
    ).run(T0, T0 + LONG_TTL_MS);
    cp.prepare<[number, number]>(
      `
        INSERT INTO watcher_liveness (scope_id, holder, holder_epoch, last_attempt_at_ms,
                                      last_result, last_success_at_ms, attempt_count)
        VALUES ('scope-1', 'watcher-old', 7, ?, 'observed_change', ?, 1)
        `,
    ).run(T0, T0);

    const refused = expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-1",
          holder: "watcher-new",
          epoch: 7,
          result: "observed_change",
          nowMs: T0 + 1,
        }),
      HeartbeatRefused,
    );

    expect(refused.cause).toBe("epoch_not_raised_by_new_holder");
    const row = liveness(cp, "scope-1");
    expect(row).toBeDefined();
    expect(row?.holder).toBe("watcher-old");
    expect(refusals(cp).length).toBe(1);
  });

  test("every refusal of a returning writer is recorded again", () => {
    // action_one_effect_per_key excludes refused rows on purpose: a writer that
    // keeps coming back is recorded every time, and none of those records is
    // what admits a second effect.
    const cp = cpFixture();
    addScope(cp);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expectRefusal(
        () =>
          heartbeat(cp, {
            scopeId: "scope-1",
            holder: "watcher-1",
            epoch: 1,
            result: "observed_change",
            nowMs: T0 + attempt,
          }),
        HeartbeatRefused,
      );
    }
    expect(refusals(cp).length).toBe(3);
  });

  test("a result and its error message must agree", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-1",
          holder: "watcher-1",
          epoch,
          result: "error",
          nowMs: T0,
        }),
      WatcherUsageError,
    );
    expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-1",
          holder: "watcher-1",
          epoch,
          result: "observed_change",
          nowMs: T0,
          error: "but nothing failed",
        }),
      WatcherUsageError,
    );
    expect(liveness(cp, "scope-1")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// the alternation the implications exist for
// --------------------------------------------------------------------------

describe("the alternation the implications exist for", () => {
  test("success then error then success keeps both histories", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");

    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_change",
      nowMs: T0,
    });
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "error",
      nowMs: T0 + 1_000,
      error: "HTTP 502 from the provider",
    });
    const afterFailure = liveness(cp, "scope-1");
    expect(afterFailure).toBeDefined();
    // The first error-after-success. A biconditional on last_success_at_ms would
    // have aborted this write, and with it every failure the table exists to
    // record.
    expect(afterFailure?.last_success_at_ms).toBe(T0);
    expect(afterFailure?.last_error_at_ms).toBe(T0 + 1_000);
    expect(afterFailure?.last_error).toBe("HTTP 502 from the provider");
    expect(afterFailure?.consecutive_errors).toBe(1);

    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0 + 2_000,
    });
    const afterRecovery = liveness(cp, "scope-1");
    expect(afterRecovery).toBeDefined();
    // The first success-after-error, which the mirror-image biconditional would
    // have aborted. The failure's timestamp survives its own recovery.
    expect(afterRecovery?.last_error_at_ms).toBe(T0 + 1_000);
    expect(afterRecovery?.last_error).toBeNull();
    expect(afterRecovery?.last_success_at_ms).toBe(T0 + 2_000);
    expect(afterRecovery?.last_change_at_ms).toBe(T0); // still the only change seen
    expect(afterRecovery?.consecutive_errors).toBe(0);
    expect(afterRecovery?.attempt_count).toBe(3);
  });

  test("consecutive errors counts up and resets only on a success", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      heartbeat(cp, {
        scopeId: "scope-1",
        holder: "watcher-1",
        epoch,
        result: "error",
        nowMs: T0 + attempt,
        error: "bad credential",
      });
    }
    const striking = liveness(cp, "scope-1");
    expect(striking).toBeDefined();
    expect(striking?.consecutive_errors).toBe(4);

    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0 + 10,
    });
    const recovered = liveness(cp, "scope-1");
    expect(recovered).toBeDefined();
    expect(recovered?.consecutive_errors).toBe(0);
  });
});

// --------------------------------------------------------------------------
// the three incident conditions, kept distinct
// --------------------------------------------------------------------------

describe("the three incident conditions, kept distinct", () => {
  test("a registered scope that never heartbeats is uncovered", () => {
    const cp = cpFixture();
    addScope(cp, "scope-a");
    expect(uncoveredScopes(cp).map((row) => row.scopeId)).toEqual(["scope-a"]);
    // ...and silence cannot see it. A scope with no row has no last_attempt to
    // be late against, which is exactly why the roster exists.
    expect(silentScopes(cp, { nowMs: T0 + 10 * INTERVAL_MS })).toEqual([]);
  });

  test("partial coverage names only the scope nobody is watching", () => {
    const cp = cpFixture();
    addScope(cp, "scope-a");
    addScope(cp, "scope-b");
    const epoch = hold(cp, "scope-b", { holder: "watcher-b" });
    heartbeat(cp, {
      scopeId: "scope-b",
      holder: "watcher-b",
      epoch,
      result: "observed_no_change",
      nowMs: T0,
    });

    expect(uncoveredScopes(cp).map((row) => row.scopeId)).toEqual(["scope-a"]);
  });

  test("silence begins strictly after the scopes own interval multiple", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0,
    });

    const onTheBound = T0 + 3 * INTERVAL_MS;
    expect(silentScopes(cp, { nowMs: onTheBound })).toEqual([]);
    const justPast = silentScopes(cp, { nowMs: onTheBound + 1 });
    expect(justPast.map((row) => row.scopeId)).toEqual(["scope-1"]);
    expect(justPast[0]?.silentForMs).toBe(3 * INTERVAL_MS + 1);
  });

  test("silence is measured against each scopes own interval", () => {
    // The reason the threshold is stored as a multiple: one millisecond figure
    // would mis-age whichever scope was not the one it was derived from.
    const cp = cpFixture();
    addScope(cp, "brisk", { intervalMs: 10_000 });
    addScope(cp, "leisurely", { intervalMs: 600_000 });
    for (const scopeId of ["brisk", "leisurely"]) {
      const epoch = hold(cp, scopeId, { holder: `watcher-${scopeId}` });
      heartbeat(cp, {
        scopeId,
        holder: `watcher-${scopeId}`,
        epoch,
        result: "observed_no_change",
        nowMs: T0,
      });
    }

    const named = silentScopes(cp, { nowMs: T0 + 60_000 }).map((row) => row.scopeId);
    expect(named).toEqual(["brisk"]);
  });

  test("an erroring watcher that is punctual is a streak and not silent", () => {
    // Two conditions, two remedies: a dead process versus a broken credential.
    // Collapsing them produces one alarm that names neither.
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      heartbeat(cp, {
        scopeId: "scope-1",
        holder: "watcher-1",
        epoch,
        result: "error",
        nowMs: T0 + attempt,
        error: "HTTP 401",
      });
    }

    const now = T0 + 5;
    expect(errorStreakScopes(cp, { nowMs: now }).map((row) => row.scopeId)).toEqual(["scope-1"]);
    expect(silentScopes(cp, { nowMs: now })).toEqual([]);
    expect(uncoveredScopes(cp)).toEqual([]);
  });

  test("a silent watcher that last succeeded is not an error streak", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_change",
      nowMs: T0,
    });

    const now = T0 + 10 * INTERVAL_MS;
    expect(silentScopes(cp, { nowMs: now }).map((row) => row.scopeId)).toEqual(["scope-1"]);
    expect(errorStreakScopes(cp, { nowMs: now })).toEqual([]);
  });

  test("the streak opens on the threshold th failure and not the one after", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      heartbeat(cp, {
        scopeId: "scope-1",
        holder: "watcher-1",
        epoch,
        result: "error",
        nowMs: T0 + attempt,
        error: "HTTP 401",
      });
    }
    expect(errorStreakScopes(cp, { nowMs: T0 + 4 })).toEqual([]);

    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "error",
      nowMs: T0 + 4,
      error: "HTTP 401",
    });
    expect(errorStreakScopes(cp, { nowMs: T0 + 5 }).map((row) => row.scopeId)).toEqual(["scope-1"]);
  });
});

// --------------------------------------------------------------------------
// both policy reads bind the effective revision (D-0031)
// --------------------------------------------------------------------------

describe("both policy reads bind the effective revision (D-0031)", () => {
  test("silence binds the effective policy revision", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0,
    });
    const now = T0 + 5 * INTERVAL_MS;
    expect(silentScopes(cp, { nowMs: now }).map((row) => row.scopeId)).toEqual(["scope-1"]);

    // A later revision relaxes the multiple from 3 to 10. An unbound join would
    // still match the seed row and keep alarming -- which is D-0031's corollary
    // exactly: the defect returns rows, so only a second revision exposes it.
    addRevision(cp, {
      note: "relaxed watcher silence",
      effectiveAtMs: T0,
      thresholds: { watcher_silence: ["scope_interval_multiple", 10] },
    });

    expect(silentScopes(cp, { nowMs: now })).toEqual([]);
    expect(silentScopes(cp, { nowMs: T0 + 11 * INTERVAL_MS }).map((row) => row.scopeId)).toEqual([
      "scope-1",
    ]);
  });

  test("silence reads the revision that was effective at the callers instant", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0,
    });
    addRevision(cp, {
      note: "relaxed watcher silence",
      effectiveAtMs: T0 + 10 * INTERVAL_MS,
      thresholds: { watcher_silence: ["scope_interval_multiple", 10] },
    });

    // Before the new revision takes effect the old multiple still governs.
    expect(silentScopes(cp, { nowMs: T0 + 4 * INTERVAL_MS }).map((row) => row.scopeId)).toEqual([
      "scope-1",
    ]);
    // After it, the same scope is inside the relaxed tolerance again.
    expect(silentScopes(cp, { nowMs: T0 + 10 * INTERVAL_MS })).toEqual([]);
  });

  test("the error streak binds the effective policy revision", () => {
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      heartbeat(cp, {
        scopeId: "scope-1",
        holder: "watcher-1",
        epoch,
        result: "error",
        nowMs: T0 + attempt,
        error: "HTTP 401",
      });
    }
    expect(errorStreakScopes(cp, { nowMs: T0 + 2 })).toEqual([]);

    addRevision(cp, {
      note: "tightened watcher error streak",
      effectiveAtMs: T0,
      thresholds: { watcher_error_streak: ["consecutive_count", 2] },
    });

    expect(errorStreakScopes(cp, { nowMs: T0 + 2 }).map((row) => row.scopeId)).toEqual(["scope-1"]);
  });

  test("two revisions at one instant resolve by the later revision id", () => {
    // Both tiebreak columns matter: without the revision_id half, a correction
    // filed in the same millisecond would resolve by SQLite's row order.
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0,
    });
    addRevision(cp, {
      note: "first at this instant",
      effectiveAtMs: T0 + 1,
      thresholds: { watcher_silence: ["scope_interval_multiple", 1] },
    });
    addRevision(cp, {
      note: "correction at the same instant",
      effectiveAtMs: T0 + 1,
      thresholds: { watcher_silence: ["scope_interval_multiple", 100] },
    });

    expect(silentScopes(cp, { nowMs: T0 + 5 * INTERVAL_MS })).toEqual([]);
  });

  test("a retired revision is not joined alongside the live one", () => {
    // The shape of the defect D-0031 names: an unbound join returns one row per
    // revision, so the same scope would be reported twice.
    const cp = cpFixture();
    addScope(cp);
    const epoch = hold(cp, "scope-1");
    heartbeat(cp, {
      scopeId: "scope-1",
      holder: "watcher-1",
      epoch,
      result: "observed_no_change",
      nowMs: T0,
    });
    addRevision(cp, {
      note: "a second revision with the same tolerance",
      effectiveAtMs: T0,
      thresholds: { watcher_silence: ["scope_interval_multiple", 3] },
    });

    expect(silentScopes(cp, { nowMs: T0 + 5 * INTERVAL_MS }).length).toBe(1);
  });

  test("the watcher module never reads a clock", () => {
    // Adapted from `Path(watcher.__file__).read_text()` plus `"time.time" not
    // in source` / `"import time" not in source`: the same scan, over this
    // module's own source text, against the names a TypeScript clock read would
    // have to use. The property is identical -- there is no wall clock anywhere
    // in the module, so every timestamp is the caller's.
    const source = readFileSync(MODULE_SOURCE_PATH, "utf8");
    // Anti-vacuity: an unreadable or empty file would make every "not in"
    // assertion below pass while proving nothing at all.
    expect(source.length).toBeGreaterThan(0);
    expect(source).toContain("export function heartbeat");

    for (const reader of ["Date.now", "new Date", "performance.now", "hrtime", "node:timers"]) {
      expect(source, reader).not.toContain(reader);
    }
  });
});

// --------------------------------------------------------------------------
// seam liveness (target-only)
//
// Conventions rule 5: a seam can rot into a decoration. If a refactor made
// production mint an id directly, a case that replaced the seam entry would stay
// green because the replacement is simply never reached. This one says
// production routes through it, and it is target-only -- the source patches
// nothing, because Python's module-level `uuid` needs no seam to be patched.
// --------------------------------------------------------------------------

describe("seam liveness (target-only)", () => {
  test("watcher uuid4Hex names the refused heartbeats action row", () => {
    const cp = cpFixture();
    addScope(cp);
    patchSeam(watcherSeams, "uuid4Hex", () => "0123456789abcdef0123456789abcdef");

    const refused = expectRefusal(
      () =>
        heartbeat(cp, {
          scopeId: "scope-1",
          holder: "watcher-1",
          epoch: 1,
          result: "observed_change",
          nowMs: T0,
        }),
      HeartbeatRefused,
    );

    expect(refused.actionId).toBe("watcher-refusal-0123456789abcdef0123456789abcdef");
    expect(refusals(cp).map((row) => row.action_id)).toEqual([
      "watcher-refusal-0123456789abcdef0123456789abcdef",
    ]);
  });
});
