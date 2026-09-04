/**
 * `LapRunIntent`: the lap-scoped execution intent `continuo run admit` fixes,
 * and the field rules its constructor is the only holder of.
 *
 * **Target-only.** Interlock has no counterpart: it has no delegation record of
 * any kind, no `run` subtree and no admission writer, so there is no source
 * node id to port and no parity ledger claims this file. The only ledger it
 * touches is `parity/gate_item11.no-provider-detail-leaks.ledger.json`, whose
 * directory walk picks it up like every other file under `test/control_plane/`.
 * Rule 10 of `docs/test-translation-conventions.md` applies: each case names
 * what would be silently wrong without it.
 *
 * What these cases are for, in the order they appear:
 *
 * * **Construction is validation, and there is no other way in.** The type
 *   carries a private field, so an object literal does not satisfy it, and
 *   `admitRun` therefore keeps no field rules of its own. That property is only
 *   worth anything if the constructor actually refuses -- so every field has a
 *   case, and each says which failure it is standing in front of.
 * * **The rules differ by field, on purpose.** `runId` is printable ASCII
 *   because it is printed back; `prompt` is held to nothing but non-emptiness
 *   because it is prose this organization writes in Japanese; `workspace` must
 *   be absolute because a later process reads it with a working directory of
 *   its own. A suite that checked one rule everywhere would pass against a
 *   record that refused a legitimate Japanese prompt, which is the failure most
 *   likely to be found in production rather than here.
 * * **The record is frozen and its payload is fixed at construction.** `D-0055`
 *   turns on the intent being immutable -- what happens after admission is a
 *   later fact in a later event, never a correction of this one.
 * * **The record carries no authority.** Asserted structurally, because the
 *   name is the whole defence: a field called `holder`, `principal` or
 *   `permissions` appearing here is how a lap-scoped work statement quietly
 *   becomes a permission model.
 */

import { resolve, win32 } from "node:path";
import { describe, expect, test } from "vitest";

import {
  FENCE_OWNED_FLAGS,
  LapRunIntent,
  type LapRunIntentFields,
  LapRunIntentUsageError,
} from "../../src/control_plane/lap_run_intent.js";
import { expectRefusal } from "../testkit/errors.js";

/** A flag spelled for a `RegExp`, so `--flag` cannot read as a quantifier. */
function escapeForRegExp(flag: string): string {
  return flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * An absolute path on whichever platform the suite is running on.
 *
 * `D-0003` puts Windows on the merge path and `isAbsolute` is the platform's,
 * so a written-down `/wt/run-1` is relative on `win32` and would make every
 * case in this file refuse for the wrong reason on one of the two cells the
 * double-green rule runs it on.
 */
const WORKSPACE = resolve("wt", "run-1");

/** A well-formed record, with one field replaced per case. */
function fields(overrides: Partial<LapRunIntentFields> = {}): LapRunIntentFields {
  return {
    runId: "run-1",
    leaseClaimantId: "secretary-1",
    workspace: WORKSPACE,
    role: "worker",
    baseBranch: "main",
    topicBranch: "feat/run-1",
    prompt: "port the thing",
    ...overrides,
  };
}

/** The seven field names, so a case can loop the ones a rule applies to. */
const QUOTABLE_FIELDS = [
  ["leaseClaimantId", "lease_claimant_id"],
  ["workspace", "workspace"],
  ["role", "role"],
  ["baseBranch", "base_branch"],
  ["topicBranch", "topic_branch"],
] as const;

// --------------------------------------------------------------------------
// a well-formed record
// --------------------------------------------------------------------------

describe("a well-formed intent keeps every value it was given", () => {
  test("carries each field back verbatim", () => {
    const intent = new LapRunIntent(fields({ cliArgs: ["--verbose", "--model=sonnet"] }));

    expect(intent.runId).toBe("run-1");
    expect(intent.leaseClaimantId).toBe("secretary-1");
    expect(intent.workspace).toBe(WORKSPACE);
    expect(intent.role).toBe("worker");
    expect(intent.baseBranch).toBe("main");
    expect(intent.topicBranch).toBe("feat/run-1");
    expect(intent.prompt).toBe("port the thing");
    expect(intent.cliArgs).toEqual(["--verbose", "--model=sonnet"]);
  });

  test("absent cli args become an empty list, not undefined", () => {
    // The record's one normalisation, and the reason it is here rather than at
    // the append site: a reader of the persisted payload must not have to tell
    // "this worker was given no arguments" from "this producer did not write
    // the key".
    const intent = new LapRunIntent(fields());

    expect(intent.cliArgs).toEqual([]);
  });

  test("is frozen, and its cli args cannot be pushed to", () => {
    // The immutability `D-0055` turns on. What comes after admission -- the
    // workspace that was actually created, the commit a base branch resolved to
    // -- is a later fact in a later event, never a correction of this record,
    // and the spine's own `event_rows_are_immutable` trigger says the same
    // thing about the row this becomes. A mutable record would make "correct it
    // in place" the obvious thing to reach for.
    const intent = new LapRunIntent(fields({ cliArgs: ["--verbose"] }));

    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.cliArgs)).toBe(true);
    expect(() => {
      (intent.cliArgs as string[]).push("--sneaky");
    }).toThrow(TypeError);
  });

  test("copies the cli args it was handed, rather than aliasing them", () => {
    // A caller's array is the caller's. Without the copy, a caller that reused
    // and mutated its own list after construction would change a record that is
    // supposed to be fixed -- and would change it after `admitRun` had already
    // persisted the old value, so the record in memory and the event on the
    // spine would disagree with nothing to say which was right.
    const supplied = ["--verbose"];
    const intent = new LapRunIntent(fields({ cliArgs: supplied }));

    supplied.push("--added-later");

    expect(intent.cliArgs).toEqual(["--verbose"]);
  });

  test("renders its payload once, and returns the same text every time", () => {
    const intent = new LapRunIntent(fields());

    expect(intent.payload).toBe(intent.payload);
    expect(JSON.parse(intent.payload)).toEqual({
      lease_claimant_id: "secretary-1",
      workspace: WORKSPACE,
      role: "worker",
      base_branch: "main",
      topic_branch: "feat/run-1",
      prompt: "port the thing",
      cli_args: [],
    });
  });
});

