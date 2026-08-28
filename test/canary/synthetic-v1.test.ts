/**
 * The stand-in counterparty's store: append-only, and refused when broken.
 *
 * Ported from interlock `tests/canary/test_synthetic_v1.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping is recorded in the parity
 * ledger.
 *
 * The source file has no section banners, so the whole file is one `describe`
 * carrying its module docstring.
 *
 * Two of these cases are about **bytes on disk** rather than about a return
 * value -- the append-only prefix check and the torn tail -- and they are the
 * ones a translation is most able to sever, because a port that reads, parses
 * and rewrites the file satisfies every record-level assertion while failing
 * the property the case is named after. They read the raw file, as the source
 * does.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { SyntheticStoreRefusal, SyntheticV1RunStore } from "../../src/canary/synthetic_v1.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

const T0 = 1_700_000_000_000;

/**
 * The source's `store` fixture: a freshly created, empty store under the case's
 * own `tmp_path`.
 *
 * A function call rather than a `beforeEach`, per convention rule 8: the source
 * fixture is function-scoped, and the call site is where a case can also see
 * the directory it landed in.
 *
 * The `caseRoot` label is a short nickname on purpose (D-0020): the directory
 * name is interpolated into every refusal message under test here, and a label
 * sharing a word with one of them ("exists", "record", "run") would make a
 * `match` that is a *search* unfailable.
 */
function newStore(): SyntheticV1RunStore {
  return SyntheticV1RunStore.create(join(caseRoot("cnry-syn"), "synthetic-v1-runs.jsonl"));
}

/** The store's file as text, which is what the append-only case compares. */
function textOf(store: SyntheticV1RunStore): string {
  return readFileSync(store.path, "utf-8");
}

describe("the stand-in counterparty's store", () => {
  test("creation refuses an existing path", () => {
    // The source requests `tmp_path` here and does not use it: the `store`
    // fixture has already created the file this case tries to create again.
    const store = newStore();

    expectRefusal(
      () => SyntheticV1RunStore.create(store.path),
      SyntheticStoreRefusal,
      /already exists/,
    );
  });

  test("a run starts once", () => {
    const store = newStore();
    store.startRun("run-1", { nowMs: T0 });

    // A later timestamp, so the refusal is keyed on the id and not on the time.
    expectRefusal(
      () => store.startRun("run-1", { nowMs: T0 + 1 }),
      SyntheticStoreRefusal,
      /already started/,
    );
  });

  test("finishing appends rather than edits", () => {
    // Append-only: the run_started record survives the finish verbatim, so the
    // store's history -- like the ledger's -- is never rewritten.
    const store = newStore();
    store.startRun("run-1", { nowMs: T0 });
    const before = textOf(store);
    store.finishRun("run-1", { nowMs: T0 + 5 });
    const after = textOf(store);

    expect(after.startsWith(before)).toBe(true);
    expect(store.records().map((record) => record["record"])).toEqual([
      "run_started",
      "run_finished",
    ]);
  });

  test("a finish needs a start and happens once", () => {
    const store = newStore();

    // Against a zero-byte store: records() must answer "no records" here rather
    // than confuse an empty file with a missing one.
    expectRefusal(
      () => store.finishRun("run-ghost", { nowMs: T0 }),
      SyntheticStoreRefusal,
      /never started/,
    );

    store.startRun("run-1", { nowMs: T0 });
    store.finishRun("run-1", { nowMs: T0 + 1 });

    expectRefusal(
      () => store.finishRun("run-1", { nowMs: T0 + 2 }),
      SyntheticStoreRefusal,
      /already finished/,
    );
  });

  test("a broken store is refused, not read as empty", () => {
    // An audit over a store read as empty is an audit that proves nothing, so
    // R3's refusal discipline applies to the stand-in too.
    const root = caseRoot("cnry-syn");
    const broken = join(root, "broken.jsonl");
    writeFileSync(
      broken,
      '{"record": "run_started", "run_id": "run-1", "at_ms": 1}\nnot json\n',
      "utf-8",
    );

    // The first line is a valid record, so a reader that returned the
    // parseable prefix would pass a weaker version of this case and fail this
    // one. The source's `match` is an alternation and is kept as one.
    expectRefusal(
      () => new SyntheticV1RunStore(broken).records(),
      SyntheticStoreRefusal,
      /refused|not a record/,
    );

    // Constructed outside the refusal assertion, exactly as the source does:
    // construction touches no filesystem, and only the read refuses.
    expectRefusal(
      () => new SyntheticV1RunStore(join(root, "absent.jsonl")).records(),
      SyntheticStoreRefusal,
      /does not exist/,
    );
  });

  test("a record without a run_id is refused", () => {
    const keyless = join(caseRoot("cnry-syn"), "keyless.jsonl");
    writeFileSync(keyless, '{"record": "run_started", "at_ms": 1}\n', "utf-8");

    expectRefusal(
      () => new SyntheticV1RunStore(keyless).records(),
      SyntheticStoreRefusal,
      /run_id/,
    );
  });

  test("an append does not fuse onto a torn tail", () => {
    // A crash can leave the final record byte-complete but missing its newline;
    // records() still reads that store, so the next legitimate append must not
    // weld two records onto one line and turn a readable store into a refused
    // one.
    const store = newStore();
    store.startRun("run-1", { nowMs: T0 });
    const torn = textOf(store).replace(/\n+$/u, "");
    writeFileSync(store.path, torn, "utf-8");

    expect(store.records()).toHaveLength(1); // readable despite the torn tail

    store.startRun("run-2", { nowMs: T0 + 1 });

    expect(store.records().map((record) => record["run_id"])).toEqual(["run-1", "run-2"]);
  });

  test("run ids answer the audit question", () => {
    const store = newStore();
    store.startRun("run-b", { nowMs: T0 });
    store.startRun("run-a", { nowMs: T0 + 1 });
    store.finishRun("run-b", { nowMs: T0 + 2 });

    // Sorted and deduplicated: the file order is run-b, run-a, run-b, and the
    // finish record must not produce a third entry.
    expect(store.runIds()).toEqual(["run-a", "run-b"]);
  });
});
