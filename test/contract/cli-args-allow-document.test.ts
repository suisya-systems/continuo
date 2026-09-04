import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import {
  bundledCliArgsAllowPath,
  type CliArgsAllowEntry,
  CliArgsAllowlistUnreadable,
  loadCliArgsAllowlist,
} from "../../src/fencing/cli_args_allow.js";
import { roleNames } from "../../src/fencing/renderer.js";
import { FENCE_ALTERING_FLAGS } from "../control_plane/fence-altering-flags.js";
import { createTempDir } from "../helpers/tmp.js";

/**
 * `src/fencing/cli_args_allow.json`: the document that says which whole
 * argument vectors a role may run with (`D-0088`).
 *
 * **Why a continuo-owned document is pinned by digest at all.**
 * `carried-documents.test.ts` pins `roles.json` because that document is
 * interlock's and byte-identity is the claim. This one is continuo's own, so
 * there is nothing to be identical *to* -- and it is pinned anyway, for a
 * different reason that is the whole point of `D-0088`'s decision D3. The
 * allowlist is the single door through which an operator argument can ever
 * reach a fenced child, and the design's promise is that widening it is a
 * REVIEWED EDIT with a written reason and not a per-run decision. A digest is
 * what makes that promise checkable: an entry added without bumping the byte
 * count and the hash in this file turns CI red, so the widening cannot arrive
 * as a one-line change nobody looked at. The pin does not decide whether an
 * entry is a good idea -- it decides that somebody had to touch this file, in
 * the same commit, to add one.
 *
 * If the allowlist legitimately widens -- a measured argument, with its reason
 * written down -- update the digest and the byte count together with the
 * document, in one commit, and say why in the message. A digest updated on its
 * own, or a document changed with the digest regenerated as an afterthought, is
 * exactly the silent edit this file stands in front of.
 *
 * The other cases here are about what the document may CONTAIN rather than what
 * its bytes are, and they are asserted through {@link loadCliArgsAllowlist} --
 * the loader `admitRun`, `lap perform` and the materialiser all call -- rather
 * than through a second copy of the schema rules written here. A second copy
 * would be a thing that can agree with this test while disagreeing with the
 * three enforcement points, which is the only agreement that matters.
 *
 * **ASCII only**, comments included, per `docs/cli-output-policy.md` and the
 * whole-tree scan in `ascii-output-policy.test.ts`.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** The document this build ships, and the bytes it must have. */
const DOCUMENT_PATH = "src/fencing/cli_args_allow.json";
const DOCUMENT_SHA256 = "364b37738032a28a72829f4d2192b70bd9353c9ee8dddfc5b70c2785f995d6ac";
const DOCUMENT_BYTES = 20;

/**
 * Does `argument` name `flag`, as an allowlist entry would have to spell it?
 *
 * Equality is not enough on its own, and the extra forms are not decoration.
 * The corpus rule below gates the written record of a fence-altering
 * authorisation, and an entry authorising `["--allowedTools=Edit"]` authorises
 * exactly as much of the fence as one authorising `["--allowedTools", "Edit"]`.
 * A pure equality scan would let the first through the record rule while
 * catching the second, which is a doorway in a check whose entire job is to
 * leave no doorway. So an attached value counts: `--flag=value` for the
 * double-dash spellings, and for the corpus's one single-dash member (`-w`) the
 * form the CLI's own parser accepts, `-wname`, which `D-0086` measured and
 * `LapRunIntent` matched for the same reason.
 *
 * This is deliberately wider than it needs to be rather than narrower. A false
 * positive here costs an author one sentence in a `reason` they were going to
 * write anyway; a false negative is an authorisation that went in unrecorded.
 */
function namesFlag(argument: string, flag: string): boolean {
  if (argument === flag) {
    return true;
  }
  if (argument.startsWith(`${flag}=`)) {
    return true;
  }
  // Single-dash spellings only. `--worktree` is a prefix of nothing the CLI
  // accepts, but `--agent` is a prefix of `--agents`, so applying the attached
  // form to double-dash flags would report `--agent` for every `--agents` entry
  // and make the corpus report name a flag that is not there.
  return !flag.startsWith("--") && flag.startsWith("-") && argument.startsWith(flag);
}

