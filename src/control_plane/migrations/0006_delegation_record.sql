-- ==========================================================================
--  0006 -- delegation_record: the values a run was admitted under, kept whole
--
--  WHAT WAS MISSING. D-0055 gave admission a record of what a run was ASKED to
--  do -- the LapRunIntent, on the spine as run_delegation_recorded. Nothing
--  recorded what the run was ALLOWED to do. The authorisation half lived as
--  three digests in the host's own store (rondo's iteration row:
--  agent_type_digest, config_digest, contract_digest) and as an in-memory value
--  in cadenza, which persists nothing. A digest proves two things are the same;
--  it does not say what either of them is. So for every run already merged, the
--  question "what was this run permitted to do" has no answer anywhere, and an
--  audit or an incident review has nothing to read.
--
--  WHY THE ROW LIVES HERE, AND IN THIS TRANSACTION. Not convenience:
--  ATOMICITY. The record has to be written inside the same transaction that
--  makes the run admissible, or there is a moment in which a run exists and
--  what it was allowed to do does not. Admission is continuo's -- run_admission
--  .ts holds the only INSERT INTO run in the build -- so this is the only place
--  the two writes can be one write. rondo is on the far side of a process
--  boundary and cannot join this transaction at all. D-1105.
--
--  WHY run_id IS THE PRIMARY KEY AND A FOREIGN KEY. One record per run, and the
--  reference relation runs record -> run rather than run -> record. With
--  PRAGMA foreign_keys = ON (connection.ts) that ordering is what forces the
--  INSERT order inside admission's block -- the run row first, the record
--  second -- and it is what makes "a delegation record for a run that does not
--  exist" unrepresentable rather than merely unwritten. The other direction, a
--  run with no record, is not expressible as a constraint on a row that is
--  inserted first; it is held by admission being the single creation site and
--  by the tests that pin it there.
--
--  WHAT CONTINUO KNOWS ABOUT THE ENVELOPE: NOTHING. envelope is opaque text.
--  This schema constrains its FORM (non-empty, valid JSON, within a bound) and
--  nothing about its MEANING. There is no column extracted from inside it, no
--  index over anything it contains, and no CHECK that reads a key. The reason
--  is structural rather than tidy: the values in there are cadenza's semantics,
--  and a control plane that starts branching on them has taken cadenza's
--  meaning into itself, which collapses the layering from the other side --
--  the same layering cadenza keeps by owning no control-plane code. The
--  columns beside it are continuo's own bookkeeping about a blob: which format
--  version it claims, how it was digested, and when it was written down.
--
--  WHY THE BYTES ARE STORED VERBATIM AND NOT RE-SERIALISED. envelope_digest is
--  sha256 over exactly the bytes in the envelope column, which are exactly the
--  bytes the producer handed in. canonicalization records that fact as
--  'verbatim-utf8'. Re-encoding the document through this build's JSON renderer
--  would make the stored record depend on the renderer rather than on the value
--  that was applied -- run_view.ts already refuses to re-encode a payload for
--  that reason -- and would make the digest incomparable with the one the
--  producer computed over its own bytes.
--
--  WHAT THIS STEP DELIBERATELY DOES NOT DO.
--
--  - It does not backfill. Runs admitted before this step have no row here and
--    never will. Inventing one would be manufacturing the evidence whose
--    absence is the defect this step reports; section 12's standing rule is
--    that a value invented to satisfy a NOT NULL is a value a report would then
--    cite. The unrecoverable past stays unrecoverable and stays visible.
--  - It does not add a column to run. A run -> record pointer would be a second
--    home for the same relation, and the two can disagree; the primary key here
--    already is the relation.
--  - It does not touch the event spine. run_delegation_recorded keeps its own
--    subject -- the lap's execution intent (D-0055) -- and is not widened.
--    Two records because they are two facts: what was asked, and what was
--    permitted.
--  - It does not open a vocabulary for record_schema. The column takes any
--    non-empty text of the producer's choosing, because the format is the
--    producer's to name; continuo stores the name and never reads it to decide
--    anything.
-- ==========================================================================

CREATE TABLE delegation_record (
    run_id            TEXT    PRIMARY KEY REFERENCES run(run_id),
    record_schema     TEXT    NOT NULL,
    envelope          TEXT    NOT NULL,
    envelope_digest   TEXT    NOT NULL,
    digest_algorithm  TEXT    NOT NULL,
    canonicalization  TEXT    NOT NULL,
    recorded_at_ms    INTEGER NOT NULL,

    CHECK (typeof(run_id) = 'text' AND length(run_id) > 0),
    CHECK (typeof(record_schema) = 'text' AND length(record_schema) > 0),
    CHECK (typeof(envelope) = 'text' AND length(envelope) > 0),

    -- Form, not meaning. json_valid is the same check the event spine applies
    -- to its own payload column, and it is the whole of what this schema asks
    -- of the document: that it is a document at all, so a reader handed it back
    -- is handed something parseable rather than a fragment.
    CHECK (json_valid(envelope)),

    -- A bound, so that a single admission cannot make the database
    -- unmanageable, and so that the refusal for an over-large record is a
    -- stated limit rather than whatever the driver does. 1 MiB of text; the
    -- record is a resolved contract and its catalog provenance, not a corpus.
    CHECK (length(envelope) <= 1048576),

    CHECK (typeof(envelope_digest) = 'text' AND length(envelope_digest) = 64),
    CHECK (envelope_digest = lower(envelope_digest)),

    -- Vocabularies rather than free text, because these two say how the digest
    -- beside them is to be reproduced. A reader that cannot name the algorithm
    -- and the normalisation cannot check the digest at all, and a value nobody
    -- constrains is a value that eventually arrives misspelled. Adding an
    -- algorithm later is a migration, which is the correct weight for changing
    -- how every stored record is verified.
    CHECK (digest_algorithm IN ('sha256')),
    CHECK (canonicalization IN ('verbatim-utf8')),

    CHECK (typeof(recorded_at_ms) = 'integer')
);

-- The digest is what a host stores instead of a copy of the record: rondo's
-- three digests become one reference, and resolving it is a lookup here. It is
-- deliberately NOT unique -- two runs admitted under the same contract are two
-- records with one digest, and refusing the second would refuse the ordinary
-- case of a contract issued for a repeated job.
CREATE INDEX delegation_record_by_digest ON delegation_record(envelope_digest);

-- Immutability, in the strong form the spine and the migration ledger already
-- use. The record's whole purpose is to say what was applied at a moment that
-- has passed; a row that can be edited afterwards is a record of what somebody
-- last wanted it to say. A correction is a new run under a new record, never an
-- UPDATE.
CREATE TRIGGER delegation_record_rows_are_immutable
BEFORE UPDATE ON delegation_record
BEGIN
    SELECT RAISE(ABORT,
        'a delegation record states what a run was admitted under; it is written once');
END;

CREATE TRIGGER delegation_record_rows_are_never_deleted
BEFORE DELETE ON delegation_record
BEGIN
    SELECT RAISE(ABORT,
        'a delegation record is the only account of what a run was permitted to do');
END;