// --------------------------------------------------------------------------
// every field is required
// --------------------------------------------------------------------------

describe("every field of the record is required", () => {
  test.each([
    ["runId", "run_id"],
    ["leaseClaimantId", "lease_claimant_id"],
    ["workspace", "workspace"],
    ["role", "role"],
    ["baseBranch", "base_branch"],
    ["topicBranch", "topic_branch"],
    ["prompt", "prompt"],
  ])("refuses an empty %s", (field, spelling) => {
    // One case per field rather than one case for the record, because "the
    // record is complete" is a claim about each field and a loop that stopped
    // at the first would pass with the rest unchecked. The message names the
    // field in the payload's spelling, which is the one an operator reading the
    // event will have in front of them.
    expectRefusal(
      () => new LapRunIntent(fields({ [field]: "" })),
      LapRunIntentUsageError,
      `${spelling} must be a non-empty string`,
    );
  });

  test.each([
    ["runId", "run_id"],
    ["leaseClaimantId", "lease_claimant_id"],
    ["workspace", "workspace"],
    ["role", "role"],
    ["baseBranch", "base_branch"],
    ["topicBranch", "topic_branch"],
    ["prompt", "prompt"],
  ])("refuses a blank %s", (field, spelling) => {
    // Whitespace is not a value. Checked separately from the empty string
    // because a `length > 0` check passes it, and a record whose role is three
    // spaces is a record that satisfies every downstream non-empty check and
    // means nothing.
    expectRefusal(
      () => new LapRunIntent(fields({ [field]: "   " })),
      LapRunIntentUsageError,
      `${spelling} must be a non-empty string`,
    );
  });

  test("refuses a field that is not a string at all", () => {
    // Reachable from plain JavaScript and from a cast, neither of which the
    // type checker sees. The value is quoted back with `pythonRepr` so the
    // message says what actually arrived rather than `[object Object]`.
    expectRefusal(
      () => new LapRunIntent(fields({ role: 42 as unknown as string })),
      LapRunIntentUsageError,
      /role must be a non-empty string, got 42/,
    );
  });
});

// --------------------------------------------------------------------------
// the run identifier is printable ASCII
// --------------------------------------------------------------------------

