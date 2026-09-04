# lap 1 dogfood -- the runbook, and what it cost to get through it

A record of driving steps 1-10 of [`../design/minimal-operating-loop.md`](../design/minimal-operating-loop.md)
section 7 end to end with a real worker (the `claude` CLI). What is written here is **the commands
that were actually run and the output that actually came back**, not what the design expects. Step 11
(push, PR, merge, close the run) is the operator's manual leg and ends the lap; this runbook stops
one step short of it, where the gate closes.

- Run on 2026-09-04, against continuo at `2d0684b` (the revision at which step 10 was on main).
- **Steps 1-10 ran.** The gate reached `outcome=answered_and_forwarded`, which closes the gate --
  not the lap. Step 11 ends the lap in the design, and it was not performed here: nothing was
  pushed or merged and the run's status is still `created` (section 6). With the fence as shipped
  the worker cannot write a single byte (F-2 below), so the lap that did real work needed a
  workaround.
- Worker prose quoted below (gate rationales, answers) is Japanese because that is what the worker
  and the operator wrote; it is reproduced verbatim rather than translated.

---

## 1. What to have ready, in absolute paths

These are the values this run used. Everything the fence rests on is required to be absolute --
`--claude-command`, `--node`, `--endpoint-module`, `--hook-script`, `--python`, `--interlock-root`,
`--claude-org-path`, `--workspace` -- and writing every path absolute, as here, is the habit worth
keeping.

Which of them must already exist is not uniform, and getting it backwards costs a run:

- **Must exist**: the CLI, the interpreter, the target repository, and the directory holding `--db`.
- **Must not exist**: `--endpoint-destination-dir`, which is refused for existing, and the workspace,
  which `git worktree add` creates.
- **Created for you**: `--state-root` and `--artifact-root` are both made recursively if absent.
- **Strictest case**: `--interlock-root` and `--claude-org-path` are substituted into the fence's own
  deny rules, so a path that is not there leaves a fence that looks enforced and guards nothing.

| What | Value |
|---|---|
| Control plane database | `/home/happy_ryo/work/org/workers/continuo-dogfood/control-plane.sqlite3` |
| Artifact root | `/home/happy_ryo/work/org/workers/continuo-dogfood/artifacts` |
| State root | `/home/happy_ryo/work/org/workers/continuo-dogfood/session-state` |
| Dropbox (endpoint destination) | `/home/happy_ryo/work/org/workers/continuo-dogfood/dropbox-003` |
| Target repository | `/home/happy_ryo/work/org/workers/continuo-dogfood/sandbox-clone` (see F-1) |
| Workspace (the worktree the lap cuts) | `/home/happy_ryo/work/org/workers/continuo-dogfood/workspace-003` |
| Worker CLI | `/home/happy_ryo/.local/bin/claude` |
| Interpreter for the endpoint | `/home/happy_ryo/.volta/tools/image/node/22.16.0/bin/node` |
| `--interlock-root` | `/home/happy_ryo/work/org/workers/interlock` |
| `--claude-org-path` | `/home/happy_ryo/work/org/claude-org-ja` |
| `--endpoint-recipient` | `external-notify` -- **not a name of your choosing** (F-3) |
| `--hook-script`, `--python` | omitted: this build's own are used |
| `--endpoint-module`, `--endpoint-db` | omitted: derived from the build and from `--db` |

Build first, with the install this repository requires (`AGENTS.md`; `npm ci` on its own runs
lifecycle scripts and breaks `better-sqlite3`, which `npm run smoke:native` then catches):

```bash
cd /home/happy_ryo/work/org/workers/continuo/.worktrees/continuo-lap1-dogfood
npm ci --ignore-scripts && npm run build
```

The three variables the rest of this runbook uses:

```bash
CLI=/home/happy_ryo/work/org/workers/continuo/.worktrees/continuo-lap1-dogfood/dist/cli.js
DB=/home/happy_ryo/work/org/workers/continuo-dogfood/control-plane.sqlite3
# G is the gate id, printed by `lap perform`; it is set in section 5.
```

Three constraints, each of which exits 2 when broken:

- The directory holding `--db` must already exist. `db create` creates the file, never the directory.
- `--endpoint-destination-dir` **must not exist**. Materialisation is what creates it, so an existing
  path is treated as another materialisation's, and publishing over it could replace a fence some
  worker is running under. Give each run a fresh path (`dropbox-001`, `dropbox-002`, ...).
- `--artifact-root` is reusable -- it writes `<root>/<run id>` -- but it must live outside the worktree.

---

## 2. Step 2: bring a control plane into existence

```bash
node "$CLI" db create --db "$DB"
# created .../control-plane.sqlite3: schema version 4 of 4        (0.16 s)

node "$CLI" db verify --db "$DB"
# verified .../control-plane.sqlite3: schema version 4 of 4       (0.10 s)
```

