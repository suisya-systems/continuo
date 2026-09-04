import { spawnSync } from "node:child_process";
import process from "node:process";

import { pythonRepr } from "../control_plane/python_repr.js";

/**
 * The git process adapter, and nothing else.
 *
 * This module runs `git` and classifies what came back. It does not know what a
 * run is, what a fence is, or that a control plane exists; `materializer.ts`
 * knows those and calls in here for the four things it cannot do without a
 * child process -- prove a name is a branch, resolve that branch to a commit,
 * add a worktree, and remove one again on the recovery path.
 *
 * **Why not `src/session/runtime.ts`.** That module is the session belt's
 * long-lived-child adapter: process groups, streamed stdio, adoption across a
 * supervisor restart, and a `ChildHandle` that outlives the call. Every one of
 * those exists because a `claude -p` session is a process you keep. A `git`
 * invocation is the opposite shape -- start it, wait, read the three things it
 * produced, and it is gone -- so reusing that adapter would mean carrying its
 * lifecycle vocabulary for calls that have no lifecycle. What *is* reused is
 * its conventions, deliberately and item by item, because those were arrived at
 * by measurement rather than taste:
 *
 * - **argv, never a shell string.** `spawnSync(file, args)` with no `shell`
 *   option passes the arguments to the kernel as an array. A branch name is
 *   attacker-adjacent data -- it arrives from a delegation record -- and the
 *   only way a shell metacharacter in one cannot matter is for there to be no
 *   shell.
 * - **explicit `cwd` and `env`.** Never the inherited ones by default. git
 *   reads roughly forty environment variables and changes behaviour on a
 *   surprising number of them, and "which repository did that command run
 *   against" must be answerable from the recorded argv plus one field rather
 *   than from the ambient state of whichever process happened to call.
 * - **`stdio: ["ignore", "pipe", "pipe"]`.** stdin is closed rather than
 *   inherited, for the reason `runtime.ts` closes it on its probe: a child
 *   handed the caller's stdin can consume bytes nothing else can get back. git
 *   in particular will read stdin for a credential prompt, which is the exact
 *   way this call would hang forever rather than fail.
 * - **`killSignal: "SIGKILL"` with the timeout.** Node's default is SIGTERM and
 *   `timeout` is not a wall-clock bound: `spawnSync` sends the signal and then
 *   keeps waiting for the child to actually exit. `runtime.ts` measured a
 *   500ms timeout returning after 3018ms *reporting success* on a child that
 *   ignores SIGTERM. Nothing can interrupt a synchronous call, so the test
 *   worker simply stops.
 * - **classify on `error` before `status`.** Same measurement: on the timeout
 *   path `spawnSync` can report both an error and a plausible-looking status,
 *   so reading `status === 0` first turns a timed-out command into a passing
 *   one.
 * - **stderr is kept, never dropped.** git says why it refused on stderr and
 *   says it once. A failure that discards it leaves an operator with an exit
 *   code, and every git exit code is `128`.
 *
 * **ASCII only** in every message this module produces, for the reason
 * `docs/cli-output-policy.md` gives: these strings reach an operator's console
 * through a refusal, and a cp932 console turns a character it cannot encode
 * into a crash rather than a smudge. git's own stderr is external text and is
 * carried through {@link pythonRepr}, which escapes anything outside printable
 * ASCII rather than passing it to the encoder.
 */

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/**
 * Something about the git side of a materialisation is not true.
 *
 * One family with three members rather than three unrelated errors, because
 * every caller in `materializer.ts` routes on the family: whatever went wrong
 * with git, nothing further is materialised and the run is refused. The members
 * exist so that a *test* can tell "git said no" from "git never answered", not
 * so that production takes three branches.
 */
export class GitRefusal extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "GitRefusal";
    Object.setPrototypeOf(this, GitRefusal.prototype);
  }
}

/** A git command ran and exited non-zero. Carries the argv and both streams. */
export class GitCommandFailed extends GitRefusal {
  readonly result: GitResult;

  constructor(message: string, result: GitResult) {
    super(message);
    this.name = "GitCommandFailed";
    Object.setPrototypeOf(this, GitCommandFailed.prototype);
    this.result = result;
  }
}

/**
 * A git command did not finish inside its timeout and was killed.
 *
 * Distinct from {@link GitCommandFailed} because the two need different
 * operator responses and, more importantly, because a timed-out command may
 * have made a partial change -- a half-created worktree -- where a non-zero
 * exit from git has usually already cleaned up after itself. The recovery path
 * has to know which it is looking at.
 */
