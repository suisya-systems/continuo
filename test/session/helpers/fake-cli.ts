import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { patchSeam } from "../../testkit/seams.js";

/**
 * The `fake_cli` and `spawn_log` fixtures of interlock's
 * `tests/session/test_claude_cli_provider.py` (`65f36c5`), and the typed switch
 * board for the fake CLI's environment.
 *
 * The program itself is `./fake-claude.mjs`; read its header first, because
 * everything here is about *placing* it and *configuring* it, and both are
 * places where a plausible shortcut changes what the 65 cases assert.
 */

/**
 * The version string the fake prints for `--version`. The source's module
 * constant of the same name.
 */
export const FAKE_VERSION = "9.9.9-fake (Claude Code)";

/** The filename the fake is copied to, and the name the recorded `argv` shows. */
export const FAKE_CLI_FILENAME = "fake-claude.mjs";

/**
 * The fake's source text, read once per test file.
 *
 * Read rather than `copyFileSync`'d because the same read pays for the drift
 * check below. ~9 KB read once per worker against ~65 writes of it is not a
 * cost worth optimising.
 */
const SCRIPT_PATH = fileURLToPath(new URL(`./${FAKE_CLI_FILENAME}`, import.meta.url));
const SCRIPT_TEXT = readFileSync(SCRIPT_PATH, "utf8");

/**
 * `FAKE_VERSION` is declared twice -- once here, once in the program -- and
 * this is the check that keeps the two the same string.
 *
 * The source has no such problem: its fake is an f-string and the constant is
 * interpolated into it, so there is exactly one spelling. A standalone program
 * cannot import a value from the test that launches it, so the duplication is
 * forced; what is not forced is letting it drift. Three cases compare the
 * provider's reported `provider_version` against {@link FAKE_VERSION}, and if
 * the program printed something else those cases would fail with a diff between
 * two version strings, which reads as a provider defect rather than as a helper
 * that fell out of step.
 *
 * At module load, so it names the real problem before any case runs.
 */
const VERSION_DECLARATION = `const FAKE_VERSION = ${JSON.stringify(FAKE_VERSION)};`;
if (!SCRIPT_TEXT.includes(VERSION_DECLARATION)) {
  throw new Error(
    `${SCRIPT_PATH} no longer declares ${VERSION_DECLARATION} -- the fake CLI's version and ` +
      "FAKE_VERSION in fake-cli.ts have drifted apart. They are two spellings of one value and " +
      "both must be edited together.",
  );
}

/**
 * The `fake_cli` fixture: the two-element command prefix that stands in for
 * `claude`.
 *
 * The script is **copied into the case's own root** rather than referenced
 * where it lives, because the source's fixture writes it into `tmp_path`. That
 * is not incidental: the path ends up inside `record.json`'s `argv`, several
 * cases assert on the recorded `argv`, and one of them
 * (`test_a_relative_workspace_is_recorded_absolute`) runs with the process
 * working directory changed. A shared path outside the case root would make
 * those assertions depend on where the repository is checked out.
 *
 * Returns `[process.execPath, <copy>]`, the analogue of the source's
 * `(sys.executable, str(script))`. Two elements, and the provider appends its
 * own arguments to them -- a case that asserts `argv[0]` is asserting that the
 * command prefix survived, so the pair must stay a pair.
 */
export function fakeCli(root: string): readonly [string, string] {
  const script = join(root, FAKE_CLI_FILENAME);
  writeFileSync(script, SCRIPT_TEXT, "utf8");
  return [process.execPath, script] as const;
}

/**
 * Every environment switch the fake reads.
 *
 * A closed union rather than `string`, so a mistyped switch is a compile error
 * instead of a case that silently exercises the default scenario. The source
 * cannot have this -- `monkeypatch.setenv` takes any name -- and the cost of
 * not having it is high here: `FAKE_MODE=silent` misspelled as `FAKE_MODE` with
 * a typo'd *name* leaves the fake in `ok` mode, where it emits a full event
 * stream and exits, and the cases that then wait for a hanging child would
 * time out ten seconds later against a message about a state never reached.
 */
export type FakeSwitch =
  | "FAKE_EXIT"
  | "FAKE_GARBAGE_BEFORE_RESULT"
  | "FAKE_GRANDCHILD_PID_FILE"
  | "FAKE_HELP_OMIT"
  | "FAKE_IS_ERROR"
  | "FAKE_LEADER_EXITS"
  | "FAKE_MODE"
  | "FAKE_OMIT_IDENTITY"
  | "FAKE_REPORT_ID"
  | "FAKE_RESULT_BARE"
  | "FAKE_SLEEP"
  | "FAKE_SPAWN_LOG"
  | "FAKE_SUBTYPE"
  | "FAKE_TERMINAL_REASON";

/** The scenarios `FAKE_MODE` selects; anything else is the `ok` path. */
export type FakeMode =
  | "events-then-hang"
  | "garbage-then-hang"
  | "ok"
  | "refuse-in-use"
  | "shielded-grandchild"
  | "silent";

/**
 * `monkeypatch.setenv(name, value)`, restored when the test finishes.
 *
 * The provider spawns the child with a **copy of this process's environment**
 * plus its own session marker -- exactly as the source's `_spawn` does with
 * `dict(os.environ)` -- so setting a variable here is how a case configures the
 * child. There is no other channel: the command prefix is fixed by
 * {@link fakeCli} and the provider owns every argument after it.
 *
 * Implemented with `patchSeam` rather than a bespoke save/restore, because
 * `process.env` *is* a mutable record and `patchSeam` already reproduces
 * `monkeypatch`'s two properties that matter: it snapshots the value present at
 * each patch (so patching one switch twice unwinds to the original, not to the
 * intermediate) and it undoes in LIFO order at `onTestFinished`. A file-level
 * `afterEach` restore would leak a switch into whichever test the shuffled
 * order ran next.
 *
 * A variable that was **absent** is deleted on restore rather than set to the
 * string `"undefined"`, which is what a plain assignment of `undefined` to
 * `process.env` produces -- and `"undefined"` is a perfectly good value for
 * `FAKE_MODE` as far as the fake is concerned, so the mistake would present as
 * a later case mysteriously taking the `ok` path.
 */
export function fakeEnv(name: FakeSwitch, value: string): void {
  patchSeam(process.env, name, value);
}

/** {@link fakeEnv}, typed for the one switch with a closed vocabulary. */
export function fakeMode(mode: FakeMode): void {
  fakeEnv("FAKE_MODE", mode);
}

/**
 * The `spawn_log` fixture: a path the fake appends one JSON line to per spawn,
 * with `FAKE_SPAWN_LOG` pointed at it for the rest of the test.
 *
 * **The file is not created**, and that is the fixture's shape in the source
 * too. `spawned()` in `session-cases.ts` reads an absent log as zero spawns,
 * which is the difference between "no spawn happened" and "the log could not be
 * read"; a helper that touched the file here would erase it.
 *
 * The fake writes this log **after** its `--version` and `--help` early exits,
 * so the capability probe -- which runs before every spawn -- never appears in
 * it. Several cases assert an exact spawn count and would be off by two per
 * verb otherwise.
 */
export function spawnLog(root: string): string {
  const log = join(root, "spawns.jsonl");
  fakeEnv("FAKE_SPAWN_LOG", log);
  return log;
}