`db create` refuses an existing path rather than adopting it. To start over, use a different path.

## 3. Step 6: admit the run, which fixes the delegation record

```bash
PROMPT='ワークツリー直下の novel.md の末尾に、作品の締めの一文を 1 文だけ追加し、
コミットメッセージ "docs(dogfood): 締めの一文を追加" で commit せよ。push はしてはならない。
ただし締めの文体には A 案 (体言止め) と B 案 (常体の完結文) の 2 案があり、どちらを採るかは
人間の判断が要る。まず A 案で 1 文を追記して commit し、turn の最後に
「判断仰ぎ: 締めの文体は A 案 (体言止め) と B 案 (常体の完結文) のどちらを採用すべきか」と
明記して turn を終えよ。'

node "$CLI" run admit \
  --db "$DB" \
  --run-id lap1-dogfood-003 \
  --lease-claimant-id operator-dogfood \
  --workspace /home/happy_ryo/work/org/workers/continuo-dogfood/workspace-003 \
  --role worker \
  --base-branch main \
  --topic-branch dogfood/lap1-003 \
  --cli-arg=--allowedTools \
  --cli-arg='Edit,Write,Bash(git add:*),Bash(git commit:*),Bash(git status:*),Bash(git diff:*)' \
  --prompt "$PROMPT"
# admitted lap1-dogfood-003 ...: status created,
#   run_created/lap1-dogfood-003 at seq 10, run_delegation_recorded/lap1-dogfood-003 at seq 11   (0.10 s)
```

The two `--cli-arg` lines are **the workaround for F-2**, not something this verb should need. Drop
them and the worker finishes its turn without ever getting an `Edit` through -- that is exactly what
laps 1 and 2 of this dogfood did.

> **Since D-0081 this workaround is no longer needed.** A non-interactive spawn renders
> `permissionMode: acceptEdits`, so the run above admits without either `--cli-arg` line. They are
> left in place because this section records what these three laps actually took; see F-2.

Pass a value that starts with `-` as `--cli-arg=--allowedTools`. Written with a space,
`--cli-arg --allowedTools`, argparse reads the next token as a flag and exits with
`expected one argument`.

`--role` must be one of the four roles in the bundled role document -- `worker`, `curator`,
`dispatcher`, `secretary` -- but `run admit` does not check that: any non-empty string is accepted
and persisted. The roster is checked when `lap perform` renders the fence, by which point the topic
branch and the worktree already exist. A typo here is paid for late.

## 4. Steps 7-9: perform the lap

```bash
node "$CLI" lap perform \
  --db "$DB" \
  --run-id lap1-dogfood-003 \
  --repository /home/happy_ryo/work/org/workers/continuo-dogfood/sandbox-clone \
  --artifact-root /home/happy_ryo/work/org/workers/continuo-dogfood/artifacts \
  --state-root /home/happy_ryo/work/org/workers/continuo-dogfood/session-state \
  --endpoint-recipient external-notify \
  --endpoint-destination-dir /home/happy_ryo/work/org/workers/continuo-dogfood/dropbox-003 \
  --node /home/happy_ryo/.volta/tools/image/node/22.16.0/bin/node \
  --claude-command /home/happy_ryo/.local/bin/claude \
  --interlock-root /home/happy_ryo/work/org/workers/interlock \
  --claude-org-path /home/happy_ryo/work/org/claude-org-ja \
  --turn-timeout-ms 540000 \
  --gate-option adopt-a-taigendome \
  --gate-option adopt-b-jotai
# performed 'lap1-dogfood-003' ...: worktree '.../workspace-003' on 'dogfood/lap1-003'
#   at fc94f02..., session cdbdc322-43fb-41fc-9cdb-903e13d75f33 started,
#   gate gate/worker_escalation/cdbdc322-.../0 over event worker_escalation/cdbdc322-.../0 at seq 13
```

Measured wall clock, each including one full worker turn: 52 s, 17 s, 32 s over the three laps.

The command materialises the workspace, renders the fence, spawns the worker, waits for the turn's
terminal report, and opens the gate. **The waiting ends at the terminal report, not at the child's
exit** -- but the command does not return there either: its teardown then stops the session and
awaits the child before returning, and abandons the endpoint lease if the stop did not report
success. So the duration above is the worker's work plus teardown, not the worker's work plus
however long its MCP servers take to shut down.

What one invocation writes:

- a worktree at `workspace-003`, cut from `main`, on a new `dogfood/lap1-003`
- `artifacts/lap1-dogfood-003/` holding `fence.json`, `settings.local.json`, `mcp.json`,
  `fence-ledger.jsonl`
- `session-state/<session id>/` holding `record.json` (argv and pid), `events-000.jsonl` (the
  transcript) and `stderr-000.log`
- the `workspace_materialized` and `worker_escalation_raised` events, and the gate standing over the
  second of them

