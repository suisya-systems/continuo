-- ==========================================================================
--  THE ROUTING LEDGER -- item 10 rehearsal (Issue #23)
--
--  *** A REHEARSAL AGAINST A SYNTHETIC COUNTERPARTY (D-0022). NOT A
--  DISCHARGE: GATE ITEM 10 IS DISCHARGED AT THE CANARY ITSELF, WITH LIVE V1
--  AS THE COUNTERPARTY. Q-0005 REMAINS OPEN: NO NUMERIC GO/NO-GO CRITERION
--  IS STATED OR USED HERE. ***
--
--  This ledger is the routing point's own durable record, and it is a
--  SEPARATE store on purpose -- separate from the spike control-plane
--  database (S5) and separate from the synthetic counterparty's store. It is
--  neither system's run state; it is the record of which system OWNS each
--  run, held by the layer that sits above both. Two boundaries follow:
--
--    * It is throwaway (D-0026), like every other spike implementation, and
--      it deliberately does NOT join Q-0001's territory: no component, no
--      role, no lease holder appears here. owning_system names a SYSTEM
--      (interlock, or the synthetic v1 stand-in), never a component within
--      one -- folding this into a component->state-item writer table would
--      answer Q-0001 by implementation.
--    * It never touches the spike schema. The S5 database is refused at any
--      other shape (D-0026), and the rollback property below depends on the
--      run stores NOT changing when routing does.
--
--  Two relations, deliberately not one. A single mutable "who owns runs" row
--  would let a routing change rewrite history: flipping the decision would
--  flip the recorded owner of runs already in flight, which is exactly the
--  mid-flight owner change item 10 forbids. So:
--
--    * routing_decision is the POLICY for runs that have not started yet.
--      It is append-only; the newest row is the routing. A rollback is one
--      appended row here and nothing anywhere else -- that is the property
--      the canary is cheap because of.
--    * run_owner is the LEDGER for runs that have started. Insert-only,
--      one row per run, and the owning system of a row is immutable by
--      trigger: a run never changes owner mid-flight, whatever the policy
--      does after it started.
--
--  Time is the caller's, as everywhere in this codebase: every timestamp is
--  INTEGER milliseconds since the Unix epoch, UTC, NOT NULL, no DEFAULT.
--  Order of authority among decisions is decision_seq, never the clock.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- routing_decision -- where NEW runs go, as an append-only history.
--
-- The rehearsed rollback is `INSERT INTO routing_decision` with the previous
-- owning system, and nothing else. Everything the rollback is allowed to
-- change lives in this table; the audit compares the stores across a rollback
-- excluding exactly this relation.
--
-- owning_system is a closed two-value vocabulary because the canary shape
-- (D-0013) has exactly two systems, and because the stand-in is named
-- synthetic_v1 rather than v1 so a ledger written by the rehearsal can never
-- be mistaken for one written against the live counterparty.
-- --------------------------------------------------------------------------
CREATE TABLE routing_decision (
    decision_seq   INTEGER PRIMARY KEY,
    owning_system  TEXT    NOT NULL,
    decided_at_ms  INTEGER NOT NULL,
    reason         TEXT    NOT NULL,

    CHECK (typeof(owning_system) = 'text' AND typeof(reason) = 'text'),
    CHECK (typeof(decided_at_ms) = 'integer'),
    CHECK (owning_system IN ('interlock', 'synthetic_v1')),
    CHECK (length(reason) > 0),
    -- A sequence number is a counter, so it is not negative -- and reserving
    -- the negative half is what keeps `routing_decision_is_never_replaced`
    -- exact. That trigger asks whether NEW.decision_seq is already in the
    -- table, and SQLite gives NEW.decision_seq the value **-1** in a BEFORE
    -- INSERT trigger when the insert supplies no sequence (the manual calls it
    -- undefined; measured on SQLite 3.53.4 it is -1, on an empty table and a
    -- populated one alike). So a row stored at -1 would make every ordinary,
    -- sequence-omitting append look like a replacement and be refused: a
    -- working ledger bricked by a value only an out-of-band writer could have
    -- put there.
    --
    -- `>= 0` rather than `<> -1` because SQLite assigns an omitted rowid as
    -- MAX + 1, so a stored -2 makes the NEXT auto-assigned sequence -1 -- the
    -- sentinel again, this time as the value being written. Excluding the whole
    -- negative half closes both directions at once: nothing can be stored at
    -- the sentinel, and nothing can be assigned it either (with the smallest
    -- legal sequence 0, an auto-assignment is always 1 or more).
    --
    -- ZERO IS DELIBERATELY STILL LEGAL. `routing_decision_is_appended_in_order`
    -- is what refuses a back-filled sequence, and the ported case that pins it
    -- inserts 0 and matches that trigger's sentence; a CHECK swallowing 0 first
    -- would change what that case asserts.
    CHECK (decision_seq >= 0)
);

-- The newest decision is the routing, so an insert that back-fills a smaller
-- sequence number would silently change which decision is newest without
-- appending anything. An omitted decision_seq is assigned by SQLite as
-- max+1 (rows are never deleted, so rowids never recycle), and an explicit
-- one must extend the history, not rewrite its order. AFTER rather than
-- BEFORE, because an omitted INTEGER PRIMARY KEY is undefined in a BEFORE
-- INSERT trigger -- the auto-assigned value exists only after the insert --
-- and RAISE(ABORT) in an AFTER trigger still undoes the statement.
CREATE TRIGGER routing_decision_is_appended_in_order
AFTER INSERT ON routing_decision
WHEN NEW.decision_seq < (SELECT MAX(decision_seq) FROM routing_decision)
BEGIN
    SELECT RAISE(ABORT, 'routing decisions are appended in order; the newest row is the routing');
END;

-- A decision, once recorded, is never overwritten -- and this trigger is what
-- makes that true for a connection this package did not hand out (D-0405,
-- D-0406). The BEFORE DELETE trigger below refuses an explicit DELETE, but
-- `INSERT OR REPLACE` resolves a primary-key conflict with an IMPLICIT delete
-- that fires no trigger unless `recursive_triggers` is ON -- and that pragma is
-- per-connection, so an ordinary `new Database(path)` gets SQLite's default of
-- OFF and rewrites history in one statement. A BEFORE INSERT trigger fires
-- ahead of conflict resolution, so it refuses the replacement whatever the
-- pragma says; that is the whole of the repair, measured.
--
-- The WHEN clause defers to the row's own CHECKs (see the matching note on
-- `run_owner_is_never_replaced`, which explains why): a row this table would
-- refuse anyway is left for the CHECK to refuse, so this guard never masks a
-- validation failure with a "you may not replace this" refusal. IT RESTATES
-- EVERY CHECK ON THE TABLE, AND A CHECK ADDED ABOVE BELONGS HERE TOO -- except
-- `decision_seq >= 0`, which is what makes the sentinel case safe rather than
-- something this clause has to handle (see that CHECK's own note). An ordinary
-- append supplies no decision_seq, arrives here as the reserved -1, matches no
-- row, and never reaches the RAISE.
CREATE TRIGGER routing_decision_is_never_replaced
BEFORE INSERT ON routing_decision
WHEN typeof(NEW.decision_seq) = 'integer'
 AND typeof(NEW.owning_system) = 'text'
 AND typeof(NEW.decided_at_ms) = 'integer'
 AND typeof(NEW.reason) = 'text'
 AND NEW.owning_system IN ('interlock', 'synthetic_v1')
 AND length(NEW.reason) > 0
 AND EXISTS (SELECT 1 FROM routing_decision WHERE decision_seq = NEW.decision_seq)
BEGIN
    SELECT RAISE(ABORT, 'a routing decision is never replaced; the routing history is appended to, never rewritten');
END;

-- Append-only in both directions: a decision, once taken, is history. An
-- edited decision would make "what was the routing at the time?" unanswerable
-- from the ledger, and a deleted one would erase the rollback's own evidence.
CREATE TRIGGER routing_decision_is_never_edited
BEFORE UPDATE ON routing_decision
BEGIN
    SELECT RAISE(ABORT, 'a routing decision is never edited; append a new one');
END;

CREATE TRIGGER routing_decision_is_never_deleted
BEFORE DELETE ON routing_decision
BEGIN
    SELECT RAISE(ABORT, 'routing decisions are rollback evidence and are never deleted');
END;

-- --------------------------------------------------------------------------
-- run_owner -- which system owns each STARTED run. Insert-only, one row per
-- run, owner immutable for the row's lifetime.
--
-- "No run changes owner mid-flight" is enforced here by the database, not by
-- the discipline of whoever routes: the UPDATE trigger refuses every update,
-- including a no-op one, because there is nothing on this row that is
-- legitimately updatable, the DELETE trigger refuses every delete, and the
-- BEFORE INSERT trigger refuses a row that would replace one already here --
-- which is the one of the three that holds on a connection this package did
-- not configure (D-0405). Re-routing the same run to the same owner is
-- handled above this table as an idempotent no-op (a crashed router may
-- retry); re-routing it to a DIFFERENT owner is refused as an owner change.
-- --------------------------------------------------------------------------
CREATE TABLE run_owner (
    run_id         TEXT    PRIMARY KEY,
    owning_system  TEXT    NOT NULL,
    decision_seq   INTEGER NOT NULL REFERENCES routing_decision(decision_seq),
    routed_at_ms   INTEGER NOT NULL,

    CHECK (typeof(run_id) = 'text' AND typeof(owning_system) = 'text'),
    CHECK (typeof(decision_seq) = 'integer' AND typeof(routed_at_ms) = 'integer'),
    CHECK (length(run_id) > 0),
    CHECK (owning_system IN ('interlock', 'synthetic_v1'))
);

-- The foreign key alone only proves the referenced decision EXISTS; it does
-- not prove the row agrees with it. A direct writer could otherwise record a
-- run as owned by one system under a decision that names the other -- a
-- contradiction that would then be immutable, verifiable, and capable of
-- passing a writer audit while violating the routing policy it cites. (A
-- missing decision_seq makes the subselect NULL and the WHEN vacuous; that
-- case is the foreign key's, and foreign_key_check refuses it at open.)
CREATE TRIGGER run_owner_matches_its_decision
BEFORE INSERT ON run_owner
WHEN NEW.owning_system <> (SELECT owning_system FROM routing_decision
                            WHERE decision_seq = NEW.decision_seq)
BEGIN
    SELECT RAISE(ABORT, 'a run owner must be the system its routing decision names');
END;

CREATE TRIGGER run_owner_never_changes_mid_flight
BEFORE UPDATE ON run_owner
BEGIN
    SELECT RAISE(ABORT, 'a run never changes owning system mid-flight (gate item 10)');
END;

-- The mid-flight guarantee against a writer this package did not hand out
-- (D-0405). `INSERT OR REPLACE INTO run_owner` moves a started run's owner in
-- one statement on any connection where `recursive_triggers` is OFF -- SQLite's
-- default, and the pragma is per-connection, so every caller that has not read
-- ledger.ts is such a connection. The implicit conflict-resolution DELETE fires
-- no BEFORE DELETE trigger there; a BEFORE INSERT trigger fires ahead of
-- conflict resolution and so refuses the replacement with the pragma either
-- way. Measured, and the reason this trigger exists rather than a comment
-- conceding the hole.
--
-- The WHEN clause deliberately DEFERS TO THE ROW'S OWN CHECKS: SQLite runs
-- BEFORE INSERT triggers ahead of constraint checking, so a bare
-- `EXISTS (...)` guard would answer a malformed row with "you may not replace
-- this" and the CHECK that should have refused it would never run. A row this
-- table would reject anyway is therefore left to the CHECK, and only a
-- well-formed replacement reaches the RAISE. The predicates below restate the
-- column CHECKs above for exactly that reason: A CHECK ADDED TO run_owner
-- BELONGS HERE TOO. (`run_id` and `length(run_id) > 0` are not restated: this
-- trigger only fires when NEW.run_id equals a row already in the table, which
-- is text and non-empty by those same CHECKs.)
CREATE TRIGGER run_owner_is_never_replaced
BEFORE INSERT ON run_owner
WHEN typeof(NEW.owning_system) = 'text'
 AND typeof(NEW.decision_seq) = 'integer'
 AND typeof(NEW.routed_at_ms) = 'integer'
 AND NEW.owning_system IN ('interlock', 'synthetic_v1')
 AND EXISTS (SELECT 1 FROM run_owner WHERE run_id = NEW.run_id)
BEGIN
    SELECT RAISE(ABORT, 'a started run keeps the owning system it was routed to; its ledger row is never replaced (gate item 10)');
END;

-- NOTE for both delete triggers in this file: on their own they guard the
-- INSERT OR REPLACE path only on a connection with PRAGMA recursive_triggers =
-- ON -- with it off (SQLite's default) the implicit conflict-resolution DELETE
-- fires no trigger at all. The pragma is per-connection, so ledger.ts sets it
-- in configureLedgerConnection() on every connection it hands out. The two
-- `..._is_never_replaced` BEFORE INSERT triggers above close that path for
-- every OTHER connection as well, which is what makes the guarantee a property
-- of the store rather than of the opener (D-0405).
CREATE TRIGGER run_owner_rows_are_never_deleted
BEFORE DELETE ON run_owner
BEGIN
    SELECT RAISE(ABORT, 'run ownership rows are writer-audit evidence and are never deleted');
END;
