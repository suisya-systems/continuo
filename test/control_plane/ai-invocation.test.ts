/**
 * The AI invocation ledger -- the units, the ceiling, and what a missing figure is.
 *
 * Ported from interlock `tests/control_plane/test_ai_invocation.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping is recorded in the
 * parity ledger.
 *
 * `docs/measurement-harness.md` sections 2.2-2.4 from the API side.
 * `tests/control_plane/test_production_schema.py` already pins what the table's
 * `CHECK` constraints do to hand-written `INSERT`s; what is unproven until here
 * is that `src/control_plane/ai_invocation.ts` can never *reach* one of them
 * with a row a caller believed was legal, and that every figure the report will
 * read means what section 2.4 says it means.
 *
 * The cases that would each cost a real result if the module got them wrong:
 *
 * * the **ceiling is per request times the response count**, so a tool-using
 *   invocation whose summed output exceeds one request's cap is legal and the
 *   same output against a single response is refused -- comparing against the
 *   flat cap would refuse every honest agentic loop;
 * * **retries are not responses**: a 429 plus a successful retry is two attempts
 *   and one assistant turn, and folding them together would report a flaky
 *   network as AI workload;
 * * a **missing usage record round-trips as a named status**, not as a zero, in
 *   both its shapes -- `partial` keeps the fields that did arrive, `unavailable`
 *   says none did;
 * * an invocation with **no `incident_id`** is recorded, because AC-1 is
 *   measured from these rows and refusing it would make AC-1 true by
 *   construction;
 * * an invocation with **no `max_output_tokens`** is recorded and stays
 *   recognisable as `unbounded_missing`, because that is the one thing that
 *   cannot be recovered afterwards.
 *
 * Every timestamp is {@link T0} and arithmetic on it. No *timestamp* column has
 * a `DEFAULT` (`time-base-policy.md` section 2, rule 2) and no function under
 * test reads a clock, so a suite whose expectations moved with the wall clock
 * would be asserting something the production code cannot observe. The two
 * columns that do carry a `DEFAULT` -- `model_response_count` and
 * `attempt_count`, both `DEFAULT 1` -- are written explicitly by both writers,
 * and the value the start writes into the first of them is a placeholder that
 * gets its own test below.
 *
 * Translation notes, each a rule rather than a local choice:
 *
 * * The source's `cp` fixture is a plain function called inside the test
 *   (conventions rule 8), and the connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1) -- on Windows an open
 *   handle is what fails the temporary-directory cleanup, and the acquisition
 *   site is the only place that knows the acquisition succeeded.
 * * `read_invocation` returns the row or `undefined` for an id that was never
 *   started (`D-0007`: a row that does not exist reads back as `undefined`, not
 *   `null`), so the source's `is None` becomes `toBeUndefined()` while a stored
 *   SQL NULL inside a row stays `toBeNull()`. The two are different facts here
 *   and conflating them would make "no such invocation" and "no such figure"
 *   the same assertion.
 * * The source indexes the returned row directly, which raises in Python if the
 *   row is missing. {@link mustRead} makes that the explicit assertion it
 *   already was, so a missing row is reported as a missing row rather than as an
 *   assertion about `undefined`.
 * * `test_an_unknown_run_reference_is_refused_by_the_foreign_key` expects
 *   `sqlite3.IntegrityError` from the `run` foreign key. better-sqlite3 raises
 *   one error type, so it becomes {@link expectSqliteError} on the **result
 *   code** (`SQLITE_CONSTRAINT*`), which is the durable half of the assertion
 *   (`D-0016`); the message text SQLite prints is not a compatibility surface.
 * * `test_the_seam_refuses_a_mapping_that_is_not_a_provider_usage` expects a
 *   bare `ValueError`. `ai_invocation.py` declares its own
 *   `AiInvocationUsageError(ValueError)` and raises it here, so the port asserts
 *   {@link AiInvocationUsageError} -- the module's own subclass, as
 *   `events.test.ts` does with `EventSpineUsageError`, rather than the
 *   `TypeError` the house convention gives an *untyped* `ValueError`
 *   (`gates.test.ts`, `repo-link.test.ts`). Recorded `adapted`.
 * * Every value read out of a `SELECT` list that is not a plain column
 *   reference is read **positionally** (`.pluck()`), because SQLite promises no
 *   name for one (`D-0021`, `D-0007`).
 * * The `caseRoot` label is `ai`, a short module nickname (`D-0020`). This file
 *   asserts no `match=` pattern at all -- its source uses none -- so no pattern
 *   can be made vacuous by the temp path; the short label keeps it that way for
 *   any pattern a later edit adds.
 * * Two cases claim something about **atomicity** -- that a refused completion
 *   leaves the row untouched, and that it leaves no open transaction -- and both
 *   additionally observe through a **second connection**. A read through the
 *   handle that did the writing is satisfied by that handle's own view, and a
 *   leaked `BEGIN IMMEDIATE` is invisible to the connection holding it; the
 *   second connection is what turns those into claims about what committed and
 *   about what lock is held. Both add assertions and weaken none.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  AiInvocationUsageError,
  CompletionPrecedesStartRefused,
  completeInvocation,
  DuplicateInvocationRefused,
  InvocationAlreadyCompleteRefused,
  InvocationNotStartedRefused,
  MalformedAttemptCountRefused,
  MalformedCeilingRefused,
  MalformedResponseCountRefused,
  NegativeTokenCountRefused,
  OutputExceedsRequestCeilingRefused,
  ProviderUsage,
  readInvocation,
  startInvocation,
  UnknownUsageStatusRefused,
  USAGE_STATUSES,
  UsageStatusContradictsTokensRefused,
  UsageWithoutRecordRefused,
} from "../../src/control_plane/ai_invocation.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

const ADAPTER = "anthropic-adapter/3";
const PROVIDER = "anthropic";
const MODEL = "some-model";

const RUN_ID = "run-1";
const INCIDENT_ID = "inc-1";

/** The result code family a foreign key produces. */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

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
 */
const productionTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/**
 * The source's `db_path` fixture, as a per-test call: a fresh copy of the
 * template in a fresh per-case directory.
 */
function productionDb(): string {
  return productionTemplate.copyInto(caseRoot("ai"));
}

/**
 * The source's `cp` fixture: a production control plane created at `T0`, with
 * the run and the incident an invocation may be attributed to already in it.
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
  addRun(connection);
  addIncident(connection);
  return connection;
}

/**
 * A second connection onto the same file, for the cases that claim something
 * committed -- or that no write lock is still held.
 *
 * A read through the handle that did the writing is satisfied by state only
 * that connection can see; this one can only see what was committed, and a
 * write through it can only succeed if nobody is holding the database.
 */
function secondConnection(cp: SqliteDatabase): SqliteDatabase {
  const connection = new Database(cp.name, { fileMustExist: true });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal surroundings an invocation needs
// --------------------------------------------------------------------------

function addRun(cp: SqliteDatabase, runId: string = RUN_ID, at: number = T0): string {
  cp.prepare<[string, number, number]>(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)" +
      " VALUES (?, 'running', ?, ?)",
  ).run(runId, at, at);
  return runId;
}

function addIncident(
  cp: SqliteDatabase,
  incidentId: string = INCIDENT_ID,
  at: number = T0,
): string {
  cp.prepare<[string, string, string, number, number]>(
    `
        INSERT INTO incident (incident_id, run_id, session_id, fact_state,
                              detector_version, dedup_key, created_at_ms, updated_at_ms)
        VALUES (?, ?, NULL, 'stalled', 'd1', ?, ?, ?)
        `,
  ).run(incidentId, RUN_ID, `dedup/${incidentId}`, at, at);
  return incidentId;
}

/** The keyword arguments the source's `start` helper lets a case override. */
interface StartOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly adapterVersion?: string;
  readonly startedAtMs?: number;
  readonly incidentId?: string | null;
  readonly runId?: string | null;
  readonly maxOutputTokens?: number | null;
}

/** Start an invocation with the ordinary, fully attributed shape. */
function start(cp: SqliteDatabase, invocationId = "inv-1", overrides: StartOverrides = {}): string {
  const fields = {
    provider: PROVIDER,
    model: MODEL,
    adapterVersion: ADAPTER,
    startedAtMs: T0,
    incidentId: INCIDENT_ID as string | null,
    runId: RUN_ID as string | null,
    maxOutputTokens: 1_024 as number | null,
    ...overrides,
  };
  startInvocation(cp, { invocationId, ...fields });
  return invocationId;
}

/**
 * The row, asserted to exist.
 *
 * The source subscripts `read_invocation(...)` directly, which raises in Python
 * when no row came back; this states that expectation where it happens instead
 * of letting it surface as an assertion about `undefined` three lines later.
 */
