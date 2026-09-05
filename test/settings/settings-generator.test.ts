import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, onTestFinished, test } from "vitest";
import { ArgparseExit, type Namespace } from "../../src/cli/parser.js";
import { buildParser as buildContinuoParser } from "../../src/cli.js";
import { pyJsonDumps, pyJsonLoads } from "../../src/fencing/pyjson.js";
import { expanduser, osJoin, osRealpath, osSep } from "../../src/fencing/pypath.js";
import { PyKeyError, PyValueError } from "../../src/fencing/pysemantics.js";
import { defaultStreams, main } from "../../src/settings/cli.js";
import {
  bundledSchemaPath,
  detectWsl,
  formatShowOutput,
  generatorSeams,
  loadSchema,
  normalizeSandboxEntry,
  type RenderResult,
  renderRole,
  renderRoleWithMetadata,
  type SandboxMetadata,
  sandboxMetadata,
} from "../../src/settings/generator.js";
import { createTempDir } from "../helpers/tmp.js";
import { patchSeam } from "../testkit/seams.js";

/**
 * The schema-driven settings generator: what it renders, what it suppresses,
 * and what it refuses.
 *
 * Ported from interlock `tests/test_settings_generator.py` at `65f36c5`. All
 * 106 source cases map to one case here; the mapping, the adapted rows and
 * their reasons are `parity/settings.settings-generator.ledger.json`.
 *
 * ## Two fixtures carry most of the weight, and both are load-bearing
 *
 * **The symlink probe is pinned off the host filesystem.** The source declares
 * an autouse fixture that replaces `generator._absolute_symlink_in_chain` with
 * "no symlinks", because these are unit tests that simulate layouts by
 * injecting `realpath_fn`, and a probe left reading the real filesystem answers
 * from whatever the runner happens to look like -- which made a fixture using
 * `/home/u/...` pass on Linux and fail on macOS. The same fixture is here, as a
 * `beforeEach` over the seam record: an ESM import binding cannot be rebound
 * from outside, so the production call site reads the probe through
 * `generatorSeams` (`docs/test-translation-conventions.md` rule 5).
 *
 * **`tmp_path` is realpath'd before it becomes a `worker_dir`.** A case that
 * asserts "an entry inside worker_dir is not suppressed" compares
 * `realpath(worker_dir + entry)` against `normpath(worker_dir)` -- the roots are
 * deliberately NOT realpath'd, because realpath'ing both sides is what would
 * make a symlink escape disappear. So the case holds only where the temp
 * directory is already its own realpath. That is true of pytest's `tmp_path` on
 * the Linux host interlock runs on, and it is NOT true on two of this port's
 * matrix cells: macOS resolves `/var` to `/private/var`, and Windows hands back
 * an 8.3 short name (`RUNNER~1`) that `realpath` expands. {@link workerDirIn}
 * restores the source's precondition rather than weakening the assertion; every
 * case still asserts exactly what its source asserts.
 */

/**
 * The source's autouse `_no_host_symlinks` fixture.
 *
 * Tests that want a symlink say so by passing `symlinkProbeFn` themselves.
 */
beforeEach(() => {
  patchSeam(generatorSeams, "absoluteSymlinkInChain", () => null);
});

/** `tmp_path`. */
function tmpPath(label = "settings"): string {
  return createTempDir(label);
}

/**
 * `os.makedirs(tmp_path / "wd")`, plus the realpath the source's host gave it
 * for free. @see the file header.
 */
function workerDirIn(root: string): string {
  const dir = join(root, "wd");
  mkdirSync(dir, { recursive: true });
  return osRealpath(dir);
}

/** `_sandbox_role`. */
function sandboxRole(
  options: {
    readonly enabled?: boolean;
    readonly denyRead?: readonly unknown[];
    readonly denyWrite?: readonly unknown[];
    readonly additional?: readonly unknown[];
    readonly failIfUnavailable?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    permissions: {
      deny: ["Bash(git push *)", "Read(.env)", "Read(**/credentials*)"],
    },
    sandbox: {
      enabled: options.enabled ?? true,
      filesystem: {
        denyRead: [...(options.denyRead ?? [])],
        denyWrite: [...(options.denyWrite ?? [])],
        additionalDirectories: [...(options.additional ?? [])],
      },
      failIfUnavailable: options.failIfUnavailable ?? false,
    },
  };
}

/** `_structured`. */
function structured(anchor: string, path: string, suppress = true): Record<string, unknown> {
  return { anchor, path, suppressOnSymlinkEscape: suppress };
}

/** `_pattern_sandbox`. */
function patternSandbox(
  options: {
    readonly denyRead?: readonly unknown[];
    readonly denyWrite?: readonly unknown[];
    readonly additional?: readonly unknown[];
  } = {},
): Record<string, unknown> {
  return {
    enabled: true,
    filesystem: {
      denyRead: [...(options.denyRead ?? [])],
      denyWrite: [...(options.denyWrite ?? [])],
      additionalDirectories: [...(options.additional ?? [])],
    },
    failIfUnavailable: false,
  };
}

/** `_pattern_role`. */
function patternRole(options: {
  readonly sandboxByPattern: Record<string, unknown>;
  readonly sandbox?: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    permissions: { deny: ["Bash(git push *)", "Read(.env)"] },
    sandbox_by_pattern: options.sandboxByPattern,
  };
  if (options.sandbox !== undefined) {
    body["sandbox"] = options.sandbox;
  }
  return body;
}

/**
 * `pytest.raises(cls)`, keeping BOTH halves: that it threw, and that it threw
 * the class the source names.
 *
 * "It threw" is satisfied by a `TypeError` from a typo in the port, which is
 * how a case stops distinguishing "the generator refused this input" from "the
 * generator crashed".
 */