describe("a run identifier is printable ASCII", () => {
  test.each([
    ["a newline", "run-1\nerror: forged"],
    ["a carriage return", "run-1\rerror: forged"],
    ["an escape sequence", `run-${String.fromCodePoint(0x1b)}[31m1`],
    ["a zero-width joiner", `run-${String.fromCodePoint(0x200d)}1`],
    // Non-ASCII is refused for the second reason the rule states: a cp932
    // console cannot encode it, and `D-0003` puts Windows on the merge path.
    // Constructed rather than typed, per `docs/cli-output-policy.md` -- this
    // source file stays ASCII, the value at runtime does not.
    ["an emoji", `run-${String.fromCodePoint(0x1f600)}`],
    ["a Japanese character", `run-${String.fromCodePoint(0x3042)}`],
  ])("refuses a run id carrying %s", (_label, runId) => {
    // `D-0051`'s rule, which moved here with the field. The identifier is
    // quoted verbatim into `run admit`'s one-line report and into the
    // `RunAlreadyAdmitted` message, both of which end at a single newline: an
    // identifier carrying its own newline makes the command appear to print a
    // second line -- `error: ` included -- and one the console cannot encode
    // makes it print none at all. Refusing here is what keeps the row, the
    // event and every report about them quoting one string.
    expectRefusal(
      () => new LapRunIntent(fields({ runId })),
      LapRunIntentUsageError,
      /must be printable ASCII/,
    );
  });

  test("accepts every printable ASCII character in a run id", () => {
    // The positive half, without which the rule above could be tightened to
    // "refuse everything" and every case in this block would still pass.
    const runId = Array.from({ length: 0x7e - 0x20 + 1 }, (_unused, index) =>
      String.fromCharCode(0x20 + index),
    ).join("");

    expect(new LapRunIntent(fields({ runId })).runId).toBe(runId);
  });
});

// --------------------------------------------------------------------------
// the other fields are quotable text, and the prompt is prose
// --------------------------------------------------------------------------

describe("a field that is quoted back cannot break the line it is quoted into", () => {
  test.each(QUOTABLE_FIELDS)("refuses a newline in %s", (field, spelling) => {
    expectRefusal(
      () => new LapRunIntent(fields({ [field]: "main\nerror: forged" })),
      LapRunIntentUsageError,
      `${spelling} must not contain a control character`,
    );
  });

  test.each(QUOTABLE_FIELDS)("refuses an escape sequence in %s", (field) => {
    expectRefusal(
      () => new LapRunIntent(fields({ [field]: `main${String.fromCodePoint(0x1b)}[31m` })),
      LapRunIntentUsageError,
      /must not contain a control character/,
    );
  });

  test.each(QUOTABLE_FIELDS)("accepts a non-ASCII %s", (field) => {
    // The rule is control characters, NOT the run id's printable-ASCII rule,
    // and the difference is deliberate: `docs/cli-output-policy.md` governs
    // what continuo authors and says in as many words that values it receives
    // from outside "may of course be non-ASCII". This organization has
    // repositories under paths with Japanese in them and roles named in
    // Japanese, so a printable-ASCII rule here would refuse work that exists.
    // Constructed rather than typed, so this source file stays ASCII.
    const value = `${WORKSPACE}-${String.fromCodePoint(0x65e5, 0x672c)}`;

    const intent = new LapRunIntent(fields({ [field]: value }));

    expect(intent[field]).toBe(value);
  });
});

describe("the prompt is prose and is held to nothing but non-emptiness", () => {
  test("accepts a prompt in Japanese", () => {
    // The field that proves the record does not push the CLI's ASCII rule onto
    // its payload. Without this case the whole record could be narrowed to
    // printable ASCII and every other test here would stay green, while the
    // organization that writes its prompts in Japanese could not admit a run.
    const prompt = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e);

    expect(new LapRunIntent(fields({ prompt })).prompt).toBe(prompt);
  });

  test("accepts a prompt spanning several lines", () => {
    // A newline is refused in a branch name and accepted here, and that is the
    // whole distinction: a branch name with a newline is a value no later
    // report can quote back, while a multi-line prompt is the ordinary shape of
    // an instruction. The payload renderer escapes it as `json.dumps` does, so
    // the stored column stays one line of ASCII either way.
    const prompt = "do the first thing\nthen the second";

    const intent = new LapRunIntent(fields({ prompt }));

    expect(intent.prompt).toBe(prompt);
    expect(intent.payload).toContain("do the first thing\\nthen the second");
  });
});

// --------------------------------------------------------------------------
// the workspace is a path a later reader can resolve
// --------------------------------------------------------------------------

