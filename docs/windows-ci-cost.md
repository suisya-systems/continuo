# Where the Windows CI cell's wall clock goes

A measurement record. The investigation it comes from existed to replace a set of
plausible guesses with numbers; one of the candidates it produced has since been
adopted (`DECISIONS.md` `D-1109` -- the temporary directory's drive, section 5a),
and the rest of the table in section 7 remains costed and unchosen.

Read `docs/ci-merge-gate.md` first for what the cells are and why there are four
of them. The short version of why this file exists: `double-green` runs its four
cells in parallel, so the wait is the slowest cell, and that was always Windows --
21 to 33 minutes against single digits for ubuntu. Past tense since `D-1109`: it
is now 7 to 9 minutes, and section 5b is the measurement of that.

Every number below is dated and says which machine -- and, it turns out, which
*drive* -- produced it. That is the headline: two machines running the same
operating system disagreed by a factor of 42, and the reason was that the suite
creates its databases on the runner's slow network-attached `C:` while the
workspace sits on the fast local `D:`. Section 5a has the confirmation; sections
1 to 4 are the narrowing that got there, and are worth keeping because two of
them (which half of the split a fix lands in, and what is still unmeasured)
outlive the finding.

## Method

Two sources, and it matters which is which.

1. **Existing CI logs, no instrumentation.** `gh api
   repos/suisya-systems/continuo/actions/runs/<id>/jobs` gives per-step start and
   finish times, and vitest's default reporter already prints per-file durations
   and a layer breakdown into the job log. Run `34506576632` (main, 2026-09-10)
   is the one quoted here; its ubuntu cell on the same commit is the control.
2. **Two profiling runs**, PR #200: run `34513292968` (durability crossed with
   Defender) and run `34515834981` (the temp directory's drive). `scripts/profile-sqlite-cost.mjs`
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

**The cause is that the databases are on the wrong drive**, and this one is no
longer a hypothesis -- see section 5a. The runner checks the workspace out onto
`D:` while `test/helpers/tmp.ts` creates every test database under
`os.tmpdir()`, which on that image is `C:\Users\RUNNER~1\AppData\Local\Temp`.
`C:` is the network-attached OS disk and `D:` the local ephemeral SSD, and fsync
is exactly the operation that separates them.

## 5a. Confirmed: the drive is the cause

Run `34515834981`, job `windows-tmpdir`, 2026-09-10. One job, two arms, differing
only in `TEMP`/`TMP`. The drives, printed rather than assumed:

```
workspace   D:\a\continuo\continuo
RUNNER_TEMP D:\a\_temp
os.tmpdir() C:\Users\RUNNER~1\AppData\Local\Temp   <- every test database
```

| | `C:` (default) | `D:` (`RUNNER_TEMP`) | ratio |
|---|---|---|---|
| commit, `delete` / `FULL` | 15.60 ms | **1.14 ms** | **13.7x** |
| commit, `delete` / `OFF` | 1.80 ms | 0.46 ms | 3.9x |
| database creation, `delete` / `FULL` | 13.61 ms | 1.60 ms | 8.5x |
| plain 64KiB file create + delete | 0.559 ms | 0.347 ms | 1.6x |

Plain file operations barely move while the fsync-bearing ones move by 8-14x, so
what `C:` is slow at is specifically fsync, not file I/O generally.

The same nine files, `tests` time: **129.24s on `C:`, 43.78s on `D:` -- 3.0x**.
Every file improves, `workspace/materializer.test.ts` included (1.3x), because
the git children it spawns use the temporary directory too.

The comparison that settles the candidate list:

| | `tests` time |
|---|---|
| `C:` with `synchronous = FULL` (today) | 129.2s |
| `C:` with `synchronous = OFF` (D-0012 abandoned) | 70.9s |
| **`D:` with `synchronous = FULL`** | **43.8s** |

**Moving the temporary directory beats giving up durability, and gives up
nothing.** No decision is reversed, no journal mode changes, no test changes.

### It is also a flakiness finding, not only a speed one

The same `C:`, same benchmark, two runs: **82.4 ms/commit and 15.60 ms/commit --
5.3x apart on one drive.** That is a network-attached disk with neighbours. `D:`
is local.

So D-0052's 42x spread "across runners", continuo #83's roughly one-in-five
Windows failures with two thirds of them timeouts rather than assertions, and
D-1003's skip may all be the same single cause. If so, this changes how often the
cell is *red*, not just how long it is *slow*. Untested as a flakiness claim --
it would take a run of Windows cells on `D:` to support it.

**Left unmeasured on purpose.** Confirming it means watching failure rates over
many runs, and the operator chose to let the cells that run anyway supply that
evidence rather than open a task to manufacture it. So this is a deliberate wait,
not an oversight: if a later reader wants the answer, the way to get it is to
count red Windows cells since `D-1109`, not to re-run anything.

### The extrapolation, kept here because it was wrong in the useful direction

From the nine files -- 478s of the suite's 1149s of test work -- this section
originally predicted a suite run at roughly 474s against 652s, so the cell at
"about 15 minutes against 21", and said in as many words that the parallel pass's
other 463s was arithmetic rather than measurement.

The measurement came in at **7m27s**. The extrapolation was conservative by
roughly a factor of two, because the 463s that had not been measured turned out
to be the same kind of work as the 478s that had. Section 5b has the real
numbers.

Two other things this benchmark settles, both non-obvious:

- **`synchronous = NORMAL` is nearly useless under a rollback journal.** 82.4ms
  to 28.4ms, against 2.8ms to 0.022ms under WAL, because the journal file is
  fsynced either way. The 90x figure people quote for NORMAL is a WAL number.
- **WAL is not free**: it makes commits 29x cheaper and database *creation* 3x
  more expensive (22.3ms to 71.6ms per database on the runner). A suite that
  creates many planes and commits a few times to each could lose.

## 5b. Adopted, and what it bought

`D-1109`. Two adjacent runs on the same branch and the same `windows-latest,
node 24` cell, differing in the temporary directory and nothing that touches
Windows -- run `34515834981` (before) against `34521636568` (after). The
`origin/main` merge between them carries #199, which only affects the nested
suite run that D-1003 skips on Windows; both logs still report `24 passed |
2 skipped`, so it is not in these numbers.

| | before | after | ratio |
|---|---|---|---|
| **cell, end to end** | **22m25s** | **7m27s** | **3.0x** |
| parallel pass, wall | 295.26s | 55.04s | 5.4x |
| parallel pass, test work | 819.17s | 126.68s | 6.5x |
| serial pass, wall | 395.67s | 148.72s | 2.7x |
| serial pass, test work | 384.32s | 137.93s | 2.8x |

Across all four cells, before against after (the second Windows cell is `node
22`, and the two Windows cells disagree because runners still vary -- 22m25s and
17m18s before, 7m27s and 9m07s after):

| cell | before | after |
|---|---|---|
| windows, node 22 | 20m23s | **9m07s** |
| windows, node 24 | 21m02s | **7m27s** |
| ubuntu, node 22 | 4m18s | 3m45s |
| ubuntu, node 24 | 3m31s | 3m42s |

**ubuntu did not move**, which is the confirmation that scoping mattered: the
step does not run there, and had the two names been set unconditionally the
Linux cells would have moved too, since POSIX `os.tmpdir()` falls back to TMP and
TEMP after TMPDIR.

### What this changes about what to look at next

The two halves have swapped places. The serial pass is now **73%** of a suite
run (148.72s of 203.76s) where it was 56%, because the parallel pass improved
5.4x and it improved 2.7x. Section 2's distinction is therefore more load-bearing
than before, not less: the remaining wall clock is mostly the half where every
file is on the critical path 1:1, and section 4 already measured that half as
child processes rather than fsync (`workspace/materializer.test.ts`, 98%
unchanged under durability-off, 1.3x here).

The parallel pass's concurrency also fell, 2.80 to 2.30 (126.68s of work in
55.04s of wall), because per-file fixed costs are a larger share once the fsync
is gone. Whether `maxWorkers` is still the right number is now a different
question from the one section 7 recorded, and still unmeasured.

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

