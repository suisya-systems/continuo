/**
 * Render and dispatch attention notifications.
 *
 * Ported from interlock `claude_org_runtime/attention/notify.py` at `65f36c5`, under the attention
 * belt's sub-belt A3 (`D-0034`). The pipeline per event is the source's, unchanged:
 *
 * 1. Pick a template (config override -> bundled runtime default).
 * 2. Detect unknown placeholders (outside the section 6 allowlist) and fall back to the bundled default
 *    if any are present -- the watcher must not crash on a misspelled template.
 * 3. Truncate to `maxTitleChars` / `maxBodyChars`.
 * 4. Emit a stdout log line (always -- including `--dry-run`).
 * 5. If desktop output is enabled and this is not a dry run, run the backend subprocess with a
 *    small timeout. If that fails, or no backend is available, fall through to a terminal bell
 *    when sound applies.
 *
 * Sub-process invocation never goes through a shell, times out at
 * {@link SUBPROCESS_TIMEOUT_SEC} seconds, and strips control characters from title and body
 * before composing arguments.
 *
 * **Three Python semantics are load-bearing here and are transcribed rather than approximated.**
 *
 * - The template is **operator-supplied text**, so `string.Formatter().parse` and
 *   `str.format_map` are CPython's, from `./pyformat.js`, and not a regular expression that
 *   happens to work on the templates this belt's cases write. What each answers decides whether
 *   an operator's template renders, is refused, or reaches a field the section 6 allowlist forbids.
 * - `len(s)` and `s[:n]` count **code points**; `String#length` and `String#slice` count UTF-16
 *   units. `_truncate` is the one place a `maxBodyChars` of 20 must mean twenty characters and
 *   not twenty-and-a-half emoji, so it iterates code points.
 * - `cfg.templates.get(event.kind)` is a `dict` lookup and a `dict` has no inherited keys, while
 *   an object literal carries `Object.prototype` (`docs/test-translation-conventions.md` rule 9).
 *   The kind is a caller-supplied string, so the lookup is `getOwn`.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, delimiter as pathDelimiter, sep as pathSep } from "node:path";
import process from "node:process";

import { pyRepr } from "../fencing/pyrepr.js";
import { getOwn, PyValueError } from "../fencing/pysemantics.js";
import type { AttentionEvent } from "./classifier.js";
import { ALLOWED_PLACEHOLDERS, type AttentionConfig, type Template } from "./config.js";
import { formatMap, parseFormat } from "./pyformat.js";

/**
 * The backend vocabulary, inlined from the removed `attention.platform` exactly as the source
 * inlines it (interlock `PORTING_LEDGER.md` `D-0014`).
 *
 * What is deliberately NOT carried is that module's OS probe -- the osascript / notify-send /
 * wsl-notify-send / PowerShell detection and the WSL sniff -- which is the old-platform
 * observation mechanism the Discard bucket names.
 */
export type Backend = "macos" | "linux" | "windows" | "wsl" | "wsl-notify-send" | "stdout";

/** How long the desktop subprocess may run before it is killed. */
export const SUBPROCESS_TIMEOUT_SEC = 5.0;

/**
 * The port's stand-in for the pair `_dispatch_desktop` catches: `(OSError,
 * subprocess.SubprocessError)`.
 *
 * It exists as a NARROW class rather than as a bare `catch` for a reason the source's own cases
 * depend on. Four of them pass a runner that fails the test if it is ever called
 * (`runner=lambda cmd: pytest.fail("runner should not run")`), and in Python that works because
 * `Failed` is neither an `OSError` nor a `SubprocessError`, so it escapes the dispatcher and the
 * case goes red. A `catch` that swallowed everything would absorb the port's equivalent and turn
 * all four into cases that can no longer fail -- which is exactly the shape
 * `docs/test-translation-conventions.md` rule 10 exists to catch.
 */
