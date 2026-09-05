# A non-string entry in `sandbox.filesystem.denyRead` / `denyWrite` silently disables `permissions.deny` and `PreToolUse` hooks

*Written to be filed upstream against the Claude Code CLI. It is self-contained on purpose: a reader
needs nothing from this repository to replay it.*

## Summary

If any entry of `sandbox.filesystem.denyRead` or `sandbox.filesystem.denyWrite` in a settings file is
not a string -- for example the object form `{"path": "~/.ssh"}`, or a number -- Claude Code
`2.1.261` accepts the settings file, exits zero, prints no warning and writes nothing to stderr, and
then applies **neither** `permissions.deny` **nor** any `PreToolUse` hook for that run.

The failure is open, not closed. A `Read` of a path covered by a `permissions.deny` rule succeeds and
the file's contents are returned to the model. The `PreToolUse` hook -- the documented escape hatch
for exactly this situation -- is never invoked at all.

Deleting the `sandbox` key entirely restores correct enforcement. So a settings file that a reader
would take to be strictly *more* restrictive, because it adds a sandbox deny list on top of the
existing rules, ends up strictly *less* restrictive than the same file with that block removed.

## Environment

- Claude Code CLI **2.1.261**
- node **v22.17.0**
- Linux (WSL2)
- Model used in the repro: `claude-haiku-4-5-20251001`
- Target: a git repository carrying no settings of its own, with `--setting-sources ''`, so the only
  settings in effect are the file passed to `--settings`.

## Reproduction

### 1. The hook (`hook.mjs`)

It writes a witness file *before* it decides. The witness is the direct observation: if the file does
not exist after the run, the hook was never invoked -- as opposed to invoked and overruled.

```js
import { writeFileSync } from "node:fs";

writeFileSync("/abs/path/witness.txt", "invoked\n");
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "denied by the PreToolUse hook",
  },
}));
```

### 2. The settings file

The two cases differ in exactly one thing: whether the single `denyRead` entry is a string or an
object. The path is the same in both.

**Good -- the entry is a string. Enforcement works.**

```json
{
  "permissions": { "deny": ["Bash(ls:*)"], "allow": [] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /abs/path/hook.mjs" }] }
    ]
  },
  "permissionMode": "acceptEdits",
  "sandbox": {
    "enabled": true,
    "filesystem": { "denyRead": ["/abs/path/to/.ssh"], "denyWrite": [] }
  }
}
```

**Bad -- the same path as an object. All enforcement is discarded.**

```json
{
  "permissions": { "deny": ["Bash(ls:*)"], "allow": [] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /abs/path/hook.mjs" }] }
    ]
  },
  "permissionMode": "acceptEdits",
  "sandbox": {
    "enabled": true,
    "filesystem": { "denyRead": [{ "path": "/abs/path/to/.ssh" }], "denyWrite": [] }
  }
}
```

### 3. The command

```sh
claude -p "Run exactly this one command with the Bash tool and then stop, reporting its outcome
verbatim: ls -la /abs/path/to/target -- Do not retry it, do not use dangerouslyDisableSandbox, and
do not run any other command." \
  --settings /abs/path/settings.json \
  --setting-sources '' \
  --model claude-haiku-4-5-20251001 \
  --output-format json
```

### Expected

With `permissions.deny: ["Bash(ls:*)"]` and a `PreToolUse` deny hook, the `ls` is refused and
`witness.txt` exists. A `sandbox` block the CLI does not accept should at worst be ignored, leaving
enforcement no weaker than if the block were absent.

### Observed, in the bad case

The `ls` **runs** and its output is returned to the model. `witness.txt` **does not exist**: the hook
was never called. Exit status 0, no warning, empty stderr.

## Results

24 cells: eight spellings of the `sandbox` key crossed with three commands (`git worktree list`,
`ls -la <dir>`, `touch <file>`), each paired with its matching `permissions.deny` rule
(`Bash(git worktree *)`, `Bash(ls:*)`, `Bash(touch:*)`). Every spelling behaved identically across
all three commands.

