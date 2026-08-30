# AGENTS.md — working on continuo

For anyone picking up an issue here, human or AI. It covers only what is **specific to this
repository and costly to get wrong**; general good practice is assumed and not repeated. Every rule
below cites where it is enforced, so you can check it rather than trust it.

Read [`README.md`](./README.md) first for what the project is. This file is about how work is done.

## 1. What this repository is, and what it is not

Continuo is a **test-first parity port** of [interlock](https://github.com/suisya-systems/interlock).
Interlock's *test suite* is the specification — not its Python source, and not your judgment about
what the code should do ([`docs/testing.md`](./docs/testing.md), "The suite is the specification").
Three consequences that catch newcomers:

- **Interlock is frozen and decides nothing.** It answers no question continuo has open, reviews no
  choice, and fixes no defect. Everything undecided is settled at *this* repository's human gate
  (`DECISIONS.md` `D-0036`), and inherited defects are repaired here (`D-0023`). A ledger field
  reading `where_a_fix_belongs: upstream` does not mean somebody elsewhere will do it — see
  [`docs/test-translation-conventions.md`](./docs/test-translation-conventions.md) §"How to read a
  `where_a_fix_belongs` that says upstream".
- **A stronger test is not a better test.** A translated case that asserts *more* than its source is
  wrong in the same way as one that asserts less: both make the suite say something interlock's
  suite does not say (`docs/test-translation-conventions.md` §0). If the stronger assertion is worth
  having, it goes next to the faithful translation as a declared target-only test.
- **Improving on the source is not a free win.** A parity port that quietly improves on its source is
  no longer a parity port; known limitations stay disclosed in the ledger's
  `inherited_limitations` (same document, §"The parity ledger").

## 2. Recording decisions — `DECISIONS.md`

If your change settles a question rather than just implementing one, it needs an entry.
The rules are stated in that file's own "How to use this file" section:

- **IDs are permanent.** Never reuse, renumber, merge, or delete an ID. A decision that stops being
  true **keeps its ID** and gains `Status: superseded by D-XXXX`; the replacement is a new entry at
  the end (see `D-0008` → `D-0045`).
- **Cross-reference by ID only** — never by line number, heading order, or table position.
- **Every entry states what would falsify it** (`**Falsifier.**` / `**Falsified by.**`, on most
  entries). A decision taken on facts that can change records the fact and the version it was
  measured at.
- **Number ranges are allocated per belt** (`D-0019`..`D-0099` control plane and cross-belt,
  `D-01xx` measurement, `D-02xx` fencing/settings, `D-03xx` session, `D-04xx` canary, `D-05xx`
  messagebus, `D-07xx` secretary, `D-09xx` attention, `D-10xx` gate_item11). Take the next free ID in
  your belt's range and add a row to the index table at the top of the file.
- An entry citing `interlock D-00NN` means *interlock's* decision of that number; the two numbering
  spaces are separate.

The house shape is `**Context.** / **Decision.** / **Alternatives.** / **Consequences.** /
**Status.** / **Source.**`, plus a falsifier. Abridged real example (`D-0004`):

```markdown
## D-0004 — TypeScript strictness beyond `strict`

**Context.** The port's safety argument is that the test suite is the specification. That argument
weakens wherever the type system quietly asserts something the runtime does not guarantee. [...]

**Decision.** `strict: true`, plus **`noUncheckedIndexedAccess`** and
**`exactOptionalPropertyTypes`** (neither is implied by `strict`) [...]

**Alternatives.** `strict` alone (rejected: `rows[0]` types as non-optional when the array may be
empty [...]).

**Consequences.** Indexed reads must be narrowed or defaulted at the call site [...]

**Status.** accepted

**Source.** Codex design review 2026-08-22, Major 4; interlock#74 refinement comment.
```

## 3. Verifying

```bash
npm ci --ignore-scripts   # --ignore-scripts is load-bearing, not hardening (D-0009)
npm run verify            # lint, knip, typecheck, smoke:native, test, parity, inventory
npm run check:package     # build, then publint and attw -- NOT part of verify, and gating
```

`npm run verify` is most of the merge gate, and it is not all of it: it runs the suite **once**, on
your platform only, and it does not run `publint` or `attw`. The mapping to
[`.github/workflows/tests.yml`](./.github/workflows/tests.yml):

| local | CI job |
|---|---|
| `npm test`, twice at two `CONTINUO_TEST_SEED` values | `double-green` (ubuntu + windows × node 22 + 24) |
| `npm run lint` | `lint` |
| `npm run knip` (in `verify`), `npm run check:package` | `package` |
| `npm run parity`, `npm run inventory` | `parity` |

So green locally is weaker evidence than green in CI in three specific ways: one order instead of
two, one platform instead of four cells, and no packaging check unless you ran `check:package`.

**`ci-gate` is the only required check.** It aggregates the four jobs, runs with `always()` because
GitHub reports a *skipped* required check as success, and allow-lists `success` only (`D-0005`,
[`docs/ci-merge-gate.md`](./docs/ci-merge-gate.md)). Do not rename it: the default-branch ruleset
references that literal name and lives outside this repository's diff.

**Double-green** means, within each required cell: the suite runs **twice, in two independent
processes, at two distinct explicit seeds**, and both must pass (`D-0005`). Randomization lives in
`vitest.config.ts`, never on a command line — a CLI flag can be dropped by an edit without turning
anything red. `retry: 0` is not negotiable. Locally, run twice with different
`CONTINUO_TEST_SEED` values to reproduce it; the seed is a hard error under `CI` and printed on
success either way.

**Green is not enough when you add or change a check.** "Each of these has been observed failing; a
check never seen red is not a check" (`docs/test-translation-conventions.md`, twice). If your change
introduces or modifies a check, show it catching what it claims to catch — an anti-vacuity assertion
in the suite, or the observed-red evidence in the PR body. Existing work does both; see `#87`'s
scan that asserts it comes back non-empty over a file that really does violate the rule.

Two platform rules that only fail in CI: **output is ASCII-only** (`D-0006`,
[`docs/cli-output-policy.md`](./docs/cli-output-policy.md)) — Windows is a required cell precisely
because that is where a cp932 console observes it; and **Node must be 22.14+ or 24** (`D-0003`).

## 4. Files that are records, not code

- **`parity/*.ledger.json`** — one entry per collected source node id, with a `disposition`
  (`ported` / `adapted` / `not-ported` / `waived`). `waived` means *translated weaker than the
  source* and requires an approved waiver; there are none. Recorded totals must reconcile **exactly**
  with the entries, so a baseline cannot be quietly re-based in the same edit that removes coverage
  (`docs/test-translation-conventions.md` §"What the check enforces").
- **`parity/source-inventory/`** — node id snapshots taken from interlock at `65f36c5`. Every
  non-empty line is read as a node id: no comments, no notes, no blank lines. It is deliberately
  larger than what continuo has agreed to port — being listed is evidence a case exists, not a
  commitment to port it (`parity/source-inventory.belts.md`).
- **`DECISIONS.md`** entries — append, never rewrite (§2).

Never edit any of these to make a check pass. If a check is red against a record, either the code is
wrong or the record needs a decision — both are reportable, neither is a silent edit.

## 5. Reading an issue

Issues carry up to three headings, and they mean specific things:

- **`## Acceptance criteria`** — the checklist your PR is graded against. Some items are literal
  commands with expected output; run them.
- **`## Implementation constraints`** — what you may *not* do, usually because a mechanical shortcut
  would produce a wrong-but-green result.
- **`## Open decisions`** — **do not start this issue.** A judgment is unmade and it is not the
  implementer's to make; the section names who decides, what, and why it cannot be inferred. The
  label `needs-decision` marks the same thing: *"Has unresolved Open decisions; do not start -- the
  decision is not the implementer's to make."* `ready-to-start` marks the opposite.

## 6. Scope

**One issue, one PR.** `#80`'s acceptance criteria put it as "submitted as its own PR/change at the
human gate [...] not folded into unrelated belt work", citing `D-0036`, which requires the pass it
governs to be "proposed as its own change, at the human gate". If you find work the issue does not cover — even
obviously correct work — **do not widen the change**. Write what you found in the issue (or a new
one) and stop at the issue's boundary. Deliberate omissions belong in the PR body (§7).

## 7. PRs: review and merge happen here

External implementers open the PR and stop there. **Review and merge are done by the organization
that owns this repository**; do not merge your own PR. The PR body must let a reviewer read the
scope without reconstructing it, so state:

1. **Which Acceptance criteria the PR satisfies** (and any it does not, with why).
2. **What you deliberately did not do** — the range you judged out of scope, and the reason. This is
   an established section here; see `#87`'s "Also deliberately absent, per `D-0046` rule 4: [...]".
3. **Every judgment call you made and why** — what you chose, and what you rejected.
4. **Verification** — the `npm run verify` result, as `#87` does.

If you widened scope anyway, say so explicitly and give the reason. Widening silently is the one
failure mode this section exists to prevent.

## 8. Language

**Issues, PR titles and bodies, and commit messages are English** — as is every one of them in the
current history, and the source tree's comments and prose with them. The merged commit title is the PR title (squash merge, with `(#NN)`
appended). Some commits carry a `type(continuo):` prefix and many do not — it is not enforced, so
match the imperative-summary style of `git log` rather than a convention it does not have.