What the worker actually did is in the worktree and in the transcript:

```bash
git -C /home/happy_ryo/work/org/workers/continuo-dogfood/workspace-003 log --oneline -2
# 5a7ddc8 docs(dogfood): 締めの一文を追加
# fc94f02 feat(dogfood): 短編小説 novel.md を追加
```

## 5. Step 10: close the gate as `answered_and_forwarded`

`G` is the gate id `lap perform` printed.

```bash
G=gate/worker_escalation/cdbdc322-43fb-41fc-9cdb-903e13d75f33/0

node "$CLI" gate list --db "$DB"
# gate/worker_escalation/cdbdc322-.../0 worker_escalation run=lap1-dogfood-003 stage=received since=... deadline=-

node "$CLI" gate show --db "$DB" --gate-id "$G"   # rationale in the worker's own words, options, relays, transitions

node "$CLI" gate present --db "$DB" --gate-id "$G"
# enqueued relay/<gate id>/presented to external-notify for stage presented

node "$CLI" gate deliver --db "$DB" \
  --destination-dir /home/happy_ryo/work/org/workers/continuo-dogfood/dropbox-003 \
  --holder operator-dogfood
# delivered 1 message(s) to external-notify under epoch 8

node "$CLI" gate ack --db "$DB" --message-id "relay/$G/presented" --actor-id operator-dogfood
# ...: acked=true cancelled=false advanced=true closed=false stage=presented

node "$CLI" gate answer --db "$DB" --gate-id "$G" \
  --body "adopt-a-taigendome を採用する。A 案 (体言止め) のまま確定でよい。" \
  --actor-id operator-dogfood
# answered=true enqueued relay/<gate id>/forwarded for stage forwarded

node "$CLI" gate deliver --db "$DB" \
  --destination-dir /home/happy_ryo/work/org/workers/continuo-dogfood/dropbox-003 \
  --holder operator-dogfood
# delivered 1 message(s) to external-notify under epoch 9

node "$CLI" gate ack --db "$DB" --message-id "relay/$G/forwarded" --actor-id operator-dogfood
# ...: acked=true cancelled=false advanced=true closed=true stage=forwarded

node "$CLI" gate show --db "$DB" --gate-id "$G"
# ... stage=forwarded deadline=- outcome=answered_and_forwarded      <-- the gate has closed
```

Each of these takes about 0.1 s. The stage moves **on the ack, not on the send**, so `deliver` alone
never advances a gate. `present` and `ack` are both idempotent.

The dropbox gets one `<sha256>.effect.json` per relay plus an `attempts.log`. The `fence.json` that
also appears there is **not a fence artifact**: it is the dropbox's own fencing token
(`{"outbox-delivery": 9}`). Do not read it as `artifacts/<run id>/fence.json`.

One reconcile pass was run, and found nothing:

```bash
node "$CLI" gate reconcile --db "$DB" --actor-id operator-dogfood --stalled-tolerance-ms 300000
# settled: subject_gone=0 advanced=0 closed=0
# found: relay_gaps=0
# found: stalled_relays=0
# found: past_deadline=0
```

Omit `--stalled-tolerance-ms` and the stalled query does not run at all; there is no default,
per `D-0031`.

## 6. Where this stops

Step 11 -- push the topic branch, open a PR against the recorded base branch, merge, close the run --
is the operator's manual leg and was not performed. The run's status is still `created`, and no CLI
verb exists to move it. Five events remain: `run_created`, `run_delegation_recorded`,
`workspace_materialized`, `worker_escalation_raised`, `gate_closed`.

---

## 7. What got in the way (symptom / cause / workaround / real fix)

### F-1. The target repository's `.claude/settings.local.json` overrides the fence

- **Symptom.** With `--repository /home/happy_ryo/work/org/workers/dogfood-sandbox`, every `Edit` and
  `Write` the worker attempted came back as
  `PreToolUse:Edit hook error: [bash ".../check-worker-boundary.sh"]: ブロック: .../workspace/novel.md
  は許可パス外です。作業は /home/happy_ryo/work/org/workers/dogfood-sandbox 内で行ってください`.
- **Cause.** The child `claude` reads ambient settings in addition to `--settings <fence>`. The target
  repository carried a `.claude/settings.local.json` whose `env.WORKER_DIR` (pointing at the
  repository root) and whose `hooks.PreToolUse` took effect, **overriding** the `WORKER_DIR` the
  fence had set to the materialised worktree. A fence delivered through `--settings` can add to the
  ambient configuration; it cannot remove it.
- **Workaround.** Point `--repository` at a clone that carries no such file
  (`git clone <repo> .../sandbox-clone`; an untracked `.claude/` does not come along).