export class GitTimedOut extends GitRefusal {
  readonly argv: readonly string[];
  readonly timeoutMs: number;

  constructor(message: string, argv: readonly string[], timeoutMs: number) {
    super(message);
    this.name = "GitTimedOut";
    Object.setPrototypeOf(this, GitTimedOut.prototype);
    this.argv = Object.freeze([...argv]);
    this.timeoutMs = timeoutMs;
  }
}

// --------------------------------------------------------------------------
// running one command
// --------------------------------------------------------------------------

/** What one git invocation produced. */
export interface GitResult {
  /** The full argv, `git` included, exactly as it was passed to the kernel. */
  readonly argv: readonly string[];
  /** The exit status. Never `null`: a signalled child is reported as a timeout. */
  readonly exitCode: number;
  /** stdout, decoded as UTF-8 with trailing newlines removed. */
  readonly stdout: string;
  /** stderr, decoded as UTF-8 with trailing newlines removed. */
  readonly stderr: string;
}

/** How one git invocation is run. */
export interface GitOptions {
  /** The directory git runs in. Required: see the module docstring. */
  readonly cwd: string;
  /** Wall-clock bound. Defaults to {@link DEFAULT_GIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * The environment git runs under, before this module's own pins are applied.
   *
   * Defaults to `process.env` because a git that cannot see `HOME`, `PATH` or
   * `SSH_AUTH_SOCK` is a git that cannot read the operator's configuration or
   * reach a remote, and lap 1 runs against the operator's own checkout. The
   * pins in {@link pinnedEnvironment} are applied on top and are not
   * overridable by this value: they are the three settings whose *absence* is a
   * hang rather than a different answer.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The default wall-clock bound for one git command.
 *
 * Two minutes, which is far more than any command this module runs needs on a
 * warm checkout and still short enough to fail a CI cell rather than hold it to
 * its own job timeout. `git worktree add` is the slow one -- it writes a
 * checkout -- and it is the reason the number is minutes rather than seconds.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * The environment settings this module imposes on every git it starts.
 *
 * Each one is here because its absence is a *hang*, not a different answer, and
 * a hang inside a synchronous `spawnSync` is uninterruptible:
 *
 * - `GIT_TERMINAL_PROMPT=0` -- git must never ask for a credential. With stdin
 *   closed it would fail anyway, but git also prompts on `/dev/tty` when it can
 *   open one, which stdio redirection does not close.
 * - `GIT_ASKPASS` / `SSH_ASKPASS` emptied, and `GIT_CONFIG_PARAMETERS` carrying
 *   `core.askPass=` -- the three other doors to the same prompt. An operator
 *   with a graphical askpass configured would otherwise get a dialog nobody is
 *   watching, on a machine nobody is sitting at.
 * - `GIT_OPTIONAL_LOCKS=0` -- a read-only query must not block on, or take, the
 *   index lock. `rev-parse` and `show-ref` are queries; a concurrent operation
 *   in the same checkout should not make them wait.
 * - `LC_ALL=C` -- git's stderr is recorded in a durable event payload and
 *   quoted back in refusals. A message whose language depends on the operator's
 *   locale is a message no runbook can match on, and a non-ASCII one is the
 *   console-encoding crash the output policy is about.
 *
 * It also *removes* {@link REPOSITORY_SELECTING_VARIABLES}, which is a different
 * kind of rule and is written out there.
 */
function pinnedEnvironment(
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || REPOSITORY_SELECTING_VARIABLES.has(key)) {
      continue;
    }
    env[key] = value;
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_ASKPASS"] = "";
  env["SSH_ASKPASS"] = "";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["LC_ALL"] = "C";
  return env;
}

/**
 * The environment variables that tell git *which repository to operate on*, and
 * which are therefore removed rather than passed through.
 *
 * `cwd` is this module's whole answer to "which repository": every function
 * here takes it, and the module docstring promises that the recorded argv plus
 * that one field say what a command ran against. `GIT_DIR` breaks that promise
 * outright -- with it set, git ignores `cwd`'s repository and uses the named one
 * instead -- and the others reinterpret it in smaller ways.
 *
 * **This is not a hypothetical inheritance.** git sets these itself for every
 * hook it runs, so a materialiser invoked from inside a `post-commit` or a
 * `pre-push` would silently create its worktree in whatever repository invoked
 * the hook, while every refusal and every event payload named the repository the
 * request asked for. That is the failure this module is least able to detect
 * from the inside: git would succeed.
 *
 * What is deliberately NOT removed: `HOME`, `PATH`, `SSH_AUTH_SOCK`,
 * `GIT_SSH_COMMAND`, the `GIT_CONFIG_*` family and everything else an operator
 * needs for git to read their configuration and reach a remote. The rule is
 * narrow on purpose -- "which repository" is this module's to decide, and
 * everything else is the operator's.
 */
