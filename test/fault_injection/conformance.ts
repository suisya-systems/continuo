/**
 * The adapter conformance battery (design 6.3).
 *
 * Ported from interlock `tests/fault_injection/conformance.py` at `65f36c5`.
 *
 * Run against **every** `FullFaultAdapter` the build ships. An adapter that has
 * not passed it cannot contribute matrix results -- this is the mechanical form
 * of design section 2.2's "stays valid" claim, and it is what a future adapter
 * will be built against.
 *
 * It asserts the contract itself, not any component's behaviour:
 *
 * 1. every checkpoint is reachable, and an armed one blocks;
 * 2. the barrier round-trip works -- `continue` releases and the script
 *    finishes;
 * 3. SIGKILL at each checkpoint yields exit `-SIGKILL` and a database the
 *    invariant queries can still be run against;
 * 4. the restart entrypoint emits recovery-complete and is idempotent --
 *    restarting twice changes nothing;
 * 5. the injected clock is honoured -- `set_clock_offset` visibly moves the
 *    driver's reported `now_ms`;
 * 6. two runs of one case with one seed produce identical event traces;
 * 7. the contract's checkpoint names equal the adapter's own vocabulary;
 * 8. the driver CLI accepts every option the contract names;
 * 9. the driver never reads the host clock.
 *
 * So "the harness ran" can never silently mean "the adapter faked it".
 *
 * **One subject is a complete exam (D-0601).** The battery is a qualification,
 * not a comparison: a second adapter adds coverage of that adapter, not of the
 * exam.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import ts from "typescript";

import * as contract from "./contract.js";
import {
  ArmedAnchor,
  ContractViolation,
  type FaultCase,
  type FullFaultAdapter,
  type InvariantRow,
} from "./contract.js";
import { Controller, type EventRecord } from "./controller.js";
import { RUNNER_BUDGET_CEILING_S } from "./policy.js";

export const CONFORMANCE_CLOCK_BASE_MS = 1_700_000_000_000;
export const CONFORMANCE_TTL_MS = 30_000;
export const CONFORMANCE_SEED = 4_242;

/**
 * A minimal case for the battery. Never part of the matrix.
 *
 * Deliberately built here rather than borrowed from the manifest: the battery
 * must be runnable against an adapter before that adapter has any manifest cases
 * at all.
 */
export function syntheticCase(options: {
  caseId: string;
  role: string;
  arms: Readonly<Record<string, readonly string[]>>;
  messages?: number;
  behaviours?: readonly string[];
}): Record<string, unknown> {
  const arms: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(options.arms)) {
    arms[key] = [...value];
  }
  return {
    case_id: options.caseId,
    targets: [options.role],
    operation: contract.OPERATION_ATTEMPT,
    checkpoint: contract.CHECKPOINT_BEFORE_DURABLE_WRITE,
    fault: "sigkill",
    variant: null,
    lane: contract.LANE_PORTABLE,
    profiles: ["full"],
    barrier: contract.BARRIER_ALIGNED,
    arms,
    kill_order: [options.role],
    restart_order: [options.role],
    expected: { queries: [], destination: [], recovery_owner: null },
    messages: options.messages ?? 1,
    behaviours: [...(options.behaviours ?? [])],
    claimant: null,
    skew: null,
    release_after_barrier: false,
    restart_after: false,
    staggered: null,
    incident_params: null,
    observation: null,
    unavailable_attempts: null,
    adapter: "spike",
    ttl_ms: CONFORMANCE_TTL_MS,
    clock_base_ms: CONFORMANCE_CLOCK_BASE_MS,
    manifest_version: 0,
  };
}

function makeController(
  adapter: FullFaultAdapter,
  workdir: string,
  faultCase: FaultCase,
): Controller {
  return new Controller({
    workdir,
    adapter,
    case: faultCase,
    suiteSeed: CONFORMANCE_SEED,
    barrierTimeoutS: 15.0,
    // The source's constant here is 60s, which is exactly Vitest's own
    // `testTimeout`. Held under {@link RUNNER_BUDGET_CEILING_S} for the reason
    // D-0602 gives for the manifest-case path, and it applies with more force
    // here: a driver that hangs after spawning -- waiting on `recovery_complete`
    // or `done` -- would otherwise let the RUNNER time out first, replacing the
    // harness's attributable failure with "a test took too long" and cutting
    // off the `finally` that runs the teardown ladder. The battery is the one
    // place a NEW adapter is qualified, so it is the last place that should
    // report a hang without saying whose.
    caseTimeoutS: RUNNER_BUDGET_CEILING_S,
  });
}

