/**
 * The twenty-four flag names `D-0086` refused, kept as a TEST CORPUS after
 * `D-0088` deleted them from `src/`.
 *
 * **These names no longer enforce anything.** Until `D-0088` they were
 * `FENCE_ALTERING_FLAGS` in `src/control_plane/lap_run_intent.ts`, and the
 * constructor refused an admitted run whose `cli_args` mentioned one. That rule
 * is gone: the `cli_args` allowlist (`src/fencing/cli_args_allow.json`) refuses
 * every argument vector it does not authorise, by whole-vector equality, so a
 * denylist of names has nothing left to add. Nothing in `src/` imports this
 * file, nothing here is checked against a submitted argument, and a reader who
 * takes this list as "the flags continuo refuses" has read it backwards: today
 * continuo refuses everything except what the document names, and this list is
 * a set of names the document is watched for -- see D7 below.
 *
 * **Why the prose that used to surround them is not here.** Each name carried a
 * paragraph saying which layer of the fence it removes, rewrites or walks
 * around -- `--bare` switching off the `PreToolUse` hook `D-0083` keeps,
 * `--add-dir` extending the reach `D-0067` bounds to the worktree, `--cloud`
 * putting the child on a machine the rendered files are not on. That prose is
 * the measurement, and it lives permanently in `D-0086`, which is append-only:
 * `AGENTS.md` says a superseded entry keeps its text and gains a `Status` line,
 * so `D-0086` remains the readable record of what each of these does and of the
 * CLI release (`2.1.260`) it was measured against. Copying it here would make
 * two texts that can disagree, and the one in the append-only ledger is the one
 * that cannot silently rot.
 *
 * **Why the constant lives in `test/` and not in `src/`.** A non-enforcing
 * exported constant in `src/` would rebuild the exact trap `D-0086` names: a
 * list that reads like the list of dangerous flags, and it is not. The next
 * reader would add a newly dangerous flag to it, believe the door shut, and
 * have changed nothing -- the failure mode of a denylist without a checker is
 * worse than no denylist, because it is indistinguishable from one that works.
 * In `test/` the list has one job and a checker that exercises it.
 *
 * **Its one job (`D-0088`, decision D7): it gates the RECORD, not the
 * decision.** `test/contract/cli-args-allow-document.test.ts` scans every
 * allowlist entry's `cli_args` for a member of this corpus and fails unless
 * that entry's `reason` NAMES the member it authorises. Authorising
 * `--allowedTools` -- the one flag the eight lap-1 dogfood runs actually used,
 * as a workaround for the fence defect `D-0081`/#120 closed -- is green once
 * somebody has written down that they did it and why, and red when it is done
 * silently. The corpus does not bar the entry, because barring it would make
 * the escape hatch useless for the only case ever observed.
 *
 * **The list is not exhaustive and never was.** That is `D-0086`'s own recorded
 * limitation: it refuses the alterations known on the day it was written and
 * cannot refuse one a future CLI release adds. Nothing here changes that, which
 * is why the corpus informs a written record rather than standing in for the
 * allowlist. Both spellings of the flags the CLI accepts twice are kept
 * (`--allowedTools` and `--allowed-tools`, and so on) because the scan matches
 * a name literally: an entry authorising the spelling that was dropped would
 * otherwise escape the record rule through a doorway in the corpus.
 *
 * The count is twenty-four, and both `D-0086` and `D-0088` state it in words,
 * so the contract test asserts the length as well -- a name silently dropped
 * from this list would quietly narrow the record rule those decisions describe.
 */
export const FENCE_ALTERING_FLAGS: readonly string[] = [
  // Remove a layer of the fence.
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--bare",
  "--safe-mode",
  // Rewrite the fence's own lists from the argv.
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  // Hand the child reach, or configuration, the fence did not author.
  "--add-dir",
  "--plugin-dir",
  "--plugin-url",
  "--agents",
  "--agent",
  // Move the child out of the workspace the fence was rendered for. The long
  // spelling precedes the short one, so a report over this corpus names
  // `--worktree` rather than `-w`.
  "--worktree",
  "-w",
  // Move execution, or control of it, out from under this run entirely -- the
  // fence is not weakened here, it is somewhere the child is not.
  "--cloud",
  "--environment",
  "--teleport",
  "--background",
  "--bg",
  "--remote-control",
  // The CLI writes a path itself, under no tool and so under no hook.
  "--debug-file",
  "--file",
];
