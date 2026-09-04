import { isAbsolute, parse as parsePath } from "node:path";

import { pythonJsonDocumentSorted } from "./python_json.js";
import { pythonRepr } from "./python_repr.js";

/**
 * What one lap of work was asked for, fixed at the moment the run is admitted.
 *
 * **This is an intent, not an authority.** Nothing in this record grants a
 * permission, proves an identity, or names a party entitled to anything. It is
 * the statement of a job: which run, who will claim its lease, where the work
 * will be materialised, in which role, from which branch onto which, and what
 * the worker is being asked to do. A reader who takes a field here as evidence
 * that the named party *may* do something has read it wrong, and the naming is
 * chosen to make that misreading hard rather than merely discouraged --
 * `leaseClaimantId` rather than `holder`, `owner` or `principal`, because the
 * string's whole meaning is "this is the value the lease will be taken under",
 * and a lease is a mutual-exclusion token whose authority comes from the
 * database's epoch rule and not from the word carried here.
 *
 * **Lap-scoped, and superseded rather than promoted.**
 * `docs/design/minimal-operating-loop.md` section 6.3 places this record in
 * continuo and puts authority and permission modelling in cadenza's G2, which
 * is a later generalisation with a different subject. When G2 lands, this
 * record is **superseded** by it: it is not the seed of G2's type, it does not
 * grow a `permissions` list or a `principal` union in the meantime, and no
 * field is added here in anticipation of one there. A field that exists only
 * because a future design might want it is a field nothing on this lap
 * validates, nothing on this lap reads, and every reader mistakes for a
 * commitment.
 *
 * **Immutable, and that is the point rather than a habit.** The record is
 * produced once, by `run admit`, inside the transaction that creates the run
 * (`run_admission.ts`), and persisted as the `run_delegation_recorded` event's
 * payload. What comes *after* admission -- the workspace that was actually
 * created, the commit a base branch resolved to, the session that was spawned
 * -- is not a correction of this record and must not be written back onto it.
 * Those are later facts about a later moment, and the spine's own rule is that
 * a fact is corrected with a new event rather than by editing an old one
 * (`event_rows_are_immutable`). So this type has no setter, no `update`, and no
 * optional "resolved" twin of any field: the run's workspace task states what
 * it materialised in its own event, and a reader who wants both reads both.
 *
 * That is also what {@link workspace} means, and it is the one field whose name
 * invites the wrong reading. It is **not** "the workspace that exists"; it is
 * the path this lap has *chosen* to materialise into. At admission the
 * directory typically does not exist yet, and this record makes no claim that
 * it ever will.
 *
 * **The fields are not read off `StartRequest`.** Section 6.3 says they are,
 * and that is wrong in a way worth correcting rather than carrying:
 * `StartRequestFields` is `sessionId`, `workspace`, `role` and `settings`
 * (`src/session/provider.ts`), so of the seven fields here exactly two are
 * `StartRequest`'s. `runId` is `admitRun`'s and this database's; the lease
 * claimant reaches `acquireRunLease` through `SessionOrchestratorOptions`
 * and never touches a `StartRequest`; `prompt` and `cliArgs` are string keys
 * inside `StartRequest.settings`'s opaque bag, read one layer further down by
 * `claude_cli_provider.ts`; and the two branches have no reader in `src/` at
 * all yet. The correction matters because the original sentence makes the whole
 * record depend on `S1`'s promotion, and it does not: each field's provenance
 * and provisionality is its own, and `D-0055` records them one by one.
 *
 * **ASCII only** in the messages this module writes, per
 * `docs/cli-output-policy.md`: they reach a console that may be cp932. The
 * *values* it validates are external and are deliberately not held to that --
 * see {@link LapRunIntent.prompt}, which is prose and is expected to be
 * Japanese.
 */

