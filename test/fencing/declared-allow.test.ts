/**
 * `D-1110` -- the admitting side's declaration of what a child may run.
 *
 * No parity ledger claims this file. The declaration has no counterpart in
 * interlock: the source's renderer takes a role and a context and nothing else,
 * so every case here is target-only and each names what would be silently wrong
 * without it (`docs/test-translation-conventions.md` rule 10).
 *
 * The file is organised around the two halves of the claim the entry makes: a
 * declaration reaches the allow list the child's CLI reads, and it reaches
 * **nothing else**. The second half is the one that matters -- an allow entry
 * that could suppress a deny rule, a sandbox path or a hook decision would make
 * the declaration a bypass, which is what rondo `D-0011` rule 3 refuses to hand
 * a host.
 */

import { describe, expect, test } from "vitest";

import { FenceRefusal, RefusalReason, renderFence } from "../../src/fencing/renderer.js";
import { FencedSpawner } from "../../src/fencing/spawn.js";
import {
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  fenceLedger,
  mutate,
} from "./helpers/fence-cases.js";

/** The `permissions.allow` list of a rendered fence, as the child's CLI reads it. */
function allowOf(settings: Readonly<Record<string, unknown>>): readonly unknown[] {
  const permissions = settings["permissions"] as Record<string, unknown> | undefined;
  return (permissions?.["allow"] ?? []) as readonly unknown[];
}

/** Every rule the deny hook and `decide` enforce, as comparable text. */
function ruleText(fence: { readonly rules: readonly { kind: string; spec: string }[] }): string[] {
  return fence.rules.map((rule) => `${rule.kind} ${rule.spec}`);
}

/** The reason codes a refusal carries. */
function codesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    expect(error, `expected a FenceRefusal, got ${String(error)}`).toBeInstanceOf(FenceRefusal);
    return (error as FenceRefusal).reasons.map(([code]) => code);
  }
  throw new Error("expected the render to be refused, and it was not");
}

describe("a declaration reaches the allow list the child reads", () => {
  test("each subject becomes one Bash(...) entry, beside what the document authored", () => {
    // The whole of continuo #207's first requirement. Without it there is no
    // input on any surface that reaches an allow rule, which is the measured
    // state the issue was filed over: a child that may commit and may not run
    // the suite it is required to have green before committing.
    const ctx = fenceContext();

    const fence = renderFence("worker", ctx, {
      document: fenceDocument(),
      allowedBash: ["npm ci --ignore-scripts", "npm run:*"],
    });

    expect(allowOf(fence.settings)).toEqual([
      // The document's own six, unmoved and in order -- a declaration adds, it
      // does not replace.
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(npm ci --ignore-scripts)",
      "Bash(npm run:*)",
    ]);
  });

  test("declaring nothing renders exactly the fence every run before this got", () => {
    // The compatibility half, and it is asserted over the whole settings payload
    // rather than over the allow list: this payload is the fence digest's input
    // and half of the restart comparison (`D-0082`), so a key that moved for a
    // run that declared nothing would report every such fence as changed.
    const ctx = fenceContext();

    const declared = renderFence("worker", ctx, { document: fenceDocument(), allowedBash: [] });
    const bare = renderFence("worker", ctx, { document: fenceDocument() });

    expect(declared.settings).toEqual(bare.settings);
  });

  test("a role that authored no permissions block still receives one", () => {
    // A sandbox-only role -- deny paths and hooks and no `permissions` key -- is
    // a shape interlock renders, and the renderer's `{}` default is what keeps
    // it renderable here (see `renderFence`'s note on it). Without the attach
    // step, the declaration for such a role would be checked against the
    // document's forbidden list and then dropped on the floor: the render would
    // succeed, the ledger would record an admitted fence, and the child would
    // start without the one thing the run was admitted to be able to do.
    const ctx = fenceContext();
    const sandboxOnly = mutate(fenceDocument(), "worker", { permissions: null });

    const fence = renderFence("worker", ctx, {
      document: sandboxOnly,
      allowedBash: ["npm run verify"],
    });

    expect(allowOf(fence.settings)).toEqual(["Bash(npm run verify)"]);
  });

  test("the spawner publishes the declaration into the run's own settings file", () => {
    // continuo #207's second requirement, at the artefact that answers it byte
    // for byte: a person reading a finished run reads what that run's child was
    // allowed off the file it was started with, not off this repository's
    // source. The declaration is held on the spawner rather than passed per
    // `prepare` so that the fence the ledger recorded is the fence the child
    // ran under.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);

    const outcome = new FencedSpawner({
      ledger: fenceLedger(root),
      document: fenceDocument(),
      allowedBash: ["npm run verify"],
    }).prepare("worker", ctx);

    expect(outcome.admitted, JSON.stringify(outcome.reasons)).toBe(true);
    expect(allowOf(outcome.fence?.settings ?? {})).toContain("Bash(npm run verify)");
  });
});