| `sandbox` value | hook invoked? | the denied command |
|---|---|---|
| key absent entirely | yes | refused |
| `{enabled:true, filesystem:{denyRead:["/abs/.ssh"]}}` | yes | refused |
| `{filesystem:{denyRead:["/abs/.ssh"]}}` (no `enabled`) | yes | refused |
| `{enabled:true, ..., surprise:{...}}` (an unknown key) | yes | refused |
| `{enabled:true, filesystem:{denyRead:[{"path":"~/.ssh"}]}}` | **no** | **ran** |
| `{filesystem:{denyRead:[{"path":"~/.ssh"}]}}` | **no** | **ran** |
| `{enabled:true, filesystem:{denyWrite:[{"path":"~/.ssh"}]}}` | **no** | **ran** |
| `{enabled:true, filesystem:{denyRead:[42]}}` | **no** | **ran** |

An unknown key inside `sandbox` is harmless. The object form and the bare number behave identically,
so the trigger is not specific to the object form -- though only those two non-string types were put
in front of the CLI in these arrays.

### `additionalDirectories` is unaffected

Eight further cells, entry types `["<abs>"]`, `[{"path":"<abs>"}]`, `[42]` and `[null]` over two
commands: all harmless. The hook fired and the denied command was refused in every one. The effect is
specific to `denyRead` and `denyWrite`.

### It is not `Bash`-only

Four cells with hook matcher `"*"` and `permissions.deny: ["Read(<secret file>)", "Edit(<dir>/**)"]`:

| `denyRead` entry shape | `Read` of the denied file | `Write` under the `Edit(...)` rule |
|---|---|---|
| string | refused by the hook | refused by the hook |
| object | **succeeded; the file's contents were returned to the model** | refused, but with *"Claude requested permissions to write to ..., but you haven't granted it yet"* -- the no-approver path in `-p`, not the deny rule |

The write happens to stop only because a non-interactive run has nobody to grant approval. That is
not the configured rule doing its job. We did not test an interactive or auto-approving session, so
we cannot say what happens to the write there; what the measurement shows is only that the rule was
not what stopped it.

## Why this matters

`permissions.deny` is the mechanism operators use to keep an agent away from credentials, and the
`PreToolUse` hook is the documented backstop for when the declarative rules are not enough. Here
both are gone at once, so a defence-in-depth setup that layers a hook under the deny list fails
exactly as one without it. There is no runtime signal: we saw nothing in the exit status, on stderr,
or in the `-p` JSON transcript. (We did not check `/doctor` or `--debug`.) The operator's evidence
that the fence is gone is that a forbidden operation succeeded.

The likely real-world trigger is a plausible typo, or a configuration generator that emits the object
form -- or that passes an operator's malformed entry through in the belief that the CLI will reject
the file.

## Determinism

The decisive pair -- string entry versus object entry, all else equal -- was run four times in each
configuration: 4/4 enforced with the string form, 4/4 entirely unenforced with the object form. The
remaining cells were run once each; no cell disagreed with its row.

## Scope of the measurement

Held constant, and therefore untested: one CLI version (`2.1.261`); one platform (Linux under WSL2);
one invocation mode (`claude -p` -- never interactive); one model; `"permissionMode": "acceptEdits"`
in every cell; and one delivery route for the settings (`--settings <file>` with
`--setting-sources ''`, against a target carrying none) -- a `sandbox` block arriving from project,
user or managed settings was not tested. Every settings file carried `"allow": []`, so what was
observed is deny rules going unapplied, not that an allow list is discarded too.

We did not inspect the CLI. The shape of the results is consistent with a validation failure over the
settings object as a whole, but we did not confirm that, and nothing here should be read as a claim
about the implementation.

## What a fix might look like

1. **Never let a settings block the CLI does not accept make enforcement weaker than omitting that
   block.** This is the property that matters. Whatever happens to a malformed `sandbox` value, the
   outcome should be at least as strict as the "key absent" row above, which enforces correctly.
2. **Fail loudly on a `denyRead` / `denyWrite` entry that is not a string** -- refuse to start, or at
   minimum warn naming the offending key and index. Silently discarding a security-relevant block is
   the one outcome that gives an operator no chance to notice.
3. **Do not let a `sandbox` problem disable `permissions.deny` and `PreToolUse` hooks.** They are
   separate mechanisms in separate keys; if they must share a failure path, it should be a closed
   one.
4. Accepting the object form would resolve this particular instance, but the general property in (1)
   still matters for any other value the settings parser will not take.