/**
 * A field of the intent is malformed. Nothing was opened, and nothing written.
 *
 * Outside the `ControlPlaneRefusal` family, matching how `run_admission.ts`
 * places `RunAdmissionUsageError` and for the same reason: a refusal in that
 * family is a fact stated about the data -- this run is already admitted, this
 * database is behind -- and reaches the operator as one line and exit 2, while
 * a malformed argument is a defect in whoever built the record and its stack is
 * the thing that diagnoses it.
 *
 * That placement is inherited rather than chosen here. `D-0051` already
 * settled it for a malformed `--run-id`, and `run_cli.ts` already records the
 * open question it leaves -- that an external value reaching a console is a
 * problem for "whichever entry settles it for every verb at once". Splitting
 * the taxonomy for this record alone would answer that question halfway, for
 * some arguments of one verb.
 */
export class LapRunIntentUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LapRunIntentUsageError";
    Object.setPrototypeOf(this, LapRunIntentUsageError.prototype);
  }
}

/**
 * What a run identifier may be made of: printable ASCII, and nothing else.
 *
 * `D-0051`'s rule, moved here with the field rather than restated: the
 * identifier is quoted verbatim into `run admit`'s one-line success report and
 * into the `RunAlreadyAdmitted` message, both of which end at a single newline.
 * An identifier carrying its own newline makes the command appear to print a
 * second line it never wrote -- `error: ` is a prefix worth forging -- and one
 * carrying a character a cp932 console cannot encode makes it print none at
 * all, on a platform `D-0003` puts on the merge path.
 *
 * Narrower than the `run` table's own `CHECK`, which asks only for non-empty
 * text, and narrower on purpose: the column holds every identifier any writer
 * ever admits, and this is the rule for the one writer that puts identifiers
 * there **and** promises to print them back.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * The C0 and C1 control characters, which no field but {@link
 * LapRunIntent.prompt} may carry -- including each element of {@link
 * LapRunIntent.cliArgs}, which is text this record quotes back like any other.
 *
 * A narrow rule with a narrow reason, and deliberately not the printable-ASCII
 * rule above. A workspace path, a role, a lease claimant and a branch name are
 * all values continuo receives from outside, and `docs/cli-output-policy.md`
 * says in as many words that such values "may of course be non-ASCII" -- this
 * organization has repositories under paths with Japanese in them, and refusing
 * those would refuse work that exists. What a control character does is
 * different in kind from being unprintable: it ends a line, moves a cursor or
 * re-colours a terminal, so a branch name carrying one is a value that cannot
 * appear in any later report as the same string the database holds. That is the
 * property this rule protects, and it is the whole of it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the range is the subject
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * **Concept one: the flags the fence generates.**
 *
 * These are the fence itself: `--settings` names the rendered settings file,
 * `--permission-mode` is the one part of the fence the provider reads back
 * (`D-0010`), and `--mcp-config` names the file that decides which control
 * plane the worker talks to. `--setting-sources` and `--strict-mcp-config`
 * joined them under `D-0081`: each is what makes one of the first three
 * *exclusive* rather than *additive*, so restating either would put the target
 * repository's own settings, or its own MCP servers, back underneath a fence
 * that had just excluded them.
 *
 * Every one of them is rendered by `materializer.ts` and `FencedSpawner`, and
 * an admitted run's `cli_args` restating one would hand the child two of the
 * same flag. Refused rather than overridden, because "the last occurrence
 * wins" is a property of a CLI this repository does not own: a fence that
 * rests on an argument-precedence rule nobody here can test is a fence resting
 * on a guess.
 *
 * **Why the list lives here rather than in `materializer.ts`, which generates
 * them.** `D-0085` needs the two concepts stated side by side, and admission
 * checks both -- it runs at `run admit`, before a workspace exists, so
 * `materializer.ts` (which imports this) cannot be where the shared list is
 * without `control_plane` depending on `workspace`. A sixth generated flag
 * goes on this list; `materializer.ts` keeps its own check over it, unchanged,
 * as the last line of defence immediately before the spawn.
 */
export const FENCE_OWNED_FLAGS: readonly string[] = [
  "--settings",
  "--permission-mode",
  "--mcp-config",
  "--setting-sources",
  "--strict-mcp-config",
];

