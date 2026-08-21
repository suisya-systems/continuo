# The merge gate: double-green under random ordering

Authority: [`DECISIONS.md`](../DECISIONS.md) `D-0005`.
Workflow: [`.github/workflows/tests.yml`](../.github/workflows/tests.yml).

## What "green twice under random ordering" means here

Loosely stated, the phrase has at least three readings that satisfy the words and defeat the
intent. The definition in force is the narrow one:

> Within **each required matrix cell**, the suite runs **twice**, in **two independent processes**,
> **serially**, at **two distinct explicit seeds**, and **both** runs must pass. A single aggregate
> job succeeds only when every required cell has done so.

Explicitly **not** double-green:

| Shape | Why it fails the rule |
|---|---|
| Separate matrix cells each running once | Two greens, one order each. No cell was ever run twice. |
| Two runs at the same seed | The same order, twice. Proves nothing about order. |
| Two runs inside one process | Module state, timers and cached handles survive between them, so the second run is not independent. |
| Shuffle enabled by a CLI flag | A later edit to the workflow drops the flag and nothing turns red. |

## Where each half is enforced

**Randomization is configuration, not a flag.** `vitest.config.ts` sets
`sequence.shuffle = {files: true, tests: true}`, `retry: 0`, `passWithNoTests: false`,
`sequence.concurrent: false`. CI passes **only** the seed, through `CONTINUO_TEST_SEED`. A workflow
edit cannot switch shuffling off, because the workflow does not switch it on.

**The seed is mandatory under CI and always printed.** Vitest's default seed is `Date.now()`, so an
un-injected seed produces a run nobody can reproduce. `vitest.config.ts` throws when `CI` is set and
`CONTINUO_TEST_SEED` is not. Both the config and Vitest's own banner print the seed on success as
well as on failure -- the seed of a *green* run is what a later bisect needs.

**Seeds vary per run.** They are derived from `github.run_id`, `github.run_attempt` and the cell
coordinates, so re-running a red build explores new orders instead of replaying the order that
happened to be green.

## Reproducing a CI failure locally

The log line is `continuo: test order seed = <n>`, and Vitest's own banner repeats it as
`Running tests with seed "<n>"`. Then:

```bash
CONTINUO_TEST_SEED=<n> npm test
```

The order is reproducible for a **fixed set of discovered test files**. Adding or removing a test
file changes the resulting order at the same seed, so reproduce before you edit.

## The required check is `ci-gate`, and it is fail-closed

Two GitHub behaviours make the obvious spelling of this job wrong:

1. **A skipped job reports as success to a required check.** Without `if: ${{ always() }}`, a
   failing matrix job causes the aggregate job to be *skipped*, and the gate reads that skip as a
   pass. The gate is then open exactly when it should be shut.
2. **A deny-list leaves holes.** `if: needs.x.result != 'failure'` passes on `cancelled` and on
   `skipped`. `ci-gate` asserts `== 'success'` instead, and additionally refuses any
   `failure`/`cancelled`/`skipped` anywhere in `needs.*` -- because the rule that
   `needs.<job>.result` aggregates all legs of a matrix is long-observed runner behaviour rather
   than a documented guarantee.

The ruleset references the literal string **`ci-gate`** and nothing else. A matrix leg's check-run
name embeds its matrix values (`double-green (ubuntu-latest, node 22)`), so requiring leg names
means every matrix edit silently changes the set of required contexts.

## The branch ruleset

A ruleset is a repository setting: it lives outside this repository's diff and cannot be reviewed in
a PR. Its intended contents are recorded here so the live setting can be audited against an intent
that *is* under version control.

```jsonc
// POST /repos/suisya-systems/continuo/rulesets
{
  "name": "default-branch-ci-gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "required_status_checks": [{ "context": "ci-gate" }],
        // false: do not require the branch to be up to date with the base
        // before merging. Enabling it serializes merges behind a rebase, which
        // is a throughput decision, not a correctness one.
        "strict_required_status_checks_policy": false
      }
    }
  ]
}
```

```bash
gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/suisya-systems/continuo/rulesets --input ruleset.json
```

Creating it requires **admin** on the repository (fine-grained token: Administration write; classic
token: `repo`). Insufficient permission answers 403 or 404.

**Apply it after this workflow is on `main`.** A ruleset that requires a context no workflow reports
leaves every pull request pending forever, and the same rule applies to direct pushes to `main`.
