/**
 * The lap, end to end, driven by CLI verbs and nothing else.
 *
 * **This file is step 8's acceptance criterion, stated as a test.** The step's
 * own wording is "a lap can be driven end to end by CLI verbs plus an operator
 * ... no hand-written TypeScript program", and the only way to hold a build to
 * that is to write a case whose whole body is `continuo db create`,
 * `continuo run admit` and `continuo lap perform`. Every path through
 * `src/lap/root.ts` is exercised here *through the verb*, because a case that
 * called `performLap` directly would be the hand-written program the step
 * exists to make unnecessary, and would stay green on a build whose CLI had
 * never mounted the subtree.
 *
 * **Target-only.** No parity ledger claims this file, on the same ground as
 * `test/workspace/materializer.test.ts` and `test/session/terminal-report.test.ts`:
 * interlock has no composition root to port from -- the module that was one had
 * no tests and was therefore never inventoried
 * (`docs/design/minimal-operating-loop.md` section 1). Rule 10 of
 * `docs/test-translation-conventions.md` applies.
 *
 * **These cases drive real git and start a real child**, so this file is listed
 * in `SPAWNING_TESTS` in `scripts/run-suite.mjs` and runs on the Windows serial
 * pass (`D-0048`). Both are load-bearing rather than incidental: a double for
 * git would be a double for the worktree the fence is established over, and a
 * double for the child would be a double for the one thing the fence exists to
 * constrain. The child is `test/session/helpers/fake-claude.mjs` -- the same
 * fake the session belt's 65 cases run against, so the worker in this lap is
 * configured exactly the way that belt configures it and no second fake can
 * drift from it.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import process from "node:process";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";
import { dispatch, helpStrings } from "../../src/cli/parser.js";
import { buildParser, main, mainAsync } from "../../src/cli.js";
import { dbCliSeams } from "../../src/control_plane/cli.js";
import { HUMAN_GATED_RECIPIENT, NOTIFY_RECIPIENT } from "../../src/control_plane/handlers.js";
import { acquire as acquireLease } from "../../src/control_plane/lease.js";
import { openProductionControlPlane } from "../../src/control_plane/migrator.js";
import { pythonRepr } from "../../src/control_plane/python_repr.js";
import {
  WORKER_ESCALATION_EVENT_TYPE,
  WORKER_ESCALATION_GATE_TYPE,
} from "../../src/control_plane/report_ingress.js";
import { RUN_DELEGATION_RECORDED_EVENT_TYPE } from "../../src/control_plane/run_admission.js";
import { runCliSeams } from "../../src/control_plane/run_cli.js";
import { EVENT_ADMITTED } from "../../src/fencing/spawn.js";
import { lapCliSeams } from "../../src/lap/cli.js";
import { DELIVERY_LEASE_RESOURCE } from "../../src/messagebus/endpoint.js";
import { type GitOptions, runGitChecked } from "../../src/workspace/git.js";
import {
  FENCE_FILENAME,
  FENCE_LEDGER_FILENAME,
  MCP_CONFIG_FILENAME,
  WORKSPACE_MATERIALIZED_EVENT_TYPE,
} from "../../src/workspace/materializer.js";
import { fakeCli, fakeEnv, fakeMode } from "../session/helpers/fake-cli.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeams } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const BASE_BRANCH = "main";
const TOPIC_BRANCH = "feat/topic";
const ROLE = "worker";
const RUN_ID = "run-lap-1";
const HOLDER = "operator-1";
const SETTINGS_FILENAME = "settings.local.json";

/** What the worker says when its turn ends, and what the gate is opened over. */
const REPORT_TEXT = "The fence refuses the push. May I publish?";

/**
 * A repository with one commit on {@link BASE_BRANCH}.
 *
 * The same shape `test/workspace/materializer.test.ts` builds and deliberately
 * not shared with it: that file's fixture is part of what its own cases assert
 * about git, and a helper serving both would make a change made for one file's
 * cases silently change the other's premise.
 */
function initRepository(root: string): GitOptions {
  mkdirSync(root, { recursive: true });
  const git: GitOptions = { cwd: root, timeoutMs: 60_000 };
  runGitChecked(["init", `--initial-branch=${BASE_BRANCH}`, "."], git);
  runGitChecked(["config", "user.name", "continuo test"], git);
  runGitChecked(["config", "user.email", "continuo@example.invalid"], git);
  runGitChecked(["config", "commit.gpgsign", "false"], git);
  writeFileSync(join(root, "README.md"), "seed\n", "utf8");
  runGitChecked(["add", "README.md"], git);
  runGitChecked(["commit", "-m", "seed"], git);
  return git;
}

/** Everything one case needs, plus what the verbs wrote while it ran. */
interface Lap {
  readonly root: string;
  readonly repository: string;
  readonly databasePath: string;
  readonly workspace: string;
  readonly artifactDir: string;
  readonly stateRoot: string;
  /** The dropbox the endpoint is configured to write into (`continuo#122`). */
  readonly destinationDir: string;
  readonly out: string[];
  readonly err: string[];
  /** The `lap perform` command line, so a case can dispatch it either way. */
  argv(overrides?: Readonly<Record<string, string>>): string[];
  /** `continuo lap perform`, with `overrides` replacing the defaults by flag. */
  perform(overrides?: Readonly<Record<string, string>>): Promise<number>;
}

/**
 * A control plane, a repository and an admitted run -- all three through the
 * CLI, because that is what the acceptance says.
 *
 * `runId` is a parameter because the artifact directory is derived from it
 * (`D-0061`), so a case that wants to see the derivation has to be able to
 * choose one.
 *
 * `spellWorkspace` exists for one case and is worth the parameter. `LapRunIntent`
 * requires the workspace to be fully qualified and says in as many words that
 * normalisation is not its business, so a run can be admitted with a `..` in it
 * -- and every containment check downstream is lexical. It takes the normalised
 * path and returns the spelling to admit, because the case cannot compute one
 * itself: `caseRoot` hands out a FRESH directory per call, so a case that asked
 * for the root a second time would be spelling a different lap's workspace.
 */