/**
 * **Concept two: the flags that alter what the fence means** -- `D-0085`, and
 * the door issue #133 was filed about.
 *
 * {@link FENCE_OWNED_FLAGS} is not this list and does not imply it. Those
 * flags are refused because the fence *generates* them, so a second one is a
 * duplicate whose winner nobody here can predict. These are refused for the
 * opposite reason: the fence generates none of them, nothing downstream would
 * notice one, and each **changes what the rendered fence permits** while
 * leaving every generated flag intact. A `cli_args` carrying one is a fence
 * the operator has quietly rewritten through the single door the fence hands
 * them -- and `docs/operations/lap-1-dogfood.md` section 10.5 records that the
 * lap's own `--allowedTools` workaround went through exactly this door.
 *
 * Read against CLI `2.1.260`, the version `D-0081` measured, `claude --help`
 * spells them -- in three groups, because they weaken the fence in three
 * different ways:
 *
 * **They remove a layer of the fence.**
 *
 * - `--dangerously-skip-permissions` -- "Bypass all permission checks". The
 *   whole fence, off, in one argument.
 * - `--allow-dangerously-skip-permissions` -- makes that bypass available
 *   rather than applying it. A fence that refused only the first would refuse
 *   the act and admit its enabling.
 * - `--bare` -- "Minimal mode: **skip hooks**, LSP, plugin sync, ...". The
 *   fence's `PreToolUse` deny hook is the layer `D-0083` keeps precisely
 *   because it does *not* depend on the CLI's own permission evaluation, and
 *   this is the argument that switches that layer off while every generated
 *   flag stays in place and still looks right.
 * - `--safe-mode` -- "Start with all customizations (CLAUDE.md, skills,
 *   plugins, **hooks**, MCP servers, ...) disabled". The same hole as
 *   `--bare`, reached through the flag whose name reads like the safe choice.
 *
 * **They rewrite the fence's own lists from the argv.**
 *
 * - `--allowedTools` / `--allowed-tools` -- widens the allow list the role
 *   document authored. This is the one the dogfood actually used.
 * - `--disallowedTools` / `--disallowed-tools` -- restates the deny half from
 *   the argv, where the fence states it from a rendered file.
 * - `--tools` -- replaces the built-in tool set the role document's allow list
 *   was written against.
 *
 * **They hand the child reach, or configuration, the fence did not author.**
 *
 * - `--add-dir` -- "Additional directories to allow tool access to", which is
 *   the fence's *reach*: `D-0067` puts the worktree at the centre of what the
 *   child may touch, and this extends it to anywhere.
 * - `--plugin-dir` / `--plugin-url` -- load a plugin, and with it hooks, agents
 *   and MCP servers the fence never rendered. `--setting-sources ''` and
 *   `--strict-mcp-config` shut the settings and MCP doors `D-0081` found open;
 *   these are the same surroundings arriving through a third one, which those
 *   two flags say nothing about.
 * - `--agents` -- "JSON object defining custom agents", which can carry tool
 *   access of their own -- and `--agent`, which selects one by name and
 *   "Overrides the 'agent' setting", reaching the same place through the
 *   fence's own settings file rather than past it.
 * - `--worktree` / `-w` -- "Create a new git worktree for this session". The
 *   fence is rendered *for* the workspace `materializer.ts` built and the
 *   admitted intent names; this moves the child into a checkout that neither
 *   of them has ever heard of, and does the `git worktree` surgery from inside
 *   the CLI, where the role's `Bash(git worktree *)` deny never sees it.
 *
 * **They move execution, or control of it, out from under this run.** This
 * fourth group is a widening of the concept, and the phrasing it corrects is
 * this docstring's own: "alters what the fence permits" was too narrow, because
 * these do not weaken the fence -- they make it *irrelevant*, by putting the
 * work somewhere the rendered files are not.
 *
 * - `--cloud` -- "Create a cloud session". The settings file, the sandbox and
 *   the deny hook this step rendered are on a machine the child is not running
 *   on, and neither is the worktree.
 * - `--environment` -- "Create a new cloud session that runs on the given
 *   self-hosted environment", which is the same departure by another door.
 * - `--teleport` -- resumes a session elsewhere. Refused by the class it
 *   belongs to rather than by a measurement of its own; `--help` says little,
 *   and the fail-closed reading of "little" is refusal.
 * - `--bg` / `--background` -- "Start the session in the background and return
 *   immediately". The supervisor's whole model is a child *this* process owns:
 *   the process group it tracks, the orphan sweep, the session record. A
 *   session that outlives the spawn and is reattached by id is none of those.
 * - `--remote-control` -- opens an external control channel into the fenced
 *   child, which hands the turn to somebody the fence never named.
 *
 * **The CLI itself touches a path, outside the tool layer the fence hooks.**
 * The deny hook and the sandbox sit under *tools*; a file the CLI process
 * writes on its own behalf passes neither.
 *
 * - `--debug-file` -- "Write debug logs to a specific file path". An arbitrary
 *   path, written by the CLI, with no tool call to intercept: the hook never
 *   sees it and the sandbox does not contain it.
 * - `--file` -- "File resources to download at startup", spelled
 *   `file_id:relative_path`. It puts bytes on disk before the first turn, so
 *   there is not even a turn for the fence to be consulted on.
 *
 * `-w` is the one single-dash spelling on either list, and it is why {@link
 * LapRunIntent} matches the attached-value form as well: `-wname` reaches the
 * CLI's parser as `--worktree name`.
 *
 * **What is deliberately NOT here**, so the next reader sees a decision rather
 * than a gap. `--restricted` and `--disable-slash-commands` only ever *narrow*
 * (they remove tools and skills), and refusing them would refuse a safer child
 * than the one admission asked for. `--permission-prompts` chooses between
 * "host" and "none", and `2.1.260` has no `--permission-prompt-tool` flag for
 * "host" to reach, so neither value widens a `claude -p` child that has no SDK
 * host in the first place. `--tmux` says "requires `--worktree`", which is
 * refused above, so it is inert rather than permitted.
 *
 * **And what is not characterised**, named rather than passed over in silence:
 * `--chrome`, `--ide` and `--from-pr`. Each plausibly touches what the child
 * can reach, none is documented in `--help` well enough to say so, and none was
 * measured. They are the concrete face of the limitation below -- a reader
 * adding one of them here needs a measurement, not this comment.
 *
 * **Both spellings of each, because the CLI accepts both.** `--allowedTools`
 * and `--allowed-tools` are one option to the parser, so a list carrying one
 * and not the other is a rejection with a doorway in it -- the same argument
 * `matchesOwnedFlag` in `claude_cli_provider.ts` makes for its own three
 * spellings.
 *
 * **A named list, not a rule, and that is its limit.** It refuses the flags
 * that are known today to alter a rendered fence; it cannot refuse one a
 * future CLI release adds. `D-0085` says so in as many words rather than
 * leaving the reader to assume this is exhaustive.
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
  // spelling is checked before the short one, so a refusal of `--worktree`
  // names `--worktree` rather than `-w`.
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

/**
 * Would `argument` reach the CLI's parser as `flag`?
 *
 * The same three spellings `matchesOwnedFlag` in `claude_cli_provider.ts`
 * recognises, for the same reason: a rejection that knew two of the three would
 * be a rejection with a doorway in it.
 *
 * 1. the exact form, `--worktree`;
 * 2. the `--flag=value` form, `--worktree=scratch`;
 * 3. for a single-dash short flag only, the attached-value form: `-wscratch`
 *    reaches the parser as `--worktree scratch`.
 *
 * The third is guarded on `argument` not being a long flag itself, which the
 * provider's version is not. Without that guard `-w` would swallow every
 * `--w...` option the CLI has -- an argument refused for naming a flag it does
 * not name, with a message quoting a flag the operator never typed.
 */
