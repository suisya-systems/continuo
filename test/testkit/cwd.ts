import process from "node:process";

import { onTestFinished } from "vitest";

/**
 * `monkeypatch.chdir`.
 *
 * The process working directory is global to the worker, so a test that changes
 * it and does not change it back moves every test that runs after it in that
 * worker -- and under a shuffled order, that is a different test each run. The
 * restore is registered before the change, and with `onTestFinished` so it runs
 * on failure too.
 *
 * Scoped to a worker, not to the run: Vitest gives each test file its own
 * worker process, so this cannot leak across files. That is a property of the
 * runner rather than of this helper, which is why the restore is still
 * unconditional.
 */
export function chdirForTest(directory: string): void {
  const previous = process.cwd();
  onTestFinished(() => {
    process.chdir(previous);
  });
  process.chdir(directory);
}