function expectRaises<T extends Error>(
  errorClass: new (...args: never[]) => T,
  body: () => unknown,
): T {
  let thrown: unknown;
  let threw = false;
  try {
    body();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  expect(threw, "expected the body to throw").toBe(true);
  expect(thrown).toBeInstanceOf(errorClass);
  return thrown as T;
}

/** `redirect_stdout(buf)`. */
function captureStdout(body: () => number): [rc: number, out: string] {
  let out = "";
  patchSeam(generatorSeams, "stdout", (text: string) => {
    out += text;
  });
  return [body(), out];
}

/** `capsys.readouterr().err`. */
function captureStderr(body: () => number): [rc: number, err: string] {
  let err = "";
  patchSeam(generatorSeams, "stderr", (text: string) => {
    err += text;
  });
  return [body(), err];
}

/** `parser.parse_args(argv)` on the unified runtime parser, then `args.func`. */
function runViaRuntimeCli(argv: readonly string[]): number {
  const parser = buildContinuoParser();
  const args = parser.parseArgs(argv, defaultStreams());
  const func = args.func as (a: Namespace) => number;
  return func(args);
}

/** `generator.load_schema()`, the bundled SoT. */
function bundledSchema(): Record<string, unknown> {
  return loadSchema();
}

/** `result.settings["sandbox"]["filesystem"]`. */
function filesystemOf(result: RenderResult): Record<string, unknown> {
  const sandbox = result.settings["sandbox"] as Record<string, unknown>;
  return sandbox["filesystem"] as Record<string, unknown>;
}

/** `result.settings["permissions"]["deny"]`. */
function denyOf(result: RenderResult): string[] {
  const permissions = result.settings["permissions"] as Record<string, unknown>;
  return permissions["deny"] as string[];
}

/**
 * The `fake_realpath` the source writes over and over: `from` is a host-cross
 * symlink to `to`, and every other path resolves to itself.
 *
 * Separator-agnostic, for the reason the source spells out at its one
 * hand-written instance: a path built with `os.path.join` arrives with a `\`
 * tail on Windows, and a fake matching only `/` would silently never fire
 * there -- so the case would report "no suppression happened" for a reason with
 * nothing to do with the code under test.
 */
function escapingRealpath(from: string, to: string): (p: string) => string {
  return (p: string): string => {
    if (p === from) {
      return to;
    }
    for (const sep of ["/", osSep()]) {
      if (p.startsWith(from + sep)) {
        return to + p.slice(from.length);
      }
    }
    return p;
  };
}

/**
 * `os.environ["HOME"] = home`, restored afterwards -- and on Windows the
 * variable `ntpath.expanduser` actually reads.
 *
 * The source forces `HOME` so that `_anchor_base_path('home')` resolves to the
 * same directory its `fake_realpath` rewrites. `os.path` is a platform choice
 * and `ntpath.expanduser` reads `USERPROFILE` (then `HOMEDRIVE` + `HOMEPATH`),
 * never `HOME`, so the same intent needs both spellings here.
 *
 * **It is not outcome-determining, on either side, and this is written down
 * because the probe said so.** Removing the forcing entirely leaves both cases
 * green: a `home`-anchored entry resolves outside the `worker_dir` read root
 * whatever `home` is, so it is suppressed either way, and the assertions are
 * about the `$comment` FORMAT (`home:.aws/.env`, from the authored entry) and
 * about the layer being emptied. The forcing is what makes the scenario the
 * realistic WSL one the source describes; it is translated because it is part
 * of the source case, not because an assertion turns on it.
 */
function withHome<T>(home: string, body: () => T): T {
  const keys = process.platform === "win32" ? ["USERPROFILE", "HOMEDRIVE", "HOMEPATH"] : ["HOME"];
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }
  process.env["USERPROFILE"] = home;
  process.env["HOME"] = home;
  if (process.platform === "win32") {
    // `USERPROFILE` wins in `ntpath.expanduser`, but the pair is cleared too so
    // a stale HOMEDRIVE cannot re-enter through the fallback branch.
    delete process.env["HOMEDRIVE"];
    delete process.env["HOMEPATH"];
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** `_make_render_result_with_suppressions`: a hand-built RenderResult. */
function renderResultWithSuppressions(): RenderResult {
  const settings = {
    permissions: {
      deny: ["Bash(git push *)", "Read(.env)", "Read(**/credentials*)"],
    },
    sandbox: {
      enabled: true,
      filesystem: { denyRead: [], denyWrite: [], additionalDirectories: [] },
      failIfUnavailable: false,
    },
  };
  return {
    settings,
    sandbox: sandboxMetadata({
      enabled: true,
      wslDetected: true,
      sandboxReadRoots: ["/home/u/wd"],
      suppressions: [
        {
          layer: "sandbox.filesystem.denyRead",
          entry: "secrets.env",
          reason: "realpath escapes sandbox read roots",
          realpath: "/mnt/c/Users/u/wd/secrets.env",
          sandboxReadRoots: ["/home/u/wd"],
        },
        {
          layer: "sandbox.filesystem.denyWrite",
          entry: "*.pem",
          reason: "worker_dir realpath escapes sandbox read roots (anchored relative pattern)",
          realpath: "/mnt/c/Users/u/wd",
          sandboxReadRoots: ["/home/u/wd"],
        },
      ],
    }),
  };
}

/** `_bundled_schema()["roles"][name]`. */
function orgRole(name: string): Record<string, unknown> {
  const roles = bundledSchema()["roles"] as Record<string, unknown>;
  return roles[name] as Record<string, unknown>;
}

/** `_bundled_schema()["worker_roles"][name]["permissions"]`. */
function templatePermissions(name: string): Record<string, unknown> {
  const templates = bundledSchema()["worker_roles"] as Record<string, unknown>;
  const template = templates[name] as Record<string, unknown>;
  return template["permissions"] as Record<string, unknown>;
}

function templateAllow(name: string): string[] {
  return templatePermissions(name)["allow"] as string[];
}

function templateDeny(name: string): string[] {
  return templatePermissions(name)["deny"] as string[];
}

/** `DOCKER_BUILD_ALLOW`. */
const DOCKER_BUILD_ALLOW: readonly string[] = [
  "Bash(docker build:*)",
  "Bash(docker buildx build:*)",
  "Bash(docker images:*)",
  "Bash(docker image inspect:*)",
];

describe("rendering a role", () => {
  test("the bundled schema loads", () => {
    const schema = loadSchema();
    expect(schema).toBeTypeOf("object");
    expect(Object.hasOwn(schema, "worker_roles")).toBe(true);
    expect(schema["worker_roles"]).toBeTypeOf("object");
  });

  test("the bundled schema is a valid JSON file", () => {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(bundledSchemaPath()),
    );
    const parsed = pyJsonLoads(text) as Record<string, unknown>;
    expect(parsed["version"] as number).toBeGreaterThanOrEqual(1);
  });

  test("render_role substitutes placeholders", () => {
    const schema = {
      worker_roles: {
        demo: {
          description: "ignored",
          $comment: "ignored",
          permissions: {
            allow: ["Read({worker_dir}/**)", "Bash(test {claude_org_path})"],
          },
          hooks: { on_stop: [{ path: "{claude_org_path}/hook.sh" }] },
        },
      },
    };
    const out = renderRole(schema, {
      role: "demo",
      workerDir: "/tmp/wd",
      claudeOrgPath: "/tmp/co",
    });
    expect(Object.hasOwn(out, "description")).toBe(false);
    expect(Object.hasOwn(out, "$comment")).toBe(false);
    const allow = (out["permissions"] as Record<string, unknown>)["allow"] as string[];
    expect(allow[0]).toBe("Read(/tmp/wd/**)");
    expect(allow[1]).toBe("Bash(test /tmp/co)");
    const onStop = (out["hooks"] as Record<string, unknown>)["on_stop"] as Record<
      string,
      unknown
    >[];
    expect((onStop[0] as Record<string, unknown>)["path"]).toBe("/tmp/co/hook.sh");
  });

  test("render_role raises KeyError for an unknown role", () => {
    const schema = { worker_roles: { a: {}, $ignored: {} } };
    const error = expectRaises(PyKeyError, () =>
      renderRole(schema, { role: "nope", workerDir: "/", claudeOrgPath: "/" }),
    );
    expect(error.args[0] as string).toContain("unknown worker role");
  });

  test("a $-prefixed key is not addressable as a role", () => {
    const schema = { worker_roles: { $special: { x: 1 } } };
    expectRaises(PyKeyError, () =>
      renderRole(schema, { role: "$special", workerDir: "/", claudeOrgPath: "/" }),
    );
  });

  test("the CLI writes to the --out file", () => {
    const root = tmpPath();
    const out = join(root, "settings.local.json");
    const rc = main([
      "--role",
      "default",
      "--worker-dir",
      join(root, "wd"),
      "--claude-org-path",
      join(root, "co"),
      "--out",
      out,
    ]);
    expect(rc).toBe(0);
    const parsed = pyJsonLoads(readFileSync(out, "utf8"));
    expect(parsed).toBeTypeOf("object");
    expect(Array.isArray(parsed)).toBe(false);
  });

  test("the CLI returns 2 for an unknown role", () => {
    const root = tmpPath();
    const [rc] = captureStderr(() =>
      main(["--role", "nope-not-a-role", "--worker-dir", root, "--claude-org-path", root]),
    );
    expect(rc).toBe(2);
  });

  test("the CLI honours a --schema override", () => {
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(schemaPath, JSON.stringify({ worker_roles: { x: { k: "{worker_dir}" } } }), {
      encoding: "utf8",
    });
    const out = join(root, "out.json");
    const rc = main([
      "--role",
      "x",
      "--worker-dir",
      "/wd",
      "--claude-org-path",
      "/co",
      "--schema",
      schemaPath,
      "--out",
      out,
    ]);
    expect(rc).toBe(0);
    expect(pyJsonLoads(readFileSync(out, "utf8"))).toStrictEqual({ k: "/wd" });
  });
});

describe("bundled schema sanity (the SoT shipped to consumers)", () => {
  test("the canonical default role renders from the bundled schema", () => {
    const out = renderRole(loadSchema(), {
      role: "default",
      workerDir: "C:/tmp/worker",
      claudeOrgPath: "C:/tmp/claude-org",
    });
    // Output must be JSON-serialisable and shaped like a settings.local.json.
    const text = pyJsonDumps(out);
    expect(text).not.toContain("{worker_dir}");
    expect(text).not.toContain("{claude_org_path}");
  });
});

describe("case E: sandbox and WSL/realpath suppression", () => {
  test("sandbox.enabled=false passes the structure through untouched", () => {
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          enabled: false,
          denyRead: ["/mnt/c/Users/somebody/secrets.env"],
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/work/wd",
      claudeOrgPath: "/home/u/co",
      wslDetector: () => true,
    });
    expect(result.sandbox.enabled).toBe(false);
    expect(result.sandbox.suppressions).toStrictEqual([]);
    const fs = filesystemOf(result);
    expect(fs["denyRead"]).toStrictEqual(["/mnt/c/Users/somebody/secrets.env"]);
  });

  test("a role without a sandbox field renders unchanged", () => {
    const schema = { worker_roles: { demo: { permissions: { deny: ["Read(.env)"] } } } };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/work/wd",
      claudeOrgPath: "/home/u/co",
      wslDetector: () => false,
    });
    expect(Object.hasOwn(result.settings, "sandbox")).toBe(false);
    expect(result.sandbox.enabled).toBe(false);
    expect(result.sandbox.suppressions).toStrictEqual([]);
  });

  test("non-WSL Linux: deny entries that stay inside worker_dir do not fire", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env", "subdir/private"] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      wslDetector: () => false,
    });
    expect(result.sandbox.wslDetected).toBe(false);
    expect(result.sandbox.enabled).toBe(true);
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual(["secrets.env", "subdir/private"]);
  });

  test("WSL: a worker_dir-relative entry whose realpath escapes is suppressed", () => {
    const workerDir = "/home/u/work/wd";
    const fakeRealpath = escapingRealpath(workerDir, "/mnt/c/Users/u/work/wd");
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: ["secrets.env"], denyWrite: ["build/"], additional: [] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: fakeRealpath,
      wslDetector: () => true,
    });
    expect(result.sandbox.wslDetected).toBe(true);
    const suppressed = result.sandbox.suppressions.map((s) => [s.layer, s.entry]);
    expect(suppressed).toContainEqual(["sandbox.filesystem.denyRead", "secrets.env"]);
    expect(suppressed).toContainEqual(["sandbox.filesystem.denyWrite", "build/"]);
    const fs = filesystemOf(result);
    expect(fs["denyRead"]).toStrictEqual([]);
    expect(fs["denyWrite"]).toStrictEqual([]);
    // Layer 2 permissions.deny is preserved untouched.
    const deny = denyOf(result);
    expect(deny).toContain("Read(.env)");
    expect(deny).toContain("Read(**/credentials*)");
  });

  test("WSL: a realpath that stays inside additionalDirectories is not suppressed", () => {
    const workerDir = "/home/u/work/wd";
    const fakeRealpath = escapingRealpath(workerDir, "/mnt/c/Users/u/work/wd");
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: ["/mnt/c"] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: fakeRealpath,
      wslDetector: () => true,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual(["secrets.env"]);
  });

  test("a devcontainer-like /workspaces symlink escape suppresses", () => {
    const workerDir = "/home/u/wd";
    const fakeRealpath = escapingRealpath(workerDir, "/workspaces/repo");
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: [] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: fakeRealpath,
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toHaveLength(1);
    const s = result.sandbox.suppressions[0] as SandboxMetadata["suppressions"][number];
    expect(s.entry).toBe("secrets.env");
    expect(s.realpath.startsWith("/workspaces/")).toBe(true);
    expect(s.reason).toContain("escapes sandbox read roots");
  });

  test("relative pure-glob patterns survive when worker_dir is reachable", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: ["**/credentials*", "*.pem"], additional: [] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual(["**/credentials*", "*.pem"]);
  });

  test("a relative pure-glob anchored at an escaping worker_dir is suppressed", () => {
    const workerDir = "/home/u/wd";
    const fakeRealpath = escapingRealpath(workerDir, "/mnt/c/Users/u/wd");
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: ["**/credentials*", "*.pem"], additional: [] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: fakeRealpath,
      wslDetector: () => true,
    });
    const suppressed = result.sandbox.suppressions.map((s) => [s.layer, s.entry]);
    expect(suppressed).toContainEqual(["sandbox.filesystem.denyRead", "**/credentials*"]);
    expect(suppressed).toContainEqual(["sandbox.filesystem.denyRead", "*.pem"]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual([]);
    // The reason names worker_dir, so operators can see why a glob without an
    // anchored prefix was dropped.
    expect(result.sandbox.suppressions.some((s) => s.reason.includes("worker_dir"))).toBe(true);
  });

  test("absolute pure-glob patterns are kept unchanged", () => {
    const workerDir = "/home/u/wd";
    const fakeRealpath = escapingRealpath(workerDir, "/mnt/c/Users/u/wd");
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: ["/*"], additional: [] }) } };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: fakeRealpath,
      wslDetector: () => true,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual(["/*"]);
  });

  test("_detect_wsl reads the kernel marker from the supplied probe files", () => {
    const root = tmpPath();
    const procVersion = join(root, "version");
    const osrelease = join(root, "osrelease");
    writeFileSync(procVersion, "Linux x.y.z (gcc) #1 SMP\n", { encoding: "utf8" });
    writeFileSync(osrelease, "5.15.123-microsoft-standard-WSL2\n", { encoding: "utf8" });
    expect(detectWsl([procVersion, osrelease])).toBe(true);
  });

  test("_detect_wsl answers false when no marker is present", () => {
    const root = tmpPath();
    const procVersion = join(root, "version");
    const osrelease = join(root, "osrelease");
    writeFileSync(procVersion, "Linux 6.6.0-1-amd64 #1 SMP\n", { encoding: "utf8" });
    writeFileSync(osrelease, "6.6.0-1-amd64\n", { encoding: "utf8" });
    expect(detectWsl([procVersion, osrelease])).toBe(false);
  });

  test("WSL1 is detected from Microsoft in /proc/version", () => {
    const root = tmpPath();
    const procVersion = join(root, "version");
    const osrelease = join(root, "osrelease");
    writeFileSync(procVersion, "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)\n", {
      encoding: "utf8",
    });
    writeFileSync(osrelease, "4.4.0-19041-Microsoft\n", { encoding: "utf8" });
    expect(detectWsl([procVersion, osrelease])).toBe(true);
  });

  test("a WSL token in /proc/version alone is enough", () => {
    const root = tmpPath();
    const procVersion = join(root, "version");
    const osrelease = join(root, "osrelease");
    writeFileSync(procVersion, "Linux version 5.15.0-microsoft-standard-WSL2 (root@host)\n", {
      encoding: "utf8",
    });
    writeFileSync(osrelease, "6.6.0-1-amd64\n", { encoding: "utf8" });
    expect(detectWsl([procVersion, osrelease])).toBe(true);
  });

  test("a missing osrelease does not block detection from /proc/version", () => {
    const root = tmpPath();
    const procVersion = join(root, "version");
    writeFileSync(procVersion, "Linux version 5.15.0-microsoft-standard-WSL2\n", {
      encoding: "utf8",
    });
    expect(detectWsl([procVersion, join(root, "does-not-exist")])).toBe(true);
  });

  test("settings show --explain text output surfaces the suppression sections", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const co = join(root, "co");
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: [] }) },
      }),
      { encoding: "utf8" },
    );
    const [rc, out] = captureStdout(() =>
      runViaRuntimeCli([
        "settings",
        "show",
        "--role",
        "demo",
        "--worker-dir",
        workerDir,
        "--claude-org-path",
        co,
        "--schema",
        schemaPath,
        "--explain",
      ]),
    );
    expect(rc).toBe(0);
    expect(out).toContain("suppressions");
    expect(out).toContain("wsl_detected");
    expect(out).toContain("sandbox.enabled: True");
    expect(out).toContain("permissions.deny");
  });

  test("settings show --explain --json emits a structured payload", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const co = join(root, "co");
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: [] }) },
      }),
      { encoding: "utf8" },
    );
    const [rc, out] = captureStdout(() =>
      runViaRuntimeCli([
        "settings",
        "show",
        "--role",
        "demo",
        "--worker-dir",
        workerDir,
        "--claude-org-path",
        co,
        "--schema",
        schemaPath,
        "--explain",
        "--json",
      ]),
    );
    expect(rc).toBe(0);
    const payload = pyJsonLoads(out) as Record<string, unknown>;
    expect(payload["role"]).toBe("demo");
    expect(Object.hasOwn(payload, "settings")).toBe(true);
    expect(Object.hasOwn(payload, "sandbox")).toBe(true);
    const sandbox = payload["sandbox"] as Record<string, unknown>;
    expect(Object.hasOwn(sandbox, "suppressions")).toBe(true);
    expect(Object.hasOwn(sandbox, "sandbox_read_roots")).toBe(true);
  });

  test("bare settings show --json omits the suppression metadata", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const co = join(root, "co");
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({ worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"] }) } }),
      { encoding: "utf8" },
    );
    const [rc, out] = captureStdout(() =>
      runViaRuntimeCli([
        "settings",
        "show",
        "--role",
        "demo",
        "--worker-dir",
        workerDir,
        "--claude-org-path",
        co,
        "--schema",
        schemaPath,
        "--json",
      ]),
    );
    expect(rc).toBe(0);
    const payload = pyJsonLoads(out) as Record<string, unknown>;
    expect(Object.hasOwn(payload, "sandbox")).toBe(false);
    const settings = payload["settings"] as Record<string, unknown>;
    expect((settings["sandbox"] as Record<string, unknown>)["enabled"]).toBe(true);
  });

  test("the text --explain output renders every suppressed entry's reason", () => {
    const result = renderResultWithSuppressions();
    const text = formatShowOutput(result, "demo", { explain: true, asJson: false });
    expect(text).toContain("wsl_detected: True");
    expect(text).toContain("sandbox_read_roots (1):");
    expect(text).toContain("  - /home/u/wd");
    expect(text).toContain("suppressions (2):");
    expect(text).toContain("sandbox.filesystem.denyRead");
    expect(text).toContain("secrets.env");
    expect(text).toContain("realpath escapes sandbox read roots");
    expect(text).toContain("sandbox.filesystem.denyWrite");
    expect(text).toContain("*.pem");
    expect(text).toContain("worker_dir realpath escapes");
    // Layer 2 deny is preserved in the output.
    expect(text).toContain("Read(.env)");
    expect(text).toContain("Read(**/credentials*)");
  });

  test("the JSON --explain payload carries structured suppression entries", () => {
    const result = renderResultWithSuppressions();
    const text = formatShowOutput(result, "demo", { explain: true, asJson: true });
    const payload = pyJsonLoads(text) as Record<string, unknown>;
    expect(payload["role"]).toBe("demo");
    const sandbox = payload["sandbox"] as Record<string, unknown>;
    expect(sandbox["wsl_detected"]).toBe(true);
    const suppressions = sandbox["suppressions"] as Record<string, unknown>[];
    expect(suppressions).toHaveLength(2);
    expect(new Set(suppressions.map((s) => s["layer"]))).toStrictEqual(
      new Set(["sandbox.filesystem.denyRead", "sandbox.filesystem.denyWrite"]),
    );
    expect(new Set(suppressions.map((s) => s["entry"]))).toStrictEqual(
      new Set(["secrets.env", "*.pem"]),
    );
    for (const s of suppressions) {
      expect(Object.hasOwn(s, "realpath")).toBe(true);
      expect(s["realpath"]).toBeTruthy();
      expect(s["sandbox_read_roots"]).toStrictEqual(["/home/u/wd"]);
    }
    const settings = payload["settings"] as Record<string, unknown>;
    const deny = (settings["permissions"] as Record<string, unknown>)["deny"] as string[];
    expect(deny).toContain("Read(.env)");
  });

  test("without --explain the text output skips the suppression sections", () => {
    const result = renderResultWithSuppressions();
    const text = formatShowOutput(result, "demo", { explain: false, asJson: false });
    expect(text).not.toContain("wsl_detected");
    expect(text).not.toContain("suppressions");
    expect(text).toContain("permissions.deny");
    expect(text).toContain("sandbox.enabled: True");
  });

  test("the render_role shim still returns just the rendered dict", () => {
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"] }) } };
    const out = renderRole(schema, {
      role: "demo",
      workerDir: "/tmp/wd",
      claudeOrgPath: "/tmp/co",
    });
    expect(out).toBeTypeOf("object");
    expect(Object.hasOwn(out, "sandbox")).toBe(true);
  });
});