// ---------------------------------------------------------------------------
// 1 and 2 -- reachable, blocking, and released by the round-trip
// ---------------------------------------------------------------------------

/** The named window is reached, announced, and the process holds there. */
export async function checkCheckpointBlocks(
  adapter: FullFaultAdapter,
  workdir: string,
  options: { role: string; operation: string; checkpoint: string },
): Promise<EventRecord> {
  const wire = `${options.operation}@${options.checkpoint}:1`;
  const faultCase = syntheticCase({
    caseId: `conformance-${options.role}-${options.operation}-${options.checkpoint}`,
    role: options.role,
    arms: { [options.role]: [wire] },
  });
  const controller = makeController(adapter, workdir, faultCase);
  try {
    controller.bootstrap();
    await controller.spawn(options.role, { armed: [ArmedAnchor.parse(wire)] });
    const event = await controller.waitAtAnchor(options.role);
    if (event["name"] !== options.checkpoint || event["operation"] !== options.operation) {
      throw new ContractViolation(
        `asked for ${options.operation}@${options.checkpoint}, the driver stopped at ` +
          `${event["operation"]}@${event["name"]}`,
      );
    }
    const roleProcess = controller.processes.get(options.role);
    if (roleProcess === undefined || roleProcess.exited) {
      throw new ContractViolation("the driver exited at the barrier instead of blocking in it");
    }
    return { ...event };
  } finally {
    await controller.teardown();
  }
}

/** `continue` releases the barrier and the script runs to a clean exit. */
export async function checkBarrierRoundTrip(
  adapter: FullFaultAdapter,
  workdir: string,
  options: { role: string },
): Promise<void> {
  const checkpoint = contract.CHECKPOINT_BEFORE_DURABLE_WRITE;
  const wire = `${contract.OPERATION_ATTEMPT}@${checkpoint}:1`;
  const faultCase = syntheticCase({
    caseId: `conformance-round-trip-${options.role}`,
    role: options.role,
    arms: { [options.role]: [wire] },
  });
  const controller = makeController(adapter, workdir, faultCase);
  try {
    controller.bootstrap();
    await controller.spawn(options.role, { armed: [ArmedAnchor.parse(wire)] });
    await controller.waitAtAnchor(options.role);
    controller.release(options.role);
    await controller.runToCompletion(options.role);
  } finally {
    await controller.teardown();
  }
}

// ---------------------------------------------------------------------------
// 3 -- a real kill, and a database that survives it
// ---------------------------------------------------------------------------

/**
 * The kill is a signal, and afterwards the store is still queryable.
 *
 * The second half matters as much as the first: a SIGKILL takes down a SQLite
 * connection mid-transaction, and the invariant queries running against the
 * reopened file is the evidence that the journal recovered rather than that
 * nothing was going on.
 */
export async function checkSigkillExitStatus(
  adapter: FullFaultAdapter,
  workdir: string,
  options: { role: string; checkpoint: string; assertExitStatus: boolean },
): Promise<void> {
  const wire = `${contract.OPERATION_ATTEMPT}@${options.checkpoint}:1`;
  const faultCase = syntheticCase({
    caseId: `conformance-kill-${options.role}-${options.checkpoint}`,
    role: options.role,
    arms: { [options.role]: [wire] },
  });
  const controller = makeController(adapter, workdir, faultCase);
  try {
    controller.bootstrap();
    await controller.spawn(options.role, { armed: [ArmedAnchor.parse(wire)] });
    await controller.waitAtAnchor(options.role);
    await controller.kill(options.role, { assertExitStatus: options.assertExitStatus });
    for (const name of contract.SQL_INVARIANTS) {
      const wanted = contract.INVARIANT_PARAMETERS[name] ?? [];
      const params = adapter.queryParameters(options.role, { nowMs: CONFORMANCE_CLOCK_BASE_MS });
      const bound: Record<string, unknown> = {};
      for (const key of wanted) {
        bound[key] = params[key];
      }
      controller.query(name, bound);
    }
  } finally {
    await controller.teardown();
  }
}

