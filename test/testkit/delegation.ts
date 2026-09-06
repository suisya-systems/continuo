import { DelegationRecord } from "../../src/control_plane/delegation_record.js";

/**
 * A delegation record for a case that is not about the record.
 *
 * `admitRun` requires one (`D-1107`), so every case that admits a run has to
 * hand it something, and most of them are about something else entirely -- a
 * lease, a gate, a workspace. One shared fixture rather than a literal in each
 * file, so that those cases say "a run was admitted" and not "a run was
 * admitted under this particular contract", and so that the cases which *are*
 * about the record are the only ones spelling one out.
 *
 * The envelope is deliberately not a realistic contract. Continuo reads no key
 * of it, and a fixture shaped like a plausible authorisation document would
 * invite a later reader to believe some field of it matters here.
 */
export function aDelegationRecord(fields?: {
  readonly recordSchema?: string;
  readonly envelope?: string;
}): DelegationRecord {
  return new DelegationRecord({
    recordSchema: fields?.recordSchema ?? "testkit.delegation/1",
    envelope: fields?.envelope ?? '{"fixture": "a delegation record continuo never reads"}',
  });
}
