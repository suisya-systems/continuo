/**
 * Derive the git revision a build was produced from.
 *
 * Split into a pure function over three already-collected git results
 * ({@link deriveRevision}) and a thin collector that runs them
 * ({@link readGitRevision}). The split is what makes the derivation testable
 * without a git repository -- and the derivation is where every interesting
 * decision lives, because the whole design is about what to do when git does
 * NOT answer.
 *
 * **The toplevel guard is checked first, before the commit.** The failure this
 * closes is the only one in the set that is confidently WRONG rather than
 * merely absent: a continuo tree sitting inside some unrelated outer repository
 * -- vendored, or a monorepo checkout -- answers `git rev-parse HEAD` with the
 * OUTER repository's commit, and the build would ship a stranger's sha as its
 * own identity. Comparing the repository's toplevel against the package root is
 * what tells the two apart.
 *
 * **Never inspect `.git` directly.** In a git worktree `.git` is a FILE holding
 * a `gitdir:` pointer, not a directory, so an `existsSync` + `isDirectory`
 * probe reports "no repository" in a perfectly good checkout -- which is
 * exactly the layout this project is developed in. Ask git; it knows.
 *
 * **`rev-parse HEAD`, not `describe`.** CI checks out at the default depth of
 * 1 with no tags. `rev-parse HEAD` is exact in a shallow clone, because that
 * commit is the one object guaranteed to be present. `describe --tags` fails
 * outright there, and `describe --always` silently degrades to an abbreviated
 * sha whose length varies with repository size -- the same reason the full 40
 * hex is used rather than `--short`.
 *
 * Detached HEAD needs no handling: `rev-parse HEAD` answers with the commit
 * whether or not a branch points at it, and no branch name is ever recorded. A
 * branch name is not part of a build's identity, and recording one would make
 * two identical builds report differently.
 *
 * **ASCII only**, per `docs/cli-output-policy.md`: this file is scanned, and
 * what it prints reaches a cp932 console during `npm run build`.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The value a build reports when nothing could be derived. Mirrors `src/about.ts`. */
const UNKNOWN = "unknown";

/**
 * A git invocation's outcome, reduced to what the derivation actually reads.
 *
 * @typedef {{status: number | null, stdout: string, error?: unknown}} GitResult
 */

/**
 * The revision, from three already-collected git results.
 *
 * @param {{toplevel: GitResult, head: GitResult, status: GitResult, root: string}} inputs
 * @returns {string} a 40-hex sha, that sha with `-dirty`, or `unknown`
 */
export function deriveRevision(inputs) {
  const { toplevel, head, status, root } = inputs;

  // The guard, first and on its own. A toplevel that is not this package's root
  // means git answered about a DIFFERENT repository, and every answer it gives
  // below is about that one too. `unknown` is the only honest output here, even
  // though `rev-parse HEAD` would have succeeded -- which is precisely why this
  // is checked before the commit rather than after it.
  if (toplevel.status !== 0 || toplevel.error !== undefined) {
    return UNKNOWN;
  }
  if (!samePath(toplevel.stdout.trim(), root)) {
    return UNKNOWN;
  }

  if (head.status !== 0 || head.error !== undefined) {
    return UNKNOWN;
  }
  const revision = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    // A repository with no commits yet answers non-zero, so this is belt and
    // braces -- but a value that is about to be written into a JavaScript
    // module is validated rather than trusted.
    return UNKNOWN;
  }

  // Dirty marking fails toward `-dirty`. If `git status` could not run while
  // `rev-parse` could (an index lock, a permissions problem), the tree is
  // recorded as dirty rather than clean: `-dirty` is a claim that this build is
  // not reproducible from the named commit, and the costs are asymmetric. A
  // false `-dirty` is noise; a missing one is a build lying about which commit
  // it is.
  if (status.error !== undefined || status.status !== 0) {
    return `${revision}-dirty`;
  }
  // Untracked files count, deliberately: an untracked `.ts` under `src/` is
  // compiled into `dist/` exactly like a tracked one, so a tree holding one does
  // not match its commit.
  return status.stdout.trim() === "" ? revision : `${revision}-dirty`;
}

/**
 * Are these the same directory?
 *
 * Through `realpathSync` on both sides when both resolve, because a symlinked
 * checkout would otherwise compare unequal and send a perfectly good build to
 * `unknown`.
 *
 * When either side will not resolve, the comparison falls back to the
 * normalised strings rather than answering "different". Answering "different"
 * there would be a third meaning for a failure that is not about identity at
 * all -- a path that has just been removed, a permissions problem on a parent
 * -- and it would drop the revision of a build whose two paths plainly match.
 * The fallback is strictly weaker than the realpath comparison and can only
 * accept pairs that are already textually the same, so it cannot let a
 * DIFFERENT repository through, which is the case the guard exists for.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

/**
 * Run the three git commands from `root` and derive the revision.
 *
 * `--path-format=absolute` on the toplevel query, the spelling already used in
 * `src/workspace/git.ts`, so the answer can be compared with an absolute root
 * without a second normalisation step.
 *
 * @param {string} root the package root the build is producing
 * @returns {{revision: string, why: string}} the revision, and a short ASCII
 *   reason when it is `unknown`, so a build log says which probe failed rather
 *   than only that one did
 */
export function readGitRevision(root) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  };

  const toplevel = run(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain"]);
  const revision = deriveRevision({ toplevel, head, status, root });

  return { revision, why: revision === UNKNOWN ? explain(toplevel, head, root) : "" };
}

/**
 * Every codepoint outside U+0020..U+007E as a `\uXXXX` escape.
 *
 * {@link explain} interpolates two values that came from OUTSIDE -- the package
 * root and the toplevel git reported -- and either may hold a character a
 * cp932 console cannot encode. `docs/cli-output-policy.md` governs every byte
 * this script writes, and it runs during `npm run build` on the required
 * windows-latest cell, so the diagnostic is escaped rather than trusted. The
 * policy's own note applies: this governs what continuo AUTHORS, and a path it
 * merely received is escaped on the way out rather than refused.
 *
 * @param {string} text
 * @returns {string}
 */
export function ascii(text) {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    out += unit >= 0x20 && unit <= 0x7e ? text[index] : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/**
 * Why the derivation gave up, in one ASCII clause for the build log.
 *
 * @param {GitResult} toplevel
 * @param {GitResult} head
 * @param {string} root
 * @returns {string}
 */
function explain(toplevel, head, root) {
  if (toplevel.error !== undefined) {
    return "git could not be run (not on PATH?)";
  }
  if (toplevel.status !== 0) {
    return `${ascii(root)} is not inside a git repository`;
  }
  if (!samePath(toplevel.stdout.trim(), root)) {
    return (
      `${ascii(root)} is not the root of the repository git reported ` +
      `(${ascii(toplevel.stdout.trim())}); refusing to stamp another repository's commit`
    );
  }
  if (head.status !== 0) {
    return "the repository has no commit at HEAD";
  }
  return "git reported no usable revision";
}