// ---------------------------------------------------------------------------
// 4 -- the restart entrypoint recovers, and recovering twice changes nothing
// ---------------------------------------------------------------------------

export async function checkRestartIsIdempotent(
  adapter: FullFaultAdapter,
  workdir: string,
  options: { role: string },
): Promise<void> {
  const checkpoint = contract.CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT;
  const wire = `${contract.OPERATION_ATTEMPT}@${checkpoint}:1`;
  const faultCase = syntheticCase({
    caseId: `conformance-restart-${options.role}`,
    role: options.role,
    arms: { [options.role]: [wire] },
  });
  const controller = makeController(adapter, workdir, faultCase);
  let first: Record<string, unknown>;
  let second: Record<string, unknown>;
  try {
    controller.bootstrap();
    await controller.spawn(options.role, { armed: [ArmedAnchor.parse(wire)] });
    await controller.waitAtAnchor(options.role);
    await controller.kill(options.role, { assertExitStatus: false });

    await controller.restart(options.role);
    await controller.runToCompletion(options.role);
    first = snapshot(controller, adapter, options.role);
    const history = first[contract.INVARIANT_LINEAR_WRITER_HISTORY] as unknown[];
    const retries = first[contract.INVARIANT_RETRY_COUNT_DURABLE] as unknown[];
    if (history.length === 0 || retries.length === 0) {
      throw new ContractViolation(
        `${adapter.driverModule}: the idempotence snapshot is empty, so 'restarting twice ` +
          "changes nothing' compares nothing to nothing",
      );
    }

    await controller.restart(options.role);
    await controller.runToCompletion(options.role);
    second = snapshot(controller, adapter, options.role);
  } finally {
    await controller.teardown();
  }

  const firstText = JSON.stringify(first);
  const secondText = JSON.stringify(second);
  if (firstText !== secondText) {
    throw new ContractViolation(
      "restarting a recovered role changed durable state; recovery is not idempotent\n" +
        `first:  ${firstText}\nsecond: ${secondText}`,
    );
  }
}

/**
 * Everything a restart could change, so "changes nothing" means something.
 *
 * The write history and the retry state are in here, not only the "is anything
 * unfinished" queries: an adapter whose restart appended another applied action,
 * or bumped a retry count, or re-attempted an already-acked message, would leave
 * every unfinished-work query empty and pass an idempotence check that never
 * looked at what it actually mutated.
 *
 * The lease row is deliberately excluded -- a restart renews, and an expiry that
 * moves is the correct behaviour, not a durable change.
 */
function snapshot(
  controller: Controller,
  adapter: FullFaultAdapter,
  role: string,
): Record<string, unknown> {
  const nowMs = controller.lastReportedNowMs({ default: CONFORMANCE_CLOCK_BASE_MS });
  const params = adapter.queryParameters(role, { nowMs });
  const out: Record<string, unknown> = {};
  for (const name of [
    contract.INVARIANT_NO_UNOWNED_OUTBOX,
    contract.INVARIANT_SINGLE_ACKED_STATE,
    contract.INVARIANT_NO_PENDING_ACTION,
    contract.INVARIANT_LINEAR_WRITER_HISTORY,
    contract.INVARIANT_RETRY_COUNT_DURABLE,
  ]) {
    const wanted = contract.INVARIANT_PARAMETERS[name] ?? [];
    const bound: Record<string, unknown> = {};
    for (const key of wanted) {
      bound[key] = params[key];
    }
    out[name] = controller.query(name, bound);
  }
  const observer = controller.observer(role);
  const effects: Record<string, [number, number]> = {};
  for (const key of adapter.effectKeys(role, controller.case)) {
    effects[key] = [observer.effectCount(key), observer.attemptCount(key)];
  }
  out["effects"] = effects;
  return out;
}

// ---------------------------------------------------------------------------
// 5 -- the clock is injected, not read
// ---------------------------------------------------------------------------

