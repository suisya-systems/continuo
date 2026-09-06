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
--  WHAT THE DIGEST COVERS, AND WHAT IT DOES NOT. envelope_digest covers the
--  envelope column and NOTHING ELSE. The four columns beside it --
--  record_schema, digest_algorithm, canonicalization, recorded_at_ms -- are
--  outside it, so a writer holding this file that edits one of them leaves a
--  row that still verifies: readDelegationRecord returns it and `run show`
--  reports digest_verified = true. Measured, not deduced: record_schema was
--  rewritten from one format name to another and recorded_at_ms was moved,
--  both outside SQLite, and both read back clean.
--
--  record_schema is the one where that matters, and it is why this is written
--  down rather than left as an obvious consequence. It is not a label: it is
--  the DECLARATION OF WHAT FORMAT THE ENVELOPE IS IN, and rondo is on the side
--  of the boundary that is allowed to interpret the envelope (D-1105's
--  cadenza/rondo asymmetry). A rondo that reads record_schema to choose how to
--  parse the bytes is doing what the column is for, so a record_schema that
--  changed underneath is a reader pointed at the wrong grammar for bytes that
--  are themselves intact -- and no digest here says so.
--
--  Widening the digest to cover the row was NOT done, and the reason is that
--  it would not close the hole it appears to close: a writer that can edit one
--  column can compute a new digest over the edited row just as easily, so a
--  row-wide digest buys detection of careless edits only, at the price of
--  looking like it buys more. See the sentence below on what this record is.
--
--  WHAT THIS RECORD IS: A RECORD, NOT A SEAL. Every check here -- the digest,
--  the three triggers, WITHOUT ROWID -- is aimed at a run's authorisation being
--  written down at the moment it was fixed, and at this build never quietly
--  rewriting it afterwards. None of it is a defence against somebody with write
--  access to this file who intends to forge. Such a writer edits the envelope
--  and the digest together and produces a row that verifies on both read
--  surfaces, which is not a defect to be repaired: with no key and no anchor
--  outside the file, no arrangement of columns can distinguish a self-
--  consistent forgery from the truth. The property is atomicity with what was
--  admitted, and integrity against corruption and against this build's own
--  mistakes -- not sealing against an adversary who holds the database.
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
)
-- WITHOUT ROWID, and it is an immutability decision rather than a storage one.
-- An ordinary table has an implicit rowid alongside its TEXT primary key, which
-- is a SECOND conflict target: `INSERT OR REPLACE` naming an existing row's
-- rowid with a different run_id deletes that row through the rowid conflict, so
-- the BEFORE INSERT guard below -- which keys on run_id -- never sees it, and
-- with `recursive_triggers` off the BEFORE DELETE trigger does not fire either.
-- Measured: inserting run 'b' at run 'a's rowid removed 'a's record silently,
-- leaving an admitted run with no authorisation record. WITHOUT ROWID removes
-- the second target instead of adding a second guard, so there is one key and
-- one thing to defend. Raised by review of this change, after the run_id guard
-- had already been added for the first replace path.
WITHOUT ROWID;

-- The digest is what a host stores instead of a copy of the record: rondo's
-- three digests become one reference, and resolving it is a lookup here. It is
-- deliberately NOT unique -- two runs admitted under the same contract are two
-- records with one digest, and refusing the second would refuse the ordinary
-- case of a contract issued for a repeated job.
CREATE INDEX delegation_record_by_digest ON delegation_record(envelope_digest);

-- A record, once written, is never overwritten -- and this trigger plus the
-- table's WITHOUT ROWID are what make that true, not the two triggers below.
-- The BEFORE DELETE trigger refuses an explicit DELETE and the BEFORE UPDATE
-- trigger refuses an explicit UPDATE, but
-- `INSERT OR REPLACE` resolves a primary-key conflict with an IMPLICIT delete
-- that fires no trigger unless `recursive_triggers` is ON -- and that pragma is
-- per-connection, so an ordinary `new Database(path)` gets SQLite's default of
-- OFF and rewrites the record in one ordinary statement. `connection.ts` does
-- not set it. A BEFORE INSERT trigger fires ahead of conflict resolution, so it
-- refuses the replacement whatever the pragma says, and on every connection
-- including ones this package never handed out. The repair is the canary
-- ledger's, verbatim in shape: see `run_owner_is_never_replaced` in
-- `src/canary/routing_ledger.sql`, which documents the same mechanism.
--
-- The WHEN clause defers to the row's own CHECKs, for the reason that file
-- gives: a row this table would refuse anyway is left for the CHECK to refuse,
-- so this guard never masks a validation failure with a "you may not replace
-- this" refusal. IT RESTATES those CHECKs rather than citing them, because a
-- trigger cannot ask a table what its constraints are.
CREATE TRIGGER delegation_record_is_never_replaced
BEFORE INSERT ON delegation_record
WHEN typeof(NEW.run_id) = 'text' AND length(NEW.run_id) > 0
 AND typeof(NEW.record_schema) = 'text' AND length(NEW.record_schema) > 0
 AND typeof(NEW.envelope) = 'text' AND length(NEW.envelope) > 0
 AND json_valid(NEW.envelope)
 AND length(NEW.envelope) <= 1048576
 AND typeof(NEW.envelope_digest) = 'text' AND length(NEW.envelope_digest) = 64
 AND NEW.envelope_digest = lower(NEW.envelope_digest)
 AND NEW.digest_algorithm IN ('sha256')
 AND NEW.canonicalization IN ('verbatim-utf8')
 AND typeof(NEW.recorded_at_ms) = 'integer'
 AND EXISTS (SELECT 1 FROM delegation_record WHERE run_id = NEW.run_id)
BEGIN
    SELECT RAISE(ABORT,
        'a delegation record is written once; it is never replaced');
END;

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