const REPOSITORY_SELECTING_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_PREFIX",
  "GIT_INDEX_VERSION",
]);

/**
 * Node marks a `spawnSync` timeout with `ETIMEDOUT` on the `error` it returns.
 *
 * Read through an accessor rather than compared inline because the property is
 * not on `Error`'s type and the cast is the sort of thing that gets copied to a
 * site where it is wrong.
 */
function errorCodeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * An argv as one quoted line, for a message an operator will read.
 *
 * Every element through {@link pythonRepr}, which is what the rest of this
 * repository does with a value it received from outside. Two things follow, and
 * the second is a limit worth stating rather than assuming away.
 *
 * It **does** make the argument boundaries readable and the control characters
 * visible: a bare `join(" ")` renders a branch name containing a space as two
 * arguments, and a name containing a newline as two lines, which is the shape
 * of message an operator misreads.
 *
 * It does **not** make the message ASCII, and it is not trying to.
 * `pythonRepr` reproduces CPython 3's `repr`, which leaves printable non-ASCII
 * alone -- `repr('\u65e5')` is `'\u65e5'`, not an escape. That is the right
 * behaviour here: `docs/cli-output-policy.md` governs what continuo *authors*
 * and says in as many words that values it receives from outside "may of course
 * be non-ASCII", and `D-0055` deliberately admits non-ASCII branches and paths
 * because this organization has repositories under them. A renderer that
 * escaped them would make every refusal about such a repository unreadable to
 * the operator who owns it, in exchange for a console-encoding problem the
 * policy explicitly assigns elsewhere. `lap_run_intent.ts` quotes the same
 * class of value the same way.
 */
function renderArgv(argv: readonly string[]): string {
  return argv.map((part) => pythonRepr(part)).join(" ");
}

/**
 * A caller-supplied timeout, checked before it reaches `spawnSync`.
 *
 * `timeout: 0` is not "no wait" to Node -- it means **no timeout at all**, so a
 * caller passing it would get an unbounded, uninterruptible synchronous call
 * from a function whose docstring promises a wall-clock bound. That is the
 * failure this module's SIGKILL note is about, arriving through the parameter
 * meant to control it. Negative and non-integer values reach `spawnSync` as
 * argument errors from outside this module's refusal vocabulary, so they are
 * refused here too rather than surfacing as `ERR_OUT_OF_RANGE`.
 */
function requireTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GitRefusal(
      `timeoutMs must be a positive integer of milliseconds, got ${pythonRepr(timeoutMs)}; ` +
        "zero disables Node's timeout entirely, which would make an unbounded call out of " +
        "the one bound this adapter promises",
    );
  }
  return timeoutMs;
}

/** `str(exc)`: CPython's `str` of an exception never prefixes the class name. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Trailing newlines only.
 *
 * `git rev-parse` answers with a value and one `\n`; a branch name may not
 * begin or end with a space but a *commit message* echoed on stderr can, and
 * trimming both ends of stderr would edit the text an operator is trying to
 * read. So the right-hand end only, and only the line terminators.
 */
function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

/**
 * Run one git command. Returns whatever it did, including a non-zero exit.
 *
 * The non-throwing form, because two callers here ask git a *question* whose
 * negative answer is a non-zero exit rather than a failure --
 * {@link branchExists} and {@link isWellFormedBranchName} both do. Callers that
 * need the exit to be zero use {@link runGitChecked}.
 *
 * @throws {GitTimedOut} if the command did not finish inside its timeout.
 * @throws {GitRefusal} if the child could not be started at all -- git absent
 *   from `PATH`, `cwd` not a directory. Distinct from a git that ran and
 *   refused, and a caller must not confuse "there is no git here" with "this is
 *   not a branch".
 */
