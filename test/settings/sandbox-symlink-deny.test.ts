import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter as pathDelimiter } from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";
import { ArgparseExit } from "../../src/cli/parser.js";
import { buildParser as buildContinuoParser } from "../../src/cli.js";
import { osJoin, osRealpath } from "../../src/fencing/pypath.js";
import { PyValueError } from "../../src/fencing/pysemantics.js";
import { isAscii } from "../../src/measurement/format.js";
import { buildDoctorParser, defaultStreams } from "../../src/settings/cli.js";
import {
  absoluteSymlinkInChain,
  canonicalizePermissionDeny,
  canonicalizeSandboxDeny,
  formatShowOutput,
  permissionRuleHostPath,
  renderRoleWithMetadata,
  sandboxMetadataToJsonable,
  splitPermissionRule,
} from "../../src/settings/generator.js";
import {
  analyzeTargets,
  CANARY_FAIL,
  CANARY_PASS,
  CANARY_SKIPPED,
  type CompletedProcess,
  collectDenyTargets,
  diagnose,
  diagnoseSources,
  discoverMergedScopes,
  doctorSeams,
  formatReport,
  pathStr,
  reportFailures,
  reportOk,
  runBwrapCanary,
  run as runDoctor,
  STATUS_SYMLINK_ESCAPE,
  STATUS_UNSUPPORTED,
  validateSettings,
} from "../../src/settings/sandbox_doctor.js";
import { caseRoot } from "../testkit/cases.js";
import { skipIf } from "../testkit/marks.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";

/**
 * The bwrap symlink-deny fix: the detector, the canonicalisers and
 * `sandbox doctor`.
 *
 * Ported from interlock `tests/test_sandbox_symlink_deny.py` at `65f36c5`. All
 * 77 source cases map to one case here; the mapping, the adapted rows and their
 * reasons are `parity/settings.sandbox-symlink-deny.ledger.json`.
 *
 * Regression coverage for the failure mode where a deny path crossing an
 * absolute symlink makes bubblewrap abort at launch, after which Claude Code
 * silently retries every Bash command unsandboxed.
 *
 * **The fixtures build real symlinks on disk rather than mocking `os.path`**,
 * and that is the source's own decision, restated because it survives
 * translation unchanged: the whole bug is about how the *filesystem* resolves a
 * path chain, so a mocked chain would not have caught it. It also decides one
 * thing about this file that the generator's suite decides the other way --
 * `generatorSeams.absoluteSymlinkInChain` is NOT patched here. The source binds
 * that name at import time in `sandbox_doctor`, so the generator suite's
 * autouse "no host symlinks" fixture never reached the doctor, and these cases
 * assert what the real filesystem says.
 *
 * ## Two capability probes, not two platform tests
 *
 * `_can_symlink` and `_bwrap_works` are probed rather than inferred, and the
 * source says why for each: Windows allows symlinks under Developer Mode or
 * elevation, so a blanket `skipif(win32)` would give up coverage on hosts that
 * can in fact run these; and bwrap's *presence* is not its ability to start,
 * because Ubuntu 24.04 and many containers block the unprivileged user
 * namespaces it needs. `docs/test-translation-conventions.md` section 4 asks
 * exactly this question of a translated platform condition, and both answers
 * are the source's.
 *
 * Both are computed at module load -- collection time, as pytest's `skipif`
 * conditions are -- and each is spelled as ONE {@link skipIf} call reused by
 * every case that needs it. Two `skipIf(` sites, approved with those exact
 * counts in the ledger, rather than fifty.
 *
 * ## `tmp_path` is realpath'd before anything is built under it
 *
 * The same precondition `settings-generator.test.ts` restores, for a sharper
 * reason here: these cases assert that `absoluteSymlinkInChain` returns a
 * particular path, and the walk resolves through the real filesystem. On macOS
 * `/var` is a symlink to `/private/var`, so an unrealpath'd temp root would
 * make the walk report the temp root's own link and every assertion would
 * compare the wrong two strings. pytest's `tmp_path` is already its own
 * realpath on the Linux host interlock runs on; {@link caseTree} restores that,
 * and no assertion is weakened.
 */

/**
 * `_can_symlink`: whether this host lets an unprivileged process create
 * symlinks.
 */
const SYMLINKS_SUPPORTED = ((): boolean => {
  const tmp = mkdtempSync(join(tmpdir(), "continuo-symlink-probe-"));
  const target = join(tmp, "target");
  mkdirSync(target);
  try {
    symlinkSync(target, join(tmp, "link"), "dir");
    return true;
  } catch {
    return false;
  }
})();

/**
 * `_bwrap_works`: whether bwrap is present *and* able to start on this host.
 *
 * Presence is not enough, so the probe launches it. `spawnSync` reports a
 * missing binary as an `error` rather than by throwing, which is the branch
 * `except (OSError, subprocess.SubprocessError)` covers in the source.
 */
const BWRAP_WORKS = ((): boolean => {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { timeout: 60_000 });
  if (probe.error !== undefined) {
    return false;
  }
  return probe.status === 0;
})();

/** `@requires_symlinks`, and the `escaping_home` fixture's own `pytest.skip`. */
const symlinkTest = skipIf(
  !SYMLINKS_SUPPORTED,
  "host cannot create symlinks (Windows without Developer Mode)",
);

/** `@requires_bwrap`. Every case carrying it also carries `@requires_symlinks`. */
const bwrapTest = skipIf(
  !(BWRAP_WORKS && SYMLINKS_SUPPORTED),
  "bubblewrap missing or cannot start on this host, or the host cannot create symlinks",
);

/** `tmp_path`, realpath'd. @see the file header. */
function caseTree(label: string): string {
  return osRealpath(caseRoot(label));
}

/**
 * `_set_fake_home`: point `~` at `home` on every platform.
 *
 * `ntpath.expanduser` never looks at `HOME`: it reads `USERPROFILE`, falling
 * back to `HOMEDRIVE` + `HOMEPATH`. Setting only `HOME` therefore redirects `~`
 * on POSIX while leaving Windows pointed at the real profile directory, which
 * would quietly turn these tests into assertions about the developer's own home.
 *
 * The source's fifth line patches `Path.home`; there is no such second surface
 * here -- `expanduser` is the only route to `~` in this port -- so the four
 * environment variables are the whole of it.
 */
function setFakeHome(home: string): void {
  const drive = home.length >= 2 && home[1] === ":" ? home.slice(0, 2) : "";
  const tail = drive === "" ? home : home.slice(2);
  for (const [key, value] of [
    ["HOME", home],
    ["USERPROFILE", home],
    ["HOMEDRIVE", drive],
    ["HOMEPATH", tail === "" ? home : tail],
  ] as const) {
    const previous = process.env[key];
    const had = Object.hasOwn(process.env, key);
    process.env[key] = value;
    onTestFinished(() => {
      if (had) {
        process.env[key] = previous;
      } else {
        delete process.env[key];
      }
    });
  }
}

/**
 * `_link_to_dir`: create a *directory* symlink.
 *
 * `target_is_directory` is ignored on POSIX but decides between a file and a
 * directory link on Windows; without it, traversing `link/child` fails there.
 */
function linkToDir(link: string, target: string): void {
  symlinkSync(target, link, "dir");
}

/** The `escaping_home` fixture's two directories. */
interface EscapingHome {
  /** The fake `$HOME`. */
  readonly home: string;
  /** The fixture's `tmp_path`; `external/.aws` lives under it. */
  readonly tmp: string;
}

/**
 * `escaping_home`: a fake `$HOME` whose `.aws` is an *absolute* symlink
 * elsewhere.
 *
 * Mirrors the real WSL2 layout that triggered the bug: `~/.aws` is a symlink to
 * a directory outside the home tree (there, `/mnt/c/...`) and the credential
 * files exist on the far side of the link.
 */
function escapingHome(label: string): EscapingHome {
  const tmp = caseTree(label);
  const home = join(tmp, "home");
  mkdirSync(home);
  const external = join(tmp, "external", ".aws");
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, "config"), "not-a-real-credential\n", "utf8");
  linkToDir(join(home, ".aws"), external);

  // A real (non-symlinked) credential dir, to prove we only rewrite the entries
  // that actually need it.
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "known_hosts"), "", "utf8");

  setFakeHome(home);
  return { home, tmp };
}

/**
 * `str(escaping_home / ".aws" / ...)`: pathlib's `/`, which is `os.path.join`.
 *
 * NOT `node:path`'s `join`, and the difference is load-bearing at exactly one
 * case. `path.join` NORMALISES its result, so `join(home, ".aws", "..",
 * "elsewhere")` collapses to `home/elsewhere` -- erasing the `.aws` component
 * whose presence "survives parent traversal" exists to assert. The case then
 * passes a clean path to a detector that correctly reports no symlink, and goes
 * green while checking nothing. `pathlib` and `os.path.join` both concatenate
 * without normalising, and `osJoin` is this repository's transcription of the
 * latter.
 */
function under(...parts: readonly string[]): string {
  const [first, ...rest] = parts;
  return osJoin(first as string, ...rest);
}

// ---------------------------------------------------------------------------
// _absolute_symlink_in_chain
// ---------------------------------------------------------------------------

