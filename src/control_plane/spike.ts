/**
 * The one thing the production migrator needs to know about the spike schema.
 *
 * Interlock's `control_plane/schema.py` opens the **spike** control plane: a
 * different database, verified by a whole-schema fingerprint, never migrated.
 * It is a sibling of the production ledger and not a predecessor -- there is no
 * migration from the spike schema and none will be written, because the cutover
 * is at the run boundary with no state conversion (interlock D-0013, D-0026).
 *
 * The rest of that module -- creating, opening, verifying and reconstructing
 * the spike database -- lives in `./schema.ts`. The
 * application id is declared here rather than there because the production
 * verifier (`migrator.ts`) names the spike explicitly: telling an operator
 * "this is a spike database" is a materially different diagnosis from "this
 * is some other database", and the id is what separates them. Keeping it in
 * this small file, imported by both `migrator.ts` and `schema.ts`, is what
 * stops the production module from depending on the whole spike opener just
 * to read one constant.
 */

/** ASCII `ILK5`. The spike control plane's `application_id`. */
export const SPIKE_APPLICATION_ID = 0x494c4b35;
