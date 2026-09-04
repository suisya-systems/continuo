/**
 * Step 7 of the minimal operating loop: workspace materialisation.
 *
 * **Target-only.** Interlock has no counterpart -- it executes no git anywhere
 * and has no workspace materialisation step at all, which is exactly what
 * `docs/design/minimal-operating-loop.md` section 4.5 calls "the largest
 * genuinely-new build in the lap". So there is no source node id to port and no
 * parity ledger claims this file. Rule 10 of
 * `docs/test-translation-conventions.md` applies: each case below names what
 * would be silently wrong without it.
 *
 * **These cases drive real `git`.** A double for it would be a double for the
 * one thing under test: every property here -- that a tag is not a branch, that
 * a resolved commit is the start point, that a worktree is a checkout -- is a
 * property of git's behaviour, and a fake would encode this file's belief about
 * git rather than test it. That is why this file is listed in
 * `SPAWNING_TESTS` in `scripts/run-suite.mjs`: it starts child processes, and
 * `D-0048` runs those apart from the rest of the suite on Windows. The
 * automatic guard there follows imports only within `test/`, so a file that
 * spawns through `src/` has to be listed by hand -- this is that hand.
 *
 * What the cases are for, in the order they appear:
 *
 * * **`M1`: a base branch is a branch.** `rev-parse` accepts a tag, an
 *   abbreviated object id, `HEAD` and a remote-tracking ref. Three of those
 *   cannot be the target of the pull request step 11 opens, and all four would
 *   pass a materialiser that merely resolved the name. The refusal cases build
 *   a real tag and a real commit id in a real repository and assert each is
 *   refused -- paired with the anti-vacuity half, that the branch of the same
 *   commit is accepted, so a materialiser that refused everything could not pass.
 * * **`M3`: the ordering is one-way.** The result event is appended last, and
 *   the case that carries this is not "the happy path appends one event" --
 *   which is green in a build that appends first -- but the pair: a failure
 *   after the worktree leaves artifacts and NO event, and there is no exported
 *   call that produces the event without producing the artifacts.
 * * **`D3`: the MCP configuration is one the endpoint would start under.** It
 *   is validated by `EndpointConfig`, the endpoint's own class, so the case
 *   asserts the artifact through that class rather than against a copy of the
 *   variable list.
 * * **The completed `SessionOrchestratorOptions`.** The step's stated deliverable
 *   is a value a composition root can hand to a `SessionOrchestrator`, so the
 *   fields are asserted directly, including that `cli_args` carries the fence's
 *   own flags and the `--mcp-config` D3 adds.
 *
 * Every timestamp is {@link T0}, never a clock, for the reason
 * `run-admission.test.ts` gives: a suite whose expectations move with the wall
 * clock cannot assert what a caller-supplied clock wrote.
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";
import { FENCE_NAME } from "../../src/control_plane/destination.js";
import { EVENT_TYPES } from "../../src/control_plane/events.js";
import { NOTIFY_RECIPIENT } from "../../src/control_plane/handlers.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import { FencedSpawner, FenceLedger } from "../../src/fencing/spawn.js";
import { DELIVERY_LEASE_RESOURCE, EndpointConfig } from "../../src/messagebus/endpoint.js";
import { MEMORY } from "../../src/sqlite/open.js";
import {
  branchExists,
  GitCommandFailed,
  type GitOptions,
  GitRefusal,
  gitMetadataRoots,
  removeWorktree,
  repositoryRoot,
  runGitChecked,
} from "../../src/workspace/git.js";
import {
  FENCE_FILENAME,
  isInside,
  type MaterializationRequest,
  MaterializedWorkspace,
  MCP_CONFIG_FILENAME,
  MCP_SERVER_NAME,
  materializeWorkspace,
  WORKSPACE_MATERIALIZED_EVENT_TYPE,
  WORKSPACE_MATERIALIZER_PRODUCER,
  WorkspaceMaterializationRefused,
  WorkspaceMaterializationUsageError,
} from "../../src/workspace/materializer.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const RUN_ID = "run-materialize-1";
/** A file the seed commit carries with the executable bit set. See `initRepository`. */
const WORKTREE_EXECUTABLE = "tool";
const BASE_BRANCH = "main";
const TOPIC_BRANCH = "feat/topic";

/**
 * A git identity and configuration that does not depend on the host's.
 *
 * `user.name` / `user.email` because `git commit` refuses without them on a
 * machine that has never been configured -- a CI runner, which is where this
 * file runs. `init.defaultBranch` because git's default is a warning and a
 * value that has changed between versions, and every case here names
 * {@link BASE_BRANCH} explicitly.
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
  // **An executable, committed, so the checkout contains one.** It exists for
  // the containment cases and nothing else. The fence renderer refuses a hook
  // launcher it cannot execute, so a case that points `--python` at a path
  // inside the worktree which does not EXIST is refused by that older guard
  // instead of by the containment ward -- and would then go red with the ward
  // deleted, for the wrong reason, while looking like it defended the rule.
  // Pointing at a real executable in the checkout is what makes that mutation
  // succeed and reproduce the hole.
  //
  // `update-index --chmod=+x` rather than `chmod`: the mode has to be in the
  // COMMIT for `git worktree add` to check it out, and `chmod` is a no-op on
  // Windows where the suite also runs. `accessSync(X_OK)` is satisfied by any
  // existing file there, so the case works on both.
  writeFileSync(join(root, WORKTREE_EXECUTABLE), "#!/bin/sh\nexit 0\n", "utf8");
  runGitChecked(["add", WORKTREE_EXECUTABLE], git);
  runGitChecked(["update-index", "--chmod=+x", WORKTREE_EXECUTABLE], git);
  runGitChecked(["commit", "-m", "seed"], git);
  return git;
}

/**
 * A production control plane at head with one admitted run on it.
 *
 * `at` is a parameter for exactly one case: the containment rule wards the
 * database itself, and the only way to violate that is for the control plane to
 * live where the worktree is about to be created.
 */
function controlPlane(root: string, at?: string): { connection: SqliteDatabase; path: string } {
  const path = at ?? join(root, "production.sqlite3");
  mkdirSync(dirname(path), { recursive: true });
  createProductionControlPlane(path, { nowMs: T0 }).close();
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  // The run this workspace belongs to has to exist: `event.run_id` is a foreign
  // key onto it. Admitted through the real writer with the real intent, so
  // these cases sit downstream of step 6 the way step 7 does.
  admitRun(connection, {
    intent: new LapRunIntent({
      runId: RUN_ID,
      leaseClaimantId: "operator-1",
      workspace: join(root, "worktree"),
      role: "worker",
      baseBranch: BASE_BRANCH,
      topicBranch: TOPIC_BRANCH,
      prompt: "do the work",
    }),
    nowMs: T0,
  });
  return { connection, path };
}

/** The whole fixture one case needs: a repository, a control plane, and a request. */
interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly git: GitOptions;
  readonly connection: SqliteDatabase;
  readonly databasePath: string;
  readonly workspace: string;
  readonly artifactDir: string;
  readonly request: MaterializationRequest;
}

function fixture(
  label: string,
  overrides: Partial<MaterializationRequest> = {},
  databaseAt?: (root: string) => string,
): Fixture {
  const root = caseRoot(label);
  const repository = join(root, "repo");
  const git = initRepository(repository);
  const plane = controlPlane(root, databaseAt?.(root));

  // Outside the worktree, deliberately: the materialiser refuses an artifact
  // directory inside it, and the reason is asserted in its own case below.
  const workspace = join(root, "worktree");
  const artifactDir = join(root, "artifacts");
  mkdirSync(artifactDir, { recursive: true });

  const request: MaterializationRequest = {
    runId: RUN_ID,
    holder: "operator-1",
    role: "worker",
    repository,
    baseBranch: BASE_BRANCH,
    topicBranch: TOPIC_BRANCH,
    workspace,
    artifactDir,
    prompt: "do the work",
    nowMs: T0,
    sessionUuidFactory: () => "00000000-0000-0000-0000-000000000001",
    gitTimeoutMs: 60_000,
    endpoint: {
      databasePath: plane.path,
      holder: "operator-1",
      epoch: 1,
      recipient: NOTIFY_RECIPIENT,
      destinationDir: join(root, "destination"),
      // A path rather than the real built module: `dist/` need not exist for
      // these cases, and what is under test is the artifact's shape and its
      // acceptance by `EndpointConfig`, not that Node can run it.
      endpointModule: join(root, "endpoint.js"),
      node: process.execPath,
    },
    fence: {
      interlockRoot: root,
      claudeOrgPath: join(root, "claude-org"),
    },
    ...overrides,
  };

  return {
    root,
    repository,
    git,
    connection: plane.connection,
    databasePath: plane.path,
    workspace,
    artifactDir,
    request,
  };
}

/** The `event` rows, as the database holds them. */
function eventRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection.prepare("SELECT * FROM event ORDER BY seq").all() as Record<string, unknown>[];
}

/** The materialisation events only. */
function materializationEvents(connection: SqliteDatabase): Record<string, unknown>[] {
  return eventRows(connection).filter(
    (row) => row["event_type"] === WORKSPACE_MATERIALIZED_EVENT_TYPE,
  );
}

// --------------------------------------------------------------------------

describe("the event vocabulary", () => {
  test("the type this step produces is registered", () => {
    // `EVENT_TYPES` is documentation rather than a constraint -- nothing
    // validates an append against it -- which is precisely why a producer that
    // forgot to register its type would go unnoticed. D-0051 rule 5 says a type
    // is registered when its producer is written, and this is the assertion
    // that the two happened together.
    expect(EVENT_TYPES.has(WORKSPACE_MATERIALIZED_EVENT_TYPE)).toBe(true);
  });
});

