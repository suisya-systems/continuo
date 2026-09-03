import type { ClaudeCliSessionProviderOptions } from "./claude_cli_provider.js";
import { ClaudeCliSessionProvider } from "./claude_cli_provider.js";

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
 */
export function createDefaultSessionProvider(
  stateRoot: string,
  options: ClaudeCliSessionProviderOptions = {},
): ClaudeCliSessionProvider {
  return new ClaudeCliSessionProvider(stateRoot, options);
}
