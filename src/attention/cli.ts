/**
 * `continuo attention scan` / `continuo attention watch`.
 *
 * Ported from interlock `claude_org_runtime/attention/cli.py` at `65f36c5`, under the attention
 * belt's sub-belt A3 (`D-0034`). This is the belt's pipeline: the one place where the readers, the
 * classifier, the dedup ledger and the notifier are wired to each other, and therefore the only
 * module in the subsystem whose behaviour is a property of all five.
 *
 * Mounted into the unified CLI by `src/cli.ts`, which owns no flag of its own here -- the subtree's
 * own module declares its parser, exactly as `measurement/cli.ts` and `settings/cli.ts` do
 * (`D-0030`).
 *
 * **What is NOT the source's, and why.**
 *
 * - **A refused dedup ledger stops the scan.** A2's `D-0904` made `loadState` fail closed: a state
 *   file that is present and unusable is a refusal, not an empty ledger, because an empty ledger
 *   says nothing has been notified and frees every already-handled event to fire again. The source
 *   recovers silently and rewrites the file, and one of its own CLI cases pins that. What A2's
 *   decision does NOT settle is what the CLI does with the refusal, which is this module's call and
 *   is recorded in its own `D-` entry: `scan` and `watch` report it on stderr and exit 2, leaving
 *   the file exactly as they found it, rather than letting a `DedupStateRefused` escape as an
 *   unhandled error with a stack trace.
 * - **The clock and the sleep are seams.** The source's cases patch
 *   `attention.cli.datetime` and `attention.cli.time.sleep` with `monkeypatch.setattr`; ESM
 *   bindings cannot be rebound from outside, so both go through {@link attentionCliSeams}
 *   (`docs/test-translation-conventions.md` rule 5), and each has a target-only liveness case.
 */

import { join, resolve } from "node:path";
import process from "node:process";
import type { ArgumentParser, Namespace, Subparsers } from "../cli/parser.js";
import { ArgparseExit } from "../cli/parser.js";
import { pyJsonDumps } from "../fencing/pyjson.js";
import { pyRepr } from "../fencing/pyrepr.js";
import { PyValueError } from "../fencing/pysemantics.js";
import { type AttentionEvent, classifyAll } from "./classifier.js";
import { type AttentionConfig, loadConfig } from "./config.js";
import {
  type DedupState,
  DedupStateRefused,
  loadState,
  recordNotified,
  saveState,
  shouldNotify,
} from "./dedup.js";
import { type Backend, renderText, notify as runNotify, type TextStream } from "./notify.js";
import {
  readBrokerDeliverySignals,
  readBrokerDuplicates,
  readEvents,
  readPendingDecisions,
} from "./readers.js";

/**
 * Where the org-broker's state directory sits, relative to the attention state root.
 *
 * Mirrors the broker's own `DEFAULT_STATE_DIR` (`.state/broker`): the journal lives one level under
 * the `.state` root the watcher already points at. Overridable with `--broker-state-dir` for a
 * daemon started with a non-default `--state-dir`.
 */
export const BROKER_SUBDIR = "broker";

/** ASCII only: this string reaches `--help` on a cp932 console (`docs/cli-output-policy.md`). */
const BROKER_STATE_DIR_HELP =
  "org-broker state dir holding queue.jsonl, scanned for " +
  `duplicate_sidecar_detected (default: <state-dir>/${BROKER_SUBDIR}). ` +
  "Point this at a daemon started with a non-default --state-dir.";

/**
 * The seams this module carries, and the only place production reaches them.
 *
 * `now` is `datetime.now(timezone.utc)`, which the source's CLI cases freeze so that a fixture
 * timestamp does not slide down the TTL ladder as the calendar advances. `sleep` is
 * `time.sleep`, which they replace so the watch loop does not really wait. `stdout` is
 * `sys.stdout`, which the `--json` payload is written to and which the source reads back through
 * `capsys`; a module-level binding captured at import would not see a replacement.
 */
export const attentionCliSeams = {
  now: (): Date => new Date(),
  sleep: (seconds: number): void => {
    // A synchronous sleep, because the source's loop is synchronous and the port is not free to
    // make `watch` asynchronous without changing what a `KeyboardInterrupt` interrupts.
    // `Atomics.wait` on a private buffer is the only way Node blocks a thread without spinning.
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, seconds * 1000);
  },
  stdout: (): TextStream => process.stdout,
  stderr: (): TextStream => process.stderr,
};

