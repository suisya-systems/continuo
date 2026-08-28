/**
 * The fake `claude` executable the session belt runs its C2 cases against.
 *
 * A transcription of `_FAKE_CLI` in interlock's
 * `tests/session/test_claude_cli_provider.py` at `65f36c5` -- the ~90-line
 * Python program that file builds as an f-string and writes into `tmp_path`.
 * It renders only the public surface interlock's probes recorded (`--version`,
 * the `--help` flag text, stream-json events carrying `session_id` in `init`
 * and `terminal_reason` / `is_error` / `subtype` in `result`) and nothing else,
 * and every scenario is selected by an environment variable so that the
 * *provider under test* is byte-identical across all 65 cases: only the
 * backend's behaviour changes, which is the situation the provider exists to
 * survive.
 *
 * ## Why this is a file, and why it is `.mjs`
 *
 * - **A file, not a string constant.** The source keeps it as `_FAKE_CLI`, a
 *   module-level f-string, and it is by some distance the least reviewable
 *   thing in that file. As a TypeScript string constant it would additionally
 *   escape Biome, `tsc` and every editor, so a typo in it would surface as 65
 *   cases quietly asserting the wrong thing rather than as a syntax error.
 * - **A file, not `node -e "<program>"`.** The `-e` form shifts the child's
 *   `process.argv.slice(2)` offset, and that offset is exactly what the spawn
 *   log records and what a dozen cases assert against.
 * - **`.mjs`, not `.ts`.** This is launched as a process, by path, by
 *   `process.execPath`, and Node 22 cannot execute a `.ts` file unflagged --
 *   the same reasoning that made `src/fencing/hook.mjs` a `.mjs` (D-0204). It
 *   lives under `test/` so it needs no build step and no `knip` entry: knip's
 *   `project` globs reach TypeScript files under `test/` and not JavaScript ones
 *   (the glob is not written out here: it ends in a `*` immediately followed by
 *   a `/`, which would close this comment block -- a real hazard, since Biome
 *   then parses the prose after it as code, and it did).
 *
 * ## Reading this against the Python
 *
 * Six places where the obvious JavaScript spelling is *not* the Python, each
 * commented at its site below:
 *
 * 1. `"".split()` in Python is `[]`; the same split on a whitespace regexp in
 *    JavaScript is `[""]`, and `"" in line` is true for every line -- so the
 *    naive `--help` port omits **all six** flag lines when `FAKE_HELP_OMIT` is
 *    unset.
 * 2. Python's `or` is a truthiness fallback; `??` is a nullishness one. The
 *    `--session-id` / `--resume` fallback needs the first.
 * 3. `os.environ.get(name, default)` falls back only when the name is
 *    **absent**, which is `??` on `process.env[name]` and not `||`: an empty
 *    `FAKE_REPORT_ID` must stay empty.
 * 4. A `session_id` of Python's `None` serialises as `null`; a JavaScript
 *    `undefined` property is *dropped* by `JSON.stringify`, which is what
 *    `FAKE_OMIT_IDENTITY` means, so the two must not be allowed to collide.
 * 5. `float("nope")` raises; `Number("nope")` is `NaN` and
 *    `setTimeout(fn, NaN)` fires immediately -- a mistyped `FAKE_SLEEP` would
 *    silently turn a hanging child into an exiting one.
 * 6. `sys.stdout.write` handles a partial write internally; `writeSync` returns
 *    a byte count and the caller must loop.
 *
 * Two deliberate divergences, both in the `shielded-grandchild` mode and both
 * argued at their site below:
 *
 * - the source's grandchild inherits the leader's stdout, which is the events
 *   file, so an escaped grandchild holds that file open. This one is spawned
 *   with `stdio: "ignore"`, so an escaped grandchild holds nothing -- which
 *   matters on the Windows cell, where an open handle turns temp-directory
 *   cleanup into an `EBUSY` blamed on whichever case the shuffled order cleaned
 *   up into. It writes nothing on any path, so nothing observes the difference.
 * - the grandchild writes its own pid file, after installing its `SIGTERM`
 *   listener, where the source's leader writes it the moment `Popen` returns.
 *   That closes an interpreter-startup window in which the grandchild is
 *   announced but has not yet ignored anything; measured, one run in three of
 *   `test_stop_reaps_a_group_member_that_outlived_the_leader` was passing over a
 *   grandchild the group `SIGTERM` had simply killed.
 */

import { spawn } from "node:child_process";
import { appendFileSync, writeSync } from "node:fs";
import process from "node:process";

