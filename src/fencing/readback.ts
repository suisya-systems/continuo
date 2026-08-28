/**
 * The public effective-configuration readback, and its normalisation rule.
 *
 * Port of interlock `src/claude_org_runtime/fencing/readback.py` at `65f36c5`.
 * The 15 cases of `tests/fencing/test_readback.py` map one-to-one onto
 * `test/fencing/readback.test.ts`; the mapping is
 * `parity/fencing.readback.ledger.json`.
 *
 * U3 was answered in interlock's `investigation/i01-supervisor-probe.md` 3.9:
 * the `system/init` event on `--output-format stream-json` reports the
 * effective `permissionMode`, `tools` and `mcp_servers` -- and **no hooks and
 * no sandbox key**. That is why D-0023's weakening of item 3 is still needed,
 * and why it is *narrowed* rather than removed: permission mode gains a direct
 * readback, hooks and sandbox keep the breach battery as their only observable.
 *
 * 3.9 also found the normalisation rule this module implements. Two runs of an
 * *identical* configuration returned 107 and 128 tools; the entire difference
 * was the tool family of one MCP server reported `pending` in one run and
 * `connected` in the other. So `init` is emitted before every MCP server has
 * finished connecting, and a naive `tools` diff is unsound. A comparison is
 * sound only if every server reads `connected`, or if MCP tools are excluded
 * from it. {@link compareReadbacks} refuses to answer rather than answering
 * unsoundly -- a flapping oracle is worse than no check.
 *
 * ## What this module does NOT need from `pyjson`
 *
 * The rest of this subsystem carries a JSON number's recorded Python spelling
 * across every container rebuild (D-0210 / D-0211). This module rebuilds
 * containers -- `tools`, `mcpServers` -- and owes that obligation **nothing**,
 * for a reason that is a property of the code rather than an oversight: every
 * value it copies out of a payload has passed through `pyStr`, so no number
 * reaches any container it builds, and no rebuilt container of its own ever
 * reaches a serialiser (nothing here writes JSON). `JSON.parse` is used rather
 * than `pyJsonLoads` for the same reason, and because `read_init_event` reads a
 * stream the CLI produces rather than a document this repository round-trips.
 * A field added here that keeps a payload value **unstringified** would change
 * that; see the census in `test/fencing/spawn-precondition.test.ts`.
 */

import { pyRepr } from "./pyrepr.js";
import { pyStr } from "./pysemantics.js";

/** `MCP_TOOL_PREFIX`. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * `MCP_COUPLED_TOOLS`: tool names the CLI exposes only once an MCP server is
 * connected. i01 3.9 saw these three arrive together with the server's own
 * tool family.
 */
export const MCP_COUPLED_TOOLS: ReadonlySet<string> = new Set([
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
]);

/** `ReadbackUnsound`: the readback cannot be compared soundly, and no verdict is invented. */
export class ReadbackUnsound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadbackUnsound";
    Object.setPrototypeOf(this, ReadbackUnsound.prototype);
  }
}

/** `InitReadback`: the parts of `system/init` that bear on the fence. */
export interface InitReadback {
  readonly sessionId: string | null;
  readonly permissionMode: string | null;
  readonly tools: readonly string[];
  readonly mcpServers: readonly (readonly [name: string, status: string])[];
}

/** `InitReadback.all_servers_connected`. */
export function allServersConnected(readback: InitReadback): boolean {
  return readback.mcpServers.every(([, status]) => status === "connected");
}

/** `InitReadback.stable_tools`: the tool set with every MCP-conditioned name removed (3.9). */
export function stableTools(readback: InitReadback): ReadonlySet<string> {
  return new Set(
    readback.tools.filter(
      (name) => !name.startsWith(MCP_TOOL_PREFIX) && !MCP_COUPLED_TOOLS.has(name),
    ),
  );
}

/**
 * `_opt_str`.
 *
 * `isinstance(value, str)`, so a non-string is `null` rather than stringified
 * -- the reason `session_id: 123` does not become `"123"`.
 */
function optStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Whether `value` is a `Mapping` for the purposes this module tests it for.
 *
 * `Array.isArray` is excluded because a JSON array is not a `Mapping` in
 * Python and `typeof [] === "object"` in JavaScript -- rule 9's shape. A
 * `mcp_servers` entry given as `["name", "connected"]` is skipped by the
 * source and must be skipped here; without the array test it would be read as
 * a mapping whose `.name` and `.status` are both absent, and silently become
 * `("", "unknown")` -- a server the caller never declared, reported as not
 * connected, which turns `require_connected` into a permanent refusal.
 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `parse_init_event`: parse one `system/init` event, refusing an incomplete one.
 *
 * Defaulting a missing `permissionMode` to `null` and a missing `tools` to `[]`
 * would make two *empty* readbacks compare **equal**, and the comparison would
 * report that the fence survived a restart it never observed. An absent field
 * is an unsound readback, not a comparable one.
 */