- **Real fix.** Make the fence hermetic -- have `lap perform` confine the child's configuration
  discovery to its own artifact directory -- or, failing that, detect a `.claude/settings*.json` in
  the target repository before spawning and refuse. Undetected, an operator cannot tell whether the
  fence or the ambient configuration is the thing in force.
- **Fixed (D-0081, #119).** The first of the two: the rendered plan passes `--setting-sources ''`,
  which confines the child to the fence and the managed settings, and the materialiser passes
  `--strict-mcp-config` for the same reason on the MCP axis. The pre-spawn refusal was not taken --
  it would make every repository with local settings permanently unrunnable. The clone workaround
  above is no longer needed.

### F-2. Under the fence as shipped, a non-interactive worker cannot write anything

- **Symptom.** With the ambient settings out of the picture, `Edit` still came back as
  `Claude requested permissions to write to .../novel.md, but you haven't granted it yet.`, and the
  worker ended its turn having done no work at all.
- **Cause.** The rendered `settings.local.json` has `permissionMode: "default"` and a
  `permissions.allow` list of six `Bash(git ...)` entries. `Edit` and `Write` are allowed nowhere.
  `lap perform` starts the worker with `claude -p`, so there is no human to approve anything, and a
  confirmation request under the default mode is therefore always a denial. The deny half of the
  fence worked correctly: the worker's `git worktree` calls were refused by rule.
- **Workaround.** Admit the run with
  `--cli-arg=--allowedTools --cli-arg='Edit,Write,Bash(git add:*),Bash(git commit:*),...'`.
  Admitted `--cli-arg` values are placed **before** the fence's own `--permission-mode`, so
  `--cli-arg=--permission-mode --cli-arg=acceptEdits` is overridden and does nothing;
  `--allowedTools` is additive and works.
- **Real fix.** Either allow `Edit`/`Write` for the `worker` role in the role document, or render
  `permissionMode: acceptEdits` for a non-interactive spawn. Which one is a fence design decision,
  so nothing was changed here. As it stands, lap 1's worker can only read and escalate, which does
  not meet section 7 step 7's "a worker that can both work and poll".
- **Fixed (D-0081, #120).** The second of the two, taken at the human gate: a non-interactive spawn
  renders `default` as `acceptEdits`. The role document is untouched -- its allow list is not
  widened and its deny rules are byte-identical -- so an interactive spawn of the same role is
  unchanged.

### F-3. An arbitrary `--endpoint-recipient` fails just before the spawn

- **Symptom.** `--endpoint-recipient operator` exits 2 with
  `error: the MCP configuration names recipient 'operator', which no registered handler serves`.
- **Cause.** The recipient is not free text: it must be a name in the handler registry
  (`external-notify` or `human-gated-effect`). `--help` does not say so.
- **Workaround.** Use `external-notify`.
- **Real fix.** List the valid values in `--help`, as `choices` if the surface allows it.

### F-4. `--endpoint-destination-dir` is refused merely for existing

- **Symptom.** A pre-created dropbox exits 2 with
  `... already exists; materialisation creates its artifacts ...`.
- **Cause.** By design: materialisation owns the path, so an existing one is presumed to belong to
  another materialisation.
- **Workaround.** Do not create it; give each run a fresh path.
- **Real fix.** The refusal is right; the help text should say the directory must not exist. Read
  alongside `gate deliver`'s "Created if it does not exist" for the same directory, the current
  wording reads as a contradiction.

### F-5. The dropbox payload is `\uXXXX`-escaped, so a human cannot read it

- **Symptom.** In `<sha256>.effect.json`, `payload` holds
  `\"rationale\": \"\\u30d5\\u30a1\\u30a4...\"`; the worker's rationale is not legible.
- **Cause.** The payload is serialised with ASCII escaping (Python's `ensure_ascii=True` behaviour).
- **Workaround.** Read it with `gate show`, which prints the text as written.
- **Real fix.** The dropbox is the surface an operator reads, so emit non-ASCII as-is. If the
  escaping is a deliberate interoperability contract, say so in `gate deliver`'s help.

### F-6. Truncating output through a pipe can kill the CLI with EPIPE

- **Symptom.** `node "$CLI" gate show ... | head -1` died with
  `Error: write EPIPE ... at Object.write (dist/gate/cli.js:135:24)`. It does not reproduce every
  time; it is timing-dependent.
- **Cause.** `EPIPE` on stdout is not handled. Any `head`/`less` on the output can trigger it.
- **Workaround.** Do not truncate the output.
- **Real fix.** Swallow `EPIPE` in the output path and exit quietly -- within the scope of
  [`../cli-output-policy.md`](../cli-output-policy.md).

### F-7. There is no verb that moves a run forward

- **Symptom.** The gate closes and `run.status` is still `created`.
- **Cause.** Step 11 is designed as the operator's manual leg, and no CLI verb moves a run to
  `running` or to a close.
- **Workaround.** None; this run left the status alone.
- **Real fix.** Add the `run close` equivalent when step 11 gets a CLI. It carries a design decision,
  so this is a proposal only.

---

## 8. The three laps this record is drawn from

| Run id | Target repository | `--allowedTools` | Result |
|---|---|---|---|
| `lap1-dogfood-001` | `dogfood-sandbox` | no | Every write refused by the ambient hook (F-1). The gate opened and closed `answered_and_forwarded` |
| `lap1-dogfood-002` | `sandbox-clone` | no | No write permission, so no work (F-2). The gate opened and closed |
| `lap1-dogfood-003` | `sandbox-clone` | yes | **Commit `5a7ddc8`, then the escalation.** Gate closed `answered_and_forwarded` |

All three opened a gate, and all three closed `answered_and_forwarded`. Steps 1-10 of the control
plane behave as designed; step 11, which is what ends the lap, is untested here. What did not run is
the worker inside the fence, and the reasons for that are F-1 and F-2.


---

## 9. Lap 2, on `5a6d75d`: what #119 and #120 changed, and what still stops the lap

A second dogfood, run on 2026-09-04 against continuo at `5a6d75d` -- the revision at which `D-0081`
(#119, the hermetic fence; #120, `acceptEdits` for a non-interactive spawn) was on main. The question
it was run to answer: does lap 1 now reach a commit and a closed gate **without the operator passing
`--allowedTools` by hand**?

**The answer is no, and the reason is new.** #119 and #120 both do what they say. The worker edited
the file under `acceptEdits` with nobody at its prompt, which is what #120 was for, and the target
repository's own settings did not reach it, which is what #119 was for. What stopped the commit is
the `sandbox` block in the fence itself (F-8), a defect lap 1 never saw because lap 1 never got far
enough to meet it.

| Run id | Target repository | `--allowedTools` | Result |
|---|---|---|---|
| `lap1-dogfood-004` | `dogfood-sandbox` (carries a write-refusing `.claude/settings.local.json`) | no | The worker appended with `Bash`; `git add` / `git commit` refused. Gate closed `answered_and_forwarded` |
| `lap1-dogfood-005` | `sandbox-clone` (carries none) | no | Same shape. **Run on a locally modified build** -- see the note below -- so it is cited here only for its transcript, never for the fence's behaviour |
| `lap1-dogfood-006` | `dogfood-sandbox` | no | The prompt required `Edit`. The edit landed, the commit did not. Gate closed `answered_and_forwarded` |

**Read 006 as the lap of record.** It is the one run on an unmodified `5a6d75d` whose worker used the
tool that the target's own hook matches, which is what makes its F-1 result mean anything (9.4).
Run 005 was performed while this worktree carried an experimental change to `SpawnPlan.cliArgs()`,
and its `record.json` accordingly lacks `--setting-sources ''`; the change was reverted before 006
and is in no commit, but 005 cannot be quoted as an observation of the shipped fence.

### 9.1 The paths this lap used

Everything in section 1 still holds. What changed run to run is only the paths that must be fresh,
and the target:

| What | Value |
|---|---|
| Dropbox (endpoint destination) | `.../continuo-dogfood/dropbox-004`, `-005`, `-006` |
| Workspace | `.../continuo-dogfood/workspace-004`, `-005`, `-006` |
| Target, runs 004 and 006 | `/home/happy_ryo/work/org/workers/dogfood-sandbox` |
| Target, run 005 | `/home/happy_ryo/work/org/workers/continuo-dogfood/sandbox-clone` |
| Control plane database | unchanged from lap 1, and reused rather than recreated |

The database is reused: `db create` refuses an existing path, but `run admit` is happy to add a run
to a control plane that already holds three. `db verify` first -- 0.10 s, `schema version 4 of 4`.

**One environment note that costs a confusing minute.** If the CLI is driven from a shell whose
filesystem sandbox does not include the control plane's directory, `run admit` dies with
`SqliteError: attempt to write a readonly database` and a Node stack, not with continuo's own exit 2.
The database file is not readonly; the caller is. What needs the write access is every verb that
changes something -- `run admit`, `lap perform`, `gate present`, `gate answer`, `gate deliver`,
`gate ack`, `gate reconcile`. Inspection does not: `db verify`, `gate list` and `gate show` all run
from a caller that can only read, which is what makes them the right thing to reach for when a run
has gone sideways and you are not sure what you are allowed to touch.

### 9.2 The lap, without the lap 1 workaround

`run admit` is section 3's command **minus both `--cli-arg` lines**, which is the whole point of the
run. Run 006's prompt is section 3's with one sentence added -- the third line below -- and that
sentence is load-bearing rather than stylistic, so `$PROMPT` must be reassigned rather than reused
from section 3:

```bash
PROMPT='ワークツリー直下の novel.md の末尾に、作品の締めの一文を 1 文だけ追加し、
コミットメッセージ "docs(dogfood): 締めの一文を追加" で commit せよ。push はしてはならない。
追記は必ず Edit ツールで行うこと (Bash のリダイレクトや sed で書き換えてはならない)。
ただし締めの文体には A 案 (体言止め) と B 案 (常体の完結文) の 2 案があり、どちらを採るかは
人間の判断が要る。まず A 案で 1 文を追記して commit し、turn の最後に
「判断仰ぎ: 締めの文体は A 案 (体言止め) と B 案 (常体の完結文) のどちらを採用すべきか」と
明記して turn を終えよ。'
```

Without that sentence the worker is free to append with `printf >>`, which is what run 004 did -- and
a `Bash` write does not exercise the target's `Edit|Write` hook, so the run cannot say anything about
whether that hook was inherited. Pinning the tool is what turns the run into a measurement.

```bash
node "$CLI" run admit --db "$DB" \
  --run-id lap1-dogfood-006 --lease-claimant-id operator-dogfood \
  --workspace /home/happy_ryo/work/org/workers/continuo-dogfood/workspace-006 \
  --role worker --base-branch main --topic-branch dogfood/lap1-006 --prompt "$PROMPT"
# admitted lap1-dogfood-006 ...: status created,
#   run_created/lap1-dogfood-006 at seq 25, run_delegation_recorded/lap1-dogfood-006 at seq 26
```

`lap perform` is section 4's command with the paths above. Wall clock: **29.4 s** (004), **30.4 s**
(006) -- the same shape as lap 1's 52 / 17 / 32 s, and dominated by the worker's turn.

The rendered `settings.local.json` now says `"permissionMode": "acceptEdits"` where lap 1's said
`"default"`, and `record.json`'s `cli_args` is

```json
["--settings", ".../artifacts/lap1-dogfood-006/settings.local.json",
 "--permission-mode", "acceptEdits", "--setting-sources", "",
 "--mcp-config", ".../artifacts/lap1-dogfood-006/mcp.json", "--strict-mcp-config"]
```

where lap 1's carried the operator's `--allowedTools`. Both are `D-0081`, arriving as designed.

What the worker did, from `session-state/4289eb20-c47b-40fa-a6b0-4dd2dfc2dda2/events-000.jsonl`:

```text
TOOL_USE: Edit  {"file_path": ".../workspace-006/novel.md", "old_string": "届いた、と思った。", ...}
RESULT: The file ... has been updated successfully.        <-- #120: nobody at the prompt, and it wrote
TOOL_USE: Bash  {"command": "git add novel.md && git commit -m \"docs(dogfood): 締めの一文を追加\" ..."}
system permission_denied: This Bash command contains multiple operations. The following parts
  require approval: git add novel.md, git commit -m "docs(dogfood): 締めの一文を追加"
TOOL_USE: Bash  {"command": "git add novel.md"}
system permission_denied: This command requires approval  <-- and `Bash(git add:*)` IS in the fence
```

`git status --short` at the end of the turn: ` M novel.md`. `git log --oneline -1`: still the base
commit. The worker then raised its escalation and said in its own words that the commit had not
happened -- the right behaviour under a fence it cannot argue with, and the reason the gate below is
worth reading even though the lap did not finish its work.

### 9.3 Step 10 again, and it closes

Identical to section 5, against `G=gate/worker_escalation/4289eb20-c47b-40fa-a6b0-4dd2dfc2dda2/0`:
`gate present` -> `gate deliver` -> `gate ack` -> `gate answer` -> `gate deliver` -> `gate ack`, each
0.09-0.14 s, ending at

```text
gate/worker_escalation/4289eb20-.../0 ... stage=forwarded deadline=- outcome=answered_and_forwarded
transition 23 advance received->presented  by=secretary/operator-dogfood
transition 24 advance presented->answered  by=human/operator-dogfood     body=adopt-a-taigendome ...
transition 25 advance answered->forwarded  by=secretary/operator-dogfood
transition 26 close   forwarded->forwarded by=system/operator-dogfood
```

**And this time `reconcile` found something**, which is worth more than lap 1's four zeros:

```bash
node "$CLI" gate reconcile --db "$DB" --actor-id operator-dogfood --stalled-tolerance-ms 300000
# settled: subject_gone=0 advanced=0 closed=0
# found: relay_gaps=1
#   gap gate/worker_escalation/a20e849b-6a2f-4d6b-b36e-c7c77a6f49c5/0 at received age=854383
# found: stalled_relays=0
# found: past_deadline=0
```

That gap is run 005's gate, which was opened and then left at `received` because the run was
abandoned. A gate with no relay behind it is exactly what `relay_gaps` is for, and the age is in
milliseconds. Lap 1's all-zero pass showed the verb runs; this one shows it can see.

What it still says nothing about is the run sitting at `created` with uncommitted work in its
worktree, because no gate is stalled -- F-7 seen from another angle rather than a reconcile defect.

`F-5` is unchanged: the dropbox's `<sha256>.effect.json` still escapes the payload to ASCII, so the
answer reads `\"answer\": \"adopt-a-taigendome \\u3092\\u63a1\\u7528\\u3059\\u308b\\u3002...\"`.

### 9.4 F-1, checked in the field

Runs 004 and 006 pointed `--repository` at `dogfood-sandbox`, which still carries the
`.claude/settings.local.json` whose `PreToolUse` hooks refused every write in lap 1's run 001. **Under
the hermetic fence it did not apply**, and run 006 is what shows it:

- that file's hook matches `Edit|Write` and runs `check-worker-boundary.sh` with `WORKER_DIR` set to
  the repository root. Run 006's worker edited `.../workspace-006/novel.md` -- a path outside that
  root -- **with the `Edit` tool**, and the edit succeeded. Inherited, the hook would have answered
  with the `ブロック: ... は許可パス外です` it produced for every write in run 001.

Run 004 cannot carry this conclusion, and the difference is the reason 006 exists. Its worker
appended with `printf >>`, which the target's hook does not match, so the hook's silence there is
what you would see either way. The other tempting argument from 004 -- that the target's
`permissions.allow` contains `Bash(git add:*)` and `git add` was nonetheless refused -- does not work
either: F-8 shows the fence's *own* allow list does not get `git add` through, so the refusal is
overdetermined and says nothing about whose allow list was in force.

So #119 works against the repository that produced F-1. **Section 7's F-1 clone workaround is no
longer needed for that reason** -- though F-8 below means neither target reaches a commit yet.

The canary this lap first intended to plant instead -- a purpose-built write-refusing
`.claude/settings.local.json` in `sandbox-clone` -- could not be created: the operator was itself a
claude-org worker, and `block-org-structure.sh` refuses any Bash command that creates a `.claude/`
directory, wherever it points. Using the repository that already carried one is the stronger test
anyway, since it is the file that produced the original defect.

### 9.5 What got in the way (continued from section 7)

Section 7's list is filed, and this lap changed nothing about the open half of it: F-3 is #121, F-4
is #122, F-5 is #123, F-6 is #124, F-7 is #125, and section 3's note on an unchecked `--role` is
#126. F-1 (#119) and F-2 (#120) are the two that shipped, and 9.4 is F-1's field check. F-8 and F-9
below were new here; they are #130 and #132, and both are now fixed by `D-0082` / `D-0083`. The
accounts below are left as this lap wrote them, because what they cost is part of the record; each
ends with what closing it actually turned out to require, and F-8's cause is not the one this lap
concluded.

#### F-8. The fence's `sandbox` block refuses the writes its own allow list permits, and lets denied reads through

- **Symptom.** Under the fence as rendered, `git add novel.md` comes back as
  `This command requires approval` -- with `Bash(git add:*)` in the fence's `permissions.allow`. In
  the same fence `git worktree list` **runs**, with `Bash(git worktree *)` in the fence's
  `permissions.deny` *and* in the deny hook's rules.
- **Cause.** The `sandbox.filesystem` block the fence renders. Measured on CLI `2.1.260` from
  `workspace-005`, whose target carries no settings of its own so that nothing ambient is in play:

  | settings passed to `claude -p` | `git add -n novel.md` | `git worktree list` |
  |---|---|---|
  | the rendered fence, as shipped | `This command requires approval` | **runs** |
  | the same fence with only the `sandbox` key removed | `add 'novel.md'` | `worker: Bash denied by permission-deny rule 'git worktree *'` |
  | a minimal file carrying only `permissions` | `add 'novel.md'` | denied |

  Removing one key fixes both directions, so both are that key's. The read that slips through is a
  command the sandbox can satisfy on its own, and it appears not to reach the permission decision or
  the hook at all. The write that is refused is refused because a worktree's `.git` is a *file*
  pointing into `<target>/.git/worktrees/<name>` -- outside the workspace -- so `git add`, which
  writes the index, writes outside the sandbox's writable surface. With no person to approve the
  escalation, `claude -p` turns that into a refusal.
- **Workaround.** Lap 1's, unchanged, and re-measured under the current fence: admit the run with
  `--cli-arg=--allowedTools --cli-arg='Bash(git add:*),Bash(git commit:*)'`. With it, `git add -n`
  returns `add 'novel.md'` under the same fence that refuses it without. `--allowedTools` outranks
  the sandbox escalation where the settings file's own allow list does not.
- **Real fix.** A fence design decision, so nothing was changed here. Three candidates: drop the
  `sandbox` block from the rendered settings and rest on `permissions` plus the deny hook; keep it
  and add the worktree's real `.git` directory to the writable surface; or render it only for an
  interactive spawn, the way `D-0081` scoped the `acceptEdits` promotion. The first loses a layer,
  the second leaves the read-side hole, and the third is the narrowest and matches the precedent.
- **Fixed by `D-0082` (#130) -- and the cause above is wrong.** The gate chose the second candidate,
  and implementing it alone was measured to change nothing. What the `sandbox` key actually does here
  is destroy itself: the block carries one deny entry in the structured form
  `{"path": "~/.ssh"}`, which the CLI cannot read, so it builds *no sandbox at all* -- silently, with
  no warning and a zero exit -- and a sandbox that was declared and could not be built makes every
  write-capable `Bash` require approval whatever the allow list says. The writable surface was never
  the problem: with that entry spelled as a string, the CLI already resolves the worktree's gitdir
  itself. And the block has no `enabled` key, which is what the CLI builds a sandbox *for* -- so the
  layer this account assumed was too tight had never once existed. The renderer now flattens the deny
  entries, sets `enabled`, and adds the derived roots anyway so the fence does not depend on an
  undocumented derivation. The read-side hole is untouched and is #131.

#### F-9. One fence deny rule is spelled in a form the CLI does not apply

- **Symptom.** Starting a child under the fence prints, on stderr,
  `Permission deny rule (...): Write(~/.claude/settings.json) is not matched by file permission
  checks — only Edit(path) rules are. Use Edit(~/.claude/settings.json) instead (Edit rules cover all
  file-editing tools).`
- **Cause.** The role document spells the rule `Write(...)`. The CLI applies file-permission rules
  under `Edit(...)`, which covers every file-editing tool including `Write`.
- **How deep the gap goes: both layers, for the tool that matters.** The tempting reading is that
  the fence's own deny hook still carries the rule, so only the `permissions` layer is affected. It
  does not. `matches` in [`../../src/fencing/rules.ts`](../../src/fencing/rules.ts) compares
  `toolName !== rule.tool` -- an exact tool name -- so a `Write(...)` rule is consulted only for the
  literal `Write` tool. A child that reaches `~/.claude/settings.json` with `Edit` is matched by
  neither the hook (wrong tool name) nor the permission system (rule ignored, as the warning says).
  The one path the rule does still close is a literal `Write`, at the hook layer only.
- **Workaround.** None; nothing at spawn time recovers the rule. The warning on stderr is the only
  signal, and it names the fix.
- **Real fix.** Spell it `Edit(~/.claude/settings.json)` in the role document -- which covers every
  file-editing tool at the permission layer, and matches the `Edit` tool at the hook layer. claude-org
  hit the same warning and removed its `Write(...)` declarations for the same reason
  (`docs/worker-permissions-design.md`), so the form is settled elsewhere and this is a transcription
  to make -- and a one-line one. `src/fencing/roles.json` carries three `Write(...)` deny rules, but
  the other two already have their twin beside them: `curator` has both
  `Write(**/.claude/skills/**)` and `Edit(**/.claude/skills/**)`, and `secretary` has both
  `Write(**/src/**)` and `Edit(**/src/**)`. **`worker` is the only role whose `Write(...)` rule
  stands alone**, so it is the only one with the gap. The other two still draw the warning when
  those roles are spawned, since the `Write(...)` half is ignored either way; whether to drop it as
  noise or keep it for the hook's exact-match layer is a smaller question than this one.
- **Fixed by `D-0083` (#132), except the warning.** `worker` carries the `Edit(...)` form now, beside
  the `Write(...)` one. Measured afterwards over three settings files differing only in that list:
  the warning names the *`Write` spelling's presence*, not the missing `Edit`, so it stays for as
  long as that spelling does -- for `curator` and `secretary` too. It is now noise about a redundant
  rule rather than a signal about a dead one. The smaller question this account left open turned out
  to be the deciding one, and `D-0083` records why the `Write(...)` half was kept.

#### A methodological note that cost this lap a wrong conclusion

The first pass at F-8 was run from `workspace-004`, and concluded that `--setting-sources` voids the
`--settings` file. **It does not.** `workspace-004` is a worktree of `dogfood-sandbox`, so the
ambient settings under test were also supplying the allow and the deny being attributed to the fence;
removing the flag let them back in, and the fence appeared to come to life with them. Re-run from
`workspace-005`, whose target carries no settings, the flag makes no difference at all: a minimal
settings file is honoured identically with and without it, and the fence's own deny hook fires under
it, exactly as `D-0081` recorded.

Two rules follow, and they are cheap next to what they cost here:

- **Measure a fence in a target that carries no settings of its own.** A target with ambient
  configuration cannot tell you which layer refused.
- **Read the refusal message, not just the refusal.** The two layers deny in different words --
  `Permission to use Bash with command ... has been denied.` from the permission system, and
  `worker: Bash denied by permission-deny rule '...'` from the fence's own hook. The second names the
  rule; the first names nothing, and it is the one an ambient rule produces.