function lap(
  label: string,
  runId = RUN_ID,
  spellWorkspace: (workspace: string) => string = (workspace) => workspace,
): Lap {
  const root = caseRoot(label);
  const repository = join(root, "repo");
  initRepository(repository);

  const databasePath = join(root, "production.sqlite3");
  const workspace = join(root, "worktree");
  const artifactRoot = join(root, "artifacts");
  const stateRoot = join(root, "state");
  const destinationDir = join(root, "destination");

  const out: string[] = [];
  const err: string[] = [];
  // The two setup verbs write through their own records, so their lines are
  // captured here rather than reaching the runner's stdout -- and capturing
  // them is also what makes the exit-code assertions below diagnosable when one
  // of them refuses.
  patchSeams(dbCliSeams, {
    write: (text: string) => {
      out.push(text);
    },
    writeError: (text: string) => {
      err.push(text);
    },
  });
  patchSeams(runCliSeams, {
    write: (text: string) => {
      out.push(text);
    },
    writeError: (text: string) => {
      err.push(text);
    },
  });
  patchSeams(lapCliSeams, {
    nowMs: () => T0,
    write: (text: string) => {
      out.push(text);
    },
    writeError: (text: string) => {
      err.push(text);
    },
  });

  // The fake worker, and the one thing it is told to say. Without a body the
  // real CLI's `result` line carries none either, and the provider reports the
  // turn as a definite nothing -- which is the refusal case further down.
  const command = fakeCli(root);
  fakeEnv("FAKE_RESULT_TEXT", REPORT_TEXT);

  expect(main(["db", "create", "--db", databasePath, "--now-ms", String(T0)])).toBe(0);
  expect(
    main([
      "run",
      "admit",
      "--db",
      databasePath,
      "--run-id",
      runId,
      "--lease-claimant-id",
      HOLDER,
      "--workspace",
      spellWorkspace(workspace),
      "--role",
      ROLE,
      "--base-branch",
      BASE_BRANCH,
      "--topic-branch",
      TOPIC_BRANCH,
      "--prompt",
      "do the work",
      "--now-ms",
      String(T0),
    ]),
  ).toBe(0);

  const flags: Record<string, string> = {
    "--db": databasePath,
    "--run-id": runId,
    "--repository": repository,
    "--artifact-root": artifactRoot,
    "--state-root": stateRoot,
    "--endpoint-recipient": NOTIFY_RECIPIENT,
    "--endpoint-destination-dir": destinationDir,
    // A path rather than the built module: nothing here starts an endpoint, and
    // what is under test is the configuration the worker is handed.
    "--endpoint-module": join(root, "endpoint.js"),
    "--node": process.execPath,
    "--interlock-root": root,
    "--claude-org-path": join(root, "claude-org"),
    // Short, because the fake child writes its terminal line immediately and a
    // second of dead time per case is a second nobody gets back.
    "--poll-interval-ms": "10",
    "--turn-timeout-ms": "60000",
    "--git-timeout-ms": "60000",
  };

  return {
    root,
    repository,
    databasePath,
    workspace,
    artifactDir: join(artifactRoot, runId),
    stateRoot,
    destinationDir,
    out,
    err,
    argv(overrides = {}) {
      const argv = ["lap", "perform"];
      for (const [flag, value] of Object.entries({ ...flags, ...overrides })) {
        argv.push(flag, value);
      }
      // The command prefix, repeated: the provider takes a prefix so a test can
      // supply `[execPath, script]` without pretending a script is directly
      // executable on every platform.
      for (const token of command) {
        argv.push("--claude-command", token);
      }
      return argv;
    },
    perform(overrides = {}) {
      return mainAsync(this.argv(overrides));
    },
  };
}

/** The control plane, opened for inspection and closed when the case ends. */
function inspect(path: string): SqliteDatabase {
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

function eventTypes(connection: SqliteDatabase): string[] {
  return (
    connection.prepare("SELECT event_type FROM event ORDER BY seq").all() as {
      event_type: string;
    }[]
  ).map((row) => row.event_type);
}

// --------------------------------------------------------------------------

describe("the acceptance: a lap from CLI verbs alone", () => {
  test("admit, perform, and a human is now being asked something", async () => {
    const f = lap("lap-e2e");

    expect(await f.perform(), f.err.join("")).toBe(0);

    // 1. The workspace is a real checkout of the topic branch, cut from the
    //    base branch that admission fixed.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
    const branch = runGitChecked(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: f.workspace,
      timeoutMs: 60_000,
    }).stdout;
    expect(branch).toBe(TOPIC_BRANCH);

    // 2. The artifacts are outside it, in the directory D-0061 derives.
    for (const name of [FENCE_FILENAME, SETTINGS_FILENAME, MCP_CONFIG_FILENAME]) {
      expect(existsSync(join(f.artifactDir, name)), name).toBe(true);
    }
    expect(existsSync(join(f.workspace, FENCE_FILENAME))).toBe(false);

    // 3. The spine carries the whole lap, in order.
    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).toEqual([
      "run_created",
      RUN_DELEGATION_RECORDED_EVENT_TYPE,
      WORKSPACE_MATERIALIZED_EVENT_TYPE,
      WORKER_ESCALATION_EVENT_TYPE,
    ]);

    // 4. A gate stands over the escalation, and it carries the worker's own
    //    words. This is the property section 2 calls the largest correctness
    //    gain available and describes as "currently unreachable".
    const gate = connection
      .prepare("SELECT gate_id, gate_type, stage, rationale, origin_event_seq FROM gate")
      .all() as {
      gate_id: string;
      gate_type: string;
      stage: string;
      rationale: string;
      origin_event_seq: number;
    }[];
    expect(gate).toHaveLength(1);
    expect(gate[0]?.gate_type).toBe(WORKER_ESCALATION_GATE_TYPE);
    expect(gate[0]?.stage).toBe("received");
    expect(gate[0]?.rationale).toContain(REPORT_TEXT);

    const escalation = connection
      .prepare("SELECT seq FROM event WHERE event_type = :type")
      .get({ type: WORKER_ESCALATION_EVENT_TYPE }) as { seq: number };
    expect(gate[0]?.origin_event_seq).toBe(escalation.seq);

    // 5. The one line an operator reads names the gate they now have to answer.
    expect(f.out.join("")).toContain(gate[0]?.gate_id ?? "");
    expect(f.err.join("")).toBe("");
  });

  test("the child was started under the fence that was admitted", async () => {
    // The property section 4.5 says the whole step exists for: "if the lap
    // spawns through the provider directly, the worker's fence was never
    // admitted ... and the human gate becomes advisory". A lap that materialised
    // a fence and then spawned around it would pass every assertion in the case
    // above, so this one reads the child's own recorded argv and the admission
    // ledger.
    const f = lap("lap-fenced");
    expect(await f.perform(), f.err.join("")).toBe(0);

    // The ledger says a fence was admitted, and `execute` spends the admission
    // exactly once.
    const ledger = readFileSync(join(f.artifactDir, FENCE_LEDGER_FILENAME), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const admitted = ledger.filter((entry) => entry["event"] === EVENT_ADMITTED);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.["settings_path"]).toBe(join(f.artifactDir, SETTINGS_FILENAME));

    // And the child was actually launched with it. `record.json` is the
    // provider's durable record of the argv it spawned, so this is the child's
    // own command line rather than a restatement of the plan.
    const record = JSON.parse(readFileSync(recordPath(f.stateRoot), "utf8")) as {
      argv: string[];
      workspace: string;
    };
    const settingsIndex = record.argv.indexOf("--settings");
    expect(settingsIndex, JSON.stringify(record.argv)).toBeGreaterThanOrEqual(0);
    expect(record.argv[settingsIndex + 1]).toBe(join(f.artifactDir, SETTINGS_FILENAME));
    expect(record.argv).toContain("--permission-mode");
    expect(record.argv).toContain("--mcp-config");
    // The child's cwd is the worktree git made, not a directory the provider
    // created for it.
    expect(record.workspace).toBe(f.workspace);
  });
});

describe("the help text and the implementation say the same thing", () => {
  // The tripwire that was missing. `--turn-timeout-ms`'s help described the
  // child as left running for a whole round after `performLap` started stopping
  // it, and nothing caught it: `verify` type-checks and runs cases, and neither
  // reads a help string against the behaviour it describes. These two cases are
  // the same claim asserted from both sides, so the pair fails when either
  // moves.
  const timeoutHelp = (): string => {
    const help = helpStrings(buildParser()).join("\n");
    const marker = "milliseconds to wait for the turn's terminal report";
    const at = help.indexOf(marker);
    expect(
      at,
      "the --turn-timeout-ms help is no longer findable by its opening words",
    ).toBeGreaterThanOrEqual(0);
    return help.slice(at, at + 400);
  };

  test("--help says the session is stopped and the workspace kept", () => {
    const text = timeoutHelp();
    expect(text).toContain("stopped");
    expect(text).toContain("workspace and the fence are left as they are");
  });

  test("the refusal an operator actually receives says the same", async () => {
    const f = lap("lap-timeout-wording");
    patchSeams(lapCliSeams, { nowMs: () => Date.now() });
    fakeMode("events-then-hang");
    fakeEnv("FAKE_SLEEP", "120");

    expect(await f.perform({ "--turn-timeout-ms": "300", "--poll-interval-ms": "50" })).toBe(2);
    const written = f.err.join("");
    expect(written).toContain("did not finish its turn");
    expect(written).toContain("session is stopped");
    expect(written).toContain("workspace and the fence are left exactly as they are");
  });
});

