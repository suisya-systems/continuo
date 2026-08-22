/**
 * The one thing the production migrator needs to know about the spike schema.
 *
 * Interlock's `control_plane/schema.py` opens the **spike** control plane: a
 * different database, verified by a whole-schema fingerprint, never migrated.
 * It is a sibling of the production ledger and not a predecessor -- there is no
 * migration from the spike schema and none will be written, because the cutover
 * is at the run boundary with no state conversion (interlock D-0013, D-0026).
 *
 * The rest of that module is not part of this pilot. Only the application id is
 * here, and only because the production verifier names the spike explicitly:
 * telling an operator "this is a spike database" is a materially different
 * diagnosis from "this is some other database", and the id is what separates
 * them. The two ported cases that need the spike *opener* are recorded in the
 * parity ledger as not yet ported rather than satisfied by a stub, because a
 * stub would make the identity check pass for the wrong reason.
 */

/** ASCII `ILK5`. The spike control plane's `application_id`. */
export const SPIKE_APPLICATION_ID = 0x494c4b35;
