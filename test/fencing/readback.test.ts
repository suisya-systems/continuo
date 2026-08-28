import { describe, expect, test } from "vitest";

import { PyTypeError } from "../../src/fencing/pysemantics.js";

import {
  allServersConnected,
  compareReadbacks,
  comparisonEqual,
  type InitReadback,
  parseInitEvent,
  ReadbackUnsound,
  readInitEvent,
} from "../../src/fencing/readback.js";

/**
 * The public effective-configuration readback, and its normalisation rule.
 *
 * Ported from interlock `tests/fencing/test_readback.py` at `65f36c5`. All 15
 * source cases map to one case here; the mapping is
 * `parity/fencing.readback.ledger.json`.
 *
 * U3 was answered in interlock's `investigation/i01-supervisor-probe.md` 3.9:
 * the `system/init` event reports `permissionMode`, `tools` and `mcp_servers`
 * -- and **no hooks and no sandbox key**. Two consequences are pinned here:
 *
 * 1. The readback is usable for permission mode, so item 3's equality check
 *    becomes *partly* runnable as written across an Interlock restart.
 * 2. The `tools` array is **not** stable across identical runs. 3.9 measured
 *    107 vs 128 tools between two runs of one configuration, the entire
 *    difference being the tool family of a single MCP server reported `pending`
 *    in one and `connected` in the other. A naive diff is therefore unsound,
 *    and the fix is in the same event: require every server `connected`, or
 *    exclude MCP tools.
 *
 * The last case of `TestTheNormalisationRule` is the point of the file: the
 * comparison **refuses** rather than returning a verdict it cannot support. A
 * flapping oracle is worse than no check.
 *
 * ## One translation decision the diff does not show
 *
 * The source's last case asserts `not hasattr(readback, "hooks")` on a frozen
 * dataclass. `hasattr` over a TypeScript interface has no runtime meaning --
 * the interface is erased -- so translating it as `"hooks" in readback` would
 * assert something the source does not: that the *object literal* has no such
 * key, which is true of every object nobody put the key on and would stay green
 * if `InitReadback` grew a `hooks` field tomorrow. The case is translated as
 * the assertion over the object's OWN KEYS, listed exhaustively, which is the
 * property the source's two `hasattr`s were reaching for and is falsifiable in
 * the direction that matters. @see the case's own note.
 */

/** The source's `init_event` helper. */
function initEvent(options: {
  readonly mode?: string;
  readonly tools: readonly unknown[];
  readonly servers: readonly (readonly [string, string])[];
}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: "11112222-3333-4444-5555-666677778888",
    permissionMode: options.mode ?? "default",
    tools: [...options.tools],
    mcp_servers: options.servers.map(([n, s]) => ({ name: n, status: s })),
  };
}

/**
 * The 3.9 measurement, reduced to its shape: one configuration, two runs, and
 * the whole difference is one server's tool family plus the three MCP-coupled
 * tool names that arrive with it.
 */
const CONTROL_A = initEvent({
  mode: "auto",
  tools: ["Bash", "Read", "Write"],
  servers: [["claude.ai Slack", "pending"]],
});
const CONTROL_B = initEvent({
  mode: "auto",
  tools: [
    "Bash",
    "Read",
    "Write",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
    "ReadMcpResourceDirTool",
    "mcp__claude_ai_Slack__slack_read_channel",
  ],
  servers: [["claude.ai Slack", "connected"]],
});

describe("TestParsing", () => {
  test("the init event is found in a stream", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "other" }),
      "",
      "not json",
      JSON.stringify(CONTROL_A),
    ];
    const readback = readInitEvent(lines);
    expect(readback.permissionMode).toBe("auto");
  });

  test("a stream with no init event is an error, not an empty readback", () => {
    expect(() => readInitEvent([JSON.stringify({ type: "assistant" })])).toThrow(ReadbackUnsound);
  });

  test("mcp server statuses are read", () => {
    const readback = parseInitEvent(CONTROL_A);
    expect(readback.mcpServers).toStrictEqual([["claude.ai Slack", "pending"]]);
    expect(allServersConnected(readback)).toBe(false);
  });
});

describe("TestAnIncompleteReadbackIsUnsoundNotEqual", () => {
  /**
   * The falsest of false positives.
   *
   * If a missing `permissionMode` defaulted to `null` and a missing `tools` to
   * `[]`, two *empty* readbacks would compare **equal** and the restart check
   * would report that the fence survived a restart it never observed.
   */
  test("a readback with no permission mode is refused", () => {
    expect(() => parseInitEvent({ type: "system", subtype: "init", tools: [] })).toThrow(
      ReadbackUnsound,
    );
  });

  test("a readback with no tools is refused", () => {
    expect(() =>
      parseInitEvent({ type: "system", subtype: "init", permissionMode: "default" }),
    ).toThrow(ReadbackUnsound);
  });

  test("a malformed tools field is refused", () => {
    expect(() =>
      parseInitEvent({ type: "system", subtype: "init", permissionMode: "d", tools: "Bash" }),
    ).toThrow(ReadbackUnsound);
  });

  test("two empty events cannot be compared into equality", () => {
    expect(() => parseInitEvent({ type: "system", subtype: "init" })).toThrow(ReadbackUnsound);
  });
});

