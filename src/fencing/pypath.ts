/**
 * Python's `posixpath.normpath` and `os.path.expanduser`, transcribed.
 *
 * `expanduser` is transcribed twice, from `posixpath` and from `ntpath`, and
 * dispatched on the platform: see its doc comment for why the difference is a
 * fence hole and not a cosmetic one.
 *
 * `fencing/rules.py` normalises every path it compares:
 *
 * ```python
 * def _normalize_path(path: str) -> str:
 *     expanded = os.path.expanduser(path)
 *     return posixpath.normpath(expanded.replace(os.sep, "/"))
 * ```
 *
 * and then decides whether a denied sandbox path covers a candidate with
 * `candidate == root or candidate.startswith(root.rstrip("/") + "/")`. So the
 * exact output of `normpath` is what decides whether a sandbox deny rule fires,
 * and Node's `path.posix.normalize` is **not** the same function:
 *
 * | input   | `posixpath.normpath` | `path.posix.normalize` |
 * |---------|----------------------|------------------------|
 * | `a/`    | `a`                  | `a/`                   |
 * | `//a`   | `//a`                | `/a`                   |
 * | `a/b/`  | `a/b`                | `a/b/`                 |
 * | `.`     | `.`                  | `.`                    |
 *
 * The trailing-slash row is the dangerous one. A rule normalised to `a/b/`
 * instead of `a/b` compares unequal to a candidate `a/b`, and
 * `"a/b/".rstrip("/") + "/"` still yields `a/b/`, so the prefix test happens to
 * survive -- but the equality test does not, and a deny rule aimed at exactly
 * one path stops firing on that path. That is a hole in the fence, produced by
 * a path helper that looks interchangeable.
 *
 * The `//a` row matters for UNC paths on Windows and for anyone who writes a
 * doubled separator by accident; POSIX reserves a leading `//` and CPython
 * preserves it deliberately.
 *
 * Authority: `DECISIONS.md` D-0200. Checked against CPython by the differential
 * vector rather than by eye; see `docs/differential-oracle.md`.
 */

import { homedir } from "node:os";
import { sep as platformSep } from "node:path";

/**
 * CPython's `posixpath.splitroot`, for the part `normpath` needs.
 *
 * Returns the leading-slash run, which is `""`, `"/"` or `"//"` and never
 * longer: three or more leading slashes collapse to one, while exactly two are
 * preserved. That asymmetry is not a quirk to tidy away -- POSIX leaves a
 * pathname beginning with exactly two slashes implementation-defined, and
 * CPython declines to normalise it.
 */
function splitRoot(p: string): [initialSlashes: string, tail: string] {
  if (p.slice(0, 1) !== "/") {
    return ["", p];
  }
  if (p.slice(1, 2) !== "/" || p.slice(2, 3) === "/") {
    return ["/", p.slice(1)];
  }
  return ["//", p.slice(2)];
}

/**
 * `posixpath.normpath`: collapse `//`, resolve `.` and `..`, textually.
 *
 * Transcribed from CPython 3.12's pure-Python implementation. CPython normally
 * runs the C `posix._path_normpath` instead, and the two are contracted to
 * agree; the differential vector is generated from whichever one CPython
 * actually used, so this is checked against the real thing rather than against
 * the fallback's promise.
 *
 * `..` is resolved **lexically**, which may change the meaning of a path that
 * crosses a symlink. That is CPython's documented behaviour and the fence
 * depends on it: a rule and a candidate are compared as text, so both sides
 * have to be wrong in the same way or neither.
 */
export function normpath(path: string): string {
  if (path === "") {
    return ".";
  }
  const [initialSlashes, tail] = splitRoot(path);
  const comps = tail.split("/");
  const newComps: string[] = [];
  for (const comp of comps) {
    if (comp === "" || comp === ".") {
      continue;
    }
    if (
      comp !== ".." ||
      (!initialSlashes && newComps.length === 0) ||
      (newComps.length > 0 && newComps[newComps.length - 1] === "..")
    ) {
      newComps.push(comp);
    } else if (newComps.length > 0) {
      newComps.pop();
    }
  }
  const joined = initialSlashes + newComps.join("/");
  return joined || ".";
}

