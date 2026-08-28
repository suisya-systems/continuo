/**
 * The populated control plane a whole measurement report is built over.
 *
 * Interlock's `tests/measurement/test_render.py` declares this as the `db`
 * pytest fixture and `tests/measurement/test_query_catalogue.py` imports it
 * straight from there -- free on that runner, because pytest collects a module
 * once however many times it is imported. Vitest collects per **file**, so
 * importing `render.test.ts` from `query-catalogue.test.ts` would register the
 * render belt's cases a second time under the importing file's name. The shared
 * half therefore moves here, to a module the runner does not collect, exactly as
 * `report-reading.ts` did for the render and CLI belts and `module-scan.ts` did
 * for the known-holes and query-catalogue belts.
 *
 * Nothing about the fixture changed in the move: the same rows, written by the
 * same writers, at the same fixed clock. Sharing it rather than copying it is
 * the point -- the query-catalogue belt asserts that *every* catalogued query
 * was one the report ran, and a second fixture that quietly stopped writing an
 * `ai_invocation` row would take a catalogue entry out of the observed set and
 * turn that case red for a reason that has nothing to do with the catalogue.
 */

import Database, { type Database as SqliteDatabase } from "better-sqlite3";

import {
  completeInvocation,
  ProviderUsage,
  startInvocation,
} from "../../src/control_plane/ai_invocation.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { suiteTemplate } from "../testkit/cases.js";
import { REPORT_CLOCK } from "./report-reading.js";

const { PERIOD_START, T0 } = REPORT_CLOCK;

/**
 * An ordinary writable connection, deliberately separate from the harness's.
 *
 * The measurement handle cannot write, which is the point of it; every row these
 * tests need therefore arrives through a second connection that can.
 */
export function withWriter<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = new Database(path, { fileMustExist: true });
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

export function addRun(cp: SqliteDatabase, runId: string): void {
  cp.pragma("foreign_keys = ON");
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'completed', ?, ?)",
  ).run(runId, PERIOD_START + 1_000, PERIOD_START + 2_000);
}

export function addIncident(
  cp: SqliteDatabase,
  options: {
    readonly incidentId: string;
    readonly runId: string;
    readonly detectorVersion: string;
  },
): void {
  cp.prepare(
    `
        INSERT INTO incident (incident_id, run_id, session_id, fact_state,
                              detector_version, dedup_key, created_at_ms,
                              updated_at_ms)
        VALUES (?, ?, NULL, 'stalled', ?, ?, ?, ?)
        `,
  ).run(
    options.incidentId,
    options.runId,
    options.detectorVersion,
    `dedup/${options.incidentId}`,
    PERIOD_START + 1_500,
    PERIOD_START + 1_500,
  );
}

export function addInvocation(
  cp: SqliteDatabase,
  options: {
    readonly invocationId: string;
    readonly adapterVersion: string;
    readonly runId: string;
  },
): void {
  startInvocation(cp, {
    invocationId: options.invocationId,
    provider: "anthropic",
    model: "a-model",
    adapterVersion: options.adapterVersion,
    startedAtMs: PERIOD_START + 1_600,
    incidentId: "inc-1",
    runId: options.runId,
    maxOutputTokens: 4_096,
  });
  completeInvocation(cp, {
    invocationId: options.invocationId,
    usage: ProviderUsage.reported({
      adapterVersion: options.adapterVersion,
      outputTokens: 512,
      inputTokens: 2_048,
      cacheReadTokens: 9_000,
    }),
    modelResponseCount: 3,
    finishedAtMs: PERIOD_START + 1_900,
  });
}

/**
 * The source's `db` fixture, built once per test file and copied per case.
 *
 * Every case that takes it gets the same rows written by the same writers at the
 * same fixed clock, so there is nothing per-case for the build to depend on --
 * which is exactly the shape `suiteTemplate` exists for (`D-0025`). The copy is
 * the case's own writable file; nothing is shared at runtime.
 *
 * The `suiteTemplate` call runs while the importing file is being collected,
 * which is the top-level position `createSuiteDir` requires: this module is
 * imported from the importing test file's own top level, and each test file gets
 * its own instance of it, so the `afterAll` that removes the directory is
 * registered on that file's collector.
 */
export const reportFixtureTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
  withWriter(path, (cp) => {
    addRun(cp, "run-1");
    addIncident(cp, { incidentId: "inc-1", runId: "run-1", detectorVersion: "detector/1" });
    addInvocation(cp, { invocationId: "inv-1", adapterVersion: "adapter/1", runId: "run-1" });
  });
});