describe("M1: the base branch must be a branch", () => {
  test("a branch is accepted (the anti-vacuity half)", () => {
    // Without this, every refusal case below is satisfied by a materialiser
    // that refuses unconditionally.
    const f = fixture("materialize-base-ok");
    const materialized = materializeWorkspace(f.connection, f.request);
    expect(materialized.baseBranch).toBe(BASE_BRANCH);
    expect(materialized.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
  });

  test("a tag pointing at the same commit is refused", () => {
    // The case `rev-parse` cannot tell apart from a branch. A tag resolves, so
    // a materialiser that only resolved would record `v1` as its base branch
    // and step 11 would open a pull request against a ref that is not a branch.
    const f = fixture("materialize-base-tag");
    runGitChecked(["tag", "v1", BASE_BRANCH], f.git);

    const refusal = expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, baseBranch: "v1" }),
      WorkspaceMaterializationRefused,
      /is not a branch/,
    );
    expect(refusal.message).toContain("refs/heads/v1");
    expect(existsSync(f.workspace)).toBe(false);
    expect(materializationEvents(f.connection)).toEqual([]);
  });

  test("a commit id is refused", () => {
    const f = fixture("materialize-base-sha");
    const head = runGitChecked(["rev-parse", "--verify", `${BASE_BRANCH}^{commit}`], f.git).stdout;

    expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, baseBranch: head }),
      WorkspaceMaterializationRefused,
      /is not a branch/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a name that resolves to nothing is refused", () => {
    const f = fixture("materialize-base-absent");
    expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, baseBranch: "no-such-branch" }),
      WorkspaceMaterializationRefused,
      /is not a branch/,
    );
  });

  test("a malformed branch name is refused before git resolves anything", () => {
    // `..` is rejected by `check-ref-format`. Two names are checked rather than
    // one because the leading-dash case is refused by this repository's own
    // guard and the `..` case by git's -- and a guard that only covered one of
    // them would leave the other reaching an argv position where git reads it
    // as an option.
    const f = fixture("materialize-base-malformed");
    for (const name of ["bad..name", "-not-a-branch"]) {
      expectRefusal(
        () => materializeWorkspace(f.connection, { ...f.request, baseBranch: name }),
        WorkspaceMaterializationRefused,
        /not a well-formed branch name/,
      );
    }
  });

  test("the worktree starts at the resolved commit, not at whatever the branch says later", () => {
    // The base branch moving between the resolve and the worktree is the race
    // the recorded commit exists to close. Driven directly: resolve, move the
    // branch, materialise, and assert the checkout is at the recorded commit.
    const f = fixture("materialize-base-moved");
    const first = runGitChecked(["rev-parse", "--verify", `${BASE_BRANCH}^{commit}`], f.git).stdout;

    const materialized = materializeWorkspace(f.connection, f.request);
    expect(materialized.baseCommit).toBe(first);

    const checkedOut = runGitChecked(["rev-parse", "--verify", "HEAD"], {
      cwd: materialized.workspace,
      timeoutMs: 60_000,
    }).stdout;
    expect(checkedOut).toBe(first);
  });

  test("an existing topic branch is refused, and nothing is created", () => {
    const f = fixture("materialize-topic-taken");
    runGitChecked(["branch", TOPIC_BRANCH, BASE_BRANCH], f.git);

    expectRefusal(
      () => materializeWorkspace(f.connection, f.request),
      WorkspaceMaterializationRefused,
      /already exists/,
    );
    expect(existsSync(f.workspace)).toBe(false);
    expect(materializationEvents(f.connection)).toEqual([]);
  });
});

describe("the artifacts", () => {
  test("fence, settings and MCP configuration are all published, outside the worktree", () => {
    const f = fixture("materialize-artifacts");
    const materialized = materializeWorkspace(f.connection, f.request);

    expect(materialized.artifacts.map((a) => a.kind).sort()).toEqual([
      "fence",
      "mcp-config",
      "settings",
    ]);
    for (const artifact of materialized.artifacts) {
      expect(existsSync(artifact.path), `${artifact.kind} at ${artifact.path}`).toBe(true);
      // The property `MaterializationRequest.artifactDir` is about: a fence the
      // fenced child can edit is not a fence, and a worktree carrying untracked
      // configuration is not a clean checkout.
      expect(artifact.path.startsWith(f.workspace)).toBe(false);
    }
    expect(materialized.artifacts[0]?.path).toBe(join(f.artifactDir, FENCE_FILENAME));
  });

  test("the fence went through admission, not around it", () => {
    // The fence ledger is the record only `FencedSpawner` writes. Asserting it
    // carries `spawn-admitted` is what distinguishes materialisation that used
    // the admission path from one that called `renderFence` and `writeFence`
    // itself -- which would produce byte-identical artifacts and no record.
    const f = fixture("materialize-admitted");
    materializeWorkspace(f.connection, f.request);

    const ledger = readFileSync(join(f.artifactDir, "fence-ledger.jsonl"), "utf8");
    const events = ledger
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((e) => e["event"])).toEqual(["battery-run", "spawn-admitted"]);
  });

  test("an artifact directory inside the worktree is refused", () => {
    const f = fixture("materialize-artifacts-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          artifactDir: join(f.workspace, ".continuo"),
        }),
      WorkspaceMaterializationUsageError,
      /inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });
});

describe("D3: the MCP configuration is one the endpoint would start under", () => {
  test("its environment satisfies EndpointConfig, the endpoint's own contract", () => {
    const f = fixture("materialize-mcp");
    materializeWorkspace(f.connection, f.request);

    const document = JSON.parse(
      readFileSync(join(f.artifactDir, MCP_CONFIG_FILENAME), "utf8"),
    ) as Record<string, Record<string, Record<string, unknown>>>;
    const server = document["mcpServers"]?.[MCP_SERVER_NAME];
    expect(server).toBeDefined();
    expect(server?.["command"]).toBe(process.execPath);
    expect(server?.["args"]).toEqual([join(f.root, "endpoint.js")]);

    // Asserted through the endpoint's own class rather than against a list of
    // variable names copied into this file. A copy would keep passing on the
    // day the endpoint starts requiring a seventh variable.
    const env = server?.["env"] as Record<string, string>;
    const config = new EndpointConfig(env);
    expect(config.missing()).toEqual([]);
    expect(config.resource).toBe(DELIVERY_LEASE_RESOURCE);
    expect(config.dbPath).toBe(f.databasePath);
    expect(config.recipient).toBe(NOTIFY_RECIPIENT);
    expect(config.epoch).toBe(1);
  });

  test("a recipient no handler serves is refused", () => {
    // `EndpointConfig.missing()` does not cover this -- the recipient is
    // well-formed, it is just not one `spikeRegistry` composes a handler for --
    // and the endpoint refuses it at startup with exit 2. A worker configured
    // with one would poll an eternally empty queue while its real messages
    // stayed due, which is the failure that looks most like working.
    const f = fixture("materialize-recipient");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, recipient: "nobody-serves-this" },
        }),
      WorkspaceMaterializationUsageError,
      /no registered handler serves/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a binding the endpoint would refuse is refused here instead", () => {
    // The failure this moves: without it, the gap is discovered by a worker
    // whose endpoint exits 2 hours later, in a different process, with the
    // materialisation long since recorded as successful.
    //
    // `holder` is the field driven here because it is the one this step has no
    // separate rule for: the database is derived, the destination directory has
    // a path rule of its own, and the recipient is checked against the
    // registry -- so `holder` is what actually reaches `EndpointConfig.missing()`
    // and is refused by it. That is the point of the case: the check being
    // asserted is the endpoint's own.
    const f = fixture("materialize-mcp-gap");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, holder: "" },
        }),
      WorkspaceMaterializationUsageError,
      /INTERLOCK_MESSAGEBUS_HOLDER/,
    );
  });
});

describe("the completed SessionOrchestratorOptions", () => {
  test("carries the run, the workspace, the prompt and the fence's own flags", () => {
    const f = fixture("materialize-options");
    const materialized = materializeWorkspace(f.connection, f.request);
    const options = materialized.options;

    expect(options.runId).toBe(RUN_ID);
    expect(options.holder).toBe("operator-1");
    expect(options.role).toBe("worker");
    expect(options.workspace).toBe(f.workspace);
    expect(options.nowMs()).toBe(T0);
    expect(options.sessionUuidFactory()).toBe("00000000-0000-0000-0000-000000000001");

    const settings = options.settings as Record<string, unknown>;
    expect(settings["prompt"]).toBe("do the work");
    const cliArgs = settings["cli_args"] as string[];
    // The fence's flags come from the plan rather than being spelled again
    // here -- and their COUNT comes from the plan too, rather than being a
    // literal this file would have to be edited every time the fence grows a
    // flag. What is asserted is that they are present and that the MCP flags
    // were appended after them.
    const fenceFlags = materialized.plan.cliArgs();
    expect(cliArgs.slice(0, fenceFlags.length)).toEqual(fenceFlags);
    expect(cliArgs.slice(fenceFlags.length)).toEqual([
      "--mcp-config",
      join(f.artifactDir, MCP_CONFIG_FILENAME),
      "--strict-mcp-config",
    ]);
  });

  test("the plan it returns is one the spawner will execute", () => {
    // The other half of the D-0217 split, from this side: step 8 calls
    // `execute` with this plan, and `execute` accepts only a plan its own
    // spawner admitted. A materialiser that hand-built a plan would satisfy
    // every other case in this file and fail at step 8.
    const f = fixture("materialize-plan");
    const materialized = materializeWorkspace(f.connection, f.request);
    expect(materialized.admission.admitted).toBe(true);
    expect(materialized.admission.plan).toBe(materialized.plan);
    expect(materialized.plan.fencePath).toBe(join(f.artifactDir, FENCE_FILENAME));
  });
});

