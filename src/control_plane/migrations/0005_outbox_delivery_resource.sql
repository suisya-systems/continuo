-- ==========================================================================
--  0005 -- the outbox row records WHICH lease minted its writer_epoch
--
--  What was missing. An outbox row carried writer_epoch and nothing else about
--  its owner, and epoch order is meaningful only WITHIN a lease resource:
--  acquire() serialises on the lease table's primary key and takes over by
--  incrementing THAT resource's epoch. With one delivery resource the fence
--  clause ("a live lease for (:fence_resource, :fence_holder, :fence_epoch)")
--  and the row clause ("writer_epoch = :fence_epoch") composed into ownership.
--  Admit two, and they answer different questions: holder B's fence proves B's
--  own lease is live, B's row clause proves the row carries the number 1, and
--  a row holder A minted at ITS epoch 1 satisfies both. The update lands, the
--  fence never lied, and A's row was written by B. Recovery is worse: A's
--  unowned sweep asks whether a lease exists on A's resource at the row's
--  epoch, so a row B owns at epoch 2 is reported unowned and re-stamped under
--  A's epoch -- a live row transferred silently between runs.
--
--  The row was missing the LEFT-HAND SIDE of the fence triple. So this step
--  stores it: delivery_resource holds the exact lease resource string, not a
--  scope tag and not a partition id, because a shorter tag needs a mapping
--  back to the resource and every mapping is a second place the answer can be
--  wrong. D-1104 records the decision; D-0074 named this column as one of the
--  two candidate lifts and left both open on purpose.
--
--  WHY A TABLE REBUILD, AND NOT ALTER TABLE ADD COLUMN. SQLite admits
--  ALTER TABLE ADD COLUMN ... NOT NULL only with a non-null constant DEFAULT,
--  and a default cannot be dropped afterwards without the rebuild anyway. The
--  default would then outlive this step: a producer added later that forgets
--  to bind the column would get 'outbox-delivery' SILENTLY, and a silently
--  global row is a row no per-run lap will ever select -- the exact failure
--  class this column exists to make impossible, arriving by omission instead
--  of by design. NOT NULL with no default refuses that insert at the database
--  instead. 0004's rule for choosing between the two shapes (rebuild only when
--  an existing CHECK changes) points the other way on its own terms, and this
--  step overrides it for the reason above and for a second: the due index is
--  being joined by two more (below), so the step re-authors index DDL either
--  way. The cost is real and is the one 0004's header names -- "a rebuild that
--  silently re-authors what it rebuilds is how a constraint disappears without
--  a decision" -- so every line below is marked either carried verbatim or
--  CHANGED, and a diff shows the whole shape.
--
--  WHY THE ROWS ARE BACKFILLED, WHERE 0004 REFUSED TO BACKFILL. 0004 could not
--  invent the epoch an existing run row was written under: it was genuinely
--  unknown, and inventing one would have manufactured the evidence the column
--  exists to carry. Here the opposite holds. Every outbox row on disk was
--  written under the one delivery resource there has ever been -- enforced at
--  four sites, endpoint startup included -- so 'outbox-delivery' is RECORDED
--  history and any run scope would be FABRICATED history. The two headers
--  reach opposite conclusions from the same principle, which is why this one
--  says so rather than leaving 0004 to be read as precedent against it.
--
--  WHY A SECOND, NULLABLE MARKER COLUMN. delivery_resource_inherited is
--  written by this backfill and by nothing else, ever. After this step a gate
--  relay carrying the global resource whose gate names a run is impossible by
--  construction (enqueueRelay derives the resource from gate.run_id on every
--  insert), so such a row can only be INHERITED or CORRUPTED -- and the
--  operator's relay-ack path has to admit the first while refusing the second.
--  A clock cannot separate them: migrateControlPlane takes nowMs as an
--  argument and enqueueRelay takes enqueued_at_ms independently, under the
--  rule 0001_initial.sql sets for this whole database ("Time is the caller's
--  ... carries NO DEFAULT"), written that way precisely so acceptance testing
--  can inject skew across boundaries. A migration clock running behind an
--  existing relay's enqueue instant would strand a genuinely inherited relay,
--  and a backdated row written afterwards would pass the exception -- wrong in
--  both directions. The marker separates them because it is a fact about what
--  this migration did, not a fact about clocks. The rebuild is rewriting every
--  row regardless, so it is close to free.
--
--  WHERE THE FOREIGN KEYS WENT. Unchanged from 0003, whose header states it in
--  full: event_consumption, gate_transition and gate_relay carry REFERENCES
--  outbox(message_id), PRAGMA foreign_keys = OFF is a no-op inside a
--  transaction and is issued by migrator._apply_pending around the whole run,
--  and each step ends with a whole-database PRAGMA foreign_key_check inside its
--  own transaction. PRAGMA defer_foreign_keys was measured not to work for this
--  shape (0003's header records the measurement) and is not used here either.
--
--  WHAT IS DELIBERATELY NOT DONE.
--
--    (a) No CHECK on the SHAPE of delivery_resource. The database is not told
--        how a delivery resource is spelled: the one constructor is
--        deliveryResourceForRun() and a LIKE pattern here would be a second
--        spelling of it, free to admit what the constructor never builds or
--        refuse what it does.
--    (b) action_one_effect_per_key is NOT re-keyed. It stays UNIQUE
--        (idempotency_key) WHERE status <> 'refused', with no resource and no
--        run in it. It is the exactly-once guarantee for an EFFECT at a
--        destination outside this database; adding the resource would let two
--        runs each perform the same effect once and call it exactly-once
--        twice. D-1104 records this as a decision, not an oversight.
--    (c) outbox_undelivered is NOT dropped. Section 5.4 of the design proposed
--        replacing it with the two new indexes; the replacement was measured to
--        regress a third reader the design had not enumerated. See the index
--        block below.
--    (d) No retention, no compaction, no cleanup of anything. In particular the
--        shared destination's fence.json now grows one key per run for ever,
--        and D-1104 explicitly does NOT authorise compacting it.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- The new shape. Carried CHARACTER FOR CHARACTER from 0003 except for the
-- four lines called out below: a rebuild that silently re-authors the table
-- it is rebuilding is how a constraint disappears without a decision.
-- --------------------------------------------------------------------------
CREATE TABLE outbox_rebuilt_0005 (
    message_id       TEXT    PRIMARY KEY,
    run_id           TEXT    REFERENCES run(run_id),
    recipient        TEXT    NOT NULL,
    payload          TEXT    NOT NULL,
    dedup_key        TEXT    NOT NULL,
    status           TEXT    NOT NULL,
    retry_count      INTEGER NOT NULL DEFAULT 0,
    writer_epoch     INTEGER,
    enqueued_at_ms   INTEGER NOT NULL,
    delivered_at_ms  INTEGER,
    acked_at_ms      INTEGER,

    -- CHANGED (1 of 4). The exact lease resource string whose epoch sequence
    -- governs this row's delivery-side mutations. NOT NULL and no DEFAULT, so
    -- a producer that forgets to bind it is refused here rather than given the
    -- global resource silently. The invariant every producer maintains is
    -- "writer_epoch IS NULL OR writer_epoch was minted by delivery_resource":
    -- the fenced producer takes it from its own live lease, the two unfenced
    -- producers derive it from the row's durable run_id, and neither can pair
    -- a per-run epoch with the global name.
    delivery_resource TEXT NOT NULL,

    -- CHANGED (2 of 4). 1 on a row this migration inherited, NULL on every row
    -- written afterwards. Written by the backfill below and by nothing else --
    -- no product code binds this column, and the trigger below refuses any
    -- later change to it. It is the recorded provenance the operator's relay
    -- ack needs in order to admit a legacy global relay under a gate that
    -- names a run while still refusing the same shape as corruption on a row
    -- written after this step.
    delivery_resource_inherited INTEGER,

    CHECK (typeof(message_id) = 'text' AND typeof(dedup_key) = 'text'),
    CHECK (typeof(retry_count) = 'integer' AND typeof(enqueued_at_ms) = 'integer'),
    CHECK (writer_epoch IS NULL OR typeof(writer_epoch) = 'integer'),
    CHECK (delivered_at_ms IS NULL OR typeof(delivered_at_ms) = 'integer'),
    CHECK (acked_at_ms IS NULL OR typeof(acked_at_ms) = 'integer'),
    CHECK (length(message_id) > 0),
    CHECK (length(recipient) > 0),
    CHECK (length(dedup_key) > 0),
    CHECK (status IN ('pending', 'delivered', 'acked', 'cancelled')),
    CHECK (retry_count >= 0),
    CHECK (writer_epoch IS NULL OR writer_epoch > 0),
    CHECK (CASE status
             WHEN 'pending'   THEN delivered_at_ms IS NULL
             WHEN 'delivered' THEN delivered_at_ms IS NOT NULL
             WHEN 'acked'     THEN delivered_at_ms IS NOT NULL
             WHEN 'cancelled' THEN 1
           END),
    CHECK ((status = 'acked') = (acked_at_ms IS NOT NULL)),
    CHECK (acked_at_ms IS NULL OR acked_at_ms >= delivered_at_ms),
    CHECK (delivered_at_ms IS NULL OR delivered_at_ms >= enqueued_at_ms),

    -- CHANGED (3 of 4). Typed and non-empty, like every other non-null text
    -- column on this table. No shape test: see (a) in the header.
    CHECK (typeof(delivery_resource) = 'text'),
    CHECK (length(delivery_resource) > 0),

    -- CHANGED (4 of 4). The marker is a marker: absent, or the one value that
    -- means "this migration inherited this row". A counter or a timestamp here
    -- would invite exactly the clock reasoning the header rejects.
    CHECK (delivery_resource_inherited IS NULL OR delivery_resource_inherited = 1)
);

-- Every column, by name. SELECT * would bind this copy to the column ORDER of
-- whatever shape happens to be on disk, and a step whose meaning depends on
-- column order is a step that stops meaning the same thing after any later
-- rebuild.
--
-- The two new columns are the two literals: 'outbox-delivery' is the resource
-- every row on disk was genuinely written under (see the header), and 1 marks
-- every one of them as inherited. Both are constants rather than expressions
-- because there is nothing to decide per row -- there has only ever been one
-- delivery resource, so a CASE here would be a branch with one reachable arm
-- pretending the history was richer than it was.
INSERT INTO outbox_rebuilt_0005
    (message_id, run_id, recipient, payload, dedup_key, status, retry_count,
     writer_epoch, enqueued_at_ms, delivered_at_ms, acked_at_ms,
     delivery_resource, delivery_resource_inherited)
SELECT message_id, run_id, recipient, payload, dedup_key, status, retry_count,
       writer_epoch, enqueued_at_ms, delivered_at_ms, acked_at_ms,
       'outbox-delivery', 1
  FROM outbox;

-- outbox_rows_are_never_deleted guards rows, and DROP TABLE is not a DELETE:
-- BEFORE DELETE triggers do not fire for it. The rows are not being deleted in
-- any case -- they were copied above and come back under the same name below,
-- with the same message_id, retry_count, delivered_at_ms and acked_at_ms.
DROP TABLE outbox;

ALTER TABLE outbox_rebuilt_0005 RENAME TO outbox;

-- --------------------------------------------------------------------------
-- The triggers and the indexes, recreated. Dropping the table dropped all of
-- them, so anything not restored here is a constraint silently repealed by a
-- migration -- the exact failure the checksum discipline of section 3.2 exists
-- to make impossible to do twice.
-- --------------------------------------------------------------------------

-- Carried verbatim from 0003.
CREATE TRIGGER outbox_retry_count_is_monotonic
BEFORE UPDATE OF retry_count ON outbox
WHEN NEW.retry_count < OLD.retry_count
BEGIN
    SELECT RAISE(ABORT, 'outbox retry_count must not decrease');
END;

-- Carried verbatim from 0003, lattice and message alike.
CREATE TRIGGER outbox_status_is_forward_only
BEFORE UPDATE OF status ON outbox
WHEN NEW.status <> OLD.status
 AND NOT (   (OLD.status = 'pending'   AND NEW.status IN ('delivered', 'cancelled'))
          OR (OLD.status = 'delivered' AND NEW.status IN ('acked', 'cancelled')))
BEGIN
    SELECT RAISE(ABORT, 'outbox status walks pending -> delivered -> acked, or is cancelled from pending or delivered; acked and cancelled are terminal');
END;

-- Carried verbatim from 0003.
CREATE TRIGGER outbox_delivery_is_set_once
BEFORE UPDATE ON outbox
WHEN OLD.delivered_at_ms IS NOT NULL
 AND (NEW.delivered_at_ms IS NULL OR NEW.delivered_at_ms <> OLD.delivered_at_ms)
BEGIN
    SELECT RAISE(ABORT, 'a delivered message is delivered once');
END;

-- Carried verbatim from 0003.
CREATE TRIGGER outbox_message_id_is_frozen
BEFORE UPDATE OF message_id ON outbox
WHEN NEW.message_id <> OLD.message_id
BEGIN
    SELECT RAISE(ABORT, 'an outbox row keeps the message identity it was enqueued under');
END;

-- Carried verbatim from 0003.
CREATE TRIGGER outbox_dedup_key_is_frozen
BEFORE UPDATE OF dedup_key ON outbox
WHEN NEW.dedup_key <> OLD.dedup_key
BEGIN
    SELECT RAISE(ABORT, 'an outbox row keeps the dedup key it was enqueued with');
END;

-- Carried verbatim from 0003.
CREATE TRIGGER outbox_ack_is_set_once
BEFORE UPDATE ON outbox
WHEN OLD.acked_at_ms IS NOT NULL
 AND (NEW.acked_at_ms IS NULL OR NEW.acked_at_ms <> OLD.acked_at_ms)
BEGIN
    SELECT RAISE(ABORT, 'an acked message is acked once');
END;

-- Carried verbatim from 0003.
CREATE TRIGGER outbox_rows_are_never_deleted
BEFORE DELETE ON outbox
BEGIN
    SELECT RAISE(ABORT, 'outbox rows are delivery evidence and are never deleted');
END;

-- NEW. A row's delivery resource is decided at enqueue and never moves. A
-- mutable one is a partition that can be moved out from under a live holder:
-- rewrite the column and a row A is mid-delivery on becomes B's, whose fenced
-- write would then match it under a fence that is perfectly intact. The
-- immutability is what makes the in-statement equality mean ownership rather
-- than "ownership as of whenever this column was last edited".
CREATE TRIGGER outbox_delivery_resource_is_frozen
BEFORE UPDATE OF delivery_resource ON outbox
WHEN NEW.delivery_resource <> OLD.delivery_resource
BEGIN
    SELECT RAISE(ABORT, 'an outbox row keeps the delivery resource it was enqueued under');
END;

-- NEW. The marker is recorded provenance about what THIS migration did, so no
-- later writer may add it, remove it or change it -- a row that could acquire
-- the marker afterwards would be a corrupted relay able to buy itself the
-- legacy exception the operator's ack path grants inherited rows.
CREATE TRIGGER outbox_delivery_resource_inherited_is_frozen
BEFORE UPDATE OF delivery_resource_inherited ON outbox
WHEN NEW.delivery_resource_inherited IS NOT OLD.delivery_resource_inherited
BEGIN
    SELECT RAISE(ABORT, 'delivery_resource_inherited is written by migration 0005 and by nothing else');
END;

-- And the same rule on the way IN, which the trigger above cannot cover. Its
-- BEFORE UPDATE OF form guards CHANGES to the column; without this second
-- trigger a fresh INSERT could still set the marker, and the CHECK admits the
-- value -- so a row written after this step could buy itself the legacy
-- exception the operator's relay ack grants inherited rows, which is the one
-- thing the marker exists to make impossible. The header above states the
-- invariant as "written by this backfill and by nothing else, ever", and this
-- is the half that makes the schema hold it as strongly as the sentence claims.
-- The backfill is not caught by it: this trigger is created after the rename,
-- and the copy ran before.
CREATE TRIGGER outbox_delivery_resource_inherited_is_not_written_by_a_producer
BEFORE INSERT ON outbox
WHEN NEW.delivery_resource_inherited IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'delivery_resource_inherited is written by migration 0005 and by nothing else');
END;

-- Carried verbatim from 0003, and NOT replaced. Section 5.4 of the design
-- proposed replacing this index with the two below, on the ground that the due
-- query gains two equality terms in front of its range term. Measured against
-- the tree, replacing it regresses a THIRD reader the design did not
-- enumerate: events.ORPHANED_OUTBOX_SQL is deliberately database-wide -- it
-- asks which rows are stale for ANY owner, so it can never carry a
-- delivery_resource term -- and neither composite index below can seek
-- enqueued_at_ms for it, because their leading column is unconstrained in that
-- query. That is the same shape of finding the design's own round A2 recorded
-- about the recipient-less due call, applied to a reader outside the due
-- family.
--
-- An earlier draft of this comment also named gates.stalled_relays as a reader
-- of this index. Measured, it is not: that query drives from gate_relay and
-- reaches outbox by primary key (SEARCH o USING INDEX
-- sqlite_autoindex_outbox_1 (message_id=?)), naming no partial index at all.
-- The keep-decision rests on ORPHANED_OUTBOX_SQL alone, which is sufficient,
-- and the narrower claim is the one worth leaving on the page.
-- So the step ADDS two indexes rather than replacing one, and D-1104 records
-- the deviation with the measurement behind it.
CREATE INDEX outbox_undelivered ON outbox(enqueued_at_ms)
    WHERE status IN ('pending', 'delivered');

-- NEW. The shape MessageBus.poll runs: one resource, one recipient, rows at or
-- before now, in enqueue order. Both equalities lead so that enqueued_at_ms is
-- still a seekable range term rather than a filter applied after a scan of the
-- partition. The partial predicate is spelled as the positive IN list, for the
-- reason 0003 gives: SQLite may use a partial index only when the query's WHERE
-- carries the index's own predicate as a term, and the reader carries this
-- exact text.
CREATE INDEX outbox_due_by_recipient ON outbox(delivery_resource, recipient, enqueued_at_ms)
    WHERE status IN ('pending', 'delivered');

-- NEW, and NOT redundant with the index above -- this is the half a later
-- reader is most likely to drop as duplication. Outbox.due has two call
-- shapes: MessageBus.poll supplies a recipient, and every other caller (the
-- fault-injection belt, and the existing assertions) does not. On the second
-- shape the composite index above cannot seek enqueued_at_ms, because
-- recipient sits between the two constrained columns and is unconstrained --
-- so that call would visit every unfinished row of the resource and sort them
-- in a temporary B-tree for the ORDER BY. This index serves that shape.
CREATE INDEX outbox_due_by_resource ON outbox(delivery_resource, enqueued_at_ms)
    WHERE status IN ('pending', 'delivered');

-- --------------------------------------------------------------------------
-- The audit trail: which lease minted an action row's writer_epoch.
--
-- Same gap, one table over. An outbox action row carries kind = 'notify' and a
-- writer_epoch, and nothing says which lease allocated the number.
-- docs/lease-fencing.md names the spike's way out -- effect_kind(resource,
-- effect), which encodes the resource in action.kind -- and calls it "a
-- workaround, not a design: a real schema carries the resource as a column".
-- This is that column.
--
-- WHY ALTER TABLE HERE AND A REBUILD ABOVE. Nothing on action changes: no
-- CHECK is replaced, no index is re-keyed, and the new column's own CHECK
-- travels with its definition. That is exactly 0004's rule, and unlike the
-- outbox column this one is NULLABLE on purpose, so there is no DEFAULT to
-- outlive the step.
--
-- WHY NULLABLE, AND WHAT NULL MEANS. Not "predates the column" -- that would
-- be false the day this step lands. Four action writers (supervisor, watcher,
-- session_binding, run_lifecycle via lease.ts) compose their kind with
-- effect_kind and are deliberately not changed by this step, so they keep
-- writing exactly-attributed rows with this column null for ever. The
-- definition is the disjunction the readers implement: a row's writer resource
-- is writer_resource when non-null, and the suffix of kind otherwise, and
-- every row carries its attribution in exactly one of the two forms. The
-- column exists for the ONE producer that cannot use the other -- the outbox
-- path, whose action kinds are the bare 'notify' and 'human_gated'.
-- --------------------------------------------------------------------------
ALTER TABLE action ADD COLUMN writer_resource TEXT
    CHECK (writer_resource IS NULL
           OR (typeof(writer_resource) = 'text' AND length(writer_resource) > 0));