export function runGit(args: readonly string[], options: GitOptions): GitResult {
  const timeoutMs = requireTimeout(options.timeoutMs);
  const argv = Object.freeze(["git", ...args]);
  const result = spawnSync("git", [...args], {
    cwd: options.cwd,
    env: pinnedEnvironment(options.env ?? process.env),
    timeout: timeoutMs,
    // See the module docstring: SIGTERM plus a child that ignores it is an
    // uninterruptible wait inside a synchronous call, not a timeout.
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    // git's default output is small, but `worktree add` on a large tree and a
    // `rev-parse` in a repository with an unusual configuration are not bounded
    // by anything this module controls, and Node's 1 MB default turns an
    // over-long answer into an ENOBUFS error with no branch to catch it.
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });

  // `error` first, always. On the timeout path `spawnSync` reports both an
  // error and a status, and reading the status first reports the killed command
  // as a success.
  if (result.error !== undefined) {
    if (errorCodeOf(result.error) === "ETIMEDOUT") {
      throw new GitTimedOut(
        `git did not finish within ${String(timeoutMs)}ms: ${renderArgv(argv)}`,
        argv,
        timeoutMs,
      );
    }
    throw new GitRefusal(`cannot run ${renderArgv(argv)}: ${describe(result.error)}`, {
      cause: result.error,
    });
  }

  if (result.status === null) {
    // A child that exited on a signal with no `error` beside it. `spawnSync`
    // returns only once the child is gone, so this is a real termination and
    // not a partial read -- but there is no exit code to report, and inventing
    // one would put a number in a durable payload that git never produced.
    throw new GitRefusal(
      `git was terminated by signal ${pythonRepr(result.signal ?? "unknown")}: ` + renderArgv(argv),
    );
  }

  return Object.freeze({
    argv,
    exitCode: result.status,
    stdout: stripTrailingNewlines(result.stdout ?? ""),
    stderr: stripTrailingNewlines(result.stderr ?? ""),
  });
}

/**
 * Run one git command and require it to succeed.
 *
 * @throws {GitCommandFailed} on a non-zero exit, with git's own stderr in the
 *   message. The stderr goes through {@link pythonRepr} rather than being
 *   interpolated raw: it is external text, it can be several lines, and a
 *   refusal that spans lines is a refusal `run_cli.ts`-shaped callers cannot
 *   print on one line.
 */
export function runGitChecked(args: readonly string[], options: GitOptions): GitResult {
  const result = runGit(args, options);
  if (result.exitCode !== 0) {
    throw new GitCommandFailed(
      `${renderArgv(result.argv)} exited ${String(result.exitCode)}: ` +
        `${pythonRepr(result.stderr === "" ? result.stdout : result.stderr)}`,
      result,
    );
  }
  return result;
}

// --------------------------------------------------------------------------
// the four questions materialisation asks
// --------------------------------------------------------------------------

/**
 * Is `name` well-formed as a branch name, without asking whether it exists?
 *
 * `git check-ref-format refs/heads/<name>` and NOT `--branch`. The two are not
 * the same check: `--branch` additionally applies git's *DWIM* rules, under
 * which `@{-1}` is a valid "branch name" that resolves to whichever branch the
 * repository was previously on. A materialisation whose base branch was
 * accepted because it means "the last one" would record a base that names
 * something different tomorrow, which is the whole failure mode M1 is about.
 * The `refs/heads/` form is pure syntax and resolves nothing.
 *
 * The leading-dash check is separate and comes first, because a name beginning
 * with `-` is a name git would read as an *option* at every later call site,
 * and `check-ref-format` accepts one (`-x` is a legal ref component). Every
 * argv this module builds could be made safe with a `--` separator instead, but
 * `git worktree add` takes its `<path>` and `<commit-ish>` positionally after
 * options with no separator that covers both, so the name is rejected at the
 * door rather than escaped at four call sites.
 */
export function isWellFormedBranchName(name: string, options: GitOptions): boolean {
  if (name === "" || name.startsWith("-")) {
    return false;
  }
  return isNoOnExitOne(runGit(["check-ref-format", `refs/heads/${name}`], options));
}

/**
 * Does `refs/heads/<name>` exist in this repository?
 *
 * `show-ref --verify` on the fully-qualified ref, which is the question M1
 * actually asks. `rev-parse <name>` would answer yes for a tag, for an
 * abbreviated object id, for `HEAD`, and for a remote-tracking ref -- four
 * things that are not branches and three of which cannot be pushed to at the
 * end of the lap.
 *
 * `--quiet` so a missing ref is an exit code rather than a line on stderr:
 * absence is the expected answer here, not a fault, and stderr from this call
 * would otherwise be reported by whichever caller is composing a refusal.
 *
 * Answered through {@link isNoOnExitOne}, so a repository whose refs cannot be
 * read raises rather than reporting the branch absent. See that function.
 */
