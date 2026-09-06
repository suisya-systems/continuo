import { createHash } from "node:crypto";

import { pythonRepr } from "./python_repr.js";

/**
 * What a run was **permitted** to do, as admission fixed it -- kept whole, and
 * never read.
 *
 * This is the other half of the sentence `lap_run_intent.ts` starts.
 * {@link LapRunIntent} records what a lap was *asked* for; this records what it
 * was *allowed*. They are two facts about two subjects, and D-1105 keeps them
 * two records for the reason D-0055 kept `run_created` and
 * `run_delegation_recorded` apart: folding an authorisation statement into a
 * work statement grows a record whose meaning is "this is the job" into the
 * carrier of "this is the permission", and every later reader has to know which
 * of the two it was handed.
 *
 * **The envelope is opaque, and that is a structural commitment rather than a
 * simplification.** Nothing in this module, and nothing anywhere in the control
 * plane, reads a key out of {@link DelegationRecord.envelope}. The values in
 * there are the delegating layer's semantics -- a resolved contract, the
 * agent-type record applied, the configuration after defaults, the catalog
 * snapshot the grant was issued against. A control plane that begins to branch
 * on them has taken that layer's meaning into itself, and the layering that
 * keeps the delegating layer free of any control-plane code collapses from the
 * other side. So what this module validates is **form**: that the document is a
 * JSON object, that it is not empty, that it is within a stated bound. What it
 * computes is **bookkeeping about a blob**: a digest over exactly the bytes it
 * was handed.
 *
 * **The bytes are stored verbatim.** The digest is `sha256` over the UTF-8
 * encoding of {@link DelegationRecord.envelope} exactly as it arrived, and
 * {@link CANONICALIZATION} records that. Re-rendering the document through this
 * build's JSON writer would make the stored record depend on the writer rather
 * than on the value that was applied -- `run_view.ts` refuses to re-encode a
 * payload for that reason -- and would make the digest incomparable with the
 * one the producer computed over its own bytes. The consequence is worth
 * stating plainly: two producers that mean the same grant but format it
 * differently produce two records with two digests, and continuo is not the
 * layer that gets to say they are the same. Canonicalisation belongs to
 * whoever owns the meaning.
 *
 * **Secrets are not values here.** A producer records the *identifier and
 * version* of a secret, never its value; nothing in this module can enforce
 * that, because enforcing it would require reading the envelope. It is stated
 * in D-1105 as an obligation on the producer and is the reason the record is
 * not a general-purpose blob store.
 *
 * **ASCII only** in the messages this module writes, per
 * `docs/cli-output-policy.md`: they reach a console that may be cp932. The
 * envelope itself is external and is deliberately not held to that -- it is
 * stored, not printed back on a human line.
 */

/**
 * The digest algorithm every record is written under.
 *
 * A constant rather than a parameter, and the DDL constrains the column to the
 * same single value. Both say the same thing: which algorithm a record was
 * digested under is a property of the record format, so changing it is a
 * migration and a decision, not a caller's argument.
 */
export const DIGEST_ALGORITHM = "sha256";

/**
 * How the bytes the digest covers were normalised: they were not.
 *
 * `verbatim-utf8` means the digest is over the UTF-8 encoding of the stored
 * envelope text, byte for byte, with no re-ordering, re-spacing or re-escaping.
 * It is recorded rather than assumed because a digest whose normalisation is
 * unstated cannot be reproduced by anybody who did not write it.
 */
export const CANONICALIZATION = "verbatim-utf8";

/**
 * The largest envelope this build accepts, in UTF-16 code units.
 *
 * A stated limit rather than whatever the driver happens to do, so that an
 * over-large record is refused with a sentence naming the bound instead of
 * failing somewhere with a constraint message. The record is a resolved
 * contract and its provenance, not a corpus.
 *
 * **The unit is not the DDL's, and the direction of the difference is what
 * makes that safe.** `0006_delegation_record.sql` writes the same number
 * against SQLite's `length()`, which counts characters, while `String.length`
 * here counts UTF-16 code units -- so an astral character costs two here and
 * one there, and this check is always at least as strict as the column's. The
 * dangerous direction is the other one: a value this constructor admitted and
 * the `CHECK` then refused would surface as a constraint error inside the
 * admitting transaction rather than as a refusal before anything is opened.
 * That cannot happen. Noted rather than unified because counting code points
 * over a megabyte of text to buy nothing is the worse trade.
 */
export const MAX_ENVELOPE_LENGTH = 1_048_576;

/**
 * A field of the record is malformed. Nothing was opened, and nothing written.
 *
 * Outside the `ControlPlaneRefusal` family, placed exactly where
 * `LapRunIntentUsageError` is placed and for the reason that module gives: a
 * refusal in that family is a fact stated about the data and reaches the
 * operator as one line, while a malformed argument is a defect in whoever built
 * the record and its stack is what diagnoses it.
 */
export class DelegationRecordUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DelegationRecordUsageError";
    Object.setPrototypeOf(this, DelegationRecordUsageError.prototype);
  }
}

/** Keyword arguments of {@link DelegationRecord}, in field order. */
export interface DelegationRecordFields {
  readonly recordSchema: string;
  readonly envelope: string;
}