describe("the workspace is an absolute path", () => {
  test.each([
    ["a bare relative path", "wt/run-1"],
    ["an explicitly relative path", "./wt/run-1"],
    ["a parent-relative path", "../wt/run-1"],
  ])("refuses %s", (_label, workspace) => {
    // The one shape rule the record imposes on a path, and it follows from the
    // record being durable rather than from taste: this value is read back
    // later, by a different process, whose working directory is its own. A
    // relative path recorded here is a path whose meaning depends on who reads
    // it, which is exactly what an intent fixed at admission exists to rule
    // out -- and the failure would arrive as a workspace materialised in the
    // wrong place, with nothing anywhere saying which place was meant.
    expectRefusal(
      () => new LapRunIntent(fields({ workspace })),
      LapRunIntentUsageError,
      /workspace must be a fully qualified absolute path/,
    );
  });

  test("refuses a path that is rooted but not qualified", () => {
    // `path.win32.isAbsolute("\\worktree")` is TRUE, and the path is still
    // drive-relative: it resolves against whichever drive the reading process
    // is on. Admission on `D:` and a materialise step on `C:` would read one
    // recorded string as two directories -- exactly the failure requiring an
    // absolute path exists to rule out, arriving through the check meant to
    // rule it out. On POSIX the same string is not absolute at all, so it is
    // refused there too, and the message is the same one either way.
    //
    // Both branches also assert what the platform MUST accept, because a rule
    // that only ever refuses is satisfied by refusing everything, and the shape
    // a rejection-only case would let through is a record that cannot hold an
    // ordinary path on the platform it is running on.
    const rooted = `${win32.sep}worktree${win32.sep}run-1`;

    expectRefusal(
      () => new LapRunIntent(fields({ workspace: rooted })),
      LapRunIntentUsageError,
      /workspace must be a fully qualified absolute path/,
    );

    const accepted =
      process.platform === "win32"
        ? [
            `C:${win32.sep}worktree${win32.sep}run-1`,
            `${win32.sep}${win32.sep}server${win32.sep}share${win32.sep}wt`,
          ]
        : ["/worktree/run-1"];
    for (const workspace of accepted) {
      expect(new LapRunIntent(fields({ workspace })).workspace).toBe(workspace);
    }
  });

  test("does not require the path to exist", () => {
    // `workspace` is where this lap has CHOSEN to materialise, not a directory
    // that exists: at admission it typically does not, and the task that
    // creates it reports what it made in its own event. A record that stat'd
    // the path would make admission depend on the filesystem and would refuse
    // every run before its workspace was cut.
    const workspace = resolve("no", "such", "directory", "anywhere");

    expect(new LapRunIntent(fields({ workspace })).workspace).toBe(workspace);
  });

  test("does not normalise the path it was given", () => {
    // Absolute is all that is checked. Normalising here would mean the record
    // holds a string the operator did not type, so the report, the payload and
    // the command line would quote three spellings of one path -- and it would
    // put a second opinion about paths in a module whose subject is a work
    // statement.
    const workspace = `${resolve("wt")}/./run-1`;

    expect(new LapRunIntent(fields({ workspace })).workspace).toBe(workspace);
  });
});

// --------------------------------------------------------------------------
// cli args
// --------------------------------------------------------------------------

describe("cli args are a list of strings, in order", () => {
  test("keeps the order it was given", () => {
    // argv order IS the meaning of an argument list; a record that sorted or
    // de-duplicated would be a different record, and the worker would be run
    // with a different command line than the one recorded.
    const cliArgs = ["--model=sonnet", "--verbose", "--model=sonnet"];

    expect(new LapRunIntent(fields({ cliArgs })).cliArgs).toEqual(cliArgs);
  });

  test("accepts an empty string as an argument", () => {
    // An empty argv element is legal and occasionally meant. Refusing it would
    // be a rule this record invented rather than one anything downstream asked
    // for.
    expect(new LapRunIntent(fields({ cliArgs: [""] })).cliArgs).toEqual([""]);
  });

  test("refuses a list that is not a list", () => {
    expectRefusal(
      () => new LapRunIntent(fields({ cliArgs: "--verbose" as unknown as string[] })),
      LapRunIntentUsageError,
      /cli_args must be a list of strings/,
    );
  });

  test("refuses a control character in an element, naming its index", () => {
    // The rule every field but `prompt` gets, applied to each element rather
    // than to the list. An argv element is the part of this record most likely
    // to arrive from a shell that did the quoting for someone, and one carrying
    // an escape sequence is a value no later report can quote back as the
    // string the database holds.
    expectRefusal(
      () =>
        new LapRunIntent({
          ...fields(),
          cliArgs: ["--verbose", `--message=a${String.fromCodePoint(0x0a)}b`],
        }),
      LapRunIntentUsageError,
      /cli_args\[1\] must not contain a control character/,
    );
  });

  test("refuses a non-string element, naming its index", () => {
    // The index is the point: a list that is a list of the wrong things fails
    // at the element the caller has to go and look at, and a message that only
    // said "cli_args is malformed" would send them through the whole list.
    expectRefusal(
      () => new LapRunIntent(fields({ cliArgs: ["--verbose", 7 as unknown as string] })),
      LapRunIntentUsageError,
      /cli_args\[1\] must be a string, got 7/,
    );
  });
});