describe("case E: the $comment suppression metadata field", () => {
  test("a WSL escape suppression emits $comment with platform=wsl", () => {
    // Mirrors the typical production WSL layout: `worker_dir` lives on the
    // Linux side and is NOT a host-cross symlink, while only `~/.aws` and
    // `~/.ssh` resolve into `/mnt/c/...`.
    const workerDir = "/home/u/work/wd";
    const home = "/home/u";
    const fakeRealpath = (p: string): string => {
      for (const dir of [`${home}/.aws`, `${home}/.ssh`]) {
        if (p === dir || p.startsWith(`${dir}/`) || p.startsWith(dir + osSep())) {
          return `/mnt/c/Users/u${p.slice(home.length)}`;
        }
      }
      return p;
    };
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          denyRead: [structured("home", ".aws/.env"), structured("home", ".ssh/id_rsa")],
          denyWrite: [structured("home", ".aws/credentials")],
          additional: [],
        }),
      },
    };
    const result = withHome(home, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir,
        claudeOrgPath: "/home/u/co",
        realpathFn: fakeRealpath,
        wslDetector: () => true,
      }),
    );
    const comment = result.settings["$comment"];
    expect(comment).toBeTypeOf("string");
    // Fixed prefix: the launcher's /sandbox status parses it.
    expect((comment as string).startsWith("platform=wsl, layer-3 entries suppressed: [")).toBe(
      true,
    );
    expect((comment as string).endsWith("]")).toBe(true);
    expect(comment).toContain("home:.aws/.env");
    expect(comment).toContain("home:.ssh/id_rsa");
    expect(comment).toContain("home:.aws/credentials");
    const fs = filesystemOf(result);
    expect(fs["denyRead"]).toStrictEqual([]);
    expect(fs["denyWrite"]).toStrictEqual([]);
  });

  test("a non-WSL escape emits a platform=linux comment", () => {
    const workerDir = "/home/u/wd";
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: [] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, "/workspaces/repo"),
      wslDetector: () => false,
    });
    const comment = result.settings["$comment"];
    expect(comment).toBeTypeOf("string");
    expect((comment as string).startsWith("platform=linux, layer-3 entries suppressed: [")).toBe(
      true,
    );
    expect(comment).toContain("secrets.env");
  });

  test("no suppression means no $comment field", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: [] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(Object.hasOwn(result.settings, "$comment")).toBe(false);
  });

  test("sandbox.enabled=false short-circuits before any suppression or comment", () => {
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          enabled: false,
          denyRead: ["/mnt/c/Users/somebody/secrets.env"],
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/work/wd",
      claudeOrgPath: "/home/u/co",
      wslDetector: () => true,
    });
    expect(Object.hasOwn(result.settings, "$comment")).toBe(false);
  });

  test("structured entries surface as <anchor>:<path> in the comment list", () => {
    const workerDir = "/home/u/work/wd";
    const fakeRealpath = (p: string): string => {
      if (p === "/home/u" || p === "/home/u/") {
        return "/mnt/c/Users/u";
      }
      if (p.startsWith("/home/u/") || p.startsWith(`/home/u${osSep()}`)) {
        return `/mnt/c/Users/u${p.slice("/home/u".length)}`;
      }
      return p;
    };
    const structuredEntry = structured("home", ".aws/.env");
    const absEntry = structured("absolute", "/mnt/c/Users/u/Windows/secret");
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structuredEntry, absEntry], additional: [] }),
      },
    };
    const result = withHome("/home/u", () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir,
        claudeOrgPath: "/home/u/co",
        realpathFn: fakeRealpath,
        wslDetector: () => true,
      }),
    );
    const comment = result.settings["$comment"] as string;
    expect(comment).toContain("home:.aws/.env");
    // `absolute` anchor: the path is already self-explanatory, so the prefix is
    // omitted.
    expect(comment).toContain("/mnt/c/Users/u/Windows/secret");
    expect(comment).not.toContain("absolute:");
  });

  test("permissions.deny survives Layer 3 suppression", () => {
    const workerDir = "/home/u/work/wd";
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: [] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/work/wd"),
      wslDetector: () => true,
    });
    const deny = denyOf(result);
    expect(deny).toContain("Read(.env)");
    expect(deny).toContain("Read(**/credentials*)");
    expect(Object.hasOwn(result.settings, "$comment")).toBe(true);
  });

  test("bare settings show text surfaces the runtime $comment line", () => {
    const workerDir = "/home/u/work/wd";
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"], additional: [] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/work/wd"),
      wslDetector: () => true,
    });
    const text = formatShowOutput(result, "demo", { explain: false, asJson: false });
    expect(text).toContain("$comment: platform=wsl, layer-3 entries suppressed: [");
    // Without --explain the per-entry suppression block stays absent.
    expect(text).not.toContain("suppressions (");
  });
});

