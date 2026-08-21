import { onTestFinished } from "vitest";

/**
 * `monkeypatch.setattr` for a seam record, with pytest's restore semantics.
 *
 * pytest's `monkeypatch` remembers the value that was present **at the moment
 * of each patch** and undoes the patches in reverse order at teardown. Both
 * halves matter and neither is what a naive `afterEach` restore gives you:
 *
 * - *Snapshot at patch time, not at first patch.* A test that patches the same
 *   key twice -- as the verify-reopen-gap cases do, re-patching from inside the
 *   wrapper to disarm it -- ends up with two recorded values. Undoing them in
 *   reverse restores the original, and undoing only the first would leave the
 *   wrapper installed.
 * - *LIFO.* Reverse order is what makes a stack of patches unwind to exactly
 *   the state before the first one, whatever order they were applied in.
 *
 * `vi.spyOn` plus `restoreAllMocks` reproduces neither reliably, and it cannot
 * touch a plain data key such as a timeout constant at all.
 *
 * The undo is registered with `onTestFinished` so it runs whether the test
 * passes or fails, and so it is scoped to the test rather than to the file --
 * under a shuffled order, a patch that outlived its test would fail a different
 * test each run.
 */
export function patchSeam<T extends object, K extends keyof T>(
  record: T,
  key: K,
  value: T[K],
): void {
  const previous = record[key];
  const had = Object.hasOwn(record, key);
  record[key] = value;
  onTestFinished(() => {
    if (had) {
      record[key] = previous;
    } else {
      delete record[key];
    }
  });
}

/**
 * Patch several keys of one seam record at once.
 *
 * Applied in the object's own key order and undone in reverse, so the whole
 * group unwinds like a single stack frame.
 */
export function patchSeams<T extends object>(record: T, overrides: Partial<T>): void {
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    patchSeam(record, key, overrides[key] as T[keyof T]);
  }
}
