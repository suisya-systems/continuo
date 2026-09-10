/**
 * What one control-plane commit costs on this runner, and how much of that is
 * durability.
 *
 * The suite's own numbers say where the Windows cell's wall clock goes but not
 * why: `test/canary/audit.test.ts` takes 1.4s on ubuntu and 87.9s on windows
 * for the same 20 cases on the same commit, and a per-file duration cannot tell
 * an fsync that is slow on that filesystem apart from a virus scanner walking
 * the files each commit touches. This measures the unit both explanations are
 * denominated in, so the suite-level arms alongside it have a cost per commit
 * to be divided by.
 *
 * Journal mode is one of the two axes rather than a constant, because the
 * control plane is deliberately NOT in WAL: `src/control_plane/connection.ts`
 * and `src/canary/ledger.ts` both stay on SQLite's rollback journal, which
 * creates and deletes a `-journal` file per transaction. That is a different
 * cost from a WAL append under both candidate explanations -- more fsyncs, and
 * two directory entries per commit for a scanner to notice -- so a WAL-only
 * number would be the wrong denominator for the files being profiled. `delete`
 * is the mode those files actually run in; `wal` is here as the contrast.
 *
 * ASCII only: this prints on the cp932 Windows console
 * (docs/cli-output-policy.md).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

/** Commits per arm. Small enough to stay under a minute on the slow runner. */
const COMMITS = 200;

/** Databases created and thrown away per arm, for the open/create half. */
const CREATES = 50;

const root = mkdtempSync(join(tmpdir(), "continuo-profile-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A profile run that cannot clean up has still produced its numbers.
  }
});

let counter = 0;
function openDatabase(journal, synchronous) {
  const path = join(root, `plane-${counter++}.db`);
  const connection = new Database(path);
  // `delete` is SQLite's default and therefore what the control plane gets;
  // it is set explicitly so that the two arms differ in exactly this pragma.
  connection.pragma(`journal_mode = ${journal}`);
  connection.pragma("foreign_keys = ON");
  connection.pragma(`synchronous = ${synchronous}`);
  connection.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
  return { connection, path };
}

function millis(work) {
  const started = process.hrtime.bigint();
  work();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function report(label, total, n, unit) {
  const per = (total / n).toFixed(3);
  console.log(
    `  ${label.padEnd(44)} ${total.toFixed(0).padStart(7)}ms total  ${per.padStart(9)}ms/${unit}`,
  );
}

console.log(`platform ${process.platform} node ${process.version} tmp ${root}`);

console.log("\ncommit cost, one INSERT per transaction:");
for (const journal of ["delete", "wal"]) {
  for (const synchronous of ["FULL", "NORMAL", "OFF"]) {
    const { connection } = openDatabase(journal, synchronous);
    const insert = connection.prepare("INSERT INTO t (v) VALUES (?)");
    const commit = connection.transaction((v) => insert.run(v));
    // One warm commit outside the measurement: the first one pays for the
    // journal file's creation, which is the create arm's business.
    commit("warmup");
    report(
      `journal_mode = ${journal}, synchronous = ${synchronous}`,
      millis(() => {
        for (let i = 0; i < COMMITS; i++) {
          commit(`row-${i}`);
        }
      }),
      COMMITS,
      "commit",
    );
    connection.close();
  }
}

console.log("\ndatabase create + schema + close, the per-case fixture cost:");
for (const journal of ["delete", "wal"]) {
  for (const synchronous of ["FULL", "OFF"]) {
    report(
      `journal_mode = ${journal}, synchronous = ${synchronous}`,
      millis(() => {
        for (let i = 0; i < CREATES; i++) {
          openDatabase(journal, synchronous).connection.close();
        }
      }),
      CREATES,
      "database",
    );
  }
}

console.log("\nplain file write + delete, no SQLite, for the scanner's share:");
const payload = Buffer.alloc(64 * 1024, 7);
report(
  "64KiB create/delete",
  millis(() => {
    for (let i = 0; i < CREATES; i++) {
      const path = join(root, `blob-${i}.bin`);
      writeFileSync(path, payload);
      rmSync(path);
    }
  }),
  CREATES,
  "file",
);
