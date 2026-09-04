# Inverting the fence-altering flag check into an allowlist

**Status: propose-only.** Nothing under `src/` changes with this document and no entry is written to
[`DECISIONS.md`](../../DECISIONS.md); the draft entry is in section 8 of this file, for a human to
accept, amend or reject. Issue: continuo#149, which is the door continuo#133 opened and `D-0086`
narrowed without closing.

`D-0086` refuses a named list of twenty-four flags, and states its own limit in as many words:

> a denylist over an option surface this repository does not own cannot be shown complete, and
> **every** review pass so far has found the next thing it was missing -- six for six, with no sign
> of the sequence terminating.

This note works out what the inversion actually costs, because the proposal in #149 is one sentence
("allow only what the lap needs") and every part of the cost is in the parts that sentence does not
say: what the list holds, who may widen it, what happens to the twenty-four names, and where in the
lap the refusing has to happen for it to be a refusal rather than a rollback.

---

## 1. What the dogfood laps actually passed, measured

#149 says the initial list "may be empty or near-empty" and marks that as an assumption. It is
checkable, and this is the check. Source:
[`docs/operations/lap-1-dogfood.md`](../operations/lap-1-dogfood.md), which records eight runs across
three laps, each with its `--cli-arg` column and, for two of them, the `record.json` the child was
actually spawned with.

| Lap | Run | Operator `cli_args` | Evidence |
|---|---|---|---|
| 1 (`2d0684b`) | `lap1-dogfood-001` | none | §8 table |
| 1 (`2d0684b`) | `lap1-dogfood-002` | none | §8 table |
| 1 (`2d0684b`) | `lap1-dogfood-003` | `--allowedTools`, `Edit,Write,Bash(git add:*),Bash(git commit:*),Bash(git status:*),Bash(git diff:*)` | §3, the two `--cli-arg` lines |
| 2 (`5a6d75d`) | `lap1-dogfood-004` | none | §9 table |
| 2 (`5a6d75d`) | `lap1-dogfood-005` | none | §9 table (locally modified build; cited for its transcript only) |
| 2 (`5a6d75d`) | `lap1-dogfood-006` | none | §9.2, and `record.json` quoted in full |
| 3 (`aa87f35`) | `lap1-dogfood-007` | none | §10 table, and `record.json` quoted in full |
| 3 (`aa87f35`) | `lap1-dogfood-008` | none | §10 table |

**One run out of eight passed anything, and it passed two argv elements.** Run 003's
`--allowedTools` is named in §3 as "**the workaround for F-2**, not something this verb should
need", and §9.2's own headline is that the lap was re-run "without the lap 1 workaround". The
defects it worked around are closed: F-2 by `D-0081`/#120 (a non-interactive spawn renders
`acceptEdits`), F-8's write half by `D-0082` (the sandbox is told where the worktree's git writes
land). Run 007's `record.json` is the direct confirmation -- its `cli_args` is

```json
["--settings", ".../artifacts/lap1-dogfood-007/settings.local.json",
 "--permission-mode", "acceptEdits", "--setting-sources", "",
 "--mcp-config", ".../artifacts/lap1-dogfood-007/mcp.json", "--strict-mcp-config"]
```

-- the fence's own flags and nothing else, on the lap that reached a commit and a closed gate.

**Two things this measurement settles, and one it does not.**

1. The lap-1 allowlist is **empty**. Not "near-empty": the single historical argument was a
   workaround for fence defects that are now fixed, and the lap that passed nothing is the lap that
   reached a commit.
2. The one thing ever passed is on `FENCE_ALTERING_FLAGS`. So the escape hatch is not hypothetical
   -- the only historical use of `cli_args` is exactly the kind of use an allowlist has to have an
   answer for, and "nobody will ever need one" is not available as an argument.
3. It does not settle lap 2. Eight runs of one lap shape is the whole evidence base; a later lap that
   needs an argument is the thing the escape hatch exists for, and section 4 is about making that a
   reviewed change rather than a per-run one.

---

## 2. What `cli_args` is, mechanically, before any policy is chosen

Three facts about the current code decide most of section 5, and each is easy to state wrongly.

**a. The record is validated by a constructor, and that constructor runs twice in the life of a
run.** `LapRunIntent`'s constructor
([`src/control_plane/lap_run_intent.ts:552`](../../src/control_plane/lap_run_intent.ts)) is where the
shape rules, the bare `--` refusal and both flag lists are applied. It runs at `run admit`, and it
runs **again** at `lap perform`: `readLapRunIntent`
([`src/control_plane/run_admission.ts:483`](../../src/control_plane/run_admission.ts)) rebuilds the
intent out of the `run_delegation_recorded` payload, and
[`src/lap/root.ts:979`](../../src/lap/root.ts) calls it as step 1, before the preflight and before any
durable write. So "the constructor" is one rule applied at two moments, not one checkpoint.

