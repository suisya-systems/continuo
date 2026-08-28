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

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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
export function ntSplitRoot(p: string): [drive: string, root: string, tail: string] {
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

/**
 * `ntpath.join`, in full: one leading path and any number of following ones.
 *
 * `ntExpanduser` only ever calls it with two, but the whole loop is here
 * because `osJoin` below dispatches to it and `os.path.join` is variadic.
 *
 * -- ONE FIDELITY FIX over the two-argument version this replaces -- the
 * different-drives branch used to `return p_drive + p_root + p_path` on the
 * spot, which skips the UNC separator fix-up CPython applies at the end of the
 * function. The two answers differ only when the SECOND path is drive-relative
 * (`D:Windows`, a drive with no root) and the FIRST carries a UNC drive, which
 * neither `ntExpanduser` call site can produce: one passes `HOMEPATH`, the
 * other a bare username, and a drive-relative second argument is the one shape
 * both exclude. The branch is now CPython's `continue`, so the fix-up runs.
 */
export function ntJoin(first: string, ...rest: readonly string[]): string {
  const sep = "\\";
  const seps = "\\/";
  const colon = ":";
  let [resultDrive, resultRoot, resultPath] = ntSplitRoot(first);
  for (const p of rest) {
    const [pDrive, pRoot, pPath] = ntSplitRoot(p);
    if (pRoot) {
      // Second path is absolute.
      if (pDrive || !resultDrive) {
        resultDrive = pDrive;
      }
      resultRoot = pRoot;
      resultPath = pPath;
      continue;
    }
    if (pDrive && pDrive !== resultDrive) {
      if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) {
        // Different drives: everything before this path is ignored.
        resultDrive = pDrive;
        resultRoot = pRoot;
        resultPath = pPath;
        continue;
      }
      // Same drive in different case.
      resultDrive = pDrive;
    }
    // Second path is relative to the first.
    if (resultPath && !seps.includes(resultPath.slice(-1))) {
      resultPath += sep;
    }
    resultPath += pPath;
  }
  // A separator is added between a UNC drive and a non-absolute path.
  const lastDriveChar = resultDrive.slice(-1);
  if (resultPath && !resultRoot && resultDrive && !`${colon}${seps}`.includes(lastDriveChar)) {
    return resultDrive + sep + resultPath;
  }
  return resultDrive + resultRoot + resultPath;
}