function mustRead(cp: SqliteDatabase, invocationId: string): Readonly<Record<string, unknown>> {
  const row = readInvocation(cp, invocationId);
  expect(row, `expected invocation ${invocationId} to have been recorded`).toBeDefined();
  return row as Readonly<Record<string, unknown>>;
}

/** `invocation_id`s matching `where`, in the order SQLite returns them. */
function invocationIdsWhere(cp: SqliteDatabase, where: string): string[] {
  return cp
    .prepare<[], string>(`SELECT invocation_id FROM ai_invocation WHERE ${where}`)
    .pluck()
    .all();
}

// --------------------------------------------------------------------------
// section 2.4 -- the request-time record, and what only it can bound
// --------------------------------------------------------------------------

describe("section 2.4 -- the request-time record, and what only it can bound", () => {
  test("a started invocation is readable before any usage arrives", () => {
    const cp = cpFixture();
    // The row exists from request time, because the completion may never
    // happen -- a killed process, a provider that never answers -- and an
    // invocation nobody recorded is one the report cannot even count as missing.
    start(cp);

    const row = readInvocation(cp, "inv-1");
    expect(row).not.toBeUndefined();
    expect(row?.started_at_ms).toBe(T0);
    expect(row?.finished_at_ms).toBeNull();
    expect(row?.usage_status).toBe("unavailable");
    expect(row?.output_tokens).toBeNull();
    expect(row?.max_output_tokens).toBe(1_024);
  });

  test("an in flight invocation is told from one that finished without usage", () => {
    const cp = cpFixture();
    // Both carry usage_status 'unavailable' -- truthfully, in both cases no
    // usage record has arrived. finished_at_ms is the column that separates
    // "still running" from "finished, and the provider told us nothing", and
    // without the distinction every in-flight invocation would be counted as a
    // telemetry loss.
    start(cp, "inv-flight");
    start(cp, "inv-done");
    completeInvocation(cp, {
      invocationId: "inv-done",
      usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
      modelResponseCount: 1,
      finishedAtMs: T0 + 500,
    });

    expect(mustRead(cp, "inv-flight").usage_status).toBe("unavailable");
    expect(mustRead(cp, "inv-flight").finished_at_ms).toBeNull();
    expect(mustRead(cp, "inv-done").usage_status).toBe("unavailable");
    expect(mustRead(cp, "inv-done").finished_at_ms).toBe(T0 + 500);
  });

  test("an unfinished invocation carries a placeholder response count", () => {
    const cp = cpFixture();
    // startInvocation cannot know how many assistant turns the provider will
    // return, so the 1 it writes is a placeholder and not a count. It matters
    // because section 2.4 imputes a non-'reported' invocation at
    // max_output_tokens * model_response_count: a four-turn loop killed
    // mid-request would be bounded at cap * 1, a quarter of its real bound,
    // which UNDERSTATES Interlock's tokens and OVERSTATES the reduction -- the
    // one direction section 2.4 exists to refuse.
    start(cp, "inv-crashed", { maxOutputTokens: 1_024 });
    start(cp, "inv-finished", { maxOutputTokens: 1_024 });
    completeInvocation(cp, {
      invocationId: "inv-finished",
      usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
      modelResponseCount: 4,
      finishedAtMs: T0 + 900,
    });

    const crashed = mustRead(cp, "inv-crashed");
    const finished = mustRead(cp, "inv-finished");
    // The placeholder is the value the started row carries, and completing is
    // the only thing that replaces it with a counted figure. Both halves are
    // asserted so that a start that began writing a real count, or a completion
    // that stopped writing one, fails here.
    expect(crashed.model_response_count).toBe(1);
    expect(finished.model_response_count).toBe(4);

    // finished_at_ms IS NULL is the discriminator, and it is the ONLY one: the
    // two rows are otherwise identical in every column the imputation reads.
    expect(crashed.finished_at_ms).toBeNull();
    expect(finished.finished_at_ms).toBe(T0 + 900);
    expect(crashed.usage_status).toBe("unavailable");
    expect(finished.usage_status).toBe("unavailable");
    expect(crashed.max_output_tokens).toBe(finished.max_output_tokens);

    // A report that imputed the placeholder at the product would bound the
    // crashed invocation below the finished one that ran the same loop. That is
    // the flattering bias, in arithmetic: it must itemise the unfinished rows
    // separately instead.
    const naiveBound =
      (crashed.max_output_tokens as number) * (crashed.model_response_count as number);
    expect(naiveBound).toBeLessThan(
      (finished.max_output_tokens as number) * (finished.model_response_count as number),
    );

    expect(invocationIdsWhere(cp, "finished_at_ms IS NULL")).toEqual(["inv-crashed"]);
  });

  test("an invocation without a ceiling is recorded and stays unbounded", () => {
    const cp = cpFixture();
    // Section 2.4: an invocation with no recorded max_output_tokens "is not
    // imputed at all: it is reported as unbounded_missing", and a report with a
    // non-zero count there cannot support an AC-9 acceptance claim. So the
    // writer must accept it -- refusing would hide a real request -- and the
    // row must stay recognisable afterwards, which is what NULL is doing here.
    start(cp, "inv-uncapped", { maxOutputTokens: null });
    completeInvocation(cp, {
      invocationId: "inv-uncapped",
      usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
      modelResponseCount: 3,
      finishedAtMs: T0 + 10,
    });

    const row = mustRead(cp, "inv-uncapped");
    expect(row.max_output_tokens).toBeNull();
    expect(row.usage_status).not.toBe("reported");
    // The pair (no ceiling, no reported usage) is the whole of the
    // unbounded_missing predicate; nothing later can supply the missing cap,
    // because the usage record that would carry it never arrived.
    expect(
      invocationIdsWhere(cp, "usage_status <> 'reported' AND max_output_tokens IS NULL"),
    ).toEqual(["inv-uncapped"]);
  });

  test("a zero ceiling is refused because it imputes a missing invocation at nothing", () => {
    const cp = cpFixture();
    // A zero cap would make the bound max_output_tokens * model_response_count
    // equal zero -- the treat-missing-as-zero bias arriving through the very
    // column that exists to remove it. null is the honest "no cap was sent";
    // zero is a cap that was never legal.
    expectRefusal(() => start(cp, "inv-zero-cap", { maxOutputTokens: 0 }), MalformedCeilingRefused);
    expectRefusal(() => start(cp, "inv-neg-cap", { maxOutputTokens: -1 }), MalformedCeilingRefused);
    expect(readInvocation(cp, "inv-zero-cap")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// section 2.2 -- what one prompt is, in both directions
// --------------------------------------------------------------------------

describe("section 2.2 -- what one prompt is, in both directions", () => {
  test("the output ceiling is per request times the response count", () => {
    const cp = cpFixture();
    // The DDL comment: "Comparing the summed output against a single request's
    // cap would fail on every tool-using invocation." 3,000 output tokens over
    // four assistant turns against a 1,024 cap is legal (ceiling 4,096) and the
    // identical output over one turn is not.
    start(cp, "inv-loop", { maxOutputTokens: 1_024 });
    completeInvocation(cp, {
      invocationId: "inv-loop",
      usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 3_000 }),
      modelResponseCount: 4,
      finishedAtMs: T0 + 60_000,
    });
    expect(mustRead(cp, "inv-loop").output_tokens).toBe(3_000);

    start(cp, "inv-single", { maxOutputTokens: 1_024 });
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-single",
          usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 3_000 }),
          modelResponseCount: 1,
          finishedAtMs: T0 + 60_000,
        }),
      OutputExceedsRequestCeilingRefused,
    );
    // Refused at the edge, so the row is untouched rather than half-written.
    const refused = mustRead(cp, "inv-single");
    expect(refused.finished_at_ms).toBeNull();
    expect(refused.output_tokens).toBeNull();
    // ... and untouched in what COMMITTED, not merely in this handle's view.
    const committed = secondConnection(cp)
      .prepare<[string], Record<string, unknown>>(
        "SELECT finished_at_ms, output_tokens FROM ai_invocation WHERE invocation_id = ?",
      )
      .get("inv-single");
    expect(committed).toEqual({ finished_at_ms: null, output_tokens: null });
  });

  test("the ceiling is exact at the product and refused one token above", () => {
    const cp = cpFixture();
    // The bound is inclusive: the provider is allowed to return exactly what the
    // caller permitted, and a report that refused the boundary would drop honest
    // invocations out of the covered population.
    start(cp, "inv-exact", { maxOutputTokens: 100 });
    completeInvocation(cp, {
      invocationId: "inv-exact",
      usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 300 }),
      modelResponseCount: 3,
      finishedAtMs: T0 + 1,
    });
    expect(mustRead(cp, "inv-exact").output_tokens).toBe(300);

    start(cp, "inv-over", { maxOutputTokens: 100 });
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-over",
          usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 301 }),
          modelResponseCount: 3,
          finishedAtMs: T0 + 1,
        }),
      OutputExceedsRequestCeilingRefused,
    );
  });

  test("an uncapped invocation admits any reported output", () => {
    const cp = cpFixture();
    // With no ceiling recorded there is nothing to compare against, and
    // inventing one here would be the harness deciding a figure it is supposed
    // to measure. The row's cost is that it can never be imputed (above).
    start(cp, "inv-nocap", { maxOutputTokens: null });
    completeInvocation(cp, {
      invocationId: "inv-nocap",
      usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 1_000_000 }),
      modelResponseCount: 1,
      finishedAtMs: T0 + 1,
    });
    expect(mustRead(cp, "inv-nocap").output_tokens).toBe(1_000_000);
  });

  test("a retry is an attempt and never a response", () => {
    const cp = cpFixture();
    // Section 2.2: "A 429 followed by a successful retry produced one assistant
    // turn; counting it as two would make a flaky network look like AI
    // workload." The two counters are independent columns for that reason, and
    // the ceiling scales with the response count only -- so the retried
    // invocation gets the same 1,024-token ceiling an unretried one would.
    start(cp, "inv-429", { maxOutputTokens: 1_024 });
    completeInvocation(cp, {
      invocationId: "inv-429",
      usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 900 }),
      modelResponseCount: 1,
      attemptCount: 2,
      finishedAtMs: T0 + 3_000,
    });

    const row = mustRead(cp, "inv-429");
    expect(row.attempt_count).toBe(2);
    expect(row.model_response_count).toBe(1);

    start(cp, "inv-429-over", { maxOutputTokens: 1_024 });
    expectRefusal(
      // If attempts had leaked into the response count, this 2,000-token
      // report would have been admitted against a doubled ceiling.
      () =>
        completeInvocation(cp, {
          invocationId: "inv-429-over",
          usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 2_000 }),
          modelResponseCount: 1,
          attemptCount: 2,
          finishedAtMs: T0 + 3_000,
        }),
      OutputExceedsRequestCeilingRefused,
    );
  });

  test("a response count below one is refused", () => {
    const cp = cpFixture();
    // An invocation that reached the provider returned at least one assistant
    // turn. Zero would also zero the imputation product, so it is the ceiling
    // bug wearing a different column's name.
    start(cp, "inv-zero-responses");
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-zero-responses",
          usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
          modelResponseCount: 0,
          finishedAtMs: T0 + 1,
        }),
      MalformedResponseCountRefused,
    );
  });

  test("an attempt count below one is refused", () => {
    const cp = cpFixture();
    // The first send is an attempt; a zero describes an invocation that was
    // never transmitted and therefore has no usage to report at all.
    start(cp, "inv-zero-attempts");
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-zero-attempts",
          usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
          modelResponseCount: 1,
          attemptCount: 0,
          finishedAtMs: T0 + 1,
        }),
      MalformedAttemptCountRefused,
    );
  });
});

