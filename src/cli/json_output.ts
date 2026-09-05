import type { ArgumentParser, Namespace } from "./parser.js";

/**
 * The one JSON envelope every host-driven verb answers in (`D-0090`, `D-0092`).
 *
 * Fourteen verbs answer in it; a fifteenth, `measure report`, mounts the same
 * flag and emits its report UNWRAPPED, for the reason `measurement/cli.ts`
 * gives. The counts below are of the fifteen that mount the flag, because what
 * this module exists to prevent is fifteen spellings of one flag.
 *
 * `docs/cli-output-policy.md` governs the bytes; this module governs their
 * shape. It exists because the alternative was measured and rejected: five
 * subtrees each grew a `--json` proposal independently and produced five
 * spellings of the same idea -- `schema` / `verb` / `command` as the
 * discriminator, dotted and space-separated verb names, refusals on stdout in
 * two subtrees and on stderr in three. A host driving this CLI as a subprocess
 * would have had to learn all five. One module that declares the flag, builds
 * the document and encodes it is what makes "the same shape" a fact about the
 * code rather than a promise in a review.
 *
 * **This is a deliberate exception to `src/cli.ts`'s rule that a subtree
 * declares its own flags.** That rule exists to stop a flag's spelling drifting
 * away from the module that implements it. Here the risk runs the other way:
 * fifteen verbs must spell one flag identically, and fifteen independent
 * `addArgument` calls are fifteen chances to disagree about the help text, the
 * `dest`, or whether the flag exists at all. A shared declaration is the
 * stronger anti-drift answer for a flag whose whole value is uniformity, and it
 * is the only flag in this CLI that has that property.
 *
 * **The envelope.**
 *
 * Success, on stdout, exit 0:
 *
 *     {"schema":"continuo.run.admit/1","ok":true,"db":"...", ...payload}
 *
 * Refusal, on stderr, exit 2:
 *
 *     {"schema":"continuo.run.admit/1","ok":false,"db":"...",
 *      "error":{"class":"RunAlreadyAdmitted","message":"..."}}
 *
 * A refusal raised over a session whose identity the verb holds carries that
 * identity as a top-level key beside `db` (`D-1102`), and omits the key
 * entirely when it does not:
 *
 *     {"schema":"continuo.lap.perform/1","ok":false,"db":"...",
 *      "session_id":"0c2b...","error":{"class":"LapRefused","message":"..."}}
 *
 * One document, one trailing newline, `snake_case` keys throughout.
 *
 * **Why the refusal goes to stderr, against the tempting alternative.** Putting
 * it on stdout would let a host read one stream and be done. It would also undo
 * a distinction this codebase already argued for and wrote down: the seam
 * records in `control_plane/cli.ts` and `control_plane/run_cli.ts` both carry a
 * separate `write` and `writeError` "because a refused verb writes to stderr and
 * a successful one to stdout, and a test that read only one of them could not
 * tell 'refused with a reason' from 'printed nothing'". A refusal document on
 * stdout reinstates exactly that ambiguity, for precisely the invocations this
 * flag adds, and makes which stream carries the diagnosis depend on a flag. The
 * host contract is one line instead: **exit 0 -- parse stdout; exit 2 -- parse
 * stderr; any other status -- the CLI was called wrong or the process failed,
 * and stderr is text.**
 *
 * **Why `class` is a hint and not a taxonomy.** {@link refusalDocument} carries
 * `error.name` verbatim rather than a hand-written code table, because a table
 * built from `instanceof` collapses subclasses silently -- `MigrationChecksumRefused`
 * and `DatabaseAheadOfCodeRefused` both extend `CorruptStateRefused`, and their
 * operator moves differ (restore versus upgrade the build). But `name` is not a
 * taxonomy either: `refuseUnlessAtHead` throws a bare `ControlPlaneRefusal`, and
 * so do three sites in `measurement/cli.ts`, so one class covers several
 * unrelated conditions. The message is the authority; a host branches on the
 * exit code and the verb, and on `class` only where the class is a leaf. Saying
 * so here is cheaper than a host discovering it.
 *
 * **Why the encoder is this module's own and not `JSON.stringify` alone.**
 * `--db` is echoed verbatim and is deliberately unconstrained (`run_cli.ts`
 * says why: an operator chooses a run id but merely *has* a filesystem path).
 * A path may hold a character the console cannot encode, and
 * `JSON.stringify` escapes control characters but passes non-ASCII through
 * untouched -- which would put a non-ASCII byte on stdout and break
 * `docs/cli-output-policy.md` on the one surface that policy exists to
 * protect. {@link asciiJsonLine} escapes every codepoint outside
 * U+0020..U+007E to `\\uXXXX`, so the document stays valid JSON and every byte
 * stays ASCII.
 *
 * Not `pyJsonDumps` from `fencing/pyjson.ts`, which would also have escaped:
 * that renderer is a byte-for-byte port of CPython's `json.dumps` and its
 * output is a *parity surface* -- it emits `, ` and `: ` separators on purpose,
 * because persisted columns are compared against interlock's. Borrowing it for
 * CLI output would quietly make these bytes a parity obligation too, and it
 * throws `PyTypeError` for a value it cannot serialise, which on a write verb
 * would be a crash *after* the write had committed. This module takes only
 * primitives and cannot fail that way.
 *
 * **ASCII only**, per `docs/cli-output-policy.md`: the help text here reaches
 * `--help` on a cp932 console from all fifteen verbs at once.
 */