export function branchExists(name: string, options: GitOptions): boolean {
  return isNoOnExitOne(runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], options));
}

/**
 * Read a git *question*'s answer, where only exit status 1 means "no".
 *
 * git reserves `1` for a well-formed question whose answer is negative and uses
 * `128` (and other statuses) for "I could not answer": unreadable refs, a
 * corrupt repository, a bad object store. Collapsing every non-zero status to
 * `false` is the fail-open direction disguised as the fail-closed one -- a
 * repository whose `refs/` cannot be read would be reported as "the base branch
 * does not exist", which sends an operator to check a branch name when the
 * problem is the repository, and it discards git's own diagnostic in the
 * process.
 *
 * So `0` is yes, `1` is no, and anything else raises with git's stderr attached.
 *
 * @throws {GitCommandFailed} for any non-zero status other than 1.
 */
function isNoOnExitOne(result: GitResult): boolean {
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  throw new GitCommandFailed(
    `${renderArgv(result.argv)} exited ${String(result.exitCode)}, which is neither yes (0) ` +
      `nor no (1): ${pythonRepr(result.stderr === "" ? result.stdout : result.stderr)}`,
    result,
  );
}

/**
 * The absolute path of the repository `options.cwd` is inside.
 *
 * `--path-format=absolute` is passed explicitly rather than relying on
 * `--show-toplevel`'s default, because `rev-parse` is one of the commands whose
 * output form git has changed between versions and the value is recorded in a
 * durable event payload.
 *
 * @throws {GitCommandFailed} if `cwd` is not inside a work tree.
 */
export function repositoryRoot(options: GitOptions): string {
  return runGitChecked(["rev-parse", "--path-format=absolute", "--show-toplevel"], options).stdout;
}

/**
 * The commit `refs/heads/<name>` currently points at, as a full object id.
 *
 * `^{commit}` peels an annotated tag or any other indirection down to a commit,
 * so the recorded value is always the thing a worktree can be created at.
 * `--verify` makes a name that resolves to nothing an error rather than an echo
 * of the input, which is `rev-parse`'s default and its worst behaviour.
 *
 * @throws {GitCommandFailed} if the branch does not resolve.
 */
export function resolveBranchCommit(name: string, options: GitOptions): string {
  return runGitChecked(["rev-parse", "--verify", `refs/heads/${name}^{commit}`], options).stdout;
}

/**
 * The git metadata a checkout at `options.cwd` writes through, as absolute
 * paths (D-0082).
 *
 * A linked worktree's `.git` is a *file* pointing at
 * `<base>/.git/worktrees/<name>`, so every write git makes on behalf of that
 * checkout -- the index, new objects, the branch it is on -- lands outside the
 * checkout. This is the list of places it lands, and it is derived from what
 * git says about this checkout rather than assembled from a layout convention:
 * a hard-coded `<worktree>/../.git/worktrees/<basename>` is wrong for a
 * worktree whose directory was renamed, for `$GIT_DIR`, for a plain clone, and
 * for a submodule, and it is wrong silently.
 *
 * The four are `claude-org`'s Pattern B union
 * (`docs/contracts/worker-git-guardrails-design.md` categories B1+B2), which
 * this reproduces rather than re-derives:
 *
 * 1. **the checkout's own admin directory** -- its `index`, `HEAD`, its locks;
 * 2. **the shared object store** -- `git add` writes the blob there, not in the
 *    admin directory, which is why staging alone needs it;
 * 3. **this branch's ref**, and only this one. `refs/heads` whole would let the
 *    worker rewrite a sibling worktree's branch, which is the cross-task
 *    isolation the union exists to keep;
 * 4. **`packed-refs`** -- git rewrites this file itself during ordinary commit
 *    and `pack-refs` work, so leaving it out breaks operations nobody asked
 *    for.
 *
 * For a plain clone (1) is the whole `.git` and the rest are inside it; the
 * union is then redundant rather than wrong, and saying it costs nothing.
 *
 * A detached HEAD yields no (3): there is no branch ref to name, and inventing
 * `refs/heads/HEAD` would allow a path that means nothing.
 *
 * @throws {GitCommandFailed} if `cwd` is not inside a work tree.
 */
