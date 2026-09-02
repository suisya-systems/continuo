import { isAbsolute } from "node:path";

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
 * LapRunIntent.prompt} may carry.
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
 * The payload keys, which are the record's durable spelling.
 *
 * `snake_case` rather than the record's own `camelCase`, because the payload is
 * read out of the database beside column names, and `cli_args` is also the key
 * `claude_cli_provider.ts` reads out of the settings bag. Kept beside the type
 * rather than at the append site so that the field list and the persisted key
 * list cannot be extended one without the other.
 */
const PAYLOAD_KEYS = {
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
   * Required to be absolute, which is the one shape rule this record imposes on
   * a path and follows from the record being durable rather than from taste: it
   * is read back later, by a different process, whose working directory is its
   * own. A relative path recorded here is a path whose meaning depends on who
   * reads it, which is exactly the thing an intent fixed at admission exists to
   * rule out.
   *
   * Absolute is all that is checked. Whether the path is normalised, whether
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
    if (!isAbsolute(this.workspace)) {
      throw new LapRunIntentUsageError(
        `workspace must be an absolute path, got ${pythonRepr(this.workspace)}; ` +
          "this record is read back by a later process with a working directory " +
          "of its own, so a relative path is one whose meaning depends on who " +
          "reads it",
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
      if (typeof argument !== "string") {
        // Each element by itself, because a list that is a list of the wrong
        // things fails at the element the caller has to go and look at.
        throw new LapRunIntentUsageError(
          `cli_args[${index}] must be a string, got ${pythonRepr(argument)}`,
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