describe("a declaration reaches nothing else", () => {
  test("it does not add, remove or move one rule the hook enforces", () => {
    // The structural claim `D-1110` rests on, asserted rather than argued.
    // `Fence.rules` is built from `permissions.deny` and the two sandbox deny
    // axes, and it is the list the `PreToolUse` hook and `decide` both walk --
    // so if this ever stopped holding, a declaration would be able to narrow the
    // fence rather than only widen one layer of it, and the entry would have to
    // be superseded rather than amended.
    const ctx = fenceContext();

    const declared = renderFence("worker", ctx, {
      document: fenceDocument(),
      allowedBash: ["npm run:*", "node --version"],
    });
    const bare = renderFence("worker", ctx, { document: fenceDocument() });

    expect(ruleText(declared)).toEqual(ruleText(bare));
    expect(declared.ruleIds()).toEqual(bare.ruleIds());
  });

  test("declaring the very command a deny rule forbids does not permit it", () => {
    // The sharpest form of the case above, and the one a reader will actually
    // ask about: `git push origin main` is on no forbidden-allow list, so it
    // renders -- and the fence still denies it, because the deny rule
    // `Bash(git push *)` is in a layer no allow entry is carried into. A
    // declaration is not a grant of everything it names; it is an entry in one
    // list, underneath two that still say no.
    const ctx = fenceContext();

    const fence = renderFence("worker", ctx, {
      document: fenceDocument(),
      allowedBash: ["git push origin main"],
    });

    expect(allowOf(fence.settings)).toContain("Bash(git push origin main)");
    const decision = fence.decide("Bash", { command: "git push origin main" });
    expect(decision.denied, "the deny layer stopped answering for a declared command").toBe(true);
  });

  test("a subject the document forbids refuses the render, rather than being dropped", () => {
    // The document keeps the last word, and it keeps it the way this module
    // keeps every other one: by refusing rather than by rendering the part it
    // could resolve (`docs/per-role-fencing.md` section 4). Observed red before
    // the merge was moved ahead of `checkForbiddenAllow`: with the declaration
    // merged after that check, both of these rendered a fence and the child
    // started with an allow entry the document forbids in as many words.
    const ctx = fenceContext();

    for (const subject of ["git *", "rm -rf *", "gh *"]) {
      expect(
        codesOf(() =>
          renderFence("worker", ctx, { document: fenceDocument(), allowedBash: [subject] }),
        ),
        `${subject} rendered instead of being refused`,
      ).toContain(RefusalReason.FORBIDDEN_ALLOW);
    }
  });

  test("a wildcard subject is refused by the document's own regex", () => {
    // `^Bash\(\s*\*\s*\)$` is in the shipped document's `forbidden_allow_regex`,
    // so the widest spelling of all is refused at render even for a caller that
    // reached this function without going through `LapRunIntent` -- which is
    // what makes the constructor's own refusal of it a convenience for the
    // operator rather than the only thing standing between a run and a bypass.
    const ctx = fenceContext();

    expect(
      codesOf(() => renderFence("worker", ctx, { document: fenceDocument(), allowedBash: ["*"] })),
    ).toContain(RefusalReason.FORBIDDEN_ALLOW);
  });
});