describe("M3: artifacts first, the event last", () => {
  test("the happy path appends exactly one event, naming the manifest", () => {
    const f = fixture("materialize-event");
    const materialized = materializeWorkspace(f.connection, f.request);

    const events = materializationEvents(f.connection);
    expect(events).toHaveLength(1);
    const row = events[0] as Record<string, unknown>;
    expect(row["subject_kind"]).toBe("run");
    expect(row["subject_id"]).toBe(RUN_ID);
    expect(row["run_id"]).toBe(RUN_ID);
    expect(row["producer"]).toBe(WORKSPACE_MATERIALIZER_PRODUCER);
    expect(row["occurred_at_ms"]).toBe(T0);
    expect(row["seq"]).toBe(materialized.eventSeq);

    const payload = JSON.parse(row["payload"] as string) as Record<string, unknown>;
    expect(payload["base_branch"]).toBe(BASE_BRANCH);
    expect(payload["base_commit"]).toBe(materialized.baseCommit);
    expect(payload["topic_branch"]).toBe(TOPIC_BRANCH);
    expect(payload["workspace"]).toBe(f.workspace);
    expect(payload["role"]).toBe("worker");
    expect(payload["artifacts"]).toEqual(
      materialized.artifacts.map((a) => ({ kind: a.kind, path: a.path })),
    );
  });

  test("a refusal after the worktree leaves artifacts and no event", () => {
    // The allowed direction, asserted as a state rather than assumed. The
    // refusal is reached with a role the document does not carry, which the
    // fence refuses *after* the worktree has been created -- so this is
    // genuinely the half-materialised state, not a request rejected up front.
    const f = fixture("materialize-partial");
    expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, role: "no-such-role" }),
      WorkspaceMaterializationRefused,
      /was refused/,
    );

    // The worktree is there and is a checkout...
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
    expect(branchExists(TOPIC_BRANCH, f.git)).toBe(true);
    // ...and the spine says nothing about it.
    expect(materializationEvents(f.connection)).toEqual([]);
    // ...and it is recoverable, which is what makes the direction acceptable.
    removeWorktree(f.workspace, f.git);
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a recorded event names a manifest that was on disk", () => {
    // The unconstructible direction, from the only side a caller can observe
    // it: there is no exported call that appends this event, so what can be
    // pinned is the pairing the append is gated on. A successful call implies
    // the sweep ran, so the payload's manifest is the returned manifest and
    // every path in it exists.
    //
    // Stated as a property rather than by simulating a torn write, which no
    // supported API can produce: the artifacts are published through
    // fsync-and-rename, so there is no moment at which a caller can see a path
    // that is present to the writer and absent to the stat.
    const f = fixture("materialize-sweep");
    const materialized = materializeWorkspace(f.connection, f.request);
    const row = materializationEvents(f.connection)[0] as Record<string, unknown>;
    const payload = JSON.parse(row["payload"] as string) as { artifacts: { path: string }[] };
    for (const artifact of payload.artifacts) {
      expect(existsSync(artifact.path), artifact.path).toBe(true);
    }
    expect(payload.artifacts.map((a) => a.path)).toEqual(materialized.artifacts.map((a) => a.path));
  });

  test("a second materialisation of one run is refused rather than absorbed", () => {
    const f = fixture("materialize-twice");
    materializeWorkspace(f.connection, f.request);

    // A fresh path, branch AND artifact directory, so the refusal comes from the
    // spine rather than from git having the worktree or from the artifact
    // directory already being claimed -- both of which refuse earlier and would
    // make this case pass for the wrong reason.
    const secondArtifacts = join(f.root, "artifacts-2");
    mkdirSync(secondArtifacts, { recursive: true });
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          workspace: join(f.root, "worktree-2"),
          topicBranch: "feat/topic-2",
          artifactDir: secondArtifacts,
        }),
      WorkspaceMaterializationRefused,
      /materialised before/,
    );
    expect(materializationEvents(f.connection)).toHaveLength(1);
  });
});

describe("the plan can actually be spawned by step 8", () => {
  test("the admitting spawner comes back, and it is the one that executes the plan", () => {
    // Without this the split is a lock with the key thrown away: `execute`
    // accepts only a plan its own instance admitted (D-0217), so a materialiser
    // that constructed a `FencedSpawner` locally and discarded it would return
    // a plan no step-8 composition root could ever spawn. Driven end to end --
    // the returned spawner executes, and a freshly built one is refused.
    const f = fixture("materialize-spawner");
    const materialized = materializeWorkspace(f.connection, f.request);

    const calls: unknown[] = [];
    const outcome = materialized.spawner.execute(materialized.admission, (plan) => {
      calls.push(plan);
      return { pid: 7 };
    });
    expect(calls).toEqual([materialized.plan]);
    expect(outcome.result).toEqual({ pid: 7 });

    const stranger = new FencedSpawner({
      ledger: new FenceLedger(join(f.artifactDir, "other-ledger.jsonl")),
    });
    expect(() => stranger.execute(materialized.admission, () => ({ pid: 8 }))).toThrow(
      /did not admit/,
    );
  });

  test("a caller-chosen fence ledger path is used", () => {
    // The one thing a caller has a real reason to move. It is a path rather
    // than a spawner deliberately: see `MaterializationRequest.fenceLedgerPath`.
    const f = fixture("materialize-ledger-path");
    const mine = join(f.root, "my-ledger.jsonl");

    materializeWorkspace(f.connection, { ...f.request, fenceLedgerPath: mine });
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(join(f.artifactDir, "fence-ledger.jsonl"))).toBe(false);
  });
});

describe("nothing is created for a request that is malformed", () => {
  test("an artifact directory reaching into the worktree through `..` is refused", () => {
    // The lexical-containment hole. `join` normalises, so this path lands
    // inside the worktree; a prefix comparison on the raw string says it does
    // not. Without normalisation the guard reports safe for the exact case it
    // exists to catch, and the fence becomes a file the fenced child can edit.
    const f = fixture("materialize-dotdot");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          // Concatenated, NOT `join`ed: `join` normalises, so building this
          // path with it would quietly produce the already-safe spelling and
          // the case would pass against the very bug it is here to catch.
          artifactDir: `${f.artifactDir}${sep}..${sep}worktree${sep}.continuo`,
        }),
      WorkspaceMaterializationUsageError,
      /inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a bad endpoint binding costs no branch, no worktree and no artifact", () => {
    // The refusal itself is asserted above; what this adds is the guarantee
    // this error family documents -- a malformed request does nothing. The
    // binding is only usable by the endpoint, so validating it at the point of
    // publication would leave a topic branch, a checkout, two published files
    // and an admission ledger line behind for an empty string.
    const f = fixture("materialize-endpoint-clean");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, holder: "" },
        }),
      WorkspaceMaterializationUsageError,
      /INTERLOCK_MESSAGEBUS_HOLDER/,
    );
    expect(existsSync(f.workspace)).toBe(false);
    expect(branchExists(TOPIC_BRANCH, f.git)).toBe(false);
    expect(existsSync(join(f.artifactDir, FENCE_FILENAME))).toBe(false);
    expect(existsSync(join(f.artifactDir, "fence-ledger.jsonl"))).toBe(false);
    expect(materializationEvents(f.connection)).toEqual([]);
  });
});