function matchesFlag(argument: string, flag: string): boolean {
  if (argument === flag || argument.startsWith(`${flag}=`)) {
    return true;
  }
  return !flag.startsWith("--") && !argument.startsWith("--") && argument.startsWith(flag);
}

/** Keyword arguments of {@link LapRunIntent}, in field order. */
export interface LapRunIntentFields {
  readonly runId: string;
  readonly leaseClaimantId: string;
  readonly workspace: string;
  readonly role: string;
  readonly baseBranch: string;
  readonly topicBranch: string;
  readonly prompt: string;
  readonly cliArgs?: readonly string[] | undefined;
}

/** Non-empty text, or a refusal naming the field and quoting what arrived. */
function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LapRunIntentUsageError(
      `${field} must be a non-empty string, got ${pythonRepr(value)}`,
    );
  }
  return value;
}

/** Non-empty text that can be quoted back into a line without breaking it. */
function requireQuotableText(field: string, value: unknown): string {
  const text = requireText(field, value);
  if (CONTROL_CHARACTERS.test(text)) {
    throw new LapRunIntentUsageError(
      `${field} must not contain a control character, got ${pythonRepr(text)}; ` +
        "this record is quoted back in reports and in the event payload, so a " +
        "value that ends a line or moves a cursor is one that cannot be quoted " +
        "back as the string the database holds",
    );
  }
  return text;
}