**b. The materialiser is a separate, narrower check.** `requireCliArgs`
([`src/workspace/materializer.ts:622`](../../src/workspace/materializer.ts), called at line 919) knows
only `FENCE_OWNED_FLAGS` -- imported from `lap_run_intent.ts`, not copied -- and runs in the
validation block, before the branch and the worktree exist. It is the last line of defence
`D-0086` describes: "a run admitted by an older build, or a `run_delegation_recorded` payload edited
by hand, reaches the materialiser without having passed the constructor".

**c. The argv the child actually gets is
`claude -p <prompt> --output-format ... --verbose <base> <operator args> <fence flags>`.** The
operator's elements are placed first by
[`src/workspace/materializer.ts:1409`](../../src/workspace/materializer.ts) so that a last-wins parser
leaves the fence the survivor; the provider concatenates them after its own
([`src/session/claude_cli_provider.ts:1761`](../../src/session/claude_cli_provider.ts)). Two
consequences for an allowlist:

- **Elements are not all flags.** Run 003's second element, `Edit,Write,Bash(git add:*),...`, is a
  *value*. A list of permitted flag *names* answers nothing about it, and a value with no flag in
  front of it is a bare positional argument to a CLI that already has `-p <prompt>` -- a second
  prompt, or an error, depending on a parser continuo does not own.
- **A flag's arity is the CLI's property, not continuo's.** Deciding "`--allowedTools` takes one
  value" is modelling somebody else's option grammar, which is the precise activity `D-0086` says
  cannot be shown correct.

There is also a **third** flag list, disjoint from both: `PROVIDER_OWNED_FLAGS`
([`src/session/claude_cli_provider.ts:232`](../../src/session/claude_cli_provider.ts)) -- `-p`,
`--resume`, `--session-id`, `--output-format` and friends, about session identity and output format.
It is out of scope here and stays exactly as it is; it is named so that a reader counting lists gets
three and not two.

---

## 3. Point one: what the lap-1 allowlist contains, and what an entry is

**Contents: nothing.** Section 1 measured it. The shipped `roles.json` authorises no `cli_args` for
any role, so `continuo run admit --cli-arg ...` refuses every argument until somebody edits a
reviewed document.

That makes the *shape* of an entry the only real question, and it has to be settled now even though
the list is empty, because the shape is what the escape hatch in section 4 authors.

**The proposal: an entry is a complete `cli_args` vector, not a flag name and not a fragment.** A
role's `cli_args_allow` is a list of whole argument lists, and a submitted `cli_args` is admitted
only if it is **equal, element by element and in order, to one of them**. A role authorising
`[["--allowedTools", "Edit,Write"]]` admits exactly that two-element list and nothing else -- not
`["--allowedTools", "Edit,Write", "--allowedTools", "Bash"]`, and not the same two elements in the
company of anything.

**The empty `cli_args` is authorised unconditionally, by a rule and not by an entry.** Exact matching
against an empty list of vectors would match nothing at all, including the no-argument run every lap
has ever performed, so "the allowlist is empty" has to be spelled out rather than inferred: a
`cli_args` of length zero is the *absence* of operator arguments, not an argument, and it is admitted
for every role whether or not the document mentions that role. Written as an entry (`[[]]` on each
role) it would be a line an author could delete, turning a documentation edit into a lap that cannot
run at all. Section 1's measurement is therefore the statement that **no role's `cli_args_allow` is
present**, and lap 1 runs entirely on the unconditional rule.

Why a whole vector rather than a fragment matched against a window:

- **Fragments compose, and the composition is not what anybody reviewed.** Two authorised fragments
  can be concatenated, reordered and repeated by an operator, and CLI options interact -- one can
  override another, and this design rests on refusing to model which. Window matching would let a
  reviewer's two individually reasonable entries produce an argv nobody looked at. Whole vectors
  have no composition rule to get wrong, because there is no composition.
- **It never models the CLI's option grammar.** The comparison is string equality over literals
  continuo's own document holds, which is a property continuo owns completely. Arity, attached-value
  forms (`--flag=value`), camelCase-versus-kebab spellings and short-flag bundling all stop being
  questions, because none of them can produce a different byte sequence that still matches.
- **It makes the reviewer's job concrete.** "May this role pass `--allowedTools`?" is unanswerable
  without the value; "may this role run with exactly `--allowedTools Edit,Write` and nothing else?"
  is a question a person can answer by reading it.
- **It fails closed on the thing a name-based list gets wrong.** Under a name list, authorising
  `--allowedTools` authorises `--allowedTools Bash`, `--allowedTools '*'` and
  `--allowedTools=$(anything)`. Under a vector list it authorises exactly what is written.