describe("_absolute_symlink_in_chain", () => {
  symlinkTest("absolute symlink in chain detects link in ancestor", () => {
    const { home } = escapingHome("chain-ancestor");
    expect(absoluteSymlinkInChain(under(home, ".aws"))).toBe(under(home, ".aws"));
  });

  symlinkTest("absolute symlink in chain detects link above target", () => {
    // The offending link is an *ancestor* of the deny path, not the path
    // itself; bwrap fails all the same.
    const { home } = escapingHome("chain-above");
    expect(absoluteSymlinkInChain(under(home, ".aws", "config"))).toBe(under(home, ".aws"));
  });

  symlinkTest("absolute symlink in chain ignores clean path", () => {
    const { home } = escapingHome("chain-clean");
    expect(absoluteSymlinkInChain(under(home, ".ssh"))).toBeNull();
  });

  symlinkTest("absolute symlink in chain ignores relative symlink", () => {
    // This is the empirically-verified boundary of the bug: an otherwise
    // identical fixture with a *relative* link launches bwrap successfully, so
    // canonicalizing it would be churn with no safety benefit.
    const tmp = caseTree("chain-rel-symlink");
    mkdirSync(join(tmp, "target"));
    writeFileSync(join(tmp, "target", "config"), "x", "utf8");
    linkToDir(join(tmp, "link"), "target"); // relative
    expect(absoluteSymlinkInChain(under(tmp, "link"))).toBeNull();
  });

  test("absolute symlink in chain ignores relative path", () => {
    expect(absoluteSymlinkInChain("relative/path")).toBeNull();
  });

  symlinkTest("absolute symlink in chain survives parent traversal", () => {
    // `..` after the link must not hide it.
    //
    // `normpath` would collapse `.aws/..` textually and drop the link component
    // entirely, reporting a clean chain for a path the kernel resolves *through*
    // the absolute symlink.
    const { home } = escapingHome("chain-pardir");
    expect(absoluteSymlinkInChain(under(home, ".aws", "..", "elsewhere"))).toBe(
      under(home, ".aws"),
    );
  });

  symlinkTest("absolute symlink in chain tolerates redundant separators", () => {
    const { home } = escapingHome("chain-redundant");
    // Rule syntax, not a host path: the source writes this one with `/`
    // literals and `str.__add__`, so it is built the same way here rather than
    // through `join`, which would normalise away the very redundancy under test.
    expect(absoluteSymlinkInChain(`${home}//.aws/./config`)).toBe(under(home, ".aws"));
  });

  symlinkTest("absolute symlink reached through relative link", () => {
    // A relative link pointing at an absolute one still breaks bwrap.
    //
    // Verified directly against bubblewrap 0.6.1: binding through
    // `rel -> abs -> /elsewhere` aborts the launch, while a purely relative
    // chain succeeds. A per-component check of each *literal* name would clear
    // `rel` and never inspect `abs`.
    const tmp = caseTree("chain-rel-to-abs");
    const external = join(tmp, "external");
    mkdirSync(external);
    linkToDir(join(tmp, "abs_link"), external); // absolute
    linkToDir(join(tmp, "rel_link"), "abs_link"); // relative -> absolute
    expect(absoluteSymlinkInChain(under(tmp, "rel_link", "config"))).toBe(under(tmp, "abs_link"));
  });

  symlinkTest("purely relative chain stays clean", () => {
    // Control for the case above: relative-only chains are bwrap-safe.
    const tmp = caseTree("chain-rel-only");
    mkdirSync(join(tmp, "external"));
    linkToDir(join(tmp, "hop"), "external");
    linkToDir(join(tmp, "rel_link"), "hop");
    expect(absoluteSymlinkInChain(under(tmp, "rel_link", "c"))).toBeNull();
  });

  symlinkTest("absolute symlink in chain bounds symlink loops", () => {
    // A relative symlink loop must terminate rather than spin.
    const tmp = caseTree("chain-loop");
    linkToDir(join(tmp, "a"), "b");
    linkToDir(join(tmp, "b"), "a");
    expect(absoluteSymlinkInChain(under(tmp, "a"))).toBeNull();
  });

  test("absolute symlink in chain walks windows drive paths", () => {
    // The walk must start at the drive anchor, not at `os.sep`.
    //
    // On Windows `os.path.join('\\', 'C:')` returns the drive-*relative* `'C:'`,
    // so a walk seeded with `os.sep` rebases every component onto a path that
    // does not exist and reports every chain as clean. This is the case that
    // took every Windows CI job down.
    //
    // -- ADAPTED (D-0214) -- The source simulates `ntpath` by patching
    // `generator.os.path`, `os.sep` and `os.altsep`. This port has no `os`
    // module object to patch: `pypath.ts` dispatches on `process.platform` at
    // CALL time, deliberately, so the simulation is a `process.platform` of
    // `"win32"` for the length of this case. `Object.defineProperty`, not
    // assignment -- `platform` is a getter, and a silently ignored assignment
    // would leave the whole case running on POSIX and passing for the wrong
    // reason. Same substitution, same three answers changed, and the assertions
    // are the source's byte for byte.
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    onTestFinished(() => {
      if (realPlatform !== undefined) {
        Object.defineProperty(process, "platform", realPlatform);
      }
    });

    const link = String.raw`C:\Users\me\.aws`;
    const visited: string[] = [];
    const hit = absoluteSymlinkInChain(String.raw`C:\Users\me\.aws\config`, {
      islinkFn: (path: string): boolean => {
        visited.push(path);
        return path === link;
      },
      readlinkFn: (): string => String.raw`D:\external\.aws`,
    });
    expect(hit).toBe(link);
    // The drive-relative bug showed up as "C:Users..." (no separator).
    expect(visited).toContain(String.raw`C:\Users`);
    expect(visited.some((v) => v.startsWith("C:U"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the bwrap oracle
// ---------------------------------------------------------------------------

describe("the bwrap oracle", () => {
  bwrapTest("detector agrees with real bwrap", () => {
    // Oracle test: the detector's verdict must match bubblewrap's.
    //
    // The whole fix rests on one empirical claim -- that an absolute symlink in
    // the resolved chain is exactly what makes bwrap abort. This pins that claim
    // to the real binary instead of to our reading of it, so a wrong refinement
    // of the walk fails here rather than silently disabling workers' sandboxes
    // again.
    const tmp = caseTree("bwrap-oracle");
    const external = join(tmp, "external");
    mkdirSync(external);
    writeFileSync(join(external, "config"), "", "utf8");
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "config"), "", "utf8");
    linkToDir(join(tmp, "abs_link"), external);
    linkToDir(join(tmp, "rel_link"), "abs_link");
    linkToDir(join(tmp, "rel_only"), "external");

    const cases = [
      join(plain, "config"),
      join(tmp, "abs_link", "config"),
      join(tmp, "rel_link", "config"),
      join(tmp, "rel_only", "config"),
      join(tmp, "abs_link", "..", "external", "config"),
    ];
    for (const target of cases) {
      const detected = absoluteSymlinkInChain(target) !== null;
      const proc = spawnSync(
        "bwrap",
        [
          // No --proc / --dev: they shadow the corresponding host trees, and a
          // shadowed region has no symlink to trip over. With them, this test's
          // verdict would depend on where the temp root happens to be.
          "--ro-bind",
          "/",
          "/",
          "--ro-bind",
          "/dev/null",
          target,
          "true",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(
        detected,
        `${target}: detector=${detected} but bwrap rc=${proc.status} (${(proc.stderr ?? "").trim()})`,
      ).toBe(proc.status !== 0);
    }
  });

  bwrapTest("shadowing mount hides the symlink failure", () => {
    // A mount over the region makes the same deny path bind cleanly.
    //
    // This is the one case where the static verdict and bwrap disagree, and it
    // is why the canary must not pass `--proc` / `--dev`: those mount fresh
    // filesystems over the host trees, so no symlink exists there for bwrap to
    // trip over and it just creates plain directories. Pinning the behaviour
    // here keeps the canary's mount choice from looking arbitrary.
    const tmp = caseTree("bwrap-shadow");
    const external = join(tmp, "external");
    mkdirSync(external);
    writeFileSync(join(external, "config"), "", "utf8");
    linkToDir(join(tmp, "abs_link"), external);
    const target = join(tmp, "abs_link", "config");

    const probe = (extra: readonly string[]): number | null =>
      spawnSync(
        "bwrap",
        ["--ro-bind", "/", "/", ...extra, "--ro-bind", "/dev/null", target, "true"],
        { encoding: "utf8", timeout: 60_000 },
      ).status;

    // Visible link -> launch aborts. Shadowed by a tmpfs -> it does not.
    expect(probe([])).not.toBe(0);
    expect(probe(["--tmpfs", tmp])).toBe(0);
  });

  test("canary does not shadow probed paths", () => {
    // The canary's argv must not contain region-shadowing mounts.
    const tmp = caseTree("canary-argv");
    const captured: string[][] = [];
    const runner = (cmd: string[]): CompletedProcess => {
      captured.push(cmd);
      return { args: cmd, returncode: 0, stdout: "", stderr: "" };
    };

    // A real path under the case root, not a POSIX system file: the canary
    // skips targets that do not exist, so hardcoding /etc/hosts would make this
    // assert nothing at all on Windows.
    const probed = join(tmp, "hosts");
    writeFileSync(probed, "", "utf8");

    runBwrapCanary(
      [
        {
          layer: "permissions.deny",
          source: `Read(//${probed.replace(/^\/+/, "")})`,
          path: probed,
          sourceFile: "",
          sourceSpelling: undefined,
        },
      ],
      { runner, bwrapPath: "bwrap" },
    );
    expect(captured.length, "canary did not invoke the runner").toBeGreaterThan(0);
    expect(captured[0]).not.toContain("--dev");
    expect(captured[0]).not.toContain("--proc");
  });

  symlinkTest("report explains static fail with canary pass", () => {
    escapingHome("report-static-fail");
    const okRunner = (cmd: string[]): CompletedProcess => ({
      args: cmd,
      returncode: 0,
      stdout: "",
      stderr: "",
    });
    const report = diagnose(settingsWithDeny(["Read(~/.aws/*)"]), {
      probeBwrap: true,
      runner: okRunner,
    });
    expect(report.canaryStatus).toBe(CANARY_PASS);
    expect(reportOk(report), "a hidden-link pass must not be treated as healthy").toBe(false);
    expect(formatReport(report)).toContain("only bindable while some mount hides the link");
  });

  symlinkTest("canonicalize permission deny handles write rules", () => {
    // `Write(...)` is a Layer 2 path deny in this repo's schema.
    const { tmp } = escapingHome("canon-write");
    const [out, rewrites] = canonicalizePermissionDeny(
      ["Write(~/.aws/*)", "Write(*/workers/*/settings.local.json)"],
      {},
    );
    const external = join(tmp, "external", ".aws");
    expect(out).toStrictEqual([
      `Write(//${external.replace(/^\/+/, "")}/*)`,
      "Write(*/workers/*/settings.local.json)",
    ]);
    expect(rewrites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// permission rule parsing
// ---------------------------------------------------------------------------

describe("permission rule parsing", () => {
  parametrize<[rule: unknown, expected: [string, string] | null]>(
    "test_split_permission_rule",
    [
      ["Read(~/.aws/*)-expected0", ["Read(~/.aws/*)", ["Read", "~/.aws/*"]]],
      ["Edit(//abs/path)-expected1", ["Edit(//abs/path)", ["Edit", "//abs/path"]]],
      ["Bash(git push *)-expected2", ["Bash(git push *)", ["Bash", "git push *"]]],
      ["not-a-rule-None", ["not-a-rule", null]],
      ["(missing-tool)-None", ["(missing-tool)", null]],
      ["123-None", [123, null]],
    ],
    ([rule, expected]) => {
      expect(splitPermissionRule(rule)).toStrictEqual(expected);
    },
  );

  symlinkTest("permission rule host path anchored forms", () => {
    // Only the anchor is substituted; the rest of the rule is verbatim.
    //
    // The expectation is built by string concatenation rather than
    // `join(home, ".aws")` on purpose. Permission-rule paths are rule syntax,
    // which always separates with `/`, so the tail is preserved as authored;
    // joining via a path helper would assert a backslash on Windows and demand a
    // normalisation the rule grammar does not want.
    const { home } = escapingHome("rule-anchored");
    expect(permissionRuleHostPath("~/.aws/*")).toBe(`${home}/.aws/*`);
    expect(permissionRuleHostPath("//mnt/c/x")).toBe("/mnt/c/x");
  });

  parametrize<string>(
    "test_permission_rule_host_path_unanchored_is_none",
    [
      [".env", ".env"],
      ["**/credentials*", "**/credentials*"],
      ["/project/rel", "/project/rel"],
    ],
    (spec) => {
      // Unanchored / project-relative specs never become host paths.
      //
      // Verified against the real client: a settings file whose only deny rule
      // was `Read(**/credentials*)` started the sandbox fine, while
      // `Read(~/.aws/*)` alone brought it down.
      expect(permissionRuleHostPath(spec)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Layer 2 canonicalization
// ---------------------------------------------------------------------------

describe("Layer 2 canonicalization", () => {
  symlinkTest("canonicalize permission deny rewrites escaping rule", () => {
    const { home, tmp } = escapingHome("canon-l2-rewrite");
    const deny = [
      "Bash(git push *)",
      "Read(.env)",
      "Read(**/credentials*)",
      "Read(~/.ssh/*)",
      "Read(~/.aws/*)",
    ];
    const [out, rewrites] = canonicalizePermissionDeny(deny, {});

    const external = join(tmp, "external", ".aws");
    expect(out).toStrictEqual([
      "Bash(git push *)",
      "Read(.env)",
      "Read(**/credentials*)",
      "Read(~/.ssh/*)",
      `Read(//${external.replace(/^\/+/, "")}/*)`,
    ]);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]?.layer).toBe("permissions.deny");
    expect(rewrites[0]?.original).toBe("Read(~/.aws/*)");
    expect(rewrites[0]?.symlink).toBe(under(home, ".aws"));
    expect(rewrites[0]?.realpath).toBe(external);
  });

  symlinkTest("canonicalize permission deny preserves glob tail", () => {
    const { tmp } = escapingHome("canon-l2-glob");
    const [out] = canonicalizePermissionDeny(["Read(~/.aws/**/*.pem)"], {});
    const external = join(tmp, "external", ".aws");
    expect(out).toStrictEqual([`Read(//${external.replace(/^\/+/, "")}/**/*.pem)`]);
  });

  symlinkTest("canonicalize permission deny noop without symlink", () => {
    escapingHome("canon-l2-noop");
    const deny = ["Read(~/.ssh/*)", "Bash(rm -rf *)", "Read(**/*.pem)"];
    const [out, rewrites] = canonicalizePermissionDeny(deny, {});
    expect(out).toStrictEqual(deny);
    expect(rewrites).toStrictEqual([]);
  });

  symlinkTest("canonicalize permission deny ignores non path tools", () => {
    // Only Read/Edit contribute paths to the sandbox deny set.
    const { home } = escapingHome("canon-l2-nonpath");
    const deny = [`Bash(cat ${home}/.aws/config)`];
    const [out, rewrites] = canonicalizePermissionDeny(deny, {});
    expect(out).toStrictEqual(deny);
    expect(rewrites).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 canonicalization
// ---------------------------------------------------------------------------

describe("Layer 3 canonicalization", () => {
  symlinkTest("canonicalize sandbox deny rewrites kept entry", () => {
    const { home, tmp } = escapingHome("canon-l3-kept");
    const entries = [under(home, ".aws", "config"), "/plain/path"];
    const [out, rewrites] = canonicalizeSandboxDeny(entries, "sandbox.filesystem.denyRead", {});
    const external = join(tmp, "external", ".aws");
    expect(out).toStrictEqual([under(external, "config"), "/plain/path"]);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]?.layer).toBe("sandbox.filesystem.denyRead");
  });

  symlinkTest("canonicalize sandbox deny expands tilde entries", () => {
    // `~/` Layer 3 raw strings reach bwrap expanded, so check them expanded.
    //
    // The authored string does not start with `/`, but Claude Code resolves the
    // prefix against the home directory when building the deny set, so a tilde
    // entry over a symlinked directory is just as fatal.
    const { tmp } = escapingHome("canon-l3-tilde");
    const [out, rewrites] = canonicalizeSandboxDeny(
      ["~/.aws/**", "~/.ssh/**"],
      "sandbox.filesystem.denyRead",
      {},
    );
    const external = join(tmp, "external", ".aws");
    expect(out).toStrictEqual([`${external}/**`, "~/.ssh/**"]);
    expect(rewrites).toHaveLength(1);
  });

  // `@pytest.mark.parametrize("enabled", [True, False])`, spelled out rather
  // than run through `parametrize`, because both rows need the symlink fixture
  // and `parametrize` declares its cases with the plain `test`. Routing the
  // condition through the BODY instead -- an early `return` when symlinks are
  // unavailable -- is the mapping section 4 names as the first of its three
  // failure modes: the body runs, the fixture work happens, and the case is
  // reported as a pass. The ids are pytest's, byte for byte.
  for (const [id, enabled] of [
    ["True", true],
    ["False", false],
  ] as const) {
    symlinkTest(`test_layer3_canonicalized_regardless_of_enabled[${id}]`, () => {
      // Deny arrays merge across scopes independently of who enables the sandbox.
      //
      // An entry rendered under a locally-disabled sandbox still reaches bwrap
      // once another scope turns the sandbox on, so gating the rewrite on the
      // local flag would leave an escaping path in the file.
      const { tmp } = escapingHome(`l3-enabled-${id}`);
      const result = renderRoleWithMetadata(sandboxRoleSchema(["~/.aws/**"], enabled), {
        role: "demo",
        workerDir: join(tmp, "wd"),
        claudeOrgPath: join(tmp, "co"),
      });
      const external = join(tmp, "external", ".aws");
      const sandbox = result.settings["sandbox"] as Record<string, unknown>;
      const fs = sandbox["filesystem"] as Record<string, unknown>;
      expect(fs["denyRead"]).toStrictEqual([`${external}/**`]);
      expect(result.sandbox.rewrites).toHaveLength(1);
    });
  }

  symlinkTest("canonicalize sandbox deny leaves structured entries", () => {
    escapingHome("canon-l3-structured");
    const entries = [{ anchor: "home", path: ".aws/**" }];
    const [out, rewrites] = canonicalizeSandboxDeny(entries, "sandbox.filesystem.denyRead", {});
    expect(out).toStrictEqual(entries);
    expect(rewrites).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderer integration
// ---------------------------------------------------------------------------

describe("renderer integration", () => {
  symlinkTest("render rewrites layer2 deny and reports metadata", () => {
    const { tmp } = escapingHome("render-l2");
    const result = renderRoleWithMetadata(roleSchema(["Read(~/.aws/*)", "Read(~/.ssh/*)"]), {
      role: "demo",
      workerDir: join(tmp, "wd"),
      claudeOrgPath: join(tmp, "co"),
      wslDetector: () => true,
    });
    const external = join(tmp, "external", ".aws");
    const expected = `Read(//${external.replace(/^\/+/, "")}/*)`;
    const permissions = result.settings["permissions"] as Record<string, unknown>;
    expect(permissions["deny"]).toStrictEqual([expected, "Read(~/.ssh/*)"]);
    expect(result.sandbox.rewrites).toHaveLength(1);
    const comment = result.settings["$comment"] as string;
    expect(comment).toContain("symlink-canonicalized deny paths");
    expect(comment.startsWith("platform=wsl, layer-3 entries suppressed: []")).toBe(true);
  });

  symlinkTest("render leaves clean deny untouched and emits no comment", () => {
    const { tmp } = escapingHome("render-clean");
    const result = renderRoleWithMetadata(roleSchema(["Read(~/.ssh/*)", "Bash(git push *)"]), {
      role: "demo",
      workerDir: join(tmp, "wd"),
      claudeOrgPath: join(tmp, "co"),
    });
    const permissions = result.settings["permissions"] as Record<string, unknown>;
    expect(permissions["deny"]).toStrictEqual(["Read(~/.ssh/*)", "Bash(git push *)"]);
    expect(result.sandbox.rewrites).toStrictEqual([]);
    expect(Object.hasOwn(result.settings, "$comment")).toBe(false);
  });

  symlinkTest("render metadata jsonable includes rewrites", () => {
    const { home, tmp } = escapingHome("render-jsonable");
    const result = renderRoleWithMetadata(roleSchema(["Read(~/.aws/*)"]), {
      role: "demo",
      workerDir: join(tmp, "wd"),
      claudeOrgPath: join(tmp, "co"),
    });
    const payload = sandboxMetadataToJsonable(result.sandbox);
    const rewrites = payload["rewrites"] as Record<string, unknown>[];
    expect(rewrites[0]?.["original"]).toBe("Read(~/.aws/*)");
    expect(rewrites[0]?.["symlink"]).toBe(under(home, ".aws"));
    // must stay JSON-serializable for `settings show --json`
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  symlinkTest("settings show explain surfaces rewrites", () => {
    const { tmp } = escapingHome("render-explain");
    const result = renderRoleWithMetadata(roleSchema(["Read(~/.aws/*)"]), {
      role: "demo",
      workerDir: join(tmp, "wd"),
      claudeOrgPath: join(tmp, "co"),
    });
    const text = formatShowOutput(result, "demo", { explain: true, asJson: false });
    expect(text).toContain("rewrites (1):");
    expect(text).toContain("absolute symlink");
  });
});

// ---------------------------------------------------------------------------
// sandbox doctor
// ---------------------------------------------------------------------------

describe("sandbox doctor", () => {
  symlinkTest("collect deny targets spans both layers", () => {
    const { home } = escapingHome("collect-both");
    const settings = settingsWithDeny(
      ["Read(~/.aws/*)", "Bash(git push *)", "Read(**/credentials*)"],
      [under(home, ".ssh")],
    );
    const targets = collectDenyTargets(settings);
    expect(new Set(targets.map((t) => t.layer))).toStrictEqual(
      new Set(["permissions.deny", "sandbox.filesystem.denyRead"]),
    );
    // Bash rules and unanchored globs contribute no host path.
    expect(targets).toHaveLength(2);
  });

  symlinkTest("collect deny targets expands tilde in layer3", () => {
    const { home } = escapingHome("collect-tilde");
    const targets = collectDenyTargets(settingsWithDeny([], ["~/.ssh"]));
    // Concatenated, not path-joined: only the anchor is substituted, so the
    // entry keeps its authored "/".
    expect(targets[0]?.path).toBe(`${home}/.ssh`);
  });

  symlinkTest("analyze targets flags symlink escape", () => {
    const { tmp } = escapingHome("analyze-escape");
    const settings = settingsWithDeny(["Read(~/.aws/*)", "Read(~/.ssh/*)"]);
    const findings = analyzeTargets(collectDenyTargets(settings));
    const bad = findings.filter((f) => f.status === STATUS_SYMLINK_ESCAPE);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.source).toBe("Read(~/.aws/*)");
    expect(bad[0]?.suggestion).toBe(`${join(tmp, "external", ".aws")}/*`);
  });

  symlinkTest("diagnose reports not ok on escape", () => {
    escapingHome("diagnose-escape");
    const report = diagnose(settingsWithDeny(["Read(~/.aws/*)"]), { probeBwrap: false });
    expect(reportOk(report)).toBe(false);
    expect(reportFailures(report)).toHaveLength(1);
    expect(report.canaryStatus).toBe(CANARY_SKIPPED);
  });

  symlinkTest("diagnose ok on clean settings", () => {
    escapingHome("diagnose-clean");
    const report = diagnose(settingsWithDeny(["Read(~/.ssh/*)"]), { probeBwrap: false });
    expect(reportOk(report)).toBe(true);
    expect(reportFailures(report)).toStrictEqual([]);
  });

  symlinkTest("canary failure marks report not ok", () => {
    // A canary failure fails the report even when static analysis is clean.
    //
    // This is the point of having a live probe: it catches unbindable deny
    // paths whose cause is not a symlink.
    escapingHome("canary-fail");
    const failingRunner = (cmd: string[]): CompletedProcess => ({
      args: cmd,
      returncode: 1,
      stdout: "",
      stderr: "bwrap: Can't create file at /x: No such file or directory\n",
    });
    const report = diagnose(settingsWithDeny(["Read(~/.ssh/*)"]), {
      probeBwrap: true,
      runner: failingRunner,
    });
    expect(reportFailures(report)).toStrictEqual([]);
    expect(report.canaryStatus).toBe(CANARY_FAIL);
    expect(report.canaryDetail).toContain("Can't create file");
    expect(reportOk(report)).toBe(false);
  });

  symlinkTest("canary pass", () => {
    escapingHome("canary-pass");
    const okRunner = (cmd: string[]): CompletedProcess => ({
      args: cmd,
      returncode: 0,
      stdout: "",
      stderr: "",
    });
    const report = diagnose(settingsWithDeny(["Read(~/.ssh/*)"]), {
      probeBwrap: true,
      runner: okRunner,
    });
    expect(report.canaryStatus).toBe(CANARY_PASS);
    expect(reportOk(report)).toBe(true);
  });

  symlinkTest("canary skipped when bwrap missing", () => {
    escapingHome("canary-missing");
    patchSeam(doctorSeams, "which", () => null);
    const [status, detail] = runBwrapCanary([]);
    expect(status).toBe(CANARY_SKIPPED);
    expect(detail).toContain("bwrap not found");
  });

  symlinkTest("format report names the silent fallback", () => {
    // The report must state that failure is silent, not just that it failed.
    escapingHome("format-fallback");
    const report = diagnose(settingsWithDeny(["Read(~/.aws/*)"]), { probeBwrap: false });
    const text = formatReport(report);
    expect(text).toContain("unsandboxed");
    expect(text).toContain("suggested rewrite:");
  });

  symlinkTest("format report ascii only", () => {
    // CLI output must survive a cp932 console (D-0006).
    //
    // The source asserts this by encoding to cp932. JavaScript has no cp932
    // encoder and needs none: ASCII is a strict subset of cp932, so `isAscii`
    // implies the source's assertion. Both of its two subjects are checked.
    escapingHome("format-ascii");
    const report = diagnose(settingsWithDeny(["Read(~/.aws/*)"]), { probeBwrap: false });
    expect(isAscii(formatReport(report, { verbose: true }))).toBe(true);
    expect(isAscii(buildDoctorParser().help())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// doctor CLI
// ---------------------------------------------------------------------------

describe("doctor CLI", () => {
  symlinkTest("doctor cli exit 1 on escape", () => {
    const { tmp } = escapingHome("cli-exit1");
    const path = writeSettings(tmp, settingsWithDeny(["Read(~/.aws/*)"]));
    const buf = captureStdout();
    const rc = runDoctor({
      settings: [path],
      json: false,
      verbose: false,
      probe_bwrap: false,
      merge_scopes: false,
    });
    expect(rc).toBe(1);
    expect(buf.text()).toContain("FAIL");
  });

  symlinkTest("doctor cli exit 0 on clean", () => {
    const { tmp } = escapingHome("cli-exit0");
    const path = writeSettings(tmp, settingsWithDeny(["Read(~/.ssh/*)"]));
    captureStdout();
    expect(
      runDoctor({
        settings: [path],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: false,
      }),
    ).toBe(0);
  });

  symlinkTest("doctor cli json output", () => {
    const { tmp } = escapingHome("cli-json");
    const path = writeSettings(tmp, settingsWithDeny(["Read(~/.aws/*)"]));
    const buf = captureStdout();
    // `settings=path`, not `settings=[path]`: the source passes the bare value
    // here and the list-coercion branch in `run` is what makes it work.
    const rc = runDoctor({ settings: path, json: true, verbose: false, probe_bwrap: false });
    const payload = JSON.parse(buf.text()) as Record<string, unknown>;
    expect(rc).toBe(1);
    expect(payload["ok"]).toBe(false);
    const findings = payload["findings"] as Record<string, unknown>[];
    expect(findings[0]?.["status"]).toBe(STATUS_SYMLINK_ESCAPE);
  });

  test("doctor cli missing file", () => {
    const tmp = caseTree("cli-missing");
    captureStderr();
    expect(
      runDoctor({
        settings: [join(tmp, "nope.json")],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: false,
      }),
    ).toBe(2);
  });

  test("doctor cli invalid json", () => {
    const tmp = caseTree("cli-badjson");
    const path = join(tmp, "bad.json");
    writeFileSync(path, "{not json", "utf8");
    captureStderr();
    expect(
      runDoctor({
        settings: [path],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: false,
      }),
    ).toBe(2);
  });

  test("doctor cli non object root", () => {
    const tmp = caseTree("cli-listroot");
    const path = join(tmp, "list.json");
    writeFileSync(path, "[]", "utf8");
    captureStderr();
    expect(
      runDoctor({
        settings: [path],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: false,
      }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// gate robustness: disabled sandbox and malformed shapes
// ---------------------------------------------------------------------------

describe("gate robustness", () => {
  symlinkTest("disabled sandbox passes the gate but still reports", () => {
    // A role that never launches a sandbox must not fail the gate.
    //
    // The finding is still listed: deny arrays merge across settings scopes, so
    // the path goes live the moment another scope enables the sandbox.
    escapingHome("gate-disabled");
    const settings = {
      permissions: { deny: ["Read(~/.aws/*)"] },
      sandbox: { enabled: false, filesystem: { denyRead: [] } },
    };
    const report = diagnose(settings, { probeBwrap: false });
    expect(report.sandboxDisabled).toBe(true);
    expect(reportOk(report)).toBe(true);
    expect(reportFailures(report)).toHaveLength(1);
    expect(formatReport(report)).toContain("latent");
  });

  symlinkTest("absent sandbox key still gates", () => {
    // Absent != disabled: user or managed settings can enable it.
    escapingHome("gate-absent");
    const report = diagnose({ permissions: { deny: ["Read(~/.aws/*)"] } }, { probeBwrap: false });
    expect(report.sandboxDisabled).toBe(false);
    expect(reportOk(report)).toBe(false);
  });

  parametrize<[settings: unknown, expected: string]>(
    "test_validate_settings_rejects_bad_shapes",
    [
      [
        "settings0-permissions.deny",
        [{ permissions: { deny: "Read(~/.aws/*)" } }, "permissions.deny"],
      ],
      ["settings1-permissions", [{ permissions: [] }, "permissions"]],
      ["settings2-sandbox", [{ sandbox: [] }, "sandbox"]],
      ["settings3-sandbox.filesystem", [{ sandbox: { filesystem: [] } }, "sandbox.filesystem"]],
      [
        "settings4-sandbox.filesystem.denyRead",
        [{ sandbox: { filesystem: { denyRead: "x" } } }, "sandbox.filesystem.denyRead"],
      ],
      ["settings5-settings root", [[], "settings root"]],
    ],
    ([settings, expected]) => {
      const message = validateSettings(settings);
      expect(message).not.toBeNull();
      expect(message as string).toContain(expected);
    },
  );

  test("validate settings accepts good shape", () => {
    expect(validateSettings(settingsWithDeny([]))).toBeNull();
  });

  symlinkTest("deny as bare string exits 2 not 0", () => {
    // The character-iteration trap: a bare string must not read as clean.
    const { tmp } = escapingHome("gate-barestring");
    const path = writeSettings(tmp, { permissions: { deny: "Read(~/.aws/*)" } });
    captureStderr();
    expect(
      runDoctor({
        settings: [path],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: false,
      }),
    ).toBe(2);
  });

  symlinkTest("non string deny entry is flagged not skipped", () => {
    escapingHome("gate-nonstring");
    const settings = settingsWithDeny([{ anchor: "home", path: ".aws/**" }], []);
    const report = diagnose(settings, { probeBwrap: false });
    expect(reportOk(report)).toBe(false);
    expect(reportFailures(report)[0]?.status).toBe(STATUS_UNSUPPORTED);
  });

  symlinkTest("unified cli wires sandbox doctor", () => {
    const { tmp } = escapingHome("gate-unified");
    const path = writeSettings(tmp, settingsWithDeny(["Read(~/.aws/*)"]));
    const parser = buildContinuoParser();
    const args = parser.parseArgs(
      ["sandbox", "doctor", "--settings", path, "--no-probe-bwrap", "--no-merge-scopes"],
      defaultStreams(),
    );
    captureStdout();
    expect(args.func?.(args)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// multi-scope merge
// ---------------------------------------------------------------------------

describe("multi-scope merge", () => {
  symlinkTest("merged scopes catch a clean file with a dirty user scope", () => {
    // A clean worker file must not pass when another scope is broken.
    //
    // Claude Code unions the deny arrays across scopes, so a symlinked path in
    // `~/.claude/settings.json` aborts the launch regardless of how clean the
    // rendered worker file is. Checking the worker file alone is exactly the
    // false-clean this command exists to prevent.
    escapingHome("merge-dirty-user");
    const worker = { label: "worker", settings: settingsWithDeny(["Read(~/.ssh/*)"]) };
    const user = {
      label: "user",
      settings: { sandbox: { filesystem: { denyRead: ["~/.aws"] } } },
    };

    expect(reportOk(diagnoseSources([worker], { probeBwrap: false }))).toBe(true);
    const merged = diagnoseSources([worker, user], { probeBwrap: false });
    expect(reportOk(merged)).toBe(false);
    expect(reportFailures(merged)[0]?.sourceFile).toBe("user");
  });

  symlinkTest("findings name the contributing file", () => {
    escapingHome("merge-names-file");
    const report = diagnoseSources(
      [{ label: "/etc/managed.json", settings: settingsWithDeny(["Read(~/.aws/*)"]) }],
      { probeBwrap: false },
    );
    expect(formatReport(report)).toContain("/etc/managed.json");
  });

  symlinkTest("any scope enabling the sandbox keeps the gate", () => {
    // Disabled locally + enabled by another scope still gates.
    escapingHome("merge-any-enables");
    const local = {
      label: "worker",
      settings: {
        permissions: { deny: ["Read(~/.aws/*)"] },
        sandbox: { enabled: false },
      },
    };
    const user = { label: "user", settings: { sandbox: { enabled: true } } };
    const report = diagnoseSources([local, user], { probeBwrap: false });
    expect(report.sandboxDisabled).toBe(false);
    expect(reportOk(report)).toBe(false);
  });

  test("discover merged scopes only returns existing files", () => {
    const tmp = caseTree("discover-existing");
    setFakeHome(tmp);
    patchSeam(doctorSeams, "managedSettingsPaths", []);
    expect(discoverMergedScopes()).toStrictEqual([]);

    const claudeDir = join(tmp, ".claude");
    mkdirSync(claudeDir);
    writeFileSync(join(claudeDir, "settings.json"), "{}", "utf8");
    expect(discoverMergedScopes()).toStrictEqual([join(claudeDir, "settings.json")]);
  });

  test("discover merged scopes adds the sibling project scope", () => {
    // `settings.json` and `settings.local.json` are separate scopes.
    //
    // Claude Code unions both, so pointing --settings at one must not leave the
    // other unaudited.
    const tmp = caseTree("discover-sibling");
    setFakeHome(join(tmp, "nowhere"));
    patchSeam(doctorSeams, "managedSettingsPaths", []);
    const project = join(tmp, "proj", ".claude");
    mkdirSync(project, { recursive: true });
    const local = join(project, "settings.local.json");
    writeFileSync(local, "{}", "utf8");
    const shared = join(project, "settings.json");
    writeFileSync(shared, "{}", "utf8");

    expect(discoverMergedScopes([local])).toStrictEqual([shared]);
    // ...and the other direction.
    expect(discoverMergedScopes([shared])).toStrictEqual([local]);
  });

  test("discover merged scopes does not duplicate the input", () => {
    const tmp = caseTree("discover-nodupe");
    setFakeHome(join(tmp, "nowhere"));
    patchSeam(doctorSeams, "managedSettingsPaths", []);
    const project = join(tmp, ".claude");
    mkdirSync(project);
    const only = join(project, "settings.json");
    writeFileSync(only, "{}", "utf8");
    expect(discoverMergedScopes([only])).toStrictEqual([]);
  });

  symlinkTest("sibling project scope breaks the gate", () => {
    // End-to-end: a dirty sibling must fail an otherwise clean run.
    const { tmp } = escapingHome("merge-sibling-gate");
    patchSeam(doctorSeams, "managedSettingsPaths", []);
    const project = join(tmp, "proj", ".claude");
    mkdirSync(project, { recursive: true });
    const local = join(project, "settings.local.json");
    writeFileSync(local, JSON.stringify(settingsWithDeny(["Read(~/.ssh/*)"])), "utf8");
    writeFileSync(
      join(project, "settings.json"),
      JSON.stringify({ sandbox: { enabled: true, filesystem: { denyRead: ["~/.aws"] } } }),
      "utf8",
    );
    const buf = captureStdout();
    const rc = runDoctor({
      settings: [local],
      json: true,
      verbose: false,
      probe_bwrap: false,
      merge_scopes: true,
    });
    const payload = JSON.parse(buf.text()) as Record<string, unknown>;
    expect(rc).toBe(1);
    const failing = (payload["findings"] as Record<string, unknown>[]).filter(
      (f) => f["status"] === STATUS_SYMLINK_ESCAPE,
    );
    expect(failing).toHaveLength(1);
    expect(failing[0]?.["source_file"]).toBe(join(project, "settings.json"));
  });

  symlinkTest("cli merges extra scopes and reports the source", () => {
    const { tmp } = escapingHome("merge-extra-scope");
    const worker = writeSettings(tmp, settingsWithDeny(["Read(~/.ssh/*)"]));
    const extra = join(tmp, "user-settings.json");
    writeFileSync(
      extra,
      JSON.stringify({ sandbox: { enabled: true, filesystem: { denyRead: ["~/.aws"] } } }),
      "utf8",
    );
    patchSeam(doctorSeams, "discoverMergedScopes", () => [extra]);
    const buf = captureStdout();
    const rc = runDoctor({
      settings: [worker],
      json: true,
      verbose: false,
      probe_bwrap: false,
      merge_scopes: true,
    });
    const payload = JSON.parse(buf.text()) as Record<string, unknown>;
    expect(rc).toBe(1);
    const failing = (payload["findings"] as Record<string, unknown>[]).filter(
      (f) => f["status"] === STATUS_SYMLINK_ESCAPE,
    );
    expect(failing).toHaveLength(1);
    expect(failing[0]?.["source_file"]).toBe(extra);
  });

  symlinkTest("cli no merge scopes skips discovery", () => {
    const { tmp } = escapingHome("merge-no-discovery");
    const worker = writeSettings(tmp, settingsWithDeny(["Read(~/.ssh/*)"]));
    patchSeam(doctorSeams, "discoverMergedScopes", () => {
      throw new Error("must not be called");
    });
    captureStdout();
    expect(
      runDoctor({
        settings: [worker],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: false,
      }),
    ).toBe(0);
  });

  symlinkTest("cli reports which scope is malformed", () => {
    const { tmp } = escapingHome("merge-malformed-scope");
    const worker = writeSettings(tmp, settingsWithDeny([]));
    const bad = join(tmp, "bad-scope.json");
    writeFileSync(bad, "{not json", "utf8");
    patchSeam(doctorSeams, "discoverMergedScopes", () => [bad]);
    captureStderr();
    expect(
      runDoctor({
        settings: [worker],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: true,
      }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// helpers used above
// ---------------------------------------------------------------------------

/** `_settings_with_deny`. */
function settingsWithDeny(
  deny: readonly unknown[],
  sandboxDeny?: readonly unknown[],
): Record<string, unknown> {
  return {
    permissions: { deny: [...deny] },
    sandbox: {
      enabled: true,
      filesystem: { denyRead: [...(sandboxDeny ?? [])], denyWrite: [] },
    },
  };
}

/** `_sandbox_role_schema`. */
function sandboxRoleSchema(deny: readonly unknown[], enabled: boolean): Record<string, unknown> {
  return {
    worker_roles: {
      demo: {
        sandbox: { enabled, filesystem: { denyRead: [...deny], denyWrite: [] } },
      },
    },
  };
}

/** `_role_schema`. */
function roleSchema(deny: readonly unknown[]): Record<string, unknown> {
  return { worker_roles: { demo: { permissions: { deny: [...deny] } } } };
}

/** `_write_settings`. */
function writeSettings(dir: string, settings: Record<string, unknown>): string {
  const path = join(dir, "settings.local.json");
  writeFileSync(path, JSON.stringify(settings), "utf8");
  return path;
}

/** `redirect_stdout(io.StringIO())` over the doctor's stdout seam. */
function captureStdout(): { text: () => string } {
  let buffer = "";
  patchSeam(doctorSeams, "stdout", (t: string) => {
    buffer += t;
  });
  return { text: () => buffer };
}

/** The stderr half; the source lets `error: ...` reach `capsys` unread. */
function captureStderr(): { text: () => string } {
  let buffer = "";
  patchSeam(doctorSeams, "stderr", (t: string) => {
    buffer += t;
  });
  return { text: () => buffer };
}

// ---------------------------------------------------------------------------
// target-only: the two in-pass repairs, the seams, and the spelling carry
// ---------------------------------------------------------------------------

/**
 * Run `body` with `process.platform` reporting `"win32"`.
 *
 * `Object.defineProperty`, not assignment: `platform` is a getter, and a
 * silently ignored assignment would leave the whole case running on POSIX and
 * passing for the wrong reason. `pypath.ts` dispatches at CALL time precisely
 * so these repairs are falsifiable on the cells where most runs happen.
 */
function asPlatform<T>(platform: string, body: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return body();
  } finally {
    if (real !== undefined) {
      Object.defineProperty(process, "platform", real);
    }
  }
}

const asWindows = <T>(body: () => T): T => asPlatform("win32", body);

/**
 * The inverse, and it is not decoration.
 *
 * A case asserting a POSIX property has to SET the platform, not assume it. The
 * first draft of the `normcase` pin below asserted that two paths differing only
 * in case stay distinct, ran on whatever host it landed on, and went red on the
 * Windows CI cells -- where the assertion is false by design, because that is
 * the whole of what D-0216 changed. Forcing the platform makes it a claim about
 * `posixpath.normcase` being the identity, which is what it was always meant to
 * be, and makes it falsifiable on every cell instead of on some of them.
 */
const asPosix = <T>(body: () => T): T => asPlatform("linux", body);

describe("the malformed-filesystem repair (target-only, D-0215)", () => {
  test("a truthy non-mapping filesystem is refused, not emptied (target-only)", () => {
    // The inherited defect, pinned by its repair. interlock's
    // `_evaluate_sandbox_suppressions` is `fs = sandbox.get('filesystem') or {}`
    // followed by `if not isinstance(fs, dict): fs = {}`, so `"filesystem":
    // "invalid"` renders as `{"enabled":true,"filesystem":{"denyRead":[],
    // "denyWrite":[]}}` -- a malformed security configuration silently becoming
    // a valid, less restrictive one.
    const schema = {
      worker_roles: {
        demo: { sandbox: { enabled: true, filesystem: "invalid" }, permissions: { deny: [] } },
      },
    };
    expect(() =>
      renderRoleWithMetadata(schema, {
        role: "demo",
        workerDir: "/wd",
        claudeOrgPath: "/co",
      }),
    ).toThrow(PyValueError);
    // The message is `sandbox_doctor.validate_settings`'s own sentence, so the
    // half that WRITES the file and the half that CHECKS it agree about the
    // shape. Asserted, because "they agree" is the warrant for the repair.
    expect(() =>
      renderRoleWithMetadata(schema, { role: "demo", workerDir: "/wd", claudeOrgPath: "/co" }),
    ).toThrow(/sandbox\.filesystem must be an object/);
    expect(validateSettings({ sandbox: { filesystem: "invalid" } })).toContain(
      "sandbox.filesystem must be an object",
    );
  });

  test("the readback is what the repair protects, and it is measured (target-only)", () => {
    // Why the repair is here and not left disclosed: `sandbox doctor` is the
    // only thing that observes the emptied arrays, and what it observes is a
    // PASS. Measured on the pre-repair render, which is reconstructed here as a
    // literal rather than produced -- the generator can no longer emit it.
    const asRenderedBeforeTheRepair = {
      enabled: true,
      filesystem: { denyRead: [], denyWrite: [] },
    };
    const report = diagnose({ sandbox: asRenderedBeforeTheRepair }, { probeBwrap: false });
    expect(report.findings).toStrictEqual([]);
    expect(reportOk(report)).toBe(true);
    expect(formatReport(report)).toContain("RESULT: sandbox deny paths are usable by bwrap.");
  });

  test("every FALSY filesystem keeps the source's behaviour (target-only)", () => {
    // The other half of the repair, and the half that decides whether it is a
    // repair or a regression. `x or {}` makes an absent, null, empty-object,
    // empty-array, zero or empty-string `filesystem` into `{}` BEFORE the type
    // test, so none of them is a "truthy non-mapping" and none may raise. Six
    // rows, because getting this wrong would reject documents interlock accepts.
    for (const filesystem of [undefined, null, {}, [], 0, ""]) {
      const sandbox: Record<string, unknown> = { enabled: true };
      if (filesystem !== undefined) {
        sandbox["filesystem"] = filesystem;
      }
      const result = renderRoleWithMetadata(
        { worker_roles: { demo: { sandbox } } },
        { role: "demo", workerDir: "/wd", claudeOrgPath: "/co" },
      );
      const rendered = result.settings["sandbox"] as Record<string, unknown>;
      const fs = rendered["filesystem"] as Record<string, unknown>;
      expect(fs["denyRead"], `filesystem: ${JSON.stringify(filesystem) ?? "absent"}`).toStrictEqual(
        [],
      );
    }
  });

  test("a DISABLED sandbox with a malformed filesystem is still not refused (target-only)", () => {
    // The refusal sits after the `enabled` gate, exactly where the coercion sat.
    // A disabled sandbox never reaches either, so a role that turns the sandbox
    // off and leaves junk under `filesystem` renders as it always did. Pinned
    // because moving the check one line earlier would look like a tidy-up and
    // would start rejecting documents on a path the defect never touched.
    const result = renderRoleWithMetadata(
      { worker_roles: { demo: { sandbox: { enabled: false, filesystem: "invalid" } } } },
      { role: "demo", workerDir: "/wd", claudeOrgPath: "/co" },
    );
    expect((result.settings["sandbox"] as Record<string, unknown>)["filesystem"]).toBe("invalid");
  });
});

describe("the case-sensitivity repair (target-only, D-0216)", () => {
  test("a Windows drive-letter case difference is not an escape (target-only)", () => {
    // The inherited defect, pinned by its repair. `_is_inside_root` compares
    // with `==` and `startswith` and applies no `normcase`, so on Windows -- where
    // path identity is case-INSENSITIVE -- a worker_dir authored `c:\...` against
    // a realpath returned as `C:\...` reads as an escape and the in-root deny
    // entry is SUPPRESSED. Measured before the repair: `denyRead: []`, one
    // suppression, reason "realpath escapes sandbox read roots".
    const result = asWindows(() =>
      renderRoleWithMetadata(
        {
          worker_roles: {
            demo: {
              sandbox: {
                enabled: true,
                filesystem: {
                  denyRead: [{ anchor: "worker_dir", path: "secret" }],
                  denyWrite: [],
                },
              },
            },
          },
        },
        {
          role: "demo",
          workerDir: String.raw`c:\Users\Foo\worker`,
          claudeOrgPath: String.raw`c:\co`,
          // The OS hands back the canonical drive-letter case; the operator
          // authored the other one. Both name the same directory.
          realpathFn: (p: string) => p.replace(/^c:/, "C:"),
          symlinkProbeFn: () => null,
        },
      ),
    );
    const fs = (result.settings["sandbox"] as Record<string, unknown>)["filesystem"] as Record<
      string,
      unknown
    >;
    expect(result.sandbox.suppressions).toStrictEqual([]);
    expect(fs["denyRead"]).toStrictEqual([String.raw`c:\Users\Foo\worker\secret`]);
  });

  test("the reported read roots keep the operator's own spelling (target-only)", () => {
    // The contract question the disclosure left open, answered and pinned. The
    // repair normcases the COMPARISON and nothing else: `sandboxReadRoots` is
    // what `settings show --explain` prints and what the launcher's /sandbox
    // status displays, and an operator has to recognise the path they wrote. A
    // repair that folded the stored roots to lowercase would pass the case above
    // and quietly change a display contract, with nothing to say so.
    const result = asWindows(() =>
      renderRoleWithMetadata(
        {
          worker_roles: {
            demo: {
              sandbox: {
                enabled: true,
                filesystem: {
                  denyRead: [{ anchor: "absolute", path: String.raw`D:\elsewhere\x` }],
                  denyWrite: [],
                },
              },
            },
          },
        },
        {
          role: "demo",
          workerDir: String.raw`c:\Users\Foo\worker`,
          claudeOrgPath: String.raw`c:\co`,
          realpathFn: (p: string) => p,
          symlinkProbeFn: () => null,
        },
      ),
    );
    // An out-of-root entry is still suppressed -- the repair folds case, it does
    // not widen the roots -- and the report names the root as authored.
    expect(result.sandbox.suppressions).toHaveLength(1);
    expect(result.sandbox.sandboxReadRoots).toStrictEqual([String.raw`c:\Users\Foo\worker`]);
  });

  test("POSIX identity stays case-SENSITIVE (target-only)", () => {
    // The repair must be a no-op on the platform interlock runs on, and "no-op"
    // is a claim about `posixpath.normcase` being the identity rather than about
    // the substitution. Pinned in the direction that would break: two paths
    // differing only in case are two different files on POSIX, and an entry
    // under one must not be judged in-root by the other.
    //
    // Wrapped in `asPosix` rather than left to the host. Unwrapped it asserted
    // a POSIX property while running wherever it landed, and went red on the
    // Windows cells -- where the entry IS in-root, correctly, because that is
    // exactly what D-0216 changed. The wrapper turns a host-dependent case into
    // a claim about `posixpath.normcase`, falsifiable on every cell.
    const result = asPosix(() =>
      renderRoleWithMetadata(
        {
          worker_roles: {
            demo: {
              sandbox: {
                enabled: true,
                filesystem: {
                  denyRead: [{ anchor: "absolute", path: "/tmp/WORKER/secret" }],
                  denyWrite: [],
                },
              },
            },
          },
        },
        {
          role: "demo",
          workerDir: "/tmp/worker",
          claudeOrgPath: "/co",
          realpathFn: (p: string) => p,
          symlinkProbeFn: () => null,
        },
      ),
    );
    expect(result.sandbox.suppressions).toHaveLength(1);
  });
});

describe("the number-spelling carry (target-only, D-0211)", () => {
  test("a non-string deny entry keeps its Python spelling through --json (target-only)", () => {
    // This module's ONE container rebuild, pinned. A `permissions.deny` of
    // `[1.0]` is reported as `unsupported-entry` with the number AS the
    // finding's `source`, and `findingToJsonable` moves it onto a freshly built
    // object under a DIFFERENT key -- so `carryNumberSpellings`, which matches
    // slots by name, would find nothing to carry and silently do nothing.
    //
    // A spelling cannot be written in TypeScript -- the literal `1.0` IS `1` --
    // so the document is built as TEXT and read back through the production
    // path (`loadSource`, which is `pyJsonLoads`), and the assertion is on the
    // serialiser's output. Both directions are covered: an integral float must
    // stay `1.0`, and a 2**53+ integer must stay an integer.
    const tmp = caseTree("spelling-carry");
    const path = join(tmp, "settings.local.json");
    writeFileSync(path, '{"permissions": {"deny": [1.0, 9007199254740993, "Read(.env)"]}}', "utf8");
    const buf = captureStdout();
    captureStderr();
    const rc = runDoctor({
      settings: [path],
      json: true,
      verbose: false,
      probe_bwrap: false,
      merge_scopes: false,
    });
    expect(rc).toBe(1);
    const text = buf.text();
    expect(text).toContain('"source": 1.0');
    expect(text).toContain('"source": 9007199254740993');
    // ...and the third entry is a well-formed rule, so it is not a finding at
    // all -- which is what makes the two above the only rows in the array and
    // keeps this case from passing on a substring from somewhere else.
    const payload = JSON.parse(text) as { findings: Record<string, unknown>[] };
    expect(payload.findings.map((f) => f["status"])).toStrictEqual([
      STATUS_UNSUPPORTED,
      STATUS_UNSUPPORTED,
    ]);
  });

  test("a Layer 3 non-string entry carries its spelling too (target-only)", () => {
    // The second collection site. Both were written from the same shape and a
    // pin on one would not have caught a carry missing from the other.
    const tmp = caseTree("spelling-carry-l3");
    const path = join(tmp, "settings.local.json");
    writeFileSync(
      path,
      '{"sandbox": {"enabled": true, "filesystem": {"denyRead": [2.0], "denyWrite": []}}}',
      "utf8",
    );
    const buf = captureStdout();
    captureStderr();
    runDoctor({
      settings: [path],
      json: true,
      verbose: false,
      probe_bwrap: false,
      merge_scopes: false,
    });
    expect(buf.text()).toContain('"source": 2.0');
  });
});

describe("the doctor's seams are live (target-only, rule 5)", () => {
  test("every seam is read by production rather than only by tests (target-only)", () => {
    // Rule 5's liveness obligation. A seam nothing reads is a `monkeypatch` that
    // silently stopped reaching production, and the tests that patch it go on
    // passing -- against the unpatched code. Each of the five is patched here
    // with a value production cannot mistake for its own, and the observation is
    // that production returned it.
    const tmp = caseTree("seam-liveness");
    const marker = join(tmp, "marker.json");
    writeFileSync(marker, "{}", "utf8");

    // `which`: the canary's bwrap lookup.
    patchSeam(doctorSeams, "which", () => null);
    expect(runBwrapCanary([])[0]).toBe(CANARY_SKIPPED);

    // `managedSettingsPaths`: read inside `discoverMergedScopes`.
    patchSeam(doctorSeams, "managedSettingsPaths", [marker]);
    setFakeHome(join(tmp, "nowhere"));
    expect(discoverMergedScopes()).toStrictEqual([marker]);

    // `discoverMergedScopes`: read by `run`.
    let asked = false;
    patchSeam(doctorSeams, "discoverMergedScopes", () => {
      asked = true;
      return [];
    });
    // `stdout` / `stderr`: both written by `run`.
    const out = captureStdout();
    const err = captureStderr();
    expect(
      runDoctor({
        settings: [marker],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: true,
      }),
    ).toBe(0);
    expect(asked).toBe(true);
    expect(out.text()).toContain("deny targets: 0");
    expect(err.text()).toBe("");

    // ...and the error path reaches `stderr`, which the success path does not.
    expect(
      runDoctor({
        settings: [join(tmp, "absent.json")],
        json: false,
        verbose: false,
        probe_bwrap: false,
        merge_scopes: false,
      }),
    ).toBe(2);
    expect(err.text()).toContain("error: settings not found:");
  });
});

describe("the two argparse actions this CLI needed (target-only, D-0214)", () => {
  test("--settings appends, and repeats accumulate (target-only)", () => {
    // `action="append"`. A parser that overwrote instead would silently audit
    // only the LAST scope named -- a merge command whose whole point is that a
    // deny path in any scope aborts the launch.
    const args = buildDoctorParser().parseArgs(
      ["--settings", "/a.json", "--settings", "/b.json"],
      defaultStreams(),
    );
    expect(args["settings"]).toStrictEqual(["/a.json", "/b.json"]);
  });

  test("--no-probe-bwrap and --no-merge-scopes default to true (target-only)", () => {
    // `action="store_false", default=True`. Collapsing store_false into
    // store_true-with-an-inverted-constant would default both to `false`: the
    // live canary off for every run that did not ask to turn it off, and scope
    // discovery off for every run that did not ask to skip it. Both defaults are
    // the safe side, and both are the source's.
    //
    // What this pin covers was MEASURED by removing each candidate rather than
    // reasoned about, and the first answer was wrong. It goes red for the two
    // branches that decide the values -- the namespace initialiser defaulting a
    // store_false dest to `true`, and the consumption site storing `false` --
    // and it stays GREEN when `defaultValue: true` is deleted from the spec in
    // `cli.ts`, because `spec.defaultValue ?? true` supplies it either way. That
    // is not a hole: `_StoreFalseAction`'s own default IS `True`, so the
    // redundancy is CPython's, and the source writes it out for the same
    // reason. Recorded because a reader would otherwise assume the spec line is
    // what this case protects.
    const defaults = buildDoctorParser().parseArgs(["--settings", "/a.json"], defaultStreams());
    expect(defaults["probe_bwrap"]).toBe(true);
    expect(defaults["merge_scopes"]).toBe(true);

    const turnedOff = buildDoctorParser().parseArgs(
      ["--settings", "/a.json", "--no-probe-bwrap", "--no-merge-scopes"],
      defaultStreams(),
    );
    expect(turnedOff["probe_bwrap"]).toBe(false);
    expect(turnedOff["merge_scopes"]).toBe(false);
  });

  test("a store_false flag takes no argument in usage and in help (target-only)", () => {
    // The regression an earlier draft shipped: usage and help asked the question
    // "does this action consume a token" separately from the parse loop, and
    // rendered `--no-probe-bwrap PROBE_BWRAP` while parsing correctly. Nothing
    // went red, because no case read the help of a store_false flag.
    const help = buildDoctorParser().help();
    expect(help).toContain("--no-probe-bwrap\n");
    expect(help).not.toContain("--no-probe-bwrap PROBE_BWRAP");
    expect(buildDoctorParser().usage()).not.toContain("PROBE_BWRAP");
    // ...and the appending option still declares its metavar.
    expect(help).toContain("--settings PATH");
  });

  test("--settings is required, and the error names this parser (target-only)", () => {
    let message = "";
    expect(() =>
      buildDoctorParser().parseArgs([], {
        stdout: () => {},
        stderr: (t: string) => {
          message += t;
        },
      }),
    ).toThrow(ArgparseExit);
    expect(message).toContain("the following arguments are required: --settings");
    expect(message).toContain("claude-org-runtime-sandbox-doctor");
  });
});

describe("shutil.which, at the three places a PATH split loses it (target-only, D-0214)", () => {
  /**
   * `os.defpath`, measured from CPython 3.12.3 on the porting host
   * (`/bin:/usr/bin`). Spelled here as well as in production deliberately: if
   * the two drift, the `PATH`-unset row below finds `sh` in one list and not
   * the other and goes red, which is what makes this a check rather than a
   * restatement.
   */
  const DEFPATH = process.platform === "win32" ? [".", "C:\\bin"] : ["/bin", "/usr/bin"];

  /** Run `body` with `PATH` set, or removed entirely when `value` is null. */
  function withPath<T>(value: string | null, body: () => T): T {
    const had = Object.hasOwn(process.env, "PATH");
    const previous = process.env["PATH"];
    if (value === null) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = value;
    }
    try {
      return body();
    } finally {
      if (had) {
        process.env["PATH"] = previous;
      } else {
        delete process.env["PATH"];
      }
    }
  }

  test("an unset PATH falls back to os.defpath; an EMPTY one searches nowhere (target-only)", () => {
    // These are two different states and `process.env["PATH"]` reports both as
    // falsy. CPython reads `os.environ.get("PATH", None)`, falls back to the
    // system default path when that is `None`, and only THEN applies
    // `if not path: return None` -- so an explicitly empty `PATH` means "search
    // nowhere" and an absent one does not. Measured against CPython 3.12.3.
    //
    // The direction matters more than the semantics: this module answers a
    // failed lookup with `CANARY_SKIPPED`, and a skipped canary with no static
    // findings exits 0. Collapsing the two states reports a preflight that
    // never ran as a preflight that passed.
    const expected = DEFPATH.map((d) => osJoin(d, "sh")).find((p) => existsSync(p)) ?? null;
    expect(withPath(null, () => doctorSeams.which("sh"))).toBe(expected);
    expect(withPath("", () => doctorSeams.which("sh"))).toBeNull();
    // On any POSIX host `sh` IS in defpath, so the first row above is a real
    // lookup rather than two nulls agreeing. Asserted rather than assumed,
    // because on a host where it is not, the row above is vacuous and a reader
    // should be able to tell which they are looking at.
    expect(
      expected !== null,
      "no `sh` under os.defpath: the unset-PATH row above is vacuous on this host",
    ).toBe(process.platform !== "win32");
  });

  test("an empty PATH component searches the current directory (target-only)", () => {
    // `os.path.join("", "bwrap")` is `"bwrap"` -- a cwd-relative path -- so a
    // `PATH` of `":/usr/bin"` names two directories and the cwd. A loop that
    // skips empty components (the obvious reading) misses a `bwrap` reachable
    // that way and skips the canary. Measured against CPython 3.12.3: the
    // answer is the BARE name, not an absolutised one.
    //
    // What this case does NOT pin, stated because the probe said so rather than
    // the code: swapping `osJoin` for `node:path`'s `join` leaves it green.
    // Both turn an empty first component into the bare name, and they differ
    // only in normalisation -- `posixpath.join("/usr//bin", "x")` keeps the
    // doubled separator `path.join` collapses -- which no `stat` can observe.
    // The transcription is used regardless; this case pins the empty component
    // being VISITED, which is the half that was missing.
    const tmp = caseTree("which-empty-component");
    const name = "continuo-which-probe";
    writeFileSync(join(tmp, name), "", "utf8");
    const cwd = process.cwd();
    process.chdir(tmp);
    onTestFinished(() => {
      process.chdir(cwd);
    });
    expect(
      withPath(`${pathDelimiter}${join(tmp, "nonexistent")}`, () => doctorSeams.which(name)),
    ).toBe(name);
  });

  test("a directory repeated in PATH is searched once (target-only)", () => {
    // `shutil.which` deduplicates by `os.path.normcase(dir)`. Behaviour-neutral
    // for the ANSWER, which is why it is pinned by counting stats rather than by
    // comparing results: a transcription that dropped the `seen` set would agree
    // on every lookup and differ only in work done, and the reason CPython's
    // loop is not a plain `for` would quietly stop being true.
    const tmp = caseTree("which-dedupe");
    const name = "continuo-which-absent";
    const repeated = [tmp, tmp, tmp].join(pathDelimiter);
    expect(withPath(repeated, () => doctorSeams.which(name))).toBeNull();
    // The observable half: the first hit still wins, and it is the directory
    // that appears first.
    const first = join(tmp, "first");
    const second = join(tmp, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, name), "", "utf8");
    writeFileSync(join(second, name), "", "utf8");
    expect(withPath([first, second].join(pathDelimiter), () => doctorSeams.which(name))).toBe(
      join(first, name),
    );
  });
});

describe("Python `or` is truthiness, and the canary has two of them (target-only, D-0214)", () => {
  test("an EMPTY bwrapPath override falls back to discovery (target-only)", () => {
    // `bwrap_path or shutil.which("bwrap")`. `??` differs from `or` for exactly
    // one value the caller can supply, and it is the one an unset-or-empty
    // environment override produces: with `??`, `bwrapPath: ""` suppresses the
    // PATH lookup and leaves an empty argv[0], so the default runner reports a
    // launch failure the settings did not cause and an injected runner is handed
    // a command it cannot recognise. Rule 9: `??` is usually right, and here it
    // is narrower than the source's operator.
    const tmp = caseTree("or-truthiness");
    const probed = join(tmp, "hosts");
    writeFileSync(probed, "", "utf8");
    const target = {
      layer: "permissions.deny",
      source: `Read(//${probed.replace(/^\/+/, "")})`,
      path: probed,
      sourceFile: "",
      sourceSpelling: undefined,
    };
    const captured: string[][] = [];
    const runner = (cmd: string[]): CompletedProcess => {
      captured.push(cmd);
      return { args: cmd, returncode: 0, stdout: "", stderr: "" };
    };
    // The lookup the empty override must NOT suppress, pinned through the seam
    // so the case does not depend on the host having bwrap.
    patchSeam(doctorSeams, "which", () => "/discovered/bwrap");

    runBwrapCanary([target], { runner, bwrapPath: "" });
    expect(captured[0]?.[0]).toBe("/discovered/bwrap");

    // ...and a non-empty override still wins, which is the half that would
    // break if `or` were mistranslated the other way.
    captured.length = 0;
    runBwrapCanary([target], { runner, bwrapPath: "/explicit/bwrap" });
    expect(captured[0]?.[0]).toBe("/explicit/bwrap");
  });

  test("the second `or` still defaults argv[0] to the bare name (target-only)", () => {
    // `resolved_bwrap = resolved_bwrap or "bwrap"`. Reached when discovery found
    // nothing AND a runner was injected -- the substitution case, where
    // requiring bwrap on PATH would make the caller's stand-in depend on the
    // tool it is standing in for.
    //
    // What this pins is the DEFAULT reaching argv[0], not the choice of `or`
    // over `??`, and the probe is why that is stated instead of assumed:
    // reverting that second line to `??` leaves this case GREEN. It has to --
    // once the first `or` is truthiness, `discovered` is a non-empty string or
    // `null` and can never be `""`, so the two operators cannot disagree there.
    // The faithful spelling is kept anyway, because it costs nothing and the
    // line's correctness would otherwise depend on a property of its caller
    // that nothing states.
    const tmp = caseTree("or-second");
    const probed = join(tmp, "hosts");
    writeFileSync(probed, "", "utf8");
    const captured: string[][] = [];
    patchSeam(doctorSeams, "which", () => null);
    const [status] = runBwrapCanary(
      [
        {
          layer: "permissions.deny",
          source: "x",
          path: probed,
          sourceFile: "",
          sourceSpelling: undefined,
        },
      ],
      {
        runner: (cmd: string[]): CompletedProcess => {
          captured.push(cmd);
          return { args: cmd, returncode: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(captured[0]?.[0]).toBe("bwrap");
    expect(status).toBe(CANARY_PASS);
  });
});

describe("str(Path(p)) is not normpath, and the port models a Path as a string (target-only, D-0214)", () => {
  /**
   * Measured against CPython 3.12.3: `str(PurePosixPath(p))` and
   * `str(PureWindowsPath(p))`, beside `posixpath.normpath` / `ntpath.normpath`
   * for the one input where the two rules disagree.
   *
   * `discover_merged_scopes` returns `list[Path]`, and this port models a
   * `Path` as a string -- so every place the source relies on `Path`
   * normalising has to do it explicitly. It is not cosmetic: the returned path
   * reaches `Finding.source_file` and is quoted back to an operator through
   * `--json`.
   */
  const POSIX_CASES: readonly (readonly [string, string])[] = [
    ["a//b", "a/b"],
    ["a/./b", "a/b"],
    // `..` is KEPT, where normpath would collapse it to `b`.
    ["a/../b", "a/../b"],
    ["../x/y", "../x/y"],
    ["/home/u/.claude/settings.json", "/home/u/.claude/settings.json"],
    ["a/", "a"],
    ["", "."],
  ];

  const WINDOWS_CASES: readonly (readonly [string, string])[] = [
    ["a//b", String.raw`a\b`],
    ["a/./b", String.raw`a\b`],
    ["a/../b", String.raw`a\..\b`],
    ["../x/y", String.raw`..\x\y`],
    [String.raw`a\b/c`, String.raw`a\b\c`],
    // The case that failed on the Windows cells: `ntpath.expanduser` returns
    // the tail's forward slashes intact, and `Path(...)` is what turns them
    // into separators before the value is compared or reported.
    [String.raw`C:\Users\x/.claude/settings.json`, String.raw`C:\Users\x\.claude\settings.json`],
  ];

  test("PurePosixPath, at every shape the two rules could disagree on (target-only)", () => {
    for (const [input, expected] of POSIX_CASES) {
      expect(
        asPlatform("linux", () => pathStr(input)),
        `str(PurePosixPath(${JSON.stringify(input)}))`,
      ).toBe(expected);
    }
  });

  test("PureWindowsPath, including the expanduser tail that broke CI (target-only)", () => {
    for (const [input, expected] of WINDOWS_CASES) {
      expect(
        asPlatform("win32", () => pathStr(input)),
        `str(PureWindowsPath(${JSON.stringify(input)}))`,
      ).toBe(expected);
    }
  });

  test("the two namespaces disagree somewhere, so neither stands in for the other (target-only)", () => {
    // The vacuity guard the ospath oracle taught this lane to write. A corpus on
    // which both platforms answer identically would let one transcription pass
    // for both, and this table is small enough for that to happen by accident.
    const shared = POSIX_CASES.filter(([input]) =>
      WINDOWS_CASES.some(([other]) => other === input),
    );
    expect(shared.length).toBeGreaterThan(0);
    const differs = shared.some(([input, posixExpected]) => {
      const windows = WINDOWS_CASES.find(([other]) => other === input);
      return windows?.[1] !== posixExpected;
    });
    expect(differs, "no input distinguishes the two namespaces").toBe(true);
  });
});
