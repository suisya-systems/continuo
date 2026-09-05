/**
 * The git revision this build was produced from, baked in at build time.
 *
 * **This file is the SOURCE-TREE value, and it is deliberately not the truth
 * about any build.** `scripts/generate-revision.mjs` runs after `tsc` and
 * overwrites the *emitted* `dist/build_revision.js` with the same module
 * carrying the real revision. Nothing ever rewrites this file, so it does not
 * churn in git and a working tree is never dirtied by having been built.
 *
 * A run out of `src/` -- the suite under vitest, or `node
 * --experimental-strip-types src/cli.ts` -- therefore reports `unknown`, and
 * that is the honest answer rather than a gap: a run out of the source tree is
 * not a build, and there is no build whose revision it could name.
 *
 * **Why a literal here rather than a read at runtime.** `about.ts` already
 * argues this for `TOOL_VERSION` and the argument is the same one, only
 * sharper: the published package ships `dist/` and nothing else
 * (`package.json`'s `files`), so **every installed copy is a `dist/` with no
 * repository around it**. A design that shelled out to `git` at startup, or
 * walked upward looking for a `.git`, would answer wrong there twice over -- it
 * would report `unknown` in the installed build whose identity is the whole
 * point of the field, and, if the package happened to be installed inside some
 * other project's checkout, it would cheerfully report *that* project's `HEAD`
 * as continuo's build revision. The second failure is the dangerous one,
 * because it is confidently wrong rather than merely absent.
 *
 * So the revision is a string in the JavaScript that ships. A `dist/` that is
 * copied, renamed, or moved somewhere with no `.git` beside it answers with the
 * revision of the checkout that built it, forever, because nothing is resolved
 * at runtime -- `--version` is a concatenation of three module constants.
 *
 * **Why the type annotation is load-bearing.** Without the explicit `: string`,
 * `tsc` would infer the literal type and emit `export declare const
 * BUILD_REVISION: "unknown"` into `dist/build_revision.d.ts` -- a declaration
 * that contradicts the value the build writes into the `.js` beside it, and
 * that would let a consumer's type-checker narrow this build's `--version`
 * output to a constant it is not. The annotation makes the declaration say
 * `string`, which stays true for every build.
 *
 * **ASCII only**, per `docs/cli-output-policy.md`: this value reaches stdout.
 */
export const BUILD_REVISION: string = "unknown";