describe("structured anchors, role_kind and Pattern B context", () => {
  test("a surviving structured entry is normalised to its absolute-path string", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const entry = structured("worker_dir", "secrets.env");
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: [entry] }) } };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual([osJoin(workerDir, "secrets.env")]);
  });

  test("kept structured entries emit only strings, never a dict", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const entries = [
      structured("worker_dir", ".env"),
      structured("worker_dir", ".env.*"),
      structured("worker_dir", "**/credentials*"),
      structured("worker_dir", "**/*.pem"),
    ];
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: entries }) } };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    const denyRead = filesystemOf(result)["denyRead"] as unknown[];
    // The whole point of the fix: no structured dict leaks into the file.
    expect(denyRead.every((e) => typeof e === "string")).toBe(true);
    expect(denyRead).toStrictEqual([
      osJoin(workerDir, ".env"),
      osJoin(workerDir, ".env.*"),
      osJoin(workerDir, "**/credentials*"),
      osJoin(workerDir, "**/*.pem"),
    ]);
  });

  test("mixed legacy and structured entries both render correctly", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: ["secrets.env", structured("worker_dir", "private.key")] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    const kept = filesystemOf(result)["denyRead"] as unknown[];
    expect(kept[0]).toBe("secrets.env");
    expect(kept[1]).toBe(osJoin(workerDir, "private.key"));
  });

  test("anchor=home resolves the entry against the home directory", () => {
    const workerDir = "/home/u/work/wd";
    const home = expanduser("~");
    const captured: string[] = [];
    const fakeRealpath = (p: string): string => {
      captured.push(p);
      return p;
    };
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structured("home", ".aws/credentials")], additional: [] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: fakeRealpath,
      wslDetector: () => true,
    });
    expect(result.sandbox.suppressions).toHaveLength(1);
    const expectedTarget = osJoin(home, ".aws/credentials");
    expect(captured).toContain(expectedTarget);
    expect((result.sandbox.suppressions[0] as { realpath: string }).realpath).toBe(expectedTarget);
    expect(denyOf(result)).toContain("Read(.env)");
  });

  test("anchor=home is reachable when home is a sandbox read root", () => {
    const workerDir = "/home/u/work/wd";
    const home = expanduser("~");
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          denyRead: [structured("home", ".aws/credentials")],
          additional: [home],
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
  });

  test("anchor=absolute treats the path literally, with no anchor-base join", () => {
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          denyRead: [structured("absolute", "/etc/shadow")],
          additional: ["/etc"],
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/wd",
      claudeOrgPath: "/home/u/co",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect((filesystemOf(result)["denyRead"] as unknown[])[0]).toBe("/etc/shadow");
  });

  test("anchor=claude_org_path uses the claude_org_path base", () => {
    const co = "/home/u/claude-org";
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          denyRead: [structured("claude_org_path", "secrets/api.key")],
          additional: [co],
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/wd",
      claudeOrgPath: co,
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
  });

  test("suppressOnSymlinkEscape=false keeps the entry when realpath escapes", () => {
    const workerDir = "/home/u/work/wd";
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structured("worker_dir", "secrets.env", false)] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/work/wd"),
      wslDetector: () => true,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    // The entry is kept and normalised to its absolute-path string;
    // suppressOnSymlinkEscape is authoring-only metadata.
    expect((filesystemOf(result)["denyRead"] as unknown[])[0]).toBe(
      osJoin(workerDir, "secrets.env"),
    );
  });

  test("opting out of suppression does not opt out of canonicalisation", () => {
    const workerDir = "/home/u/work/wd";
    const escaped = "/mnt/c/Users/u/work/wd";
    // Separator-agnostic on purpose: the kept entry is built with `os.path.join`,
    // so the tail arrives as `/secrets.env` on POSIX and `\secrets.env` on
    // Windows. Matching only the forward slash would make this fake silently
    // never fire there, and the case would report "no rewrite happened" for a
    // reason with nothing to do with the code under test.
    const fakeRealpath = (p: string): string => {
      if (p === workerDir) {
        return escaped;
      }
      for (const sep of ["/", osSep()]) {
        if (p.startsWith(workerDir + sep)) {
          return escaped + p.slice(workerDir.length);
        }
      }
      return p;
    };
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structured("worker_dir", "secrets.env", false)] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: fakeRealpath,
      wslDetector: () => true,
      symlinkProbeFn: (path: string) => (path.startsWith(workerDir) ? workerDir : null),
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect((filesystemOf(result)["denyRead"] as unknown[])[0]).toBe(osJoin(escaped, "secrets.env"));
    expect(result.sandbox.rewrites).toHaveLength(1);
  });

  test("Pattern B placeholders are substituted in entry paths and additionalDirectories", () => {
    const baseClone = "/home/u/base";
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          denyRead: [structured("absolute", "{base_clone}/.git/config")],
          additional: ["{base_clone}/.git"],
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/work/wd",
      claudeOrgPath: "/home/u/co",
      baseClone,
      taskId: "demo-task",
      branchRef: "feat/x",
      pattern: "B",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    const fs = filesystemOf(result);
    expect(fs["additionalDirectories"]).toStrictEqual([`${baseClone}/.git`]);
    expect((fs["denyRead"] as unknown[])[0]).toBe(`${baseClone}/.git/config`);
    expect(result.sandbox.suppressions).toStrictEqual([]);
  });

  test("legacy string entries also see Pattern B substitution before realpath", () => {
    const baseClone = "/home/u/base";
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: ["{base_clone}/.git/HEAD"], additional: [] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/work/wd",
      claudeOrgPath: "/home/u/co",
      baseClone,
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    expect(result.sandbox.suppressions).toHaveLength(1);
    expect((result.sandbox.suppressions[0] as { realpath: string }).realpath).toBe(
      `${baseClone}/.git/HEAD`,
    );
  });

  test("role_kind=org looks the role up under schema.roles", () => {
    const schema = {
      roles: {
        secretary: {
          description: "Secretary",
          settings_paths: [".claude/settings.local.json"],
          sandbox: {
            enabled: true,
            filesystem: {
              denyRead: [structured("home", ".ssh/id_rsa")],
              denyWrite: [],
              additionalDirectories: [],
            },
            failIfUnavailable: false,
          },
        },
        $comment_irrelevant: "ignored",
      },
      worker_roles: {},
    };
    const result = renderRoleWithMetadata(schema, {
      role: "secretary",
      roleKind: "org",
      workerDir: "/home/u/wd",
      claudeOrgPath: "/home/u/co",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    expect(Object.hasOwn(result.settings, "description")).toBe(false);
    expect(result.settings["settings_paths"]).toStrictEqual([".claude/settings.local.json"]);
    expect(result.sandbox.suppressions).toHaveLength(1);
    expect((result.sandbox.suppressions[0] as { layer: string }).layer).toBe(
      "sandbox.filesystem.denyRead",
    );
  });

  test("role_kind=org for an unknown role raises an org-role-flavoured KeyError", () => {
    const schema = { roles: { secretary: {} }, worker_roles: {} };
    const error = expectRaises(PyKeyError, () =>
      renderRoleWithMetadata(schema, {
        role: "nope",
        roleKind: "org",
        workerDir: "/wd",
        claudeOrgPath: "/co",
      }),
    );
    expect(error.args[0] as string).toContain("unknown org role");
  });

  test("an unknown role_kind is rejected up front", () => {
    const schema = { worker_roles: { demo: {} } };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        roleKind: "bogus",
        workerDir: "/wd",
        claudeOrgPath: "/co",
      }),
    );
    expect(error.message).toContain("unknown role_kind");
  });

  test("a structured entry with an invalid anchor is kept untouched, and refuses (D-0094)", () => {
    // ADAPTED (D-0094). The source asserts the PASS leaves the entry alone --
    // no anchoring, no substitution, no suppression -- and then that the entry
    // is WRITTEN. The first half is unchanged and is what the refusal quotes:
    // an entry the pass had touched would appear in the message as something
    // other than the dict authored below. The second half is the premise
    // D-0093 measured false, so the document is refused instead of written.
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const weird = { anchor: "moon", path: "x", suppressOnSymlinkEscape: true };
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: [weird] }) } };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir,
        claudeOrgPath: join(root, "co"),
        wslDetector: () => false,
      }),
    );
    expect(error.message).toContain("sandbox.filesystem.denyRead[0]");
    expect(error.message, "quoted as authored, so the pass demonstrably left it alone").toContain(
      "{'anchor': 'moon', 'path': 'x', 'suppressOnSymlinkEscape': True}",
    );
  });

  test("a legacy absolute string normalises to anchor=absolute", () => {
    const norm = normalizeSandboxEntry("/etc/shadow");
    expect(norm).not.toBeNull();
    expect(norm?.anchor).toBe("absolute");
    expect(norm?.path).toBe("/etc/shadow");
    expect(norm?.suppressOnSymlinkEscape).toBe(true);
  });

  test("a legacy relative string normalises to anchor=worker_dir", () => {
    const norm = normalizeSandboxEntry("secrets.env");
    expect(norm).not.toBeNull();
    expect(norm?.anchor).toBe("worker_dir");
    expect(norm?.path).toBe("secrets.env");
    expect(norm?.suppressOnSymlinkEscape).toBe(true);
  });

  test("a structured entry without suppressOnSymlinkEscape defaults to true", () => {
    const norm = normalizeSandboxEntry({ anchor: "home", path: ".aws/credentials" });
    expect(norm).not.toBeNull();
    expect(norm?.anchor).toBe("home");
    expect(norm?.suppressOnSymlinkEscape).toBe(true);
  });

  test("the text rendering of a structured entry produces a readable line", () => {
    const settings = {
      permissions: { deny: [] },
      sandbox: {
        enabled: true,
        filesystem: {
          denyRead: [structured("home", ".aws/credentials")],
          denyWrite: [],
          additionalDirectories: [],
        },
        failIfUnavailable: false,
      },
    };
    const result: RenderResult = { settings, sandbox: sandboxMetadata() };
    const text = formatShowOutput(result, "demo", { explain: false, asJson: false });
    expect(text).toContain("sandbox.filesystem.denyRead (1):");
    // The structured entry is rendered via its repr / dict form.
    expect(text).toContain("anchor");
    expect(text).toContain(".aws/credentials");
  });

  test("the pre-Phase-1 positional signature still works", () => {
    const root = tmpPath();
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"] }) } };
    const out = renderRole(schema, {
      role: "demo",
      workerDir: join(root, "wd"),
      claudeOrgPath: join(root, "co"),
    });
    expect(out).toBeTypeOf("object");
    expect(Array.isArray(out)).toBe(false);
  });
});

describe("strict bool, malformed absolute, additionalDirectories and CLI plumbing", () => {
  test("a non-bool suppressOnSymlinkEscape passes the entry through as-is, and refuses (D-0094)", () => {
    // ADAPTED (D-0094), on the same terms as the invalid-anchor case above: the
    // source's "passes through as-is" is what the refusal quotes, and its "and
    // is written" is the half D-0093 falsified. The escaping realpath is kept
    // so the entry still travels the branch that would have suppressed it had
    // `normalizeSandboxEntry` accepted the string flag.
    const workerDir = "/home/u/work/wd";
    const bad = { anchor: "worker_dir", path: "secrets.env", suppressOnSymlinkEscape: "false" };
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: [bad] }) } };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir,
        claudeOrgPath: "/home/u/co",
        realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/work/wd"),
        wslDetector: () => true,
      }),
    );
    expect(error.message).toContain(
      "{'anchor': 'worker_dir', 'path': 'secrets.env', 'suppressOnSymlinkEscape': 'false'}",
    );
  });

  test("_normalize_sandbox_entry rejects non-bool suppress flags", () => {
    expect(
      normalizeSandboxEntry({ anchor: "worker_dir", path: "x", suppressOnSymlinkEscape: "true" }),
    ).toBeNull();
    expect(
      normalizeSandboxEntry({ anchor: "worker_dir", path: "x", suppressOnSymlinkEscape: 1 }),
    ).toBeNull();
  });

  test("anchor=absolute with a relative path is malformed, kept as-is, and refuses (D-0094)", () => {
    // ADAPTED (D-0094). Unchanged: the malformed entry is NOT anchored against
    // CWD or against any other base -- the refusal quotes `etc/shadow`, not a
    // resolved path. Changed: the document is refused rather than written,
    // because the reader that was supposed to surface this to the operator
    // accepts the file and voids the fence instead (D-0093).
    const bad = { anchor: "absolute", path: "etc/shadow", suppressOnSymlinkEscape: true };
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: [bad], additional: [] }) } };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/home/u/wd",
        claudeOrgPath: "/home/u/co",
        realpathFn: (p) => p,
        wslDetector: () => false,
      }),
    );
    expect(error.message).toContain(
      "{'anchor': 'absolute', 'path': 'etc/shadow', 'suppressOnSymlinkEscape': True}",
    );
    expect(error.message, "the refusal names what a run would lose").toContain("D-0093");
  });

  test("an absent additionalDirectories stays absent", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const schema = {
      worker_roles: {
        demo: {
          permissions: { deny: [] },
          sandbox: {
            enabled: true,
            filesystem: { denyRead: ["secrets.env"], denyWrite: [] },
            failIfUnavailable: false,
          },
        },
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      wslDetector: () => false,
    });
    const fs = filesystemOf(result);
    expect(Object.hasOwn(fs, "additionalDirectories")).toBe(false);
    expect(fs["denyRead"]).toStrictEqual(["secrets.env"]);
  });

  test("settings generate --role-kind org is rejected with a helpful message", () => {
    const root = tmpPath();
    const [rc, err] = captureStderr(() =>
      main([
        "--role",
        "secretary",
        "--role-kind",
        "org",
        "--worker-dir",
        join(root, "wd"),
        "--claude-org-path",
        join(root, "co"),
      ]),
    );
    expect(rc).toBe(2);
    expect(err).toContain("settings generate");
    expect(err).toContain("--role-kind org");
    expect(err).toContain("settings show");
  });

  test("settings generate --base-clone substitutes Pattern B placeholders", () => {
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        worker_roles: {
          demo: {
            permissions: { allow: ["Bash(test {base_clone})"] },
            env: { BASE: "{base_clone}", TASK: "{task_id}", BRANCH: "{branch_ref}" },
          },
        },
      }),
      { encoding: "utf8" },
    );
    const out = join(root, "out.json");
    const rc = main([
      "--role",
      "demo",
      "--worker-dir",
      "/wd",
      "--claude-org-path",
      "/co",
      "--base-clone",
      "/tmp/base",
      "--task-id",
      "task-123",
      "--branch-ref",
      "feat/x",
      "--pattern",
      "B",
      "--schema",
      schemaPath,
      "--out",
      out,
    ]);
    expect(rc).toBe(0);
    const parsed = pyJsonLoads(readFileSync(out, "utf8")) as Record<string, unknown>;
    const allow = (parsed["permissions"] as Record<string, unknown>)["allow"] as string[];
    expect(allow[0]).toBe("Bash(test /tmp/base)");
    expect(parsed["env"]).toStrictEqual({
      BASE: "/tmp/base",
      TASK: "task-123",
      BRANCH: "feat/x",
    });
  });

  test("--role-kind bogus is rejected by the parser with a non-zero exit", () => {
    const error = expectRaises(ArgparseExit, () =>
      captureStderr(() =>
        main([
          "--role",
          "demo",
          "--role-kind",
          "bogus",
          "--worker-dir",
          "/wd",
          "--claude-org-path",
          "/co",
        ]),
      ),
    );
    expect(error.code).not.toBe(0);
  });

  test("settings show --role-kind org with an unknown role returns 2", () => {
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(schemaPath, JSON.stringify({ roles: { secretary: {} }, worker_roles: {} }), {
      encoding: "utf8",
    });
    const [rc] = captureStderr(() =>
      runViaRuntimeCli([
        "settings",
        "show",
        "--role",
        "nope",
        "--role-kind",
        "org",
        "--worker-dir",
        "/wd",
        "--claude-org-path",
        "/co",
        "--schema",
        schemaPath,
      ]),
    );
    expect(rc).toBe(2);
  });

  test("settings show --role-kind org --explain surfaces sandbox suppression", () => {
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        roles: {
          secretary: {
            sandbox: {
              enabled: true,
              filesystem: {
                denyRead: [
                  { anchor: "absolute", path: "/etc/shadow", suppressOnSymlinkEscape: true },
                ],
                denyWrite: [],
                additionalDirectories: [],
              },
              failIfUnavailable: false,
            },
          },
        },
        worker_roles: {},
      }),
      { encoding: "utf8" },
    );
    const [rc, out] = captureStdout(() =>
      runViaRuntimeCli([
        "settings",
        "show",
        "--role",
        "secretary",
        "--role-kind",
        "org",
        "--worker-dir",
        join(root, "wd"),
        "--claude-org-path",
        join(root, "co"),
        "--schema",
        schemaPath,
        "--explain",
        "--json",
      ]),
    );
    expect(rc).toBe(0);
    const payload = pyJsonLoads(out) as Record<string, unknown>;
    expect(payload["role"]).toBe("secretary");
    const suppressions = (payload["sandbox"] as Record<string, unknown>)["suppressions"] as Record<
      string,
      unknown
    >[];
    expect(suppressions).toHaveLength(1);
    const entry = (suppressions[0] as Record<string, unknown>)["entry"] as Record<string, unknown>;
    expect(entry["path"]).toBe("/etc/shadow");
  });
});