// --------------------------------------------------------------------------
// section 2.3 -- the provider seam, and only the provider seam
// --------------------------------------------------------------------------

describe("section 2.3 -- the provider seam, and only the provider seam", () => {
  test("a reported usage round trips every column of the seam", () => {
    const cp = cpFixture();
    // Cache-read tokens are carried in their own column and are neither an
    // output nor an input figure (ACCEPTANCE.md section 5). A seam that folded
    // them into either would move a bandwidth indicator into AC-9's arithmetic.
    start(cp, "inv-full");
    completeInvocation(cp, {
      invocationId: "inv-full",
      usage: ProviderUsage.reported({
        adapterVersion: "anthropic-adapter/4",
        outputTokens: 512,
        inputTokens: 2_048,
        cacheReadTokens: 99_000,
      }),
      modelResponseCount: 2,
      attemptCount: 1,
      finishedAtMs: T0 + 7_000,
    });

    const row = mustRead(cp, "inv-full");
    expect(row.usage_status).toBe("reported");
    expect(row.output_tokens).toBe(512);
    expect(row.input_tokens).toBe(2_048);
    expect(row.cache_read_tokens).toBe(99_000);
    expect(row.model_response_count).toBe(2);
    expect(row.finished_at_ms).toBe(T0 + 7_000);
    // The version that PARSED the usage is what the three figures are qualified
    // by, so the completion's adapter version is the one the report's
    // adapter_versions set (section 6) will see.
    expect(row.adapter_version).toBe("anthropic-adapter/4");
  });

  test("a partial usage keeps the fields that did arrive", () => {
    const cp = cpFixture();
    // 'partial' is "some fields present, output_tokens absent". Discarding the
    // input and cache figures because the headline one is missing would throw
    // away facts the report prints as their own series -- and imputing this row
    // is still correct, which is why it is not merged into 'unavailable'.
    start(cp, "inv-partial");
    completeInvocation(cp, {
      invocationId: "inv-partial",
      usage: ProviderUsage.partial({
        adapterVersion: ADAPTER,
        inputTokens: 1_500,
        cacheReadTokens: 42,
      }),
      modelResponseCount: 2,
      finishedAtMs: T0 + 900,
    });

    const row = mustRead(cp, "inv-partial");
    expect(row.usage_status).toBe("partial");
    expect(row.output_tokens).toBeNull();
    expect(row.input_tokens).toBe(1_500);
    expect(row.cache_read_tokens).toBe(42);
    expect(row.finished_at_ms).toBe(T0 + 900);
  });

  test("an unavailable usage round trips as a completed invocation with no figures", () => {
    const cp = cpFixture();
    // The status is the fact. Nothing here writes a zero, because a zero would
    // be read by the report as a measured figure and would understate
    // Interlock's token use -- overstating the reduction in the criterion the
    // reduction is judged by.
    start(cp, "inv-none");
    completeInvocation(cp, {
      invocationId: "inv-none",
      usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
      modelResponseCount: 1,
      finishedAtMs: T0 + 20,
    });

    const row = mustRead(cp, "inv-none");
    expect(row.usage_status).toBe("unavailable");
    expect([row.output_tokens, row.input_tokens, row.cache_read_tokens]).toEqual([
      null,
      null,
      null,
    ]);
    expect(row.finished_at_ms).toBe(T0 + 20);
  });

  test("unavailable alongside a usage figure is refused", () => {
    const cp = cpFixture();
    // 'unavailable' means no usage record at all, so an input figure under it is
    // evidence that one arrived and the ledger cannot say which half is wrong.
    // A record that arrived incomplete is 'partial'; that is why it exists.
    start(cp, "inv-contradiction");
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-contradiction",
          usage: new ProviderUsage({
            usageStatus: "unavailable",
            adapterVersion: ADAPTER,
            inputTokens: 10,
          }),
          modelResponseCount: 1,
          finishedAtMs: T0 + 1,
        }),
      UsageWithoutRecordRefused,
    );
  });

  parametrize<ProviderUsage>(
    "the status and the output figure must agree",
    [
      // 'reported' with nothing to report: it would count as covered while
      // adding nothing to the token sum, which understates usage exactly as
      // imputing zero does.
      [
        "usage0",
        new ProviderUsage({
          usageStatus: "reported",
          adapterVersion: ADAPTER,
          outputTokens: null,
        }),
      ],
      // A missing-status row carrying tokens: the report imputes over it and
      // counts the invocation twice.
      [
        "usage1",
        new ProviderUsage({ usageStatus: "partial", adapterVersion: ADAPTER, outputTokens: 7 }),
      ],
    ],
    (usage) => {
      const cp = cpFixture();
      start(cp, "inv-disagree");
      expectRefusal(
        () =>
          completeInvocation(cp, {
            invocationId: "inv-disagree",
            usage,
            modelResponseCount: 1,
            finishedAtMs: T0 + 1,
          }),
        UsageStatusContradictsTokensRefused,
      );
    },
  );

  test("a status outside the closed set is refused", () => {
    const cp = cpFixture();
    // An unknown status belongs to no branch of the coverage arithmetic, so the
    // invocation would exist and appear in no denominator at all.
    expect(USAGE_STATUSES).toEqual(["reported", "partial", "unavailable"]);
    start(cp, "inv-bad-status");
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-bad-status",
          usage: new ProviderUsage({
            usageStatus: "probably_fine",
            adapterVersion: ADAPTER,
          }),
          modelResponseCount: 1,
          finishedAtMs: T0 + 1,
        }),
      UnknownUsageStatusRefused,
    );
  });

  parametrize<ProviderUsage>(
    "a negative token count is refused on every figure",
    [
      [
        "usage0",
        new ProviderUsage({ usageStatus: "reported", adapterVersion: ADAPTER, outputTokens: -1 }),
      ],
      [
        "usage1",
        new ProviderUsage({ usageStatus: "partial", adapterVersion: ADAPTER, inputTokens: -1 }),
      ],
      [
        "usage2",
        new ProviderUsage({
          usageStatus: "partial",
          adapterVersion: ADAPTER,
          cacheReadTokens: -1,
        }),
      ],
    ],
    (usage) => {
      const cp = cpFixture();
      // The DDL guards output_tokens alone; the other two are guarded here against
      // the same failure. A negative count subtracts from the period's total and
      // can only move the measured reduction upward.
      start(cp, "inv-negative");
      expectRefusal(
        () =>
          completeInvocation(cp, {
            invocationId: "inv-negative",
            usage,
            modelResponseCount: 1,
            finishedAtMs: T0 + 1,
          }),
        NegativeTokenCountRefused,
      );
    },
  );

  test("the seam refuses a mapping that is not a provider usage", () => {
    const cp = cpFixture();
    // The seam is a typed object so a dict carrying a provider's own field names
    // cannot cross it. This is what keeps "nothing else in the harness is
    // provider-shaped" true rather than aspirational.
    start(cp, "inv-raw-dict");
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-raw-dict",
          usage: { output_tokens: 5, usage_status: "reported" } as unknown as ProviderUsage,
          modelResponseCount: 1,
          finishedAtMs: T0 + 1,
        }),
      AiInvocationUsageError,
    );
  });
});

