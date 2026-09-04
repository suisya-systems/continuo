/**
 * The fence is the child's ONLY configuration, and it lets the child work.
 *
 * **Target-only.** Both defects these cases pin were found by continuo's lap 1
 * dogfood (`docs/operations/lap-1-dogfood.md` section 7, F-1 and F-2) against a
 * CLI interlock's suite never spawned, so there is no source case to translate
 * and no parity ledger's totals move. `D-0081` records the decision.
 *
 * The two are one shape seen from two sides, which is why they share a file:
 *
 * - **#119, the fence is not hermetic.** `--settings` is *additive*. The CLI
 *   loads the user, project and local settings files as well, so the target
 *   repository's own `.claude/settings.local.json` -- its hooks included --
 *   arrives underneath a fence that can add rules and cannot take any away. In
 *   the dogfood the target carried a hook that refused every write inside the
 *   worktree, and the lap produced no work at all while the gate opened and
 *   closed normally: the most expensive failure mode there is, because
 *   everything Interlock can see says the run was fine.
 * - **#120, the fence lets the child do nothing.** The role document renders
 *   `permissionMode: default`, which means "ask a person". A `claude -p` child
 *   has no person at its prompt, so every `Edit` and `Write` is refused and the
 *   turn ends having changed nothing.
 *
 * A fence that cannot be escaped and cannot be worked under is two different
 * ways of shipping a lap that produces nothing.
 *
 * **What the real child proves that a rendered argv cannot.** The cases below
 * split in two. The first group renders and reads -- fast, hermetic, always
 * run. It can show that `--setting-sources ''` is in the argv and that the mode
 * says `acceptEdits`; it cannot show that the CLI *honours* either, and both
 * defects were precisely a case of the fence saying something the CLI did not
 * do. So the second group starts a real `claude -p` under a real fence, in a
 * target carrying the dogfood's write-refusing settings file, and looks at the
 * filesystem afterwards.
 *
 * **The witness, and why the observation is not "was the file written".** The
 * target's hook writes a witness file *before* it refuses. Its absence is the
 * direct observation that the target's settings were never read; a write that
 * merely succeeded would be the same outcome whether the hook was absent, or
 * present and outranked, or present and firing for a different tool. The
 * negative case asserts the witness IS written when the flag is removed from
 * the argv -- which is the dogfood reproduction, and the half that fails
 * against the code as it stood before `D-0081`.
 *
 * **Why the real-child group is opt-in.** It needs a `claude` on `PATH` that is
 * authenticated and can reach the API, and it bills a real turn. Nothing else
 * in this suite does; every other "real provider" case here drives a fake CLI.
 * So it is gated on an explicit environment variable as well as on the binary
 * being present, and the gate names both. Skipped, the file still carries the
 * first group, which is what a machine with no CLI can prove.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  FenceRefusal,
  NON_INTERACTIVE_PERMISSION_MODE,
  RefusalReason,
  renderFence,
} from "../../src/fencing/renderer.js";
import { FencedSpawner } from "../../src/fencing/spawn.js";
import { expectRefusal } from "../testkit/errors.js";
import { skipIf } from "../testkit/marks.js";
import {
  deepCopyDocument,
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  fenceLedger,
  mutate,
  shippedHookScript,
} from "./helpers/fence-cases.js";

/** Opt-in: a real, authenticated `claude` that this file may bill a turn on. */
const REAL_CHILD_ENV = "CONTINUO_REAL_CLAUDE_CHILD";

/** Is a `claude` resolvable on `PATH`? Probed once, at collection time. */
function claudeOnPath(): boolean {
  const path = process.env["PATH"] ?? "";
  const names = process.platform === "win32" ? ["claude.cmd", "claude.exe"] : ["claude"];
  return path
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => names.some((name) => existsSync(join(entry, name))));
}

const REAL_CHILD_ENABLED = process.env[REAL_CHILD_ENV] === "1" && claudeOnPath();

// ---------------------------------------------------------------------------
// what the renderer and the plan say
// ---------------------------------------------------------------------------