export class SubprocessRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubprocessRunError";
    // Extending a built-in under a downlevel emit target loses the prototype chain, and
    // `instanceof` then reports false -- which would let a genuine spawn failure escape as an
    // internal error instead of demoting to the bell fallback.
    Object.setPrototypeOf(this, SubprocessRunError.prototype);
  }
}

/**
 * What a runner returns: `subprocess.CompletedProcess`, narrowed to the one field read.
 *
 * `getattr(result, "returncode", 0)` is the source's read, so a runner that returns nothing at
 * all -- which every one of its test runners does -- is a clean exit. The port keeps that
 * `unknown` return type for the same reason.
 */
export interface CompletedProcess {
  readonly returncode?: unknown;
}

/** A `sys.stdout`-shaped sink. `flush` is not modelled: Node's writes are not buffered here. */
export interface TextStream {
  write(text: string): void;
}

/**
 * Always `"stdout"`: there is no decided desktop channel yet.
 *
 * The OS backend probe was discarded with `attention.platform` and interlock `Q-0017` ("what
 * replaces the discarded desktop human-notification path") is still open, so this resolves to the
 * stdout log line rather than inventing a delivery channel the source does not decide. Callers
 * that know their backend still pass `notify(..., { backend })` explicitly.
 */
export function detectBackend(): Backend {
  return "stdout";
}

/**
 * Emit a BEL (`\a`) -- stderr by default, to keep stdout clean. Returns whether it was written.
 *
 * A closed pipe or a non-tty must not crash the watcher, which is what the source's
 * `except (OSError, ValueError)` says. Node reports a closed stream by throwing from `write`, so
 * the guard is the same shape.
 *
 * **The return value is a DELIBERATE DIVERGENCE, under `D-0023`.** The source's `bell()` returns
 * `None` and its caller writes `bell(); bell_dispatched = True` unconditionally -- so a bell that
 * could not be written is still recorded as an audio channel that reached the user. With the
 * desktop dispatch also failed, `reached_user` is then true for a notification that reached
 * nobody, and the CLI records it in the dedup ledger: the event is suppressed for good, on the one
 * path where the operator was told nothing. That is the same defect class the source repaired for
 * a failing desktop subprocess and did not follow through to the bell. interlock is frozen, so
 * `D-0023` puts the repair here, in the belt that is already editing this code, and the ledger
 * carries it as a divergence rather than as a silent improvement. No source case pins the
 * inherited behaviour -- in both suites the bell's stream always accepts the write -- so there is
 * no case to invert; a target-only one pins the repair.
 */
export function bell(stream: TextStream | null = null): boolean {
  const target = stream ?? notifySeams.stderr();
  try {
    target.write("\u0007");
    return true;
  } catch {
    // Closed pipes / non-tty streams must not crash the watcher.
    return false;
  }
}

/**
 * What was sent, as `notify` returns it.
 *
 * `reachedUser` is true when at least one user-visible channel ran: the desktop subprocess
 * succeeded, the bell rang, or the runtime is intentionally in stdout-only mode and the log line
 * IS the notification. The CLI uses it to decide whether to record dedup state -- a
 * silently-failing desktop subprocess should retry on the next poll, but an stdout-only setup
 * must not replay forever.
 */
export class FormattedNotification {
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly sound: boolean;
  readonly backend: Backend;
  readonly desktopDispatched: boolean;
  readonly bellDispatched: boolean;
  readonly desktopIntended: boolean;

  constructor(fields: {
    title: string;
    body: string;
    severity: string;
    sound: boolean;
    backend: Backend;
    desktopDispatched: boolean;
    bellDispatched: boolean;
    desktopIntended: boolean;
  }) {
    this.title = fields.title;
    this.body = fields.body;
    this.severity = fields.severity;
    this.sound = fields.sound;
    this.backend = fields.backend;
    this.desktopDispatched = fields.desktopDispatched;
    this.bellDispatched = fields.bellDispatched;
    this.desktopIntended = fields.desktopIntended;
    // `frozen=True` on the source's dataclass is enforced at runtime and `readonly` here is not:
    // it is erased at emit. The classifier's `AttentionEvent` closes the same gap the same way.
    Object.freeze(this);
  }