/** What a document may hold: primitives and the two containers, nothing else. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** The flag's help text, declared once so fifteen verbs cannot disagree about it. */
export const JSON_HELP =
  "emit one machine-readable JSON document instead of the human-readable " +
  "text. The document goes to stdout on success and to stderr on a refusal; " +
  "the exit code is the same either way.";

/**
 * Mount `--json` on a verb's parser.
 *
 * `storeTrue`, spelled as `settings/cli.ts` and `attention/cli.ts` already
 * spell it, so the flag behaves the way the two `--json` surfaces that predate
 * this one behave.
 */
export function addJsonArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--json"],
    dest: "json",
    storeTrue: true,
    help: JSON_HELP,
  });
}

/**
 * Was `--json` given?
 *
 * `=== true` rather than a truthiness test: the parser's namespace is
 * `unknown`-valued, and a `storeTrue` dest is `false` when the flag was absent
 * rather than missing, so this reads the value the parser actually stored.
 */
export function jsonRequested(args: Namespace): boolean {
  return args["json"] === true;
}

/**
 * One JSON document as a line of ASCII.
 *
 * The escape pass runs over `JSON.stringify`'s output rather than over the
 * input values, so it catches non-ASCII wherever it sits -- in a key, in a
 * string, in a nested object -- without this module having to walk the
 * document itself.
 *
 * Each UTF-16 code unit is escaped separately, which is correct for astral
 * characters too: a surrogate pair becomes two `\\uXXXX` escapes, and that is
 * what JSON says a pair is. `charCodeAt` rather than a codepoint iteration for
 * exactly that reason.
 *
 * `0x7f` (DEL) is escaped as well as everything above it. The policy's alphabet
 * is U+0020..U+007E plus tab and newline, and DEL is outside it; `JSON.stringify`
 * leaves it raw.
 */
export function asciiJsonLine(document: JsonValue): string {
  const encoded = JSON.stringify(document);
  let out = "";
  for (let index = 0; index < encoded.length; index += 1) {
    const unit = encoded.charCodeAt(index);
    if (unit >= 0x20 && unit <= 0x7e) {
      out += encoded[index];
    } else {
      out += `\\u${unit.toString(16).padStart(4, "0")}`;
    }
  }
  return `${out}\n`;
}

/**
 * The success document: the envelope's three fixed keys, then the verb's payload.
 *
 * The payload is spread last so that a verb cannot accidentally shadow
 * `schema`, `ok` or `db` -- if it tries, the spread wins and the envelope is
 * silently wrong. That is why {@link SUCCESS_KEYS} exists and why
 * {@link successLine} refuses instead.
 */
const SUCCESS_KEYS = ["schema", "ok", "db"] as const;

/**
 * Build and encode a verb's success document.
 *
 * `schema` is the pinned identifier for this verb's shape -- `continuo.<verb>/1`
 * -- and the `/1` is the whole of the version story: a change that a host cannot
 * absorb becomes `/2`, and the two can then be told apart by a host reading one
 * key. A verb that grows a field does not change it, because a document with an
 * unread key is one every JSON reader already handles.
 *
 * A payload that tries to set one of the envelope's own keys is a defect in the
 * caller, not an operator's problem, so it throws rather than being absorbed:
 * absorbing it would ship a document whose `ok` came from a payload and mean the
 * envelope is not an envelope.
 */
