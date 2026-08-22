/**
 * G6 -- the measurement harness.
 *
 * The instrument AC-9's rate, AC-10's ground truth and the AC-7 divergence
 * report are computed with. Its first and most load-bearing property is that it
 * cannot write: interlock's `ACCEPTANCE.md` section 3 condition 5 requires the
 * shadow path to be read-only **enforced by capability, not by convention**
 * (interlock `D-0040`), and {@link ./reader.js} is the only place in this
 * package that opens a database.
 *
 * Everything else here reads through the connection {@link openForMeasurement}
 * returns, so no module in the harness has to be trusted to refrain from
 * writing: none of them holds a handle that could.
 *
 * This barrel is deliberately narrow, and a source case is what keeps it that
 * way: it asserts that no exported name contains `migrate`, `create`, `write`
 * or `lease`. A writer re-exported here would be a writer the harness's callers
 * could reach through the harness's own front door.
 */

export {
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MissingStateRefused,
  measurementSnapshot,
  NestedSnapshotRefused,
  openForMeasurement,
  proveReadOnly,
  ReadOnlyCapabilityRefused,
} from "./reader.js";
