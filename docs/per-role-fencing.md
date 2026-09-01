# Per-role fencing

Authority: [`DECISIONS.md`](../DECISIONS.md) D-0200 series.
Lineage: interlock `D-0023` ("Gate item 3 is observed by a breach-probe battery, and fail-closed is
Interlock's own obligation") -- the observable *and* the fail-closed obligation are both that one
decision; interlock `D-0017` ("Workers are few, capped, and fenced per role") for why a fence is
per-role at all; interlock `D-0026` for why the implementations are throwaway and the tests are the
durable output; and interlock's own `docs/per-role-fencing.md`, which this document carries.

**Porting status.** The whole fencing subsystem is in continuo: `src/fencing/rules.ts`,
`renderer.ts`, `battery.ts`, `state.ts`, `spawn.ts`, `readback.ts`, the deny hook as `hook.mjs`
(a separate process, hence `.mjs` rather than `.ts` -- see `src/fencing/spawn.ts`), and the
transcribed matching primitives (`fnmatch.ts`, `shlex.ts`, `pypath.ts`, `pyjson.ts`, `pyregex.ts`,
`pyrepr.ts`, `pysemantics.ts`, `uescape.ts`). Sections 4 and 5 describe code continuo ships. The
parity ledgers under `parity/` are the authority on what is actually ported at any moment.

This is the carried design doc named by interlock#74. It restates interlock's own
`docs/per-role-fencing.md`, adjusted only where the runtime changes what is true. Where the two
documents would otherwise say the same thing, they do.

## 1. What a per-role fence is

A per-role fence is three layers rendered together, from one role document, into one settings
payload:

1. **Permission deny rules** -- the rules a CLI's own permission system enforces before a tool runs.
2. **Sandbox deny paths** -- filesystem paths the sandbox refuses regardless of what permissions say.
3. **A `PreToolUse` deny hook** -- an out-of-band backstop invoked before every tool call, independent
   of whatever the first two layers decided.

The renderer produces all three from a single role document in one pass. None of the three is a
fence by itself. A permission rule with no hook behind it is one absorbed exit code away from a
silent bypass (see section 4). A hook with no permission rules to match is enforcing nothing. A
sandbox path with neither is a wall around an empty room. Fencing means treating the three as one
object, because a role's actual exposure is whatever the weakest of the three permits, not whatever
the strongest of the three forbids.

## 2. Why the fence is a list of rules with stable ids

The renderer does not emit a blob of settings JSON and stop there. It emits a list of `Rule` values,
each carrying a stable `rule_id`, before it ever serialises anything to the wire format. The
settings payload is a rendering of that list, not the other way around.

This ordering is what makes the breach battery possible as anything other than a promise. Given the
rule list, `probesFor(fence)` can derive exactly one probe per rule and assert:

```ts
new Set(probesFor(fence).map((probe) => probe.ruleId))  ===  new Set(fence.ruleIds())
```

Coverage becomes a set equality the test suite checks on every run, not a claim in a comment that a
human wrote once and nobody re-verifies when a rule is added. Rendered JSON alone has no stable unit
to enumerate against -- a settings blob does not say how many rules went into it, so nothing can
assert that all of them were probed. A rule list does.

## 3. The breach battery

The battery is one forbidden operation **per rule**, not per role. A per-role battery would leave
almost every rule unobserved: a handful of roles carry dozens of rules between them, so a per-role
probe would exercise a handful of them and report success regardless.

The battery is **derived, never authored**. `probesFor` walks a fence's rules and synthesizes each
probe from the rule's own text -- the pattern the rule matches is the same pattern the probe
constructs an operation against. Nobody writes the probe list by hand, because a hand-written list
drifts the moment a rule is added and nobody remembers to extend it, and it goes on passing while it
drifts.

The self-check that follows from this: a battery that cannot prove itself complete is refused rather
than returned. If a rule's pattern cannot be turned into a concrete matching operation, that is
treated as a defect in the battery, not skipped silently -- a rule nothing can be probed against is a
rule nothing observes, which is indistinguishable from no rule at all.

## 4. Fail-closed, in both places

**The renderer refuses rather than rendering a partial fence.** A role document that names a
discarded configuration axis, a hook path the renderer cannot resolve, or a sandbox profile that
does not exist does not get a best-effort render with the broken part dropped. It is refused, and
the refusal is recorded. A fence rendered by dropping the part that could not be resolved is a fence
narrower than its author believed -- a downgrade wearing the clothes of a cleanup -- and the renderer
treats that as no fence at all.

**The deny hook denies on every malformed input it can be handed.** An unreadable fence file, a
malformed event, an unexpected exception mid-decision: every one of those paths routes to the same
deny, never to a permissive default and never to letting the process exit in a way that looks like
success. The hook's own module docstring records why this matters more than it looks: some exit
codes are absorbed by the calling CLI as though nothing happened (see section 5), so the hook's
obligation is not merely "return the right answer" but "never exit in a shape that reads as
success when the answer was actually a refusal to decide."

Fail-closed here is interlock's own obligation, independent of which CLI it runs under. It does not
depend on a provider promising to honour a deny; it is designed so that the worst a broken input can
do is still deny.

## 5. What this does not prove

No public surface reports a session's effective hooks or sandbox configuration back to the caller.
There is no readback that says "here is what actually loaded," only the settings payload the fence
was rendered into. So the battery cannot compare "the fence we meant to enforce" against "the fence
the provider is actually enforcing" -- that second value is not observable.

What the battery observes instead is behaviour against the fence **interlock rendered**: it runs
each derived probe, and the fence is expected to deny it. This proves that the rules, as rendered,
are internally coherent and that the hook's decision function denies exactly the operations the
rules say it should. It does not prove that the provider loaded those same rules into the running
session. The rendered-input diff used to check restart persistence (section 6) is the same kind of
evidence: it proves the bytes interlock wrote are the same bytes it wrote before, not that the
provider read them.

This is recorded in interlock as D-0023, and this document repeats it in the same terms rather than
softening it: substituting a behavioural breach-probe battery plus a diff of interlock's own rendered
inputs for a true effective-configuration comparison is a **deliberate weakening, accepted by a
human, not an equivalent method.** interlock#74 acceptance criterion 5 requires this limitation to
stay disclosed in the port and never be quietly "fixed" or dropped by treating the battery as if it
closed the gap. It does not. It narrows it.

## 6. The fail-closed spawn precondition and canary acceptance

interlock's fail-closed obligation extends past rendering: a broken configuration must refuse the
spawn itself, and the spawner callable must never be invoked on a refused configuration. This is not
optional wiring -- interlock#71's canary acceptance names it as an obligation on the production spawn
path, not only on a test harness that calls the precondition directly. A precondition that exists as
a function nobody's spawn code calls is not a precondition; it is dead code with the shape of one.

TypeScript has no interpreter-level import-time side effect that mirrors how a Python module wires
its call sites together, so the port has to choose an explicit representation. The intended one is a
dependency in the module graph: the production spawn path imports and calls the fencing precondition
directly, and a test asserts *that dependency exists* rather than only asserting the precondition's
own behaviour in isolation -- because a precondition tested only in isolation is exactly the dead
code with the shape of a precondition that interlock#71 is about.

**Landed.** `spawn.ts` is in continuo (`src/fencing/spawn.ts`), with interlock#74's acceptance
criterion 4 recorded alongside it and its cases in
`parity/fencing.spawn-precondition.ledger.json`. This section states a property the port has, not
merely an obligation it is carrying.

## 7. Language-specific notes for the TypeScript port

The renderer and battery depend on two CPython standard-library behaviours that TypeScript has no
built-in equivalent for: `fnmatch`-style pattern matching and `shlex`-style shell-command splitting
and quoting. Both are transcribed line-for-line from CPython's implementation into
`src/fencing/fnmatch.ts` and `src/fencing/shlex.ts`, and both are checked against Python's own output
on a fixed input corpus rather than trusted on inspection alone. See
[`docs/differential-oracle.md`](./differential-oracle.md) for how that class of transcription is
verified in this port, and the two files themselves for the corpora used.

A third CPython behaviour joins them, and it is the least obvious of the three: **path
normalisation**. `rules.py` compares paths through `posixpath.normpath` and `os.path.expanduser`,
and Node's `path.posix.normalize` is *not* the same function -- it keeps a trailing slash and
collapses a leading `//`. Since a sandbox deny rule fires on a path comparison, that difference moves
what the rule covers. `src/fencing/pypath.ts` transcribes both, and they are pinned by the same
vector. `D-0200` records the whole family, including the divergence the vector caught on its first
run.

The `PreToolUse` deny hook script runs on Node in this port. Interlock's Python hook is invoked as a
subprocess by path, and the TypeScript hook is invoked the same way, so the fail-closed obligations
in section 4 -- deny on unreadable input, deny on malformed events, deny on unexpected exceptions --
apply to the Node process exactly as they apply to the Python one.

**The deny hook must be the program the command runs.** Interlock decides whether a `PreToolUse`
command invokes the deny hook by testing whether the hook path appears *anywhere* in the command
string, which admits a command that merely mentions it -- `/bin/echo <hook_script> --role worker
--fence <fence_path>` renders a 17-rule fence there while the CLI runs `echo` and the hook never
executes. continuo refuses that: the hook script has to be `argv[1]`, with `argv[0]` equal to the
recorded interpreter. So a role document's hook command must read `{python} {hook_script} --role
<role> --fence {fence_path}` -- the form every shipped role already uses, and the only accepted
shape; anything else, a bare `{hook_script}` at `argv[0]` included, is refused with `hook-absent`.
Position alone is not the rule -- `true {hook_script} --fence ... --role ...` also puts the hook at
`argv[1]` -- so the launcher is compared, not just counted. A hook at `argv[0]` was accepted while
`D-0208` was being written, on the theory that an executable file with a shebang is run by the
kernel; it was dropped because it was a Windows hole. The shipped hook has no shebang and is not
executable, and `access(X_OK)` on Windows is only an existence check, so the render succeeded there
while `cmd` could not launch the hook at all -- an unfenced child with the spawn recorded as
admitted. `D-0208` records the divergence, the amendment and the measurements.

**Answered.** Which runtime resolves the hook command is one of the questions interlock#74 named
and interlock never answered; **continuo answers it** in `D-0208` above (`D-0036` -- interlock is
frozen and no answer is coming from it), and the hook ships as `hook.mjs` rather than `hook.ts`
because it is launched as a separate process. The renderer carries one consequence of that answer:
its check that a hook command's script token names an existing file recognises `.mjs`, `.js` and
`.cjs` in addition to interlock's `.sh` and `.py`, which is strictly more that must resolve, never
less.
