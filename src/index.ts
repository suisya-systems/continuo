/**
 * Public entry point for @suisya-systems/continuo.
 *
 * This package is the TypeScript port of interlock. At bootstrap the surface is
 * deliberately near-empty: the port lands module by module, test-first, and
 * every export added here is one the ported test suite already pins.
 *
 * Design lineage of record: https://github.com/suisya-systems/interlock
 * (DECISIONS.md D-0001..D-0042, docs/parity-audit.md).
 */

/**
 * The production control plane.
 *
 * The package exports only `.` (D-0002), so a name that is not re-exported here
 * is a name an installed consumer cannot reach at all -- `dist` containing the
 * module is not the same as the module being importable.
 *
 * `migratorSeams` is deliberately absent. It is a test seam that reproduces
 * Python's late binding (D-0014), and a consumer replacing an entry on it would
 * be reaching into the migrator's internals through a door left open for tests.
 */
export {
  type ControlPlaneOpenOptions,
  configureConnection,
  openControlPlaneConnection,
} from "./control_plane/connection.js";
export {
  type AppliedMigration,
  appliedMigrations,
  createProductionControlPlane,
  discoverMigrationSteps,
  headVersion,
  LEDGER_COMPANIONS,
  MIGRATIONS_DIR,
  type MigrationStep,
  migrateControlPlane,
  openProductionControlPlane,
  PRODUCTION_APPLICATION_ID,
  renderCurrentSchema,
  STEP_FILENAME,
  verifyProductionDatabase,
} from "./control_plane/migrator.js";
export {
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MigrationStepsRefused,
  MissingStateRefused,
} from "./control_plane/refusals.js";
export { SPIKE_APPLICATION_ID } from "./control_plane/spike.js";
/**
 * The G6 measurement harness.
 *
 * Only the measurement-specific names are listed: the refusal family it shares
 * with the control plane (`ControlPlaneRefusal` and friends) is already
 * exported above, and re-exporting the same bindings twice would be a duplicate
 * export rather than a second way to reach them.
 *
 * `readerSeams`, `requireQueryOnly` and `theErrorSaysTheDatabaseIsReadOnly` are
 * deliberately absent. The first is a test seam (D-0014); the other two are
 * module internals exported only because a source case reaches them and
 * TypeScript has no other way to be reached (D-0101). None of the three is
 * package API, and the measurement barrel's own test asserts the package
 * exports no way to write.
 */
export {
  AsynchronousReportRefused,
  measurementSnapshot,
  NestedSnapshotRefused,
  openForMeasurement,
  proveReadOnly,
  ReadOnlyCapabilityRefused,
} from "./measurement/index.js";
export { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";
export { MEMORY, type OpenDatabaseOptions, openDatabase } from "./sqlite/open.js";