describe("no artifact can land inside the worktree", () => {
  test("a fence ledger inside the worktree is refused", () => {
    // The admission audit trail is the one artifact whose whole value is that
    // its subject cannot edit it, and it is written by `prepare` -- so it is a
    // path this check has to cover, not just the three the manifest names.
    const f = fixture("materialize-ledger-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fenceLedgerPath: join(f.workspace, "ledger.jsonl"),
        }),
      WorkspaceMaterializationUsageError,
      /the fence ledger would be written to/,
    );
    expect(existsSync(f.workspace)).toBe(false);
    expect(branchExists(TOPIC_BRANCH, f.git)).toBe(false);
  });

  test("a fence ledger reaching into the worktree through `..` is refused", () => {
    const f = fixture("materialize-ledger-traverse");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          // Concatenated, NOT `join`ed: `join` normalises, and building it that
          // way would produce the already-safe spelling.
          fenceLedgerPath: `${f.artifactDir}${sep}..${sep}worktree${sep}ledger.jsonl`,
        }),
      WorkspaceMaterializationUsageError,
      /the fence ledger would be written to/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("an endpoint destination directory inside the worktree is refused", () => {
    // This step never writes it -- `KeyedDropbox` creates it at endpoint
    // startup and writes delivery files into it for the rest of the worker's
    // life. That is exactly why it belongs on the list: its contents appear
    // inside the checkout later, where no check of this step's would ever see
    // them, and they are the operator's delivery artifacts rather than the
    // worker's.
    const f = fixture("materialize-destination-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, destinationDir: join(f.workspace, "outbox") },
        }),
      WorkspaceMaterializationUsageError,
      /the endpoint destination directory would be written to/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("continuo#122: an endpoint destination directory that already exists is accepted", () => {
    // Containment is a rule about WHERE the path is; the unclaimed check above
    // is a rule about WHO made it, and this step does not make this one --
    // `KeyedDropbox` opens it with `mkdir -p` at endpoint startup and again on
    // every `gate deliver`. So its presence is not evidence of another
    // materialisation, and refusing it made the one dropbox an operator polls
    // unusable for the next lap (D-0085). The dropbox's own protection against
    // a superseded writer is the fencing watermark it keeps beside the effects.
    const f = fixture("materialize-destination-exists");
    const destinationDir = f.request.endpoint.destinationDir;
    mkdirSync(destinationDir, { recursive: true });
    const earlier = join(destinationDir, "earlier.effect.json");
    writeFileSync(earlier, "{}\n", "utf8");

    const materialized = materializeWorkspace(f.connection, f.request);

    expect(materialized.artifacts).toHaveLength(3);
    expect(existsSync(earlier)).toBe(true);
  });

  test("continuo#122: a destination directory that is a dangling symlink is refused", () => {
    // The spelling `existsSync` gets wrong. It follows the link, finds nothing
    // and reports the path absent, while `mkdirSync(..., {recursive: true})`
    // sees the link itself and refuses with EEXIST -- so a check written the
    // obvious way passes this and the endpoint fails on it, with the whole
    // materialisation already recorded.
    const f = fixture("materialize-destination-dangling");
    try {
      symlinkSync(join(f.root, "nowhere"), f.request.endpoint.destinationDir, "dir");
    } catch {
      // Windows without developer mode refuses to create a symlink. The case
      // asserts nothing there rather than asserting something weaker.
      return;
    }
    expectRefusal(
      () => materializeWorkspace(f.connection, f.request),
      WorkspaceMaterializationUsageError,
      /endpoint destination directory .* exists and does not resolve to a directory/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("continuo#122: a dropbox another control plane drove past this epoch is refused", () => {
    // The qualifier on "reused if it does": one dropbox per control plane. The
    // fencing watermark is keyed by the lease RESOURCE, a constant with no
    // database in it, while the epochs measured against it are one plane's
    // lease sequence -- so a dropbox already at epoch 5 refuses this run's
    // epoch 1, and without this it refuses it at the endpoint's first delivery,
    // with the workspace, the artifacts and the event already there.
    const f = fixture("materialize-destination-foreign-fence");
    const destinationDir = f.request.endpoint.destinationDir;
    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(
      join(destinationDir, FENCE_NAME),
      `${JSON.stringify({ [DELIVERY_LEASE_RESOURCE]: 5 })}\n`,
      "utf8",
    );
    expectRefusal(
      () => materializeWorkspace(f.connection, f.request),
      WorkspaceMaterializationRefused,
      /has already honoured fencing token 5/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("continuo#122: a dropbox this plane's earlier epoch left behind is reused", () => {
    // The anti-vacuity half of the case above, and the shape same-plane reuse
    // actually has: the lap that ran before this one left its own watermark,
    // and this run's epoch is above it because lease epochs on one resource
    // only rise. A check written as "any watermark refuses" would pass every
    // other case in this file and refuse exactly the workflow #122 asks for.
    const f = fixture("materialize-destination-own-fence");
    const destinationDir = f.request.endpoint.destinationDir;
    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(
      join(destinationDir, FENCE_NAME),
      `${JSON.stringify({ [DELIVERY_LEASE_RESOURCE]: 2 })}\n`,
      "utf8",
    );

    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      endpoint: { ...f.request.endpoint, epoch: 3 },
    });
    expect(materialized.artifacts).toHaveLength(3);
  });

  test("continuo#122: a destination directory that is a file is refused, and nothing is created", () => {
    // What the narrowing must not lose. `KeyedDropbox` opens the path as a
    // directory, so a regular file there is a request the endpoint cannot start
    // under -- and without this it would be found at endpoint startup, after
    // the branch, the worktree, the artifacts and the event.
    const f = fixture("materialize-destination-file");
    writeFileSync(f.request.endpoint.destinationDir, "not a dropbox\n", "utf8");
    expectRefusal(
      () => materializeWorkspace(f.connection, f.request),
      WorkspaceMaterializationUsageError,
      /endpoint destination directory .* exists and does not resolve to a directory/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("continuo#122: an artifact this step does write is still refused for existing", () => {
    // The anti-vacuity half of the case above: the refusal was narrowed to the
    // paths materialisation creates, not deleted. Without this, dropping the
    // check outright would pass every case in this file.
    const f = fixture("materialize-fence-exists");
    writeFileSync(join(f.artifactDir, FENCE_FILENAME), "{}\n", "utf8");
    expectRefusal(
      () => materializeWorkspace(f.connection, f.request),
      WorkspaceMaterializationRefused,
      /the fence would be written to .* which already exists/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a relative endpoint destination directory is refused", () => {
    const f = fixture("materialize-destination-relative");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, destinationDir: "outbox" },
        }),
      WorkspaceMaterializationUsageError,
      /endpoint\.destination_dir must be a fully qualified absolute path/,
    );
  });

  test("a fence ledger aliasing another artifact is refused", () => {
    // Distinctness, which containment does not imply. Two artifacts at one path
    // is a silent substitution rather than a layout error: the later write wins
    // and every later `stat` still succeeds, so the sweep reports a complete
    // manifest for a file whose contents are somebody else's.
    const f = fixture("materialize-alias");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fenceLedgerPath: join(f.artifactDir, FENCE_FILENAME),
        }),
      WorkspaceMaterializationUsageError,
      /would both be written to/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the default settings name lands beside the fence (the anti-vacuity half)", () => {
    // And it pins the constant the check above predicts with: if
    // `FencedSpawner`'s own default moved, this fails rather than the guard
    // quietly checking a path nothing writes.
    const f = fixture("materialize-settings-default");
    const materialized = materializeWorkspace(f.connection, f.request);
    expect(materialized.plan.settingsPath).toBe(join(f.artifactDir, "settings.local.json"));
    // And the manifest really is four distinct files, so the distinctness check
    // above is checking something that could otherwise collide.
    const paths = materialized.artifacts.map((a) => a.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("the MCP launcher is validated too", () => {
  test("an empty endpoint module is refused, and nothing is created", () => {
    // `??` does not fire on `""`, and `EndpointConfig` validates the
    // environment rather than the launcher -- so without this the empty value
    // is recorded as a successful materialisation whose MCP child cannot start.
    const f = fixture("materialize-endpoint-module");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, endpointModule: "" },
        }),
      WorkspaceMaterializationUsageError,
      /endpoint_module/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("an empty node command is refused", () => {
    const f = fixture("materialize-endpoint-node");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, node: "" },
        }),
      WorkspaceMaterializationUsageError,
      /endpoint\.node/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a relative endpoint module is refused", () => {
    // The configuration is read by a CLI whose working directory is the
    // worker's, so a relative module path names a different file there than it
    // does here -- or none at all.
    const f = fixture("materialize-endpoint-relative");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, endpointModule: "dist/endpoint.js" },
        }),
      WorkspaceMaterializationUsageError,
      /must be a fully qualified absolute path/,
    );
  });
});