/** A `set_clock_offset` at a barrier visibly moves the reported `now_ms`. */
export async function checkClockIsInjected(
  adapter: FullFaultAdapter,
  workdir: string,
  options: { role: string },
): Promise<void> {
  const wire = `${contract.OPERATION_LEASE_ACQUIRE}@${contract.SYNC_LEASE_ACQUIRED}:1`;
  const faultCase = syntheticCase({
    caseId: `conformance-clock-${options.role}`,
    role: options.role,
    arms: { [options.role]: [wire] },
  });
  const offset = contract.resolveSkewMs("forward", {
    ttlMs: CONFORMANCE_TTL_MS,
    elapsedMs: 0,
  });
  const controller = makeController(adapter, workdir, faultCase);
  try {
    controller.bootstrap();
    await controller.spawn(options.role, { armed: [ArmedAnchor.parse(wire)] });
    const atBarrier = await controller.waitAtAnchor(options.role);
    const moved = await controller.setClockOffset(options.role, offset);
    if (Number(moved["offset_ms"]) !== offset) {
      throw new ContractViolation(
        `the driver reported offset ${moved["offset_ms"]}, not ${offset}`,
      );
    }
    if (Number(moved["now_ms"]) - Number(atBarrier["now_ms"]) !== offset) {
      throw new ContractViolation(
        "the driver's reported now_ms did not move by the injected offset: " +
          `${atBarrier["now_ms"]} -> ${moved["now_ms"]}`,
      );
    }
    controller.release(options.role);
    await controller.runToCompletion(options.role);
  } finally {
    await controller.teardown();
  }
}

/**
 * Reading any of these is reading the host clock.
 *
 * The check is over the parsed syntax tree, not over the source text: a prose
 * mention of `Date.now()` in a doc comment is not a call, and a checker that
 * cannot tell the two apart teaches people to stop writing the comment. The
 * source parses Python with `ast`; this parses TypeScript with the compiler API,
 * which is the same choice for the same reason and follows the precedent in
 * `test/canary/structural.test.ts`.
 */
export const FORBIDDEN_CLOCK_CALLS: ReadonlySet<string> = new Set([
  "Date.now",
  "performance.now",
  "process.hrtime",
  "process.hrtime.bigint",
  "process.uptime",
]);

/**
 * Constructing one of these reads the host clock too.
 *
 * `new Date()` with no argument is the JavaScript spelling of `datetime.now()`,
 * which the source forbids by module import. TypeScript has no module to forbid
 * -- `Date` is a global -- so the ban is on the zero-argument construction,
 * which is the form that reads the clock. `new Date(someMs)` is arithmetic on a
 * value the caller already had and is left alone, exactly as the source leaves
 * `datetime.fromtimestamp` of an injected value alone.
 */
export const FORBIDDEN_CLOCK_CONSTRUCTORS: ReadonlySet<string> = new Set(["Date"]);

/** The dotted spelling of a possibly-nested property access. */
function dotted(node: ts.Node): string {
  const parts: string[] = [];
  let current: ts.Node = node;
  while (ts.isPropertyAccessExpression(current)) {
    parts.push(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current)) {
    parts.push(current.text);
  }
  return parts.reverse().join(".");
}

/**
 * The driver may not read the host clock -- not as a base, not as a fallback.
 *
 * Asserted over the module's own syntax tree rather than by trusting a comment:
 * it is the property the identical-trace requirement rests on, and a single
 * `Date.now()` fallback would make a re-run on another day differ while every
 * test still passed. The clock a role process has is the injected one; the
 * *controller's* watchdogs run on host monotonic time and are never skewed,
 * which is a deliberate asymmetry (design 7) and is why only the driver module
 * is scanned.
 */
