import type { ClaudeCliSessionProviderOptions } from "./claude_cli_provider.js";
import { ClaudeCliSessionProvider } from "./claude_cli_provider.js";
import { CodexCliSessionProvider } from "./codex_cli_provider.js";

/**
 * Which worker CLI a lap runs on (continuo D-1114, issue #220).
 *
 * A closed set, named by the CLI and not by a model: which tier or agent type
 * runs on which CLI is the caller's table (rondo's), and this package only
 * answers "run it on that one".
 */
export type SessionProviderKind = "claude" | "codex";

/**
 * The name the orchestrator records in `session_binding.provider` for a kind.
 *
 * Stated here, beside the factory, so the row names the class that was built:
 * `recover()` refuses a binding whose provider name differs from its own, and
 * a Codex session recorded as `claude-cli` would be adopted by the wrong
 * backend. `claude-cli` is the orchestrator's own default, so a Claude lap's
 * bytes are what they were before the kind existed.
 */
export function sessionProviderName(kind: SessionProviderKind): string {
  return kind === "codex" ? "codex-cli" : "claude-cli";
}

/**
 * The shipped default session backend, named in the one half of the package
 * that is allowed to name one.
 *
 * **Why this indirection exists** (`D-0059`).
 * `test/gate_item11/no-provider-detail-leaks.test.ts` forbids any module under
 * `src/` other than `src/index.ts` from importing both a session backend and
 * `src/control_plane/`, and what it measures by that is *which files a provider
 * swap has to edit*. The lap's composition root is by definition a file that
 * knows both, and its CLI verb has to obtain a provider instance from somewhere.
 *
 * This function is that somewhere. It is a **provider-neutral name** -- the
 * lap's verb asks for "the default session provider" and never for
 * `ClaudeCliSessionProvider` -- so swapping the shipped default is an edit to
 * this file and its neighbours under `src/session/`, and to nothing in
 * `src/lap/`. The check's number is unchanged, which is the difference between
 * this and a one-hop indirection that merely hides the join from a per-file
 * scan (`docs/design/composition-root-placement.md`, option E).
 *
 * **It deliberately does not choose a state root.** Two providers silently
 * sharing a directory adopt each other's children, which is why
 * `ClaudeCliSessionProvider` requires one and never defaults it; a default here
 * would be that defaulting, one layer further from the constructor that refused
 * to do it.
 *
 * The return type is the concrete class rather than `SessionProvider`, and that
 * is load-bearing: `readTerminalReport` (`D-0056`) is on the implementation and
 * not on the contract, so a caller that needs the finished turn's report needs a
 * value whose type carries it. A caller reaches that method **structurally** --
 * `src/lap/root.ts` declares the shape it needs and never imports this type --
 * so nothing about the concrete class escapes into the control-plane half.
 *
 * **`kind` picks the CLI, and `codexHome` is required for `codex`** (D-1114).
 * The Codex provider is a subclass of the Claude one, so the return type still
 * holds and `readTerminalReport` is reached the same way. `codexHome` is
 * ignored for `claude`; the lap's CLI refuses the combination before it gets
 * here, and the Codex constructor refuses a missing or relative one.
 */
export function createDefaultSessionProvider(
  stateRoot: string,
  options: ClaudeCliSessionProviderOptions & { readonly codexHome?: string } = {},
  kind: SessionProviderKind = "claude",
): ClaudeCliSessionProvider {
  const { codexHome, ...shared } = options;
  if (kind === "codex") {
    return new CodexCliSessionProvider(stateRoot, { ...shared, codexHome: codexHome ?? "" });
  }
  return new ClaudeCliSessionProvider(stateRoot, shared);
}