The cost is combinatorial: a role that legitimately needs two independent arguments must author
every combination it will use, and a legitimately variable value (a path, a branch) cannot be
authorised without authorising each spelling of it. That cost is not being paid today by anybody --
the list is empty -- and it is deliberately steep, because the alternatives are a pattern language
for values (a parser continuo would then own and have to defend, which is the trade `D-0086` lost)
or a composition rule (the hazard above). A role whose vector list starts growing combinatorially is
a role whose arguments belong in the rendered fence instead (section 4.2's "apply" shape), and the
growth is the signal that says so.

**The `--` check stays where it is, and is not an allowlist entry.** A bare `--` is not a flag and a
list of flag names structurally cannot hold it (`D-0086`). Under an empty allowlist it is refused
anyway, along with everything else -- but the explicit refusal at
[`lap_run_intent.ts:592`](../../src/control_plane/lap_run_intent.ts) is a statement about **argv
structure**, true regardless of policy and regardless of which role is running, and deleting it would
make the fence depend on the allowlist being empty. It costs four lines and it is the check that
survives a future non-empty list.

---

## 4. Point two: the escape hatch, owned by the role document

The requirement from #149: widening the list must be "a reviewed change and not a per-run decision".
That is two properties -- the authorisation lives in a document, and editing that document is
noticed -- and continuo already has machinery for the second.

### 4.1 Where the key can physically go

`src/fencing/roles.json` is a document **carried verbatim from interlock** and pinned by SHA-256 in
[`test/contract/carried-documents.test.ts:65`](../../test/contract/carried-documents.test.ts). It
already carries one recorded deviation (`D-0083`'s `Edit(~/.claude/settings.json)`), so deviating is
an established move with an established cost: the digest, the byte count and a written reason must be
updated in the same commit, or CI is red.

Three candidate locations, and the difference between them is measured rather than aesthetic.

**E1 -- a key on the role body**, e.g. `roles.worker.cli_args_allow`. Viable, with a caveat that had
to be read to find. `stripMeta` ([`src/fencing/renderer.ts:1295`](../../src/fencing/renderer.ts))
keeps every key that is not in `META_KEYS` or `DISCARDED_ROLE_KEYS`, so the key stays on `rendered`
and passes through `substitute` and `checkPlaceholders` -- a value containing `{a_word}` would be
substituted or would raise a placeholder refusal. It does **not** reach the child's
`settings.local.json`: `settingsPayload` ([`renderer.ts:1389`](../../src/fencing/renderer.ts)) copies
only `permissions`, `sandbox`, `hooks` and `env` beside `permissionMode`. Making the key properly
inert means adding it to `META_KEYS`, which is a behavioural change to a module ported faithfully
from interlock and pinned by ported tests -- the same file records that one line's worth of
divergence there "was the sole cause of all 187 reason-code divergences" in an 800-document
differential fuzz. That is a deviation needing its own decision, on top of this one.

**E2 -- a top-level key, sibling to `roles` and `global`**, e.g.
`{"cli_args_allow": {"worker": [["--allowedTools", "Edit,Write"]]}}`. `renderFence` reads
`doc.roles[role]` and `doc.global` and nothing else, so a fourth top-level key is invisible to the
renderer: no substitution, no placeholder scan, no settings key, no ported code touched at all. The
only artifact that changes is `roles.json`'s bytes.

**E3 -- a separate continuo-owned document.** No deviation on the carried file, and no permanent
divergence to re-apply if interlock is ever re-synced. It costs the property that makes E1 and E2
work: the digest pin. A new file has no pin, so editing it is a normal edit, and "reviewed change"
degrades to "somebody hopefully looked at the diff". It also splits the answer to "what fences this
role?" across two files.

**Recommendation: E2**, with one addition, because the digest pin on its own does less than it
looks like it does.

*What the pin actually enforces.* `carried-documents.test.ts` compares `bytes` and `sha256` and
nothing else; `deviations` is free-form metadata that no assertion reads. So an author adding an
allowlist entry is forced to make a second, deliberate edit in the same commit -- the test's own
failure message tells them to update the digest, the byte count and the revision -- but **nothing in
CI makes them write the reason down**. "Reviewed change" rests on the digest bump being conspicuous
in a diff, which is real, and not on an enforced record, which the current test does not provide.
That is worth stating plainly rather than letting the recommendation borrow strength it does not
have.

*The addition that closes it.* A test in `test/contract/` asserting that **every vector in
`cli_args_allow` appears verbatim in that document's `deviations` list**. It is mechanical (both
sides are literal strings in files this repository owns), it fails closed (an authorised vector with
no written reason is red), and it turns "somebody should explain this" into a check. It also gives
the corpus in section 6 the thing it needs -- a place where every authorised vector is enumerated.

With that addition E2 is the recommendation, and it gets there without touching a single line of
ported rendering code, which E1 does not.

The cost of E2, stated so it is not discovered later: continuo's `roles.json` diverges further from
interlock's, and the `deviations` list is where that debt is tracked. It already has one entry; this
adds the mechanism for a second class of them.

### 4.2 Permit, or apply?

There is a shape #149 does not name and a human should see, because it is stronger.

**H0 -- the role document carries the arguments and the fence renders them**, and `cli_args` from the
operator is refused outright with no hatch at all. The operator door closes completely; a legitimate
argument becomes part of the rendered fence, reviewed exactly as the fence is.

It is genuinely better on the safety axis, and it is rejected here for a reason that is about the
record rather than about safety: `D-0055` makes the admitted intent the durable statement of what a
run was asked to do, and `cli_args` is a field of it. Under H0 the child's argv would carry arguments
that no `run_delegation_recorded` payload mentions, read out of a document at spawn time -- the run
record would stop being a complete answer to "what did this run run", which is the property the
readback check at [`run_admission.ts:534`](../../src/control_plane/run_admission.ts) exists to
protect. Under the permit shape, an authorised argument is still typed by the operator, still lands
in the intent, and is still quoted back in every report.

H0 stays on the decision table as a real option, not a strawman.

---

## 5. Point four (taken before point three, because point three depends on it): where the check runs

Two rules look at `cli_args` today -- the record's constructor and the materialiser's own check --
and the constructor's runs at two separate moments. The question is which of them learns the
allowlist, and it has to be answered before section 6, because "is `FENCE_ALTERING_FLAGS` still
enforcement?" is a question about checkpoints. The answer adds a site the current code does not have,
for the reason 5.3 gives.

### 5.1 Not in the constructor

The allowlist is **role-scoped**: the answer depends on which role's document authorised what. The
constructor could load the document -- it holds `role` -- and it should not, for a reason continuo
already decided once. `UnknownRoleRefused`
([`run_admission.ts:184`](../../src/control_plane/run_admission.ts)) records it: `LapRunIntent` holds
`role` "to no more than a *shape* check, not the roster -- the roster is `src/fencing/roles.json`'s
... and a shape check has no business owning a second copy of it" (continuo#126). The allowlist is
the same kind of fact as the roster: it lives in the fence document and it changes when that document
changes.

There is also a concrete failure mode. `readLapRunIntent` reconstructs the intent through the
constructor, so a role-document-aware constructor would make an **already admitted** run
unconstructible the moment its authorising entry is removed -- and unconstructible means
`RunNotAdmitted`, which is not only "the lap will not run" but "the run cannot be read back", by
`lap perform` or by anything else. Fail-closed in the direction that matters, and also fail-closed
across reporting and closing a run that was legitimately admitted.

**`FENCE_OWNED_FLAGS` stays in the constructor; only `FENCE_ALTERING_FLAGS` leaves.** The two are
different in exactly the way that matters here: the owned list is *this build's own output*, closed
by construction and role-independent, so refusing it is a fact about the record's shape and needs no
document. Moving it out would let a `cli_args` restating `--settings` pass admission and the
preflight and be refused only at the materialiser -- the late refusal this section exists to avoid.

So the constructor keeps: the string rule, the control-character rule, the bare `--`, and
`FENCE_OWNED_FLAGS`. It loses `FENCE_ALTERING_FLAGS` and gains nothing.

### 5.2 In `admitRun`, beside the roster check

`admitRun` already reads the fence document for the roster, before the transaction opens
([`run_admission.ts:307`](../../src/control_plane/run_admission.ts)). The allowlist check goes there,
for the reason the comment there already gives: it is checked "against the same roster the fence
renderer checks ... rather than a copy of it, so admission and render cannot drift apart". One
document, one read, one refusal, before anything is written.

The refusal names the role and the document, because an operator who is refused needs to know where
the answer is authored, not merely that there was one.

### 5.3 In the lap's preflight, and **not** first met at the materialiser

The document can be narrowed *after* a run is admitted, so `lap perform` has to re-ask rather than
trust admission. The place it asks is the preflight
([`src/lap/root.ts:487`](../../src/lap/root.ts)), whose docstring is already exactly this: "everything
this lap can refuse, refused before anything irreversible". The allowlist check goes **first** in it,
before `requireCompletion` -- the rest of the preflight has side effects of its own (it creates the
provider state root, and the spawn probe writes evidence into it), and a policy refusal that fires
after those has made directories for a run it was about to refuse.

**Leaving this to the materialiser would be too late, and that is a measured ordering rather than a
preference.** `performLap` takes the delivery lease at step 1b, *before* it materialises anything:
`holdDeliveryLease` writes the lease row and consumes an epoch, and `outbox-delivery` is one global
resource (`D-0053` rule 4), so a run that will be refused would first take a resource away from
whichever lap could have used it. "Before anything irreversible" has to mean before the lease, and
the lease is before the worktree.

### 5.4 And in the materialiser, which is still the point of the materialiser

`requireCliArgs` learns the allowlist as well. Its whole purpose is a run that reaches the spawn
without having passed the checks above -- an older build, a hand-edited payload, or a caller that
reaches `materializeWorkspace` directly rather than through `performLap` -- and after this change the
class of thing the earlier checks refuse is much larger, so leaving the materialiser at
`FENCE_OWNED_FLAGS` would leave the new refusal with exactly the gap `D-0086` built the old one to
cover.

One placement detail, or the check lands in the wrong place *inside* the materialiser: the fence is
rendered at [`materializer.ts:1271`](../../src/workspace/materializer.ts), **after** the branch and
the worktree are created at step 3. The allowlist read must happen in the validation block at line
919, where `requireCliArgs` already is, loading the document directly through `loadDocument`
([`renderer.ts:303`](../../src/fencing/renderer.ts)) -- exactly as `admitRun` does with `roleNames`.
A refusal after a worktree exists is strictly worse for the operator and no safer, which is the
argument `D-0086` already made for not teaching the *render* the concept.

Reading the document more than once means the reads can disagree if it changed in between. The later
read wins, and that is the correct direction: a role document narrowed after admission narrows a
pending run.

**The resulting map**, which is one rule at four moments:

| Moment | Check | Before what |
|---|---|---|
| `run admit` | shape + bare `--` + `FENCE_OWNED_FLAGS` (constructor), then allowlist (`admitRun`) | the run row and both events |
| `lap perform`, step 1 | shape + bare `--` + `FENCE_OWNED_FLAGS` (constructor, via `readLapRunIntent`) | the preflight |
| `lap perform`, step 1a | allowlist, first in `preflight` | the state root, the probe, **the delivery lease** |
| `lap perform`, materialise | allowlist (`requireCliArgs`) | the branch, the worktree, the fence |

---

## 6. Point three: what becomes of `FENCE_ALTERING_FLAGS`

Under an allowlist the twenty-four names refuse nothing that the empty list does not already refuse.
The question is whether the constant survives, and the honest hazard is the one `D-0086` itself
names about `FENCE_OWNED_FLAGS`: a list that "reads like the list of dangerous flags, and it is not".
A second exported constant that no longer enforces anything is that trap rebuilt.

**Proposal: the names move to a test fixture; the prose stays in `D-0086`.**

- **The prose** -- why `--bare` matters, why `--cloud` is a different kind of hole, why `-w` needs the
  attached-value spelling -- is already written down permanently. `DECISIONS.md` is append-only, and
  `D-0086` is the record of six review passes finding six different kinds of gap. Nothing needs to be
  copied anywhere for it to survive; `D-0087` points at it.
- **The names** become a corpus in `test/control_plane/`, not an export from `src/`, and the case it
  drives **reads the document rather than submitting arguments**. Submitting each flag on its own and
  asserting refusal is the obvious shape and it is close to vacuous: if a role authorised
  `["--dangerously-skip-permissions", "--foo"]`, submitting the bare flag would still be refused under
  exact whole-vector matching and CI would stay green over a document that had just re-opened the
  largest hole `D-0086` names. The case that catches that scans **every vector in every role's
  `cli_args_allow`** for a corpus member and fails naming the role, the vector and the flag.
  `AGENTS.md`'s "green is not enough" rule applies directly -- this is a new check, so it ships with
  an anti-vacuity fixture: a document that *does* authorise a corpus flag, over which the scan is
  observed red.
- The four *admitted* flags `D-0086` asserts on purpose (`--restricted`, `--disable-slash-commands`,
  `--permission-prompts`, `--tmux`) **invert**: under an allowlist they are refused like everything
  else, and the cases that assert they are admitted must be deleted rather than left to fail. That
  deletion is a visible, deliberate loss -- a child that would have been *safer* than the admitted one
  is now refused too -- and it is the price of a rule that does not read the CLI's mind.

**Does the corpus bar the escape hatch, or only inform it?** A tempting rule: an entry whose first
element matches the corpus is refused, so the hatch can never authorise `--dangerously-skip-permissions`.
It is tempting and it is wrong for lap 1, because the single argument the dogfood ever needed
(`--allowedTools`) is on the corpus -- a bar would make the hatch useless for the only case ever
observed. Recommendation: the corpus **informs** review (a hatch entry naming one of the twenty-four
is a change that has to argue for itself in the deviations reason) and does not bar it. This is the
residual risk of the whole design and section 7 states it as such.

---

## 7. What this does not close

- **The escape hatch is the door, moved.** An allowlist does not remove the ability to run a child
  with a widened fence; it moves the decision from a command line into a digest-pinned document. The
  security claim is exactly that and no more: **per-run** widening becomes impossible, **reviewed**
  widening stays possible. Anyone with commit access and a green CI can still author it.
- **An authorised vector authorises its value forever.** `["--allowedTools", "Edit,Write"]` on a
  role is not scoped to a run, a repository or a date. Nothing here proposes an expiry.
- **`PROVIDER_OWNED_FLAGS` is untouched**, and the provider's own `base_cli_args` path
  ([`claude_cli_provider.ts:1216`](../../src/session/claude_cli_provider.ts)) is a different door with
  a different guard. This design says nothing about it.
- **The measurement is eight runs of one lap shape.** If lap 2 needs arguments routinely, the empty
  list will be widened repeatedly and the review gate becomes the thing under strain rather than the
  refusal. That is the falsifier in section 8.
- **`--cli-arg` becomes a flag that refuses everything under the shipped document.** That is an
  operator-visible contract change and needs the help text
  ([`run_cli.ts:109`](../../src/control_plane/run_cli.ts)) rewritten to say so, plus `lap-1-dogfood.md`
  §3's command annotated -- its `--cli-arg` lines would no longer admit even as a workaround. Removing
  the flag instead is rejected: an escape-hatch-authorised argument has to be passable.

---

## 8. Draft `DECISIONS.md` entry

Not written to `DECISIONS.md` by this change. `D-0087` is the next free ID in the control-plane range
(`D-0019`..`D-0099`) as of `9212f2b`; it also needs a row in the index table at the top of that file.

```markdown
## D-0087 -- An admitted run may pass only what a role document authorised: the cli_args check is an allowlist

**Context.** `D-0086` refuses twenty-four named flags, and states its own limit: a denylist over an
option surface this repository does not own cannot be shown complete. Six review passes found six
different gaps, three of them different *kinds* of gap, with no sign of the sequence terminating
(#149). The complementary question is bounded: `docs/operations/lap-1-dogfood.md` records eight runs
across three laps, and exactly one passed operator `cli_args` -- run 003's `--allowedTools`, named in
§3 as the workaround for F-2, a defect `D-0081`/#120 closed. Run 007's `record.json` carries the
fence's own flags and nothing else, and run 007 is the lap that reached a commit and a closed gate.

**Decision.** An admitted run's `cli_args` must be one of the complete argument vectors a role
document authorises, and everything else is refused. Four parts:

1. **The allowlist is per-role and lives in `src/fencing/roles.json`** under a top-level
   `cli_args_allow` key, sibling to `roles` and `global`. `renderFence` reads neither, so the key is
   inert to the render and no ported module changes. `roles.json` is pinned by digest in
   `test/contract/carried-documents.test.ts`, so widening the list cannot be a quiet edit: it is a red
   CI until the digest, the byte count and a written reason are updated together. That is the review
   gate, and it is the reason the list lives in this document rather than in a new one.
2. **An entry is a complete `cli_args` vector, and a submitted list must equal one of them exactly**
   -- `[["--allowedTools", "Edit,Write"]]` admits that two-element list and nothing else. Not a flag
   name, because a name plus an arity is a model of the CLI's option grammar, which is the thing
   `D-0086` established this repository cannot own. And not a fragment matched against a window,
   because fragments compose: two individually reviewed entries could be concatenated, reordered and
   repeated into an argv nobody reviewed, and CLI options interact in ways this decision rests on
   refusing to model. Whole vectors have no composition rule to get wrong. Attached-value forms,
   camelCase spellings and short-flag bundling stop being questions too, because none can produce a
   matching byte sequence.
3. **A `cli_args` of length zero is authorised unconditionally**, by a rule rather than by an entry:
   it is the absence of operator arguments, not an argument. Exact matching against an absent or
   empty entry list would otherwise refuse the no-argument run every lap has performed, and spelling
   it as an entry (`[[]]` per role) would make a deletable line load-bearing. **No role's
   `cli_args_allow` is present as shipped**, so the lap-1 rule is "no operator arguments at all" --
   the measurement above, not an aspiration.
4. **The check runs where the role document is already read, at every point before something
   irreversible**: in `admitRun` beside the roster check; first in `lap perform`'s preflight, which
   is before the delivery lease -- `holdDeliveryLease` writes a row and consumes an epoch on the one
   global `outbox-delivery` resource (`D-0053` rule 4), so a refusal after it has already taken a
   resource from a lap that could have used it; and in the materialiser's validation block, for a
   caller that reaches it without going through `performLap`. `LapRunIntent`'s constructor keeps the
   shape rules and the bare `--` refusal and gains nothing, for the reason `UnknownRoleRefused` gives
   about the roster -- a record's constructor owns shape, not policy read out of a mutable document.
   Concretely: the constructor also runs at `lap perform` via `readLapRunIntent`, so a
   document-aware constructor would make an already admitted run unreadable the moment its
   authorising entry was removed.

**What happens to `FENCE_ALTERING_FLAGS`.** It stops being enforcement and is removed from `src/`.
Its prose stays in `D-0086`, which is append-only and is the record of what six review passes found.
Its twenty-four names become a test corpus, and the case that corpus drives **reads the document
rather than submitting arguments**: it scans every vector in every role's `cli_args_allow` for a
corpus member and fails naming the role, the vector and the flag. Submitting each flag and asserting
refusal would be close to vacuous -- a role authorising `["--dangerously-skip-permissions", "--foo"]`
still refuses the bare flag under exact matching, so CI would stay green over a document that had
just re-opened the largest hole `D-0086` names. The corpus **informs** review of a hatch entry rather
than barring one, because `--allowedTools` is on it and is the only argument the dogfood ever
needed.

**This supersedes `D-0086`, and restates the half of it that survives.** `D-0086`'s central decision
was that the constructor refuses both lists; that stops being true here, so under `AGENTS.md`'s rule
it cannot stay `accepted` -- two accepted entries giving different answers to "what refuses
`cli_args`?" is the drift that rule exists to prevent. `D-0086` keeps its ID and gains
`Status: superseded by D-0087`, its index row is updated, and its text is otherwise untouched: it
remains the record of what six review passes found and the argument this entry is built on.

**The part of `D-0086` that survives, restated so this entry stands alone.** *Flags the fence
generates* and *flags that alter what the fence means* are still two concepts, and the first is still
enforced by name. `FENCE_OWNED_FLAGS` -- `--settings`, `--permission-mode`, `--mcp-config`,
`--setting-sources`, `--strict-mcp-config` -- stays in `src/control_plane/lap_run_intent.ts`, stays
refused by the constructor and by the materialiser's own check, and stays refused for its own reason:
the fence generates these, so a second one is a duplicate whose winner is a property of a CLI this
repository does not own. A denylist is sound *there* because the list is closed by construction --
it is this build's own output, not somebody else's option surface. The bare `--` refusal stays in the
constructor for the same kind of reason: it is a statement about argv structure, true whatever the
allowlist holds. What this entry replaces is only the second concept's enforcement.

**The four flags `D-0086` asserts are admitted** -- `--restricted`, `--disable-slash-commands`,
`--permission-prompts`, `--tmux` -- are now refused with everything else, and those cases are deleted
rather than left failing. A child safer than the one admission asked for is refused too. That is the
cost of a rule that does not read the CLI's mind, and it is recorded rather than absorbed.

**Alternatives.** *Keep the denylist and keep extending it* (rejected: `D-0086`'s own falsifier, six
for six). *Refuse `cli_args` entirely and let the role document carry arguments the fence renders*
(rejected, narrowly: it is safer, but the child's argv would then carry arguments no
`run_delegation_recorded` payload mentions, and `D-0055` makes that payload the complete statement of
what a run was asked to do). *A separate continuo-owned allowlist document* (rejected: no digest pin,
so "reviewed change" degrades to "somebody looked at the diff", and the answer to "what fences this
role?" splits across two files). *A key on the role body rather than a top-level one* (rejected:
`stripMeta` keeps unknown role keys, so the value would pass through placeholder substitution and
scanning; making it inert means editing `META_KEYS` in a module ported faithfully from interlock).
*The corpus bars the hatch* (rejected: it would bar the only argument ever needed).

**What records it.** Three checks, all new. (1) The allowlist's own cases at each of the three
enforcement points, including the unconditional empty-vector rule, which is the one a literal reading
of "must equal an entry" gets wrong. (2) The corpus scan over the document, described above. (3) A
`test/contract/` case asserting that **every vector in `cli_args_allow` appears verbatim in the
`deviations` list** for `roles.json` -- because `carried-documents.test.ts` compares only `bytes` and
`sha256`, and `deviations` is free-form metadata no assertion reads, so without it the digest pin
forces a deliberate second edit but not a written reason. Checks (2) and (3) are new checks under
`AGENTS.md`'s "green is not enough" rule and each ships with an anti-vacuity fixture: a document that
authorises a corpus flag, and one that authorises a vector no deviation mentions, both observed red.

**Consequences.** `continuo run admit --cli-arg X` refuses X under the shipped document, for every
role; the flag stays, because an authorised argument must be passable, and its help says so.
`docs/operations/lap-1-dogfood.md` §3's command no longer admits even as a workaround, and is
annotated. The refusal names the role and the document, so an operator is told where the answer is
authored. `roles.json` gains a second class of deviation from interlock's copy, tracked in the same
`deviations` list. `D-0086`'s `Status` line and its index row take the supersession edit -- the only
edit `AGENTS.md` permits to a standing entry -- and nothing else in it changes.

**Status.** proposed -- `docs/design/cli-args-allowlist.md` is the working; #149 is the human gate.

**Falsifier.** A lap that legitimately needs operator arguments often enough that the allowlist is
widened repeatedly. The review gate is a digest bump, which is cheap to perform and easy to wave
through; a document accumulating entries is this decision failing, and it fails quietly, because
every individual widening looks reasonable. The counting is the check: more than one or two entries
across all roles means the bounded question ("what does a lap need?") was not bounded after all.

**Source.** #149, on `D-0086`'s stated limit. The eight-run measurement is
`docs/operations/lap-1-dogfood.md` §3, §8, §9.2 and §10.1.
```

---

## 9. Decision table for the human gate

Each row is a question this design had to answer and that the gate can overturn independently.

| # | Open decision | Recommendation | Reason |
|---|---|---|---|
| D1 | What does the lap-1 allowlist contain? | **Empty, for every role** | Measured: one of eight dogfood runs passed anything, and it was a workaround for a fence defect `D-0081`/#120 closed. Run 007 reached a commit with the fence's flags and nothing else |
| D2 | What is an allowlist entry -- a flag name, a fragment, or a whole `cli_args` vector? | **A whole vector**, admitted only on element-by-element equality | A name plus an arity models the CLI's option grammar, the thing `D-0086` proved cannot be shown correct. A fragment is worse than it looks: fragments compose, so two reviewed entries can be concatenated and reordered into an argv nobody reviewed. Whole vectors also kill the `--flag=value` / camelCase / bundling spellings as a class |
| D3 | Where does the escape hatch live? | **A top-level `cli_args_allow` key in `src/fencing/roles.json`, plus a test tying each vector to a `deviations` entry** | The renderer reads only `roles` and `global`, so no ported code changes. The digest pin alone is weaker than it looks -- `carried-documents.test.ts` compares only `bytes` and `sha256`, and `deviations` is metadata nothing reads -- so it forces a deliberate second edit but not a written reason. The added test is what makes "reviewed, not per-run" enforced rather than hoped for |
| D4 | Permit an operator argument, or apply one from the document? | **Permit** | Applying is safer, but puts arguments in the child's argv that the `run_delegation_recorded` payload does not mention, and `D-0055` makes that payload the whole statement of what a run runs. Overturnable: if the gate values the closed door more than the complete record, H0 (§4.2) is the stronger design |
| D5 | Which module enforces the allowlist? | **`admitRun`, first in `lap perform`'s preflight, and the materialiser's validation block -- not the constructor, which keeps `FENCE_OWNED_FLAGS` and the bare `--`** | The preflight is load-bearing rather than belt-and-braces: `performLap` takes the one global delivery lease *before* it materialises, so a check first met at the materialiser lets a run that will be refused consume an epoch and a resource. The constructor is excluded from the *allowlist* only, because it also runs at `lap perform` -- teaching it a mutable document would make an admitted run *unreadable* once its entry was removed. The owned-flag list stays there: it is this build's own output, closed by construction and role-independent |
| D6 | What happens to `FENCE_ALTERING_FLAGS`? | **Delete from `src/`; the names become a corpus that scans the document, not one that submits arguments** | A non-enforcing exported list rebuilds the exact trap `D-0086` names. The scan direction is load-bearing: under exact whole-vector matching a submitted bare flag is refused even when the document authorises a vector containing it, so a submit-and-assert corpus would stay green over the widening it exists to catch |
| D7 | Does the corpus bar an escape-hatch entry, or inform review of one? | **Inform** | `--allowedTools` is on the corpus and is the only argument the dogfood ever needed; a bar makes the hatch useless for the only observed case. This is the residual risk, stated in §7 |
| D8 | Is `D-0086` superseded? | **Yes. `D-0087` supersedes it and restates the surviving owned-flag rule** | Its central decision -- the constructor refuses both lists -- stops being true, and `AGENTS.md` says a decision that stops being true gains `Status: superseded by D-XXXX`. Leaving it accepted would give a reader two accepted answers to "what refuses `cli_args`?". The price is that `D-0087` must restate `FENCE_OWNED_FLAGS` and the bare `--` rule so nothing is only recorded in a superseded entry, which it does |
| D9 | Does `--cli-arg` survive as a CLI flag? | **Yes, with rewritten help** | Removing it would make an authorised argument unpassable. The help must say the refusal is the default and that the role document is where the answer is authored |
| D10 | How is "no operator arguments" expressed? | **An unconditional rule: `cli_args` of length zero is always authorised** | Exact matching against an absent entry list matches nothing, so a literal implementation would refuse the no-argument run every lap has performed. Writing `[[]]` on each role instead makes a deletable line load-bearing -- a documentation tidy-up would stop every lap |
| D11 | Is the enforcement change one PR or several? | **One**, after this gate | The pieces are not independently shippable: deleting `FENCE_ALTERING_FLAGS` before the allowlist exists opens the door `D-0086` closed, and adding the allowlist while the denylist stands leaves two rules with one meaning |