describe("continuo#122: one rule for the endpoint destination directory", () => {
  // The rule is `KeyedDropbox`'s, because the dropbox is what owns the
  // directory: it opens the path with `mkdir -p` and deduplicates per
  // idempotency key, and a writer that has been superseded is refused by the
  // fencing watermark kept beside the effects rather than by the directory's
  // absence. Materialisation used to refuse an existing one anyway -- the
  // dropbox rode along on the list of paths this step *creates* -- which made
  // the one dropbox an operator polls unusable for the next lap pointed at it
  // and contradicted `gate deliver`'s help about the same directory (D-0085).
  test("perform accepts a dropbox that already exists, and leaves what is in it", async () => {
    const f = lap("lap-destination-exists");
    mkdirSync(f.destinationDir, { recursive: true });
    // An earlier lap's effect, spelled as a file this run has no reason to
    // touch. Its survival is the half that says "reused" rather than "emptied".
    const earlier = join(f.destinationDir, "earlier.effect.json");
    writeFileSync(earlier, '{"idempotency_key":"earlier"}\n', "utf8");

    expect(await f.perform(), f.err.join("")).toBe(0);

    expect(readFileSync(earlier, "utf8")).toBe('{"idempotency_key":"earlier"}\n');
    // And the run really did materialise, so the case is not green because the
    // lap stopped somewhere before the check that used to refuse.
    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).toContain(WORKSPACE_MATERIALIZED_EVENT_TYPE);
    // The artifacts this step *does* create keep the old rule, which is the
    // anti-vacuity half: the refusal was narrowed, not deleted.
    expect(existsSync(join(f.artifactDir, FENCE_FILENAME))).toBe(true);
  });

  test("--help states the rule, in the words gate deliver's help uses", () => {
    const help = helpStrings(buildParser()).join("\n");
    const at = help.indexOf("directory the endpoint's delivery files are written into");
    expect(at, "the --endpoint-destination-dir help is no longer findable").toBeGreaterThanOrEqual(
      0,
    );
    const text = help.slice(at, at + 600);
    expect(text).toContain("Created if it does not exist, and reused if it does");
    expect(text).toContain("one dropbox per control plane");
    // The two verbs are named in each other's help on purpose: #122 is a
    // contradiction an operator hit by reading them side by side.
    expect(text).toContain("gate deliver --destination-dir");
  });
});

describe("D-0065: an expired deadline costs the deadline, never the report", () => {
  test("the gate opens without it, and the operator is told which one lapsed", async () => {
    // The worker's turn outrunning the operator's deadline used to be fatal in
    // the worst possible place: `gate.deadline_at_ms > created_at_ms` is a DDL
    // CHECK, so the ingest raised a raw SQLite error AFTER the whole lap had
    // run -- and because the event and the gate are one transaction, the
    // worker's report rolled back with it. Everything was done and nothing was
    // recorded, on a run that could not be materialised again.
    //
    // The clock has to MOVE for this state to exist at all: the deadline must
    // be in the future when the lap starts (or the prologue refuses it up
    // front, which is the case above) and in the past when the gate is created.
    // So the fixture's frozen clock is replaced by one that jumps exactly once,
    // on its first read -- deterministic, and it puts the whole of the lap on
    // the far side of the deadline without depending on how long anything took.
    const f = lap("lap-deadline-lapsed");
    let reads = 0;
    patchSeams(lapCliSeams, {
      nowMs: () => {
        reads += 1;
        return reads === 1 ? T0 : T0 + 10_000;
      },
    });
    const deadline = T0 + 5_000;

    expect(await f.perform({ "--gate-deadline-at-ms": String(deadline) }), f.err.join("")).toBe(0);

    const connection = inspect(f.databasePath);
    const gate = connection.prepare("SELECT gate_id, deadline_at_ms FROM gate").all() as {
      gate_id: string;
      deadline_at_ms: number | null;
    }[];
    // The gate exists -- which is the whole point -- and carries no deadline.
    expect(gate).toHaveLength(1);
    expect(gate[0]?.deadline_at_ms).toBeNull();
    // And the report reached the spine rather than rolling back with it.
    expect(eventTypes(connection)).toContain(WORKER_ESCALATION_EVENT_TYPE);

    // The operator is told, and told WHICH deadline, so they can tell "my
    // deadline was too tight" from "the worker ran long".
    const written = f.out.join("");
    expect(written).toContain(String(deadline));
    expect(written).toContain("opened without one");
  });

  test("a deadline the lap does honour is written through unchanged", async () => {
    // The anti-vacuity half: without it, an implementation that dropped every
    // deadline would satisfy the case above.
    const f = lap("lap-deadline-kept");
    const future = T0 + 3_600_000;
    expect(await f.perform({ "--gate-deadline-at-ms": String(future) }), f.err.join("")).toBe(0);

    const connection = inspect(f.databasePath);
    const gate = connection.prepare("SELECT deadline_at_ms FROM gate").get() as {
      deadline_at_ms: number | null;
    };
    expect(gate.deadline_at_ms).toBe(future);
    expect(f.out.join("")).not.toContain("opened without one");
  });
});