  get reachedUser(): boolean {
    if (this.desktopDispatched || this.bellDispatched) {
      return true;
    }
    // No desktop attempt was made: this is the user's chosen stdout-only or desktop-disabled
    // mode and the log line is the entire notification surface. Treat it as delivered.
    return !this.desktopIntended;
  }
}

/**
 * The seams this module carries, and the only place production reaches them.
 *
 * `tests/attention/test_cli.py` patches `notify._safe_subprocess_run` and `notify.detect_backend`
 * with `monkeypatch.setattr`; ESM has no equivalent rebinding, so both internal call sites go
 * through this record and tests replace the entry (`docs/test-translation-conventions.md`
 * rule 5). `stdout` and `stderr` join them because the source reads `sys.stdout` / `sys.stderr`
 * at CALL time -- a module-level `const` capturing the stream at import would not see a
 * replacement either. Each entry's liveness is pinned by a target-only case.
 */
export const notifySeams = {
  safeSubprocessRun,
  detectBackend,
  stdout: (): TextStream => process.stdout,
  stderr: (): TextStream => process.stderr,
  /**
   * `subprocess.run`'s own call into the operating system.
   *
   * A second, inner seam beside {@link safeSubprocessRun}, and it earns its place rather than
   * duplicating it: `safeSubprocessRun` is what every CALLER replaces, and this is what lets a
   * case reach the translation INSIDE it -- Node's `{status, signal, error}` triple becoming a
   * `CompletedProcess`. The signalled-child branch has no other way in. It was found the hard
   * way: the first case written for that branch patched the outer seam, so it asserted on a
   * `returncode` the case had supplied itself and stayed green under the mutation it was written
   * to catch.
   */
  spawn: spawnSync,
};

/** `print(..., file=sys.stderr)`, through the seam so a test can read it back. */
function warn(message: string): void {
  notifySeams.stderr().write(`${message}\n`);
}

/**
 * Return `[title, body]` after template substitution and truncation.
 *
 * The fallback is **whole-event**: a template whose title is fine and whose body names an unknown
 * placeholder falls back for both. Half a rendered template is a notification an operator cannot
 * read as either their own text or the runtime's.
 */
export function renderText(event: AttentionEvent, cfg: AttentionConfig): [string, string] {
  const template = getOwn(cfg.templates, event.kind) as Template | undefined;
  let title = event.title;
  let body = event.body;
  if (template !== undefined) {
    const used = new Set([...placeholders(template.title), ...placeholders(template.body)]);
    const unknown = [...used].filter((name) => !ALLOWED_PLACEHOLDERS.has(name));
    if (unknown.length > 0) {
      warn(
        `warning: attention template[${pyRepr(event.kind)}] uses unknown ` +
          `placeholders ${sortedList(unknown)}; falling back to runtime ` +
          "default",
      );
    } else {
      try {
        title = formatWithEvent(template.title, event);
        body = formatWithEvent(template.body, event);
      } catch (error) {
        if (!(error instanceof PyValueError)) {
          throw error;
        }
        warn(
          `warning: attention template[${pyRepr(event.kind)}] format ` +
            `failed (${error.message}); falling back to runtime default`,
        );
        title = event.title;
        body = event.body;
      }
    }
  }
  return [truncate(title, cfg.maxTitleChars), truncate(body, cfg.maxBodyChars)];
}

/** Everything `notify` takes beyond the event and the config. */
export interface NotifyOptions {
  readonly dryRun?: boolean;
  readonly backend?: Backend | null;
  readonly logStream?: TextStream | null;
  readonly runner?: ((cmd: string[]) => unknown) | null;
}

