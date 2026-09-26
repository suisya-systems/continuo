/**
 * A Codex lap as the materializer leaves it -- the fence `F`, the settings `S`
 * and the MCP config `P` rendered and published -- and the provider over the
 * fake `codex`, shared by the Codex provider's cases and its fence-shape table.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { expect } from "vitest";
import { renderFence } from "../../../src/fencing/renderer.js";
import { Fence, type FenceRule, parsePermissionRule } from "../../../src/fencing/rules.js";
import { readFence, writeFence } from "../../../src/fencing/state.js";
import { CodexCliSessionProvider } from "../../../src/session/codex_cli_provider.js";
import { Failure, Ok, type ProviderResult } from "../../../src/session/provider.js";
import {
  fenceContext,
  fenceDocument,
  shippedHookScript,
} from "../../fencing/helpers/fence-cases.js";
import { caseRoot } from "../../testkit/cases.js";
import { fakeCodexCli, spawnLog } from "./fake-cli.js";
import { cliRequest, stopSessionsAtTeardown, waitForSpawns } from "./session-cases.js";

export const SESSION = "sess-1";
export const MCP_SERVER = "continuo-messagebus";

export interface Lap {
  readonly root: string;
  readonly cliArgs: readonly string[];
  readonly settingsPath: string;
  readonly mcpPath: string;
  readonly fencePath: string;
  readonly codexHome: string;
}

/** A worker fence rendered and published as the materializer does, plus an operator home. */
export function lap(
  options: { readonly allowedBash?: readonly string[]; readonly hookScript?: string } = {},
): Lap {
  const root = caseRoot("codexprov");
  const ctx = fenceContext(join(root, "fence"), {
    hookScript: options.hookScript ?? shippedHookScript(),
  });
  const fence = renderFence("worker", ctx, {
    document: fenceDocument(),
    allowedBash: options.allowedBash ?? ["npm test"],
    nonInteractive: true,
  });
  mkdirSync(dirname(ctx.fencePath), { recursive: true });
  writeFence(fence, ctx.fencePath);
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const settingsPath = join(artifacts, "settings.local.json");
  writeFileSync(settingsPath, JSON.stringify(fence.settings), "utf8");
  const mcpPath = join(artifacts, "mcp.json");
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER]: {
          command: process.execPath,
          args: [join(root, "endpoint.mjs")],
          env: { INTERLOCK_MESSAGEBUS_DB: join(root, "bus.db") },
        },
      },
    }),
    "utf8",
  );
  const codexHome = join(root, "operator-codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), '{"token":"operator"}', "utf8");
  return {
    root,
    settingsPath,
    mcpPath,
    fencePath: ctx.fencePath,
    codexHome,
    cliArgs: [
      "--settings",
      settingsPath,
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "",
      "--mcp-config",
      mcpPath,
      "--strict-mcp-config",
    ],
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a settings document is edited freely by cases.
type Settings = Record<string, any>;

/**
 * Edit `S` and publish the result as the materializer would: into `F` too,
 * whose rules gain every deny entry the edit added -- unless `only` is
 * `"settings"`, which leaves `F` as it was (the two disagreeing).
 */
export function publish(l: Lap, edit: (settings: Settings) => void, only?: "settings"): void {
  const settings = JSON.parse(readFileSync(l.settingsPath, "utf8")) as Settings;
  edit(settings);
  writeFileSync(l.settingsPath, JSON.stringify(settings), "utf8");
  if (only === "settings") {
    return;
  }
  const fence = readFence(l.fencePath);
  const rules = new Map<string, FenceRule>(fence.rules.map((rule) => [rule.ruleId, rule]));
  for (const entry of (settings["permissions"]?.["deny"] ?? []) as unknown[]) {
    try {
      const rule = parsePermissionRule(entry);
      rules.set(rule.ruleId, rule);
    } catch {
      // An unparseable entry is the translation's to refuse, not the fixture's.
    }
  }
  writeFence(
    new Fence({
      role: fence.role,
      roleKind: fence.roleKind,
      permissionMode: fence.permissionMode,
      rules: [...rules.values()],
      settings,
    }),
    l.fencePath,
  );
}

export function providerFor(l: Lap): CodexCliSessionProvider {
  return stopSessionsAtTeardown(
    new CodexCliSessionProvider(join(l.root, "state"), {
      claudeCommand: fakeCodexCli(l.root),
      codexHome: l.codexHome,
    }),
  );
}

export function start(
  provider: CodexCliSessionProvider,
  l: Lap,
  settings: Readonly<Record<string, unknown>> = {},
): Promise<ProviderResult<unknown>> {
  return provider.start(
    cliRequest(l.root, SESSION, { prompt: "do the lap", cli_args: l.cliArgs, ...settings }),
  );
}

export function refusalOf(result: ProviderResult<unknown>): Failure {
  expect(result, `expected Failure, got ${String(result)}`).toBeInstanceOf(Failure);
  return result as Failure;
}

/**
 * Point the lap's fence at a base `.git` whose branch ref is `branch`, the
 * way `gitMetadataRoots` names it (`/`-separated, the ref a FILE, beside the
 * common directory's `objects` and `packed-refs`), and return the paths involved.
 */
export function withBranchRef(l: Lap, branch: string) {
  const gitDir = join(l.root, "base", ".git");
  const ref = `${gitDir}/refs/heads/${branch}`;
  mkdirSync(dirname(ref), { recursive: true });
  mkdirSync(`${gitDir}/objects`, { recursive: true });
  writeFileSync(ref, "0".repeat(40), "utf8");
  writeFileSync(`${gitDir}/packed-refs`, "", "utf8");
  publish(l, (settings) => {
    settings["sandbox"]["filesystem"]["additionalDirectories"] = [
      gitDir,
      `${gitDir}/objects`,
      ref,
      `${gitDir}/packed-refs`,
    ];
  });
  return { gitDir, ref };
}

/** The `permissions=` override of the spawned `codex exec`, after a start that must succeed. */
export async function profileOf(l: Lap): Promise<string> {
  const log = spawnLog(l.root);
  const started = await start(providerFor(l), l);
  expect(started, started instanceof Failure ? started.detail : "").toBeInstanceOf(Ok);
  const [entry] = await waitForSpawns(log, 1);
  return (entry?.argv ?? []).find((part) => part.startsWith("permissions=")) ?? "";
}
