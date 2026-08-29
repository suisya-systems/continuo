/**
 * Ported from interlock `tests/attention/test_notify.py` at `65f36c5` -- 34 cases.
 *
 * The ledger is `parity/attention.notify.ledger.json`. Two mechanisms are rewritten and are why
 * most entries read `adapted` rather than `ported`:
 *
 * - `StringIO()` becomes {@link recordingStream}, a `{write}` sink, because the source's
 *   `log_stream` contract is "something with `.write()`" and nothing here reads a file.
 * - `capsys` becomes `capturedStderr` (`./helpers/fixtures.js`), the same seam A1's readers cases
 *   use: the observable really is the rendered stderr text, because the source warns with
 *   `print(file=sys.stderr)` and asserts on substrings of it.
 *
 * One assertion of the source's has no direct spelling here and is carried as a stronger one:
 * four cases pass `runner=lambda cmd: pytest.fail("runner should not run")`, which works in Python
 * because `Failed` is neither an `OSError` nor a `SubprocessError` and therefore escapes
 * `_dispatch_desktop`'s `except`. The port's `dispatchDesktop` catches only
 * {@link SubprocessRunError} for exactly that reason, so a runner that throws a plain `Error`
 * escapes here too and the four cases stay falsifiable. A target-only case measures it.
 */

import { describe, expect, test } from "vitest";

import { AttentionEvent } from "../../src/attention/classifier.js";
import { AttentionConfig, Template } from "../../src/attention/config.js";
import {
  FormattedNotification,
  notify,
  notifySeams,
  renderText,
  SubprocessRunError,
  type TextStream,
} from "../../src/attention/notify.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";
import { capturedStderr } from "./helpers/fixtures.js";

/**
 * The non-ASCII literals the source's own cases carry, as escape sequences.
 *
 * `docs/cli-output-policy.md` (D-0006) scans every byte of this file, and the reason reaches this
 * belt directly: a Japanese template is exactly what an operator puts in `attention.json`, and the
 * case that proves it survives the pipeline must not itself be the thing that breaks `--help` on a
 * cp932 console. The escapes spell, in order: "CI ga shippai shimashita" (CI failed), "PR #{pr} ga
 * {status} de kanryou shimashita." (PR #{pr} finished with {status}.), the same line rendered, and
 * "handan machi" (awaiting a decision). `ELLIPSIS` is U+2026, the character the source's
 * `_truncate` appends.
 */
const ELLIPSIS = "\u2026";
const JA_TITLE = "CI \u304c\u5931\u6557\u3057\u307e\u3057\u305f";
const JA_BODY = "PR #{pr} \u304c {status} \u3067\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002";
const JA_BODY_RENDERED = "PR #42 \u304c failed \u3067\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002";
const JA_PENDING = "\u5224\u65ad\u5f85\u3061";

/** `io.StringIO()`, narrowed to the one method `notify` calls on its log stream. */
function recordingStream(): TextStream & { text(): string } {
  const chunks: string[] = [];
  return {
    write(text: string): void {
      chunks.push(text);
    },
    text(): string {
      return chunks.join("");
    },
  };
}

/** The source's `_event(**kwargs)`, with its defaults. */
function makeEvent(overrides: Partial<ConstructorParameters<typeof AttentionEvent>[0]> = {}) {
  return new AttentionEvent({
    key: "event:1",
    kind: "ci_failed",
    severity: "urgent",
    title: "CI failed",
    body: "PR #42 finished with failed.",
    source: "state.db.events",
    taskId: "t1",
    worker: "w1",
    pr: 42,
    status: "failed",
    summary: null,
    createdAt: "2026-05-12T10:00:00Z",
    ...overrides,
  });
}

/** A runner the case asserts is never reached: `pytest.fail("...")`. */
function forbiddenRunner(reason: string): (cmd: string[]) => never {
  return () => {
    throw new Error(reason);
  };
}