describe("nothing the fence depends on may live inside the worktree (D-0070)", () => {
  // The artifact list above states this rule over what materialisation
  // *creates*. These are the paths it does not create and the fence depends on
  // anyway, and every one of them is a value an operator hands in on the
  // command line. The question each case asks is the one that decides the rule:
  // can the worker influence this file? Everything inside its own worktree it
  // can rewrite between one tool call and the next.
  //
  // **Every case here was mutation-checked**, which is what makes the list
  // worth its length: with the containment loop deleted, each of these
  // materialisations SUCCEEDS and records `workspace_materialized` for a fence
  // resting on a file its own subject may edit. A case that merely failed
  // differently would not have shown that -- and three of these cases were
  // rewritten for exactly that reason, because a warded path that does not
  // EXIST is refused by whichever older guard notices absence first (the
  // renderer's, for the hook and its interpreter) rather than by the ward.
  //
  // **The database's case is the one exception to the paragraph above, and it
  // is marked as such rather than quietly listed with the others.** The guard
  // fires -- the case below proves it -- but with the guard deleted the request
  // does not succeed: `git worktree add` refuses a workspace directory that is
  // already there, and one holding a database necessarily is. So the entry is
  // belt-and-braces, and the honest claim for it is "the rule is stated over
  // this value too", not "this closes a reachable hole".

  test("a deny hook inside the worktree is refused", () => {
    // The worst of the list and the reason it exists: this is the file that
    // ENFORCES the fence, and the hook does not protect its own path. `git`
    // puts `README.md` in the checkout, so without the guard this exact request
    // renders a fence whose PreToolUse command names a file the worker may
    // rewrite -- the hole, reproduced, rather than a different failure. A path
    // that merely did not exist would be refused by the older
    // `hook-unresolvable` guard and prove nothing.
    const f = fixture("materialize-hook-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fence: { ...f.request.fence, hookScript: join(f.workspace, "README.md") },
        }),
      WorkspaceMaterializationUsageError,
      /the deny hook is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
    expect(branchExists(TOPIC_BRANCH, f.git)).toBe(false);
  });

  test("a deny hook reaching into the worktree through `..` is refused", () => {
    // Concatenated rather than `join`ed, for the reason the fence ledger's
    // traversal case gives: `join` normalises, and building the path that way
    // would produce the already-safe spelling. This is what the `resolve` in
    // front of the lexical comparison is for.
    const f = fixture("materialize-hook-traverse");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fence: {
            ...f.request.fence,
            hookScript: `${f.artifactDir}${sep}..${sep}worktree${sep}README.md`,
          },
        }),
      WorkspaceMaterializationUsageError,
      /the deny hook is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the hook's interpreter inside the worktree is refused", () => {
    // One step out from the hook and the same hole: whoever runs the hook
    // decides what the hook does.
    //
    // It names the checkout's committed executable rather than any path inside
    // the worktree, and the first spelling of this case is why. A
    // `<workspace>/python` that does not exist is refused by the renderer's
    // launcher check once the ward is deleted -- red, but from the wrong guard,
    // and red in a way that would survive the ward being removed. The base
    // branch carrying an executable is not exotic either: a repository-vendored
    // interpreter or wrapper script is the realistic shape of this mistake.
    const f = fixture("materialize-python-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fence: { ...f.request.fence, python: join(f.workspace, WORKTREE_EXECUTABLE) },
        }),
      WorkspaceMaterializationUsageError,
      /the hook's interpreter is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the endpoint module inside the worktree is refused", () => {
    // The module runs holding the messagebus lease and the control plane's
    // path, which is more authority than the worker has through its fence.
    const f = fixture("materialize-module-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, endpointModule: join(f.workspace, "endpoint.js") },
        }),
      WorkspaceMaterializationUsageError,
      /the endpoint module is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the endpoint's interpreter inside the worktree is refused", () => {
    const f = fixture("materialize-node-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, node: join(f.workspace, "node") },
        }),
      WorkspaceMaterializationUsageError,
      /the endpoint's interpreter is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("an endpoint launcher reaching into the worktree through `..` is refused", () => {
    // The `resolve` inside `renderMcpConfig`, which has two jobs and would be
    // silently half-removable with only the plain containment cases above. The
    // ward is lexical, so an unresolved `..` spelling walks past it; and the
    // resolved string is also what the document is built from, so the file that
    // is warded and the file that is published are the same bytes. Concatenated
    // rather than `join`ed, since `join` would normalise it away.
    const f = fixture("materialize-node-traverse");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: {
            ...f.request.endpoint,
            node: `${f.artifactDir}${sep}..${sep}worktree${sep}${WORKTREE_EXECUTABLE}`,
          },
        }),
      WorkspaceMaterializationUsageError,
      /the endpoint's interpreter is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("an endpoint module reaching into the worktree through `..` is refused", () => {
    const f = fixture("materialize-module-traverse");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: {
            ...f.request.endpoint,
            endpointModule: `${f.artifactDir}${sep}..${sep}worktree${sep}endpoint.js`,
          },
        }),
      WorkspaceMaterializationUsageError,
      /the endpoint module is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("an interlock root that IS the worktree is refused", () => {
    // The equality branch of `isInside`, and the substitution that makes it
    // matter: `{interlock_root}` is interpolated into the fence's own deny
    // rules, so a `denyRead` of `{interlock_root}/.secrets` pointed here denies
    // a directory holding no secrets while the real one stays readable. The
    // fence would render, publish and pass every later check.
    const f = fixture("materialize-interlock-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fence: { ...f.request.fence, interlockRoot: f.workspace },
        }),
      WorkspaceMaterializationUsageError,
      /the fence's interlock root is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a claude-org path inside the worktree is refused", () => {
    const f = fixture("materialize-claude-org-inside");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fence: { ...f.request.fence, claudeOrgPath: join(f.workspace, "claude-org") },
        }),
      WorkspaceMaterializationUsageError,
      /the fence's claude-org path is .*inside the workspace/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a control plane database inside the worktree is refused", () => {
    // The database holds the gate this whole lap exists to open, and the
    // admission ledger the fence's own audit trail is written beside. The only
    // way to reach it is for the control plane to live where the worktree is
    // about to be created -- which git would refuse a moment later, so this
    // guard is the earlier and more legible of two refusals rather than the
    // only one. See the block comment above.
    const f = fixture("materialize-database-inside", {}, (root) =>
      join(root, "worktree", "production.sqlite3"),
    );
    expectRefusal(
      () => materializeWorkspace(f.connection, f.request),
      WorkspaceMaterializationUsageError,
      /the control plane database is .*inside the workspace/,
    );
    expect(branchExists(TOPIC_BRANCH, f.git)).toBe(false);
  });

  test("a relative deny hook is refused before it can be resolved by anyone", () => {
    // The second half of the rule, and the half containment alone cannot carry.
    // A relative path is not inside the workspace *here* -- it is not anywhere
    // until somebody resolves it, and the somebody is Claude, running the
    // PreToolUse command with the WORKTREE as its working directory. So
    // `./hook.py`, which looks safe from the operator's shell, is
    // `<workspace>/hook.py` when it is finally executed. The lap already
    // learned this on the worker's own command: remove the resolution rather
    // than reimplement whoever else's rules would have performed it.
    //
    // **The spelling matters, and a plain `./hook.py` would have been a weaker
    // case.** With the rule removed, a relative path naming nothing is refused
    // by the older `hook-unresolvable` guard -- a failure, but not this one, and
    // one that would let the rule be deleted while the case still went red for
    // the wrong reason. So the path names a file that really is there *from
    // this process's directory*: without the rule the fence renders, publishes,
    // and records a successful materialisation whose PreToolUse command is a
    // relative string the worker's Claude will resolve inside its own worktree.
    //
    // **It names a file in the checkout rather than one in the case's temporary
    // directory, and that is a Windows constraint rather than a preference.**
    // `relative()` between two different DRIVES has no relative answer and
    // returns an absolute path -- and on a Windows runner the checkout is
    // commonly on `D:` while `tmpdir()` is on `C:`, so a path built that way
    // would arrive here already absolute, be accepted, and fail the cell. This
    // repository's own `package.json` is on the same drive as the working
    // directory by construction, because the working directory is this
    // repository. It is only ever read.
    const f = fixture("materialize-hook-relative");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fence: { ...f.request.fence, hookScript: "package.json" },
        }),
      WorkspaceMaterializationUsageError,
      /fence\.hook_script must be a fully qualified absolute path/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a relative hook interpreter is refused, however real it is from here", () => {
    // The interpreter decides what the hook does, so it is the same rule one
    // step out -- and the same trap in the case that carries it. The renderer
    // already refuses a launcher it cannot execute, but it asks that question
    // from THIS process's directory, which is precisely the directory the
    // command will not be run from. So the spelling here is a real, executable
    // file named relatively: without the rule the launcher check passes, the
    // fence publishes a relative interpreter, and the worker's Claude resolves
    // it inside the worktree.
    //
    // A bare `python3` would have been the weaker case for the same reason the
    // hook's was -- refused, but by the wrong guard. The bare-name half of the
    // rule is carried by the endpoint interpreter below, where nothing else
    // looks at the value at all.
    //
    // **`relative(cwd, process.execPath)` was the first spelling and is wrong on
    // Windows**, for the reason the hook's case above gives: a runner whose
    // checkout is on `D:` and whose Node is on `C:` has no relative path between
    // them, so `relative` returns an ABSOLUTE one and the case stops testing
    // what it says. The runner's own launcher is inside the checkout, hence on
    // the working directory's drive by construction -- and it is certainly
    // present and executable, because it is what is running this test.
    const f = fixture("materialize-python-relative");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          fence: { ...f.request.fence, python: join("node_modules", ".bin", "vitest") },
        }),
      WorkspaceMaterializationUsageError,
      /fence\.python must be a fully qualified absolute path/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("a bare endpoint interpreter is refused too", () => {
    // `endpoint.node` was the one launcher field validated only for being
    // quotable text, and nothing downstream looks at it at all -- so without
    // the rule this materialisation SUCCEEDS and writes `"command": "node"`
    // into `mcp.json`. That is a name resolved through a `PATH` this process
    // does not own and cannot inspect, whose entries may be relative and whose
    // EMPTY entry means the current directory on POSIX -- and the current
    // directory, for the process that runs this command, is the worktree.
    const f = fixture("materialize-node-bare");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, node: "node" },
        }),
      WorkspaceMaterializationUsageError,
      /endpoint\.node must be a fully qualified absolute path/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the defaults are outside the worktree (the anti-vacuity half)", () => {
    // Without this, every refusal above is satisfied by a materialiser that
    // refuses unconditionally -- and, more usefully, it pins that the BUNDLED
    // hook and this build's own interpreter still pass the rule the overrides
    // are judged by. A guard that refused the shipped default would be found
    // here rather than in production.
    const f = fixture("materialize-warded-defaults");
    const materialized = materializeWorkspace(f.connection, f.request);
    expect(isInside(materialized.plan.settingsPath, f.workspace)).toBe(false);
    expect(existsSync(join(f.workspace, "README.md"))).toBe(true);
  });
});

describe("the clock is taken once", () => {
  test("mutating the request afterwards cannot move the orchestrator's clock", () => {
    // `readonly` is a compile-time claim and freezes nothing. A `nowMs` that
    // re-read the request on every call would let a later mutation put the
    // session's instant somewhere the recorded event does not say.
    const f = fixture("materialize-clock");
    const mutable = { ...f.request };
    const materialized = materializeWorkspace(f.connection, mutable);

    (mutable as { nowMs: number }).nowMs = T0 + 999_999;
    expect(materialized.options.nowMs()).toBe(T0);

    const row = materializationEvents(f.connection)[0] as Record<string, unknown>;
    expect(row["occurred_at_ms"]).toBe(materialized.options.nowMs());
  });
});

describe("a git question that git cannot answer is not a 'no'", () => {
  test("branchExists raises outside a repository rather than answering 'absent'", () => {
    // `show-ref --verify --quiet` exits 1 for a missing ref and 128 when it
    // cannot look at all -- measured, both codes, in this repository's own
    // suite below. Collapsing every non-zero status to `false` is the fail-open
    // direction wearing the fail-closed one's clothes: an operator would be
    // sent to check a branch name while the real problem is the repository, and
    // git's diagnostic would be discarded on the way.
    const outside = caseRoot("materialize-not-a-repo");
    expectRefusal(
      () => branchExists(BASE_BRANCH, { cwd: outside, timeoutMs: 60_000 }),
      GitCommandFailed,
      /neither yes \(0\) nor no \(1\)/,
    );
  });

  test("a genuinely absent branch is still 'no' (the anti-vacuity half)", () => {
    // Without this, a `branchExists` that raised on everything would pass the
    // case above -- and every M1 refusal in this file would then be refusing
    // for the wrong reason.
    const f = fixture("materialize-absent-branch");
    expect(branchExists("definitely-not-a-branch", f.git)).toBe(false);
    expect(branchExists(BASE_BRANCH, f.git)).toBe(true);
  });
});

describe("what the admitted intent may carry, this step must accept", () => {
  // `LapRunIntent` (D-0055) holds only the run identifier to printable ASCII; a
  // workspace, a role and a branch may be non-ASCII, and the prompt may carry
  // newlines. This organization has repositories under paths with Japanese in
  // them and writes its prompts in Japanese, so a step 7 that applied the
  // run-id rule to every field would refuse work `run admit` accepted --
  // silently, in the sense that nothing about the request looks wrong.
  //
  // The literals here are `\u` escapes rather than the characters themselves:
  // `test/contract/ascii-output-policy.test.ts` scans this tree for non-ASCII
  // bytes, and the point of the case is the runtime value, not the source byte.
  const JAPANESE_DIR = "\u4f5c\u696d"; // "sagyou" -- work
  const JAPANESE_BRANCH = "feat/\u65e5\u672c\u8a9e";
  const JAPANESE_PROMPT =
    "\u4f5c\u696d\u3092\u9032\u3081\u3066\u304f\u3060\u3055\u3044\n\n- \u4e00\u3064\u76ee";

  test("a Japanese workspace path, branch, role and multiline prompt all materialise", () => {
    const f = fixture("materialize-non-ascii");
    const workspace = join(f.root, JAPANESE_DIR, "worktree");
    const artifactDir = join(f.root, JAPANESE_DIR, "artifacts");

    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      workspace,
      artifactDir,
      topicBranch: JAPANESE_BRANCH,
      prompt: JAPANESE_PROMPT,
    });

    expect(materialized.workspace).toBe(workspace);
    expect(materialized.topicBranch).toBe(JAPANESE_BRANCH);
    expect(existsSync(join(workspace, "README.md"))).toBe(true);
    expect((materialized.options.settings as Record<string, unknown>)["prompt"]).toBe(
      JAPANESE_PROMPT,
    );

    // And the durable payload stays ASCII, because `pythonJsonDocumentSorted`
    // escapes from U+007F up the way `json.dumps` does -- which is what makes
    // accepting these values safe rather than merely permissive.
    const row = materializationEvents(f.connection)[0] as Record<string, unknown>;
    const payload = row["payload"] as string;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of raw bytes
    expect(/[^\x00-\x7f]/.test(payload)).toBe(false);
    expect(JSON.parse(payload)["topic_branch"]).toBe(JAPANESE_BRANCH);
  });

  test("a control character in a branch name is still refused", () => {
    // The half that keeps the rule a rule. A value that ends a line or moves a
    // cursor cannot appear in a later report as the string the database holds,
    // which is `D-0055`'s reason and not one non-ASCII text shares.
    const f = fixture("materialize-control-char");
    expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, topicBranch: "feat/a\u0007b" }),
      WorkspaceMaterializationUsageError,
      /must not contain a control character/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });
});