describe("TestTheNormalisationRule", () => {
  test("two runs of one configuration differ before normalisation", () => {
    // 3.9's measurement, restated: the raw arrays are not equal.
    const a = new Set(CONTROL_A["tools"] as string[]);
    const b = new Set(CONTROL_B["tools"] as string[]);
    expect(a).not.toStrictEqual(b);
  });

  test("excluding mcp tools makes them equal", () => {
    const comparison = compareReadbacks(parseInitEvent(CONTROL_A), parseInitEvent(CONTROL_B));
    expect(comparisonEqual(comparison)).toBe(true);
    expect(comparison.normalisation).toBe("mcp-tools-excluded");
    expect(comparison.addedTools).toStrictEqual([]);
    expect(comparison.removedTools).toStrictEqual([]);
  });

  test("requiring connected refuses when a server is pending", () => {
    // The refusal, not a false mismatch.
    //
    // A restart reported as a fence change because a server was slow to connect
    // would be a false failure of item 3, and a caller who learned to ignore it
    // would be ignoring the real ones too.
    expect(() =>
      compareReadbacks(parseInitEvent(CONTROL_A), parseInitEvent(CONTROL_B), {
        requireConnected: true,
      }),
    ).toThrow(ReadbackUnsound);
  });

  test("requiring connected compares the full list when it can", () => {
    const bothConnected = initEvent({
      mode: "auto",
      tools: CONTROL_B["tools"] as unknown[],
      servers: [["claude.ai Slack", "connected"]],
    });
    const comparison = compareReadbacks(parseInitEvent(CONTROL_B), parseInitEvent(bothConnected), {
      requireConnected: true,
    });
    expect(comparisonEqual(comparison)).toBe(true);
    expect(comparison.normalisation).toBe("all-servers-connected");
  });
});

