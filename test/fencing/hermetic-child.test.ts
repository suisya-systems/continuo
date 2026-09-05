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
import { normalizePath } from "../../src/fencing/pypath.js";
import {
  FenceRefusal,
  NON_INTERACTIVE_PERMISSION_MODE,
  RefusalReason,
  renderFence,
} from "../../src/fencing/renderer.js";
import { parsePermissionRule } from "../../src/fencing/rules.js";
import { FencedSpawner } from "../../src/fencing/spawn.js";
import { gitMetadataRoots, runGitChecked } from "../../src/workspace/git.js";
import { expectRefusal } from "../testkit/errors.js";
import { skipIf } from "../testkit/marks.js";
import {
  deepCopyDocument,
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  fenceLedger,
  mutate,
  replaceFenceContext,
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

describe("the sandbox the fence renders is one the CLI can actually build (D-0082)", () => {
  /** The `sandbox.filesystem` block as the child's settings file carries it. */
  function renderedFilesystem(roots: readonly string[] = []): Record<string, unknown> {
    const fence = renderFence("worker", fenceContext(), {
      document: fenceDocument(),
      nonInteractive: true,
      sandboxWritableRoots: roots,
    });
    const sandbox = fence.settings["sandbox"] as Record<string, unknown>;
    return sandbox["filesystem"] as Record<string, unknown>;
  }

  test("the block arrives switched on, because a block without that is not a sandbox", () => {
    const fence = renderFence("worker", fenceContext(), {
      document: fenceDocument(),
      nonInteractive: true,
    });
    const sandbox = fence.settings["sandbox"] as Record<string, unknown>;

    expect(sandbox["enabled"]).toBe(true);
    // The document does NOT say so, and that is the finding: `roles.json` has
    // never carried the key, so every fence this repository has rendered
    // declared a sandbox the CLI then did not build. The repair is the
    // renderer's, and the document is left as interlock wrote it.
    const document = fenceDocument() as Record<string, unknown>;
    const worker = (document["roles"] as Record<string, unknown>)["worker"] as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(worker["sandbox"] as object, "enabled")).toBe(false);
  });

  test("every deny entry reaches the child as a string, expanded, and none as an object", () => {
    const filesystem = renderedFilesystem();

    for (const key of ["denyRead", "denyWrite"]) {
      for (const entry of filesystem[key] as unknown[]) {
        // One structured entry anywhere here silently turns the whole sandbox
        // off -- measured on CLI 2.1.260 -- so this is not a tidiness
        // assertion: it is the whole of the `#130` repair.
        expect(typeof entry).toBe("string");
      }
    }
    // The document's own spelling of that rule, still structured, so the case
    // fails if the repair is ever moved into the carried document instead.
    const document = fenceDocument() as Record<string, unknown>;
    const worker = (document["roles"] as Record<string, unknown>)["worker"] as Record<
      string,
      unknown
    >;
    const authored = (
      (worker["sandbox"] as Record<string, unknown>)["filesystem"] as Record<string, unknown>
    )["denyRead"] as unknown[];
    expect(authored.some((entry) => typeof entry === "object" && entry !== null)).toBe(true);
    // And the rule survives the flattening rather than being dropped by it: the
    // path the child is denied is the one `~/.ssh` names, expanded here rather
    // than left for the CLI to expand.
    expect(filesystem["denyRead"]).toContain(normalizePath("~/.ssh"));
  });

  test("the settings and the fence's own rules now name one path, not two spellings", () => {
    const fence = renderFence("worker", fenceContext(), {
      document: fenceDocument(),
      nonInteractive: true,
    });
    const filesystem = (fence.settings["sandbox"] as Record<string, unknown>)[
      "filesystem"
    ] as Record<string, unknown>;

    // The disagreement between these two lists is the shape of the defect: the
    // hook layer flattened the structured entry and the settings layer did not,
    // so the two layers enforced the same intent under different spellings and
    // only one of them was a spelling the CLI could read.
    const specs = fence.rules
      .filter((rule) => rule.kind === "sandbox-deny-read")
      .map((rule) => rule.spec);
    expect(filesystem["denyRead"]).toStrictEqual(specs);
  });

  test("the derived roots are appended, and nothing else in the fence moves", () => {
    const roots = [
      "/base/.git/worktrees/topic",
      "/base/.git/objects",
      "/base/.git/refs/heads/feat/topic",
      "/base/.git/packed-refs",
    ];
    const ctx = fenceContext();
    const document = fenceDocument();
    const without = renderFence("worker", ctx, { document, nonInteractive: true });
    const with_ = renderFence("worker", ctx, {
      document,
      nonInteractive: true,
      sandboxWritableRoots: roots,
    });

    expect(
      (
        (with_.settings["sandbox"] as Record<string, unknown>)["filesystem"] as Record<
          string,
          unknown
        >
      )["additionalDirectories"],
    ).toStrictEqual(roots);
    // `#130`'s acceptance in as many words: the deny list is byte-identical
    // before and after. Over the rule set AND over the two lists the child
    // reads, because those are the two places a widening could hide.
    expect(with_.ruleIds()).toStrictEqual(without.ruleIds());
    expect(with_.settings["permissions"]).toStrictEqual(without.settings["permissions"]);
  });

  test("a role handed no roots keeps the key absent rather than gaining an empty one", () => {
    const filesystem = renderedFilesystem();
    // The settings generator states the same contract for the same field, and a
    // key that appears only sometimes is a diff a restart check has to explain.
    expect(Object.hasOwn(filesystem, "additionalDirectories")).toBe(false);
  });

  test("a non-list additionalDirectories refuses rather than being replaced", () => {
    const document = deepCopyDocument(fenceDocument());
    const worker = (document["roles"] as Record<string, unknown>)["worker"] as Record<
      string,
      unknown
    >;
    const filesystem = (worker["sandbox"] as Record<string, unknown>)["filesystem"] as Record<
      string,
      unknown
    >;
    filesystem["additionalDirectories"] = "/shared";

    // Merging the derived roots over this would publish `["/base/.git/objects"]`
    // -- a valid-looking list the document does not contain -- so it is refused
    // on the same terms as a non-list `denyRead`. (Found by codex review.)
    const refusal = expectRefusal(
      () =>
        renderFence("worker", fenceContext(), {
          document,
          nonInteractive: true,
          sandboxWritableRoots: ["/base/.git/objects"],
        }),
      FenceRefusal,
      /additionalDirectories must be a list, got str/,
    );
    expect(refusal.codes).toContain(RefusalReason.RULE_SYNTAX);
  });

  test("a root the document already declared is not added twice", () => {
    const document = deepCopyDocument(fenceDocument());
    const worker = (document["roles"] as Record<string, unknown>)["worker"] as Record<
      string,
      unknown
    >;
    const filesystem = (worker["sandbox"] as Record<string, unknown>)["filesystem"] as Record<
      string,
      unknown
    >;
    filesystem["additionalDirectories"] = ["/base/.git/objects"];

    const fence = renderFence("worker", fenceContext(), {
      document,
      nonInteractive: true,
      sandboxWritableRoots: ["/base/.git/objects", "/base/.git/packed-refs"],
    });

    expect(
      (
        (fence.settings["sandbox"] as Record<string, unknown>)["filesystem"] as Record<
          string,
          unknown
        >
      )["additionalDirectories"],
    ).toStrictEqual(["/base/.git/objects", "/base/.git/packed-refs"]);
  });
});