describe("sandbox_by_pattern and the base_clone anchor", () => {
  test("--pattern A selects sandbox_by_pattern.A as the rendered sandbox", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const schema = {
      worker_roles: {
        demo: patternRole({
          sandboxByPattern: {
            A: patternSandbox({ denyRead: ["secrets.env"], additional: ["{worker_dir}"] }),
            B: patternSandbox({
              denyRead: [structured("base_clone", ".git/config")],
              additional: ["{worker_dir}", "{base_clone}/.git/worktrees/{task_id}"],
            }),
          },
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      pattern: "A",
      wslDetector: () => false,
    });
    const fs = filesystemOf(result);
    expect(fs["denyRead"]).toStrictEqual(["secrets.env"]);
    // base_clone-flavoured entries from sandbox_by_pattern.B did NOT leak in.
    expect(fs["additionalDirectories"]).toStrictEqual([workerDir]);
    expect(Object.hasOwn(result.settings, "sandbox_by_pattern")).toBe(false);
  });

  test("--pattern B selects sandbox_by_pattern.B and resolves base_clone anchors", () => {
    const workerDir = "/home/u/work/proj/.worktrees/task-42";
    const baseClone = "/home/u/work/proj";
    const schema = {
      worker_roles: {
        demo: patternRole({
          sandboxByPattern: {
            A: patternSandbox({ additional: ["{worker_dir}"] }),
            B: patternSandbox({
              denyRead: [structured("base_clone", ".git/HEAD")],
              denyWrite: [structured("base_clone", ".git/config")],
              additional: [
                "{worker_dir}",
                "{base_clone}/.git/worktrees/{task_id}",
                "{base_clone}/.git/objects",
              ],
            }),
          },
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      baseClone,
      taskId: "task-42",
      branchRef: "feat/x",
      pattern: "B",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    const fs = filesystemOf(result);
    expect(fs["additionalDirectories"]).toStrictEqual([
      workerDir,
      `${baseClone}/.git/worktrees/task-42`,
      `${baseClone}/.git/objects`,
    ]);
    // `.git/HEAD` is inside neither `.git/objects` nor `.git/worktrees/task-42`.
    expect(
      result.sandbox.suppressions.some(
        (s) =>
          s.layer === "sandbox.filesystem.denyRead" &&
          typeof s.entry === "object" &&
          s.entry !== null &&
          (s.entry as Record<string, unknown>)["anchor"] === "base_clone" &&
          (s.entry as Record<string, unknown>)["path"] === ".git/HEAD",
      ),
    ).toBe(true);
  });

  test("--pattern C selects the ephemeral sandbox_by_pattern.C surface", () => {
    const root = tmpPath();
    const dir = join(root, "ephemeral-task");
    mkdirSync(dir, { recursive: true });
    const workerDir = osRealpath(dir);
    const schema = {
      worker_roles: {
        demo: patternRole({
          sandboxByPattern: {
            A: patternSandbox({ additional: ["{worker_dir}"] }),
            C: patternSandbox({ denyRead: ["secrets.env"], additional: ["{worker_dir}"] }),
          },
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      pattern: "C",
      wslDetector: () => false,
    });
    const fs = filesystemOf(result);
    expect(fs["denyRead"]).toStrictEqual(["secrets.env"]);
    expect(fs["additionalDirectories"]).toStrictEqual([workerDir]);
  });

  test("a role with sandbox_by_pattern errors when --pattern is missing", () => {
    const schema = {
      worker_roles: { demo: patternRole({ sandboxByPattern: { A: patternSandbox() } }) },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, { role: "demo", workerDir: "/wd", claudeOrgPath: "/co" }),
    );
    expect(error.message).toContain("sandbox_by_pattern");
    expect(error.message).toContain("--pattern");
  });

  test("unknown pattern keys in sandbox_by_pattern are rejected", () => {
    const schema = {
      worker_roles: {
        demo: patternRole({ sandboxByPattern: { A: patternSandbox(), D: patternSandbox() } }),
      },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "A",
      }),
    );
    expect(error.message).toContain("unknown pattern keys");
  });

  test("selecting a pattern the role does not define surfaces an error", () => {
    const schema = {
      worker_roles: { demo: patternRole({ sandboxByPattern: { A: patternSandbox() } }) },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "B",
      }),
    );
    expect(error.message).toContain("no entry for pattern 'B'");
    expect(error.message).toContain("['A']");
  });

  test("sandbox and sandbox_by_pattern are mutually exclusive on a worker role", () => {
    const schema = {
      worker_roles: {
        demo: patternRole({
          sandboxByPattern: { A: patternSandbox() },
          sandbox: patternSandbox({ denyRead: ["legacy.env"] }),
        }),
      },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "A",
      }),
    );
    expect(error.message).toContain("mutually exclusive");
    expect(error.message).toContain("sandbox_by_pattern");
  });

  test("org roles may not declare sandbox_by_pattern", () => {
    const schema = {
      roles: { secretary: { sandbox_by_pattern: { A: patternSandbox() } } },
      worker_roles: {},
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "secretary",
        roleKind: "org",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "A",
      }),
    );
    expect(error.message).toContain("reserved for worker roles");
  });

  test("a non-dict sandbox_by_pattern is rejected up front", () => {
    const schema = {
      worker_roles: { demo: { permissions: { deny: [] }, sandbox_by_pattern: ["A", "B"] } },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "A",
      }),
    );
    expect(error.message).toContain("must be a dict");
  });

  test("sandbox_by_pattern: null alongside sandbox is rejected as mutually exclusive", () => {
    const schema = {
      worker_roles: {
        demo: {
          permissions: { deny: [] },
          sandbox_by_pattern: null,
          sandbox: patternSandbox({ denyRead: ["legacy.env"] }),
        },
      },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "A",
      }),
    );
    // Mutual exclusivity catches this ahead of the dict-shape check.
    expect(error.message).toContain("mutually exclusive");
  });

  test("sandbox_by_pattern: null on its own still fails the dict-shape check", () => {
    const schema = {
      worker_roles: { demo: { permissions: { deny: [] }, sandbox_by_pattern: null } },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "A",
      }),
    );
    expect(error.message).toContain("must be a dict");
  });

  test("a Pattern B sandbox referencing {base_clone} without --base-clone errors out", () => {
    const schema = {
      worker_roles: {
        demo: patternRole({
          sandboxByPattern: {
            B: patternSandbox({
              additional: ["{worker_dir}", "{base_clone}/.git/worktrees/{task_id}"],
            }),
          },
        }),
      },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "B",
      }),
    );
    expect(error.message).toContain("{base_clone}");
    expect(error.message).toContain("--base-clone");
    expect(error.message).toContain("--pattern B");
  });

  test("{task_id} without --task-id is caught independently of base_clone", () => {
    const schema = {
      worker_roles: {
        demo: patternRole({
          sandboxByPattern: {
            B: patternSandbox({
              additional: ["{worker_dir}", "{base_clone}/.git/worktrees/{task_id}"],
            }),
          },
        }),
      },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        baseClone: "/home/u/proj",
        pattern: "B",
      }),
    );
    expect(error.message).toContain("{task_id}");
    expect(error.message).toContain("--task-id");
  });

  test("an unresolved {base_clone} on a legacy-string deny entry is also caught", () => {
    const schema = {
      worker_roles: {
        demo: patternRole({
          sandboxByPattern: {
            B: patternSandbox({
              denyRead: ["{base_clone}/.git/HEAD"],
              additional: ["{worker_dir}"],
            }),
          },
        }),
      },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
        pattern: "B",
      }),
    );
    expect(error.message).toContain("{base_clone}");
  });

  test("sandbox_by_pattern: null on an org role is also misconfiguration", () => {
    const schema = { roles: { secretary: { sandbox_by_pattern: null } }, worker_roles: {} };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "secretary",
        roleKind: "org",
        workerDir: "/wd",
        claudeOrgPath: "/co",
      }),
    );
    expect(error.message).toContain("reserved for worker roles");
  });

  test("a role using the legacy single sandbox ignores --pattern", () => {
    const root = tmpPath();
    const workerDir = workerDirIn(root);
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: ["secrets.env"] }) } };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: join(root, "co"),
      pattern: "B",
      wslDetector: () => false,
    });
    expect(filesystemOf(result)["denyRead"]).toStrictEqual(["secrets.env"]);
  });

  test("anchor=base_clone joins the entry path against ctx.base_clone", () => {
    const workerDir = "/home/u/work/proj/.worktrees/task-1";
    const baseClone = "/home/u/work/proj";
    const captured: string[] = [];
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structured("base_clone", ".git/config")], additional: [] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      baseClone,
      realpathFn: (p) => {
        captured.push(p);
        return p;
      },
      wslDetector: () => false,
    });
    // The anchor base is realpath'd, then `.git/config` is joined onto it.
    // `os.path.join` is platform-aware, so the joined path uses backslashes on
    // Windows -- matched here rather than hard-coding a POSIX separator.
    expect(captured).toContain(baseClone);
    expect(captured).toContain(osJoin(baseClone, ".git/config"));
    expect(result.sandbox.suppressions).toHaveLength(1);
  });

  test("anchor=base_clone without --base-clone surfaces a usable error", () => {
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structured("base_clone", ".git/HEAD")], additional: [] }),
      },
    };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/home/u/wd",
        claudeOrgPath: "/home/u/co",
        wslDetector: () => false,
      }),
    );
    expect(error.message).toContain("anchor='base_clone'");
    expect(error.message).toContain("--base-clone");
  });

  test("_normalize_sandbox_entry accepts the base_clone anchor", () => {
    const norm = normalizeSandboxEntry({ anchor: "base_clone", path: ".git/objects" });
    expect(norm).not.toBeNull();
    expect(norm?.anchor).toBe("base_clone");
    expect(norm?.path).toBe(".git/objects");
  });

  test("--pattern rejects a free-form value like 'b'", () => {
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({ worker_roles: { demo: { permissions: { deny: [] } } } }),
      { encoding: "utf8" },
    );
    const error = expectRaises(ArgparseExit, () =>
      captureStderr(() =>
        main([
          "--role",
          "demo",
          "--worker-dir",
          "/wd",
          "--claude-org-path",
          "/co",
          "--pattern",
          "b",
          "--schema",
          schemaPath,
        ]),
      ),
    );
    expect(error.code).not.toBe(0);
  });

  test("end to end: settings generate --pattern B writes the Pattern B sandbox", () => {
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        worker_roles: {
          demo: {
            permissions: { deny: [] },
            sandbox_by_pattern: {
              A: {
                enabled: true,
                filesystem: {
                  denyRead: ["secrets.env"],
                  denyWrite: [],
                  additionalDirectories: ["{worker_dir}"],
                },
                failIfUnavailable: false,
              },
              B: {
                enabled: true,
                filesystem: {
                  denyRead: [],
                  denyWrite: [],
                  additionalDirectories: ["{worker_dir}", "{base_clone}/.git/worktrees/{task_id}"],
                },
                failIfUnavailable: false,
              },
            },
          },
        },
      }),
      { encoding: "utf8" },
    );
    const out = join(root, "out.json");
    const rc = main([
      "--role",
      "demo",
      "--worker-dir",
      "/home/u/proj/.worktrees/task-1",
      "--claude-org-path",
      "/home/u/co",
      "--base-clone",
      "/home/u/proj",
      "--task-id",
      "task-1",
      "--branch-ref",
      "feat/x",
      "--pattern",
      "B",
      "--schema",
      schemaPath,
      "--out",
      out,
    ]);
    expect(rc).toBe(0);
    const parsed = pyJsonLoads(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "sandbox_by_pattern")).toBe(false);
    const fs = (parsed["sandbox"] as Record<string, unknown>)["filesystem"] as Record<
      string,
      unknown
    >;
    expect(fs["additionalDirectories"]).toStrictEqual([
      "/home/u/proj/.worktrees/task-1",
      "/home/u/proj/.git/worktrees/task-1",
    ]);
  });

  test("settings generate without --pattern errors when the role uses sandbox_by_pattern", () => {
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        worker_roles: {
          demo: {
            permissions: { deny: [] },
            sandbox_by_pattern: { A: { enabled: true, filesystem: {} } },
          },
        },
      }),
      { encoding: "utf8" },
    );
    const [rc] = captureStderr(() =>
      main([
        "--role",
        "demo",
        "--worker-dir",
        "/wd",
        "--claude-org-path",
        "/co",
        "--schema",
        schemaPath,
      ]),
    );
    expect(rc).toBe(2);
  });
});