/** `ntpath.split`, for `ntBasename` / `ntDirname`. */
export function ntSplit(p: string): [head: string, tail: string] {
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

// ---------------------------------------------------------------------------
// `os.path`, the rest of it
// ---------------------------------------------------------------------------
//
// `expanduser` above is dispatched on the platform because `os.path` IS a
// platform choice: Python binds the name to `posixpath` or `ntpath` at import
// time. The settings generator (`src/settings/generator.ts`) reads far more of
// that module than the fence does -- `join`, `normpath`, `isabs`, `dirname`,
// `splitdrive`, `realpath` -- and its decisions turn on the answers:
// `_is_inside_root` composes `normpath` with an `os.sep` boundary test to
// decide whether a deny entry escaped the sandbox, and a kept structured entry
// is emitted as `os.path.join(anchor_base, path)`, which is the literal string
// that reaches `settings.local.json`.
//
// Node's `path` module is not that function on either platform. The trailing-
// slash and `//` rows in the table at the top of this file are the posix half;
// on Windows `path.win32.normalize("C:/a/")` keeps the trailing separator and
// `ntpath.normpath` drops it, and `path.win32.isabs("/x")` answers `true` where
// `ntpath.isabs` answers `true` as well -- but for a different reason and with
// a different treatment of `C:x`. So both halves are transcribed here from
// CPython 3.12's `posixpath` and `ntpath`, and checked against them by
// `parity/oracle/ospath-vector.json` rather than by eye.
//
// Both namespaces are exported, not merely the dispatched pair: the oracle runs
// BOTH on every matrix cell. A Windows-only check of the `ntpath` half would
// leave it unverified on the Linux cells, which is where most runs happen, and
// a POSIX-only check would leave it unverified on the cells that ship it.

/** `os.sep`, read at call time exactly as `normalizePath` reads `path.sep`. */
export function osSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/** `os.altsep`: `/` on Windows, `None` elsewhere. */
export function osAltsep(): string | null {
  return process.platform === "win32" ? "/" : null;
}

/** `os.curdir`. */
export const OS_CURDIR = ".";

/** `os.pardir`. */
export const OS_PARDIR = "..";

/** `posixpath.join`. */
export function posixJoin(first: string, ...rest: readonly string[]): string {
  const sep = "/";
  let path = first;
  for (const b of rest) {
    if (b.startsWith(sep)) {
      path = b;
    } else if (path === "" || path.endsWith(sep)) {
      path += b;
    } else {
      path += sep + b;
    }
  }
  return path;
}

/** `posixpath.isabs`. */
export function posixIsabs(p: string): boolean {
  return p.startsWith("/");
}

/**
 * `posixpath.split`.
 *
 * The `head != sep*len(head)` guard is what keeps `/` and `//` from being
 * stripped to the empty string, so `dirname("/x")` is `/` and not `""`.
 */
export function posixSplit(p: string): [head: string, tail: string] {
  const sep = "/";
  const i = p.lastIndexOf(sep) + 1;
  let head = p.slice(0, i);
  const tail = p.slice(i);
  if (head !== "" && head !== sep.repeat(head.length)) {
    head = head.replace(/\/+$/, "");
  }
  return [head, tail];
}

/** `posixpath.splitdrive`: there are no drives on POSIX. */
export function posixSplitdrive(p: string): [drive: string, tail: string] {
  return ["", p];
}

/** `ntpath.splitdrive`, which is `splitroot` with the root put back on the tail. */
export function ntSplitdrive(p: string): [drive: string, tail: string] {
  const [drive, root, tail] = ntSplitRoot(p);
  return [drive, root + tail];
}

/** `ntpath.isabs`. */
export function ntIsabs(p: string): boolean {
  // CPython's own comment calls the first test a LEGACY BUG -- `isabs("/x")` is
  // true on Windows although the path names no drive -- and keeps it. So does
  // this: the generator's `_absolute_symlink_in_chain` returns early for a
  // non-absolute path, and disagreeing here would make it walk (or refuse to
  // walk) a different set of paths from interlock's.
  const head = p.slice(0, 3).split("/").join("\\");
  return head.startsWith("\\") || head.startsWith(":\\", 1);
}

/**
 * `ntpath.normpath`.
 *
 * Transcribed from the pure-Python fallback. On a real Windows interpreter
 * CPython calls `nt._path_normpath` instead, and the two are contracted to
 * agree -- the same contract `normpath` above relies on for POSIX, and the
 * reason the oracle vector is generated from whichever one CPython actually
 * ran rather than from the fallback's promise.
 */
export function ntNormpath(p: string): string {
  const sep = "\\";
  const path = p.split("/").join(sep);
  const [drive, root, tail] = ntSplitRoot(path);
  const prefix = drive + root;
  const comps = tail.split(sep);
  let i = 0;
  while (i < comps.length) {
    if (comps[i] === "" || comps[i] === OS_CURDIR) {
      comps.splice(i, 1);
    } else if (comps[i] === OS_PARDIR) {
      if (i > 0 && comps[i - 1] !== OS_PARDIR) {
        comps.splice(i - 1, 2);
        i -= 1;
      } else if (i === 0 && root !== "") {
        comps.splice(i, 1);
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  if (prefix === "" && comps.length === 0) {
    comps.push(OS_CURDIR);
  }
  return prefix + comps.join(sep);
}

/** `os.path.join`. */
export function osJoin(first: string, ...rest: readonly string[]): string {
  return process.platform === "win32" ? ntJoin(first, ...rest) : posixJoin(first, ...rest);
}

/** `os.path.normpath`. */
export function osNormpath(p: string): string {
  return process.platform === "win32" ? ntNormpath(p) : normpath(p);
}

/** `os.path.isabs`. */
export function osIsabs(p: string): boolean {
  return process.platform === "win32" ? ntIsabs(p) : posixIsabs(p);
}

/** `os.path.split`. */
export function osSplit(p: string): [head: string, tail: string] {
  return process.platform === "win32" ? ntSplit(p) : posixSplit(p);
}

/** `os.path.dirname`. */
export function osDirname(p: string): string {
  return osSplit(p)[0];
}

/** `os.path.splitdrive`. */
export function osSplitdrive(p: string): [drive: string, tail: string] {
  return process.platform === "win32" ? ntSplitdrive(p) : posixSplitdrive(p);
}

// ---------------------------------------------------------------------------
// `os.path.realpath`, and the two probes that go with it
// ---------------------------------------------------------------------------
//
// This is where `os.path` stops being string work and touches the filesystem,
// and it is the one function in this file whose Windows half is an ADAPTATION
// rather than a transcription. The reason is named rather than glossed:
// `ntpath.realpath` is written on `nt._getfinalpathname`, a Win32 API
// (`GetFinalPathNameByHandle`) with no user-space equivalent to transcribe.
// Node's `fs.realpathSync.native` is the same call, so the STRUCTURE of
// CPython's non-strict algorithm is reproduced around it -- resolve as much of
// the path as the OS can, follow a link ourselves when it cannot, then walk one
// component back and try again -- and what is not reproduced is listed below
// rather than left to be discovered.
//
// Not covered by the differential vector, because a static vector cannot pin a
// function of the filesystem. `parity/oracle/ospath-vector.json` covers the
// pure string half; `realpath` is pinned by the settings suite's cases, which
// build a real directory and, where the layout has to be a symlinked one,
// inject `realpathFn` exactly as interlock's own tests do.

/** `os.path.islink`: `stat.S_ISLNK` over `lstat`, false when it cannot be read. */
export function osIslink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `os.readlink`. Throws, as CPython's does, when the target is not a link. */
export function osReadlink(p: string): string {
  return readlinkSync(p, { encoding: "utf8" });
}

/** `posixpath.abspath`. */
function posixAbspath(path: string): string {
  return normpath(posixIsabs(path) ? path : posixJoin(process.cwd(), path));
}

/**
 * `posixpath._joinrealpath`, non-strict.
 *
 * Returns `[path, ok]`, where `ok` is false once an unresolvable symlink loop
 * has been met -- at which point the remainder is appended unchanged, which is
 * what makes non-strict `realpath` return something for a cyclic path instead
 * of raising.
 *
 * `seen` maps a link path to its resolution, with `null` meaning "being
 * resolved"; meeting a `null` again IS the loop.
 */
function joinRealpath(
  start: string,
  remainder: string,
  seen: Map<string, string | null>,
): [path: string, ok: boolean] {
  const sep = "/";
  let path = start;
  let rest = remainder;
  if (posixIsabs(rest)) {
    rest = rest.slice(1);
    path = sep;
  }
  while (rest !== "") {
    // `rest.partition(sep)`.
    const cut = rest.indexOf(sep);
    const name = cut < 0 ? rest : rest.slice(0, cut);
    rest = cut < 0 ? "" : rest.slice(cut + 1);
    if (name === "" || name === OS_CURDIR) {
      continue;
    }
    if (name === OS_PARDIR) {
      if (path !== "") {
        const [head, tail] = posixSplit(path);
        path = tail === OS_PARDIR ? posixJoin(head, OS_PARDIR, OS_PARDIR) : head;
      } else {
        path = OS_PARDIR;
      }
      continue;
    }
    const newpath = posixJoin(path, name);
    if (!osIslink(newpath)) {
      // Covers both "not a link" and "cannot be stat'ed", which is CPython's
      // `except ignored_error: is_link = False` for the non-strict call.
      path = newpath;
      continue;
    }
    if (seen.has(newpath)) {
      const cached = seen.get(newpath) ?? null;
      if (cached !== null) {
        path = cached;
        continue;
      }
      // A symlink loop. Non-strict returns the resolved part plus the rest,
      // unchanged and unresolved.
      return [posixJoin(newpath, rest), false];
    }
    seen.set(newpath, null);
    const [resolved, ok] = joinRealpath(path, osReadlink(newpath), seen);
    if (!ok) {
      return [posixJoin(resolved, rest), false];
    }
    seen.set(newpath, resolved);
    path = resolved;
  }
  return [path, true];
}

/** `posixpath.realpath(path)`, with `strict=False`. */
export function posixRealpath(path: string): string {
  return posixAbspath(joinRealpath("", path, new Map())[0]);
}

/**
 * `ntpath.normcase`: separators normalised to `\\`, then lowercased.
 *
 * CPython's is `s.replace('/', '\\').lower()` -- `str.lower()`, which is the
 * FULL Unicode lowering, not ASCII-only. `String.prototype.toLowerCase` is the
 * same Default Case Conversion algorithm without a locale, so the two agree on
 * every code point including the Turkish dotted I that `toLocaleLowerCase`
 * would get wrong. The oracle vector checks this against CPython rather than
 * leaving it as a reading of both specifications.
 */
export function ntNormcase(p: string): string {
  return p.split("/").join("\\").toLowerCase();
}

/**
 * `posixpath.normcase`: the identity.
 *
 * Spelled out rather than inlined as "POSIX needs no normcase", because that
 * sentence is what a reader has to trust when the dispatch below looks
 * one-sided. CPython's `posixpath.normcase` is `os.fspath(s)` and nothing more:
 * POSIX path identity is case-SENSITIVE, so folding case there would make two
 * genuinely different files compare equal.
 */
export function posixNormcase(p: string): string {
  return p;
}

/** `os.path.normcase`, bound the way Python binds `os.path` at import time. */
export function osNormcase(p: string): string {
  return process.platform === "win32" ? ntNormcase(p) : posixNormcase(p);
}

/**
 * `ntpath._readlink_deep`: follow a chain of links as far as it goes.
 *
 * CPython stops on a specific list of `winerror` codes and re-raises anything
 * else. Node reports `errno`/`code` strings rather than `winerror`, and the
 * codes on that list are the ones that mean "there is nothing more to follow"
 * -- a missing file, a denied directory, a reparse point that is not a symlink.
 * Stopping on ANY error is therefore the same answer for every case on the
 * list, and for the cases off it turns a raise into "return what we have",
 * which non-strict `realpath` would have produced anyway one frame up.
 */
function ntReadlinkDeep(start: string): string {
  const seen = new Set<string>();
  let path = start;
  while (!seen.has(ntNormcase(path))) {
    seen.add(ntNormcase(path));
    const oldPath = path;
    let target: string;
    try {
      target = osReadlink(path);
    } catch {
      break;
    }
    if (!ntIsabs(target)) {
      if (!osIslink(oldPath)) {
        path = oldPath;
        break;
      }
      path = ntNormpath(ntJoin(ntSplit(oldPath)[0], target));
    } else {
      path = target;
    }
  }
  return path;
}

/** `ntpath._getfinalpathname_nonstrict`, over Node's native realpath. */
function ntFinalPathNonstrict(start: string): string {
  let path = start;
  let tail = "";
  while (path !== "") {
    try {
      const resolved = realpathSync.native(path);
      return tail === "" ? resolved : ntJoin(resolved, tail);
    } catch {
      try {
        const followed = ntReadlinkDeep(path);
        if (followed !== path) {
          return tail === "" ? followed : ntJoin(followed, tail);
        }
      } catch {
        // Keep traversing, exactly as CPython does when readlink fails.
      }
      const [head, name] = ntSplit(path);
      if (head !== "" && name === "") {
        return head + tail;
      }
      path = head;
      tail = tail === "" ? name : ntJoin(name, tail);
    }
  }
  return tail;
}

/**
 * `ntpath.realpath(path)`, with `strict=False`.
 *
 * **What is reproduced.** `normpath` first, the `nul` special case, absolutise
 * against the working directory, then `_getfinalpathname` with the non-strict
 * walk-back on failure.
 *
 * **What is not, stated so it is not mistaken for parity.**
 *
 * - *8.3 short names and on-disk case.* `GetFinalPathNameByHandle` returns the
 *   canonical spelling, so CPython answers `C:\Users\Barney` for `c:\users\barn~1`.
 *   Node's native call is the same API and does the same thing, so this holds
 *   where the path EXISTS; the walk-back half joins the unresolved tail
 *   verbatim, as CPython's does (its own `TODO (bpo-38186)` says so).
 * - *The `\\?\` prefix round-trip.* CPython strips a `\\?\` prefix it did not
 *   start with, and only when the stripped form resolves to the same file.
 *   Node's native call does not add the prefix for the paths this port hands
 *   it, so the strip has nothing to strip. A caller that passes an explicit
 *   `\\?\` path gets it back with the prefix, where CPython may return it
 *   without.
 */
export function ntRealpath(path: string): string {
  const normalised = ntNormpath(path);
  if (ntNormcase(normalised) === ntNormcase("nul")) {
    return "\\\\.\\NUL";
  }
  const prefix = "\\\\?\\";
  const hadPrefix = normalised.startsWith(prefix);
  const absolute =
    !hadPrefix && !ntIsabs(normalised) ? ntJoin(process.cwd(), normalised) : normalised;
  try {
    return realpathSync.native(absolute);
  } catch {
    return ntFinalPathNonstrict(absolute);
  }
}

/** `os.path.realpath`, with `strict=False`. */
export function osRealpath(path: string): string {
  return process.platform === "win32" ? ntRealpath(path) : posixRealpath(path);
}