describe("TestWhatTheReadbackCanAndCannotSettle", () => {
  test("permission mode is diffable across a restart", () => {
    const before = parseInitEvent(initEvent({ mode: "default", tools: ["Bash"], servers: [] }));
    const after = parseInitEvent(initEvent({ mode: "default", tools: ["Bash"], servers: [] }));
    expect(compareReadbacks(before, after).permissionModeEqual).toBe(true);
  });

  test("a changed permission mode is caught", () => {
    const before = parseInitEvent(initEvent({ mode: "default", tools: ["Bash"], servers: [] }));
    const after = parseInitEvent(
      initEvent({ mode: "bypassPermissions", tools: ["Bash"], servers: [] }),
    );
    const comparison = compareReadbacks(before, after);
    expect(comparison.permissionModeEqual).toBe(false);
    expect(comparisonEqual(comparison)).toBe(false);
  });

  test("a genuinely changed non-mcp tool set is caught", () => {
    const before = parseInitEvent(
      initEvent({ mode: "auto", tools: ["Bash", "Read"], servers: [] }),
    );
    const after = parseInitEvent(initEvent({ mode: "auto", tools: ["Read"], servers: [] }));
    const comparison = compareReadbacks(before, after);
    expect(comparison.toolsEqual).toBe(false);
    expect(comparison.removedTools).toStrictEqual(["Bash"]);
  });

  test("the readback carries no hooks and no sandbox", () => {
    // The residual, asserted rather than described.
    //
    // This is why D-0023's weakening of item 3 is still needed: the two layers
    // the breach battery is the *only* observable for are absent from the one
    // public surface that reports anything at all.
    //
    // -- ADAPTED (D-0214) -- The source's `not hasattr(readback, "hooks")` has
    // no runtime translation: `InitReadback` is a TypeScript interface and is
    // erased, so there is no object to interrogate about a field it never
    // received. `"hooks" in readback` would be green for any object nobody
    // happened to set the key on, INCLUDING one produced by a `parseInitEvent`
    // that had grown a `hooks` field and left it `undefined` -- which is the
    // change the source's assertion exists to catch.
    //
    // So the property is asserted over the readback's OWN KEYS, exhaustively.
    // That is strictly stronger than the source's pair of `hasattr` calls: it
    // fails for `hooks`, for `sandbox`, and for any THIRD field a future
    // `parseInitEvent` starts reporting -- which is the direction a residual
    // claim has to be falsifiable in. The source's second half (the event
    // itself carries none of the three keys) translates directly.
    const readback: InitReadback = parseInitEvent(CONTROL_A);
    expect(Object.keys(readback).sort()).toStrictEqual([
      "mcpServers",
      "permissionMode",
      "sessionId",
      "tools",
    ]);
    const present = ["hooks", "sandbox", "permissions"].filter((k) => Object.hasOwn(CONTROL_A, k));
    expect(present).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// target-only: two properties of `dict.get` no source case constructs
// ---------------------------------------------------------------------------

describe("dict.get is presence, not truthiness or nullishness (target-only, D-0214)", () => {
  test("an explicitly null mcp name or status stringifies as None (target-only)", () => {
    // `entry.get("name", "")` returns the default only when the key is ABSENT.
    // A key present with the value `None` returns `None`, and `str(None)` is
    // `"None"`. The obvious TypeScript spelling -- `entry["name"] ?? ""` --
    // collapses the two, and reports an explicitly-null name as `""`, which is
    // indistinguishable from a name the CLI genuinely sent as empty. No source
    // case constructs the shape, because the source cannot get it wrong.
    const readback = parseInitEvent({
      type: "system",
      subtype: "init",
      permissionMode: "auto",
      tools: [],
      mcp_servers: [{ name: null, status: null }, { name: "s", status: "connected" }, {}],
    });
    expect(readback.mcpServers).toStrictEqual([
      ["None", "None"],
      ["s", "connected"],
      // ...and the ABSENT case still takes the defaults, which is the half that
      // would break if presence were spelled as a truthiness test instead.
      ["", "unknown"],
    ]);
    // A server reporting `None` is not `connected`, so the refusal still fires.
    expect(allServersConnected(readback)).toBe(false);
  });

  test("a non-mapping mcp_servers entry is skipped, not read as an empty one (target-only)", () => {
    // `isinstance(entry, Mapping)` is false for a list; `typeof [] === "object"`
    // in JavaScript. Without the array test a `["name", "connected"]` entry
    // would be read as a mapping with neither key and become `("", "unknown")`
    // -- a server the caller never declared, reported as not connected, which
    // turns `requireConnected` into a permanent refusal.
    const readback = parseInitEvent({
      type: "system",
      subtype: "init",
      permissionMode: "auto",
      tools: [],
      mcp_servers: [["name", "connected"], "nope", 1, { name: "s", status: "connected" }],
    });
    expect(readback.mcpServers).toStrictEqual([["s", "connected"]]);
    expect(allServersConnected(readback)).toBe(true);
  });
});

describe("a malformed mcp_servers cannot become a vacuous all-connected (target-only, D-0214)", () => {
  test("a truthy non-iterable mcp_servers raises, as the source's `for` does (target-only)", () => {
    // `for entry in payload.get("mcp_servers") or ():` raises `TypeError` on a
    // truthy non-iterable. Coercing it to "no servers" instead is the one shape
    // that turns this module's refusal OFF, and it does so silently -- see the
    // case below for what that buys.
    for (const bad of [1, "servers", true, { name: "s" }]) {
      expect(
        () =>
          parseInitEvent({
            type: "system",
            subtype: "init",
            permissionMode: "auto",
            tools: [],
            mcp_servers: bad,
          }),
        `mcp_servers: ${JSON.stringify(bad)}`,
      ).toThrow(PyTypeError);
    }
    // ...and every FALSY value is still the empty tuple, which is the source's
    // `or ()` and must not start raising.
    for (const ok of [undefined, null, [], 0, ""]) {
      const payload: Record<string, unknown> = {
        type: "system",
        subtype: "init",
        permissionMode: "auto",
        tools: [],
      };
      if (ok !== undefined) {
        payload["mcp_servers"] = ok;
      }
      expect(
        parseInitEvent(payload).mcpServers,
        `mcp_servers: ${JSON.stringify(ok)}`,
      ).toStrictEqual([]);
    }
  });

  test("what the coercion would have bought: a vacuous all-connected (target-only)", () => {
    // The consequence, asserted rather than described, because it is the reason
    // the raise above is not pedantry. `all(...)` over an EMPTY list is `true`,
    // so a readback whose `mcp_servers` could not be read would report every
    // server connected -- and `requireConnected: true`, whose entire job is to
    // refuse when a server is still `pending`, would compare the full tools
    // snapshot and call the restart sound.
    //
    // Pinned on a hand-built readback, which is the only way to reach the state
    // now that `parseInitEvent` refuses to produce it. That is the point: the
    // vacuity is a property of `all([])` and cannot be fixed downstream, so the
    // parser is the only place to stop it.
    const emptyServers: InitReadback = {
      sessionId: null,
      permissionMode: "auto",
      tools: ["Bash"],
      mcpServers: [],
    };
    expect(allServersConnected(emptyServers)).toBe(true);
    expect(() =>
      compareReadbacks(emptyServers, emptyServers, { requireConnected: true }),
    ).not.toThrow();
  });
});