describe("a spawn with nobody at its prompt renders a mode it can work under", () => {
  test("the shipped worker's 'default' becomes acceptEdits, and only for a non-interactive spawn", () => {
    const ctx = fenceContext();
    const document = fenceDocument();

    const interactive = renderFence("worker", ctx, { document });
    const nonInteractive = renderFence("worker", ctx, { document, nonInteractive: true });

    // The document is untouched; the promotion is the renderer's, taken on
    // what the caller said about the child rather than on what the role says
    // about itself.
    expect(interactive.permissionMode).toBe("default");
    expect(nonInteractive.permissionMode).toBe(NON_INTERACTIVE_PERMISSION_MODE);
    // Both halves of the fence the child actually reads, not just the summary
    // field: the settings file is what the CLI parses and what a restart diffs.
    expect(interactive.settings["permissionMode"]).toBe("default");
    expect(nonInteractive.settings["permissionMode"]).toBe(NON_INTERACTIVE_PERMISSION_MODE);
  });

  test("the mode is the only byte that moves: allow and deny are identical", () => {
    // The human gate's decision in as many words -- the role document's allow
    // list is not widened and the deny rules stay exactly as they are (#120).
    // Asserted over the *rendered* settings rather than over the document,
    // because the document is trivially unchanged; what matters is that the
    // promotion did not take anything with it on the way through.
    const ctx = fenceContext();
    const document = fenceDocument();

    const interactive = renderFence("worker", ctx, { document });
    const nonInteractive = renderFence("worker", ctx, { document, nonInteractive: true });

    const permissionsOf = (settings: Readonly<Record<string, unknown>>): unknown =>
      (settings["permissions"] ?? null) as unknown;
    expect(JSON.stringify(permissionsOf(nonInteractive.settings))).toBe(
      JSON.stringify(permissionsOf(interactive.settings)),
    );
    // And the rules the deny hook reads back, which are the fence's teeth.
    expect(nonInteractive.ruleIds()).toEqual(interactive.ruleIds());
  });

  test("a mode the document is not 'default' is carried verbatim, not promoted", () => {
    // The narrow rule, and the reason for it. `plan` means "look, do not
    // touch"; promoting it to `acceptEdits` would hand a role write access its
    // author declined to give it, which is the silent widening D-0023 part 2
    // refuses. `default` is the one mode that *cannot* be honoured without a
    // person, so it is the one this promotion is about.
    const ctx = fenceContext();
    const document = mutate(fenceDocument(), "worker", { permission_mode: "plan" });

    expect(renderFence("worker", ctx, { document, nonInteractive: true }).permissionMode).toBe(
      "plan",
    );
  });

  test("a document that forbids acceptEdits refuses rather than being promoted into it", () => {
    // The promoted value goes through the same gate the authored one did. A
    // document whose `global.permission_modes` omits the mode has said it may
    // not be rendered, and rendering it anyway would be a fence its author
    // forbade -- so this refuses, and says which mode it refused on.
    const ctx = fenceContext();
    // `mutate` edits one role; this is a `global` key, so the copy is taken
    // directly -- through the same JSON round trip, which is what carries the
    // document's source key order onto it.
    const document = deepCopyDocument(fenceDocument());
    (document["global"] as Record<string, unknown>)["permission_modes"] = ["default", "plan"];

    const refusal = expectRefusal(
      () => renderFence("worker", ctx, { document, nonInteractive: true }),
      FenceRefusal,
      /acceptEdits/,
    );
    expect(refusal.codes).toContain(RefusalReason.PERMISSION_MODE_INVALID);
    // The anti-vacuity half: the same document renders for an interactive
    // spawn, so the refusal is the promotion's and not the document's.
    expect(renderFence("worker", ctx, { document }).permissionMode).toBe("default");
  });
});

describe("the plan's argv makes the fence the only settings source", () => {
  test("the fence's flags carry --setting-sources with the empty subset", () => {
    const root = fenceCaseRoot();
    const outcome = new FencedSpawner({
      ledger: fenceLedger(root),
      document: fenceDocument(),
      nonInteractive: true,
    }).prepare("worker", fenceContext(root));

    expect(outcome.admitted).toBe(true);
    const args = outcome.plan?.cliArgs() ?? [];
    const index = args.indexOf("--setting-sources");
    expect(index).toBeGreaterThanOrEqual(0);
    // The empty string is the flag's "no sources" spelling; a missing value --
    // or a flag rendered last with nothing after it -- would be the CLI's own
    // parse error rather than a fence.
    expect(args[index + 1]).toBe("");
    // And the mode the child is started under is the one the settings file
    // says, because they come from the same field.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(NON_INTERACTIVE_PERMISSION_MODE);
  });
});

// ---------------------------------------------------------------------------
// what a real child does
// ---------------------------------------------------------------------------