export function successLine(
  schema: string,
  db: string,
  payload: { readonly [key: string]: JsonValue },
): string {
  for (const key of SUCCESS_KEYS) {
    if (key in payload) {
      throw new Error(
        `${schema}: payload may not carry the envelope key '${key}'; ` +
          "the envelope's keys are set by successLine and a payload that " +
          "overwrote one would ship a document whose envelope is not this one",
      );
    }
  }
  return asciiJsonLine({ schema, ok: true, db, ...payload });
}

/**
 * The structured facts a refusal carries **beside** its class and its message
 * (`D-1102`).
 *
 * **An enumerated record and never a generic expansion of the `Error`.** The
 * tempting shortcut is to copy a refusal's own enumerable fields into the
 * document and let each class decide what a host sees. That would put values
 * this envelope has made no promise about on the wire -- `IdentityUnconfirmed`
 * carries an `unknown`-typed `lastAnswer` that is the provider's raw answer,
 * `LoserTerminated` carries a nested refusal object -- and the first host to
 * read one would make it a contract nobody wrote down. Every key here is
 * decided one at a time, and today exactly one is decided.
 *
 * Every field is optional, and an absent field means **unknown**, never
 * "empty": a caller that cannot establish the fact omits it, and the document
 * omits the key in turn rather than carrying `null`. rondo `D-0015` rule 7 still
 * holds on the other side of the wire -- a decoder that finds no `session_id`
 * learns that the identity is unknown, and must not go looking for one in
 * `error.message`.
 */
export interface RefusalMetadata {
  /**
   * The session this refusal is about, when the verb holds a **confirmed**
   * identity for it.
   *
   * Which refusals hold one is a property of the state the verb reached, not of
   * the refusal's class alone; `src/lap/cli.ts` enumerates the classes that do
   * for `continuo.lap.perform/1` and `D-1102` records why each is on the list.
   * A minted-but-unbound identity is not one of them: reporting it would name a
   * session this process never owned.
   */
  readonly sessionId?: string | undefined;
}

/**
 * Build and encode a verb's refusal document.
 *
 * `db` is required rather than optional, and is on every refusal for the same
 * reason it is on every success: a host driving several control planes cannot
 * attribute a refusal it reads from a log without it. The human refusal line
 * carries the path only when the message happens to quote it, which is not a
 * property a host can rely on.
 *
 * `error.name` rather than the constructor name, because every refusal class in
 * this codebase sets `this.name` explicitly, and reading the field cannot drift
 * from the class the way a hand-maintained table can.
 *
 * **`session_id` is a top-level key and not a member of `error`** (`D-1102`).
 * `error` is the diagnosis -- a class hint and a sentence written for a person
 * -- and the identity is a fact about the refusal's subject that a host acts on:
 * it is what the next `session stop`, the next transcript read and the next log
 * correlation are keyed on. Nesting it inside the diagnosis would make a
 * machine-read field depend on a human-facing object, and the `message` is
 * emphatically not the source of identity even when it quotes the id.
 *
 * **Absent rather than `null` when unknown.** This is the opposite of the
 * success document's `endpoint_lease_failure`, and deliberately so: there,
 * "always present, `null` when there is nothing to say" exists because a host
 * must be able to read "the lap was clean" positively. Here the two states are
 * "this refusal is about a session I can name" and "it is not about a session
 * at all" -- a `null` would be a third spelling of the second, and a host that
 * has to distinguish an absent key from a null one has learnt nothing. An empty
 * string is omitted too: it is not an identity, and shipping `""` would hand a
 * host a value it would then try to stop.
 */
export function refusalLine(
  schema: string,
  db: string,
  error: Error,
  metadata: RefusalMetadata = {},
): string {
  const sessionId = metadata.sessionId;
  return asciiJsonLine({
    schema,
    ok: false,
    db,
    ...(sessionId === undefined || sessionId === "" ? {} : { session_id: sessionId }),
    error: { class: error.name, message: error.message },
  });
}