/**
 * Is this a path that means the same thing to every process that reads it?
 *
 * `isAbsolute` alone is not that question on Windows, and the gap is not
 * theoretical on a platform `D-0003` puts on the merge path.
 * `path.win32.isAbsolute("\\worktree")` is `true`, but that path is
 * **drive-relative**: it resolves against whichever drive the reading process
 * happens to be on, so admission on `D:` and a materialise step on `C:` would
 * read one recorded string as two directories. That is precisely the failure
 * requiring an absolute path exists to rule out, arriving through the check
 * meant to rule it out.
 *
 * **Exported so that everyone asking "is this path unambiguous" asks one
 * implementation.** `src/lap/root.ts` required the worker's command to be
 * absolute and wrote its own `isAbsolute` check to say so -- inheriting exactly
 * the gap this docstring describes, in a rule that already had a correct
 * implementation eleven lines long. A rule with two implementations has one
 * that is wrong; the only question is which.
 *
 * So the rule is the root, not the leading separator: `parse` gives `"C:\\"`
 * for a drive-qualified path and `"\\\\server\\share\\"` for a UNC one, and a bare
 * `"\\"` or `"/"` for the drive-relative form. On POSIX the root of an absolute
 * path is always `"/"`, so the length test would reject every path there --
 * which is why `isAbsolute` is asked first and the root is only examined where
 * the two can disagree.
 */
export function isFullyQualified(path: string): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  if (process.platform !== "win32") {
    return true;
  }
  // A drive-relative root is exactly one separator. Anything qualified -- a
  // drive letter or a UNC share -- has more.
  return parsePath(path).root.length > 1;
}

/**
 * The payload keys, which are the record's durable spelling.
 *
 * `snake_case` rather than the record's own `camelCase`, because the payload is
 * read out of the database beside column names, and `cli_args` is also the key
 * `claude_cli_provider.ts` reads out of the settings bag. Kept beside the type
 * rather than at the append site so that the field list and the persisted key
 * list cannot be extended one without the other.
 *
 * **Exported so the reader can be driven by it** (`readLapRunIntent`). A reader
 * that checked a hand-written list of keys would be a second statement of this
 * contract, and the two would drift the first time a field was added -- with the
 * new field's absence silently tolerated, which is the failure that reader
 * exists to prevent.
 */
export const PAYLOAD_KEYS = {
  leaseClaimantId: "lease_claimant_id",
  workspace: "workspace",
  role: "role",
  baseBranch: "base_branch",
  topicBranch: "topic_branch",
  prompt: "prompt",
  cliArgs: "cli_args",
} as const;

/**
 * One lap's execution intent, validated at construction and frozen.
 *
 * A class rather than an interface, and it carries a private field, so the type
 * is **nominal**: a plain object of the right shape does not satisfy it, which
 * is what makes "every intent that reaches `admitRun` was validated" a property
 * of the type rather than a convention callers are asked to follow.
 *
 * @throws {LapRunIntentUsageError} for any malformed field. Construction is
 *   validation: there is no other way to obtain one of these.
 */