/**
 * Every corpus flag an entry authorises without saying so in its `reason`.
 *
 * This is the executable half of `D-0088`'s decision D7, and it gates the
 * RECORD rather than the decision: an entry authorising `--allowedTools` -- the
 * one flag the eight lap-1 dogfood runs actually passed, as a workaround for
 * the fence defect `D-0081`/#120 closed -- is green the moment somebody writes
 * down that they did it and why, and red when it is done silently. Barring the
 * entry outright would make the escape hatch useless for the only case ever
 * observed; leaving the corpus advisory would make it not a check at all.
 *
 * `reason` is matched as a substring rather than parsed. The field exists to be
 * read by the reviewer of the edit, and what is being asserted is that the flag
 * was named at all -- no phrasing is prescribed, because prescribing one would
 * turn a record rule into a spelling rule.
 */
function unrecordedCorpusFlags(
  entries: readonly CliArgsAllowEntry[],
): readonly { readonly index: number; readonly flag: string }[] {
  const missing: { readonly index: number; readonly flag: string }[] = [];
  for (const [index, entry] of entries.entries()) {
    for (const flag of FENCE_ALTERING_FLAGS) {
      if (!entry.cliArgs.some((argument) => namesFlag(argument, flag))) {
        continue;
      }
      if (!entry.reason.includes(flag)) {
        missing.push({ index, flag });
      }
    }
  }
  return missing;
}

/** Write a fixture document verbatim -- including shapes the loader must reject. */
function writeDocument(text: string, label: string): string {
  const path = join(createTempDir(label), "cli_args_allow.json");
  writeFileSync(path, text, "utf8");
  return path;
}