/**
 * The worker git policy and Docker allow-set regressions.
 *
 * These read the BUNDLED schema rather than a fixture, which is the point:
 * they pin the shipped document's content, so a later edit to
 * `role_configs_schema.json` that re-broadened a deny set turns them red. The
 * document itself is separately pinned by digest in
 * `test/contract/carried-documents.test.ts`.
 */
describe("the shipped schema's worker git and Docker policy", () => {
  test("roles.worker.required_allow contains the colon-form fetch", () => {
    expect(orgRole("worker")["required_allow"] as string[]).toContain("Bash(git fetch:*)");
  });

  test("workers do a fetch plus a merge instead of a pull", () => {
    expect(orgRole("worker")["required_allow"] as string[]).toContain("Bash(git merge:*)");
    for (const template of ["default", "claude-org-self-edit"]) {
      expect(templateAllow(template)).toContain("Bash(git merge:*)");
    }
  });

  test("both mutating worker templates carry the narrow Docker build allow set", () => {
    for (const template of ["default", "claude-org-self-edit"]) {
      const allow = templateAllow(template);
      for (const entry of DOCKER_BUILD_ALLOW) {
        expect(allow, `${entry} missing from ${template} allow`).toContain(entry);
      }
    }
  });

  test("the Docker allow set has not broadened to the rejected wide patterns", () => {
    const forbidden = new Set([
      "Bash(docker inspect:*)",
      "Bash(docker buildx:*)",
      "Bash(docker run:*)",
      "Bash(docker compose:*)",
      "Bash(docker push:*)",
      "Bash(docker login:*)",
      "Bash(docker rmi:*)",
      "Bash(docker system prune:*)",
    ]);
    for (const template of ["default", "claude-org-self-edit"]) {
      const allow = new Set(templateAllow(template));
      const overlap = [...forbidden].filter((entry) => allow.has(entry));
      expect(overlap, `${template} allow broadened beyond the narrow set`).toStrictEqual([]);
    }
  });

  test("the Docker allow set stays out of the read-only and frozen surfaces", () => {
    const docAuditAllow = new Set(templateAllow("doc-audit"));
    const workerRequired = new Set(orgRole("worker")["required_allow"] as string[]);
    for (const entry of DOCKER_BUILD_ALLOW) {
      expect(docAuditAllow.has(entry), `${entry} leaked into doc-audit`).toBe(false);
      expect(workerRequired.has(entry), `${entry} leaked into worker.required_allow`).toBe(false);
    }
  });

  test("roles.worker.required_allow carries no publishing variant", () => {
    const forbidden = [
      "Bash(git push:*)",
      "Bash(git push)",
      "Bash(git push *)",
      "Bash(git -C * push:*)",
    ];
    const allow = new Set(orgRole("worker")["required_allow"] as string[]);
    expect(forbidden.filter((entry) => allow.has(entry))).toStrictEqual([]);
  });

  test("worker fetch is scoped to the worker's own cwd", () => {
    expect(orgRole("worker")["required_allow"] as string[]).not.toContain("Bash(git -C * fetch:*)");
    for (const template of ["default", "claude-org-self-edit"]) {
      expect(templateAllow(template)).not.toContain("Bash(git -C * fetch:*)");
    }
  });

  test("roles.worker.required_deny no longer blocks a fetch", () => {
    const deny = orgRole("worker")["required_deny"] as string[];
    expect(deny).not.toContain("Bash(git fetch)");
    expect(deny).not.toContain("Bash(git fetch *)");
  });

  test("roles.worker.required_deny still blocks publishing", () => {
    const deny = orgRole("worker")["required_deny"] as string[];
    expect(deny).toContain("Bash(git push)");
    expect(deny).toContain("Bash(git push *)");
  });

  test("roles.worker.required_deny still blocks a pull", () => {
    const deny = orgRole("worker")["required_deny"] as string[];
    expect(deny).toContain("Bash(git pull)");
    expect(deny).toContain("Bash(git pull *)");
  });

  test("the default worker template allows the colon-form fetch", () => {
    expect(templateAllow("default")).toContain("Bash(git fetch:*)");
  });

  test("the default worker template no longer denies a cwd fetch", () => {
    const deny = templateDeny("default");
    expect(deny).not.toContain("Bash(git fetch)");
    expect(deny).not.toContain("Bash(git fetch *)");
    // The -C form stays denied for defence in depth.
    expect(deny).toContain("Bash(git -C * fetch)");
    expect(deny).toContain("Bash(git -C * fetch *)");
  });

  test("the default worker template still denies publishing and pulling", () => {
    const deny = templateDeny("default");
    expect(deny).toContain("Bash(git push)");
    expect(deny).toContain("Bash(git push *)");
    expect(deny).toContain("Bash(git pull)");
    expect(deny).toContain("Bash(git pull *)");
  });

  test("the claude-org-self-edit template allows the colon-form fetch", () => {
    expect(templateAllow("claude-org-self-edit")).toContain("Bash(git fetch:*)");
  });

  test("the claude-org-self-edit template no longer denies a cwd fetch", () => {
    const deny = templateDeny("claude-org-self-edit");
    expect(deny).not.toContain("Bash(git fetch)");
    expect(deny).not.toContain("Bash(git fetch *)");
    expect(deny).toContain("Bash(git -C * fetch)");
    expect(deny).toContain("Bash(git -C * fetch *)");
  });

  test("the claude-org-self-edit template still denies publishing and pulling", () => {
    const deny = templateDeny("claude-org-self-edit");
    expect(deny).toContain("Bash(git push)");
    expect(deny).toContain("Bash(git push *)");
    expect(deny).toContain("Bash(git pull)");
    expect(deny).toContain("Bash(git pull *)");
  });

  test("global.forbidden_allow_exact still lists the space forms", () => {
    const forbidden = (bundledSchema()["global"] as Record<string, unknown>)[
      "forbidden_allow_exact"
    ] as string[];
    expect(forbidden).toContain("Bash(git fetch *)");
    expect(forbidden).toContain("Bash(git pull *)");
    expect(forbidden).toContain("Bash(git push *)");
    expect(forbidden).not.toContain("Bash(git fetch:*)");
  });

  test("the generated default worker settings include the colon-form fetch", () => {
    const root = tmpPath();
    const out = join(root, "settings.local.json");
    const rc = main([
      "--role",
      "default",
      "--worker-dir",
      join(root, "wd"),
      "--claude-org-path",
      join(root, "co"),
      "--out",
      out,
    ]);
    expect(rc).toBe(0);
    const parsed = pyJsonLoads(readFileSync(out, "utf8")) as Record<string, unknown>;
    const permissions = parsed["permissions"] as Record<string, unknown>;
    const allow = permissions["allow"] as string[];
    const deny = permissions["deny"] as string[];
    expect(allow).toContain("Bash(git fetch:*)");
    expect(allow).not.toContain("Bash(git push:*)");
    expect(allow).not.toContain("Bash(git pull:*)");
    expect(deny).toContain("Bash(git push)");
    expect(deny).toContain("Bash(git pull)");
    expect(deny).not.toContain("Bash(git fetch)");
    expect(deny).not.toContain("Bash(git fetch *)");
  });
});

/**
 * Target-only. These translate no interlock node id.
 *
 * Two obligations meet here, and neither is visible to a translated case.
 *
 * **Seam liveness** (`docs/test-translation-conventions.md` rule 5). A seam can
 * rot into a decoration: if production stops routing through the record and
 * calls the underlying function directly, every case that replaces the entry
 * stays green, because the replacement is simply never reached and the
 * assertions still hold for the wrong reason. The source's autouse fixture
 * replaces `generator._absolute_symlink_in_chain` precisely so these cases do
 * not read the host filesystem; if the replacement stopped reaching production,
 * the whole file would silently go back to reading it.
 *
 * **The number-spelling carry** (D-0210, D-0211). A rebuilt container starts
 * with an empty spelling record, the values are still numbers, every comparison
 * still holds, and nothing goes red -- so the obligation is enforced by
 * enumeration plus pins, and this is the pins half. This module has THIRTEEN
 * rebuild branches; they are listed in `src/settings/generator.ts`'s header and
 * in `src/fencing/pyjson.ts`'s, and each one is reached by one of the four
 * cases below. Every pin was confirmed to fail, for the stated reason, with its
 * carry removed.
 *
 * A spelling CANNOT be written in TypeScript -- the literal `1.0` IS `1` -- so
 * each pin builds the schema as TEXT, reads it back through `loadSchema` (the
 * production read path) and asserts on the serialiser's output. A case that
 * built the role body in code would carry no spelling into it and would pass
 * against a renderer with every carry removed.
 *
 * The float lives on a key of its own at each level rather than inside a
 * neighbouring container, because a spelling hangs on the container that
 * IMMEDIATELY holds the number: a float nested one level deeper rides on the
 * inner object and says nothing about whether the outer rebuild carried
 * anything. That is how the first draft of this block pinned an array carry
 * while believing it pinned the object rebuild around it.
 */