export class LapRunIntent {
  /** The run this intent is about, and the subject of every event it produces. */
  readonly runId: string;
  /**
   * The value the run's lease will be taken under (`acquireRunLease`'s
   * `holder`, reached through `SessionOrchestratorOptions.holder`).
   *
   * Not an authority and not an identity: see this module's own note. The
   * adapter that eventually starts the session is the only place this is spelt
   * `holder`, and that spelling stops at the lease call.
   */
  readonly leaseClaimantId: string;
  /**
   * The path this lap has chosen to materialise its workspace **into**, not one
   * that exists.
   *
   * Required to be **fully qualified** -- absolute, and on Windows carrying a
   * drive or a UNC share rather than a bare leading separator (see {@link
   * isFullyQualified}). That is the one shape rule this record imposes on a
   * path, and it follows from the record being durable rather than from taste:
   * it is read back later, by a different process, whose working directory is
   * its own. A path whose meaning depends on who reads it is exactly the thing
   * an intent fixed at admission exists to rule out.
   *
   * Being resolvable is all that is checked. Whether the path is normalised, whether
   * its parent exists, and what is eventually created there belong to the task
   * that materialises it, and that task states what it made in its own event.
   */
  readonly workspace: string;
  /** The role the worker runs as, as `StartRequest.role` spells it. */
  readonly role: string;
  /** The branch the work starts from. No reader in `src/` yet; see `D-0055`. */
  readonly baseBranch: string;
  /** The branch the work lands on. No reader in `src/` yet; see `D-0055`. */
  readonly topicBranch: string;
  /**
   * What the worker is being asked to do, verbatim.
   *
   * The one field held to nothing but non-emptiness, and deliberately: it is
   * operator-written prose, this organization writes prose in Japanese, and it
   * may legitimately carry newlines. `pythonJsonDocumentSorted` escapes every
   * character from `U+007F` up as `json.dumps` does, so the payload column
   * stays ASCII whatever this holds.
   */
  readonly prompt: string;
  /**
   * Extra arguments for the worker's CLI, in order. Empty when none were given.
   *
   * An empty array rather than `undefined` once constructed, so the payload has
   * one shape: a reader of the event does not have to tell "no arguments" from
   * "this producer did not write the key".
   */
  readonly cliArgs: readonly string[];

  /**
   * The event payload, rendered once at construction.
   *
   * Private, and read through {@link payload}. It is also what makes this class
   * nominal, which is the second reason it is a field rather than a method that
   * re-renders: a caller cannot hand `admitRun` an object literal that merely
   * looks like an intent.
   */
  readonly #payload: string;

