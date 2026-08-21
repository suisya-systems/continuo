/**
 * The control plane's refusal family.
 *
 * Interlock declares these in `control_plane/schema.py` and the migrator
 * *imports* them rather than redeclaring them, so that `except
 * ControlPlaneRefusal` catches refusals raised by either module and so that
 * class identity holds across the module boundary. That property is load-
 * bearing here too -- `test_a_spike_database_is_refused_by_the_production_opener`
 * and its mirror assert a refusal type raised by one module while calling the
 * other -- so the family lives in one file that both import, never in parallel
 * declarations.
 *
 * The hierarchy is not decoration. Each split exists because the operator's
 * next move differs:
 *
 * - `MissingStateRefused` -- the file is not there. Creating one is a legitimate
 *   next step.
 * - `CorruptStateRefused` -- the file is there and could not be verified, so it
 *   was not opened. Creating one over it is not a legitimate next step.
 * - `MigrationStepsRefused` -- *this build's* step files are unusable. No
 *   database is at fault, which is why it descends from `ControlPlaneRefusal`
 *   directly and **not** from `CorruptStateRefused`.
 */

/**
 * Root of the family.
 *
 * `Object.setPrototypeOf` in every constructor: extending a built-in under a
 * downlevel emit target loses the prototype chain, and `instanceof` then
 * silently reports false. The tests assert refusal *types*, so a broken chain
 * would turn a type assertion into a message assertion without saying so.
 */
export class ControlPlaneRefusal extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ControlPlaneRefusal";
    Object.setPrototypeOf(this, ControlPlaneRefusal.prototype);
  }
}

/** The file does not exist. An absent database is not an empty one. */
export class MissingStateRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MissingStateRefused";
    Object.setPrototypeOf(this, MissingStateRefused.prototype);
  }
}

/** The file exists but did not verify, so it was not opened. */
export class CorruptStateRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CorruptStateRefused";
    Object.setPrototypeOf(this, CorruptStateRefused.prototype);
  }
}

/**
 * The step files shipped in this build are not a usable ledger, or a step
 * could not be applied.
 *
 * Deliberately **not** a `CorruptStateRefused`: nothing is wrong with the
 * database, and an operator who reads this as database corruption will reach
 * for a restore when the fix is a rebuild.
 */
export class MigrationStepsRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationStepsRefused";
    Object.setPrototypeOf(this, MigrationStepsRefused.prototype);
  }
}

/** An applied step's recorded checksum or name no longer matches its file. */
export class MigrationChecksumRefused extends CorruptStateRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationChecksumRefused";
    Object.setPrototypeOf(this, MigrationChecksumRefused.prototype);
  }
}

/**
 * The ledger holds a version this build has no step for.
 *
 * Never downgraded: there are no down migrations, and a rollback is a restore
 * of the database file.
 */
export class DatabaseAheadOfCodeRefused extends CorruptStateRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseAheadOfCodeRefused";
    Object.setPrototypeOf(this, DatabaseAheadOfCodeRefused.prototype);
  }
}