export function checkNoHostClock(adapter: FullFaultAdapter): void {
  const source = ts.createSourceFile(
    adapter.driverSourcePath,
    readFileSync(adapter.driverSourcePath, "utf8"),
    ts.ScriptTarget.ES2023,
    true,
  );

  const offenders = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = dotted(node.expression);
      if (FORBIDDEN_CLOCK_CALLS.has(name)) {
        offenders.add(name);
      }
    } else if (ts.isNewExpression(node)) {
      const name = dotted(node.expression);
      // Only the zero-argument construction reads the clock.
      if (
        FORBIDDEN_CLOCK_CONSTRUCTORS.has(name) &&
        (node.arguments === undefined || node.arguments.length === 0)
      ) {
        offenders.add(`new ${name}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  if (offenders.size > 0) {
    throw new ContractViolation(
      `${adapter.driverModule} reaches the host clock (${[...offenders].sort().join(", ")}); ` +
        "the injected clock is the only clock a role process has (design 7)",
    );
  }
}

// ---------------------------------------------------------------------------
// 6 -- same case, same seed, identical trace
// ---------------------------------------------------------------------------

/**
 * Two runs of one case with one seed produce identical event traces.
 *
 * This is the whole determinism claim made testable (design 4.4). It holds only
 * because the clock is virtual and because no identifier the driver puts on the
 * wire is randomly generated.
 */
export async function checkIdenticalTraces(
  adapter: FullFaultAdapter,
  workdir: string,
  options: { role: string },
): Promise<void> {
  const traces: string[] = [];
  for (let run = 0; run < 2; run += 1) {
    const checkpoint = contract.CHECKPOINT_DELIVERED_BEFORE_ACK;
    const wire = `${contract.OPERATION_ATTEMPT}@${checkpoint}:1`;
    const faultCase = syntheticCase({
      caseId: "conformance-determinism",
      role: options.role,
      arms: { [options.role]: [wire] },
      messages: 2,
    });
    const controller = makeController(adapter, join(workdir, `run${run}`), faultCase);
    try {
      controller.bootstrap();
      await controller.spawn(options.role, { armed: [ArmedAnchor.parse(wire)] });
      await controller.waitAtAnchor(options.role);
      controller.release(options.role);
      await controller.runToCompletion(options.role);
      traces.push(JSON.stringify(controller.traces()[options.role]));
    } finally {
      await controller.teardown();
    }
  }
  if (traces[0] !== traces[1]) {
    throw new ContractViolation(
      `the same case with the same seed produced different traces:\n${traces[0]}\n${traces[1]}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7 and 8 -- vocabulary and CLI
// ---------------------------------------------------------------------------

/**
 * The contract's four names are the adapter's four names.
 *
 * Today they are textually equal to the outbox's constants. When the spike is
 * discarded the contract's names survive and the next adapter maps its internals
 * onto them -- this assertion is what makes that mapping mandatory rather than
 * optional.
 */
export function checkVocabularyMatches(adapter: FullFaultAdapter): void {
  const vocabulary = [...adapter.checkpointVocabulary()];
  const wanted = [...contract.CHECKPOINTS];
  if (JSON.stringify(vocabulary) !== JSON.stringify(wanted)) {
    throw new ContractViolation(
      `${adapter.driverModule} names its windows ${JSON.stringify(vocabulary)}; the contract ` +
        `names them ${JSON.stringify(wanted)}`,
    );
  }
}

/**
 * The driver accepts every option the contract names, and says so.
 *
 * Checked by running `--help` in a real subprocess, which also smoke-tests that
 * the module is executable at all and that its help text encodes cleanly on the
 * console encoding of the platform running it.
 */
export function checkDriverCli(adapter: FullFaultAdapter): void {
  const { executable, prefixArguments } = adapter.driverCommand();
  let stdout: string;
  try {
    stdout = execFileSync(executable, [...prefixArguments, "--help"], {
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    throw new ContractViolation(
      `${adapter.driverModule} --help exited ${failure.status}\n` +
        `stdout: ${failure.stdout}\nstderr: ${failure.stderr}`,
    );
  }
  const missing = contract.driverCliArguments().filter((option) => !stdout.includes(option));
  if (missing.length > 0) {
    throw new ContractViolation(
      `${adapter.driverModule} does not accept ${JSON.stringify(missing)}; the contract's CLI ` +
        `is ${JSON.stringify(contract.driverCliArguments())}`,
    );
  }

  // ... and then actually PARSE each one, which the help-text scan above does
  // not prove on its own.
  //
  // The source gets that implication for free: its `--help` is generated by
  // `argparse` FROM the parser, so an option in the help text is an option the
  // parser has. A hand-written parser with independently hand-written help has
  // no such coupling -- an option can sit in the help text while its branch is
  // missing or broken, and the scan above would still qualify the adapter. That
  // is a property the port lost in translation rather than one the source
  // lacks, so it is restored here by testing acceptance directly. Raised by the
  // review gate on this change.
  const unsupported: string[] = [];
  for (const option of contract.driverCliArguments()) {
    const value = REPRESENTATIVE_CLI_VALUES[option];
    if (value === undefined) {
      throw new ContractViolation(
        `the battery has no representative value for ${option}; a contract option with no value ` +
          "here would be scanned in the help text and never parsed",
      );
    }
    try {
      adapter.parseDriverArguments(["--role", contract.ROLE_DISPATCHER, option, ...value]);
    } catch {
      unsupported.push(option);
    }
  }
  if (unsupported.length > 0) {
    throw new ContractViolation(
      `${adapter.driverModule} names ${JSON.stringify(unsupported)} in its help text but its ` +
        "parser refuses them; the CLI the contract requires is the one the driver can be RUN " +
        "with, not the one it advertises",
    );
  }

  // The check has to be able to fire, or it is decoration: an option the
  // contract does not name must be refused rather than ignored.
  let refusedUnknown = false;
  try {
    adapter.parseDriverArguments(["--role", contract.ROLE_DISPATCHER, "--not-a-contract-option"]);
  } catch {
    refusedUnknown = true;
  }
  if (!refusedUnknown) {
    throw new ContractViolation(
      `${adapter.driverModule} accepts an option the contract does not name, so the acceptance ` +
        "check above would pass over a parser that accepts anything",
    );
  }
}

/**
 * One representative value per contract option, so the battery can parse each.
 *
 * Deliberately a total map with no default: a contract option added without a
 * value here fails the battery rather than being silently scanned in the help
 * text and never parsed, which is the hole this whole check exists to close.
 */
const REPRESENTATIVE_CLI_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "--role": [contract.ROLE_DISPATCHER],
  "--db": ["control-plane.sqlite3"],
  "--case-id": ["conformance-cli"],
  "--suite-seed": ["1"],
  // The empty arming is legal and is what an unarmed role is spawned with.
  "--armed": [""],
  "--clock-base-ms": [String(CONFORMANCE_CLOCK_BASE_MS)],
  // Negative on purpose: a backward skew is a negative offset (design 7), and a
  // parser that rejected the sign would break the clock-back cases only.
  "--clock-offset-ms": ["-31000"],
  "--restart-generation": ["1"],
  "--control-fd": ["0"],
  "--event-fd": ["1"],
  "--observation-mode": [contract.OBSERVATION_HEALTHY],
  "--escalate-on": [contract.FACT_ACTIVE_EVIDENCE],
  "--incident-dedup-key": ["observe/conformance"],
  "--incident-repeats": ["2"],
  "--incident-collapse": ["increment-in-place"],
  "--incident-renotify-window-ms": ["5000"],
  "--incident-reconcile-interval-ms": ["1000"],
  "--unavailable-attempts": ["3"],
});

/** Every named invariant is bound, and binds exactly its named parameters. */
export function checkInvariantQueriesBindTheContractParameters(adapter: FullFaultAdapter): void {
  const queries = adapter.invariantQueries();
  const missing = contract.SQL_INVARIANTS.filter((name) => !(name in queries));
  if (missing.length > 0) {
    throw new ContractViolation(
      `${adapter.driverModule} binds no SQL for ${JSON.stringify(missing)}`,
    );
  }
  for (const [name, sql] of Object.entries(queries)) {
    const declared = [...(contract.INVARIANT_PARAMETERS[name] ?? [])].sort();
    const used = [
      ...new Set([...sql.matchAll(/:([a-z_]+)/g)].map((match) => match[1] as string)),
    ].sort();
    // Equality, not containment. A subset check only catches the harmless
    // direction: an adapter that *omitted* a parameter would pass, and the
    // omission is the dangerous one -- a `lease-single-holder` query without
    // `:now_ms` reads expired leases as live and reports a single-holder
    // violation that is not there, or misses one that is.
    if (JSON.stringify(used) !== JSON.stringify(declared)) {
      const missingParams = declared.filter((key) => !used.includes(key));
      const unexpected = used.filter((key) => !declared.includes(key));
      throw new ContractViolation(
        `${name} binds ${JSON.stringify(used)}; the contract names ${JSON.stringify(declared)}. ` +
          `Missing: ${JSON.stringify(missingParams)}; unexpected: ${JSON.stringify(unexpected)}`,
      );
    }
  }
}

/**
 * Every named query can actually see the rows its role wrote.
 *
 * The failure this exists for is the quietest one a harness has. A query whose
 * scoping does not match the schema returns zero rows on every run, and an
 * invariant of the shape "this result set is empty" then passes forever --
 * including on the day the property it names is violated. It is not a test
 * failure, it is the *absence* of one.
 *
 * So the battery runs a clean case and asserts the positive direction: the write
 * history is non-empty, the lease is held at the instant the run reached, and
 * the role's outbox rows are visible. An adapter that cannot show these has not
 * bound the invariants, whatever its SQL says.
 */
export async function checkInvariantQueriesAreNotVacuous(
  adapter: FullFaultAdapter,
  workdir: string,
  options: { role: string },
): Promise<void> {
  const faultCase = syntheticCase({
    caseId: `conformance-vacuity-${options.role}`,
    role: options.role,
    arms: {},
  });
  const controller = makeController(adapter, workdir, faultCase);
  try {
    controller.bootstrap();
    await controller.spawn(options.role, { armed: [] });
    await controller.runToCompletion(options.role);

    const nowMs = controller.lastReportedNowMs({ default: CONFORMANCE_CLOCK_BASE_MS });
    const params = adapter.queryParameters(options.role, { nowMs });

    const rowsFor = (name: string): InvariantRow[] => {
      const wanted = contract.INVARIANT_PARAMETERS[name] ?? [];
      const bound: Record<string, unknown> = {};
      for (const key of wanted) {
        bound[key] = params[key];
      }
      return controller.query(name, bound);
    };

    const history = rowsFor(contract.INVARIANT_LINEAR_WRITER_HISTORY);
    if (history.length === 0) {
      throw new ContractViolation(
        `${adapter.driverModule}: linear-writer-history sees none of ${options.role}'s writes, ` +
          "so 'no epoch regression' would pass over an empty set forever",
      );
    }
    const outboxRows = rowsFor(contract.INVARIANT_RETRY_COUNT_DURABLE);
    if (outboxRows.length === 0) {
      throw new ContractViolation(
        `${adapter.driverModule}: retry-count-durable sees none of ${options.role}'s outbox rows`,
      );
    }
    if (!(contract.ROLE_SCRIPTS[options.role] ?? []).includes(contract.OPERATION_LEASE_RELEASE)) {
      const held = rowsFor(contract.INVARIANT_LEASE_SINGLE_HOLDER).filter(
        (row) => row["resource"] === params["resource"],
      );
      if (held.length === 0) {
        throw new ContractViolation(
          `${adapter.driverModule}: no live holder on ${JSON.stringify(params["resource"])} at ` +
            `now_ms=${nowMs}, so 'at most one live holder' would assert nothing`,
        );
      }
    }

    const observer = controller.observer(options.role);
    for (const key of adapter.effectKeys(options.role, faultCase)) {
      if (observer.effectCount(key) !== 1) {
        throw new ContractViolation(
          `${adapter.driverModule}: the destination observer cannot see the effect for ` +
            `${JSON.stringify(key)}`,
        );
      }
    }
  } finally {
    await controller.teardown();
  }
}

/**
 * No two refusals recorded in one case share an `action_id`.
 *
 * A refusal's `action_id` is whatever the driver passed as `attemptId`, and it is
 * the primary key of the row. A harness cannot use a uuid there -- a uuid in the
 * evidence is a re-run that cannot be compared -- so the ids are composed, and a
 * composed id collides the moment the same writer is refused twice on the same
 * operation. The collision does not surface as a duplicate row: it surfaces as a
 * constraint error raised from inside the write's own transaction, *instead of*
 * the refusal exception, which rolls the refusal back. The record ACCEPTANCE.md
 * section 2 requires to be durable is precisely the thing that is lost.
 */
export async function checkRefusalIdsAreUnique(
  adapter: FullFaultAdapter,
  workdir: string,
): Promise<void> {
  const role = contract.ROLE_SUPERVISOR;
  const faultCase = syntheticCase({
    caseId: "conformance-refusal-ids",
    role,
    arms: {},
    // The collision cannot happen unless the same writer is refused twice, and
    // no ordinary case does that. So the battery injects it: a token one epoch
    // off the lease row, presented on two consecutive protected writes. A clean
    // run would leave nothing to scan and this check would pass over an empty
    // set -- which is the same vacuity it exists to catch elsewhere.
    behaviours: ["stale-writer"],
  });
  const controller = makeController(adapter, workdir, faultCase);
  try {
    controller.bootstrap();
    await controller.spawn(role, { armed: [] });
    await controller.runToCompletion(role);

    const nowMs = controller.lastReportedNowMs({ default: CONFORMANCE_CLOCK_BASE_MS });
    const params = adapter.queryParameters(role, { nowMs });
    const history = controller.query(contract.INVARIANT_LINEAR_WRITER_HISTORY, {
      scope: params["scope"],
    });
    const refusals = history.filter((row) => row["status"] === "refused");
    if (refusals.length < 2) {
      throw new ContractViolation(
        `${adapter.driverModule}: the stale-writer injection produced ${refusals.length} ` +
          "refusal row(s); at least two are needed for a repeated id to be observable at all",
      );
    }
    const ids = refusals.map((row) => String(row["action_id"]));
    const duplicates = [
      ...new Set(ids.filter((id) => ids.filter((x) => x === id).length > 1)),
    ].sort();
    if (duplicates.length > 0) {
      throw new ContractViolation(
        `${adapter.driverModule}: ${role} wrote refusal rows sharing ` +
          `${JSON.stringify(duplicates)}; a refusal id that repeats loses the refusal it was ` +
          "supposed to record",
      );
    }
  } finally {
    await controller.teardown();
  }
}

/**
 * A recommendation *can* be recorded, so its absence is evidence.
 *
 * The observation cases assert that no termination/restart recommendation was
 * produced from an outage (ACCEPTANCE.md section 2, interlock D-0006). That
 * assertion is a count, and a count over a path nothing can reach is zero
 * forever -- it would pass on the day the rule broke, and on every day before
 * it.
 *
 * So the battery drives the path with a fact state D-0006 says nothing about,
 * supplied as case data, and asserts the row appears. Nothing here claims that
 * state *should* escalate: the policy is an input, Q-0012 is open, and what is
 * being checked is that the query and the write both work.
 */
export async function checkEscalationPathCanRecord(
  adapter: FullFaultAdapter,
  workdir: string,
): Promise<void> {
  const role = contract.ROLE_SUPERVISOR;
  const faultCase = syntheticCase({
    caseId: "conformance-escalation",
    role,
    arms: {},
  });
  faultCase["observation"] = {
    mode: contract.OBSERVATION_HEALTHY,
    escalate_on: [contract.FACT_ACTIVE_EVIDENCE],
  };
  const controller = makeController(adapter, workdir, faultCase);
  try {
    controller.bootstrap();
    await controller.spawn(role, { armed: [] });
    await controller.runToCompletion(role);

    const nowMs = controller.lastReportedNowMs({ default: CONFORMANCE_CLOCK_BASE_MS });
    const params = adapter.queryParameters(role, { nowMs });
    const rows = controller.query(contract.INVARIANT_NO_ANOMALY_ESCALATION, {
      scope: params["scope"],
    });
    if (rows.length === 0 || Number((rows[0] as InvariantRow)["escalations"]) < 1) {
      throw new ContractViolation(
        `${adapter.driverModule}: the escalation path recorded nothing even when the case asked ` +
          "for it, so 'no recommendation was produced' is a statement about a path that cannot " +
          "be taken",
      );
    }
  } finally {
    await controller.teardown();
  }
}

/**
 * The battery, as data, so a report can name what ran.
 *
 * **Ported dead data, deliberately.** `conformance.py` defines `BATTERY` and nothing
 * in interlock reads it -- it exists so a report *can* name what ran. It is carried
 * across because a parity port reproduces its source's surface rather than curating
 * it.
 *
 * The `@parityonly` tag excludes it from knip's dead-export analysis (`knip.json`).
 * That exclusion is deliberately narrow: it marks THIS export as unused-in-the-
 * source-too, rather than switching the check off, so a genuinely dead export
 * added later still turns the gate red.
 *
 * @parityonly
 */
export const BATTERY = [
  "checkpoint-blocks",
  "barrier-round-trip",
  "sigkill-exit-status",
  "restart-is-idempotent",
  "clock-is-injected",
  "no-host-clock",
  "identical-traces",
  "vocabulary-matches",
  "driver-cli",
  "invariant-queries",
  "invariant-queries-not-vacuous",
  "refusal-ids-unique",
  "escalation-path-reachable",
] as const;