  constructor(fields: LapRunIntentFields) {
    const runId = requireText("run_id", fields.runId);
    if (!PRINTABLE_ASCII.test(runId)) {
      throw new LapRunIntentUsageError(
        `run_id must be printable ASCII (U+0020..U+007E), got ${pythonRepr(runId)}; ` +
          "the identifier is printed back verbatim in this command's report and in " +
          "its refusals, so a character that cannot be printed is one that cannot " +
          "be reported",
      );
    }
    this.runId = runId;
    this.leaseClaimantId = requireQuotableText("lease_claimant_id", fields.leaseClaimantId);
    this.workspace = requireQuotableText("workspace", fields.workspace);
    if (!isFullyQualified(this.workspace)) {
      throw new LapRunIntentUsageError(
        `workspace must be a fully qualified absolute path, got ${pythonRepr(this.workspace)}; ` +
          "this record is read back by a later process with a working directory " +
          "of its own, so a path whose meaning depends on who reads it is one " +
          "this record cannot fix",
      );
    }
    this.role = requireQuotableText("role", fields.role);
    this.baseBranch = requireQuotableText("base_branch", fields.baseBranch);
    this.topicBranch = requireQuotableText("topic_branch", fields.topicBranch);
    this.prompt = requireText("prompt", fields.prompt);

    const cliArgs = fields.cliArgs ?? [];
    if (!Array.isArray(cliArgs)) {
      throw new LapRunIntentUsageError(
        `cli_args must be a list of strings, got ${pythonRepr(cliArgs)}`,
      );
    }
    for (const [index, argument] of cliArgs.entries()) {
      // Each element by itself, because a list that is a list of the wrong
      // things fails at the element the caller has to go and look at.
      if (typeof argument !== "string") {
        throw new LapRunIntentUsageError(
          `cli_args[${index}] must be a string, got ${pythonRepr(argument)}`,
        );
      }
      // The same rule the other fields get, and NOT `requireQuotableText`: an
      // empty string is a legal argv element and refusing it would be a rule
      // this record invented. What is refused is the control character, for the
      // reason {@link CONTROL_CHARACTERS} gives -- an argument carrying an
      // escape sequence is one no later report can quote back as the string the
      // database holds, and it is the element of this record most likely to
      // arrive from a shell that did the quoting for someone.
      if (CONTROL_CHARACTERS.test(argument)) {
        throw new LapRunIntentUsageError(
          `cli_args[${index}] must not contain a control character, got ` + pythonRepr(argument),
        );
      }
      // The end-of-options marker, which is not a flag and is the reason this
      // check is not only a list. `materializer.ts` renders the child's argv as
      // the operator's arguments **followed by** the fence's own -- an order it
      // chose deliberately, so that a parser resolving a repeated option
      // last-wins leaves the fence the survivor. A bare `--` inverts that: by
      // the POSIX convention every option parser implements, it ends option
      // parsing, so every generated flag after it arrives as positional text
      // and the child starts with no fence at all. One argument, two
      // characters, the whole fence -- and each individual flag still present
      // in the argv, so it reads fenced.
      //
      // Refused here rather than answered by reordering the argv: putting the
      // fence first would give up the last-wins property that order exists for,
      // trading this hole for the one it was closing.
      if (argument === "--") {
        throw new LapRunIntentUsageError(
          `cli_args[${index}] is '--', the end-of-options marker (D-0085). This step renders ` +
            "the operator's arguments before the fence's own, so a '--' among them ends option " +
            "parsing and hands the child every fence flag as positional text -- a run admitted " +
            "with it would spawn a child with no fence at all",
        );
      }
      // `D-0085`'s two concepts, refused here for two different reasons and
      // named separately so the refusal says which one this argument is.
      const owned = FENCE_OWNED_FLAGS.find((flag) => matchesFlag(argument, flag));
      if (owned !== undefined) {
        throw new LapRunIntentUsageError(
          `cli_args[${index}] is ${pythonRepr(argument)}, which repeats ${owned} -- a flag ` +
            "the fence generates. An admitted run may not restate the fence's own arguments, " +
            "because which occurrence a CLI honours is not a property this repository controls",
        );
      }
      const altering = FENCE_ALTERING_FLAGS.find((flag) => matchesFlag(argument, flag));
      if (altering !== undefined) {
        throw new LapRunIntentUsageError(
          `cli_args[${index}] is ${pythonRepr(argument)}, which is ${altering} -- a flag that ` +
            "alters what the fence permits (D-0085). The fence does not generate it, so nothing " +
            "downstream would refuse it, and a run admitted with it would spawn a child fenced " +
            "by something other than its role document",
        );
      }
    }
    this.cliArgs = Object.freeze([...cliArgs]);

    this.#payload = pythonJsonDocumentSorted({
      [PAYLOAD_KEYS.leaseClaimantId]: this.leaseClaimantId,
      [PAYLOAD_KEYS.workspace]: this.workspace,
      [PAYLOAD_KEYS.role]: this.role,
      [PAYLOAD_KEYS.baseBranch]: this.baseBranch,
      [PAYLOAD_KEYS.topicBranch]: this.topicBranch,
      [PAYLOAD_KEYS.prompt]: this.prompt,
      [PAYLOAD_KEYS.cliArgs]: this.cliArgs,
    });

    Object.freeze(this);
  }

  /**
   * This intent as the event payload persists it: `json.dumps(..., sort_keys=True)`.
   *
   * The run identifier is **not** in it, and that is the existing convention
   * rather than an omission -- `run_created`'s payload is `{"status":
   * "created"}` and names no run either. The event's `subject_id` and `run_id`
   * columns carry it, they are what `event_by_run` and `event_by_subject` are
   * built on, and a copy in the payload would be a second answer to which run
   * an event is about.
   */
  get payload(): string {
    return this.#payload;
  }
}