/** A runner that records the argv and returns nothing, as the source's `fake_runner` does. */
function recordingRunner(): { calls: string[][]; run: (cmd: string[]) => undefined } {
  const calls: string[][] = [];
  return {
    calls,
    run(cmd: string[]): undefined {
      calls.push(cmd);
      return undefined;
    },
  };
}

/** The source's `class FailingProc: returncode = 1`. */
const failingProc = { returncode: 1 };

describe("attention notify", () => {
  // -------------------------------------------------------------------------
  // renderText: the section 6 template, truncation and unknown-placeholder contract
  // -------------------------------------------------------------------------

  test("render uses the runtime default when there is no template", () => {
    const [title, body] = renderText(makeEvent(), new AttentionConfig());
    expect(title).toBe("CI failed");
    expect(body).toBe("PR #42 finished with failed.");
  });

  test("render applies a user template", () => {
    const cfg = new AttentionConfig({
      templates: {
        ci_failed: new Template({ title: "CI Failed", body: "PR #{pr} status={status}" }),
      },
    });
    const [title, body] = renderText(makeEvent(), cfg);
    expect(title).toBe("CI Failed");
    expect(body).toBe("PR #42 status=failed");
  });

  test("render falls back on an unknown placeholder", () => {
    const cfg = new AttentionConfig({
      templates: {
        // `branch` is not in the allowlist.
        ci_failed: new Template({ title: "CI Failed", body: "PR #{pr} branch={branch}" }),
      },
    });
    const { value, err } = capturedStderr(() => renderText(makeEvent(), cfg));
    // Falls back to the runtime default for BOTH title and body -- half a template is not
    // rendered, the warning and the fallback are whole-event.
    expect(value[0]).toBe("CI failed");
    expect(value[1]).toBe("PR #42 finished with failed.");
    expect(err).toContain("branch");
    expect(err).toContain("falling back");
  });

  test("render rejects an attribute lookup", () => {
    const cfg = new AttentionConfig({
      templates: { ci_failed: new Template({ title: "X", body: "{summary.__class__}" }) },
    });
    const { value, err } = capturedStderr(() => renderText(makeEvent(), cfg));
    // Whole-template fallback, because the field name uses `.`.
    expect(value[0]).toBe("CI failed");
    expect(value[1]).toBe("PR #42 finished with failed.");
    expect(err).toContain("falling back");
  });

  test("render rejects an index lookup", () => {
    const cfg = new AttentionConfig({
      templates: { ci_failed: new Template({ title: "X", body: "{summary[0]}" }) },
    });
    const { value } = capturedStderr(() => renderText(makeEvent(), cfg));
    expect(value[0]).toBe("CI failed");
    expect(value[1]).toBe("PR #42 finished with failed.");
  });

  test("render truncates a long body", () => {
    const cfg = new AttentionConfig({
      maxTitleChars: 10,
      maxBodyChars: 20,
      templates: {
        ci_failed: new Template({ title: "A".repeat(80), body: "B".repeat(80) }),
      },
    });
    const [title, body] = renderText(makeEvent(), cfg);
    // `len()` on a `str` is a code point count, which is what these two assert.
    expect([...title].length).toBe(10);
    expect(title.endsWith(ELLIPSIS)).toBe(true);
    expect([...body].length).toBe(20);
    expect(body.endsWith(ELLIPSIS)).toBe(true);
  });

  test("render supports a Japanese template", () => {
    const cfg = new AttentionConfig({
      templates: {
        ci_failed: new Template({
          title: JA_TITLE,
          body: JA_BODY,
        }),
      },
    });
    const [title, body] = renderText(makeEvent(), cfg);
    expect(title).toBe(JA_TITLE);
    expect(body).toBe(JA_BODY_RENDERED);
  });

  test("render substitutes the summary placeholder", () => {
    const cfg = new AttentionConfig({
      templates: {
        pending_decision: new Template({ title: JA_PENDING, body: "{task_id}: {summary}" }),
      },
    });
    const event = makeEvent({
      kind: "pending_decision",
      severity: "urgent",
      title: "X",
      body: "Y",
      source: "pending_decisions",
      taskId: "T",
      summary: "should we ship?",
      pr: null,
      status: null,
      worker: null,
    });
    const [title, body] = renderText(event, cfg);
    expect(title).toBe(JA_PENDING);
    expect(body).toBe("T: should we ship?");
  });

  // -------------------------------------------------------------------------
  // notify: dispatch behaviour
  // -------------------------------------------------------------------------

  test("a dry run skips the subprocess and the dedup state", () => {
    const runner = recordingRunner();
    const out = recordingStream();
    const result = notify(makeEvent(), new AttentionConfig(), {
      dryRun: true,
      backend: "linux",
      logStream: out,
      runner: runner.run,
    });
    expect(runner.calls).toEqual([]);
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(false);
    // The stdout log line is still emitted in a dry run.
    expect(out.text()).toContain("URGENT");
    expect(out.text()).toContain("ci_failed");
  });

  test("a dispatch invokes the backend runner", () => {
    const runner = recordingRunner();
    const result = notify(makeEvent(), new AttentionConfig(), {
      backend: "linux",
      logStream: recordingStream(),
      runner: runner.run,
    });
    expect(result.desktopDispatched).toBe(true);
    expect(runner.calls.length).toBeGreaterThan(0);
    expect((runner.calls[0] as string[])[0]).toBe("notify-send");
    expect((runner.calls[0] as string[])[1]).toContain("CI failed");
  });

  test("the stdout backend runs no subprocess but bells on urgent", () => {
    const out = recordingStream();
    const { value: result } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "stdout",
        logStream: out,
        runner: forbiddenRunner("runner should not run"),
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(true);
    expect(out.text()).toContain("URGENT");
  });

  test("the bell rings on a macOS desktop success", () => {
    const { value: result } = capturedStderr(() =>
      // urgent event, sound=urgent-only
      notify(makeEvent(), new AttentionConfig(), {
        backend: "macos",
        logStream: recordingStream(),
        runner: () => undefined,
      }),
    );
    expect(result.desktopDispatched).toBe(true);
    expect(result.bellDispatched).toBe(true);
  });

  test("the bell rings on a Linux desktop success", () => {
    const { value: result } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "linux",
        logStream: recordingStream(),
        runner: () => undefined,
      }),
    );
    expect(result.desktopDispatched).toBe(true);
    expect(result.bellDispatched).toBe(true);
  });

  test("there is no double bell on a Windows success", () => {
    const result = notify(makeEvent(), new AttentionConfig(), {
      backend: "windows",
      logStream: recordingStream(),
      runner: () => undefined,
    });
    expect(result.desktopDispatched).toBe(true);
    expect(result.bellDispatched).toBe(false);
  });

  test("a normal-severity event does not bell under urgent-only", () => {
    const cfg = new AttentionConfig();
    const out = recordingStream();
    const result = notify(makeEvent({ severity: "normal", kind: "worker_completed" }), cfg, {
      backend: "stdout",
      logStream: out,
      runner: forbiddenRunner("no runner expected"),
    });
    expect(result.bellDispatched).toBe(false);
  });

  test("sound off stays silent even on urgent", () => {
    const cfg = new AttentionConfig({ sound: "off" });
    const result = notify(makeEvent(), cfg, {
      backend: "stdout",
      logStream: recordingStream(),
      runner: forbiddenRunner("no runner expected"),
    });
    expect(result.bellDispatched).toBe(false);
  });

  test("a runner that raises falls back to the bell", () => {
    const out = recordingStream();
    const { value: result, err } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "linux",
        logStream: out,
        runner: () => {
          throw new SubprocessRunError("nope");
        },
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(true);
    expect(err).toContain("failed");
  });

  test("a runner returning a non-zero code falls back to the bell", () => {
    const out = recordingStream();
    const { value: result, err } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "linux",
        logStream: out,
        runner: () => failingProc,
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(true);
    expect(err).toContain("exited with code 1");
  });

  // -------------------------------------------------------------------------
  // reachedUser
  // -------------------------------------------------------------------------

  test("reachedUser is true for stdout-only mode", () => {
    const result = notify(
      makeEvent({ severity: "normal", kind: "worker_completed" }),
      new AttentionConfig(),
      { backend: "stdout", logStream: recordingStream() },
    );
    expect(result.desktopIntended).toBe(false);
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(false);
    expect(result.reachedUser).toBe(true);
  });

  test("reachedUser is false when the desktop failed and nothing sounded", () => {
    const cfg = new AttentionConfig({ sound: "off" });
    const { value: result } = capturedStderr(() =>
      notify(makeEvent({ severity: "normal", kind: "worker_completed" }), cfg, {
        backend: "linux",
        logStream: recordingStream(),
        runner: () => failingProc,
      }),
    );
    expect(result.desktopIntended).toBe(true);
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(false);
    expect(result.reachedUser).toBe(false);
  });

  test("reachedUser is true when the bell rang after the desktop failed", () => {
    const { value: result } = capturedStderr(() =>
      // urgent event, sound=urgent-only
      notify(makeEvent(), new AttentionConfig(), {
        backend: "linux",
        logStream: recordingStream(),
        runner: () => failingProc,
      }),
    );
    expect(result.bellDispatched).toBe(true);
    expect(result.reachedUser).toBe(true);
  });

  test("reachedUser is true when only the desktop is disabled", () => {
    const cfg = new AttentionConfig({ desktop: false, sound: "off" });
    const result = notify(makeEvent({ severity: "normal", kind: "worker_completed" }), cfg, {
      backend: "linux",
      logStream: recordingStream(),
      runner: forbiddenRunner("desktop=false, runner must not run"),
    });
    expect(result.desktopIntended).toBe(false);
    expect(result.reachedUser).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Windows / WSL beep gating
  // -------------------------------------------------------------------------

  parametrize(
    "a Write-Host backend with sound off skips the subprocess",
    [
      ["windows", "windows"],
      ["wsl", "wsl"],
    ] as const,
    (backend) => {
      const runner = recordingRunner();
      const cfg = new AttentionConfig({ sound: "off" });
      const result = notify(makeEvent(), cfg, {
        backend,
        logStream: recordingStream(),
        runner: runner.run,
      });
      expect(runner.calls).toEqual([]);
      expect(result.desktopIntended).toBe(false);
      expect(result.reachedUser).toBe(true);
    },
  );

  parametrize(
    "a Write-Host backend carries the beep when sound is urgent",
    [
      ["windows", "windows"],
      ["wsl", "wsl"],
    ] as const,
    (backend) => {
      const runner = recordingRunner();
      // sound="urgent-only" and the event is urgent
      notify(makeEvent(), new AttentionConfig(), {
        backend,
        logStream: recordingStream(),
        runner: runner.run,
      });
      expect(runner.calls.length).toBeGreaterThan(0);
      expect((runner.calls[0] as string[]).join(" ")).toContain("console]::beep");
    },
  );

  test("a disabled desktop still bells on urgent", () => {
    const cfg = new AttentionConfig({ desktop: false });
    const out = recordingStream();
    const { value: result } = capturedStderr(() =>
      notify(makeEvent(), cfg, {
        backend: "linux",
        logStream: out,
        runner: forbiddenRunner("desktop disabled, no runner"),
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(true);
  });

  test("control characters are stripped from the command", () => {
    const runner = recordingRunner();
    const event = makeEvent({ title: "ok\u0007evil", body: "hi\nthere" });
    capturedStderr(() =>
      notify(event, new AttentionConfig(), {
        backend: "linux",
        logStream: recordingStream(),
        runner: runner.run,
      }),
    );
    expect(runner.calls.length).toBeGreaterThan(0);
    const [, titleArg, bodyArg] = runner.calls[0] as string[];
    expect(titleArg).not.toContain("\u0007");
    expect(bodyArg).not.toContain("\n");
  });

  // -------------------------------------------------------------------------
  // wsl-notify-send
  // -------------------------------------------------------------------------

  test("wsl-notify-send sends only the toast when sound is off", () => {
    const runner = recordingRunner();
    const cfg = new AttentionConfig({ sound: "off" });
    const result = notify(makeEvent(), cfg, {
      backend: "wsl-notify-send",
      logStream: recordingStream(),
      runner: runner.run,
    });
    // The toast is visible without sound, so the desktop stays intended -- unlike the legacy
    // `wsl` / `windows` Write-Host backends.
    expect(result.desktopIntended).toBe(true);
    expect(result.desktopDispatched).toBe(true);
    expect(result.bellDispatched).toBe(false);
    expect(runner.calls.length).toBe(1);
    const toast = runner.calls[0] as string[];
    expect(toast[0]).toBe("wsl-notify-send.exe");
    expect(toast).toContain("--category");
    expect(toast[toast.indexOf("--category") + 1]).toBe("CI failed");
    // The body is the final positional argument.
    expect(toast[toast.length - 1]).toBe("PR #42 finished with failed.");
  });

  test("wsl-notify-send sends the toast and a beep when sound is on", () => {
    const runner = recordingRunner();
    // sound="urgent-only" and the event is urgent
    const result = notify(makeEvent(), new AttentionConfig(), {
      backend: "wsl-notify-send",
      logStream: recordingStream(),
      runner: runner.run,
    });
    expect(result.desktopDispatched).toBe(true);
    // The beep is a separate powershell subprocess, NOT the terminal bell.
    expect(result.bellDispatched).toBe(false);
    expect(runner.calls.length).toBe(2);
    expect((runner.calls[0] as string[])[0]).toBe("wsl-notify-send.exe");
    expect((runner.calls[1] as string[])[0]).toBe("powershell.exe");
    expect((runner.calls[1] as string[]).join(" ")).toContain("console]::beep");
  });

  test("a successful wsl-notify-send does not also ring the terminal bell", () => {
    const result = notify(makeEvent(), new AttentionConfig(), {
      backend: "wsl-notify-send",
      logStream: recordingStream(),
      runner: () => undefined,
    });
    expect(result.desktopDispatched).toBe(true);
    expect(result.bellDispatched).toBe(false);
  });

  test("a failed wsl-notify-send toast skips the beep", () => {
    const runner: string[][] = [];
    const { value: result, err } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "wsl-notify-send",
        logStream: recordingStream(),
        runner: (cmd) => {
          runner.push(cmd);
          return failingProc;
        },
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    // A failed desktop on an urgent event still bells as the audio fallback; the powershell beep
    // never ran.
    expect(result.bellDispatched).toBe(true);
    expect(runner.length).toBe(1);
    expect(err).toContain("exited with code 1");
  });

  test("a failed wsl-notify-send beep does not demote the toast", () => {
    let index = 0;
    const { value: result, err } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "wsl-notify-send",
        logStream: recordingStream(),
        runner: () => {
          index += 1;
          return index === 1 ? { returncode: 0 } : { returncode: 7 };
        },
      }),
    );
    expect(result.desktopDispatched).toBe(true);
    expect(result.bellDispatched).toBe(false);
    expect(err).toContain("wsl-notify-send beep");
  });

  test("wsl-notify-send strips control characters", () => {
    const runner = recordingRunner();
    const event = makeEvent({ title: "ok\u0007evil", body: "hi\nthere" });
    notify(event, new AttentionConfig({ sound: "off" }), {
      backend: "wsl-notify-send",
      logStream: recordingStream(),
      runner: runner.run,
    });
    expect(runner.calls.length).toBeGreaterThan(0);
    const toast = runner.calls[0] as string[];
    const category = toast[toast.indexOf("--category") + 1] as string;
    const body = toast[toast.length - 1] as string;
    expect(category).not.toContain("\u0007");
    expect(body).not.toContain("\n");
  });

  // -------------------------------------------------------------------------
  // Target-only. None of these is counted as ported coverage; each is listed in
  // `parity/attention.notify.ledger.json` with the mutation that measured it red.
  // -------------------------------------------------------------------------

  test("production reaches the subprocess through its seam (target-only)", () => {
    const calls: string[][] = [];
    patchSeam(notifySeams, "safeSubprocessRun", (cmd: string[]) => {
      calls.push(cmd);
      return { returncode: 0 };
    });
    const { value: result } = capturedStderr(() =>
      // No `runner`: this is the path a real watcher takes.
      notify(makeEvent(), new AttentionConfig(), {
        backend: "linux",
        logStream: recordingStream(),
      }),
    );
    expect(result.desktopDispatched).toBe(true);
    expect(calls.length).toBe(1);
    expect((calls[0] as string[])[0]).toBe("notify-send");
  });

  test("production reaches backend detection through its seam (target-only)", () => {
    const runner = recordingRunner();
    patchSeam(notifySeams, "detectBackend", () => "linux" as const);
    const { value: result } = capturedStderr(() =>
      // No `backend`: the source's `chosen = backend if backend is not None else detect_backend()`
      notify(makeEvent(), new AttentionConfig(), {
        logStream: recordingStream(),
        runner: runner.run,
      }),
    );
    expect(result.backend).toBe("linux");
    expect(result.desktopDispatched).toBe(true);
    expect((runner.calls[0] as string[])[0]).toBe("notify-send");
  });

  test("a runner failure that is not an OS error escapes the dispatcher (target-only)", () => {
    // The guarantee the four `pytest.fail`-shaped runners above rest on. If `dispatchDesktop`
    // caught every error, each of them would silently become a case that cannot fail.
    expect(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "linux",
        logStream: recordingStream(),
        runner: forbiddenRunner("runner should not run"),
      }),
    ).toThrow("runner should not run");
  });

  test("an unparseable template falls back with a warning (target-only)", () => {
    const cfg = new AttentionConfig({
      // `Single '{' encountered in format string` -- `string.Formatter().parse` raises, which the
      // source turns into `__invalid__` and therefore into the unknown-placeholder branch. The
      // source has no case for a template that does not parse at all.
      templates: { ci_failed: new Template({ title: "X", body: "unbalanced {" }) },
    });
    const { value, err } = capturedStderr(() => renderText(makeEvent(), cfg));
    expect(value[0]).toBe("CI failed");
    expect(value[1]).toBe("PR #42 finished with failed.");
    expect(err).toContain("__invalid__");
    expect(err).toContain("falling back");
  });

  test("a bad format spec falls back through the format branch (target-only)", () => {
    const cfg = new AttentionConfig({
      // Every name is allowed, so this reaches `format_map` and fails there: `d` is not a format
      // code for a `str`. The source catches `(ValueError, IndexError)` around that call and has
      // no case that reaches the branch at all.
      templates: { ci_failed: new Template({ title: "X", body: "{pr:d}" }) },
    });
    const { value, err } = capturedStderr(() => renderText(makeEvent(), cfg));
    expect(value[0]).toBe("CI failed");
    expect(value[1]).toBe("PR #42 finished with failed.");
    expect(err).toContain("format failed");
  });

  test("an auto-numbered field falls back through the positional refusal (target-only)", () => {
    const cfg = new AttentionConfig({
      // `_placeholders` SKIPS the empty field name (`if not field_name`), so `{}` passes the
      // allowlist and then refuses in `format_map`, which is handed no positional arguments at
      // all. MEASURED through the oracle: CPython raises `ValueError("Format string contains
      // positional fields")` here rather than the `IndexError` the source's own
      // `except (ValueError, IndexError)` names, which makes that second class unreachable
      // through `render_text`. The source reaches neither.
      templates: { ci_failed: new Template({ title: "X", body: "empty {}" }) },
    });
    const { value, err } = capturedStderr(() => renderText(makeEvent(), cfg));
    expect(value[0]).toBe("CI failed");
    expect(value[1]).toBe("PR #42 finished with failed.");
    expect(err).toContain("format failed");
  });

  test("an escaped brace is not a placeholder (target-only)", () => {
    const cfg = new AttentionConfig({
      // A regular expression over `\{(\w+)\}` reads `{{pr}}` as a reference to `pr`. CPython
      // reads it as the literal text `{pr}`, and the difference is visible in the OUTPUT rather
      // than only in the allowlist: the operator gets braces, not 42.
      templates: { ci_failed: new Template({ title: "T", body: "{{pr}} = {pr}" }) },
    });
    const [title, body] = renderText(makeEvent(), cfg);
    expect(title).toBe("T");
    expect(body).toBe("{pr} = 42");
  });

  test("a conversion and a format spec are honoured (target-only)", () => {
    const cfg = new AttentionConfig({
      // `{summary!r}` is a bare identifier with a conversion, so the allowlist accepts it and
      // `format_map` renders `repr()`. `{status:>8}` is the format-spec half.
      templates: { ci_failed: new Template({ title: "T", body: "{summary!r} [{status:>8}]" }) },
    });
    const [, body] = renderText(makeEvent({ summary: "ship it" }), cfg);
    expect(body).toBe("'ship it' [  failed]");
  });

  test("truncation counts code points, not UTF-16 units (target-only)", () => {
    const cfg = new AttentionConfig({
      maxTitleChars: 4,
      maxBodyChars: 240,
      // Four astral characters. `String#slice(0, 3)` would cut between a surrogate pair and
      // produce a lone surrogate; `len()` in Python is 4 and the cut is at code point 3.
      templates: { ci_failed: new Template({ title: "\u{1F600}".repeat(6), body: "b" }) },
    });
    const [title] = renderText(makeEvent(), cfg);
    expect(title).toBe(`${"\u{1F600}".repeat(3)}${ELLIPSIS}`);
    expect([...title].length).toBe(4);
  });

  test("a child killed by a signal is not a clean exit (target-only)", () => {
    // `spawnSync` reports a signalled child as `status: null` plus a `signal` name, and does NOT
    // necessarily set `error`. Reading `status ?? 0` would call that a clean exit, so the desktop
    // dispatch would report success for a backend that was killed mid-notification and the CLI
    // would record the event as delivered -- the shape `reachedUser` exists to prevent, on the one
    // path no other case covers because every one of them replaces the runner.
    //
    // The INNER seam is what this patches. The first draft patched `safeSubprocessRun` and
    // asserted on a `returncode` it had supplied itself; it measured GREEN under the mutation it
    // was written to catch, which is rule 10 doing its job.
    patchSeam(notifySeams, "spawn", (() => ({
      status: null,
      signal: "SIGKILL",
      pid: 1234,
      output: [],
      stdout: "",
      stderr: "",
    })) as unknown as typeof notifySeams.spawn);
    const { value: result, err } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "linux",
        logStream: recordingStream(),
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    // Urgent event, sound=urgent-only: the bell is the audio fallback, so the user is still
    // reached -- but by the bell, not by a desktop notification that never arrived.
    expect(result.bellDispatched).toBe(true);
    // `-9` is `-signal.SIGKILL`, which is what `CompletedProcess.returncode` carries there.
    expect(err).toContain("exited with code -9");
  });

  test("the real subprocess call goes through its own seam (target-only)", () => {
    // Liveness for the inner seam, without which the case above would be asserting about a
    // function production no longer calls.
    const calls: string[][] = [];
    patchSeam(notifySeams, "spawn", ((command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { status: 0, signal: null, pid: 1, output: [], stdout: "", stderr: "" };
    }) as unknown as typeof notifySeams.spawn);
    const result = notifySeams.safeSubprocessRun(["notify-send", "title", "body"]);
    expect(result.returncode).toBe(0);
    expect(calls).toEqual([["notify-send", "title", "body"]]);
  });

  test("a bell that could not be written did not ring (target-only, D-0023)", () => {
    // DELIBERATE DIVERGENCE. The source writes `bell(); bell_dispatched = True`, so a closed
    // stderr still counts as an audio channel that reached the user -- and with the desktop
    // dispatch also failed, `reached_user` is then true for a notification that reached nobody
    // and the CLI dedups it for good. `D-0023` puts the repair in the belt that touches the code.
    // Only the BEL write fails. The warning `dispatchDesktop` prints goes to the same stream, and
    // a stream that refused everything would model a stderr the SOURCE cannot survive either --
    // its `print(file=sys.stderr)` raises just as loudly -- which is a different (and inherited)
    // fragility from the one this case is about.
    patchSeam(notifySeams, "stderr", () => ({
      write(text: string): void {
        if (text === "\u0007") {
          throw new Error("EPIPE: broken pipe");
        }
      },
    }));
    const cfg = new AttentionConfig();
    const result = notify(makeEvent(), cfg, {
      backend: "linux",
      logStream: recordingStream(),
      runner: () => failingProc,
    });
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(false);
    // The whole point: nothing reached the user, so the CLI must not record it.
    expect(result.reachedUser).toBe(false);
  });

  test("an overflowing format width is refused, not a RangeError (target-only)", () => {
    const cfg = new AttentionConfig({
      // MEASURED on CPython 3.12.3: `format("42", "9" * 33)` raises
      // `ValueError("Too many decimal digits in format string")`, so `render_text` warns and falls
      // back. `Number.parseInt` alone produces `1e33` and `String#repeat` then throws a
      // `RangeError`, which is neither class the source catches -- an operator's mistyped template
      // would take the watcher down.
      templates: { ci_failed: new Template({ title: "T", body: `{pr:${"9".repeat(33)}}` }) },
    });
    const { value, err } = capturedStderr(() => renderText(makeEvent(), cfg));
    expect(value[0]).toBe("CI failed");
    expect(value[1]).toBe("PR #42 finished with failed.");
    expect(err).toContain("Too many decimal digits");
  });

  test("a Write-Host backend that never ran still bells (target-only, D-0023)", () => {
    // DELIBERATE DIVERGENCE. The source suppresses the bell for `windows` and `wsl`
    // unconditionally, on the stated grounds that `[console]::beep` is "already inside the
    // PowerShell command" -- a reason that only holds when that command RAN. With `desktop=false`
    // an urgent event with sound enabled therefore makes no sound at all on those two backends.
    const cfg = new AttentionConfig({ desktop: false });
    const { value: result } = capturedStderr(() =>
      notify(makeEvent(), cfg, {
        backend: "windows",
        logStream: recordingStream(),
        runner: forbiddenRunner("desktop disabled, no runner"),
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(true);
  });

  test("a failed Write-Host dispatch falls back to the bell (target-only, D-0023)", () => {
    // The other half of the same hole, and the one the source already closes for
    // `wsl-notify-send`: a subprocess that failed carried no beep either.
    const { value: result, err } = capturedStderr(() =>
      notify(makeEvent(), new AttentionConfig(), {
        backend: "wsl",
        logStream: recordingStream(),
        runner: () => failingProc,
      }),
    );
    expect(result.desktopDispatched).toBe(false);
    expect(result.bellDispatched).toBe(true);
    expect(err).toContain("exited with code 1");
  });

  test("a notification records what it sent (target-only)", () => {
    // `FormattedNotification` is frozen the way the source's `frozen=True` dataclass is, and
    // `readonly` alone is erased at emit.
    const result = notify(makeEvent(), new AttentionConfig(), {
      dryRun: true,
      backend: "stdout",
      logStream: recordingStream(),
    });
    expect(result).toBeInstanceOf(FormattedNotification);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { title: string }).title = "rewritten";
    }).toThrow(TypeError);
  });
});