/**
 * Emit one attention notification (and its stdout log line).
 *
 * `dryRun` keeps the log line but skips both the OS subprocess and the terminal bell (the latter
 * so unit tests stay silent). `backend` overrides detection. `runner` overrides the subprocess
 * seam; tests use it to capture the command instead of executing it.
 */
export function notify(
  event: AttentionEvent,
  cfg: AttentionConfig,
  options: NotifyOptions = {},
): FormattedNotification {
  const dryRun = options.dryRun ?? false;
  const runner = options.runner ?? null;
  const logStream = options.logStream ?? notifySeams.stdout();
  const [title, body] = renderText(event, cfg);
  const chosen = options.backend ?? notifySeams.detectBackend();
  const playSound = shouldPlaySound(cfg.sound, event.severity);
  let desktopIntended = Boolean(cfg.desktop) && chosen !== "stdout";

  // The legacy Windows / WSL Write-Host backends signal exclusively through the embedded
  // `[console]::beep` -- `Write-Host` goes to a captured PowerShell stdout we discard, so it is
  // invisible to the user. With sound suppressed the subprocess would dispatch successfully yet
  // deliver nothing, so this downgrades to intentional stdout-only delivery instead of
  // pretending it worked. `wsl-notify-send` is intentionally excluded: it raises a real Windows
  // toast that stays visible regardless of `cfg.sound`, so suppressing sound must not suppress
  // the toast itself.
  if ((chosen === "windows" || chosen === "wsl") && !playSound) {
    desktopIntended = false;
  }

  logStream.write(
    `[attention] ${event.severity.toUpperCase()} ${event.kind} ` +
      `key=${event.key} task=${orDash(event.taskId)} :: ${title}\n`,
  );

  let desktopDispatched = false;
  let bellDispatched = false;
  if (dryRun) {
    return new FormattedNotification({
      title,
      body,
      severity: event.severity,
      sound: playSound,
      backend: chosen,
      desktopDispatched: false,
      bellDispatched: false,
      desktopIntended,
    });
  }

  if (desktopIntended) {
    desktopDispatched = dispatchDesktop(chosen, title, body, { playSound, runner });
  }

  // Bell semantics per the design's section 5:
  //   - macOS / Linux: the notification is visual-only; the bell is the audio channel.
  //   - Windows / WSL: `[console]::beep` is already inside the PowerShell command, so a bell
  //     here would double up.
  //   - wsl-notify-send: the dispatcher fires a companion `powershell.exe` beep alongside a
  //     successful toast, so the bell is suppressed there to avoid double audio. If the toast
  //     subprocess itself failed the bell becomes the audio fallback, matching macOS / Linux.
  //   - desktop disabled / dispatch failed / stdout-only: the bell is the only audio surface
  //     left.
  let shouldBell = playSound && chosen !== "windows" && chosen !== "wsl";
  if (chosen === "wsl-notify-send" && desktopDispatched) {
    shouldBell = false;
  }
  if (shouldBell) {
    // `bell(); bell_dispatched = True` in the source. See `bell`'s own note: the write's answer is
    // read here rather than assumed, per `D-0023`.
    bellDispatched = bell();
  }

  return new FormattedNotification({
    title,
    body,
    severity: event.severity,
    sound: playSound,
    backend: chosen,
    desktopDispatched,
    bellDispatched,
    desktopIntended,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Run the backend subprocess; return true only on a clean exit.
 *
 * A non-zero exit demotes the result to false so {@link notify} falls back to a bell -- and,
 * crucially, so the caller does not mark the event as dedup'd and the next poll re-attempts.
 * `playSound` is threaded in so the Windows / WSL PowerShell command can conditionally include
 * its `[console]::beep`; without it `sound: "off"` would still beep on those platforms.
 *
 * The `wsl-notify-send` backend is special: the binary has no beep flag, so a second
 * `powershell.exe` beep subprocess fires after the toast. A failing beep does NOT demote the
 * toast -- the user already saw the notification.
 */
function dispatchDesktop(
  backend: Backend,
  title: string,
  body: string,
  options: { playSound: boolean; runner: ((cmd: string[]) => unknown) | null },
): boolean {
  const cmd = backendCommand(backend, title, body, options.playSound);
  if (cmd === null) {
    return false;
  }
  const runFn = options.runner ?? ((command: string[]) => notifySeams.safeSubprocessRun(command));
  let result: unknown;
  try {
    result = runFn(cmd);
  } catch (error) {
    if (!(error instanceof SubprocessRunError)) {
      throw error;
    }
    warn(`warning: desktop notification via ${pyRepr(backend)} failed: ${error.message}`);
    return false;
  }
  const returncode = returncodeOf(result);
  if (returncode !== 0) {
    warn(`warning: desktop notification via ${pyRepr(backend)} exited with code ${returncode}`);
    return false;
  }
  if (backend === "wsl-notify-send" && options.playSound) {
    dispatchWslNotifySendBeep(runFn);
  }
  return true;
}

/**
 * Fire the supplementary PowerShell beep next to a `wsl-notify-send` toast.
 *
 * Warned about on failure but never demoting the toast: the user has already seen it, so the
 * event is delivered even if the audio side fails.
 */
function dispatchWslNotifySendBeep(runFn: (cmd: string[]) => unknown): void {
  const beepCmd = ["powershell.exe", "-NoProfile", "-Command", "[console]::beep(800,200)"];
  let result: unknown;
  try {
    result = runFn(beepCmd);
  } catch (error) {
    if (!(error instanceof SubprocessRunError)) {
      throw error;
    }
    warn(`warning: wsl-notify-send beep subprocess failed: ${error.message}`);
    return;
  }
  const returncode = returncodeOf(result);
  if (returncode !== 0) {
    warn(`warning: wsl-notify-send beep exited with code ${returncode}`);
  }
}

/**
 * `getattr(result, "returncode", 0)`, then Python's truthiness on the answer.
 *
 * The source writes `if returncode and returncode != 0`, and the first half is what makes a
 * runner returning `None` -- every test runner in both suites -- a clean exit rather than a
 * `TypeError`. A `returncode` that is not a number is treated the way Python's truth test treats
 * it: anything falsy is a clean exit, and anything else is reported as the failure it is.
 */
function returncodeOf(result: unknown): number {
  if (result === null || result === undefined || typeof result !== "object") {
    return 0;
  }
  const value = getOwn(result as Record<string, unknown>, "returncode");
  if (value === undefined || value === null || value === false || value === 0) {
    return 0;
  }
  return typeof value === "number" ? value : Number.NaN;
}

/** `subprocess.run(cmd, timeout=..., check=False, capture_output=True)`. */
function safeSubprocessRun(cmd: string[]): CompletedProcess {
  const [command, ...args] = cmd;
  const result = notifySeams.spawn(command as string, args, {
    timeout: SUBPROCESS_TIMEOUT_SEC * 1000,
    // `capture_output=True`: the child's streams are collected, not inherited, so a backend that
    // prints does not interleave with the watcher's own log line.
    encoding: "utf8",
    // `shell=True` is never used, and saying so here rather than only in the module docstring is
    // deliberate: this is the one place it could be turned on.
    shell: false,
  });
  if (result.error !== undefined) {
    // Node reports a failed spawn (and a timeout kill) by returning an error rather than
    // throwing; Python raises. Raising here is what puts both runtimes on the source's
    // `except (OSError, subprocess.SubprocessError)` path.
    throw new SubprocessRunError(result.error.message);
  }
  if (result.signal !== null && result.signal !== undefined) {
    // A child killed by a signal: `status` is `null` and `signal` names what killed it.
    // `CompletedProcess.returncode` is `-signum` there, which is truthy and non-zero, so the
    // source demotes the dispatch and the caller retries on the next poll. Reading `status ?? 0`
    // would report a clean exit for a backend that was killed mid-notification and would then
    // record the event as delivered -- the exact shape the `reachedUser` contract exists to
    // prevent, arriving through the one path that does not go through a test runner.
    return { returncode: -signalNumber(result.signal) };
  }
  return { returncode: result.status ?? 0 };
}

/** `signal.Signals[name]`, so a killed child's `returncode` reads as CPython spells it. */
function signalNumber(signal: NodeJS.Signals): number {
  const known = (osConstants.signals as Record<string, number | undefined>)[signal];
  // An unrecognised name still has to be a FAILURE rather than a clean exit, so the fallback is a
  // non-zero number rather than `0`. `1` is `SIGHUP`, which is what a name Node reports and this
  // runtime does not define would most likely have been.
  return known ?? 1;
}

/** The argv for one backend, or `null` where the source returns `None`. */
function backendCommand(
  backend: Backend,
  title: string,
  body: string,
  playSound: boolean,
): string[] | null {
  const safeTitle = stripControl(title);
  const safeBody = stripControl(body);
  if (backend === "macos") {
    const script = `display notification ${appleQuote(safeBody)} with title ${appleQuote(safeTitle)}`;
    return ["osascript", "-e", script];
  }
  if (backend === "linux") {
    return ["notify-send", safeTitle, safeBody];
  }
  if (backend === "wsl-notify-send") {
    // Upstream `main.go`: `--category` is documented as "Notification category (used as title)",
    // so the rendered title goes there and the body is the positional argument. The beep is a
    // separate subprocess; the binary itself has no audio flag.
    return ["wsl-notify-send.exe", "--category", safeTitle, safeBody];
  }
  if (backend === "windows" || backend === "wsl") {
    // Honour `cfg.sound` on the PowerShell path: the beep is included iff the caller asked for
    // sound. Without this guard, `sound: "off"` users still hear a beep on Windows / WSL.
    const beep = playSound ? "; [console]::beep(800,200)" : "";
    const message = `Write-Host '${psQuote(safeTitle)}: ${psQuote(safeBody)}'${beep}`;
    if (backend === "windows") {
      const ps = which("powershell.exe") ?? "powershell";
      return [ps, "-NoProfile", "-Command", message];
    }
    return ["powershell.exe", "-NoProfile", "-Command", message];
  }
  return null;
}

function shouldPlaySound(soundMode: string, severity: string): boolean {
  if (soundMode === "off") {
    return false;
  }
  if (soundMode === "urgent-only") {
    return severity === "urgent";
  }
  return true; // "all"
}

/**
 * `s[: limit - 1] + "\u2026"`, counting **code points**. The ellipsis is written as an
 * escape rather than as the character, so this file stays ASCII (`docs/cli-output-policy.md`);
 * it is the character the source appends.
 *
 * `len(s)` and slicing are code-point operations in Python and UTF-16-unit operations here, so a
 * title of astral characters would be cut short -- and, worse, a cut landing between a surrogate
 * pair produces a lone surrogate, which is not text any consumer can render. A1 hit the same
 * hazard on the classifier's summary cut and repaired it the same way.
 */
function truncate(s: string, limit: number): string {
  if (limit <= 0) {
    return s;
  }
  const points = [...s];
  if (points.length <= limit) {
    return s;
  }
  if (limit === 1) {
    return points[0] as string;
  }
  return `${points.slice(0, limit - 1).join("")}\u2026`;
}

/**
 * Drop ASCII C0 control bytes and DEL (`\x00-\x1f`, `\x7f`).
 *
 * Iterated by code point, as Python iterates a `str`. The characters removed are all BMP
 * non-surrogates, so this agrees with a UTF-16 scan on every input -- the iteration is written
 * this way because the *predicate* is about a code point, and reading it that way is what makes
 * the astral case obviously safe rather than accidentally so.
 */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if ((code >= 0x20 && code < 0x7f) || code > 0x7f) {
      out += ch;
    }
  }
  return out;
}

function appleQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function psQuote(s: string): string {
  return s.replaceAll("'", "''");
}

/**
 * The set of named placeholders a template references.
 *
 * Anything beyond a bare identifier -- an index or attribute lookup such as `{summary[0]}` or
 * `{summary.__class__}` -- is reported as `__invalid__` so the section 6 allowlist stays strict: a
 * template must not be able to reach into an arbitrary attribute of the event. A template that
 * does not parse at all is `__invalid__` for the same reason.
 */
function placeholders(template: string): Set<string> {
  const out = new Set<string>();
  let chunks: ReturnType<typeof parseFormat>;
  try {
    chunks = parseFormat(template);
  } catch (error) {
    if (!(error instanceof PyValueError)) {
      throw error;
    }
    out.add("__invalid__");
    return out;
  }
  for (const chunk of chunks) {
    const fieldName = chunk.fieldName;
    // `if not field_name` -- Python truthiness, so BOTH the `None` of a trailing literal and the
    // empty name of an auto-numbered `{}` are skipped. The empty one then reaches the formatter
    // and raises `IndexError`, which is the other half of the source's two-class catch.
    if (fieldName === null || fieldName === "") {
      continue;
    }
    if (fieldName.includes(".") || fieldName.includes("[")) {
      out.add("__invalid__");
      continue;
    }
    out.add(fieldName);
  }
  return out;
}

/** `template.format_map({...})` over the six values the section 6 allowlist names. */
function formatWithEvent(template: string, event: AttentionEvent): string {
  const values: Record<string, string> = Object.assign(Object.create(null), {
    task_id: event.taskId ?? "",
    worker: event.worker ?? "",
    kind: event.kind,
    status: event.status ?? "",
    pr: event.pr === null ? "" : String(event.pr),
    summary: event.summary ?? "",
  });
  return formatMap(template, values);
}

/** `x or '-'`, on a field the source types `Optional[str]`. */
function orDash(value: string | null): string {
  return value === null || value === "" ? "-" : value;
}

/** `sorted(unknown)` as Python renders a list of strings inside an f-string. */
function sortedList(names: readonly string[]): string {
  const sorted = [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return `[${sorted.map((name) => pyRepr(name)).join(", ")}]`;
}

/**
 * A faithful equivalent of Python's `shutil.which` for a bare command name.
 *
 * Node has no built-in `which`. This searches `PATH` the way `shutil.which` does -- each
 * directory in order, first hit wins -- and on Windows also honours `PATHEXT`, which is what
 * `shutil.which` itself does there (Windows has no executable bit, so it appends each `PATHEXT`
 * extension in turn). On POSIX the `X_OK` check via `accessSync` is the direct equivalent.
 *
 * **This is the repository's third private copy of `shutil.which`** -- `src/fencing/renderer.ts`
 * and `src/settings/sandbox_doctor.ts` each carry one, both private to their module. Neither is
 * exported, and exporting one is an edit to a landed belt's file, which `D-0504` established
 * belongs in its own PR rather than in whichever belt happens to be the first to need it. The
 * consolidation is a declared follow-on and is named in `parity/attention.notify.ledger.json`
 * rather than left for a reader to discover by grep.
 */
function which(command: string): string | null {
  const pathEnv = process.env["PATH"] ?? process.env["Path"] ?? "";
  const dirs = pathEnv.split(pathDelimiter).filter((dir) => dir.length > 0);

  if (process.platform === "win32") {
    const pathext = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
      .split(pathDelimiter)
      .filter((ext) => ext.length > 0);
    const candidates = pathext.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()))
      ? [command]
      : pathext.map((ext) => command + ext);
    for (const dir of dirs) {
      for (const candidate of candidates) {
        const full = isAbsolute(candidate) ? candidate : `${dir}${pathSep}${candidate}`;
        if (isFile(full)) {
          return full;
        }
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const full = `${dir}${pathSep}${command}`;
    if (isExecutableFile(full)) {
      return full;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  if (!isFile(path)) {
    return false;
  }
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