// --------------------------------------------------------------------------
// section 2.2 -- AC-1 is measured from these rows
// --------------------------------------------------------------------------

describe("section 2.2 -- AC-1 is measured from these rows", () => {
  test("an invocation without an incident is recorded and identifiable", () => {
    const cp = cpFixture();
    // "Zero AI turns absent incidents" is the assertion that every row here has
    // an incident_id. Refusing the row would erase the only evidence the
    // violation happened and make AC-1 true by construction, so the writer
    // accepts it and the report itemises it.
    start(cp, "inv-orphan", { incidentId: null });
    completeInvocation(cp, {
      invocationId: "inv-orphan",
      usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 10 }),
      modelResponseCount: 1,
      finishedAtMs: T0 + 5,
    });
    start(cp, "inv-attributed");

    expect(mustRead(cp, "inv-orphan").incident_id).toBeNull();
    expect(invocationIdsWhere(cp, "incident_id IS NULL")).toEqual(["inv-orphan"]);
  });

  test("an invocation may name a run without an incident and the reverse", () => {
    const cp = cpFixture();
    // Both attribution columns are nullable and independent: an invocation
    // triggered outside any run is as recordable as one whose incident was not
    // written. Making either mandatory would push the same evidence out of the
    // table.
    start(cp, "inv-run-only", { incidentId: null, runId: RUN_ID });
    start(cp, "inv-incident-only", { incidentId: INCIDENT_ID, runId: null });

    expect(mustRead(cp, "inv-run-only").run_id).toBe(RUN_ID);
    expect(mustRead(cp, "inv-incident-only").run_id).toBeNull();
  });
});