describe("src/fencing/cli_args_allow.json", () => {
  test("is the document this build was reviewed with, byte for byte", () => {
    // Read as bytes, never as text: the claim is about bytes, and a text read
    // would hide a BOM and normalise nothing on POSIX.
    const bytes = readFileSync(join(ROOT, DOCUMENT_PATH));
    expect(bytes.byteLength, `${DOCUMENT_PATH} changed length`).toBe(DOCUMENT_BYTES);
    expect(
      createHash("sha256").update(bytes).digest("hex"),
      `${DOCUMENT_PATH} is no longer the document this build was reviewed with. This is the ` +
        `pin that makes widening the cli_args allowlist a reviewed change rather than a ` +
        `per-run decision (D-0088, decision D3): every added entry authorises a complete ` +
        `argument vector to reach a fenced child, so an entry may not arrive without a commit ` +
        `that touches this test too. If the change is deliberate, update the sha256 and the ` +
        `byte count here in the same commit as the document, and say in the message which ` +
        `vector was authorised and why.`,
    ).toBe(DOCUMENT_SHA256);
  });

  test("is the same file the enforcement points read", () => {
    // The digest above pins a path spelled in this test; the three enforcement
    // points resolve theirs from `import.meta.url`. Without this case the two
    // could drift -- a moved document would leave the pin guarding a file
    // nothing reads, which is a green test over an unpinned allowlist.
    expect(bundledCliArgsAllowPath()).toBe(join(ROOT, DOCUMENT_PATH));
  });

  test("loads, so the digest is not pinning a document no build can read", () => {
    // A digest alone would happily pin a truncated file. Going through the real
    // loader rather than `JSON.parse` also makes this the schema assertion: the
    // loader is where "exactly the keys role, cli_args, reason", "non-empty
    // role", "array of strings" and "non-empty reason" live, and it fails
    // closed on each. Restating those rules here would create a second copy
    // that can agree with this test while disagreeing with `admitRun`.
    expect(() => loadCliArgsAllowlist()).not.toThrow();
  });

  test("authorises nothing, which is the measured lap-1 answer", () => {
    // `D-0088` decision D1, and it is a measurement rather than a placeholder:
    // of the eight lap-1 dogfood runs recorded in
    // `docs/operations/lap-1-dogfood.md`, exactly one passed an operator
    // argument, and that one was `--allowedTools` used as a workaround for the
    // fence defect `D-0081`/#120 has since closed. Run 007 reached a commit
    // carrying the fence's own flags and nothing else. So the honest allowlist
    // is the empty one, and this case is what makes the first entry ever added
    // a deliberate act: it goes red, and whoever turns it green has to state
    // here that continuo now authorises operator arguments at all.
    expect(loadCliArgsAllowlist()).toStrictEqual([]);
  });

  test("names only roles the fence roster has", () => {
    // A typo'd role sits in the document looking like an authorisation while
    // authorising nothing: `cliArgsRefusal` compares `entry.role` to the run's
    // role, so `wroker` matches no run, and the operator who added the entry
    // sees their run refused with the document visibly containing their vector.
    // Fail-closed, therefore silent, therefore worth a test.
    const roster = new Set(roleNames());
    for (const [index, entry] of loadCliArgsAllowlist().entries()) {
      expect(
        roster.has(entry.role),
        `entry ${index} authorises role ${JSON.stringify(entry.role)}, which is not in the ` +
          `fence roster (${[...roster].join(", ")}). An entry for a role that does not exist ` +
          `authorises nothing and reads as though it does.`,
      ).toBe(true);
    }
  });

  test("records, in the reason, every fence-altering flag it authorises", () => {
    // `D-0088` decision D7. Note the DIRECTION: this scans the document, and
    // does not submit arguments. A submit-and-assert corpus -- feed each of the
    // twenty-four names to `cliArgsRefusal` and expect a refusal -- would be
    // green today and green forever, and would say nothing, because under exact
    // whole-vector matching a submitted bare `--allowedTools` is refused even
    // when the document authorises `["--allowedTools", "Edit"]`. That is
    // precisely the widening this corpus exists to catch, and the submitting
    // form stays green straight through it.
    const missing = unrecordedCorpusFlags(loadCliArgsAllowlist());
    expect(
      missing,
      `these entries authorise a flag D-0086 measured as altering the fence without naming it ` +
        `in their reason: ${missing.map((m) => `entry ${m.index} / ${m.flag}`).join("; ")}. ` +
        `The corpus does not bar the entry -- it requires the decision to be written down. Say ` +
        `in that entry's reason which flag is being authorised and why the fence it alters is ` +
        `acceptable for this role.`,
    ).toStrictEqual([]);
  });

  test("carries the twenty-four names D-0086 and D-0088 both state in words", () => {
    // The corpus is the input to the case above, so a name quietly dropped from
    // it narrows that rule without changing a line of it. Both decision entries
    // state the count in words, which makes the number checkable rather than a
    // property of whatever the list happens to hold today.
    expect(FENCE_ALTERING_FLAGS).toHaveLength(24);
    expect(new Set(FENCE_ALTERING_FLAGS).size, "the corpus has a duplicated name").toBe(24);
  });
});

/**
 * Anti-vacuity: the checks above, observed RED over documents built to break
 * them.
 *
 * `AGENTS.md`'s rule is that green is not enough when a check is added -- a
 * check nobody has watched fail is a check nobody knows fires. Every case here
 * builds a real document in a temporary directory and runs the REAL loader, and
 * the real corpus scan, over it. Each names the hole it stands in front of.
 */