/**
 * The version string `--version` prints.
 *
 * `test/session/helpers/fake-cli.ts` re-states it as `FAKE_VERSION` (the
 * source's own module constant) and checks at import that the literal below
 * still says this, so the two cannot drift apart unnoticed. Change one and the
 * check names the other.
 */
const FAKE_VERSION = "9.9.9-fake (Claude Code)";

/**
 * The `--help` flag text, verbatim from the source including the two leading
 * spaces on each line.
 *
 * `test_a_missing_flag_is_a_missing_capability_and_refuses_the_spawn` and its
 * neighbours drop lines from this list by substring, so the exact spelling of
 * each flag is load-bearing.
 */
const HELP_LINES = [
  "  -p, --print                Print response and exit",
  "  --session-id <uuid>        Use a specific session ID",
  "  -r, --resume [value]       Resume a conversation by session ID",
  "  --output-format <format>   Output format (json | stream-json)",
  "  --verbose                  Override verbose mode",
  "  --model <model>            Model for the current session",
];

const args = process.argv.slice(2);
const env = process.env;

/**
 * `sys.stdout.write(text)` followed by `sys.stdout.flush()`.
 *
 * `writeSync` rather than `process.stdout.write` so the flush contract is
 * explicit rather than inherited from whatever fd 1 happens to be: writing to
 * a *file* fd is synchronous on POSIX and asynchronous on Windows, and the
 * provider reads that file while the child is still running.
 *
 * The loop is not decoration. `writeSync` returns the number of bytes it wrote
 * and is permitted to write fewer than asked; Python's buffered writer hides
 * that. A short write here would truncate a JSON event line, which the provider
 * would then correctly report as garbage -- a failure that looks exactly like
 * the one `test_a_complete_line_that_is_not_json_fails_loudly` induces on
 * purpose.
 */
function writeAll(fd, text) {
  const bytes = Buffer.from(text, "utf8");
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written, bytes.length - written);
  }
}

/** `print(text)` -- to stdout, with the newline `print` adds. */
function out(text) {
  writeAll(1, `${text}\n`);
}

/** `print(text, file=sys.stderr)`. */
function errorOut(text) {
  writeAll(2, `${text}\n`);
}

/**
 * `time.sleep(seconds)`.
 *
 * A timer, never a busy loop. A busy loop would spin a core for the 60 seconds
 * the `silent` / `events-then-hang` / `garbage-then-hang` modes are asked to
 * hang for, on every one of the thirteen cases that use them.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `str.split()` with no argument: split on runs of whitespace, and yield
 * **nothing** for an empty or all-whitespace string.
 *
 * This is difference (1) from the header, and it is the one that fails
 * silently. `"".split(/\s+/)` is `[""]`, and the omission test below asks
 * whether any omitted token is a substring of a line -- `""` is a substring of
 * every line, so the naive spelling prints the usage banner and none of the six
 * flags whenever `FAKE_HELP_OMIT` is unset. Every capability-probe case would
 * then see a CLI missing every flag it depends on, and the cases that assert a
 * *refusal* would still pass.
 */
function pythonSplit(text) {
  return text.split(/\s+/).filter((token) => token !== "");
}

/**
 * `float(os.environ.get(name, fallback))`, or die the way Python dies.
 *
 * Difference (5). `Number("nope")` is `NaN`, `Number("")` is `0`, and
 * `setTimeout(fn, NaN)` fires on the next turn -- so a mistyped `FAKE_SLEEP`
 * would turn every hanging-child case into an exiting-child case, and those
 * cases assert states an exiting child also reaches. Python raises `ValueError`
 * and the child dies with a traceback; this dies with a message on stderr,
 * which is where the provider already captures the child's words.
 */
function floatFromEnv(name, fallback) {
  const raw = env[name] ?? fallback;
  const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    errorOut(`fake-claude: ${name}=${JSON.stringify(raw)} is not a number`);
    process.exit(1);
  }
  return parsed;
}

/** `int(os.environ.get(name, fallback))`, likewise. */
function intFromEnv(name, fallback) {
  const raw = env[name] ?? fallback;
  const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed)) {
    errorOut(`fake-claude: ${name}=${JSON.stringify(raw)} is not an integer`);
    process.exit(1);
  }
  return parsed;
}

