/**
 * Item 10 rehearsal: run-start routing, the run-owner ledger, the writer audit.
 *
 * .. warning::
 *
 *    **A REHEARSAL AGAINST A SYNTHETIC COUNTERPARTY (D-0022). NOT A DISCHARGE: GATE ITEM 10 IS DISCHARGED AT THE CANARY ITSELF, WITH LIVE V1 AS THE COUNTERPARTY. Q-0005 REMAINS OPEN: NO NUMERIC GO/NO-GO CRITERION IS STATED OR USED HERE.**
 *
 *    The marking sits on **one physical line** here, unlike the source's
 *    docstring and unlike `routing_ledger.sql`, and that is deliberate. The
 *    structural belt collapses an artifact by stripping a leading `--`, `>` or
 *    `#` per line and folding whitespace -- the three prefixes SQL comments,
 *    Markdown blockquotes and Python comments use. A JSDoc continuation line
 *    begins with `*`, which is *not* in that set, so a wrapped copy would
 *    collapse to "... NOT A * DISCHARGE: ..." and no longer carry the sentence
 *    verbatim. Widening the collapse rule to accept `*` was the alternative and
 *    was rejected: the rule is the source's, and loosening the reader is a
 *    worse trade than one long line in the writer.
 *
 *    Everything in this package is throwaway by default (D-0026); the durable
 *    halves are `test/canary/` and the written contract
 *    `docs/canary-routing-rehearsal.md`.
 *
 * The property under rehearsal (Issue `#23`): **rollback is a routing change,
 * not a data migration**. Concretely -- a routing point consulted once per run
 * at run start (`./routing.js`), a separate run-owner ledger whose rows never
 * change owner (`./ledger.js`), a writer audit that reads both stores and
 * shows no record written by both systems (`./audit.js`), and a stand-in
 * counterparty that is loud about being one (`./synthetic_v1.js`).
 *
 * **Explicit named re-exports, never `export *`.** The source's `__init__.py`
 * lists 27 names in `__all__` and deliberately leaves five of `ledger`'s
 * exports out: `LEDGER_APPLICATION_ID`, `LEDGER_REVISION`,
 * `LEDGER_SCHEMA_PATH`, `LEDGER_TABLES` and `load_ledger_sql`. Those are how
 * the opener decides whether a file is *this* ledger; a caller that reached
 * them could write the application id onto some other database and hand it back
 * as a ledger. `export *` would leak all five (and `collapsedLedgerSql`,
 * `configureLedgerConnection`, `canonicalJson`, `sqliteRunIds` and the seams
 * besides), so the omission has to be spelled out name by name to survive.
 */

export {
  canonicalSqliteBytes,
  canonicalSyntheticBytes,
  compareAcrossRollback,
  type RollbackComparison,
  type StoreSnapshot,
  snapshotStores,
  type WriterAuditReport,
  writerAudit,
} from "./audit.js";
export {
  CorruptLedgerRefused,
  createRoutingLedger,
  INTERLOCK,
  MissingLedgerRefused,
  OWNING_SYSTEMS,
  openRoutingLedger,
  RoutingLedgerRefusal,
  SYNTHETIC_V1,
} from "./ledger.js";
export { REHEARSAL_MARKING } from "./marking.js";
export {
  NoRoutingDecision,
  OwnerChangeRefused,
  type RoutedRun,
  type RoutingDecision,
  RoutingRefused,
  RunStartRoutingPoint,
  UnknownOwningSystem,
  UnroutedRun,
} from "./routing.js";
export { SyntheticStoreRefusal, SyntheticV1RunStore } from "./synthetic_v1.js";
