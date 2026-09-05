# The sandbox masks project-local config with `/dev/null`, and git reports the masks as untracked

*The answer to [#137](https://github.com/happy-ryo/continuo/issues/137) -- "a fenced child's
`git status` lists character devices its worktree does not contain". Kept in tree as the record of
what was measured and how; it is self-contained on purpose, so a reader needs nothing from this
repository to replay it. Nothing in continuo changes as a result: see "What this does and does not
mean for the fence" below.*

## Summary

When Claude Code's bubblewrap sandbox is on, the CLI read-only bind-mounts `/dev/null` over a fixed
set of **project-local configuration paths, anchored at the session's project root**. The masks are
not files the CLI writes. They are mounts, they live in **that session's mount namespace only**, and
they exist for the session's whole life.

Two consequences follow, and together they account for every part of #137:

1. **git sees them.** A bind-mounted `/dev/null` is a character device sitting in the working tree,
   at a path git does not track and no `.gitignore` mentions, so `git status --short` prints it as
   `??`. Where the CLI has to *create* a directory in order to mask paths under it -- `.claude/` --
   git prints the whole directory as one untracked entry.
2. **Nobody else sees them.** Another process, in another mount namespace, looking at the very same
   directory, sees none of it. `ls -a` and `git -C <that path> status` run from a *different* Claude
   session are that other process.

So the entries a fenced child reports are real for the child and absent for the operator checking
afterwards, with nothing appearing or disappearing in between. #137's leading hypothesis -- that
something creates devices in the child's worktree during the run and removes them again -- is
**wrong**, and the reason it did not reproduce is that the operator's check was made from a
namespace where those mounts were never anchored at that path in the first place.

## Environment

- Claude Code CLI **2.1.261** (#137 was observed on **2.1.260**)
- Linux (WSL2)
- A `claude` session with the sandbox enabled, project root = a git worktree

## The masked set, as measured

Every `/dev/null` bind in the session's namespace, from `/proc/self/mountinfo`:

```sh
awk '$4=="/null"{print $5}' /proc/self/mountinfo | sort
```

Eleven at the project root:

```text
<project root>/.bash_profile   <project root>/.gitconfig    <project root>/.profile     <project root>/.vscode
<project root>/.bashrc         <project root>/.gitmodules   <project root>/.ripgreprc   <project root>/.zprofile
<project root>/.idea           <project root>/.mcp.json                                 <project root>/.zshrc
```

and eleven more inside `.claude/`: `agents`, `commands`, `hooks`, `launch.json`, `loop.md`,
`output-styles`, `routines`, `scheduled_tasks.json`, `settings.json`, `skills`, `workflows`.

The mount line itself, for one of them:

```text
0:6 /null <project root>/.bashrc ro,nosuid,nodev,relatime - devtmpfs none rw,...
```

`/null` on `devtmpfs` is `/dev/null`; `ro` is why it is a mask rather than a redirect. On disk each
is `crw-rw-rw- 1 nobody nogroup 1, 3` -- the `1, 3` and the `crw-` of #137's report.

Read as a set these are the files a repository could ship to redirect a tool the agent runs: shell
rc and profile (`bash`, `zsh`), `git` config and submodule config, editor config (`.idea`,
`.vscode`), `ripgrep` config, and the MCP and Claude project config. Masking them with an empty
read-only file is a coherent defence. **That reading is inference; the mount table is the
measurement.** What is measured, and matters here, is that the set is *built in*: none of these
paths appears in the session's own `permissions.deny` or `sandbox.filesystem.deny*`, and the
`Bash command sandbox` reminder the session receives does not list them either.

## Reproduction

Inside any sandboxed session whose project root is a git worktree:

```sh
ls -la .bashrc .zshrc .profile .gitconfig .idea .vscode .ripgreprc .gitmodules .mcp.json
# crw-rw-rw- 1 nobody nogroup 1, 3 ... .bashrc      (and so on)

ls -la ../                      # the parent directory: none of them
ls -la src/.bashrc              # a subdirectory: No such file or directory
```

-- the masks are at the project root and nowhere else.

To see what git makes of them, ask git for the untracked set *without* the local excludes, since a
worktree that has been worked in for a while usually has these names in `.git/info/exclude` already:

```sh
git ls-files --others --directory --exclude-per-directory=.gitignore | grep '^\.'
```

In this repository that prints, in this order:

```text
.bash_profile  .bashrc  .claude/  .gitconfig  .gitmodules  .idea
.mcp.json      .profile  .ripgreprc  .vscode  .zprofile  .zshrc
```

-- twelve entries, **identical to the twelve #137 reports**, in the same order. The child of
`lap1-dogfood-007` was a fresh clone with no `.git/info/exclude` of its own, so its plain
`git status --short` printed exactly this.

## What #137 got right, and the two corrections

Right: that the entries are `/dev/null` character devices and environment litter rather than a view
of anyone's home directory; and that the twelve are exactly what `git status --short` prints in the
child's worktree if the devices are sitting in it.

Two corrections:

- **They do not come and go.** They were there for the child's whole run and were never at that path
  in the operator's namespace. The temporal framing -- "created and removed during a run" -- is what
  made the observation look unreproducible.
- **All twelve are artefacts; none is a genuine entry of the tree.** #137 (and §10.6 of the lap-1
  dogfood record) reads `.claude/` and `.mcp.json` as real untracked entries and counts ten devices.
  `.mcp.json` is itself a mask, and `.claude/` is a directory the CLI creates only so it can mask
  eleven paths *inside* it. The count is eleven masks plus one mask-bearing directory. Not one of
  the twelve is something the child wrote or the worktree owns.

## What this does and does not mean for the fence

**Does not:** the fence did not cause this and cannot prevent it. The mounts are made by the child's
own CLI from a built-in list, before any settings this repository writes are in play, and they are
invisible to the parent. No fence rule changes, so this finding carries no `D-` entry.

**Does:** an operator reading a fenced child's `git status` is reading a tree with up to twelve
entries that are not in it, and a child told to stage broadly (`git add -A`, `git add .`) will point
git at character devices. The already-documented failure where an untracked-inclusive stash breaks
part way through is the same devices from the same cause.

The noise is not confined to `git status`, either. `.gitmodules` is one of the masked names and is
also a path git opens on its own initiative, so ordinary commands narrate the mask -- `git fetch` in
such a session prints, twice, to stderr and while otherwise succeeding:

```text
warning: unable to access '<project root>/.gitmodules': Permission denied
```

A reader who does not know the cause will spend the warning on a permissions or ownership theory.
Nothing is actually inaccessible: the mount is `ro` and owned by `nobody`, and git wanted to read a
submodule config that does not exist.

The mitigation, if one is ever wanted, is one line of `.git/info/exclude` per name in the workspace
continuo materialises for the child -- `.git/info/exclude` is not committed, so it does not touch
the target repository's tracked files. It is **deliberately not done here**: the list is a property
of a particular CLI version on a particular platform, and burning it into the materialiser trades a
harmless cosmetic artefact for a maintenance obligation that goes stale silently. Prefer teaching
the reader (this document) over teaching the code, until something other than a confusing
`git status` is actually obstructed.

## Scope of the measurement

One CLI version (`2.1.261`), one platform (Linux under WSL2), one sandbox backend (bubblewrap). The
mask set was read from a live session rather than from the CLI's source, so it is the set *this*
version mounts and not a documented contract; it may differ by version, platform or settings. The
namespace claim is supported by the anchoring measurement above (parent and subdirectory carry
nothing) and by #137's own pair of observations, not by an experiment that enters another session's
namespace directly.