export function gitMetadataRoots(options: GitOptions): readonly string[] {
  const gitDir = runGitChecked(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    options,
  ).stdout;
  const commonDir = runGitChecked(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    options,
  ).stdout;
  const roots = [gitDir, posixJoin(commonDir, "objects")];
  // `symbolic-ref --quiet` is the question "is HEAD on a branch", asked in the
  // one form that answers no by exit status instead of by echoing `HEAD` back
  // the way `rev-parse --abbrev-ref` does -- a detached checkout would
  // otherwise produce `refs/heads/HEAD`.
  //
  // The FULL ref, and no `--short`. `--short` abbreviates only as far as the
  // name stays unambiguous, so a repository carrying both `refs/heads/release`
  // and `refs/tags/release` answers `heads/release` -- and this would then name
  // `refs/heads/heads/release`, a path that is not the branch's ref and is not
  // anything. The full ref is already `refs/heads/<name>` and needs no prefix
  // put back on it. (Found by codex review of this change.)
  const head = runGit(["symbolic-ref", "--quiet", "HEAD"], options);
  if (isNoOnExitOne(head)) {
    roots.push(posixJoin(commonDir, head.stdout));
  }
  roots.push(posixJoin(commonDir, "packed-refs"));
  // De-duplicated in place: in a plain clone `--git-dir` and `--git-common-dir`
  // are the same directory, and the same path twice in a fence is noise in a
  // file an operator reads.
  return Object.freeze([...new Set(roots)]);
}

/**
 * Join path segments the way the *settings file* spells them: with `/`.
 *
 * Not `node:path.join`, which on Windows would emit `\` into a document whose
 * other paths come from `git rev-parse --path-format=absolute` and are
 * forward-slashed. One document, one separator.
 */
function posixJoin(...segments: readonly string[]): string {
  return segments
    .map((segment, index) => (index === 0 ? segment.replace(/\/+$/, "") : segment))
    .join("/");
}

/** One `git worktree add`. */
export interface WorktreeRequest {
  /** Absolute path the worktree is created at. Must not exist. */
  readonly path: string;
  /** The branch to create there. Must not already exist. */
  readonly branch: string;
  /** The commit it starts at, as returned by {@link resolveBranchCommit}. */
  readonly startCommit: string;
}

/**
 * Create a worktree at `request.path`, on a new branch, at an exact commit.
 *
 * `-b <branch>` rather than `--detach`, because the lap ends by pushing this
 * branch and opening a pull request against the recorded base; a detached
 * checkout would have to grow a branch later, at the point where the name
 * matters most and the least is known about it.
 *
 * **The start point is a resolved commit id, never the base branch's name.**
 * `resolveBranchCommit` has already been called and its answer recorded, and
 * passing the id here is what makes the recorded value true rather than
 * approximately true: between the two calls the base branch can move, and a
 * worktree created from the *name* would then start somewhere the event payload
 * does not say. It also removes the last place a branch name reaches git as a
 * revision rather than as a ref.
 *
 * `--no-track` because `-b` from a start point that happens to be a
 * remote-tracking commit would otherwise configure an upstream the operator did
 * not ask for, and the lap's push target is decided at step 11, not here.
 *
 * @throws {GitCommandFailed} if git refuses -- an existing path, an existing
 *   branch, a start commit that is not in this repository. git checks all three
 *   itself and says which; this module does not pre-check them, because a
 *   pre-check is a second answer to a question git answers atomically, and the
 *   race between the two is exactly the window in which two runs claim one path.
 */
export function addWorktree(request: WorktreeRequest, options: GitOptions): GitResult {
  return runGitChecked(
    ["worktree", "add", "--no-track", "-b", request.branch, request.path, request.startCommit],
    options,
  );
}

/**
 * Remove a worktree that was created here, on the recovery path.
 *
 * This is the *only* mutating call in this module that materialisation itself
 * does not make. It exists because `docs/design/minimal-operating-loop.md`'s
 * step 7 is artifact-first: a crash between the worktree and the result event
 * leaves artifacts with no event, which is the direction that is allowed to
 * happen precisely because it can be swept up afterwards -- and this is what
 * sweeps it. Materialisation itself never calls it: rolling a worktree back
 * inside a failing materialisation would delete a checkout an operator may be
 * looking at, and "leave it and record nothing" is the recoverable direction.
 *
 * `--force` is deliberately NOT passed. git refuses to remove a worktree with
 * uncommitted changes in it, and that refusal is correct here: a worktree with
 * work in it is not a leftover, whatever the event spine says about it.
 *
 * @throws {GitCommandFailed} if git refuses.
 */
export function removeWorktree(path: string, options: GitOptions): GitResult {
  return runGitChecked(["worktree", "remove", path], options);
}