// --------------------------------------------------------------------------
// the flag rules the constructor still owns (D-0088)
// --------------------------------------------------------------------------

describe("cli args may not restate a flag the fence generates", () => {
  // One case per flag. `materializer.ts` has its own cases over the same list
  // at the fence-render checkpoint; these assert the earlier one, where the
  // refusal costs an operator a failed `run admit` rather than a half-built
  // workspace.
  for (const flag of FENCE_OWNED_FLAGS) {
    test(`refuses ${flag}, bare and with an attached value`, () => {
      for (const argument of [flag, `${flag}=some-value`]) {
        expectRefusal(
          () => new LapRunIntent(fields({ cliArgs: ["--model=sonnet", argument] })),
          LapRunIntentUsageError,
          new RegExp(
            `cli_args\\[1\\] is .*, which repeats ${escapeForRegExp(flag)} -- a flag the fence generates`,
          ),
        );
      }
    });
  }
});

describe("the constructor owns the argv's shape, and the allowlist owns the policy", () => {
  // What is left here after `D-0088` inverted the other half of `D-0086`, and
  // the point of keeping the two apart. This constructor answers questions
  // about the argv **this build itself renders** -- a flag the fence generates,
  // and the marker that ends option parsing -- which are the same whatever role
  // is being admitted and need no document to decide. Which arguments a role
  // may run with is not that kind of question: it is a judgement about a role,
  // measured against a CLI release this repository does not own, and it now
  // lives in `src/fencing/cli_args_allow.json`, read at `admitRun`, at the head
  // of `lap perform`'s preflight and in the materialiser's validation block.
  //
  // The constructor deliberately does not learn that document, and these cases
  // are where that shows: it also runs at `lap perform` through
  // `readLapRunIntent`, over a payload the database already holds, so a
  // document-aware constructor would make an already admitted run *unreadable*
  // the moment its authorising entry was removed -- and unreadable is not a
  // narrowing, because reporting on that run and closing it out go through this
  // same constructor as running it.

  test("the end-of-options marker is refused, though it is not a flag", () => {
    // The one that a list of flag names structurally cannot catch, and the
    // largest hole of the set: `materializer.ts` renders the operator's
    // arguments *before* the fence's own, so a bare `--` ends option parsing
    // and every generated flag after it arrives as positional text. The child
    // starts with no fence, and the argv still reads fenced because each flag
    // is still in it. Kept in the constructor under `D-0088` for the reason
    // above: the allowlist would refuse a vector carrying it too, but only
    // where the allowlist runs, and this holds at every construction.
    expectRefusal(
      () => new LapRunIntent(fields({ cliArgs: ["--"] })),
      LapRunIntentUsageError,
      /cli_args\[0\] is '--', the end-of-options marker/,
    );
    // Anywhere in the list, not only first: everything after it is what the
    // marker converts, so its position is not what makes it dangerous.
    expectRefusal(
      () => new LapRunIntent(fields({ cliArgs: ["--model=sonnet", "--"] })),
      LapRunIntentUsageError,
      /cli_args\[1\] is '--', the end-of-options marker/,
    );
  });

  test("an argument that merely starts with the marker is still admitted", () => {
    // `--` is refused as a whole token, not as a prefix. Refusing every
    // argument that begins with two dashes would refuse the entire long-option
    // namespace, which is most of what `cli_args` legitimately carries.
    expect(new LapRunIntent(fields({ cliArgs: ["--model=sonnet"] })).cliArgs).toEqual([
      "--model=sonnet",
    ]);
  });

  test("a flag that alters what the fence permits is admitted here, and refused elsewhere", () => {
    // The case that pins the move rather than merely letting the old ones
    // vanish. Every argument below was refused by this constructor under
    // `D-0086` and is now constructed without complaint -- not because it
    // became safe, but because the refusal moved to the three sites that read
    // `src/fencing/cli_args_allow.json`, where the question can be asked of a
    // *role* and answered by a document a reviewer edits with a written reason.
    // Without this case the inversion would be invisible in this file: the
    // deleted refusals would read as a suite that stopped checking, and a
    // constructor that quietly grew a policy check of its own again would still
    // be green here.
    //
    // `-wscratch` is in the list on purpose. It is the attached-value spelling
    // of `-w, --worktree`, the one single-dash flag either concept ever
    // carried, and the shape that `matchesFlag`'s third branch exists for --
    // so if that branch is ever pointed at a policy list again, this is the
    // argument that catches it.
    for (const argument of [
      "--worktree",
      "-wscratch",
      "--allowedTools",
      "--allowed-tools=Bash",
      "--bare",
      "--safe-mode",
      "--cloud",
      "--debug-file=/tmp/x",
      "--plugin-dir",
    ]) {
      expect(new LapRunIntent(fields({ cliArgs: [argument] })).cliArgs).toEqual([argument]);
    }
  });

  // **Deleted under `D-0088`, and the loss is deliberate and visible.** This is
  // where `flags that only narrow the child are deliberately admitted` stood:
  // `--restricted`, `--disable-slash-commands`, `--permission-prompts` and
  // `--tmux` were kept off `D-0086`'s denylist because refusing them would
  // refuse a child *safer* than the one admission asked for. Under a whole-
  // vector allowlist they invert: a vector naming any of them is unauthorised
  // like every other vector the document does not carry, so a strictly safer
  // child is refused too. That is the price of a rule that does not read the
  // CLI's mind -- an allowlist cannot tell "this argument narrows the child"
  // from "this argument moves it out from under the fence" without the same
  // per-release judgement `D-0086` proved could not be kept correct. The
  // remedy is an entry in `src/fencing/cli_args_allow.json` with a written
  // reason, which is a reviewed edit rather than a per-run decision.

  test("the owned-flag list's length is pinned, so prose that counts it cannot drift", () => {
    // `D-0086` stated the size in words and `D-0088` restates it for the half
    // that survived. A flag added or removed without the entry being updated
    // leaves a decision record that miscounts its own decision -- and the count
    // is how a reader checks they are looking at the same list the entry
    // describes.
    expect(FENCE_OWNED_FLAGS).toHaveLength(5);
  });
});