describe("the admission record says what the fence actually opened (D-0082)", () => {
  test("a root the document declared is in the ledger row too, not only the derived ones", () => {
    const root = fenceCaseRoot();
    const document = deepCopyDocument(fenceDocument());
    const worker = (document["roles"] as Record<string, unknown>)["worker"] as Record<
      string,
      unknown
    >;
    ((worker["sandbox"] as Record<string, unknown>)["filesystem"] as Record<string, unknown>)[
      "additionalDirectories"
    ] = ["/shared"];

    const ledgerPath = join(root, "declared-roots.jsonl");
    const outcome = new FencedSpawner({
      ledger: fenceLedger(root, "declared-roots.jsonl"),
      document,
      nonInteractive: true,
      sandboxWritableRoots: ["/base/.git/objects"],
    }).prepare("worker", fenceContext(root));
    expect(outcome.admitted).toBe(true);

    const admitted = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row["event"] === "spawn-admitted");

    // The child can write through `/shared` as surely as through the derived
    // root, so a row that listed only what the caller supplied would report a
    // narrower surface than the one published -- the one direction this field
    // must not fail in.
    expect((admitted[0] as Record<string, unknown>)["sandbox_writable_roots"]).toStrictEqual([
      "/shared",
      "/base/.git/objects",
    ]);
  });

  test("a sandbox the document switched off reports no opened roots", () => {
    const root = fenceCaseRoot();
    const document = deepCopyDocument(fenceDocument());
    const worker = (document["roles"] as Record<string, unknown>)["worker"] as Record<
      string,
      unknown
    >;
    (worker["sandbox"] as Record<string, unknown>)["enabled"] = false;

    const ledgerPath = join(root, "disabled-sandbox.jsonl");
    const outcome = new FencedSpawner({
      ledger: fenceLedger(root, "disabled-sandbox.jsonl"),
      document,
      nonInteractive: true,
      sandboxWritableRoots: ["/base/.git/objects"],
    }).prepare("worker", fenceContext(root));
    expect(outcome.admitted).toBe(true);

    // The document's position is kept -- the repair sets `enabled` only where
    // the document is silent -- and a row listing paths beside a switched-off
    // sandbox would say a layer that is not running had let them through.
    const sandbox = outcome.fence?.settings["sandbox"] as Record<string, unknown>;
    expect(sandbox["enabled"]).toBe(false);
    const admitted = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row["event"] === "spawn-admitted");
    expect((admitted[0] as Record<string, unknown>)["sandbox_writable_roots"]).toStrictEqual([]);
  });
});