/** `(state.db, pending_decisions.json, attention_notified.json)` under `stateDir`. */
export function statePaths(stateDir: string): [string, string, string] {
  return [
    join(stateDir, "state.db"),
    join(stateDir, "pending_decisions.json"),
    join(stateDir, "attention_notified.json"),
  ];
}

/**
 * Resolve the broker state dir: the flag if given, else `<stateDir>/broker`.
 *
 * `Path(override).resolve()` becomes `resolve()`. The two differ on symbolic links -- Python
 * resolves them and this does not -- and nothing here reads through one: the value is joined with
 * a file name and handed to `existsSync`, which follows links itself.
 */
export function resolveBrokerStateDir(stateDir: string, override: string | null): string {
  if (override !== null && override !== "") {
    return resolve(override);
  }
  return join(stateDir, BROKER_SUBDIR);
}

/** Everything `scanOnce` takes beyond the state directory and the config. */
export interface ScanOptions {
  readonly now: Date;
  readonly dryRun: boolean;
  readonly backend?: Backend | null;
  readonly emitJson?: boolean;
  readonly logStream?: TextStream | null;
  readonly brokerStateDir?: string | null;
}

/**
 * One classification and dispatch cycle. Returns the events notified.
 *
 * `brokerStateDir` points at the org-broker's state dir so `duplicate_sidecar_detected` journal
 * lines reach the operator; `null` skips the broker journal entirely, which keeps callers that
 * only care about `.state` unchanged. The same directory feeds the delivery-ownership signals,
 * read with their own, longer freshness window because they do not repeat.
 */
export function scanOnce(
  stateDir: string,
  cfg: AttentionConfig,
  options: ScanOptions,
): AttentionEvent[] {
  const [dbPath, pendingPath, dedupPath] = statePaths(stateDir);
  const { now, dryRun } = options;
  const brokerStateDir = options.brokerStateDir ?? null;
  const emitJson = options.emitJson ?? false;
  const events = readEvents(dbPath);
  const pending = readPendingDecisions(pendingPath);
  // `now.timestamp()` is epoch SECONDS as a float; `Date#getTime` is milliseconds.
  const nowEpoch = now.getTime() / 1000;
  // Widened to a record at the seam. `readBrokerDuplicates` publishes a three-key INTERFACE and
  // `classifyAll` takes a `Record<string, unknown>`; an interface without an index signature is
  // not assignable to one, though the value is the same object with the same three keys. Python
  // had nothing to reconcile here -- both sides are a `dict` -- and this is the first caller to
  // put the two together, which is why the seam surfaces in the pipeline rather than in either
  // module's own belt. Spread rather than cast, so a field renamed on either side is a compile
  // error here instead of an `undefined` at runtime.
  const duplicates: Record<string, unknown>[] =
    brokerStateDir !== null
      ? readBrokerDuplicates(brokerStateDir, {
          nowEpoch,
          windowSec: cfg.duplicateSidecarWindowSec,
        }).map((row) => ({ ts: row.ts, owner: row.owner, instances: row.instances }))
      : [];
  const deliverySignals =
    brokerStateDir !== null
      ? readBrokerDeliverySignals(brokerStateDir, {
          nowEpoch,
          windowSec: cfg.deliverySignalWindowSec,
        })
      : [];
  const classified = classifyAll(events, pending, now, {
    pendingDecisionMin: cfg.pendingDecisionMin,
    userRepliedMin: cfg.userRepliedMin,
    notifyMap: cfg.notify,
    pendingDecisionMax: cfg.pendingDecisionMax,
    pendingDecisionDrop: cfg.pendingDecisionDrop,
    brokerDuplicates: duplicates,
    brokerDeliverySignals: deliverySignals,
  });
  const state: DedupState = loadState(dedupPath);
  const notified: AttentionEvent[] = [];
  const notifiedPayloads: Record<string, unknown>[] = [];
  // With `--json` the caller wants a machine-readable stdout payload, so the human log lines go to
  // stderr instead and stdout stays pure JSON.
  let effectiveLog = options.logStream ?? null;
  if (emitJson && effectiveLog === null) {
    effectiveLog = attentionCliSeams.stderr();
  }
  let stateDirty = false;
  for (const event of classified) {
    // A drop-tier row is surfaced in `attention scan --json` for triage but never routed to
    // `notify`: no desktop ping, no bell, no dedup update. `renderText` runs even on the
    // suppressed branch so template overrides and the `max_*_chars` truncation apply to the JSON
    // title and body -- otherwise a stale pending would emit the runtime-default English copy
    // while every other row carried the operator's template. `delivered` stays false so a machine
    // consumer can tell "classified but suppressed" from "delivered".
    if (event.suppressed) {
      const [renderedTitle, renderedBody] = renderText(event, cfg);
      const payload = event.toDict();
      payload["title"] = renderedTitle;
      payload["body"] = renderedBody;
      payload["desktop_dispatched"] = false;
      payload["bell_dispatched"] = false;
      payload["delivered"] = false;
      notifiedPayloads.push(payload);
      continue;
    }
    if (
      !shouldNotify(state, event.key, {
        source: event.source,
        cooldownSec: cfg.cooldownSec,
        now,
      })
    ) {
      continue;
    }
    notified.push(event);
    const formatted = runNotify(event, cfg, {
      dryRun,
      backend: options.backend ?? null,
      logStream: effectiveLog,
    });
    // The rendered title and body go into `--json` so the payload reflects what was actually sent
    // (post-template, post-truncation). `delivered` mirrors `FormattedNotification.reachedUser` so
    // a machine consumer can tell "classified" from "actually delivered" without re-implementing
    // the dispatch contract.
    const payload = event.toDict();
    payload["title"] = formatted.title;
    payload["body"] = formatted.body;
    payload["desktop_dispatched"] = formatted.desktopDispatched;
    payload["bell_dispatched"] = formatted.bellDispatched;
    payload["delivered"] = formatted.reachedUser;
    notifiedPayloads.push(payload);
    if (dryRun) {
      continue;
    }
    // Only mark dedup'd when the notification reached the user. `reachedUser` covers desktop
    // success, the bell fallback and the intentional stdout-only / desktop-disabled modes; a
    // silently-failing desktop subprocess does NOT count, so the next poll retries instead of
    // suppressing forever.
    if (formatted.reachedUser) {
      recordNotified(state, event.key, { source: event.source, now });
      stateDirty = true;
    }
  }
  if (stateDirty) {
    saveState(dedupPath, state);
  }
  if (emitJson) {
    // `json.dump(..., indent=2, ensure_ascii=False)`, through the port's CPython `json.dumps`
    // transcription rather than `JSON.stringify`: the payload carries an operator's template text,
    // and the two disagree about how a non-BMP character and a lone surrogate are emitted.
    attentionCliSeams
      .stdout()
      .write(`${pyJsonDumps(notifiedPayloads, { indent: 2, ensureAscii: false })}\n`);
  }
  return notified;
}