export function parseInitEvent(payload: Record<string, unknown>): InitReadback {
  for (const key of ["permissionMode", "tools"] as const) {
    // `key not in payload`: presence, not truthiness. An explicit
    // `"permissionMode": null` is a PRESENT key with a bad value, and the
    // check below is the one that must reject it -- with the message naming
    // the value, which is the difference between "the CLI told us nothing" and
    // "the CLI told us something we do not understand".
    if (!Object.hasOwn(payload, key)) {
      // `f"...has no {key!r}"`: Python's `repr` of a `str` uses single quotes.
      throw new ReadbackUnsound(`system/init event has no '${key}'`);
    }
  }
  // `{...!r}` is `repr`, and `pyRepr` is this repository's single
  // transcription of it -- including CPython's float formatting, which
  // `String(x)` gets wrong for `1e16`. Writing a local repr for "just a message"
  // is the shape rule 11 names: the correct spelling already exists in this
  // subsystem, and a second one drifts from it silently.
  const mode = payload["permissionMode"];
  if (typeof mode !== "string" || mode === "") {
    throw new ReadbackUnsound(`permissionMode is not a mode: ${pyRepr(mode)}`);
  }
  if (!Array.isArray(payload["tools"])) {
    throw new ReadbackUnsound(`tools is not a list: ${pyRepr(payload["tools"])}`);
  }

  const servers: [string, string][] = [];
  const rawServers = payload["mcp_servers"];
  // `payload.get("mcp_servers") or ()`: a falsy value (absent, `null`, `[]`)
  // yields the empty tuple, and a non-iterable truthy value would raise in the
  // source. Only an array can be walked here, which is the same set of
  // payloads reaching the loop for every input the source's suite constructs.
  if (Array.isArray(rawServers)) {
    for (const entry of rawServers) {
      if (isMapping(entry)) {
        servers.push([pyStr(entry["name"] ?? ""), pyStr(entry["status"] ?? "unknown")]);
      }
    }
  }
  const tools = (payload["tools"] as unknown[]).map((t) => pyStr(t));
  return {
    sessionId: optStr(payload["session_id"]),
    permissionMode: optStr(payload["permissionMode"]),
    tools,
    mcpServers: servers,
  };
}

/**
 * `read_init_event`: first `{"type": "system", "subtype": "init"}` line of a
 * stream-json run.
 */
export function readInitEvent(stream: Iterable<string>): InitReadback {
  for (const raw of stream) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      // `json.JSONDecodeError`: a non-JSON line in the stream is skipped, not
      // fatal. The CLI interleaves its own diagnostics with the event stream.
      continue;
    }
    if (isMapping(payload) && payload["type"] === "system") {
      if (payload["subtype"] === "init") {
        return parseInitEvent(payload);
      }
    }
  }
  throw new ReadbackUnsound("no system/init event in the stream");
}

/** `ReadbackComparison`. */
export interface ReadbackComparison {
  readonly permissionModeEqual: boolean;
  readonly toolsEqual: boolean;
  readonly normalisation: string;
  readonly addedTools: readonly string[];
  readonly removedTools: readonly string[];
}

/** `ReadbackComparison.equal`. */
export function comparisonEqual(comparison: ReadbackComparison): boolean {
  return comparison.permissionModeEqual && comparison.toolsEqual;
}

/**
 * `compare_readbacks`: compare two readbacks across an Interlock-initiated
 * restart.
 *
 * `requireConnected: true` demands every MCP server read `connected` in both
 * runs and then compares the full tool list. The default instead drops
 * MCP-conditioned names, which is sound without waiting on connection state and
 * is what a restart check should use: a restart must not be reported as a fence
 * change because a server was slow.
 */
export function compareReadbacks(
  before: InitReadback,
  after: InitReadback,
  options: { readonly requireConnected?: boolean } = {},
): ReadbackComparison {
  const requireConnected = options.requireConnected ?? false;
  let left: ReadonlySet<string>;
  let right: ReadonlySet<string>;
  let normalisation: string;
  if (requireConnected) {
    if (!(allServersConnected(before) && allServersConnected(after))) {
      throw new ReadbackUnsound(
        "an MCP server was not 'connected'; the tools array is a snapshot of " +
          "whatever had connected at that instant (i01 3.9) and cannot be diffed",
      );
    }
    left = new Set(before.tools);
    right = new Set(after.tools);
    normalisation = "all-servers-connected";
  } else {
    left = stableTools(before);
    right = stableTools(after);
    normalisation = "mcp-tools-excluded";
  }

  return {
    permissionModeEqual: before.permissionMode === after.permissionMode,
    // `left == right` on two `frozenset`s is set equality, not identity and
    // not order. `Set` has no such operator, so it is spelled out: same size,
    // and every member of one present in the other.
    toolsEqual: setsEqual(left, right),
    normalisation,
    // `tuple(sorted(right - left))`. Python sorts strings by code POINT;
    // `Array.prototype.sort`'s default comparator sorts by UTF-16 code UNIT,
    // and the two disagree for any name outside the BMP. Tool names are ASCII
    // today, so this is the wider-type hazard of rule 9 rather than an
    // observed divergence -- spelled `codePointCompare` so it stays right when
    // one is not.
    addedTools: [...difference(right, left)].sort(codePointCompare),
    removedTools: [...difference(left, right)].sort(codePointCompare),
  };
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((value) => !b.has(value));
}

/** `sorted()` over `str`: code point order, which `localeCompare` is not. */
function codePointCompare(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const l = (left[i] as string).codePointAt(0) as number;
    const r = (right[i] as string).codePointAt(0) as number;
    if (l !== r) {
      return l - r;
    }
  }
  return left.length - right.length;
}