describe("the worker's settings.json deny closes the tool a child would reach for (#132, #135)", () => {
  /**
   * The rendered worker fence, whose only rule for this path is now the single
   * `Edit(~/.claude/settings.json)` entry -- the `Write(...)` twin is gone.
   */
  function workerFence() {
    return renderFence("worker", fenceContext(), {
      document: fenceDocument(),
      nonInteractive: true,
    });
  }

  /** The rule id every member of the family must be refused by. */
  // The spec is the rule as authored -- permission rules keep the document's
  // spelling, and `specMatches` normalises at comparison time instead.
  const EDIT_RULE_ID = "permissions:permission-deny:Edit:~/.claude/settings.json";

  // `NotebookEdit` carries its subject under `notebook_path`, not `file_path`;
  // the table uses each tool's real payload key so a match cannot pass on a
  // shape the CLI never sends.
  const FAMILY = [
    { tool: "Edit", input: { file_path: normalizePath("~/.claude/settings.json") } },
    { tool: "Write", input: { file_path: normalizePath("~/.claude/settings.json") } },
    { tool: "NotebookEdit", input: { notebook_path: normalizePath("~/.claude/settings.json") } },
  ] as const;

  for (const { tool, input } of FAMILY) {
    test(`${tool} on ~/.claude/settings.json is refused by the one Edit rule`, () => {
      // Before D-0089 `matches` compared an exact tool name, so this rule spoke
      // only for the tool it was spelled with. It now speaks for the family the
      // CLI applies it to -- which is what makes the `Write(...)` twin the
      // document used to carry redundant rather than load-bearing.
      const decision = workerFence().decide(tool, input);
      expect(decision.denied).toBe(true);
      // Asserting the rule id, not merely the refusal: it is the only thing
      // that shows one authored `Edit(...)` rule reached three tools rather
      // than three rules each reaching their own.
      expect(decision.ruleId).toBe(EDIT_RULE_ID);
      // The reason names the invoked tool and the rule that refused, which is
      // how an operator tells this layer's refusal from the permission
      // system's wordless one.
      expect(decision.reason).toContain(`${tool} denied by permission-deny rule`);
      expect(decision.reason).toContain("~/.claude/settings.json");
    });
  }

  test("a file the rule does not name is not refused by it", () => {
    // The widening is over tools only. A path outside the rule's spec stays
    // outside it, and `denied: false` here means the fence has no opinion.
    expect(workerFence().decide("Edit", { file_path: normalizePath("~/notes.md") }).denied).toBe(
      false,
    );
  });

  test("an authored Write(...) rule does not become a family alias", () => {
    // The one-way half of D-0089. `Edit(...)` is the CLI's family spelling;
    // `Write(...)` is not, and a fence that made it one would deny more than
    // the document authorised.
    const rule = parsePermissionRule("Write(~/.claude/settings.json)");
    expect(rule.matches("Write", { file_path: normalizePath("~/.claude/settings.json") })).toBe(
      true,
    );
    expect(rule.matches("Edit", { file_path: normalizePath("~/.claude/settings.json") })).toBe(
      false,
    );
    expect(
      rule.matches("NotebookEdit", { notebook_path: normalizePath("~/.claude/settings.json") }),
    ).toBe(false);
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

/**
 * A base clone with one commit, and a LINKED WORKTREE checked out of it.
 *
 * The worktree is the whole point: its `.git` is a *file* pointing into
 * `<base>/.git/worktrees/<name>`, so the index `git add` writes and the objects
 * it creates land outside the checkout. A plain clone would run this case green
 * against a fence with no writable surface at all, because there would be
 * nothing outside the checkout to reach.
 */
function worktreeTarget(root: string): { readonly base: string; readonly workerDir: string } {
  const base = join(root, "base");
  mkdirSync(base, { recursive: true });
  const git = { cwd: base, timeoutMs: 60_000 };
  runGitChecked(["init", "--initial-branch=main", "."], git);
  // The identity and the signing setting, because `git commit` refuses without
  // the first on a machine that has never been configured and can hang on the
  // second, and this case's whole observation is whether a commit happened.
  runGitChecked(["config", "user.name", "continuo test"], git);
  runGitChecked(["config", "user.email", "continuo@example.invalid"], git);
  runGitChecked(["config", "commit.gpgsign", "false"], git);
  writeFileSync(join(base, "seed.txt"), "seed\n", "utf8");
  runGitChecked(["add", "seed.txt"], git);
  runGitChecked(["commit", "-m", "seed"], git);

  const workerDir = join(root, "worktree");
  runGitChecked(["worktree", "add", "--no-track", "-b", "feat/topic", workerDir, "HEAD"], git);
  return { base, workerDir };
}

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

  skipIf(!REAL_CHILD_ENABLED, REAL_CHILD_REASON)(
    "commits inside a worktree with no prompt, and has a sandbox while doing it (D-0082)",
    () => {
      const root = fenceCaseRoot();
      const { workerDir } = worktreeTarget(root);
      const git = { cwd: workerDir, timeoutMs: 60_000 };
      const ctx = replaceFenceContext(fenceContext(root, { hookScript: shippedHookScript() }), {
        workerDir,
      });
      const outcome = new FencedSpawner({
        ledger: fenceLedger(root, "worktree-commit.jsonl"),
        document: fenceDocument(),
        nonInteractive: true,
        sandboxWritableRoots: gitMetadataRoots(git),
      }).prepare("worker", ctx);
      expect(outcome.admitted).toBe(true);

      const stdout = execFileSync(
        "claude",
        [
          "-p",
          "Create a file named work.txt in the current directory containing the word OK, " +
            "then run `git add work.txt` and then `git commit -m work`. " +
            "The last line of your reply must be exactly SANDBOX YES if a system message " +
            "describing a 'Bash command sandbox' is present in your context, and exactly " +
            "SANDBOX NO if there is none.",
          ...(outcome.plan?.cliArgs() ?? []),
        ],
        { cwd: workerDir, encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
      );

      // The observation that does not go through the child's own account of
      // itself: the repository has the commit. `#130`'s acceptance is that this
      // happens with nobody at the prompt to approve anything.
      expect(runGitChecked(["log", "--oneline", "-1"], git).stdout).toContain("work");
      expect(runGitChecked(["show", "--name-only", "--format=", "HEAD"], git).stdout).toContain(
        "work.txt",
      );
      // And the layer the human gate voted to keep is actually there. This one
      // can only be asked of the child: the sandbox is not visible from outside
      // the process, and a fence that renders `enabled: true` into a file the
      // CLI then declines to act on would pass every other case in this file.
      // Measured before the repair: a fence whose deny entry was still
      // structured answered SANDBOX NO here and could not stage at all.
      expect(stdout).toContain("SANDBOX YES");
      expect(stdout).not.toContain("SANDBOX NO");
    },
  );
});
