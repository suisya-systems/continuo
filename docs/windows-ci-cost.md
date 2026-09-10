# Where the Windows CI cell's wall clock goes

A measurement record, not a decision. Nothing here has been adopted: the point of
the investigation it comes from was to replace a set of plausible guesses with
numbers, and the candidates in the last section are costed but unchosen.

Read `docs/ci-merge-gate.md` first for what the cells are and why there are four
of them. The short version of why this file exists: `double-green` runs its four
cells in parallel, so the wait is the slowest cell, and that is always Windows --
21 to 33 minutes against single digits for ubuntu.

Every number below is dated and says which machine produced it, because the
headline finding is that two machines running the same operating system disagree
by a factor of 42.

## Method

Two sources, and it matters which is which.

1. **Existing CI logs, no instrumentation.** `gh api
   repos/suisya-systems/continuo/actions/runs/<id>/jobs` gives per-step start and
   finish times, and vitest's default reporter already prints per-file durations
   and a layer breakdown into the job log. Run `34506576632` (main, 2026-09-10)
   is the one quoted here; its ubuntu cell on the same commit is the control.
2. **A profiling run**, PR #200, run `34513292968`. `scripts/profile-sqlite-cost.mjs`
   times one commit and one database creation at each durability level and
   journal mode; `test/helpers/profile-pragmas.ts` forces every connection a
   worker opens to a chosen `synchronous` level, so the suite can be run with
   durability removed. Both are still in the tree, for re-measurement.

## 1. It is the suite, and inside the suite it is `tests`

On run `34506576632`, cell `windows-latest, node 24`, total 21m06s:

| | |
|---|---|
| checkout, setup-node, `npm ci`, type-check, native smoke, seed derivation | 32s |
| `Green 1 of 2` | 656s |
| `Green 2 of 2` | 573s |
| `Build the distribution` | 2s |

97% is the two suite runs. Within them vitest's own breakdown is equally
one-sided -- for the first parallel pass, `tests 793.07s` against `transform
4.65s`, `setup 5.72s`, `import 10.33s`. Type-checking, building and installing
are not worth optimising; they are already rounding error.

## 2. The two halves of the split are wall clock in different ways

`scripts/run-suite.mjs` splits the Windows run: a parallel pass, then the
child-process files at one worker (D-0048). Reconstructing concurrency from the
log -- each file's completion is timestamped and its duration printed, so
`start = end - duration` -- shows the two halves are not the same problem.

**Parallel pass: throughput-bound, not tail-bound.** Mean concurrency 2.80
against a peak of 3, and only 3 seconds of its 284s span with a single file
running. Perfectly packed at that peak the floor would be 264s, so scheduling
slack is 7%. **No single file is the critical path here.** Removing the heaviest
(`canary/audit.test.ts`, 87.9s) buys roughly its share of total work divided by
the concurrency -- about 29s, not 88s.

This is the trap #198 fell into: it removed the heaviest *single* file and the
wall clock did not move. Peak 3 is vitest's default `maxWorkers` of `cpus - 1` on
a 4-vCPU runner.

**Serial pass: entirely critical path.** At one worker its 368s is the sum of its
files, every one of them on the path 1:1, and it is 56% of the suite's wall
clock. Here per-file reduction does translate directly.

For contrast the ubuntu cell is tail-bound, the opposite shape:
`gate_item11/suite-runs-unchanged.test.ts` alone is 73% of its span.

## 3. The excess over ubuntu is SQLite, not child processes

Same commit, per file, windows against ubuntu: 6.8x overall, and concentrated in
files that open a control plane and commit to it and do nothing else.

| file | ubuntu | windows | ratio |
|---|---|---|---|
| `canary/audit.test.ts` | 1.4s | 87.9s | 61.7x |
| `canary/ledger.test.ts` | 0.7s | 37.0s | 54.6x |
| `gate/operator.test.ts` | 1.1s | 48.9s | 44.9x |
| `measurement/ac9.test.ts` | 1.3s | 41.0s | 32.0x |
| `control_plane/gates.test.ts` | 1.3s | 38.9s | 30.0x |

None of these spawns a child process. The D-0048 comment's claim that "what
dominates the remaining wall clock is child processes rather than SQLite" was
true of the measurement it cited and is not true of the Windows cell overall.

## 4. Within a file it is commit durability -- 93-96% of it

PR #200 ran nine files four times on `windows-latest`: durability on and off,
crossed with Defender excluded and not. vitest `tests` time:

| | scanner on | scanner excluded |
|---|---|---|
| `synchronous = FULL` | 174.6s | 137.8s |
| `synchronous = OFF` | 70.9s | 92.0s |

Per file, durability on against off, scanner on:

| file | FULL | OFF | remaining |
|---|---|---|---|
| `control_plane/events.test.ts` | 29.9s | 1.3s | **4%** |
| `canary/audit.test.ts` | 27.3s | 1.8s | **7%** |
| `canary/ledger.test.ts` | 7.1s | 0.9s | 12% |
| `control_plane/gates.test.ts` | 7.4s | 1.4s | 19% |
| `gate/operator.test.ts` | 8.8s | 1.8s | 21% |
| `measurement/ac9.test.ts` | 6.2s | 1.4s | 22% |
| `gate/cli.test.ts` | 7.8s | 2.3s | 30% |
| `fault_injection/conformance.test.ts` | 33.9s | 15.1s | 45% |
| `workspace/materializer.test.ts` | 46.1s | 45.0s | **98%** |

