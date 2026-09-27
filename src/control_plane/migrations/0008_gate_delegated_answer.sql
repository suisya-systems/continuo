-- ==========================================================================
--  0008 -- a gate answer made under delegation is recorded as delegated (D-1121)
--
--  What this closes. The only edge into 'answered' is 'presented -> answered',
--  and 0001's actor vocabulary gives it one member that can take it: 'human'.
--  So an answer a host makes on a person's standing approval -- rondo's
--  organisation answering a lap's end gate inside a scope the person approved
--  (rondo D-0064 rule 3.6) -- could only be written under the person's own
--  actor id, which records it as the person's press. Nothing downstream could
--  then tell a carried answer from a composed one. rondo holds such answers
--  until continuo can record them honestly; this step is that record.
--
--  The shape:
--
--    (a) actor_kind gains 'delegate': somebody acted, and it was not the person.
--        actor_id stays who acted (a host's component, e.g. rondo's), and is
--        refused if it equals on_behalf_of, because a delegate named as the
--        person it acts for is the person's press by another spelling.
--    (b) two columns say on whose authority: on_behalf_of (the person the
--        answer is made for) and authority_ref (the approval it rests on, e.g.
--        rondo's scope_decision_id). Both are present on a delegate's row and
--        absent on every other row -- an IF AND ONLY IF, so neither half can be
--        forgotten and no human row can claim a delegation.
--    (c) a delegate row is only ever the 'presented -> answered' advance, both
--        ends named. The application's edge table says the same (gates.ts
--        ADMISSIBLE); the
--        CHECK makes it a property of the store rather than of the one writer.
--
--  What continuo does NOT do with the two columns: interpret them. They are
--  opaque references in the sense D-1107 point 2 gives the delegation record --
--  their form is checked (non-empty, printable ASCII, bounded; gates.ts), their
--  meaning is the host's. Whether the scope covers this gate is rondo's
--  judgement, made before it calls; continuo records who acted and on whose
--  authority, and refuses only the gate types that stay a person's to answer.
--
--  WHY A TABLE REBUILD. The actor vocabulary is a CHECK constraint, and SQLite
--  has no ALTER TABLE that replaces one; 0003 states the procedure and why
--  nothing cheaper is acceptable. Two things are specific to this table:
--
--    * gate_transition references itself (supersedes_seq), so the new shape
--      names 'gate_transition' in that REFERENCES clause: it is resolved when a
--      row is checked, after the rename below, not when the table is created.
--    * gate_stage_matches_its_transition, a trigger on gate, reads
--      gate_transition in its body. ALTER TABLE ... RENAME re-parses the
--      schema and refuses a trigger naming a table that does not exist, which
--      between the DROP and the RENAME this one would. So it is dropped first
--      and recreated last, character for character from 0001.
--    * SQLite fires the triggers of one event most-recently-created first, so
--      recreating that trigger alone would move it ahead of the two UPDATE
--      triggers 0001 created after it, and a backwards stage_seq would be
--      refused with its message instead of 'never walks backwards'. The two
--      are dropped and recreated after it, in 0001's order, so every refusal
--      on gate reads as it did.
--
--  seq is carried by value, so every stage_seq in gate and every
--  supersedes_seq still names the row it named; AUTOINCREMENT's high-water
--  mark follows the copied rows (SQLite sets it from the largest seq inserted).
-- ==========================================================================

DROP TRIGGER gate_closure_is_terminal;
DROP TRIGGER gate_stage_seq_is_monotonic;
DROP TRIGGER gate_stage_matches_its_transition;

