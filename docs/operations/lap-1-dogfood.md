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