// --------------------------------------------------------------------------
// append, then ONE usage fill-in (production-schema.md section 4)
// --------------------------------------------------------------------------

describe("append, then ONE usage fill-in (production-schema.md section 4)", () => {
  test("a second completion is refused rather than overwriting the first", () => {
    const cp = cpFixture();
    // The row takes exactly one fill-in. A second report -- a duplicated
    // callback, a re-parse, a second adapter -- is a different fact, and
    // overwriting would replace evidence with the most recent claim about it.
    start(cp, "inv-twice");
    completeInvocation(cp, {
      invocationId: "inv-twice",
      usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 100 }),
      modelResponseCount: 1,
      finishedAtMs: T0 + 10,
    });
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-twice",
          usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 999 }),
          modelResponseCount: 5,
          finishedAtMs: T0 + 20,
        }),
      InvocationAlreadyCompleteRefused,
    );

    const row = mustRead(cp, "inv-twice");
    expect(row.output_tokens).toBe(100);
    expect(row.model_response_count).toBe(1);
    expect(row.finished_at_ms).toBe(T0 + 10);
  });

  test("completing an invocation that was never started is refused", () => {
    const cp = cpFixture();
    // The fill-in is not an upsert: inserting here would invent a started_at_ms
    // out of the completion instant, giving every such invocation a zero latency
    // and no recorded ceiling.
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-never",
          usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
          modelResponseCount: 1,
          finishedAtMs: T0 + 1,
        }),
      InvocationNotStartedRefused,
    );
    expect(readInvocation(cp, "inv-never")).toBeUndefined();
  });

  test("starting the same invocation id twice is refused", () => {
    const cp = cpFixture();
    // invocation_id is this single writer's idempotency key, so a repeat is not
    // a benign re-poll: it would make two invocations indistinguishable in every
    // report.
    start(cp, "inv-dup", { startedAtMs: T0 });
    expectRefusal(
      () => start(cp, "inv-dup", { startedAtMs: T0 + 5_000 }),
      DuplicateInvocationRefused,
    );

    expect(mustRead(cp, "inv-dup").started_at_ms).toBe(T0);
  });

  test("a completion before its own start is refused", () => {
    const cp = cpFixture();
    // Latency is measured off started_at_ms and finished_at_ms, so a negative
    // duration is a mixed clock rather than a small number. The clock is the
    // caller's (time-base-policy.md section 2), which is what makes this
    // checkable at all.
    start(cp, "inv-backwards", { startedAtMs: T0 });
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-backwards",
          usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
          modelResponseCount: 1,
          finishedAtMs: T0 - 1,
        }),
      CompletionPrecedesStartRefused,
    );
    expect(mustRead(cp, "inv-backwards").finished_at_ms).toBeNull();
  });

  test("a completion at the start instant is legal", () => {
    const cp = cpFixture();
    // The DDL admits equality and so does this: a sub-millisecond invocation is
    // unlikely, not impossible, and refusing it would drop a real row for the
    // sake of a strict inequality nothing needs.
    start(cp, "inv-instant", { startedAtMs: T0 });
    completeInvocation(cp, {
      invocationId: "inv-instant",
      usage: ProviderUsage.unavailable({ adapterVersion: ADAPTER }),
      modelResponseCount: 1,
      finishedAtMs: T0,
    });
    expect(mustRead(cp, "inv-instant").finished_at_ms).toBe(T0);
  });
});