describe("src/fencing/cli_args_allow.json checks, observed red", () => {
  test("a whitespace-only reason is not a reason", () => {
    // The hole: `reason` present, a string, and recording nothing. Without the
    // trim in the loader, an entry could satisfy every schema rule and the
    // corpus scan alike while documenting no decision at all -- and D3's whole
    // argument for owning this document's schema is that the rationale is a
    // field a test can see.
    const path = writeDocument(
      JSON.stringify({
        entries: [{ role: "worker", cli_args: ["--print-mode"], reason: "   " }],
      }),
      "reason-blank",
    );
    expect(() => loadCliArgsAllowlist(path)).toThrow(CliArgsAllowlistUnreadable);
    expect(() => loadCliArgsAllowlist(path)).toThrow(/'reason' must be a non-empty string/);
  });

  test("an unknown key stops the build rather than being ignored", () => {
    // The hole: a document written against a LATER schema -- one that grew, say,
    // an `expires` field -- read by this build as an unconditional
    // authorisation. A lenient reader drops the key it does not know and
    // silently widens; failing closed turns version skew into a stop.
    const path = writeDocument(
      JSON.stringify({
        entries: [
          {
            role: "worker",
            cli_args: ["--print-mode"],
            reason: "measured",
            expires: "2099-01-01",
          },
        ],
      }),
      "unknown-key",
    );
    expect(() => loadCliArgsAllowlist(path)).toThrow(CliArgsAllowlistUnreadable);
    expect(() => loadCliArgsAllowlist(path)).toThrow(/must have exactly the keys/);
  });

  test("a top-level shape that is not {entries: [...]} is refused", () => {
    // The hole: a document that parses as JSON and is not this document. A
    // reader that took `document.entries ?? []` would read a bare array, or a
    // renamed key, as an empty allowlist -- fail-closed by accident, and so
    // indistinguishable from a document that is simply empty on purpose. The
    // operator would be refused a vector their file plainly contains.
    const bareArray = writeDocument(JSON.stringify([{ role: "worker" }]), "top-array");
    expect(() => loadCliArgsAllowlist(bareArray)).toThrow(CliArgsAllowlistUnreadable);
    expect(() => loadCliArgsAllowlist(bareArray)).toThrow(/document must be a JSON object/);

    const renamedKey = writeDocument(JSON.stringify({ allow: [] }), "top-renamed");
    expect(() => loadCliArgsAllowlist(renamedKey)).toThrow(CliArgsAllowlistUnreadable);
    expect(() => loadCliArgsAllowlist(renamedKey)).toThrow(/must have exactly one key 'entries'/);
  });

  test("a corpus flag authorised without being named in the reason is caught", () => {
    // The headline fixture, and the one the design names: the widening this
    // whole corpus exists for, arriving silently. The entry is schema-valid --
    // it loads -- and its reason is a real sentence; what it does not do is say
    // that `--allowedTools` is what is being authorised, so the record rule
    // fires. Note that the second entry, the same authorisation WITH the flag
    // named, is clean: the rule gates the record, not the decision, and a case
    // that only ever showed red would not show that.
    const path = writeDocument(
      JSON.stringify({
        entries: [
          {
            role: "worker",
            cli_args: ["--allowedTools", "Edit"],
            reason: "the dogfood lap needed a wider allow list",
          },
          {
            role: "curator",
            cli_args: ["--allowedTools", "Edit"],
            reason:
              "authorises --allowedTools for the curator role; measured against " +
              "docs/operations/lap-1-dogfood.md section 10.5",
          },
        ],
      }),
      "corpus-unrecorded",
    );
    const entries = loadCliArgsAllowlist(path);
    expect(unrecordedCorpusFlags(entries)).toStrictEqual([{ index: 0, flag: "--allowedTools" }]);
  });

  test("an attached value does not carry a corpus flag past the record rule", () => {
    // The hole a pure equality scan would leave. `--allowedTools=Edit` is one
    // argv element and authorises exactly as much of the fence as the two-element
    // spelling above, so an entry could take the same door and leave no record
    // behind it. `namesFlag` is why this is red, and this case is why nobody may
    // simplify `namesFlag` back to `===` without noticing what it cost.
    const path = writeDocument(
      JSON.stringify({
        entries: [
          {
            role: "worker",
            cli_args: ["--allowedTools=Edit"],
            reason: "widens the allow list for one measured lap",
          },
        ],
      }),
      "corpus-attached",
    );
    expect(unrecordedCorpusFlags(loadCliArgsAllowlist(path))).toStrictEqual([
      { index: 0, flag: "--allowedTools" },
    ]);
  });

  test("a document with no corpus flag in it reports nothing", () => {
    // The vacuity check on the vacuity checks: a scan that reported every entry
    // would satisfy each red case above while saying nothing about any document.
    const path = writeDocument(
      JSON.stringify({
        entries: [{ role: "worker", cli_args: ["--verbose"], reason: "measured on lap 1" }],
      }),
      "corpus-clean",
    );
    expect(unrecordedCorpusFlags(loadCliArgsAllowlist(path))).toStrictEqual([]);
  });
});