-- --------------------------------------------------------------------------
-- The new shape. Carried character for character from 0001 except for the
-- lines marked CHANGED / NEW.
-- --------------------------------------------------------------------------
CREATE TABLE gate_transition_rebuilt_0008 (
    seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
    gate_id             TEXT    NOT NULL REFERENCES gate(gate_id),
    transition_kind     TEXT    NOT NULL,
    from_stage          TEXT,
    to_stage            TEXT    NOT NULL,
    actor_kind          TEXT    NOT NULL,
    actor_id            TEXT    NOT NULL,
    writer_epoch        INTEGER,
    message_id          TEXT             REFERENCES outbox(message_id),
    body                TEXT,
    supersedes_seq      INTEGER          REFERENCES gate_transition(seq),
    occurred_at_ms      INTEGER NOT NULL,
    recorded_at_ms      INTEGER NOT NULL,
    -- NEW: on whose authority a delegate acted.
    on_behalf_of        TEXT,
    authority_ref       TEXT,

    CHECK (transition_kind IN ('open', 'advance', 'resend', 'correction', 'close')),
    CHECK (from_stage IS NULL OR from_stage IN ('received', 'presented', 'answered', 'forwarded')),
    CHECK (to_stage IN ('received', 'presented', 'answered', 'forwarded')),
    CHECK ((transition_kind = 'open') = (from_stage IS NULL)),
    -- CHANGED: 'delegate' joins the vocabulary (D-1121).
    CHECK (actor_kind IN ('worker', 'secretary', 'human', 'delegate', 'dispatcher_core', 'system')),
    CHECK (length(actor_id) > 0),
    CHECK (writer_epoch IS NULL OR writer_epoch > 0),
    CHECK (body IS NULL OR length(body) > 0),
    CHECK ((transition_kind = 'correction') = (supersedes_seq IS NOT NULL)),
    CHECK (supersedes_seq IS NULL OR supersedes_seq < seq),
    CHECK (typeof(occurred_at_ms) = 'integer' AND typeof(recorded_at_ms) = 'integer'),

    -- NEW: a delegate's row names its authority, and only a delegate's row does.
    CHECK ((actor_kind = 'delegate') = (on_behalf_of IS NOT NULL)),
    CHECK ((actor_kind = 'delegate') = (authority_ref IS NOT NULL)),
    CHECK (on_behalf_of IS NULL OR length(on_behalf_of) > 0),
    CHECK (authority_ref IS NULL OR length(authority_ref) > 0),
    CHECK (on_behalf_of IS NULL OR on_behalf_of <> actor_id),
    -- NEW: and a delegate takes one edge, the answer.
    CHECK (actor_kind <> 'delegate'
           OR (transition_kind = 'advance' AND from_stage = 'presented'
               AND to_stage = 'answered'))
);

-- Every column, by name, for the reason 0003 gives.
INSERT INTO gate_transition_rebuilt_0008
    (seq, gate_id, transition_kind, from_stage, to_stage, actor_kind, actor_id,
     writer_epoch, message_id, body, supersedes_seq, occurred_at_ms, recorded_at_ms)
SELECT seq, gate_id, transition_kind, from_stage, to_stage, actor_kind, actor_id,
       writer_epoch, message_id, body, supersedes_seq, occurred_at_ms, recorded_at_ms
  FROM gate_transition;

-- The two row guards are BEFORE UPDATE / BEFORE DELETE triggers, and DROP TABLE
-- fires neither. No row is lost: each was copied above, under the same seq.
DROP TABLE gate_transition;

ALTER TABLE gate_transition_rebuilt_0008 RENAME TO gate_transition;

-- --------------------------------------------------------------------------
-- The index and triggers, recreated from 0001: dropping the table dropped them.
-- --------------------------------------------------------------------------
CREATE INDEX gate_transition_by_gate ON gate_transition(gate_id, seq);

CREATE TRIGGER gate_transition_rows_are_immutable
BEFORE UPDATE ON gate_transition
BEGIN
    SELECT RAISE(ABORT, 'a gate transition is history; correct it with a correction transition');
END;

CREATE TRIGGER gate_transition_rows_are_never_deleted
BEFORE DELETE ON gate_transition
BEGIN
    SELECT RAISE(ABORT, 'gate transition history is the relay-gap evidence');
END;

CREATE TRIGGER gate_stage_matches_its_transition
BEFORE UPDATE OF stage, stage_seq ON gate
WHEN NOT EXISTS (
    SELECT 1 FROM gate_transition t
     WHERE t.seq = NEW.stage_seq
       AND t.gate_id = NEW.gate_id
       AND t.to_stage = NEW.stage
       -- 'open' is admitted alongside 'advance' because the opening transition
       -- is what establishes the projection in the first place. Admitting only
       -- 'advance' makes gate creation impossible: the gate is inserted with a
       -- null stage_seq, the 'open' transition is inserted, and nothing may then
       -- point the projection at it -- and the transition table has no
       -- received -> received advance to reach instead.
       AND t.transition_kind IN ('open', 'advance'))
BEGIN
    SELECT RAISE(ABORT,
        'gate.stage is a projection; it may only name an open or advance transition of this gate');
END;

CREATE TRIGGER gate_stage_seq_is_monotonic
BEFORE UPDATE OF stage_seq ON gate
WHEN NEW.stage_seq < OLD.stage_seq OR NEW.stage_seq IS NULL
BEGIN
    SELECT RAISE(ABORT, 'a gate stage projection never walks backwards');
END;

CREATE TRIGGER gate_closure_is_terminal
BEFORE UPDATE ON gate
WHEN OLD.closed_at_ms IS NOT NULL
 AND (NEW.closed_at_ms IS NULL OR NEW.outcome <> OLD.outcome)
BEGIN
    SELECT RAISE(ABORT, 'a closed gate keeps its outcome; open a new gate instead');
END;
