# Where the composition root goes

**Status: the placement note step 8 asks for**, written before the code it recommends. Its decision
is recorded as `DECISIONS.md` `D-0059`; this file is the working that produced it, kept because the
option that looks obvious is the one that quietly costs the most.

`docs/design/minimal-operating-loop.md` section 4.5 names the gap: `src/supervisor.ts` is imported by
`src/index.ts` and nothing else under `src/`, so a lap can be performed only by hand-writing a
TypeScript program. Step 8 closes it. The question this note answers is **which file is allowed to
know both a session backend and the control plane**, because the composition root is by definition
the file that knows both, and continuo has a test that forbids exactly that.

---

## The constraint, stated exactly

`test/gate_item11/no-provider-detail-leaks.test.ts` enforces three properties. Only the third binds
this step:

> **no shipped module knows both a provider and the control plane** -- nothing under `src/` may
> import both a session backend and `src/control_plane/`, except `src/index.ts`
> (`ALLOWED_BARRELS`, `D-1001`).

Two details of that test decide this note, and both are easy to misread:

1. **"a session backend" excludes the contract.** `knowsASessionBackend` is true for an import that
   reaches under `src/session/` **other than `src/session/provider.js`**. So a module may import
   `SessionProvider`, `SessionReadout`, `Ok`, `Failure` and `ProviderResult` alongside the whole
   control plane and be entirely legal. It is naming `ClaudeCliSessionProvider`, `stub_provider` or
   the `src/session/index.ts` barrel that is forbidden.
2. **The scan is per file and follows every import form** -- `import`, `import type`,
   `export ... from`, `require()` and dynamic `import()` (`test/testkit/ast.ts`). It resolves a
   relative specifier to a path but does **not** compute a transitive closure. What it measures is
   therefore precise: *which files a provider swap has to edit*.

The exit condition item 11 is graded on is that number. Any option below that raises it is a
weakening of the check whatever else it does.

---

## What the composition root actually needs

From the inputs step 8 is composed of:

| need | supplied by | vocabulary |
|---|---|---|
| open the database at head | `openProductionControlPlane` | control plane |
| read back what the run was admitted to do | the `run_delegation_recorded` payload | control plane |
| materialise the workspace and render the fence | `materializeWorkspace` | control plane (it appends an event) |
| run the lease-before-spawn walk | `SessionOrchestrator` | `src/session/provider.js` only -- the contract |
| start the child under the admitted fence | `MaterializedWorkspace.spawner.execute` | fencing |
| read the finished turn's report | `readTerminalReport` | **the concrete provider only** |
| turn that report into an event and a gate | `ingestTerminalReport` | control plane |

Every row but two is control-plane or contract-level and can live anywhere. The two that are not:

- **A `SessionProvider` instance has to be constructed by someone.** `SessionOrchestrator` takes one;
  it does not make one.
- **`readTerminalReport` is not on the contract.** It is declared on `ClaudeCliSessionProvider`
  (`D-0056`), and its `TerminalReportReadout` type is declared there too -- so even
  `import type { TerminalReportReadout }` would count as knowing a backend.

So the composition root splits cleanly into a **provider-agnostic half** (everything above, taking a
`SessionProvider` and a structurally-typed report reader as parameters) and **one line that names
the shipped default**. Only that line is constrained. `src/control_plane/report_ingress.ts` already
solved the second problem the same way and says so in as many words: `TerminalReportFact` is
"structurally the provider's `TerminalReport` ... declared here because this package may not import
that one."

---

## The options

### A. `src/lap/`, provider-agnostic, default reached through the package barrel -- **recommended**

`src/lap/root.ts` holds the order and imports the control plane plus `../session/provider.js`. It
takes the provider and the report reader as arguments, so it is legal under the rule as written.

`src/lap/cli.ts` declares the verb, opens the database, and needs the shipped default. It reaches it
as a **provider-neutral factory name re-exported by `src/index.ts`**:

```ts
import { createDefaultSessionProvider } from "../index.js";
```

The factory itself lives in `src/session/`, where naming a concrete provider is what the package is
for, and `src/index.ts` re-exports it as it re-exports everything else -- the barrel keeps its
character and gains no logic.

- **Leak test:** passes unchanged. `resolve("src/lap", "../index.js")` is `src/index.ts`, which is
  not under `src/session/`.
- **`ALLOWED_BARRELS`:** unchanged.
- **Provider swap cost:** unchanged at `src/session/*` plus `src/index.ts`'s session block.
  `src/lap/cli.ts` names an abstraction, not an implementation, so a swap does not edit it -- which
  is the property the test measures, and it is true here rather than merely unmeasured.
- **Cost:** a module under `src/` imports its own package barrel. That is a smell, and it is the
  price of the rule. It is bounded: one import, in the one file that is an entry point.

### B. Add the composition root to `ALLOWED_BARRELS`

`src/lap/cli.ts` imports `ClaudeCliSessionProvider` directly and is allowlisted beside
`src/index.ts`. Honest and readable; the allowlist would arguably be renamed from "barrels" to
"entry points", and `D-1001`'s rationale ("continuo ships one package entry point") does extend to
the `bin` in a way nobody has had to notice before.

**Rejected**, because the swap cost goes from one file to two and the step's own acceptance says the
leak test must still pass *without weakening it*. Growing the allowlist is the weakening, whatever
the entry is called. Recorded rather than dismissed: if a second composition root ever has to name a
provider for a reason A cannot serve, this is the shape to take, and it should be taken as its own
decision rather than folded into one about the lap.

### C. Put the whole root in `src/index.ts`

The file is already allowlisted, so nothing else moves.

**Rejected.** `src/index.ts` is 44 re-export blocks and no function declarations; it is a barrel and
its whole value is that reading it tells you the surface. A lap's order buried in it would be
invisible to anyone looking for the lap, and it would put the one file every consumer imports on the
critical path of a subsystem most consumers never call.

### D. Put the root in the CLI layer (`src/cli.ts`)

**Rejected on a fact rather than on taste.** `src/cli.ts` already imports `./control_plane/cli.js`
and `./control_plane/run_cli.js`, so it knows the control plane; adding a provider to it is exactly
the forbidden join, and it is not allowlisted. The same argument rules out any of the existing
`*/cli.ts` modules.

### E. Route around the scan

A one-hop indirection (`src/lap/provider.ts` importing the concrete provider, imported by
`src/lap/cli.ts`) passes the test because the scan is per file.

**Rejected, and named so nobody re-derives it as clever.** A swap would edit `src/lap/provider.ts`,
so the cost really would be two files while the test went on reporting one. A check that has been
routed around is worse than one that was widened on purpose: the widened one is reviewable.
Option A is not this -- there the swap genuinely does not touch `src/lap/`, because what
`src/lap/cli.ts` names is a factory whose name does not change when the implementation behind it
does.

---

## Recommendation

**Option A.** `src/lap/` holds the composition root; the order is provider-agnostic and takes the
provider and the report reader as parameters; the shipped default is chosen in `src/session/` and
reached by the verb through the package barrel. The leak test and `ALLOWED_BARRELS` are untouched,
and the number item 11 grades is unchanged.

**What would falsify it.** The `D-1001` falsifier already on the books -- a subpath-exports split
that let a provider swap avoid touching `src/index.ts` -- would also remove the barrel this option
reaches through, and the import in `src/lap/cli.ts` would have to move with it. And if a second
lap-shaped surface ever needs a *different* provider chosen at a place that is not `src/session/`,
option A cannot express it and option B is the recorded fallback.