describe("the worker polls the database this materialisation wrote to", () => {
  test("the endpoint database is derived from the connection when none is given", () => {
    // Derivation rather than validation as the default: with no override the
    // question cannot be got wrong.
    const f = fixture("materialize-db-derived");
    const { databasePath: _dropped, ...endpointWithoutDb } = f.request.endpoint;
    materializeWorkspace(f.connection, { ...f.request, endpoint: endpointWithoutDb });

    const document = JSON.parse(
      readFileSync(join(f.artifactDir, MCP_CONFIG_FILENAME), "utf8"),
    ) as Record<string, Record<string, Record<string, Record<string, string>>>>;
    const env = document["mcpServers"]?.[MCP_SERVER_NAME]?.["env"];
    expect(env?.["INTERLOCK_MESSAGEBUS_DB"]).toBe(resolve(f.databasePath));
  });

  test("an endpoint pointed at a different control plane is refused", () => {
    // The failure that looks most like working: a second, perfectly valid
    // production plane passes every check `EndpointConfig` makes, the endpoint
    // starts cleanly, and the worker waits forever on a queue this run's
    // messages are not in.
    const f = fixture("materialize-db-mismatch");
    const other = join(f.root, "other.sqlite3");
    createProductionControlPlane(other, { nowMs: T0 }).close();

    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, databasePath: other },
        }),
      WorkspaceMaterializationUsageError,
      /is not the control plane this materialisation writes to/,
    );
    expect(existsSync(f.workspace)).toBe(false);
    expect(materializationEvents(f.connection)).toEqual([]);
  });

  test("an in-memory control plane is refused, because no worker can open it", () => {
    const f = fixture("materialize-db-memory");
    const memory = new Database(MEMORY);
    onTestFinished(() => {
      memory.close();
    });
    expectRefusal(
      () => materializeWorkspace(memory, f.request),
      WorkspaceMaterializationUsageError,
      /has no file behind it/,
    );
  });
});

describe("path identity is one rule, and the platform decides what it says", () => {
  /**
   * **The Windows halves of these two rules are not simulated here, and the
   * reason is worth stating rather than leaving as an omission.**
   *
   * `pathIdentity` folds case on Windows and `isFullyQualified` demands a drive
   * or a UNC share there; both branch on `process.platform`. Stubbing that
   * property does NOT produce a Windows world, because `node:path` binds its
   * flavour at module load -- `join` and `parse` stay POSIX while the branch
   * goes Windows, so a stubbed case either refuses for the wrong reason (a
   * POSIX absolute path is not win32-fully-qualified) or builds paths the
   * Windows branch cannot recognise. A case written that way would assert
   * against a world that exists on no machine.
   *
   * What does cover them: the `windows-latest` cell runs this whole file, where
   * every fixture path goes through `isFullyQualified`'s Windows branch and
   * every artifact path through the folded comparison. The *negative* Windows
   * cases -- a drive-relative module path, two artifacts differing only in case
   * -- are asserted by neither cell, and that is a known limit rather than a
   * covered one.
   *
   * The POSIX half below is not a consolation prize: it is what stops the fold
   * from being applied where it is wrong. Distinctness itself, with no platform
   * question in it, is asserted by "a fence ledger aliasing another artifact is
   * refused" above.
   */
  test("two paths differing only in case are two files here, and both are materialised", () => {
    if (process.platform === "win32") {
      // On an NTFS volume these two ARE one file, and the distinctness check is
      // right to refuse them -- which is the assertion this case cannot make
      // and the Windows cell makes for free by running everything else.
      return;
    }
    const f = fixture("materialize-posix-case");
    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      fenceLedgerPath: join(f.artifactDir, FENCE_FILENAME.toUpperCase()),
    });
    expect(materialized.eventSeq).toBeGreaterThan(0);
    expect(existsSync(join(f.artifactDir, FENCE_FILENAME))).toBe(true);
    expect(existsSync(join(f.artifactDir, FENCE_FILENAME.toUpperCase()))).toBe(true);
  });
});

describe("the admitted run's own CLI arguments survive", () => {
  test("they reach the child, before the flags this step generates", () => {
    // `LapRunIntent` carries cliArgs and the provider consumes them through
    // settings["cli_args"]. A materialiser that overwrote that key would drop
    // half the durable execution intent between the record and the child --
    // silently, because `cli_args` would still be present and would still look
    // right, carrying only the flags this step generated.
    const f = fixture("materialize-cli-args");
    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      cliArgs: ["--model", "sonnet"],
    });

    const cliArgs = (materialized.options.settings as Record<string, unknown>)[
      "cli_args"
    ] as string[];
    expect(cliArgs.slice(0, 2)).toEqual(["--model", "sonnet"]);
    // The generated flags come after, so a parser resolving a repeated option
    // last-wins resolves it in the fence's favour.
    const fenceFlags = materialized.plan.cliArgs();
    expect(cliArgs.slice(2, 2 + fenceFlags.length)).toEqual(fenceFlags);
    expect(cliArgs.slice(2 + fenceFlags.length)).toEqual([
      "--mcp-config",
      join(f.artifactDir, MCP_CONFIG_FILENAME),
      "--strict-mcp-config",
    ]);
  });

  test("an empty argument is carried, because the intent permits one", () => {
    // `LapRunIntent` allows an empty string as an argv element in as many words
    // -- "refusing it would be a rule this record invented" -- so an intent
    // with `cliArgs: [""]` is admitted and must then be materialisable. This is
    // the SECOND time this module was stricter than the record it consumes (the
    // first refused non-ASCII paths), which is why D-0057 states the general
    // form rather than only the instance.
    const f = fixture("materialize-cli-args-empty");
    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      cliArgs: ["--append-system-prompt", ""],
    });
    const cliArgs = (materialized.options.settings as Record<string, unknown>)[
      "cli_args"
    ] as string[];
    expect(cliArgs.slice(0, 2)).toEqual(["--append-system-prompt", ""]);
  });

  test("a control character in an argument is still refused", () => {
    // The rule the record actually applies, and the half that keeps it a rule.
    const f = fixture("materialize-cli-args-control");
    expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, cliArgs: ["--model", "a\u0007b"] }),
      WorkspaceMaterializationUsageError,
      /must not contain a control character/,
    );
  });

  test("an argument repeating a flag the fence owns is refused", () => {
    // The first line of defence. Ordering is the second, and cannot be the
    // only one: which occurrence a CLI honours is a property of a program this
    // repository does not own, and a fence resting on that is resting on a
    // guess. Both spellings are checked, because a rejection that knew one
    // would be a rejection with a doorway in it.
    const f = fixture("materialize-cli-args-fence");
    for (const argument of ["--permission-mode", "--permission-mode=bypassPermissions"]) {
      expectRefusal(
        () => materializeWorkspace(f.connection, { ...f.request, cliArgs: [argument] }),
        WorkspaceMaterializationUsageError,
        /repeats --permission-mode/,
      );
    }
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the two flags that remove the surroundings are owned by the fence too", () => {
    // `D-0081`. `--setting-sources` and `--strict-mcp-config` are not more
    // configuration for the child: each one is what makes one of the other
    // flags exclusive rather than additive. An operator argument restating
    // either would put the target repository's own settings, or its own MCP
    // servers, back underneath a fence that had just excluded them -- which is
    // the defect they close, arriving through the one door the fence leaves
    // open. Both spellings, for the reason the case above gives.
    const f = fixture("materialize-cli-args-hermetic");
    for (const argument of [
      "--setting-sources",
      "--setting-sources=user,project,local",
      "--strict-mcp-config",
      "--strict-mcp-config=false",
    ]) {
      expectRefusal(
        () => materializeWorkspace(f.connection, { ...f.request, cliArgs: [argument] }),
        WorkspaceMaterializationUsageError,
        /repeats --(setting-sources|strict-mcp-config)/,
      );
    }
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("no arguments means only the generated flags (the anti-vacuity half)", () => {
    const f = fixture("materialize-cli-args-none");
    const materialized = materializeWorkspace(f.connection, f.request);
    const cliArgs = (materialized.options.settings as Record<string, unknown>)[
      "cli_args"
    ] as string[];
    const fenceFlags = materialized.plan.cliArgs();
    expect(cliArgs.slice(0, fenceFlags.length)).toEqual(fenceFlags);
  });
});

describe("materialisation evidence cannot be forged", () => {
  test("a MaterializedWorkspace cannot be constructed outside the materializer", () => {
    // Its whole claim is that `workspace` names a checkout git made and
    // artifacts this step published -- the evidence half of step 8's veto. A
    // value anyone could construct for an arbitrary directory is evidence of
    // nothing, and an observer keyed on it would admit bare directories while
    // believing it had ruled them out.
    const f = fixture("materialize-forge");
    const real = materializeWorkspace(f.connection, f.request);

    const forge = MaterializedWorkspace as unknown as new (
      mint: symbol,
      fields: Record<string, unknown>,
    ) => MaterializedWorkspace;
    expect(() => new forge(Symbol("not the mint"), { ...real })).toThrow(
      /produced by materializeWorkspace and nowhere else/,
    );
  });
});