// --------------------------------------------------------------------------
// what the record is not
// --------------------------------------------------------------------------

describe("the record carries no authority", () => {
  test("has no field named for a permission, a principal or an owner", () => {
    // Structural, because the name is the whole defence. `D-0055` records that
    // this is a lap-scoped work statement superseded by cadenza's G2 rather
    // than promoted into it, and the way that stops being true is one field at
    // a time: a `holder` renamed back, a `permissions` list added "while we are
    // here", a `principal` union added in anticipation of G2. Each would be a
    // small diff and none would fail a behavioural test.
    const intent = new LapRunIntent(fields());
    const names = Object.keys(intent);

    expect(names).toEqual([
      "runId",
      "leaseClaimantId",
      "workspace",
      "role",
      "baseBranch",
      "topicBranch",
      "prompt",
      "cliArgs",
    ]);
    for (const forbidden of [
      "holder",
      "owner",
      "principal",
      "authority",
      "permissions",
      "scopes",
      "grants",
      "contract",
    ]) {
      expect(names, `${forbidden} is G2's vocabulary, not this record's`).not.toContain(forbidden);
    }
  });

  test("the payload names the claimant as a claimant", () => {
    // The persisted spelling matters more than the in-memory one: the payload
    // is what another process, and a person reading the spine, will see. A key
    // called `holder` there would read as an authority regardless of what this
    // module's doc says.
    const payload = JSON.parse(new LapRunIntent(fields()).payload) as Record<string, unknown>;

    expect(Object.keys(payload)).toContain("lease_claimant_id");
    expect(Object.keys(payload)).not.toContain("holder");
  });
});