/**
 * What a `record_schema` may be made of: printable ASCII, and nothing else.
 *
 * The same rule `LapRunIntent` holds `run_id` to, and for the same reason: this
 * string is quoted back into `run admit`'s one-line report and into refusals,
 * both of which end at a single newline, so a value carrying its own newline
 * makes the command appear to print a line it never wrote.
 *
 * Note what this rule is **not**: it is not a vocabulary. Continuo does not
 * know, and must not learn, which format names are meaningful -- the format is
 * the producer's to name. This holds the name to something that can be printed
 * back, and stops there.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * One run's delegation record, validated at construction and frozen.
 *
 * A class carrying a private field, so the type is **nominal**: an object
 * literal of the right shape does not satisfy it, which is what makes "every
 * record that reaches `admitRun` was validated" a property of the type rather
 * than a convention.
 *
 * @throws {DelegationRecordUsageError} for any malformed field. Construction is
 *   validation: there is no other way to obtain one of these.
 */
export class DelegationRecord {
  /**
   * The format the producer says this envelope is written in.
   *
   * Stored and printed back; never consulted. Continuo does not dispatch on it,
   * does not hold a list of the ones it knows, and does not refuse one it has
   * not seen -- a control plane that recognised format names would be a control
   * plane that has opinions about the contents, arrived at one version string
   * at a time.
   */
  readonly recordSchema: string;

  /**
   * The record itself, verbatim, exactly as the producer wrote it.
   *
   * Held to being a JSON **object** and to {@link MAX_ENVELOPE_LENGTH}, and to
   * nothing else. No key of it is read here or anywhere downstream.
   */
  readonly envelope: string;

  /** `sha256` over the UTF-8 bytes of {@link envelope}, lower-case hex. */
  readonly envelopeDigest: string;

  /** Always {@link DIGEST_ALGORITHM}; a field so a reader need not assume it. */
  readonly digestAlgorithm: string;

  /** Always {@link CANONICALIZATION}; a field for the same reason. */
  readonly canonicalization: string;

  constructor(fields: DelegationRecordFields) {
    const recordSchema = fields.recordSchema;
    if (typeof recordSchema !== "string" || recordSchema.trim() === "") {
      throw new DelegationRecordUsageError(
        `record_schema must be a non-empty string, got ${pythonRepr(recordSchema)}`,
      );
    }
    if (!PRINTABLE_ASCII.test(recordSchema)) {
      throw new DelegationRecordUsageError(
        `record_schema must be printable ASCII (U+0020..U+007E), got ` +
          `${pythonRepr(recordSchema)}; it is printed back verbatim in this ` +
          "command's report and in its refusals, so a character that cannot be " +
          "printed is one that cannot be reported",
      );
    }
    this.recordSchema = recordSchema;

    const envelope = fields.envelope;
    if (typeof envelope !== "string" || envelope === "") {
      throw new DelegationRecordUsageError(
        `envelope must be a non-empty string, got ${pythonRepr(envelope)}`,
      );
    }
    if (envelope.length > MAX_ENVELOPE_LENGTH) {
      throw new DelegationRecordUsageError(
        `envelope is ${envelope.length} UTF-16 code units and the limit is ` +
          `${MAX_ENVELOPE_LENGTH}; the record states the values one run was ` +
          "admitted under, and a document past this bound is something else " +
          "arriving through this door",
      );
    }

    // Parsed for VALIDITY ONLY, and the result is discarded unread -- the same
    // shape `events.ts`'s `requireJson` uses for the spine's payload column,
    // and the line where this module's "never interprets" claim is either true
    // or false. The parse is here rather than left to the DDL's `json_valid`
    // so that a malformed document is refused with a sentence naming the
    // decoder's complaint, before a transaction is opened.
    let parsed: unknown;
    try {
      parsed = JSON.parse(envelope);
    } catch (error) {
      throw new DelegationRecordUsageError(
        `envelope must be a JSON document; the delegation_record table has a ` +
          `json_valid CHECK and would refuse this (${describeParseError(error)})`,
        { cause: error },
      );
    }
    // A top-level object, and this is the one structural claim continuo makes
    // about the document. It is not a step towards reading it: it is what makes
    // the record extensible by its owner without a migration here, because a
    // producer that needs to add a section adds a key, and a bare array or
    // scalar has nowhere to put one.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DelegationRecordUsageError(
        `envelope must be a JSON object, got ${pythonRepr(describeJsonShape(parsed))}; ` +
          "the record is a document with sections in it, and a bare array or " +
          "scalar has nowhere for its owner to add one",
      );
    }

    this.envelope = envelope;
    this.envelopeDigest = createHash(DIGEST_ALGORITHM)
      .update(Buffer.from(envelope, "utf-8"))
      .digest("hex");
    this.digestAlgorithm = DIGEST_ALGORITHM;
    this.canonicalization = CANONICALIZATION;

    Object.freeze(this);
  }
}

/** A decoder's complaint, reduced to one ASCII clause for a one-line refusal. */
function describeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").trim();
}

/** What arrived, named by shape rather than quoted -- the document may be huge. */
function describeJsonShape(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