The last two were included precisely to test the serial pass, and they answer it.
`materializer` does not move at all: its cost is the git children it spawns, not
the plane they write to. `conformance` is about half and half. **The serial pass
and the parallel pass do not share a remedy.**

The same nine files on ubuntu go 22.2s to 18.3s. The effect is Windows-specific
in magnitude.

### The Defender axis is not resolved, and the experiment is why

The two rows disagree in sign: 174.6 → 137.8 with durability on, but 70.9 → 92.0
with it off. The arms ran in a fixed order (scanner on, then excluded), so the
exclusion is confounded with filesystem cache warmth, and Defender's first scan
of a file is the expensive one -- the later arms would run faster with no
exclusion at all. Any re-measurement must randomise or repeat the arm order.

Record this as **unmeasured**, not as "no effect".

## 5. The subject correction: it is not Windows, it is the runner's `C:`

The unit benchmark, one commit under the control plane's actual configuration
(rollback journal, since `src/control_plane/connection.ts` and
`src/canary/ledger.ts` both decline WAL):

| journal / synchronous | `windows-latest` runner | a developer's Windows box | a developer's WSL Linux |
|---|---|---|---|
| `delete` / `FULL` | **82.4 ms** | **1.94 ms** | 3.28 ms |
| `delete` / `NORMAL` | 28.4 ms | 1.56 ms | 2.66 ms |
| `delete` / `OFF` | 2.4 ms | 0.74 ms | 0.06 ms |
| `wal` / `FULL` | 2.8 ms | 0.44 ms | 1.34 ms |
| `wal` / `NORMAL` | 0.022 ms | 0.015 ms | 0.015 ms |

Two Windows machines, 42x apart. The developer's Windows box is *faster* than the
same developer's WSL Linux. So "Windows fsync is slow" is the wrong statement;
the true one is narrower: **this runner's filesystem is slow at fsync.** On a
healthy disk `FULL` against `OFF` is 2.6x, not 34x, and durability is not the
dominant cost at all.

42x is also, to the digit, the spread D-0052 recorded for one test across two
runners (28ms linux, 321ms windows healthy, 13,556ms windows slow) and attributed
to runner luck. It may not be luck.

**The leading explanation is that the databases are on the wrong drive.** The
runner checks the workspace out onto `D:` -- vitest reports its root as
`D:/a/continuo/continuo` -- while `test/helpers/tmp.ts` creates every test
database under `os.tmpdir()`, which on that image is
`C:\Users\RUNNER~1\AppData\Local\Temp`. On an Azure VM `C:` is the
network-attached OS disk and `D:` the local ephemeral SSD, and fsync is exactly
the operation that separates them. **This is untested**; the `windows-tmpdir` job
exists to test it.

Two other things this benchmark settles, both non-obvious:

- **`synchronous = NORMAL` is nearly useless under a rollback journal.** 82.4ms
  to 28.4ms, against 2.8ms to 0.022ms under WAL, because the journal file is
  fsynced either way. The 90x figure people quote for NORMAL is a WAL number.
- **WAL is not free**: it makes commits 29x cheaper and database *creation* 3x
  more expensive (22.3ms to 71.6ms per database on the runner). A suite that
  creates many planes and commits a few times to each could lose.

## 6. What any of this is worth, and what is still guessed

Applying the measured per-file ratios to run `34506576632` puts roughly **153s of
each 653s suite run** on commit durability -- about 100s off the parallel pass
(330s of measured work falling to ~50s, divided by the concurrency of 2.8) and
53s off the serial pass, where `conformance` is on the critical path 1:1. The
cell runs the suite twice, so about five minutes.

**That extrapolation covers the nine measured files only.** The parallel pass has
86 files and 793s of work; how much of the rest behaves the same way is not
measured.

Still unmeasured, and named so that nobody re-derives them from a guess:

- whether the temp directory's drive is the cause (section 5)
- the Defender axis (section 4)
- how many commits the suite actually performs
- WAL's net effect across the whole suite, creation cost included
- whether raising `maxWorkers` above the vCPU count helps a workload this
  fsync-bound

## 7. Candidates, costed, none adopted

| | effort | what it costs | status |
|---|---|---|---|
| Point the suite's temp directory at `RUNNER_TEMP` (`D:`) | one env var | nothing: no durability claim, journal mode or test changes | **untested, and worth more than the rest combined if section 5 is right** |
| Defender exclusion in CI | 3 lines | nothing on a disposable runner | blocked on a re-measurement that fixes the arm ordering |
| `journal_mode = WAL` for test planes only | medium | test and production planes stop sharing a journal mode; `connection.ts` declines WAL for three stated reasons; creation gets 3x dearer | needs its own measurement |
| Reduce commits per case | large | nothing semantic | commit count unmeasured |
| Raise `maxWorkers` past the vCPU count | small | memory, and contention that D-0048 assumed away | unmeasured |
| Revisit the serial pass (D-0048) | large | the contention relief D-0048 measured | a separate problem: `materializer`'s 98% says this half is child processes, so nothing above touches it |
| Weaken durability under test | small | D-0012's claim stops being exercised | **not recommended** -- it deletes the property rather than the cost |
