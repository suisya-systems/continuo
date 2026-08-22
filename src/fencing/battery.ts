/**
 * The breach-probe battery -- one forbidden operation per *rule*.
 *
 * D-0023 part 1 is precise about the unit: "one forbidden operation per **rule**
 * in the role's fence, not one per role". Per-role probing leaves most rules
 * unobserved, so a battery that is merely *plausible* is not the observable the
 * decision asks for.
 *
 * The battery is therefore **derived**, never authored. {@link probesFor} walks
 * the rendered fence and synthesizes one probe per rule from the rule's own
 * text, and it refuses to return a battery whose synthesized operand the rule
 * does not actually match. That refusal is the whole point: a hand-maintained
 * probe list drifts from the fence silently, and the drift is invisible exactly
 * when a new rule has been added and nobody probed it.
 *
 * What this battery does and does not prove is stated plainly in
 * `docs/per-role-fencing.md` and in the gate record: it observes *behaviour
 * against the fence Interlock rendered*. It is a deliberate weakening of item 3
 * accepted by a human, not an equivalent method.
 */

import { pyRepr } from "./pyrepr.js";
import {
  type Decision,
  type Fence,
  type FenceRule,
  KIND_PERMISSION_DENY,
  KIND_SANDBOX_DENY_READ,
  KIND_SANDBOX_DENY_WRITE,
  witnessSubject,
} from "./rules.js";

/**
 * A rule for which no matching forbidden operation could be synthesized.
 *
 * Fatal by design. Skipping the rule would leave it unprobed while the
 * battery still reported full coverage, which is the failure this battery
 * exists to make impossible.
 */
export class ProbeSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeSynthesisError";
    Object.setPrototypeOf(this, ProbeSynthesisError.prototype);
  }
}

/** One forbidden operation, aimed at exactly one rule. */
export class BreachProbe {
  constructor(
    readonly ruleId: string,
    readonly toolName: string,
    readonly toolInput: Readonly<Record<string, unknown>>,
    readonly description: string,
  ) {
    // The source is a frozen dataclass. Freezing here keeps a caller from
    // retargeting a probe after `probeFor` proved it matches its own rule --
    // the proof is what makes the battery a coverage claim rather than a
    // promise, and a mutated probe would carry the proof's authority without
    // the proof.
    Object.freeze(this);
  }

  toJson(): Record<string, unknown> {
    return {
      rule_id: this.ruleId,
      tool_name: this.toolName,
      tool_input: { ...this.toolInput },
      description: this.description,
    };
  }
}

export class ProbeResult {
  constructor(
    readonly probe: BreachProbe,
    readonly decision: Decision,
  ) {
    // Frozen dataclass in the source. A result is evidence: if it can be
    // edited after the fact, a red battery can be turned green by a caller
    // rather than by a fix.
    Object.freeze(this);
  }

  get denied(): boolean {
    return this.decision.denied;
  }

  /**
   * Denied *by the rule it targets*, not merely denied by something.
   *
   * A probe that trips a neighbouring rule would let a broken rule hide
   * behind a working one and still show a green battery.
   */
  get deniedByItsOwnRule(): boolean {
    return this.decision.denied && this.decision.ruleId === this.probe.ruleId;
  }
}

export class BatteryReport {
  constructor(
    readonly role: string,
    readonly results: readonly ProbeResult[],
  ) {
    // Frozen dataclass in the source, and for the same reason as
    // {@link ProbeResult}: the report is the artifact the gate reads.
    Object.freeze(this);
  }

  get coveredRuleIds(): ReadonlySet<string> {
    return new Set(this.results.map((result) => result.probe.ruleId));
  }

  get breaches(): readonly ProbeResult[] {
    return this.results.filter((result) => !result.deniedByItsOwnRule);
  }

  get allDenied(): boolean {
    return this.breaches.length === 0;
  }

  toJson(): Record<string, unknown> {
    return {
      role: this.role,
      all_denied: this.allDenied,
      probes: this.results.map((result) => ({
        ...result.probe.toJson(),
        denied: result.denied,
        denied_by_its_own_rule: result.deniedByItsOwnRule,
        decided_by: result.decision.ruleId,
      })),
    };
  }
}