describe("git operates on the repository the request names", () => {
  test("an inherited GIT_DIR does not redirect the work", () => {
    // git sets GIT_DIR (and friends) for every hook it runs, so a materialiser
    // invoked from a post-commit or pre-push would inherit one. With it set,
    // git ignores `cwd`'s repository and uses the named one -- so the worktree
    // would be created in whichever repository invoked the hook while every
    // refusal and every event payload named the one the request asked for.
    // git would succeed, which is why nothing downstream could catch it.
    const f = fixture("materialize-git-dir");
    const decoy = join(f.root, "decoy");
    initRepository(decoy);

    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      env: { ...process.env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy },
    });

    // The repository git actually operated on is the requested one...
    expect(materialized.repository).toBe(
      runGitChecked(["rev-parse", "--path-format=absolute", "--show-toplevel"], f.git).stdout,
    );
    // ...and the branch was created there, not in the decoy.
    expect(branchExists(TOPIC_BRANCH, f.git)).toBe(true);
    expect(branchExists(TOPIC_BRANCH, { cwd: decoy, timeoutMs: 60_000 })).toBe(false);
  });

  test("the operator's other variables still reach git (the anti-vacuity half)", () => {
    // The rule is narrow on purpose: "which repository" is this module's to
    // decide and everything else is the operator's. A pin that stripped the
    // environment wholesale would break credentials and configuration, and
    // would pass the case above for the wrong reason.
    const f = fixture("materialize-git-env");
    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      env: { ...process.env, GIT_AUTHOR_NAME: "kept" },
    });
    expect(existsSync(join(materialized.workspace, "README.md"))).toBe(true);
  });
});

describe("the endpoint database may be reached by another name", () => {
  test("a symlink to the control plane is accepted", () => {
    // The documented alias case. `realpathSync` resolves it, so this is the
    // cheap half -- but it is the half that says the check is about file
    // identity rather than about spelling.
    const f = fixture("materialize-db-symlink");
    const link = join(f.root, "plane-link.sqlite3");
    try {
      symlinkSync(f.databasePath, link);
    } catch {
      // Windows without developer mode refuses to create a symlink. The case
      // asserts nothing there rather than asserting something weaker.
      return;
    }

    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      endpoint: { ...f.request.endpoint, databasePath: link },
    });
    expect(materialized.eventSeq).toBeGreaterThan(0);
  });

  test("a hard link to the control plane is refused, and that is deliberate", () => {
    // File identity is not enough for THIS database. The control plane runs on
    // a rollback journal, not WAL (connection.ts records why WAL is refused),
    // and SQLite derives `<path>-journal` from the spelling the database was
    // opened with -- so two hard links are two databases as far as recovery is
    // concerned: each writer keeps its own journal and, after a crash, one path
    // cannot see the other's hot journal. The bytes are shared and the recovery
    // is not, which is worse than two separate databases because it looks like
    // one.
    //
    // An earlier revision accepted this on `(device, inode)` equality. This
    // case is the correction, and it asserts a refusal rather than an
    // acceptance for that reason.
    const f = fixture("materialize-db-hardlink");
    const alias = join(f.root, "plane-alias.sqlite3");
    try {
      linkSync(f.databasePath, alias);
    } catch {
      // Some filesystems refuse hard links. Nothing is asserted there rather
      // than something weaker.
      return;
    }

    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          endpoint: { ...f.request.endpoint, databasePath: alias },
        }),
      WorkspaceMaterializationUsageError,
      /is not the control plane this materialisation writes to/,
    );
    expect(existsSync(f.workspace)).toBe(false);
  });

  test("the endpoint database is SQLite's resolved path, not the caller's spelling", () => {
    // `connection.name` is the string the driver was handed, verbatim. A
    // connection opened relatively keeps that string forever, so a process that
    // changed directory in between would resolve it against the NEW working
    // directory and configure the worker for a different database, or none.
    // Deriving from the connection is only safe if it comes from the
    // connection -- `PRAGMA database_list` gives SQLite's own resolution.
    //
    // The directory change is the whole point of the case, so it is made for
    // real. That is sound where stubbing `process.platform` was not: the
    // working directory is genuine process state rather than a value some
    // module bound at load, tests are not concurrent within a file
    // (`docs/testing.md`), files run in their own workers, and it is restored
    // whether this passes or fails.
    const f = fixture("materialize-db-relative");
    const relativeName = relative(process.cwd(), f.databasePath);
    if (isAbsolute(relativeName)) {
      // `path.relative` returns an ABSOLUTE path when the two sides are on
      // different Windows drives, which is the ordinary arrangement on a CI
      // runner: the checkout is on one drive and TMPDIR on another. The case's
      // premise -- a connection opened with a relative filename -- cannot be
      // built there, so it asserts nothing rather than something weaker.
      return;
    }
    const relativelyOpened = new Database(relativeName);
    onTestFinished(() => {
      relativelyOpened.close();
    });
    expect(relativelyOpened.name).toBe(relativeName);

    // Deeper than the original working directory, deliberately. A shallower
    // target would let `..` clamp at the filesystem root and resolve the stale
    // relative spelling back onto the right file by accident, and the case
    // would pass against the bug it exists to catch.
    const deep = join(f.root, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l");
    mkdirSync(deep, { recursive: true });
    const before = process.cwd();
    onTestFinished(() => {
      process.chdir(before);
    });
    process.chdir(deep);

    materializeWorkspace(relativelyOpened, f.request);

    const document = JSON.parse(
      readFileSync(join(f.artifactDir, MCP_CONFIG_FILENAME), "utf8"),
    ) as Record<string, Record<string, Record<string, Record<string, string>>>>;
    const configured =
      document["mcpServers"]?.[MCP_SERVER_NAME]?.["env"]?.["INTERLOCK_MESSAGEBUS_DB"];
    expect(configured).toBe(resolve(f.databasePath));
    // And it is not what resolving the stale relative spelling here would give,
    // which is the value the bug produced. Guarded, because `..` clamps at the
    // filesystem root: if the deep directory is not deeper than the original
    // working directory, the stale resolution lands back on the right file by
    // accident and this assertion would pass against the bug.
    const stale = resolve(relativeName);
    if (stale !== resolve(f.databasePath)) {
      expect(configured).not.toBe(stale);
    }
  });
});

describe("the event describes a workspace that is still a checkout", () => {
  test("the recorded workspace is the worktree's own root, per git", () => {
    // The final sweep asks git -- not `existsSync` -- whether `workspace` is
    // still a worktree, and whether it is that worktree's ROOT. Both halves
    // matter: a concurrent cleanup between `git worktree add` and the append
    // would leave the three files intact and the checkout gone, and "the
    // directory exists" is also true of the bare directory the provider would
    // have made, which is precisely what this event must not be recorded for.
    //
    // **The negative branch has no in-process seam and is not asserted here.**
    // Nothing runs between the worktree's creation and the sweep that a test
    // could hook, and manufacturing one would mean adding a test-only door to
    // the production path for a check whose whole purpose is to have no doors.
    // What is asserted is that the sweep really consults git and really agrees
    // with the recorded value -- so a check comparing the wrong paths, or
    // asking the wrong question, fails here.
    const f = fixture("materialize-worktree-root");
    const materialized = materializeWorkspace(f.connection, f.request);

    // Compared through `realpathSync.native`, not by spelling. git reports the
    // long form of a path whose 8.3 short form the request carried, so a
    // `resolve`-only comparison here would assert the very thing the production
    // code had to stop doing -- and did, on Windows CI, while the code under
    // test was already right.
    const rootPerGit = repositoryRoot({ cwd: materialized.workspace, timeoutMs: 60_000 });
    expect(realpathSync.native(rootPerGit)).toBe(realpathSync.native(materialized.workspace));
    // And it is a different repository root from the one the request named, so
    // the comparison above is not trivially true of any path.
    expect(materialized.workspace).not.toBe(materialized.repository);
  });

  test("a workspace reached through a symlinked parent is still its own root", () => {
    // Two spellings of one directory must not read as two directories. Windows
    // CI found this the expensive way: `TMPDIR` on a GitHub runner is an 8.3
    // short path (`C:\\Users\\RUNNER~1\\...`) while git reports the long form,
    // and `resolve` normalises separators without expanding the short name -- so
    // the final sweep refused a workspace that WAS the worktree's own root,
    // after the worktree and every artifact had been created. A false refusal at
    // the last step is the worst place for one.
    //
    // The 8.3 case cannot be built on Linux. A symlinked parent is the same
    // defect in the form this cell can reach: one directory, two spellings, and
    // only a resolving comparison gets it right.
    const f = fixture("materialize-symlinked-parent");
    const real = join(f.root, "real");
    const link = join(f.root, "via-link");
    mkdirSync(real, { recursive: true });
    try {
      symlinkSync(real, link, "dir");
    } catch {
      // Windows without developer mode refuses to create a directory symlink.
      // The case asserts nothing there rather than something weaker; the cell
      // that needs this property most is covered by the 8.3 path it hits for
      // real.
      return;
    }

    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      workspace: join(link, "worktree"),
      artifactDir: join(link, "artifacts"),
    });
    expect(materialized.eventSeq).toBeGreaterThan(0);
    expect(existsSync(join(link, "worktree", "README.md"))).toBe(true);
  });

  test("an endpoint database reached through a symlinked parent is accepted", () => {
    // The same comparison, at the other site that uses it. Keeping them one
    // rule is the point: two spellings of one database must not be read as two
    // control planes any more than two spellings of one worktree are.
    const f = fixture("materialize-db-symlinked-parent");
    const linkDir = join(f.root, "plane-link");
    try {
      symlinkSync(f.root, linkDir, "dir");
    } catch {
      return;
    }

    const materialized = materializeWorkspace(f.connection, {
      ...f.request,
      endpoint: {
        ...f.request.endpoint,
        databasePath: join(linkDir, "production.sqlite3"),
      },
    });
    expect(materialized.eventSeq).toBeGreaterThan(0);
  });

  test("removing the worktree afterwards leaves a path git no longer owns", () => {
    // The state a sweeper leaves behind, and the reason the sweep's question is
    // git's rather than the filesystem's: after `removeWorktree` the directory
    // is gone and git disowns the path, which is what the refusal branch keys
    // on.
    const f = fixture("materialize-worktree-swept");
    const materialized = materializeWorkspace(f.connection, f.request);

    removeWorktree(materialized.workspace, f.git);
    expect(existsSync(materialized.workspace)).toBe(false);
    expect(() => repositoryRoot({ cwd: materialized.workspace, timeoutMs: 60_000 })).toThrow();
  });
});

