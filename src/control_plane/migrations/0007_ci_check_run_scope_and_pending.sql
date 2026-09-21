-- ==========================================================================
--  0007 -- ci_observation learns what `gh` actually reports (D-1113)
--
--  What this closes. `continuo ci observe` records what the operator's `gh`
--  printed about a pull request's head, and GitHub reports two things 0001's
--  vocabulary has no member for:
--
--    (a) a check that has NOT FINISHED. 0001's verdicts are all outcomes, so a
--        running check could only be recorded as nothing -- and then a PR with
--        one green check and one still running folds to 'passed' -- or as
--        'indeterminate', which says "could not be observed" about a check
--        that was observed perfectly well. The gate answer recorded in D-1113
--        is that a pending check is "not yet" and never green, so the verdict
--        set gains 'pending', ranked below every failure and 'indeterminate'
--        and above 'passed' in the fold (ci_ingest.ts VERDICT_SEVERITY).
--    (b) the unit GitHub reports in. `commits/<sha>/check-runs` answers one
--        check run per check NAME (the latest of each), and `commits/<sha>/
--        status` one status per CONTEXT. Neither is a check suite or a workflow
--        run. Keying a check run by its numeric id instead would be wrong in
--        the way that costs a result: a rerun is a NEW check run with a new id,
--        so the old red run would stay in the fold as a scope of its own and
--        the PR would read red after its rerun went green. So the scope set
--        gains 'check_run' (scope_id = the check's name) and 'commit_status'
--        (scope_id = the status's context), and a rerun is a later observation
--        of the SAME scope, ordered by the provider's clock like every other.
--
--  WHY A TABLE REBUILD. Both vocabularies are CHECK constraints, and SQLite has
--  no ALTER TABLE that replaces one; 0003 states the procedure and why nothing
--  cheaper is acceptable. Nothing REFERENCES ci_observation and no trigger is
--  on it, so the rebuild has no foreign key to hold open. The view that reads
--  it is dropped first and recreated last, because it is part of what this
--  step changes.
-- ==========================================================================

DROP VIEW ci_current_verdict;

-- --------------------------------------------------------------------------
-- The new shape. Carried character for character from 0001 except for the two
-- CHECK lines marked CHANGED.
-- --------------------------------------------------------------------------
CREATE TABLE ci_observation_rebuilt_0007 (
    observation_id  TEXT    PRIMARY KEY,
    event_seq       INTEGER NOT NULL REFERENCES event(seq),
    provider        TEXT    NOT NULL,
    repo_id         TEXT    NOT NULL REFERENCES repository(repo_id),
    pr_number       INTEGER NOT NULL,
    head_sha        TEXT    NOT NULL,
    check_scope     TEXT    NOT NULL,
    scope_id        TEXT    NOT NULL,
    attempt         INTEGER NOT NULL,
    verdict         TEXT    NOT NULL,
    verdict_detail  TEXT,
    source_id       TEXT,
    observer        TEXT    NOT NULL,
    observer_epoch  INTEGER NOT NULL,
    occurred_at_ms  INTEGER NOT NULL,
    ingested_at_ms  INTEGER NOT NULL,

    CHECK (provider IN ('github')),
    CHECK (typeof(pr_number) = 'integer' AND pr_number > 0),
    CHECK (length(head_sha) = 40 AND head_sha = lower(head_sha)),
    -- CHANGED: + check_run, commit_status.
    CHECK (check_scope IN ('check_suite', 'workflow_run', 'rollup',
                           'check_run', 'commit_status')),
    CHECK (length(scope_id) > 0),
    CHECK (typeof(attempt) = 'integer' AND attempt >= 1),
    -- CHANGED: + pending.
    CHECK (verdict IN (
        'passed',
        'failed',
        'cancelled',
        'timed_out',
        'no_run',          -- the provider reports no CI configured for this head
        'indeterminate',   -- OBSERVATION_UNAVAILABLE's CI shape (D-0006)
        'pending'          -- observed, and not finished yet (D-1113)
    )),
    CHECK (observer_epoch > 0),
    CHECK (typeof(occurred_at_ms) = 'integer' AND typeof(ingested_at_ms) = 'integer')
);

INSERT INTO ci_observation_rebuilt_0007
SELECT observation_id, event_seq, provider, repo_id, pr_number, head_sha, check_scope,
       scope_id, attempt, verdict, verdict_detail, source_id, observer, observer_epoch,
       occurred_at_ms, ingested_at_ms
  FROM ci_observation;

DROP TABLE ci_observation;

ALTER TABLE ci_observation_rebuilt_0007 RENAME TO ci_observation;

-- Carried verbatim from 0001; dropped with the table.
CREATE UNIQUE INDEX ci_observation_event ON ci_observation(event_seq);

CREATE UNIQUE INDEX ci_observation_identity
    ON ci_observation(provider, repo_id, pr_number, head_sha, check_scope, scope_id,
                      attempt, verdict);

CREATE INDEX ci_observation_by_head
    ON ci_observation(repo_id, pr_number, head_sha, attempt DESC, occurred_at_ms DESC);

-- Carried from 0001 with one CHANGED line: rule 3's list of fine-grained scopes
-- gains the two new ones. Left out, a stale coarse rollup would stay in the
-- fold beside real check runs -- the exact failure rule 3 exists to prevent.
CREATE VIEW ci_current_verdict AS
SELECT o.repo_id, o.pr_number, o.head_sha, o.check_scope, o.scope_id,
       o.verdict, o.attempt, o.occurred_at_ms, o.event_seq
  FROM ci_observation o
  JOIN pull_request p
    ON p.repo_id = o.repo_id AND p.pr_number = o.pr_number AND p.head_sha = o.head_sha
 WHERE o.observation_id = (
        SELECT o2.observation_id FROM ci_observation o2
         WHERE o2.repo_id = o.repo_id AND o2.pr_number = o.pr_number
           AND o2.head_sha = o.head_sha AND o2.check_scope = o.check_scope
           AND o2.scope_id = o.scope_id
         ORDER BY o2.attempt DESC, o2.occurred_at_ms DESC, o2.event_seq DESC
         LIMIT 1)
   AND (o.check_scope <> 'rollup'
        OR NOT EXISTS (SELECT 1 FROM ci_observation f
                        WHERE f.repo_id = o.repo_id AND f.pr_number = o.pr_number
                          AND f.head_sha = o.head_sha
                          -- CHANGED: + check_run, commit_status.
                          AND f.check_scope IN ('check_suite', 'workflow_run',
                                                'check_run', 'commit_status')));