/**
 * `os.path.expanduser`, for the forms a fence document can contain.
 *
 * The shipped `roles.json` writes `~/.ssh`, so this is on the path of a real
 * rule and not a theoretical case.
 *
 * **`os.path` is not one function.** Python binds `os.path` to `posixpath` or
 * `ntpath` at import time, and the two `expanduser`s disagree in ways that
 * decide whether a rule fires:
 *
 * | | `posixpath` | `ntpath` |
 * |---|---|---|
 * | terminator | `/` only | `\` **and** `/` |
 * | home from | `HOME` | `USERPROFILE`, else `HOMEDRIVE`+`HOMEPATH` |
 * | trailing slashes on userhome | rstripped | kept |
 * | unresolvable | path unchanged | path unchanged |
 *
 * The first two rows are a fence hole on Windows. A sandbox deny entry
 * `"~\\.aws"` is one component to `ntpath` -- `\` terminates the user field --
 * so interlock expands it to `C:/Users/me/.aws` and a `Read` of
 * `C:\Users\me\.aws\credentials` is DENIED. A posix-only transcription sees no
 * `/`, treats `~\.aws` as `~user` with user `\.aws`, returns it unchanged, and
 * the same read is NOT denied. No error, and the breach battery stays green,
 * because `witnessSubject` runs the same broken expansion and probes the
 * unexpanded spec.
 *
 * So the platform is selected here the way `os.path` selects the module, and
 * for the same reason `normalizePath` below reads `path.sep` at call time.
 *
 * **The `~user` form is deliberately narrower than CPython on POSIX, in the
 * safe direction.** `posixpath` resolves `~otheruser` through the `pwd`
 * database; Node has no equivalent, and guessing at another user's home
 * directory would produce a rule pointing at a path that does not exist -- a
 * deny rule that silently stops covering anything. CPython itself returns the
 * path **unchanged** when the lookup fails, so returning it unchanged is the
 * branch CPython already has, not a new behaviour invented here. This
 * limitation is under operator review and is not widened here. `ntpath` needs
 * no such waiver: its `~user` handling is pure environment and string work,
 * and is transcribed in full below.
 *
 * The home directory is a parameter rather than a call to `os.homedir()` so
 * that the differential vector can pin both sides to the same value. An
 * environment-dependent oracle compares two environments, not two
 * implementations. When supplied it stands in for whichever variable the
 * platform's CPython would have read.
 */
export function expanduser(path: string, home?: string): string {
  return process.platform === "win32" ? ntExpanduser(path, home) : posixExpanduser(path, home);
}

/** `posixpath.expanduser`. */
function posixExpanduser(path: string, home: string | undefined): string {
  if (!path.startsWith("~")) {
    return path;
  }
  let i = path.indexOf("/", 1);
  if (i < 0) {
    i = path.length;
  }
  if (i !== 1) {
    // `~someuser/...`: CPython consults `pwd`. See the doc comment above --
    // unresolvable means unchanged, which is CPython's own failure branch.
    return path;
  }
  // CPython strips trailing slashes from `userhome` before joining, so that
  // `~/` does not become `//` when HOME is `/`.
  const userhome = (home ?? defaultPosixHome()).replace(/\/+$/, "");
  return userhome + path.slice(i) || "/";
}

/**
 * `ntpath.expanduser`.
 *
 * Note what is NOT here: `ntpath` does no rstripping of `userhome`. That is
 * not an oversight to tidy up -- `USERPROFILE` ending in a separator would
 * make interlock produce a doubled separator too, and the fence compares
 * `rules._normalize_path` output on both sides, so the two have to agree
 * before normalisation as well as after.
 */
function ntExpanduser(path: string, home: string | undefined): string {
  if (!path.startsWith("~")) {
    return path;
  }
  // `_get_bothseps`: on Windows BOTH separators terminate the user field.
  let i = 1;
  const n = path.length;
  while (i < n && path[i] !== "\\" && path[i] !== "/") {
    i += 1;
  }

  let userhome: string;
  if (home !== undefined) {
    userhome = home;
  } else {
    const profile = process.env["USERPROFILE"];
    // `'USERPROFILE' in os.environ`: presence, not truthiness. An empty
    // USERPROFILE is still a hit for CPython, and expands `~/x` to `/x`.
    if (profile !== undefined) {
      userhome = profile;
    } else {
      const homepath = process.env["HOMEPATH"];
      if (homepath === undefined) {
        return path;
      }
      userhome = ntJoin(process.env["HOMEDRIVE"] ?? "", homepath);
    }
  }

  if (i !== 1) {
    // `~user`. CPython guesses that profile directories are siblings named
    // after their users, and bails out when `userhome` does not look like one.
    const targetUser = path.slice(1, i);
    const currentUser = process.env["USERNAME"];
    if (targetUser !== currentUser) {
      if (currentUser !== ntBasename(userhome)) {
        return path;
      }
      userhome = ntJoin(ntDirname(userhome), targetUser);
    }
  }

  return userhome + path.slice(i);
}

/**
 * `ntpath.splitroot`: `[drive, root, tail]`.
 *
 * Reproduced rather than approximated because `ntJoin` below is built on it,
 * and drive-relative paths (`X:Windows`, no root) join differently from
 * absolute ones.
 */