describe("an artifact directory belongs to one materialisation", () => {
  test("a directory already holding artifacts is refused before the worktree exists", () => {
    // Two runs pointed at one artifact directory: without this, the second's
    // `prepare` publishes over the first's fence and settings -- and the first's
    // worker may be running under them right now. The same shape `git worktree
    // add` already imposes on the checkout, applied to the directory beside it.
    const f = fixture("materialize-artifactdir-claimed");
    const first = materializeWorkspace(f.connection, f.request);
    expect(existsSync(first.plan.fencePath)).toBe(true);

    const secondWorkspace = join(f.root, "worktree-2");
    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          runId: RUN_ID,
          workspace: secondWorkspace,
          topicBranch: "feat/topic-2",
        }),
      WorkspaceMaterializationRefused,
      /which already exists/,
    );

    // Nothing of the second run was created, and -- the point of the case --
    // the FIRST run's artifacts are untouched.
    expect(existsSync(secondWorkspace)).toBe(false);
    expect(branchExists("feat/topic-2", f.git)).toBe(false);
    expect(readFileSync(first.plan.fencePath, "utf8")).toBe(
      readFileSync(join(f.artifactDir, FENCE_FILENAME), "utf8"),
    );
  });

  test("the refusal comes before the worktree, not after it", () => {
    // A retry of one run with a different workspace reaches the duplicate-event
    // refusal eventually -- but only after `prepare` has replaced the earlier
    // materialisation's files. Ordering this check ahead of `git worktree add`
    // is what stops a failing call from destroying a successful one's artifacts.
    const f = fixture("materialize-artifactdir-order");
    materializeWorkspace(f.connection, f.request);
    const fenceBefore = readFileSync(join(f.artifactDir, FENCE_FILENAME), "utf8");

    expectRefusal(
      () =>
        materializeWorkspace(f.connection, {
          ...f.request,
          workspace: join(f.root, "worktree-3"),
          topicBranch: "feat/topic-3",
        }),
      WorkspaceMaterializationRefused,
      /which already exists/,
    );
    expect(readFileSync(join(f.artifactDir, FENCE_FILENAME), "utf8")).toBe(fenceBefore);
  });
});

describe("the git adapter's own refusals", () => {
  test("a zero timeout is refused rather than becoming no timeout", () => {
    // Node treats `timeout: 0` as NO timeout, so a caller passing it would get
    // an unbounded, uninterruptible synchronous call from a function whose
    // docstring promises a wall-clock bound.
    const f = fixture("materialize-timeout-zero");
    expectRefusal(
      () => branchExists(BASE_BRANCH, { cwd: f.repository, timeoutMs: 0 }),
      GitRefusal,
      /must be a positive integer/,
    );
  });

  test("a non-integer timeout is refused inside this module's vocabulary", () => {
    const f = fixture("materialize-timeout-fractional");
    expectRefusal(
      () => branchExists(BASE_BRANCH, { cwd: f.repository, timeoutMs: 1.5 }),
      GitRefusal,
      /must be a positive integer/,
    );
  });

  test("a git refusal quotes each argv element rather than joining them raw", () => {
    // Not an ASCII-escaping rule: `docs/cli-output-policy.md` governs what
    // continuo authors and says values it receives from outside "may of course
    // be non-ASCII", and D-0055 admits non-ASCII branches and paths because this
    // organization has repositories under them. Escaping them would make every
    // refusal about such a repository unreadable to the operator who owns it.
    //
    // What quoting buys is that the message survives a value containing a space
    // or a newline: a bare join renders one such branch name as two arguments,
    // or as two lines, which is the shape an operator misreads.
    const f = fixture("materialize-git-quoting");
    const awkward = "feat/two words";

    const refusal = expectRefusal(
      () => runGitChecked(["rev-parse", "--verify", `refs/heads/${awkward}`], f.git),
      GitCommandFailed,
    );
    expect(refusal.message).toContain("'refs/heads/feat/two words'");
    // The elements stay separable: the quoted form is what makes the space
    // inside one argument distinguishable from the space between two.
    expect(refusal.message).toContain("'rev-parse' '--verify'");

    // And a non-ASCII branch name is carried through, not mangled.
    const japanese = "feat/\u65e5\u672c\u8a9e";
    const nonAscii = expectRefusal(
      () => runGitChecked(["rev-parse", "--verify", `refs/heads/${japanese}`], f.git),
      GitCommandFailed,
    );
    expect(nonAscii.message).toContain(japanese);
  });
});

describe("the request is validated before anything is created", () => {
  test("a relative workspace is refused", () => {
    const f = fixture("materialize-relative");
    expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, workspace: "relative/path" }),
      WorkspaceMaterializationUsageError,
      /must be a fully qualified absolute path/,
    );
  });

  test("a non-ASCII run id is refused", () => {
    const f = fixture("materialize-ascii");
    expectRefusal(
      () => materializeWorkspace(f.connection, { ...f.request, runId: "run-\u00e9" }),
      WorkspaceMaterializationUsageError,
      /printable ASCII/,
    );
  });
});

describe("the fence's writable surface is derived from the worktree's own git (D-0082)", () => {
  test("gitMetadataRoots names this worktree's admin dir, the shared store, this branch and packed-refs", () => {
    const f = fixture("materialize-git-roots");
    materializeWorkspace(f.connection, f.request);

    const worktreeGit: GitOptions = { ...f.git, cwd: f.workspace };
    const commonDir = runGitChecked(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      worktreeGit,
    ).stdout;
    const gitDir = runGitChecked(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      worktreeGit,
    ).stdout;

    // Asked of git rather than assembled from the layout, on both sides: a case
    // that spelled `<repo>/.git/worktrees/<basename>` by hand would agree with
    // an implementation that did the same and would be wrong with it.
    expect(gitMetadataRoots(worktreeGit)).toStrictEqual([
      gitDir,
      `${commonDir}/objects`,
      `${commonDir}/refs/heads/${TOPIC_BRANCH}`,
      `${commonDir}/packed-refs`,
    ]);
    // The premise the whole decision rests on: the worktree's git metadata is
    // NOT inside the worktree, so a writable surface that stops at the checkout
    // stops short of where `git add` writes.
    expect(gitDir.startsWith(f.workspace)).toBe(false);
  });

  test("an ambiguous short ref name does not move the branch path (codex review)", () => {
    const f = fixture("materialize-git-roots-ambiguous");
    materializeWorkspace(f.connection, f.request);

    const worktreeGit: GitOptions = { ...f.git, cwd: f.workspace };
    // A tag with the SAME name as the checked-out branch. `symbolic-ref --short`
    // abbreviates only as far as the name stays unambiguous, so with this in the
    // repository it answers `heads/feat/topic` -- and a `refs/heads` prefix put
    // back on that names `refs/heads/heads/feat/topic`, which is not the
    // branch's ref and is not anything.
    runGitChecked(["tag", TOPIC_BRANCH, "HEAD"], worktreeGit);

    const commonDir = runGitChecked(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      worktreeGit,
    ).stdout;
    expect(gitMetadataRoots(worktreeGit)).toContain(`${commonDir}/refs/heads/${TOPIC_BRANCH}`);
    expect(gitMetadataRoots(worktreeGit).some((root) => root.includes("heads/heads/"))).toBe(false);
  });

  test("a detached HEAD contributes no branch ref rather than refs/heads/HEAD", () => {
    const f = fixture("materialize-git-roots-detached");
    materializeWorkspace(f.connection, f.request);

    const worktreeGit: GitOptions = { ...f.git, cwd: f.workspace };
    runGitChecked(["checkout", "--detach", "HEAD"], worktreeGit);

    const roots = gitMetadataRoots(worktreeGit);
    expect(roots.some((root) => root.includes("refs/heads/"))).toBe(false);
    // The other three are unaffected: a detached checkout still stages and
    // still writes objects.
    expect(roots).toHaveLength(3);
  });

  test("the published settings carry them, switched on and spelled in strings", () => {
    const f = fixture("materialize-settings-sandbox");
    materializeWorkspace(f.connection, f.request);

    const settings = JSON.parse(
      readFileSync(join(f.artifactDir, "settings.local.json"), "utf8"),
    ) as Record<string, unknown>;
    const sandbox = settings["sandbox"] as Record<string, unknown>;
    const filesystem = sandbox["filesystem"] as Record<string, unknown>;

    // Without this the CLI builds no sandbox at all, and the deny entries
    // beside it are inert (D-0082).
    expect(sandbox["enabled"]).toBe(true);
    // The union the materialiser derived, verbatim -- this is the acceptance's
    // "derived from the worktree's actual .git pointer, not hard-coded".
    expect(filesystem["additionalDirectories"]).toStrictEqual([
      ...gitMetadataRoots({ ...f.git, cwd: f.workspace }),
    ]);
    // And the shape the CLI can actually read: one structured entry anywhere in
    // here turns the sandbox off silently, which is what `#130` was.
    for (const key of ["denyRead", "denyWrite"]) {
      for (const entry of filesystem[key] as unknown[]) {
        expect(typeof entry).toBe("string");
      }
    }
  });

  test("the fence ledger records the area that was opened, as paths", () => {
    const f = fixture("materialize-ledger-roots");
    materializeWorkspace(f.connection, f.request);

    const admitted = readFileSync(join(f.artifactDir, "fence-ledger.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row["event"] === "spawn-admitted");

    expect(admitted).toHaveLength(1);
    expect((admitted[0] as Record<string, unknown>)["sandbox_writable_roots"]).toStrictEqual([
      ...gitMetadataRoots({ ...f.git, cwd: f.workspace }),
    ]);
  });
});