// --------------------------------------------------------------------------
// the transaction boundary
// --------------------------------------------------------------------------

describe("the transaction boundary", () => {
  test("a refused completion leaves no open transaction", () => {
    const cp = cpFixture();
    // Both calls take one transaction from txn.ts, so a refusal raised from
    // inside the block must have rolled it back before it reached the caller. A
    // leaked write lock would stall every other writer on the spine, and the
    // symptom would appear nowhere near this module.
    start(cp, "inv-rollback");
    expectRefusal(
      () =>
        completeInvocation(cp, {
          invocationId: "inv-rollback",
          usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 99_999 }),
          modelResponseCount: 1,
          finishedAtMs: T0 + 1,
        }),
      OutputExceedsRequestCeilingRefused,
    );

    expect(cp.inTransaction).toBe(false);
    // `inTransaction` is this handle's own bookkeeping, and a leaked
    // BEGIN IMMEDIATE is exactly what the handle holding it cannot see. Another
    // writer can: this INSERT is refused with SQLITE_BUSY while the lock is
    // held, which is the stall the case is named for.
    secondConnection(cp)
      .prepare<[number, number]>(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)" +
          " VALUES ('run-2', 'running', ?, ?)",
      )
      .run(T0, T0);

    // And the invocation is still completable afterwards with a truthful figure.
    completeInvocation(cp, {
      invocationId: "inv-rollback",
      usage: ProviderUsage.reported({ adapterVersion: ADAPTER, outputTokens: 1_000 }),
      modelResponseCount: 1,
      finishedAtMs: T0 + 1,
    });
    expect(mustRead(cp, "inv-rollback").output_tokens).toBe(1_000);
  });

  test("an unknown run reference is refused by the foreign key", () => {
    const cp = cpFixture();
    // The attribution columns are foreign keys and the connection runs with
    // PRAGMA foreign_keys = ON, so an invocation cannot be attributed to a run
    // that does not exist -- which would leave the AC-9 cohort join silently
    // short of a row it should have counted.
    expectSqliteError(() => start(cp, "inv-ghost-run", { runId: "run-does-not-exist" }), {
      code: CONSTRAINT,
    });
    expect(readInvocation(cp, "inv-ghost-run")).toBeUndefined();
  });
});
