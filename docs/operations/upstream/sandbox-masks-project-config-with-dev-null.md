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

`/null` on `devtmpfs` is `/dev/null`; `ro` is why nothing can be written back through it. On disk
each is `crw-rw-rw- 1 nobody nogroup 1, 3` -- the `1, 3` and the `crw-` of #137's report. The
`nodev` matters too, and is easy to skim past: on a `nodev` mount the kernel will not open a device
node, so a masked path is not an empty file but an unreadable one, and a read of it fails `EACCES`
however permissive its mode bits look. See "What this does and does not mean for the fence" for the
warning this produces in ordinary use.

Read as a set these are the files a repository could ship to redirect a tool the agent runs: shell
rc and profile (`bash`, `zsh`), `git` config and submodule config, editor config (`.idea`,
`.vscode`), `ripgrep` config, and the MCP and Claude project config. Making each of them unreadable
is a coherent defence. **That reading is inference; the mount table is the
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

The path really is unreadable, and the reason is the `nodev` in the mount line above rather than the
`ro` or the `nobody` ownership: on a `nodev` mount the kernel refuses to open a device node at all,
so the mask is not an empty file but an unopenable one. Measured, on both a masked config path and a
masked rc file:

```sh
cat .gitmodules              # cat: .gitmodules: Permission denied
python3 -c "import os; os.open('.gitmodules', os.O_RDONLY)"   # OSError errno 13 EACCES
```

`EACCES` on a path that `ls` shows as `crw-rw-rw-` is the shape to recognise. A reader who does not
know the cause will spend the warning on a file-permission or ownership theory, and the mode bits
will appear to contradict them.

### The mitigation, and why this change is not it

The mitigation is one line of `.git/info/exclude` per masked name in the workspace continuo
materialises for the child. `.git/info/exclude` is not committed, so it does not touch the target
repository's tracked files, and this repository's own worker worktrees already carry exactly those
lines by hand -- which is why a `git status` run here is clean while `lap1-dogfood-007`'s fresh
clone's was not.

It would work, and on more than the cosmetics. `git add -A`, `git add .` and an untracked-inclusive
stash all honour the exclude file, so excluding the names keeps git from reaching the devices at all
and closes the two real failures above, not just the confusing listing. Measured here, where the
names are already excluded:

```sh
git add -A --dry-run        # lists only real files; no device is proposed
git add --dry-run .bashrc   # "The following paths are ignored by one of your .gitignore files"
```

-- an explicit add is refused, not merely skipped. It would **not** close the `.gitmodules` warning:
git opens that path on its own initiative regardless of what is excluded.

So the reason this change does not make it is **not** that the artefact is harmless -- it is not,
and the paragraphs above should be read as the case *for* eventually doing this:

- **It is a fence behaviour change, and this was an investigation.** Writing into the child
  workspace's git metadata is the fence acquiring a new side effect, which is a `D-` decision rather
  than a docs task's to take unilaterally. It is recommended, not done.
- **The list is a property of one CLI version on one platform.** That is an argument about how to
  build it, not about whether -- a stale list degrades benignly, since a name that stops being
  masked simply stops needing the exclude, and a newly masked name reintroduces the old noise rather
  than producing a wrong answer. A mitigation that reads the live mount table instead of a
  hard-coded list would not go stale at all, and is the better shape if this is taken up.
- **Nothing is obstructed today.** continuo's fenced children are not instructed to stage broadly,
  and this repository's worker rules already forbid the stash mutation that the devices break. The
  cost of waiting is that a reader is confused once and finds this document; the cost of guessing
  wrong in the materialiser is carried by every run.

## Scope of the measurement

One CLI version (`2.1.261`), one platform (Linux under WSL2), one sandbox backend (bubblewrap). The
mask set was read from a live session rather than from the CLI's source, so it is the set *this*
version mounts and not a documented contract; it may differ by version, platform or settings. The
namespace claim is supported by the anchoring measurement above (parent and subdirectory carry
nothing) and by #137's own pair of observations, not by an experiment that enters another session's
namespace directly.