-- NEW. Attribution, once non-null, is evidence: it says which lease minted the
-- epoch in the same row. Nothing may re-aim it afterwards. Null is left
-- writable in one direction only -- an unattributed row may gain attribution
-- (which is what the backfill below does, in this same transaction) and an
-- attributed one may never lose or change it.
CREATE TRIGGER action_writer_resource_is_set_once
BEFORE UPDATE OF writer_resource ON action
WHEN OLD.writer_resource IS NOT NULL
 AND (NEW.writer_resource IS NULL OR NEW.writer_resource <> OLD.writer_resource)
BEGIN
    SELECT RAISE(ABORT, 'an action row keeps the writer resource its epoch was minted under');
END;

-- The backfill, and it is what makes the readers' fallback sufficient. A
-- pre-0005 outbox action row has writer_resource IS NULL *and* a bare kind, so
-- the kind-suffix fallback excludes it from write_history() and throws out of
-- resource_of_kind() exactly as before -- adding the column without this
-- statement would leave the gap open while looking repaired.
--
-- The predicate identifies those rows exactly for a database this tree
-- produced: every other action writer composes its kind with effect_kind, so
-- an '@' in kind means "attributed the old way", and the outbox path is the
-- only writer here that does not compose. Rows so selected were written under
-- the one delivery resource there has ever been, so 'outbox-delivery' records
-- what is known -- the same argument as the outbox backfill above, and not the
-- fabrication 0004 refused.
--
-- The residual is named rather than papered over: HandlerRegistry.register
-- requires only a non-empty actionKind, so a database written through the
-- public API with a kind like 'mail@v2' would be skipped here AND read by the
-- fallback as though 'v2' were its lease resource. No syntactic discriminator
-- fixes that -- such a row is byte-identical to a legitimate
-- effect_kind('v2', 'mail') row -- so what bounds it is a measurement instead:
-- the package is "private": true at version 0.0.0 and unpublished, so every
-- existing database was produced by this tree, where the only outbox action
-- kinds are the two bare ones. A foreign database carrying an '@'-bearing
-- legacy action kind is OUT OF SCOPE for this step: unattributable, rather
-- than mis-attributed by design. Going forward the format is closed --
-- register() now refuses an actionKind containing '@', the rule effect_kind
-- already enforces for effects.
UPDATE action
   SET writer_resource = 'outbox-delivery'
 WHERE writer_epoch IS NOT NULL
   AND writer_resource IS NULL
   AND instr(kind, '@') = 0;
