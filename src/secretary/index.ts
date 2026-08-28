/**
 * The stub Secretary intake and its explicit queue boundary (gate item 8
 * rehearsal).
 *
 * Ported from interlock `src/claude_org_runtime/secretary/__init__.py` at
 * `65f36c5`.
 *
 * **Spike scaffold, throwaway by default (interlock D-0026).** This package
 * exists so the item-8 rehearsal (interlock Issue #21, interlock D-0022) has a
 * concrete intake whose non-blocking property can be **asserted in code** and
 * **measured under load**, rather than argued. The durable half is
 * `test/secretary/`; nothing here is the real Secretary, and promotion takes a
 * new `D-` entry.
 *
 * **This is a rehearsal, not a discharge.** interlock D-0022 defers item 8 to
 * its own discharge point: the same absence of blocking shown against the
 * **real** Secretary under **genuine** worker load, due **before the canary
 * starts**, against a threshold settled by interlock `Q-0011`. No numeric
 * latency threshold is stated or used anywhere in this package or its tests.
 *
 * **Explicit named re-exports, never `export *`.** The source's `__init__.py`
 * lists exactly four names in `__all__`, and deliberately leaves out the status
 * vocabulary (`ACCEPTED`, `REFUSED_QUEUE_FULL`) and the item type that crosses
 * the boundary -- which the source spells `_Item`, private by name. Those are
 * reachable from `./intake.js` for a test that needs to speak the vocabulary,
 * and are not part of the boundary a later real Secretary inherits. `export *`
 * would hand all three back, so the omission is spelled out name by name to
 * survive. The boundary contract itself is written down in
 * `docs/secretary-intake-boundary.md` so later work inherits the boundary
 * instead of re-deciding it.
 */

export { IntakeQueue, IntakeReceipt, IntakeRefused, SecretaryIntake } from "./intake.js";