describe("the seam and the number-spelling carry (target-only, D-0213)", () => {
  test("production reads the symlink probe through the seam record (target-only)", () => {
    // The record is patched to claim a symlink where the real filesystem has
    // none. If `canonicalizeEscapingPath` called the imported function instead,
    // the probe would answer "no symlink" for this synthetic path and no
    // rewrite could be recorded -- so a non-empty `rewrites` is the positive
    // evidence that the replacement was the thing production called.
    const workerDir = "/home/u/work/wd";
    const escaped = "/mnt/c/Users/u/work/wd";
    patchSeam(generatorSeams, "absoluteSymlinkInChain", (path: string) =>
      path.startsWith(workerDir) ? workerDir : null,
    );
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structured("worker_dir", "secrets.env", false)] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, escaped),
      wslDetector: () => true,
    });
    expect(result.sandbox.rewrites).toHaveLength(1);
    expect((result.sandbox.rewrites[0] as { symlink: string }).symlink).toBe(workerDir);
  });

  test("an integral float and a 2**53+ integer survive the whole CLI render (target-only)", () => {
    // The artefact-level pin: schema text in, `settings.local.json` BYTES out,
    // across the template copy, `substitute` and the serialiser. CPython writes
    // `1.0` and `9007199254740993`; without the carry this port writes `1` and
    // `9007199254740992` -- and the second is not even the authored value, so
    // no later serialiser could recover it.
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      '{"worker_roles": {"demo": {"env": {"A": 1.0, "B": 9007199254740993, "C": 2}}}}',
      { encoding: "utf8" },
    );
    const out = join(root, "out.json");
    const rc = main([
      "--role",
      "demo",
      "--worker-dir",
      "/wd",
      "--claude-org-path",
      "/co",
      "--schema",
      schemaPath,
      "--out",
      out,
    ]);
    expect(rc).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain('"A": 1.0');
    expect(text).toContain('"B": 9007199254740993');
    // The neighbouring int is unaffected: the carry re-emits the SPELLING, it
    // does not turn every number into a float.
    expect(text).toContain('"C": 2');
  });

  test("every rebuild on the render path carries the spelling (target-only)", () => {
    // Reaches the branches a render with no suppression and no rewrite passes
    // through: the role-template copy, `substitute`'s object and array
    // branches, the `additionalDirectories` map, and the two rebuilds inside
    // the suppression evaluator. One float per container, so a missing carry
    // names the container it was missing from.
    //
    // The deny arrays carry no float HERE since D-0094: a number that survives
    // to the end of a render is refused rather than written, so their two
    // branches -- `list(...)` over the array, and the filtered KEPT list -- are
    // pinned by the two cases below instead, which read the spelling out of the
    // refusal. Nothing is lost: `pyTypeNameOf` consults the same record on the
    // same final container, so a dropped carry turns `float` into `int` there
    // exactly as it turns `5.0` into `5` here.
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        worker_roles: {
          demo: {
            topFloat: "@1.0@",
            listFloat: ["@2.0@"],
            sandbox: {
              sandboxFloat: "@3.0@",
              enabled: true,
              filesystem: {
                fsFloat: "@4.0@",
                denyRead: [],
                denyWrite: [],
                additionalDirectories: ["@0.0@"],
              },
              failIfUnavailable: false,
            },
          },
        },
      })
        .replaceAll('"@', "")
        .replaceAll('@"', ""),
      { encoding: "utf8" },
    );
    const result = renderRoleWithMetadata(loadSchema(schemaPath), {
      role: "demo",
      workerDir: "/home/u/work/wd",
      claudeOrgPath: "/home/u/co",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    const text = pyJsonDumps(result.settings, { indent: 2, ensureAscii: false });
    // Each assertion names the container whose rebuild had to carry the record.
    expect(text, "role template copy").toContain('"topFloat": 1.0');
    expect(text, "substitute's array branch").toContain("2.0");
    expect(text, "substitute's object branch, on the sandbox").toContain('"sandboxFloat": 3.0');
    expect(text, "the filesystem rebuild in the suppression evaluator").toContain('"fsFloat": 4.0');
    // `0.0` rather than another positive float: a truthy non-string in this
    // array is a `TypeError` from `os.path.normpath` one line later, exactly as
    // it is in the source, so a falsy one is the only number that can sit here.
    expect(text, "list() over additionalDirectories, then the map").toContain("0.0");
  });

  test("a kept deny entry keeps its spelling after an earlier entry is suppressed (target-only)", () => {
    // The subtle branch, and the one a wholesale carry gets WRONG rather than
    // merely missing. `kept` is a FILTERED copy, so its indices do not line up
    // with the input's: carrying the record wholesale hands element 0 of `kept`
    // the spelling recorded for element 0 of the INPUT -- the suppressed
    // string, which has none -- and the number is then classified by value.
    //
    // Read out of the refusal since D-0094, because a number in a deny array is
    // no longer written. The two assertions are the same two facts the file
    // assertion carried: `[0]` says the string was suppressed and the number
    // moved down a slot, and `float` says the record moved WITH it. A wholesale
    // carry says `int` here for exactly the reason it wrote `1` there.
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      '{"worker_roles": {"demo": {"sandbox": {"enabled": true, "filesystem": ' +
        '{"denyRead": ["secrets.env", 1.0], "denyWrite": [], "additionalDirectories": []}, ' +
        '"failIfUnavailable": false}}}}',
      { encoding: "utf8" },
    );
    const workerDir = "/home/u/work/wd";
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(loadSchema(schemaPath), {
        role: "demo",
        workerDir,
        claudeOrgPath: "/home/u/co",
        realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/work/wd"),
        wslDetector: () => true,
      }),
    );
    expect(error.message).toContain(
      "sandbox.filesystem.denyRead[0] would reach the child as float",
    );
  });

  test("list() over a deny array carries the spelling into the refusal (target-only)", () => {
    // Branch 3 (`pyList` over the deny array) and branch 7 (the KEPT list) on a
    // render that suppresses nothing, so the number reaches the post-condition
    // through the plain path rather than the re-keyed one above. Drop either
    // carry and `pyTypeNameOf` classifies by value: `int`, not `float`.
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      '{"worker_roles": {"demo": {"sandbox": {"enabled": true, "filesystem": ' +
        '{"denyRead": [], "denyWrite": [5.0], "additionalDirectories": []}, ' +
        '"failIfUnavailable": false}}}}',
      { encoding: "utf8" },
    );
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(loadSchema(schemaPath), {
        role: "demo",
        workerDir: "/home/u/work/wd",
        claudeOrgPath: "/home/u/co",
        realpathFn: (p) => p,
        wslDetector: () => false,
      }),
    );
    expect(error.message).toContain(
      "sandbox.filesystem.denyWrite[0] would reach the child as float",
    );
  });

  test("the canonicalising rebuilds carry the spelling too (target-only)", () => {
    // The other five branches, which only run when at least one path was
    // rewritten -- so the probe is forced to report a symlink. `enabled` is
    // false on purpose: Layer 3 canonicalisation is deliberately NOT gated on
    // it, so this also pins that the rebuilds happen for a disabled sandbox.
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        worker_roles: {
          demo: {
            permissions: { permFloat: "@1.0@", deny: ["@2.0@", "Read(//home/u/link/x)"] },
            sandbox: {
              sandboxFloat: "@3.0@",
              enabled: false,
              filesystem: {
                fsFloat: "@4.0@",
                denyRead: ["/home/u/link/y"],
                denyWrite: [],
              },
            },
          },
        },
      })
        .replaceAll('"@', "")
        .replaceAll('@"', ""),
      { encoding: "utf8" },
    );
    patchSeam(generatorSeams, "absoluteSymlinkInChain", (path: string) =>
      path.startsWith("/home/u/link") ? "/home/u/link" : null,
    );
    const result = renderRoleWithMetadata(loadSchema(schemaPath), {
      role: "demo",
      workerDir: "/home/u/work/wd",
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath("/home/u/link", "/mnt/c/link"),
      wslDetector: () => false,
    });
    // Both layers were rewritten, which is what makes the rebuilds run at all.
    expect(result.sandbox.rewrites.map((r) => r.layer)).toStrictEqual([
      "sandbox.filesystem.denyRead",
      "permissions.deny",
    ]);
    const text = pyJsonDumps(result.settings, { indent: 2, ensureAscii: false });
    expect(text, "the permissions rebuild").toContain('"permFloat": 1.0');
    expect(text, "canonicalizePermissionDeny's output list").toContain("2.0");
    expect(text, "the sandbox rebuild in the canonicaliser").toContain('"sandboxFloat": 3.0');
    expect(text, "the filesystem rebuild in the canonicaliser").toContain('"fsFloat": 4.0');
  });

  test("canonicalizeSandboxDeny's output list carries the spelling too (target-only)", () => {
    // Branch 11, split off from the case above because its float can no longer
    // ride in the rendered file (D-0094). The rewrite is still forced, so the
    // canonicaliser's `out` -- not the suppression evaluator's `kept` -- is the
    // last container to hold the number before the post-condition reads it.
    const root = tmpPath();
    const schemaPath = join(root, "schema.json");
    writeFileSync(
      schemaPath,
      '{"worker_roles": {"demo": {"sandbox": {"enabled": false, "filesystem": ' +
        '{"denyRead": [5.0, "/home/u/link/y"], "denyWrite": []}}}}}',
      { encoding: "utf8" },
    );
    patchSeam(generatorSeams, "absoluteSymlinkInChain", (path: string) =>
      path.startsWith("/home/u/link") ? "/home/u/link" : null,
    );
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(loadSchema(schemaPath), {
        role: "demo",
        workerDir: "/home/u/work/wd",
        claudeOrgPath: "/home/u/co",
        realpathFn: escapingRealpath("/home/u/link", "/mnt/c/link"),
        wslDetector: () => false,
      }),
    );
    expect(error.message).toContain(
      "sandbox.filesystem.denyRead[0] would reach the child as float",
    );
  });

  test("a placeholder written twice in one string is substituted twice (target-only)", () => {
    // `str.replace` in Python replaces EVERY occurrence; JavaScript's
    // `String.prototype.replace` with a string pattern replaces only the FIRST.
    // No source case writes the same placeholder twice in one string, so the
    // narrower spelling would translate green -- and would then ship a literal
    // `{worker_dir}` into a rendered settings file, which the bwrap launcher
    // consumes as a concrete path.
    const out = renderRole(
      { worker_roles: { demo: { env: { PAIR: "{worker_dir}/a:{worker_dir}/b" } } } },
      { role: "demo", workerDir: "/wd", claudeOrgPath: "/co" },
    );
    expect((out["env"] as Record<string, unknown>)["PAIR"]).toBe("/wd/a:/wd/b");
  });
});

/**
 * Target-only. The two repairs the review gate found, each pinned with the
 * thing it must not break beside it (`docs/test-translation-conventions.md`
 * rule 11: "pin the repair AND the thing it must not break").
 */