describe("what the verb refuses, and what it leaves behind", () => {
  test("a run that was never admitted is a refusal, not a stack trace", async () => {
    const f = lap("lap-unadmitted");
    expect(await f.perform({ "--run-id": "no-such-run" })).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);
    expect(f.err.join("")).toContain("run_delegation_recorded");
    // Nothing was built for a run that does not exist.
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("continuo#121: --help lists the recipients the outbox actually serves", () => {
    // `helpStrings` walks `spec.help` only; the served values render in
    // `--endpoint-recipient`'s `{a,b}` metavar instead (`#metavar`, driven by
    // `choices`), which is part of `usage()`/`help()` and not of that walk. So
    // this reads the same rendering `--help` on a real console does.
    const out: string[] = [];
    const status = dispatch(buildParser(), ["lap", "perform", "--help"], {
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
    });
    expect(status).toBe(0);
    const help = out.join("");
    expect(help).toContain(NOTIFY_RECIPIENT);
    expect(help).toContain(HUMAN_GATED_RECIPIENT);
  });

  test("continuo#121: an unknown --endpoint-recipient is refused before admission is even read", () => {
    const f = lap("lap-unknown-recipient");
    // `main`, not `f.perform`: an unrecognised choice is a parser refusal
    // (`ArgparseExit`) raised by `dispatch` itself, before the handler --
    // and therefore before the lap -- ever runs, so it never reaches the
    // "asynchronous verb" guard the synchronous-dispatch case above exists
    // to exercise. `main` catches it and returns its code rather than
    // throwing, exactly as it does for `--help`.
    expect(main(f.argv({ "--endpoint-recipient": "bogus-recipient" }))).toBe(2);
    expect(existsSync(f.workspace)).toBe(false);
    expect(existsSync(f.artifactDir)).toBe(false);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKSPACE_MATERIALIZED_EVENT_TYPE);
  });

  test("a turn that said nothing opens no gate", async () => {
    // `D-0060`'s other half: a `result` line with no body is a finished turn
    // with nothing to escalate, and polling will not change it. Without the
    // refusal the lap would spend its whole budget and report a timeout, which
    // names the wrong problem to the operator.
    const f = lap("lap-silent");
    fakeEnv("FAKE_RESULT_TEXT", "");

    expect(await f.perform()).toBe(2);
    expect(f.err.join("")).toContain("without a report to escalate");

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
    // The workspace and the fence are left exactly as they were: the refusal is
    // about the turn, and rolling back a checkout the worker may have written
    // into would destroy the evidence of what it did.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
    expect(existsSync(join(f.artifactDir, FENCE_FILENAME))).toBe(true);
  });

  test("a synchronous dispatch refuses before the lap has begun", () => {
    // `main` cannot settle a promise, and this verb's handler does its work
    // before returning one -- it materialises a worktree, publishes a fence and
    // starts a child. So the shape has to be discovered from the parser's own
    // declaration and refused BEFORE the handler is called; discovering it from
    // the returned value would mean discovering it after a child was running
    // that nobody was going to observe.
    const f = lap("lap-sync-dispatch");
    expect(() => main(f.argv())).toThrow(/asynchronous/);
    expect(existsSync(f.workspace)).toBe(false);
    expect(existsSync(f.artifactDir)).toBe(false);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKSPACE_MATERIALIZED_EVENT_TYPE);
  });

  test("a run someone else holds the lease on is a refusal, not a stack trace", async () => {
    // `SessionOrchestrator.start()` takes the run's lease and raises `LeaseHeld`
    // -- a `LeaseRefusal`, which is neither a `ControlPlaneRefusal` nor one of
    // `src/workspace/`'s. So does `OrchestrationRefused` when the walk stops for
    // its own reasons. Both are ordinary outcomes of a command an operator
    // typed, and without them on this verb's classification the operator gets an
    // unhandled stack trace and exit 1 where every other verb gives one line and
    // exit 2.
    const f = lap("lap-lease-held");
    const held = openProductionControlPlane(f.databasePath);
    onTestFinished(() => {
      held.close();
    });
    acquireLease(held, {
      resource: `session-run:${RUN_ID}`,
      holder: "someone-else",
      nowMs: T0,
      ttlMs: 600_000,
    });

    expect(await f.perform()).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
  });

  test("an unadmitted run id cannot forge a second line of output", async () => {
    // This refusal path is the only one in the module that names an identifier
    // nothing has validated: it fires precisely because the id matched no row,
    // so `LapRunIntent`'s printable-ASCII rule never saw it. A raw
    // interpolation would let `--run-id $'x\nerror: approved'` write a second
    // line that reads like continuo's own.
    const f = lap("lap-forged-line");
    expect(await f.perform({ "--run-id": "x\nerror: approved" })).toBe(2);
    const written = f.err.join("");
    // One line, and the newline is escaped inside the quoted value rather than
    // ending it.
    expect(written.trimEnd().split("\n")).toHaveLength(1);
    expect(written).toContain("\\n");
  });

  test("a timed-out turn refuses and the verb still returns", async () => {
    // The bound has to be a bound. The provider holds a referenced child
    // handle, so a lap that printed a timeout and left the child running would
    // keep this process's event loop alive and the command would not exit until
    // the child felt like it -- a `--turn-timeout-ms` in the help text and
    // nowhere else. `performLap` stops the session on every path out for that
    // reason, and this case is green only if the verb actually returns.
    const f = lap("lap-timeout");
    // A real clock, replacing the fixture's frozen one: a budget is measured
    // against a clock that moves, and every other case wants a fixed instant.
    patchSeams(lapCliSeams, { nowMs: () => Date.now() });
    // A child that emits its events and then hangs for far longer than the
    // budget: there is no terminal line to read, so the poll runs out of time
    // rather than finding anything, and the child is still alive when it does.
    fakeMode("events-then-hang");
    fakeEnv("FAKE_SLEEP", "120");

    expect(await f.perform({ "--turn-timeout-ms": "300", "--poll-interval-ms": "50" })).toBe(2);
    expect(f.err.join("")).toContain("did not finish its turn within 300ms");

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    // The workspace and the fence stay: the refusal is about the turn, and
    // deleting a checkout the worker may have written into is not a rollback.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
  });

  test("a walk that fails after spawning still stops its child", async () => {
    // `orchestrator.start()` can spawn and then reject -- the identity never
    // reads back, the post-spawn validation refuses -- and the provider says in
    // as many words that a Failure does not prove no process was created. The
    // session id lives inside that rejected call, so a teardown that read it off
    // the outcome would have no outcome to read and would leave a fenced worker
    // running with its handle holding this process open. The child here would
    // sleep two minutes; the case is green only because the verb returns.
    const f = lap("lap-walk-fails");
    fakeMode("events-then-hang");
    fakeEnv("FAKE_SLEEP", "120");
    // The child never names itself, so the identity cannot be read back and the
    // walk refuses after the spawn rather than before it.
    fakeEnv("FAKE_OMIT_IDENTITY", "1");

    // **The read-back window this case asks for, and the assertion that the
    // flag reached the orchestrator** (`D-0098`). The default window is thirty
    // seconds -- deliberately, because a real `claude` needs up to 11.3 s to
    // its first event -- and this child is never going to name itself, so
    // taking the default here would buy half a minute of polling for a
    // conclusion known at the first ask. The refusal quoting the number is the
    // evidence: `--identity-readback-timeout-ms` is the only thing on this
    // command line that can put it in that sentence, so a build where the flag
    // stopped short of the orchestrator fails here -- slowly, which is itself
    // the symptom.
    expect(await f.perform({ "--identity-readback-timeout-ms": "150" })).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);
    expect(f.err.join("")).toContain("within the 150 ms identity read-back budget");

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
  });

  test("a read-back window below a millisecond is a refusal, and costs no worktree", async () => {
    // The same family as `--turn-timeout-ms: -1` below: the parser types this
    // flag as an integer, so `0` and `-1` are values an operator can type, and
    // the orchestrator would meet them as a `RangeError` -- a stack trace and
    // exit 1 where every other flag in this verb gives one line and exit 2.
    // `performLap` refuses it before the intent is even read, which is what
    // makes the second half of this case true.
    const f = lap("lap-zero-readback");
    expect(await f.perform({ "--identity-readback-timeout-ms": "0" })).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);
    expect(f.err.join("")).toContain("identity_readback_timeout_ms");
    // Nothing was built: a mistyped window must not spend the run identifier,
    // because `D-0057` refuses a second materialisation of one run.
    expect(existsSync(f.workspace)).toBe(false);
    expect(existsSync(f.artifactDir)).toBe(false);
  });

  test("an operator's own bad values are refusals, not stack traces", async () => {
    // The parser types `--turn-timeout-ms` as an integer, which admits `-1`, and
    // `--artifact-root` as a string, which admits a relative path. Both reach a
    // *usage error* class at runtime -- `LapUsageError` and
    // `WorkspaceMaterializationUsageError` -- and the reflex is to leave those
    // uncaught because a usage error is a defect in a caller. Here the caller is
    // the operator, so leaving them out means a typo arrives as a stack trace and
    // exit 1 where every other verb in this CLI gives one line and exit 2.
    const negative = lap("lap-negative-timeout");
    expect(await negative.perform({ "--turn-timeout-ms": "-1" })).toBe(2);
    expect(negative.err.join("")).toMatch(/^error: /);
    expect(negative.err.join("")).toContain("timeout_ms");
    // **And nothing was built.** This half was missing when this case was first
    // written, which meant it pinned the exit code while quietly accepting that
    // a typo materialised a worktree, published a fence and started a child --
    // and `D-0057` refuses a second materialisation of one run, so that typo
    // cost the run identifier itself. Asserting the exit code alone is what
    // made the bad behaviour look settled.
    expect(existsSync(negative.workspace)).toBe(false);
    expect(existsSync(negative.artifactDir)).toBe(false);

    const relative = lap("lap-relative-artifacts");
    expect(await relative.perform({ "--artifact-root": "relative/dir" })).toBe(2);
    expect(relative.err.join("")).toMatch(/^error: /);
    // Refused before anything is created: a malformed request costs no worktree.
    expect(existsSync(relative.workspace)).toBe(false);
  });

  test("a gate deadline already in the past is refused before anything is built", async () => {
    // A stale value pasted from an earlier command, or a mistyped digit. The
    // operator hears about it while a corrected retry is still free -- which it
    // only is if nothing has been materialised yet.
    const f = lap("lap-stale-deadline");
    expect(await f.perform({ "--gate-deadline-at-ms": String(T0 - 1) })).toBe(2);
    expect(f.err.join("")).toContain("already in the past");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a worker that called its own turn a failure opens no gate", async () => {
    // `D-0056` decides that a turn marked `is_error` is an execution failure and
    // not an escalation, so the ingress refuses it and no gate is opened. The
    // behaviour was already right -- `ReportIngressUsageError` is a
    // `ControlPlaneRefusal`, so it reaches the operator as one line and exit 2
    // rather than as a stack trace -- and it had no case, which is how a review
    // came to read it as a defect. This is that case: what is pinned is that the
    // classification holds through the whole lap, not merely that the class
    // extends the right base.
    const f = lap("lap-worker-failed");
    fakeEnv("FAKE_IS_ERROR", "1");

    expect(await f.perform()).toBe(2);
    const written = f.err.join("");
    expect(written).toMatch(/^error: /);
    expect(written).toContain("is marked is_error");
    expect(written).toContain("no gate is opened");
    // One line, not a stack: a stack trace would arrive over several.
    expect(written.trimEnd().split("\n")).toHaveLength(1);

    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKER_ESCALATION_EVENT_TYPE);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
    // The workspace and the fence stay: the worker's failure is evidence, and
    // deleting the checkout it failed in would destroy it.
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
  });

  test("a worker CLI that will not start is a refusal, not a stack trace", async () => {
    // `SessionProvider.start` runs the spawn precondition before anything is
    // spawned, and raises `SpawnRefused` when the CLI is absent, its capability
    // probe fails, or it lacks a flag the fence needs. The commonest of those --
    // `claude` not installed -- was arriving as an unhandled stack trace and
    // exit 1, after the worktree had already been materialised, where every
    // other verb in this CLI gives one line and exit 2.
    const f = lap("lap-no-cli");
    expect(await f.perform({ "--claude-command": join(f.root, "not-a-real-cli") })).toBe(2);
    const written = f.err.join("");
    expect(written).toMatch(/^error: /);
    // One line, not a stack.
    expect(written.trimEnd().split("\n")).toHaveLength(1);

    // **And nothing was built.** Classifying the refusal was only half of it:
    // the capability check used to run inside `orchestrator.start()`, so
    // `claude` not being installed cost a branch, a worktree and a
    // `workspace_materialized` event -- and `D-0057` refuses a second
    // materialisation, so fixing PATH did not make the run retryable. The
    // preflight asks the provider before any of that exists.
    expect(existsSync(f.workspace)).toBe(false);
    const connection = inspect(f.databasePath);
    expect(eventTypes(connection)).not.toContain(WORKSPACE_MATERIALIZED_EVENT_TYPE);
    expect(connection.prepare("SELECT count(*) AS n FROM gate").get()).toEqual({ n: 0 });
  });

  test("a provider state root inside the worktree is refused before anything is built", async () => {
    // `D-0067`, for the one path this PR introduces that the materialiser never
    // sees. The transcript is the evidence `readTerminalReport` turns into a
    // gate, so a state root inside the worktree is a gate opened over words its
    // own subject wrote. The remaining warded paths are all
    // `MaterializationRequest` fields and are branch B's.
    const f = lap("lap-state-root-inside");
    expect(await f.perform({ "--state-root": join(f.workspace, "state") })).toBe(2);
    expect(f.err.join("")).toContain("the provider's state root");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("an un-normalised admitted workspace does not open the containment guard", async () => {
    // The predicate is shared with the materialiser (`isInside`), and sharing it
    // is not enough on its own: it is LEXICAL, so it answers about whatever
    // spelling of the root it is handed. `materializeWorkspace` normalises its
    // own workspace before asking; this side receives `intent.workspace` exactly
    // as an operator typed it at admission, and `LapRunIntent` deliberately does
    // not normalise -- being resolvable is all it checks.
    //
    // So `<root>/worktree/../worktree` is a fully qualified path that admission
    // accepts, that the materialiser checks out at `<root>/worktree`, and that a
    // prefix comparison finds no `<root>/worktree/...` path inside. Without the
    // `resolve` at the top of the guard, the command below is accepted and the
    // binary the fence is applied to is a file in the checkout the worker may
    // rewrite: one rule, one predicate, and two spellings of its argument.
    const f = lap(
      "lap-workspace-unnormalised",
      RUN_ID,
      // Concatenated rather than `join`ed: `join` would normalise it away.
      (workspace) => `${workspace}${sep}..${sep}${basename(workspace)}`,
    );
    expect(await f.perform({ "--claude-command": join(f.workspace, "tool") })).toBe(2);
    expect(f.err.join("")).toContain("worker command");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a relative worker command that would resolve inside the worktree is refused", async () => {
    // The command is spawned with the WORKSPACE as its working directory, so a
    // relative token resolves there -- `./tool` looks safe from the operator's
    // shell and is `<workspace>/tool` when it runs. Each warded path is resolved
    // the way its own consumer resolves it, and this is the case that says the
    // command's consumer is not this process.
    const f = lap("lap-relative-command");
    expect(await f.perform({ "--claude-command": "./tool" })).toBe(2);
    expect(f.err.join("")).toContain("worker command");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a state root that is not a writable directory is refused up front", async () => {
    // The capability probe will not catch this: it writes `probe-evidence.txt`
    // into the state root and treats a failed write as a degraded record rather
    // than an incompatible CLI -- correctly, since an unwritable directory says
    // nothing about the CLI. So `requireSpawnable()` succeeds and the failure
    // surfaces from the session directory's own `mkdirSync`, after the branch,
    // the worktree and `workspace_materialized` exist, on a run `D-0057` will
    // not let anyone materialise again. An operator typo costing a run.
    const f = lap("state-root-not-a-dir");
    const file = join(f.root, "not-a-directory");
    writeFileSync(file, "", "utf8");

    expect(await f.perform({ "--state-root": file })).toBe(2);
    expect(f.err.join("")).toContain("not a writable directory");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a relative worker command is refused", async () => {
    // `D-0067`: every token of the worker command must be an absolute path.
    // Three earlier attempts tried to decide safely which relative spellings
    // were harmless -- a token with no separator, then a PATH without a relative
    // entry -- and each was defeated by a resolution rule this repository does
    // not own: an empty PATH element means the current directory on POSIX, and a
    // command given as interpreter plus script has a second token no check of
    // the first one sees. Requiring absolute removes resolution from the path
    // instead of trying to reason about it.
    const f = lap("warded-relative-command");
    expect(await f.perform({ "--claude-command": "./tool" })).toBe(2);
    expect(f.err.join("")).toContain("not a fully qualified path");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("every token is checked, not just the first", async () => {
    // The interpreter-plus-script form. `worker.mjs` has no separator in it, so
    // every earlier version of this rule let it through -- and the interpreter
    // resolves it against ITS working directory, which is the worktree.
    const f = lap("warded-second-token");
    const argv = f.argv();
    argv.push("--claude-command", "worker.mjs");
    expect(await mainAsync(argv)).toBe(2);
    expect(f.err.join("")).toContain("token 2");
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a second perform of one run is refused rather than re-run", async () => {
    // The materialiser refuses a run it has already materialised (`D-0057`),
    // and this is the case that says the CLI surfaces that as a refusal rather
    // than as an unhandled error -- and that it does not start a second child
    // under a fence the first lap already spent.
    const f = lap("lap-twice");
    expect(await f.perform(), f.err.join("")).toBe(0);
    f.err.length = 0;

    expect(await f.perform()).toBe(2);
    expect(f.err.join("")).toMatch(/^error: /);

    const connection = inspect(f.databasePath);
    expect(
      eventTypes(connection).filter((type) => type === WORKSPACE_MATERIALIZED_EVENT_TYPE),
    ).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------

/** The pinned shape identifier every document this verb writes carries. */
const PERFORM_SCHEMA = "continuo.lap.perform/1";

/**
 * The one document a `--json` run wrote, parsed.
 *
 * The line count is asserted rather than assumed: this verb's human report is a
 * success line plus up to two conditional `note:` lines, and the whole claim of
 * the JSON path is that all three become ONE document. A half-converted report
 * -- the document plus a human note beside it -- is exactly what a host reading
 * with a line reader would choke on, and it is what this catches.
 */
function oneDocument(written: readonly string[]): Record<string, unknown> {
  const text = written.join("");
  expect(
    text.endsWith("\n"),
    "the document must end in exactly one newline: a host reads it a line at a time",
  ).toBe(true);
  expect(
    text.trimEnd().split("\n"),
    "a --json run writes ONE document; a second line means part of the report stayed human",
  ).toHaveLength(1);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Does this text look like one of the documents, rather than like a human line?
 *
 * Deliberately weak -- it asks only "does this parse as a JSON object" -- because
 * its job is to separate the two SPELLINGS, and a stronger predicate would start
 * restating the assertions the cases make about the document's contents.
 */
function looksLikeDocument(text: string): boolean {
  if (!text.startsWith("{")) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The facts the spine holds about a finished lap, read back independently. */
function spineFacts(databasePath: string): {
  readonly baseCommit: string;
  readonly sessionId: string;
  readonly gateId: string;
  readonly eventId: string;
  readonly eventSeq: number;
} {
  const connection = inspect(databasePath);
  const escalation = connection
    .prepare("SELECT event_id, seq FROM event WHERE event_type = :type")
    .get({ type: WORKER_ESCALATION_EVENT_TYPE }) as { event_id: string; seq: number };
  const materialized = connection
    .prepare("SELECT payload FROM event WHERE event_type = :type")
    .get({ type: WORKSPACE_MATERIALIZED_EVENT_TYPE }) as { payload: string };
  const gate = connection.prepare("SELECT gate_id FROM gate").get() as { gate_id: string };
  const session = connection.prepare("SELECT session_id FROM session").get() as {
    session_id: string;
  };
  return {
    baseCommit: (JSON.parse(materialized.payload) as { base_commit: string }).base_commit,
    sessionId: session.session_id,
    gateId: gate.gate_id,
    eventId: escalation.event_id,
    eventSeq: escalation.seq,
  };
}

/** `lap perform --json`, as a host drives it. */
function jsonArgv(f: Lap, overrides: Readonly<Record<string, string>> = {}): string[] {
  const argv = f.argv(overrides);
  // Pushed rather than passed through `argv(overrides)`: `--json` is a
  // `storeTrue` flag and the override map is flag-to-value pairs, so spelling it
  // there would put a positional value after it.
  argv.push("--json");
  return argv;
}

describe("D-0090: the host seam, continuo lap perform --json", () => {
  test("a clean lap answers a host with one document, and this is that document", async () => {
    // Without this, nothing pins the document a host parses: a key could be
    // renamed, dropped or added by an unrelated edit and every behavioural case
    // in this file would stay green, because none of them reads the JSON path at
    // all. `toStrictEqual` over the WHOLE object is what makes an extra key a
    // failure rather than a silent widening of the contract.
    const f = lap("lap-json-clean");
    // The two setup verbs wrote their own lines into these arrays; what is
    // under test is what `lap perform` writes, so the slate is cleared here.
    f.out.length = 0;
    f.err.length = 0;

    expect(await mainAsync(jsonArgv(f)), f.err.join("")).toBe(0);
    expect(
      f.err.join(""),
      "a successful --json run writes nothing to stderr: exit 0 means the host parses stdout",
    ).toBe("");

    // Every value is read back off the spine and off the fixture rather than
    // off the line that produced it, so the document is checked against the
    // facts and not against itself.
    const facts = spineFacts(f.databasePath);
    expect(
      oneDocument(f.out),
      "the document a host parses changed shape; if that was deliberate the schema id owes a /2",
    ).toStrictEqual({
      schema: PERFORM_SCHEMA,
      ok: true,
      db: f.databasePath,
      run_id: RUN_ID,
      workspace: f.workspace,
      topic_branch: TOPIC_BRANCH,
      base_commit: facts.baseCommit,
      session_id: facts.sessionId,
      // The walk's own name for the road it took, which is what the human line
      // prints beside the session id too -- not a filesystem path.
      session_path: "started",
      gate_id: facts.gateId,
      event_id: facts.eventId,
      event_seq: facts.eventSeq,
      // Both conditionals present and null: this lap was clean, and a host must
      // not have to tell an absent key from a null one to learn that.
      endpoint_lease_failure: null,
      elapsed_deadline_at_ms: null,
      // Present and null for the same reason, and saying a different thing from
      // either of them (`D-0099`): this lap named no model, so what it ran on
      // was the worker CLI's own default and this build does not know which one
      // that was. A host accounting for what a lap cost reads the choice here.
      model: null,
    });
  });

  test("the two conditional keys carry values when the lap was not clean", async () => {
    // Without this, the document would be pinned only in the shape where both
    // conditionals are null -- and an implementation that hardcoded `null` for
    // both, or that omitted the keys whenever there was something to say, would
    // pass the case above while being permanently broken for exactly the laps a
    // host most needs to hear about.
    //
    // Both conditions are provoked in ONE lap because they are independent: the
    // deadline is decided at the ingest and the lease failure at a renewal, and
    // a lap that carries both is the one the human path prints two `note:` lines
    // for.
    const f = lap("lap-json-notes", "run-json-notes");
    const deadline = T0 + 5_000;
    const stealer = inspect(f.databasePath);
    let reads = 0;
    patchSeams(lapCliSeams, {
      // The deadline must be in the future when the lap starts -- or it is
      // refused up front -- and in the past when the gate is created. This clock
      // jumps exactly once, on its first read, which is the acquisition of the
      // delivery lease; every later step is on the far side of the deadline
      // without depending on how long anything took.
      nowMs: () => {
        reads += 1;
        return reads === 1 ? T0 : T0 + 10_000;
      },
      // The delivery lease, expired under the lap while the walk holds it. The
      // seam is called by the orchestrator as it mints the session id, which is
      // after the materialisation renewal `performLap` requires to have
      // succeeded and before the one it makes by hand once the turn is over --
      // so the failure lands exactly where `D-0073` says it costs the lease and
      // never the report.
      //
      // Taken over rather than deleted or back-dated. The schema forbids
      // deleting a lease row (a deleted row lets the next acquisition restart
      // the epoch at 1) and CHECKs `expires_at_ms > acquired_at_ms`, so neither
      // of those spells the state. Raising the epoch under a new holder is the
      // state itself: `renew` matches on holder AND epoch, so the lap's token
      // stops matching the live row and the renewal is refused exactly as it
      // would be against a real second claimant. A second connection, because
      // the lap owns its own.
      sessionUuid: () => {
        stealer
          .prepare(
            "UPDATE lease SET holder = :holder, epoch = epoch + 1 WHERE resource = :resource",
          )
          .run({ holder: "someone-else", resource: DELIVERY_LEASE_RESOURCE });
        return randomUUID();
      },
    });
    f.out.length = 0;
    f.err.length = 0;

    expect(
      await mainAsync(jsonArgv(f, { "--gate-deadline-at-ms": String(deadline) })),
      f.err.join(""),
    ).toBe(0);

    const facts = spineFacts(f.databasePath);
    expect(oneDocument(f.out)).toStrictEqual({
      schema: PERFORM_SCHEMA,
      ok: true,
      db: f.databasePath,
      run_id: "run-json-notes",
      workspace: f.workspace,
      topic_branch: TOPIC_BRANCH,
      base_commit: facts.baseCommit,
      session_id: facts.sessionId,
      session_path: "started",
      gate_id: facts.gateId,
      event_id: facts.eventId,
      event_seq: facts.eventSeq,
      // The failure reduced to its message. An `Error` handed to a JSON encoder
      // serialises as whatever its enumerable fields are, which for an `Error`
      // is nothing at all -- so the object is built by hand from the one field
      // an operator acts on.
      endpoint_lease_failure: { message: expect.stringContaining(DELIVERY_LEASE_RESOURCE) },
      // The operator's own number, handed back so a host can tell "my deadline
      // was too tight" from "the worker ran long".
      elapsed_deadline_at_ms: deadline,
      model: null,
    });
  });

  test("a refusal is a document on stderr, and the exit code does not move", async () => {
    // The half a success-only pinning would miss twice over: a host that gets
    // exit 2 has to be able to parse the reason, and the flag must not have
    // changed WHICH code it gets. Both spellings of the same refusal are run
    // here so the codes are compared rather than merely asserted.
    const human = lap("lap-json-refusal-human");
    human.out.length = 0;
    human.err.length = 0;
    const humanStatus = await human.perform({ "--run-id": "no-such-run" });

    const document = lap("lap-json-refusal-document");
    document.out.length = 0;
    document.err.length = 0;
    const documentStatus = await mainAsync(jsonArgv(document, { "--run-id": "no-such-run" }));

    expect(humanStatus, "the refusal's exit code is the contract; --json may not move it").toBe(2);
    expect(documentStatus, "--json changed the exit code, which is a change of behaviour").toBe(
      humanStatus,
    );
    expect(
      document.out.join(""),
      "a refused --json run must leave stdout empty: exit 2 means the host parses stderr",
    ).toBe("");

    const refusal = oneDocument(document.err);
    expect(refusal["schema"]).toBe(PERFORM_SCHEMA);
    expect(refusal["ok"]).toBe(false);
    expect(refusal["db"]).toBe(document.databasePath);
    const error = refusal["error"] as Record<string, unknown>;
    // `class` is the refusal's own `name`, which is a hint and not a taxonomy:
    // what a host branches on is the exit code and the message.
    expect(typeof error["class"]).toBe("string");
    expect(String(error["message"])).toContain("run_delegation_recorded");
    // And the same fact reached the human spelling, so the two are two
    // renderings of one refusal rather than two refusals.
    expect(human.err.join("")).toMatch(/^error: /);
    expect(human.err.join("")).toContain("run_delegation_recorded");
  });
});

/**
 * Anti-vacuity: the `--json` cases above, observed over runs built to break them.
 *
 * `AGENTS.md`'s rule is that a check never seen red is not a check. Every case
 * above would stay green under an implementation that made JSON the only
 * spelling, that hardcoded the document, or that taught the flag to the success
 * path alone. Each case here names the hole it stands in front of and runs the
 * REAL verb through `mainAsync` over a real lap.
 */
describe("the --json contract, observed red", () => {
  test("without --json the report is the human line it has always been", async () => {
    // The hole: JSON as the new default. Every case above passes `--json`, so an
    // implementation that ignored the flag and always emitted the document would
    // satisfy all of them while breaking every operator and every existing
    // script -- and rule 2 of this change is that the human bytes do not move.
    const f = lap("lap-json-absent");
    f.out.length = 0;
    f.err.length = 0;

    expect(await f.perform(), f.err.join("")).toBe(0);

    const written = f.out.join("");
    expect(
      looksLikeDocument(written),
      "the human path emitted a JSON document: --json is not being read at all",
    ).toBe(false);
    expect(written).toMatch(/^performed /);
    expect(written).toContain(`performed ${pythonRepr(RUN_ID)}`);
    expect(written).toContain("worktree");
    expect(written).toContain(", gate ");
  });

  test("the payload follows the record rather than a literal", async () => {
    // The hole: a document assembled from constants. Every field of the case
    // above is compared against the spine of the SAME run, so a builder that
    // wrote the run id it was given and invented everything else would still be
    // caught -- but one that echoed a fixed identifier would not be, because
    // nothing there varies. Two laps that differ in exactly one input are what
    // make the difference observable.
    const first = lap("lap-json-varies-a", "run-json-varies-a");
    first.out.length = 0;
    expect(await mainAsync(jsonArgv(first)), first.err.join("")).toBe(0);
    const a = oneDocument(first.out);

    const second = lap("lap-json-varies-b", "run-json-varies-b");
    second.out.length = 0;
    expect(await mainAsync(jsonArgv(second)), second.err.join("")).toBe(0);
    const b = oneDocument(second.out);

    expect(a["run_id"]).toBe("run-json-varies-a");
    expect(b["run_id"], "the run id in the document is not the run the host asked for").toBe(
      "run-json-varies-b",
    );
    // And the fields the operator did NOT choose moved with the lap too: a
    // document whose gate and session came from anywhere but this run's record
    // would repeat here.
    expect(a["gate_id"]).not.toBe(b["gate_id"]);
    expect(a["session_id"]).not.toBe(b["session_id"]);
    expect(a["event_id"]).not.toBe(b["event_id"]);
    expect(a["workspace"]).not.toBe(b["workspace"]);
  });

  test("a second refusal family is a document too, not just the one that was tested", async () => {
    // The hole: `--json` taught at a call site instead of to `refuse()`. This
    // verb funnels six refusal families through one writer; a flag read on the
    // path somebody happened to test would leave the rest human, and every
    // success case would stay green. `--turn-timeout-ms -1` is a
    // `LapUsageError` -- a different family, raised from a different depth, than
    // the unadmitted run above -- and it must come out as the same document.
    const f = lap("lap-json-second-family");
    f.out.length = 0;
    f.err.length = 0;

    expect(await mainAsync(jsonArgv(f, { "--turn-timeout-ms": "-1" }))).toBe(2);
    expect(f.out.join(""), "a refused --json run must leave stdout empty").toBe("");

    const refusal = oneDocument(f.err);
    expect(refusal["ok"]).toBe(false);
    expect(refusal["schema"]).toBe(PERFORM_SCHEMA);
    expect(String((refusal["error"] as Record<string, unknown>)["message"])).toContain(
      "timeout_ms",
    );
    // Nothing was built, exactly as in the human spelling: `--json` changes the
    // bytes and never what the verb does.
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the predicate the cases above rest on tells the two spellings apart", async () => {
    // The vacuity check on the vacuity checks. `looksLikeDocument` returning
    // `false` for everything would make the human case pass over a document, and
    // returning `true` for everything would make it fail over a human line
    // nobody had broken. Both spellings of ONE refusal are put through it here,
    // so the predicate is observed separating them rather than asserted to.
    const f = lap("lap-json-predicate");
    f.err.length = 0;
    expect(await f.perform({ "--run-id": "no-such-run" })).toBe(2);
    const humanLine = f.err.join("");

    f.err.length = 0;
    expect(await mainAsync(jsonArgv(f, { "--run-id": "no-such-run" }))).toBe(2);
    const documentLine = f.err.join("");

    expect(looksLikeDocument(humanLine)).toBe(false);
    expect(looksLikeDocument(documentLine)).toBe(true);
  });
});

/**
 * The one `record.json` under a state root.
 *
 * Found rather than named, because the session id is a UUID this test does not
 * choose -- the verb mints it. There is exactly one session per lap, so an
 * expectation of one directory is a check as well as a lookup.
 */
function recordPath(stateRoot: string): string {
  // Filtered on `record.json` rather than taking the only entry: the provider
  // also writes `probe-evidence.txt` into the state root, so "the only child of
  // this directory" is not the same statement as "the only session".
  const sessions = readdirSync(stateRoot).filter((entry) =>
    existsSync(join(stateRoot, entry, "record.json")),
  );
  expect(sessions, `expected one session under ${stateRoot}`).toHaveLength(1);
  return join(stateRoot, sessions[0] as string, "record.json");
}

/** The provider's durable record of the argv it spawned, and the identity in it. */
function spawnedRecord(f: Lap): { readonly argv: string[]; readonly uuid: string } {
  const record = JSON.parse(readFileSync(recordPath(f.stateRoot), "utf8")) as {
    argv: string[];
    claude_session_uuid: string;
  };
  return { argv: record.argv, uuid: record.claude_session_uuid };
}

/**
 * One lap's spawned argv with everything that cannot repeat across laps folded
 * out of it, so two laps' vectors can be compared element by element.
 *
 * Exactly two things vary between two laps of the same fixture shape, and both
 * are here: the case's own root, which every path in the vector is built under
 * (`caseRoot` hands out a fresh directory per call), and the session UUID the
 * verb mints. Nothing else in the vector is per-lap, which is the property the
 * comparison below is asserting -- so folding these two and finding a
 * difference means a difference this change made.
 *
 * The root is folded case-insensitively because Windows paths are, and a
 * substitution that missed on the cell would leave both vectors carrying their
 * own roots and fail with a diff that named the wrong thing.
 */
function foldedArgv(f: Lap): string[] {
  const { argv, uuid } = spawnedRecord(f);
  const root = new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return argv.map((token) => token.replace(root, "<root>").split(uuid).join("<uuid>"));
}

describe("D-0099: which model the worker runs on", () => {
  test("--model reaches the child's argv exactly once, after the flags the provider owns", async () => {
    // The whole of what the flag is for: a model named on the command line is a
    // model the fenced child was actually started with. `record.json` is the
    // provider's own record of the vector it spawned, so this reads the child's
    // command line rather than a restatement of the intent to build one.
    const f = lap("lap-model-argv", "run-model-argv");

    expect(await f.perform({ "--model": "claude-haiku-4-5-20251001" }), f.err.join("")).toBe(0);

    const { argv } = spawnedRecord(f);
    const at = argv.indexOf("--model");
    expect(at, JSON.stringify(argv)).toBeGreaterThanOrEqual(0);
    // **Exactly once.** Two `--model` tokens is the failure mode a flag threaded
    // through both the provider and the request could produce, and the child
    // would silently honour the last one -- so a lap could run on a model the
    // operator did not choose while every other assertion here passed.
    expect(argv.filter((token) => token === "--model")).toHaveLength(1);
    expect(argv[at + 1]).toBe("claude-haiku-4-5-20251001");
    // After the flags the provider renders itself, which is the ordering that
    // makes the committed identity un-overridable: `base_cli_args` is appended
    // behind `--session-id` and the structured-readout flags, never in front of
    // them.
    expect(argv.indexOf("--session-id"), JSON.stringify(argv)).toBeLessThan(at);
    expect(argv.indexOf("--output-format")).toBeLessThan(at);
  });

  test("the report says which model, in both spellings", async () => {
    const f = lap("lap-model-report", "run-model-report");
    f.out.length = 0;

    expect(await mainAsync(jsonArgv(f, { "--model": "sonnet" })), f.err.join("")).toBe(0);
    // The document's key, which is the one a host driving laps reads to account
    // for what one cost. Not `toStrictEqual` over the whole object here: the
    // shape is pinned once, above, and this case is about the one key.
    expect(oneDocument(f.out)["model"]).toBe("sonnet");
  });

  test("a value that is not a plain model id is refused, in the envelope, with nothing built", async () => {
    // The reason the rule exists. The value becomes a token in the fenced
    // child's own command line, so anything that could be read there as a second
    // argument -- a leading `-`, a path, whitespace, an `=` -- is refused before
    // the lap starts rather than handed to the child's parser to interpret.
    const refused = [
      // A flag wearing a model's clothes.
      "--dangerously-skip-permissions",
      // A flag the PROVIDER renders itself, which is the value that found the
      // ordering defect: `base_cli_args` carrying one raises at construction,
      // and with the check downstream of that constructor an operator's typo
      // arrived as a stack trace and exit 1 instead of this document.
      "-p",
      "--session-id",
      // Two arguments in one, for a reader that splits its own option values.
      "opus --dangerously-skip-permissions",
      // A path, which `D-0067` spent three attempts removing from this command
      // line and is not letting back in through a different flag.
      "../../etc/passwd",
      // An attached-value form of something else.
      "opus=--print",
      // Empty: naming no model is spelled by omitting the flag.
      "",
    ];
    for (const [index, value] of refused.entries()) {
      const f = lap(`lap-model-refused-${index}`, `run-model-refused-${index}`);
      f.out.length = 0;
      f.err.length = 0;

      // `--model=<value>`, attached, and not as two tokens. Every value here is
      // one the parser itself would stop first in the spaced form -- a leading
      // `-` reads as the next flag and `""` as a missing argument -- and being
      // stopped there is a usage error and not this rule. The attached form is
      // how an operator passes such a value (the same note `run admit --cli-arg`
      // carries), so it is the form the rule has to hold under.
      const argv = jsonArgv(f);
      argv.push(`--model=${value}`);

      expect(await mainAsync(argv), `accepted ${value}`).toBe(2);
      expect(f.out.join(""), "a refused --json run must leave stdout empty").toBe("");
      const refusal = JSON.parse(f.err.join("")) as Record<string, unknown>;
      expect(refusal["schema"]).toBe(PERFORM_SCHEMA);
      expect(refusal["ok"]).toBe(false);
      const error = refusal["error"] as { class: string; message: string };
      expect(error.class).toBe("LapUsageError");
      expect(error.message).toContain("model");

      // And it is refused where the preflight promises: before the branch, the
      // worktree and the fence exist, so a corrected retry is still free rather
      // than costing the run identifier (`D-0057`).
      expect(existsSync(f.workspace), "a refused model still cut a worktree").toBe(false);
      expect(eventTypes(inspect(f.databasePath))).toEqual([
        "run_created",
        RUN_DELEGATION_RECORDED_EVENT_TYPE,
      ]);
    }
  });

  test("omitting the flag leaves the argv byte-identical to what it always was", async () => {
    // The half that makes this change safe for every caller that does not pass
    // it. Asserted as a comparison rather than as `not.toContain("--model")`,
    // because the absent spelling has to be identical and not merely
    // model-free: a `baseCliArgs: []` handed to the provider, or a `--model`
    // with an empty value appended when the flag was omitted, would both pass
    // the weaker check.
    // The SAME run id for both, because the artifact directory is derived from
    // it (`D-0061`) and so appears in the vector: two ids would be a difference
    // this comparison would report as the flag's doing. The two laps are in
    // separate control planes and separate roots, so one id is not a clash.
    const without = lap("lap-model-absent");
    expect(await without.perform(), without.err.join("")).toBe(0);

    const with_ = lap("lap-model-present");
    expect(await with_.perform({ "--model": "sonnet" }), with_.err.join("")).toBe(0);

    const present = foldedArgv(with_);
    const at = present.indexOf("--model");
    expect(at).toBeGreaterThanOrEqual(0);
    // The flag's whole footprint: two tokens, and every other element of the
    // vector unchanged.
    expect(foldedArgv(without)).toEqual([...present.slice(0, at), ...present.slice(at + 2)]);
    expect(foldedArgv(without)).not.toContain("--model");

    // And the human line an operator reads is the line it has always been: the
    // model clause is present or absent, where the document's key is always
    // there and null.
    // Matched at the end of the line rather than by "does not contain 'model'":
    // the case's own temporary directory has the word in its name, and every
    // path on the line is under it.
    expect(without.out.join("")).toMatch(/at seq \d+\n$/);
    expect(with_.out.join("")).toMatch(/at seq \d+, model 'sonnet'\n$/);
  });
});