- the Defender axis (section 4)
- whether `D-1109` reduced the Windows failure rate as well as the duration
  (section 5a -- a deliberate wait, not an oversight)
- how many commits the suite actually performs
- WAL's net effect across the whole suite, creation cost included
- whether raising `maxWorkers` above the vCPU count helps a workload this
  fsync-bound

## 7. Candidates, costed, one adopted

| | effort | what it costs | status |
|---|---|---|---|
| Point the suite's temp directory at `RUNNER_TEMP` (`D:`) | one env var | nothing: no durability claim, journal mode or test changes | **adopted, `D-1109`** -- measured 3.0x (section 5a) |
| Defender exclusion in CI | 3 lines | nothing on a disposable runner | still unmeasured, and now lower value: the fsync cost was the drive |
| `journal_mode = WAL` for test planes only | medium | test and production planes stop sharing a journal mode; `connection.ts` declines WAL for three stated reasons; creation gets 3x dearer | **not needed** -- `D:` is faster and costs nothing |
| Reduce commits per case | large | nothing semantic | commit count unmeasured; less pressing at 1.14ms a commit |
| Raise `maxWorkers` past the vCPU count | small | memory, and contention that D-0048 assumed away | unmeasured, and worth re-asking after the move |
| Revisit the serial pass (D-0048) | large | the contention relief D-0048 measured | a separate problem: `materializer`'s 98% says this half is child processes, so nothing above touches it |
| Weaken durability under test | small | D-0012's claim stops being exercised | **not needed** -- `D:` at `FULL` beats `C:` at `OFF` |