function ntSplitRoot(p: string): [drive: string, root: string, tail: string] {
  const sep = "\\";
  const uncPrefix = "\\\\?\\UNC\\";
  const normp = p.split("/").join(sep);
  if (normp.slice(0, 1) === sep) {
    if (normp.slice(1, 2) === sep) {
      // UNC or device drive: `\\server\share`, `\\?\UNC\server\share`, `\\.\dev`.
      const start = normp.slice(0, 8).toUpperCase() === uncPrefix ? 8 : 2;
      const index = normp.indexOf(sep, start);
      if (index === -1) {
        return [p, "", ""];
      }
      const index2 = normp.indexOf(sep, index + 1);
      if (index2 === -1) {
        return [p, "", ""];
      }
      return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
    }
    return ["", p.slice(0, 1), p.slice(1)];
  }
  if (normp.slice(1, 2) === ":") {
    if (normp.slice(2, 3) === sep) {
      return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
    }
    return [p.slice(0, 2), "", p.slice(2)];
  }
  return ["", "", p];
}

/** `ntpath.join`, two-argument form -- all `ntExpanduser` needs. */
function ntJoin(first: string, second: string): string {
  const sep = "\\";
  const seps = "\\/";
  let [resultDrive, resultRoot, resultPath] = ntSplitRoot(first);
  const [pDrive, pRoot, pPath] = ntSplitRoot(second);
  if (pRoot) {
    if (pDrive || !resultDrive) {
      resultDrive = pDrive;
    }
    resultRoot = pRoot;
    resultPath = pPath;
  } else {
    if (pDrive && pDrive !== resultDrive) {
      if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) {
        // Different drives: the first path is ignored entirely.
        return pDrive + pRoot + pPath;
      }
      resultDrive = pDrive;
    }
    if (resultPath && !seps.includes(resultPath.slice(-1))) {
      resultPath += sep;
    }
    resultPath += pPath;
  }
  // A separator is added between a UNC drive and a non-absolute path.
  const lastDriveChar = resultDrive.slice(-1);
  if (resultPath && !resultRoot && resultDrive && !`:${seps}`.includes(lastDriveChar)) {
    return resultDrive + sep + resultPath;
  }
  return resultDrive + resultRoot + resultPath;
}

/** `ntpath.split`, for `ntBasename` / `ntDirname`. */
function ntSplit(p: string): [head: string, tail: string] {
  const seps = "\\/";
  const [d, r, rest] = ntSplitRoot(p);
  let i = rest.length;
  while (i > 0 && !seps.includes(rest[i - 1] as string)) {
    i -= 1;
  }
  const head = rest.slice(0, i);
  const tail = rest.slice(i);
  return [d + r + head.replace(/[\\/]+$/, ""), tail];
}

function ntBasename(p: string): string {
  return ntSplit(p)[1];
}

function ntDirname(p: string): string {
  return ntSplit(p)[0];
}

/**
 * `os.environ["HOME"]`, falling back the way CPython does.
 *
 * `posixpath.expanduser` reads `HOME` first and only consults the password
 * database when it is unset; `os.homedir()` prefers the OS record. Reading the
 * environment first keeps a test that sets `HOME` -- and interlock's suite does
 * -- behaving the same on both sides.
 *
 * **Presence, not truthiness.** CPython's test is `if 'HOME' not in os.environ`,
 * so an `HOME` that is present and **empty** is used as the home directory, and
 * the password database is never consulted. Treating `HOME=""` as unset instead
 * is a fence hole with the shipped document: interlock expands `~/.ssh` to
 * `/.ssh` (empty home, then the separator), while a `homedir()` fallback expands
 * it to the running account's home. A read under `/.ssh` is then denied by
 * interlock and **not** denied here.
 *
 * An empty `HOME` is not hypothetical for this project: it is what a bare
 * `env -i`, a systemd unit without `User=`, and several CI images produce.
 */
function defaultPosixHome(): string {
  const fromEnv = process.env["HOME"];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  return homedir();
}

/**
 * `rules._normalize_path`.
 *
 * The `replace(os.sep, "/")` is **platform-dependent in the source** and stays
 * that way here: on Windows `os.sep` is `\` and backslashes become separators,
 * while on POSIX the replacement is a no-op and a backslash is an ordinary
 * character in a filename. Hardcoding either behaviour would make one platform
 * disagree with interlock, so `path.sep` is read at call time exactly as
 * `os.sep` is.
 */
export function normalizePath(path: string): string {
  const expanded = expanduser(path);
  return normpath(expanded.split(platformSep).join("/"));
}
