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

export { openDatabase, MEMORY, type OpenDatabaseOptions } from "./sqlite/open.js";
export { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";