describe("the two in-pass repairs (target-only, D-0213)", () => {
  test("a kept absolute entry is emitted as a string on this platform (target-only)", () => {
    // The source asks `substituted_path.startswith("/")`, which is
    // `posixpath.isabs` written out -- and on Windows is not "is this
    // absolute" at all, so `C:\secret` fell through and was emitted as the
    // original DICT, the exact shape `_kept_entry_string` exists to stop
    // emitting.
    //
    // The absolute form is PARAMETERISED BY PLATFORM rather than guarded by a
    // skip, because the property is "the emitted form follows `os.path.isabs`",
    // and `os.path` is a platform choice. On POSIX this asserts the unchanged
    // behaviour; on the Windows cells it asserts the repair. A `skipIf` would
    // have made the repair unpinned on every cell that is not Windows AND
    // needed a ledger approval for a construct that buys nothing here.
    const absolute = process.platform === "win32" ? "C:\\secret" : "/secret";
    const schema = {
      worker_roles: {
        demo: sandboxRole({
          denyRead: [structured("absolute", absolute)],
          additional: [absolute],
        }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/wd",
      claudeOrgPath: "/home/u/co",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    const kept = filesystemOf(result)["denyRead"] as unknown[];
    expect(kept).toStrictEqual([absolute]);
    expect(typeof kept[0], "the contract's arrays are lists of STRINGS").toBe("string");
  });

  test("anchor=absolute with a relative path is still refused as the dict (target-only)", () => {
    // The half the repair must not break. `osIsabs` widens what counts as
    // absolute; it must not turn the MALFORMED case -- `anchor='absolute'` with
    // a path that is absolute under no namespace -- into a silently
    // wrong-anchored string. Under D-0094 the observation moved from the
    // rendered file to the refusal, and it says the same thing in the same
    // direction: a message naming a PATH rather than the dict would mean
    // `osIsabs` had judged this entry absolute and anchored it somewhere.
    const bad = { anchor: "absolute", path: "etc/shadow", suppressOnSymlinkEscape: true };
    const schema = { worker_roles: { demo: sandboxRole({ denyRead: [bad], additional: [] }) } };
    const error = expectRaises(PyValueError, () =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/home/u/wd",
        claudeOrgPath: "/home/u/co",
        realpathFn: (p) => p,
        wslDetector: () => false,
      }),
    );
    expect(error.message).toContain("would reach the child as dict");
    expect(error.message).toContain(
      "{'anchor': 'absolute', 'path': 'etc/shadow', 'suppressOnSymlinkEscape': True}",
    );
  });

  /**
   * Every `--` shape, measured against CPython 3.12.3 on this exact parser
   * rather than reasoned about.
   *
   * The separator was the second finding, and the first fix was wrong in the
   * interesting direction: it assumed `(-*A-*)` let an optional absorb the
   * separator and take the token after it, so `--worker-dir -- /wd` would
   * parse. `_get_nargs_pattern` strips the `-` for an optional action, and
   * CPython rejects that line -- which the table below only says because the
   * table was produced by running it.
   */
  const SEPARATOR_CASES: readonly (readonly [argv: readonly string[], expected: string])[] = [
    [
      ["--role", "demo", "--claude-org-path", "/co", "--worker-dir", "--"],
      "argument --worker-dir: expected one argument",
    ],
    [
      ["--role", "demo", "--claude-org-path", "/co", "--worker-dir", "--", "/wd"],
      "argument --worker-dir: expected one argument",
    ],
    [
      ["--role", "demo", "--worker-dir", "--", "--claude-org-path", "/co"],
      "argument --worker-dir: expected one argument",
    ],
    [
      ["--role", "demo", "--worker-dir", "/wd", "--claude-org-path", "/co", "--"],
      "unrecognized arguments: --",
    ],
    [
      ["--role", "demo", "--worker-dir", "/wd", "--claude-org-path", "/co", "--", "x"],
      "unrecognized arguments: -- x",
    ],
    [
      ["--role", "demo", "--worker-dir", "/wd", "--", "--claude-org-path", "/co"],
      "the following arguments are required: --claude-org-path",
    ],
    [
      ["--", "--role", "demo"],
      "the following arguments are required: --role, --worker-dir, --claude-org-path",
    ],
  ];

  for (const [argv, expected] of SEPARATOR_CASES) {
    test(`the -- separator: ${argv.join(" ")} (target-only)`, () => {
      const error = expectRaises(ArgparseExit, () => captureStderr(() => main([...argv])));
      expect(error.code).toBe(2);
      expect(error.message).toBe(expected);
    });
  }

  test("the -- separator reaches a subcommand choice as itself (target-only)", () => {
    // The other half of "the separator is never removed": with a `nargs=PARSER`
    // positional it is handed to the choice check verbatim. Measured:
    // `claude-org-runtime -- settings` is `invalid choice: '--'`.
    const parser = buildContinuoParser();
    const error = expectRaises(ArgparseExit, () =>
      captureStderr(() => {
        parser.parseArgs(["--", "settings", "show"], defaultStreams());
        return 0;
      }),
    );
    expect(error.message).toContain("invalid choice: '--'");
  });
});

/**
 * Target-only. The three repairs the review gate found in round 2, each pinned
 * against a value MEASURED from CPython 3.12.3 on this exact parser.
 *
 * The round-1 separator fix is why these are measured rather than reasoned
 * about: that one was derived by reading `argparse`'s source, and it was wrong.
 */
describe("the round-2 repairs (target-only, D-0213)", () => {
  const BASE = ["--role", "demo", "--worker-dir", "/wd", "--claude-org-path", "/co"];

  /**
   * `_negative_number_matcher`. This parser declares no option string that
   * looks like a negative number, so `_has_negative_number_optionals` is false
   * and the matcher is honoured: a negative-number-shaped token is a VALUE.
   *
   * Without it, `--task-id -1` fails with `expected one argument` and a task id
   * or filename that happens to be negative-number-shaped is unusable.
   */
  const NUMERIC_VALUES: readonly string[] = ["-1", "-1.5", "-", "-0"];
  const NOT_VALUES: readonly string[] = ["-x", "-12abc", "--1"];

  for (const value of NUMERIC_VALUES) {
    test(`a negative-number-shaped token is a value: --task-id ${value} (target-only)`, () => {
      const root = tmpPath();
      const schemaPath = join(root, "schema.json");
      writeFileSync(schemaPath, '{"worker_roles": {"demo": {"k": "{task_id}"}}}', {
        encoding: "utf8",
      });
      const out = join(root, "out.json");
      const rc = main([...BASE, "--task-id", value, "--schema", schemaPath, "--out", out]);
      expect(rc).toBe(0);
      expect(pyJsonLoads(readFileSync(out, "utf8"))).toStrictEqual({ k: value });
    });
  }

  for (const value of NOT_VALUES) {
    test(`a token that only looks numeric is not a value: --task-id ${value} (target-only)`, () => {
      const error = expectRaises(ArgparseExit, () =>
        captureStderr(() => main([...BASE, "--task-id", value])),
      );
      expect(error.message).toBe("argument --task-id: expected one argument");
    });
  }

  /**
   * Extras are reported by the ROOT parser, after the subcommand has run.
   *
   * This is the finding with teeth: an unknown option ahead of a valid
   * subcommand was collected into `extras` and then abandoned by the early
   * return, so `claude-org-runtime --bogus settings generate ...` GENERATED a
   * settings file for a command line the parser did not understand.
   */
  for (const [label, argv] of [
    ["before the subcommand", ["--bogus", "settings", "generate", ...BASE]],
    ["between the subcommands", ["settings", "--bogus", "generate", ...BASE]],
    ["after the subcommand", ["settings", "generate", "--bogus", ...BASE]],
  ] as const) {
    test(`an unrecognized option ${label} is reported, not ignored (target-only)`, () => {
      const parser = buildContinuoParser();
      const error = expectRaises(ArgparseExit, () =>
        captureStderr(() => {
          parser.parseArgs([...argv], defaultStreams());
          return 0;
        }),
      );
      expect(error.code).toBe(2);
      expect(error.message).toBe("unrecognized arguments: --bogus");
    });
  }

  /**
   * The other two sites of the `startswith("/")` repair.
   *
   * Parameterised by platform for the reason the first one is: the property is
   * "absolute means `os.path.isabs`", and `os.path` is a platform choice. On
   * POSIX these assert the unchanged behaviour; on the Windows cells they
   * assert the repair.
   */
  const ABSOLUTE = process.platform === "win32" ? "C:\\secrets" : "/secrets";
  // A PURE glob: the first segment is itself a glob, so `literalPathPrefix`
  // finds no anchored prefix and reachability cannot be computed. `/secrets/*`
  // would not do -- it has the literal prefix `/secrets`, takes the ordinary
  // path and is judged on that, which is a different branch entirely.
  const ABSOLUTE_GLOB = process.platform === "win32" ? "C:\\*" : "/*";

  test("a legacy absolute string is anchored absolute, not at worker_dir (target-only)", () => {
    // The slash test called `C:\secrets\credentials` worker_dir-RELATIVE, so
    // its reachability was judged by joining it onto the worker directory: a
    // path naming nothing, and a deny rule kept or dropped for a reason with
    // nothing to do with the entry.
    const norm = normalizeSandboxEntry(`${ABSOLUTE}/credentials`);
    expect(norm).not.toBeNull();
    expect(norm?.anchor).toBe("absolute");
  });

  test("a relative string is still anchored at worker_dir (target-only)", () => {
    // The half the repair must not break: widening what counts as absolute must
    // not make an ordinary relative entry absolute.
    expect(normalizeSandboxEntry("secrets.env")?.anchor).toBe("worker_dir");
    expect(normalizeSandboxEntry("**/credentials*")?.anchor).toBe("worker_dir");
  });

  test("an absolute pure-glob is kept as-is on this platform (target-only)", () => {
    // `/*` is kept because reachability cannot be computed without fnmatching
    // the filesystem. `C:\*` is the same pattern and was being judged as a
    // worker_dir-anchored glob instead -- so on an escaping worker_dir it was
    // suppressed, and the deny disappeared.
    const workerDir = "/home/u/wd";
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: [ABSOLUTE_GLOB], additional: [] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/wd"),
      wslDetector: () => true,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual([ABSOLUTE_GLOB]);
  });

  test("a relative pure-glob is still judged from worker_dir (target-only)", () => {
    // The half that must not break: the same shape WITHOUT an absolute anchor
    // is still anchored at worker_dir and still suppressed when worker_dir
    // escapes. Widening `isabs` must not turn every glob into an absolute one.
    const workerDir = "/home/u/wd";
    const schema = {
      worker_roles: { demo: sandboxRole({ denyRead: ["**/credentials*"], additional: [] }) },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/wd"),
      wslDetector: () => true,
    });
    expect(result.sandbox.suppressions).toHaveLength(1);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual([]);
  });
});

/**
 * Target-only. The `startswith("/")` repair, made observable on every cell.
 *
 * The three pins above are parameterised by platform, and on POSIX
 * `posixpath.isabs` IS `startswith("/")` -- so on the Linux cells they cannot
 * go red when the repair is reverted. They discriminate only where `os.path` is
 * `ntpath`, which is the one cell class this repository runs least.
 *
 * That is not good enough for a repair: rule 11's whole point is that a repair
 * carries no warrant from the source, and a pin that cannot fail on the cell a
 * reviewer runs is a pin nobody has seen fail. `pypath.ts` dispatches on
 * `process.platform` at CALL time -- deliberately, because that is how Python
 * binds `os.path` -- so the Windows branch is reachable from here by patching
 * the property the dispatch reads. Every one of the three reverts turns this
 * red on Linux; each was confirmed to.
 *
 * What this does NOT claim to be is a Windows cell. It exercises the
 * `os.path` CHOICE, which is what these three decisions turn on; the
 * filesystem underneath is still POSIX, which is why every case here injects
 * `realpathFn` and touches no real path.
 */
describe("the absolute-path repair under a simulated ntpath (target-only, D-0213)", () => {
  /**
   * `process.platform`, patched for one test and restored afterwards.
   *
   * `Object.defineProperty` rather than assignment: `platform` is a getter on
   * the process object, so `process.platform = x` is silently ignored -- which
   * would leave every assertion below running on POSIX and passing for the
   * wrong reason, the exact shape rule 10 is about. The descriptor is captured
   * and put back, so a failure cannot leak the patch into another test.
   */
  function simulateWindows(): void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    onTestFinished(() => {
      if (original === undefined) {
        // Node always defines it; this is the branch that would otherwise
        // leave a fabricated own-property behind.
        delete (process as { platform?: string }).platform;
      } else {
        Object.defineProperty(process, "platform", original);
      }
    });
    // The patch has to be live before anything below runs on it.
    expect(process.platform).toBe("win32");
  }

  test("a drive-letter string anchors absolute, not at worker_dir (target-only)", () => {
    simulateWindows();
    const norm = normalizeSandboxEntry("C:\\secrets\\credentials");
    expect(norm?.anchor).toBe("absolute");
    // The half that must not break, under the same simulated namespace.
    expect(normalizeSandboxEntry("secrets.env")?.anchor).toBe("worker_dir");
  });

  test("a drive-letter pure glob under a relative anchor is kept as-is (target-only)", () => {
    // The STRUCTURED form with a non-absolute anchor is the only route to this
    // branch, and that is a consequence of the first repair rather than a
    // contrivance: a legacy string `C:\*` now normalises to anchor=absolute and
    // is kept by the anchor check one line earlier. What is left for
    // `absolutePattern` to decide is an absolute pure glob authored under an
    // anchor that is not -- which without the repair is judged as a
    // worker_dir-anchored glob and suppressed the moment worker_dir escapes,
    // taking a deny rule with it.
    simulateWindows();
    const workerDir = "/home/u/wd";
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [structured("worker_dir", "C:\\*")], additional: [] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir,
      claudeOrgPath: "/home/u/co",
      realpathFn: escapingRealpath(workerDir, "/mnt/c/Users/u/wd"),
      wslDetector: () => true,
    });
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(filesystemOf(result)["denyRead"]).toStrictEqual(["C:\\*"]);
  });

  test("a kept drive-letter entry is emitted as a string, not a dict (target-only)", () => {
    simulateWindows();
    const entry = structured("absolute", "C:\\secrets\\credentials");
    const schema = {
      worker_roles: {
        demo: sandboxRole({ denyRead: [entry], additional: ["C:\\secrets"] }),
      },
    };
    const result = renderRoleWithMetadata(schema, {
      role: "demo",
      workerDir: "/home/u/wd",
      claudeOrgPath: "/home/u/co",
      realpathFn: (p) => p,
      wslDetector: () => false,
    });
    const kept = filesystemOf(result)["denyRead"] as unknown[];
    // Without the repair this is the original object, and Claude Code answers a
    // dict in denyRead with "Expected string, but received object".
    expect(typeof kept[0]).toBe("string");
    expect(kept).toStrictEqual(["C:\\secrets\\credentials"]);
  });
});
