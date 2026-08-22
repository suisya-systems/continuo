/**
 * Single source of truth for the package version.
 *
 * Interlock has `claude_org_runtime/__about__.py` for the same reason and the
 * provenance header reads it there rather than carrying a literal: a report
 * states which build produced it, and a build that reported a version it is not
 * would be wrong in the one field a later reader uses to reproduce it
 * (`measurement-harness.md` section 6).
 *
 * A literal here rather than a read of `package.json`. The published package
 * has `dist/` at a different depth from `src/`, so a runtime read would resolve
 * differently in the two layouts and could fail in exactly the installed build
 * whose version the field is about. Instead the literal is pinned to
 * `package.json` by a test, so the two cannot drift apart silently.
 */
export const TOOL_VERSION = "0.0.0";
