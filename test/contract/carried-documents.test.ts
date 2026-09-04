import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * Documents carried verbatim from interlock, pinned by digest.
 *
 * The lane brief makes byte-identity a hard rule for a carried source document,
 * and interlock#74 says the same of the migration SQL: "SQL carries verbatim --
 * any dialect-forced deviation is a flagged decision, not a silent edit."
 * `src/fencing/roles.json` is the fencing lane's instance of that rule.
 *
 * **This test exists because the rule was already broken once, silently.** The
 * document was copied byte for byte and verified with `cmp`; a later
 * `biome check --write` across the repository then reformatted it -- collapsing
 * two arrays onto one line and adding a space inside `{"path": ...}` -- and
 * nothing noticed. Two comments went on claiming a `cmp` verification that no
 * longer held and, in fact, existed nowhere in the repository. The formatter
 * is now told to leave the file alone (`biome.json`), but a configuration entry
 * is a thing someone can remove; a failing test is a thing someone has to
 * answer.
 *
 * **Why a digest rather than a comparison.** CI has no interlock checkout -- the
 * whole reason `parity/source-inventory/` holds committed snapshots -- so there
 * is nothing to `cmp` against at gate time. The digest is the checkable form of
 * the claim: it is recorded here, and regenerating it is a diff a reviewer sees
 * and has to justify, exactly as `docs/differential-oracle.md` section 5 argues
 * for the oracle vectors.
 *
 * To re-verify against interlock by hand, from a checkout at the recorded
 * revision:
 *
 * ```
 * cmp src/fencing/roles.json <interlock>/src/claude_org_runtime/fencing/roles.json
 * ```
 *
 * If that ever legitimately changes -- interlock edits the document and continuo
 * follows -- update the digest and the revision in the same commit, and say why
 * in the message. A digest updated on its own is the silent edit this test is
 * about.
 *
 * **A carried document may also deviate, and then it stops being byte-identical.**
 * `deviations` is where that is said out loud. A row carrying one no longer
 * claims `cmp` against interlock succeeds; it claims the document is interlock's
 * at the recorded revision *plus exactly the listed edits*, and the digest pins
 * that. The field exists because the alternative -- bumping the digest and
 * leaving the "byte-identical" claim standing in a comment -- is the silent edit
 * this file was written after, wearing a green test.
 */

const ROOT = join(import.meta.dirname, "..", "..");

interface CarriedDocument {
  readonly path: string;
  readonly sourcePath: string;
  readonly revision: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Edits continuo made on top of the carried bytes, each with its reason. */
  readonly deviations?: readonly string[];
}

const CARRIED: readonly CarriedDocument[] = [
  {
    path: "src/fencing/roles.json",
    sourcePath: "src/claude_org_runtime/fencing/roles.json",
    revision: "65f36c5",
    sha256: "8f80d3550dfe4bf2ccfdad03df5b88f0b925ceb408169a84511e9e711034128d",
    bytes: 5678,
    deviations: [
      // D-0083 / #132. The CLI applies a file-permission rule only under
      // `Edit(...)`, which covers every file-editing tool -- it says so on
      // stderr on every spawn -- and `matches` in `src/fencing/rules.ts`
      // compares an exact tool name, so the `Write(...)` spelling closed
      // neither layer for the tool a child would actually reach for. The
      // `Write(...)` half is kept because the hook layer does still match a
      // literal `Write`, so removing it would narrow the fence.
      "worker.permissions.deny gains Edit(~/.claude/settings.json) beside the " +
        "Write(...) form, which neither the CLI's permission layer nor the fence's " +
        "own hook applied to an Edit",
    ],
  },
  {
    path: "src/settings/role_configs_schema.json",
    sourcePath: "src/claude_org_runtime/settings/role_configs_schema.json",
    revision: "65f36c5",
    sha256: "a359db26b83a5d6a7e9e9f58f0444570a846e47e4ed93451690557c9ffda8ed9",
    bytes: 25158,
  },
];

describe("documents carried verbatim from interlock", () => {
  for (const document of CARRIED) {
    const claim =
      document.deviations === undefined
        ? `is byte-identical to interlock at ${document.revision}`
        : `is interlock at ${document.revision} plus ${document.deviations.length} recorded deviation(s)`;
    test(`${document.path} ${claim}`, () => {
      // Read as bytes, never as text: a text read would normalise nothing on
      // POSIX and could still hide a BOM, and the claim is about bytes.
      const bytes = readFileSync(join(ROOT, document.path));
      expect(bytes.byteLength, `${document.path} changed length`).toBe(document.bytes);
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        `${document.path} is no longer the document carried from interlock ` +
          `${document.revision}:${document.sourcePath}` +
          (document.deviations === undefined
            ? ""
            : ` plus its recorded deviations (${document.deviations.join("; ")})`) +
          ". If this change is deliberate, update the digest, the byte count and the revision " +
          "together -- and add a `deviations` entry if the document is no longer interlock's -- " +
          "and say why in the commit message.",
      ).toBe(document.sha256);
    });

    test(`${document.path} still parses, so the digest is not pinning a broken file`, () => {
      // A digest alone would happily pin a truncated document. This is the
      // cheapest guard against a corrupted copy passing as a faithful one.
      const parsed: unknown = JSON.parse(readFileSync(join(ROOT, document.path), "utf8"));
      expect(parsed).toBeTypeOf("object");
      expect(parsed).not.toBeNull();
    });
  }
});