/**
 * `load_config`, with a clean error instead of a traceback.
 *
 * The source catches `(ValueError, OSError, json.JSONDecodeError)`. `JSONDecodeError` is a
 * `ValueError` subclass there and is a native `SyntaxError` here, because `pyJsonLoads` parses
 * with `JSON.parse` -- so it is named explicitly. Leaving it out is what would turn the source's
 * "garbled config exits 2" case into an unhandled `SyntaxError`.
 */
export function loadCfgOrExit(configArg: string | null): AttentionConfig {
  if (configArg === null || configArg === "") {
    return loadConfig(null);
  }
  try {
    return loadConfig(configArg);
  } catch (error) {
    if (!isConfigRefusal(error)) {
      throw error;
    }
    attentionCliSeams
      .stderr()
      .write(`error: invalid attention config ${pyRepr(configArg)}: ${messageOf(error)}\n`);
    throw new ArgparseExit(2, "invalid attention config");
  }
}

/** `(ValueError, OSError, json.JSONDecodeError)`, in this runtime's classes. */
function isConfigRefusal(error: unknown): boolean {
  if (error instanceof PyValueError || error instanceof SyntaxError) {
    return true;
  }
  // Node reports an `OSError` as an `Error` carrying an errno `code`; there is no class to test.
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** `str(exc)` for the message half of a refusal. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Report a refused dedup ledger and stop, rather than letting the refusal escape.
 *
 * A2's `D-0904` fails closed on a state file that is present and unusable. This is the CLI's half
 * of that decision, and it is A3's to make: the operator gets one line naming the file and the
 * process exits 2, the same code a refused config exits with, because both mean "an input this
 * command was pointed at cannot be used". Nothing is written -- in particular the refused file is
 * left exactly as it was found, so an operator can inspect it and so a later run cannot mistake a
 * rewritten empty ledger for a ledger that was always empty.
 */
function refuseDedupState(error: DedupStateRefused): never {
  attentionCliSeams.stderr().write(`error: ${error.message}\n`);
  throw new ArgparseExit(2, "refused attention dedup state");
}

/** `cmd_attention_scan`. */
export function cmdAttentionScan(args: Namespace): number {
  const stateDir = resolve(String(args["state_dir"]));
  const cfg = loadCfgOrExit(optionalString(args["config"]));
  try {
    scanOnce(stateDir, cfg, {
      now: attentionCliSeams.now(),
      dryRun: Boolean(args["dry_run"]),
      emitJson: Boolean(args["json"]),
      brokerStateDir: resolveBrokerStateDir(stateDir, optionalString(args["broker_state_dir"])),
    });
  } catch (error) {
    if (error instanceof DedupStateRefused) {
      refuseDedupState(error);
    }
    throw error;
  }
  return 0;
}

/** `cmd_attention_watch`. */
export function cmdAttentionWatch(args: Namespace): number {
  const stateDir = resolve(String(args["state_dir"]));
  const cfg = loadCfgOrExit(optionalString(args["config"]));
  const brokerStateDir = resolveBrokerStateDir(stateDir, optionalString(args["broker_state_dir"]));
  // `max(1, int(cfg.poll_interval_sec))`.
  const interval = Math.max(1, Math.trunc(cfg.pollIntervalSec));
  const maxIterations =
    args["max_iterations"] === undefined ? null : Number(args["max_iterations"]);
  let count = 0;
  for (;;) {
    try {
      scanOnce(stateDir, cfg, {
        now: attentionCliSeams.now(),
        dryRun: false,
        brokerStateDir,
      });
    } catch (error) {
      if (error instanceof DedupStateRefused) {
        refuseDedupState(error);
      }
      throw error;
    }
    count += 1;
    if (maxIterations !== null && count >= maxIterations) {
      break;
    }
    attentionCliSeams.sleep(interval);
  }
  // The source also catches `KeyboardInterrupt` and prints one line. There is no equivalent to
  // catch here: Node delivers SIGINT as a process signal rather than as an exception raised inside
  // the loop, so the handler would have to be installed on `process` -- a different mechanism with
  // a different lifetime, and one that would still be installed after `watch` returned. The
  // divergence is recorded in `parity/attention.cli.ledger.json`; no source case exercises it.
  return 0;
}

/** `x if x else None` on a flag argparse defaults to `None`. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `add_subparsers`: mount `scan` and `watch` under the caller's `attention` subparser. */
export function addSubparsers(sub: Subparsers): void {
  const scan = sub.addParser("scan", "One-shot scan of .state for attention events");
  addCommonArguments(scan);
  scan.addArgument({
    optionStrings: ["--dry-run"],
    dest: "dry_run",
    storeTrue: true,
    help:
      "classify and log, but never invoke an OS notification subprocess " + "or update dedup state",
  });
  scan.addArgument({
    optionStrings: ["--json"],
    dest: "json",
    storeTrue: true,
    help: "emit notified events to stdout as JSON",
  });
  scan.setDefaults({ func: cmdAttentionScan });

  const watch = sub.addParser("watch", "Long-running poll of .state for attention events");
  addCommonArguments(watch);
  watch.addArgument({
    optionStrings: ["--max-iterations"],
    dest: "max_iterations",
    type: "int",
    // `help=argparse.SUPPRESS` in the source: the flag exists so the loop can terminate under
    // test and is not part of the documented surface. This parser has no SUPPRESS, so the help
    // text says what the flag is for and why it is not for operators.
    help: "stop after this many polls (test hook; not part of the supported surface)",
  });
  watch.setDefaults({ func: cmdAttentionWatch });
}

/** The three flags `scan` and `watch` declare identically. */
function addCommonArguments(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--state-dir"],
    dest: "state_dir",
    defaultValue: ".state",
    help: "state directory root (default: .state)",
  });
  parser.addArgument({
    optionStrings: ["--config"],
    dest: "config",
    help: "path to attention config JSON (optional)",
  });
  parser.addArgument({
    optionStrings: ["--broker-state-dir"],
    dest: "broker_state_dir",
    help: BROKER_STATE_DIR_HELP,
  });
}