/**
 * `args[args.index(flag) + 1] if flag in args else None`.
 *
 * Named `argAfter` rather than the source's `value_of` because `valueOf` is a
 * global property name and shadowing it is a lint error here.
 *
 * `undefined` stands for Python's `None`. A flag in the final position has no
 * following argument: Python raises `IndexError` there and this yields
 * `undefined`, which is the one shape below where the two programs differ. No
 * source case spawns a trailing bare `--session-id` or `--resume`, and the
 * provider never builds one, so the shape is unreachable from the suite.
 */
function argAfter(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

async function main() {
  // The two early exits come first, and the spawn log is written **after**
  // them, so the capability probe -- which runs `--version` and `--help` before
  // every spawn -- never appears in the log. Several cases assert an exact
  // spawn count, and a probe counted as a spawn would break all of them.
  if (args.includes("--version")) {
    out(FAKE_VERSION);
    return 0;
  }

  if (args.includes("--help")) {
    const omitted = pythonSplit(env.FAKE_HELP_OMIT ?? "");
    out("Usage: claude [options] [command] [prompt]");
    for (const line of HELP_LINES) {
      // Substring, not token matching, and that is the point of the switch:
      // omitting `--resume` must drop `-r, --resume [value]` and only it, which
      // a token comparison against `-r,` / `--resume` / `[value]` would also do
      // -- until a case omits `--print`, which appears in no line as its own
      // token.
      if (!omitted.some((flag) => line.includes(flag))) {
        out(line);
      }
    }
    return 0;
  }

  const log = env.FAKE_SPAWN_LOG;
  // Python's `if log:` -- an empty value means "not configured", as an absent
  // one does.
  if (log) {
    // Key order is the source's (`argv` then `cwd`) and `JSON.stringify`
    // preserves insertion order, so a reader comparing the two files sees the
    // same lines. Appended in one `appendFileSync` call, which is `O_APPEND` on
    // POSIX, so a concurrent reader sees whole lines.
    appendFileSync(log, `${JSON.stringify({ argv: args, cwd: process.cwd() })}\n`, "utf8");
  }

  // Difference (2): Python's `or`, not `??`. An explicitly empty `--session-id`
  // is falsy in Python and falls through to `--resume`; `??` would keep it.
  const claimed = argAfter("--session-id") || argAfter("--resume");
  const mode = env.FAKE_MODE ?? "ok";
  const sleepForMs = floatFromEnv("FAKE_SLEEP", "60") * 1000;

  if (mode === "refuse-in-use") {
    // `str(claimed)` on Python's `None` is the four characters `None`. Spelled
    // out rather than left to `String(undefined)` so that the refusal text a
    // case might one day match on is the source's text on every path, not only
    // on the path the suite happens to take.
    const shown = claimed === undefined ? "None" : claimed;
    errorOut(`Error: Session ID ${shown} is already in use.`);
    return 1;
  }

  if (mode === "silent") {
    // Nothing on stdout and nothing on stderr: the child that exists and says
    // nothing, which is what `could-not-observe` has to survive.
    await sleep(sleepForMs);
    return 0;
  }

  // Difference (3): `os.environ.get("FAKE_REPORT_ID", claimed)` falls back only
  // when the variable is **absent**, so `??` and never `||` -- a case that
  // reports an empty identity must be able to.
  //
  // Difference (4): `?? null` closes the gap between Python's `None` and
  // JavaScript's `undefined`. `JSON.stringify` *drops* an `undefined` property
  // and emits `null` for a null one, and dropping `session_id` is precisely
  // what `FAKE_OMIT_IDENTITY` means. Without this, a spawn with neither
  // `--session-id` nor `--resume` would emit the omit-identity shape without
  // anyone having asked for it.
  const reported = env.FAKE_REPORT_ID ?? claimed ?? null;
  const omitIdentity = env.FAKE_OMIT_IDENTITY === "1";

  /** `emit(payload)` -- one JSON object per line, flushed. */
  const emit = (payload) => {
    if (omitIdentity) {
      delete payload.session_id;
    }
    out(JSON.stringify(payload));
  };

  if (mode === "shielded-grandchild") {
    const pidFile = env.FAKE_GRANDCHILD_PID_FILE;
    if (pidFile === undefined) {
      // Python's `os.environ["..."]` raises `KeyError` here. Said out loud
      // rather than left to `writeFileSync(undefined, ...)`, whose `TypeError`
      // names the argument and not the switch.
      errorOut("fake-claude: FAKE_MODE=shielded-grandchild needs FAKE_GRANDCHILD_PID_FILE");
      return 1;
    }
    // `detached: false` is load-bearing. The whole point of this mode is a
    // process that is a **member of the leader's group without being the
    // provider's child** -- interlock's H1 shape, the one the group sweep
    // exists for. `detached: true` would give it its own group, the sweep would
    // correctly find nothing, and every case here would pass while proving the
    // opposite of what it names.
    //
    // The no-op `SIGTERM` listener is Python's `signal.signal(SIGTERM,
    // SIG_IGN)`: registering any listener replaces Node's default terminate.
    // The bounded 120s timer is the source's `time.sleep(120)` and is what
    // makes a missed kill self-heal rather than leak until the runner exits.
    //
    // **The grandchild announces its own pid, and only after the listener is
    // installed.** The source has the leader write the pid the moment `Popen`
    // returns, which is before the child has started interpreting anything, so
    // a stop that arrives inside the interpreter's startup window kills a
    // grandchild that had not yet ignored anything -- and
    // `test_stop_reaps_a_group_member_that_outlived_the_leader` then passes
    // while observing a TERM that worked rather than the sweep it is named for.
    // Measured on the porting host with the after-exit sweep deleted: that case
    // went red in only two runs of three, so one run in three was exercising
    // nothing. Announcing after the handler is installed removes the window;
    // the file is still written exactly once, still holds the same decimal pid,
    // and the pid-file path arrives through the environment the grandchild
    // already inherits.
    const grandchild = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {});" +
          "require('node:fs').writeFileSync(process.env.FAKE_GRANDCHILD_PID_FILE, " +
          "String(process.pid));" +
          "setTimeout(() => {}, 120000);",
      ],
      { detached: false, stdio: "ignore" },
    );
    if (grandchild.pid === undefined) {
      errorOut("fake-claude: the grandchild did not spawn");
      return 1;
    }
    // `.unref()` so the leader's event loop is not held open by the
    // grandchild's handle -- Python needs no equivalent, since a `Popen` never
    // keeps its parent alive.
    //
    // It is **not** what makes the leader exit under `FAKE_LEADER_EXITS=1`, and
    // the comment originally said it was: measured, removing this line leaves
    // the leader exiting `[0, null]` exactly as before, because every path out
    // of `main` ends in an explicit `process.exit(code)` and `process.exit`
    // does not wait for handles. It is kept because it makes the exit true of
    // the *event loop* and not only of the exit call, which is the property any
    // future path that returns without exiting would rely on.
    grandchild.unref();
  }

  // The `unknown_field` is deliberate and is asserted: an event carrying a
  // shape the provider has never seen must be carried uninterpreted, not
  // rejected.
  emit({
    type: "system",
    subtype: "init",
    session_id: reported,
    unknown_field: { nested: ["tolerated"] },
  });

  if (mode === "shielded-grandchild") {
    if (env.FAKE_LEADER_EXITS !== "1") {
      await sleep(sleepForMs);
    }
    return 0;
  }

  if (mode === "garbage-then-hang") {
    out("this complete line is not JSON");
    await sleep(sleepForMs);
    return 0;
  }

  emit({ type: "unheard_of_event", session_id: reported, payload: 123 });

  if (env.FAKE_GARBAGE_BEFORE_RESULT === "1") {
    out("mid-stream line that is not JSON");
  }

  if (mode === "events-then-hang") {
    await sleep(sleepForMs);
    return 0;
  }

  if (env.FAKE_RESULT_BARE === "1") {
    // A `result` with no `terminal_reason`, no `subtype` and no `is_error`: the
    // shape a provider that reads terminality off a missing key would treat as
    // success.
    emit({ type: "result", session_id: reported });
  } else {
    emit({
      type: "result",
      subtype: env.FAKE_SUBTYPE ?? "success",
      is_error: env.FAKE_IS_ERROR === "1",
      terminal_reason: env.FAKE_TERMINAL_REASON ?? "completed",
      session_id: reported,
      another_unknown_field: true,
    });
  }

  return intFromEnv("FAKE_EXIT", "0");
}

// The leader installs **no** `SIGTERM` handler, on any path. The stop ladder's
// first rung is a group `SIGTERM` and it depends on this process dying from it;
// a handler here -- even one that exits -- would turn every ladder case into a
// test of the ladder's `SIGKILL` fallback instead.
main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    // Python's uncaught traceback: on stderr, and a non-zero exit. Without the
    // handler Node would report an unhandled rejection and still exit non-zero,
    // but with a message the provider's stderr capture cannot attribute.
    errorOut(`fake-claude: ${String(error)}`);
    process.exit(1);
  });
