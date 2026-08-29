/**
 * The attention belt's shared fixtures -- interlock `tests/attention/conftest.py`, plus the two
 * things a Node port needs that a pytest one does not.
 *
 * Belt-local rather than in `test/testkit/`: the testkit is frozen (`docs/
 * test-translation-conventions.md`), and nothing outside this belt builds a fake `state.db` or a
 * broker journal. Promotion is a later PR's question, not this belt's.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import { onTestFinished, vi } from "vitest";

/** One row the fake `events` table may carry. Missing keys take the SQL defaults. */
export interface FakeEvent {
  readonly occurred_at?: string;
  readonly actor?: string | null;
  readonly kind: string;
  readonly payload?: unknown;
}

/**
 * Create a minimal `state.db` with an `events` table.
 *
 * The schema mirrors the state-database schema the source projects from; only the columns the
 * attention reader touches are present, and the defaults are the source's.
 */
export function makeStateDb(dbPath: string, events: Iterable<FakeEvent>): string {
  mkdirSync(dirname(dbPath), { recursive: true });
  const connection = new Database(dbPath);
  try {
    connection.exec(`
      CREATE TABLE events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at  TEXT NOT NULL DEFAULT '2026-05-12T00:00:00Z',
        actor        TEXT,
        kind         TEXT NOT NULL,
        run_id       INTEGER,
        workstream_id INTEGER,
        project_id   INTEGER,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    const insert = connection.prepare(
      "INSERT INTO events (occurred_at, actor, kind, payload_json) VALUES (?, ?, ?, ?)",
    );
    for (const event of events) {
      insert.run(
        event.occurred_at ?? "2026-05-12T00:00:00Z",
        event.actor ?? null,
        event.kind,
        JSON.stringify(event.payload ?? {}),
      );
    }
  } finally {
    connection.close();
  }
  return dbPath;
}

/** interlock's `write_pending_decisions`. */
export function writePendingDecisions(path: string, entries: readonly unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf8");
  return path;
}

/** Write `queue.jsonl` lines the way the broker's own journal writer does. */
export function writeJournal(stateDir: string, records: readonly unknown[]): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "queue.jsonl");
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  return path;
}

/** Append raw text to an existing journal, for the malformed-line cases. */
export function appendJournalText(path: string, text: string): void {
  appendFileSync(path, text, "utf8");
}

/**
 * pytest's `capsys`, narrowed to stderr.
 *
 * The subject really is the rendered stderr text: the reader warns with a `print(file=sys.stderr)`
 * and the source's cases read it back through `capsys`, asserting on substrings and on emptiness.
 * `docs/test-translation-conventions.md` rule 7 is about `caplog`, which is an assertion over log
 * *records*; there is no record here to assert about, and inventing a `LogSink` seam would put a
 * test-shaped indirection in a production path the source reaches directly. The precedent is
 * `test/measurement/cli.test.ts`'s own `captureStderr`.
 *
 * Restored with `onTestFinished` rather than a bare `finally`, so a failing assertion inside the
 * action cannot leave the spy installed for whatever the shuffle runs next.
 */
export function capturedStderr<T>(action: () => T): { readonly value: T; readonly err: string } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  onTestFinished(() => {
    spy.mockRestore();
  });
  const value = action();
  spy.mockRestore();
  return { value, err: chunks.join("") };
}