/** Synthesize the forbidden operation for one rule. */
export function probeFor(rule: FenceRule): BreachProbe {
  const subject = witnessSubject(rule);

  let toolName: string;
  let toolInput: Readonly<Record<string, unknown>>;
  let description: string;
  if (rule.kind === KIND_PERMISSION_DENY) {
    toolName = rule.tool;
    toolInput = payload(toolName, subject);
    description = `${toolName} against ${pyRepr(subject)}, denied by ${pyRepr(rule.spec)}`;
  } else if (rule.kind === KIND_SANDBOX_DENY_READ) {
    toolName = "Read";
    toolInput = { file_path: subject };
    description = `read of sandbox-denied path ${pyRepr(subject)}`;
  } else if (rule.kind === KIND_SANDBOX_DENY_WRITE) {
    toolName = "Write";
    toolInput = { file_path: subject, content: "" };
    description = `write to sandbox-denied path ${pyRepr(subject)}`;
  } else {
    // Source comment: "pragma: no cover - guarded by rules.FenceRule.matches".
    // FenceRule.matches raises RuleSyntaxError for an unknown kind before this
    // function is ever called with one, so this branch should be unreachable
    // in practice -- but it stays a fatal ProbeSynthesisError, not a silent
    // skip, for the same reason the rest of this module is fatal-by-default:
    // an unknown kind must never be able to look like coverage.
    throw new ProbeSynthesisError(`unknown rule kind: ${rule.kind}`);
  }

  const probe = new BreachProbe(rule.ruleId, toolName, toolInput, description);
  if (!rule.matches(probe.toolName, probe.toolInput)) {
    throw new ProbeSynthesisError(
      `synthesized operation does not match its own rule: ${rule.ruleId} ` +
        `vs ${pyRepr(probe.toolInput)}`,
    );
  }
  return probe;
}

/**
 * One probe per rule, in fence order, or an error.
 *
 * The returned array is the coverage claim: callers assert
 * `probeIds(probes)` equals the set of `fence.ruleIds()`.
 */
export function probesFor(fence: Fence): readonly BreachProbe[] {
  const probes = fence.rules.map((rule) => probeFor(rule));
  const covered = new Set(probes.map((probe) => probe.ruleId));
  const expected = new Set(fence.ruleIds());
  // Defensive: probeFor already maps one probe per rule in fence.rules, so
  // this can only fire if a rule somehow produced a probe under a different
  // ruleId than its own -- source keeps the check anyway (also marked
  // "pragma: no cover - defensive" there), so this does too.
  if (covered.size !== expected.size || ![...expected].every((id) => covered.has(id))) {
    const missing = [...expected].filter((id) => !covered.has(id)).sort();
    throw new ProbeSynthesisError(`rules left unprobed: ${pyRepr(missing)}`);
  }
  return probes;
}

/**
 * Run every probe through `evaluate` (default: the fence itself).
 *
 * `evaluate` is injected so the same battery can be pointed at the fence's
 * own decision function, at the deny hook as a subprocess, or at a live
 * session -- one battery, several observation points, no second probe list to
 * keep in step.
 */
export function runBattery(
  fence: Fence,
  options?: {
    readonly evaluate?: (
      toolName: string,
      toolInput: Readonly<Record<string, unknown>>,
    ) => Decision;
  },
): BatteryReport {
  const decide =
    options?.evaluate ??
    ((toolName: string, toolInput: Readonly<Record<string, unknown>>) =>
      fence.decide(toolName, toolInput));
  const results = probesFor(fence).map(
    (probe) => new ProbeResult(probe, decide(probe.toolName, probe.toolInput)),
  );
  return new BatteryReport(fence.role, results);
}

function payload(toolName: string, subject: string): Record<string, unknown> {
  if (toolName === "Bash") {
    return { command: subject };
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    return { file_path: subject, content: "" };
  }
  if (toolName === "WebFetch") {
    return { url: subject };
  }
  if (toolName === "Glob" || toolName === "Grep") {
    return { pattern: subject };
  }
  return { file_path: subject };
}

/**
 * The set of rule ids a batch of probes covers.
 *
 * **Ported dead code, deliberately.** `battery.py` defines `probe_ids` and
 * nothing in interlock calls it -- not the module, not the suite, and it is not
 * in `fencing/__init__.py`'s `__all__` either. It is carried across because a
 * parity port reproduces its source's public surface rather than curating it,
 * and dropping a function on the grounds that today's callers do not need it is
 * how a port quietly stops being a translation.
 *
 * The `@parityonly` tag excludes it from `knip`'s dead-export analysis
 * (`knip.json`). That exclusion is deliberately narrow: it marks THIS export as
 * unused-in-the-source-too, rather than switching the check off, so a genuinely
 * dead export added later still turns the gate red.
 *
 * @parityonly
 */
export function probeIds(probes: Iterable<BreachProbe>): ReadonlySet<string> {
  return new Set([...probes].map((probe) => probe.ruleId));
}