/** One target repository carrying the dogfood's write-refusing settings file. */
function dogfoodTarget(root: string): { readonly workerDir: string; readonly witness: string } {
  const workerDir = join(root, "worker");
  const settingsDir = join(workerDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const witness = join(root, "local-settings-were-read");
  // The hook records that it ran before it refuses. Written with `node` -- the
  // interpreter this process is already running under -- rather than a shell
  // builtin, so the command means the same thing on every platform the suite
  // runs on.
  const script =
    `require("node:fs").writeFileSync(${JSON.stringify(witness)}, "ran");` +
    `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",` +
    `permissionDecision:"deny",permissionDecisionReason:"the target repository's own hook"}}))`;
  writeFileSync(
    join(settingsDir, "settings.local.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              // Every tool, exactly as the dogfood's target hook refused every
              // write path rather than one tool's. A matcher naming only
              // `Write|Edit` leaves the child a way around it -- measured: a
              // real turn, refused at `Write`, reached for `Bash` and wrote the
              // file anyway -- and a reproduction the model can work around is
              // one that reports the defect fixed on a lucky turn.
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { workerDir, witness };
}

/**
 * Start one real `claude -p` under a real fence, and hand back where it ran.
 *
 * `stripSettingSources` removes the flag pair from the argv the plan rendered,
 * which is the code as it stood before `D-0081` -- reproduced by subtraction
 * from the real plan rather than by hand-writing an argv, so the reproduction
 * cannot drift away from what the fence otherwise renders.
 */
function runFencedChild(
  label: string,
  options?: { readonly stripSettingSources?: boolean },
): { readonly workerDir: string; readonly witness: string; readonly written: string } {
  const root = fenceCaseRoot();
  const { workerDir, witness } = dogfoodTarget(root);
  const ctx = fenceContext(root, { hookScript: shippedHookScript() });
  const outcome = new FencedSpawner({
    ledger: fenceLedger(root, `${label}.jsonl`),
    document: fenceDocument(),
    nonInteractive: true,
  }).prepare("worker", ctx);
  expect(outcome.admitted).toBe(true);

  const rendered = outcome.plan?.cliArgs() ?? [];
  const args: string[] = [];
  for (let i = 0; i < rendered.length; i += 1) {
    if (options?.stripSettingSources === true && rendered[i] === "--setting-sources") {
      i += 1;
      continue;
    }
    args.push(rendered[i] as string);
  }

  execFileSync(
    "claude",
    [
      "-p",
      "Write a file named written-by-the-child.txt in the current directory whose only " +
        "content is the word OK. Then stop.",
      ...args,
    ],
    {
      cwd: workerDir,
      encoding: "utf8",
      // A turn that hangs must fail this case rather than the whole run.
      timeout: 300_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return { workerDir, witness, written: join(workerDir, "written-by-the-child.txt") };
}

const REAL_CHILD_REASON =
  `the real-child cases need a real, authenticated \`claude\` on PATH and bill an API turn, ` +
  `so they are opt-in: set ${REAL_CHILD_ENV}=1 with the CLI installed. Everything they prove ` +
  `about the rendered fence -- the mode, the flag and its empty value -- is proved without a ` +
  `child by the cases above; what only a child can show is that the CLI HONOURS them, which ` +
  `is exactly what both defects turned on`;

describe("a real child under the fence", () => {
  skipIf(!REAL_CHILD_ENABLED, REAL_CHILD_REASON)(
    "writes inside its worktree, and never reads the target's own settings",
    () => {
      const { witness, written } = runFencedChild("hermetic");

      // #119: the target's settings file was not loaded at all. Its hook never
      // ran, so it left no witness.
      expect(existsSync(witness)).toBe(false);
      // #120: with nobody to approve a prompt, the child still wrote.
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, "utf8")).toContain("OK");
    },
  );

  skipIf(!REAL_CHILD_ENABLED, REAL_CHILD_REASON)(
    "reproduces the dogfood: without the flag the target's hook runs and the turn writes nothing",
    () => {
      // The half that fails against the code as it stood before `D-0081`: the
      // argv is the same fence minus `--setting-sources`, which is what the
      // plan rendered until this change.
      const { witness, written } = runFencedChild("dogfood", { stripSettingSources: true });

      expect(existsSync(witness)).toBe(true);
      expect(existsSync(written)).toBe(false);
    },
  );
});
