/**
 * The repository's one way to get a TypeScript syntax tree.
 *
 * Twelve checks read this tree's own sources as syntax rather than importing
 * them -- the structural sweeps under `test/canary`, `test/secretary`,
 * `test/messagebus`, `test/measurement`, `test/fault_injection`,
 * `test/control_plane`, `test/gate_item11` and `test/testkit`, plus
 * `scripts/escaping-coverage.mjs` -- and every one of them called
 * `ts.createSourceFile` on text it had read itself. TypeScript 7 removes that
 * entry point. The compiler is a Go program now, and the `typescript` package's
 * main export is `{ version, versionMajorMinor }` and nothing else; the syntax
 * tree is still reachable, but only as data the compiler sends back.
 * `typescript/unstable/ast` decodes it and `typescript/unstable/sync` is what
 * asks for it. Parsing is therefore no longer a pure function over a string --
 * it is a question put to a running program -- and this module is where that
 * difference is absorbed so that the twelve callers can go on asking the old
 * question.
 *
 * It lives under `scripts/` rather than `test/testkit/` because
 * `scripts/escaping-coverage.mjs` is one of the callers, and a script may not
 * reach into the test tree. `test/testkit/ast.ts` keeps the shared *walk*
 * (`importedModules`); this module owns the shared *parse*.
 *
 * **The old signature is kept deliberately**: `parseSourceFile(fileName,
 * source)` parses the text it is given, as if it lived at that path. The
 * alternative -- asking the compiler for the file at that path on disk -- reads
 * better until it meets the callers that parse text no file holds:
 * `scripts/escaping-coverage.mjs` parses each mutated variant of a module,
 * `test/fault_injection/import-graph.test.ts` and
 * `test/messagebus/import-graph.test.ts` parse hand-written snippets attributed
 * to modules that have never existed, and those snippets are how the detectors
 * themselves are tested. A parse that could only see real files would have
 * quietly cost every one of those sweeps its own test.
 *
 * So the text is mounted in a **virtual filesystem** holding one file and a
 * `tsconfig.json` that turns everything off: `noLib` and `noResolve` mean no
 * `lib.d.ts` is loaded and no import is followed, because a syntax tree is all
 * any caller wants and resolving the rest would drag the real tree in behind a
 * snippet that is not part of it. Nothing here touches disk.
 *
 * The extension is carried over from `fileName` and it is load-bearing. `.tsx`
 * is not TypeScript with extra tokens, it is a different grammar, and parsing
 * one as `.ts` yields a tree wrong in both directions: a dynamic import inside
 * JSX goes unexposed, and JSX text is read as code that is not there. The
 * compiler takes script kind from the extension, so naming the virtual file
 * with the caller's own extension is what asks for the right grammar -- the
 * question the removed `ts.ScriptKind` argument used to answer by hand.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where the virtual file is mounted.
 *
 * Under the repository root rather than at `/parse`, so the path has the shape
 * the host platform uses -- a bare `/`-rooted path is not what an absolute path
 * looks like on the Windows cell this suite runs in. Nothing is created here:
 * the directory exists only inside the virtual filesystem.
 */
const PARSE_DIR = resolve(ROOT, ".ts-ast-parse").split("\\").join("/");
const TSCONFIG = `${PARSE_DIR}/tsconfig.json`;

const TSCONFIG_TEXT = JSON.stringify({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    // A syntax tree is the whole product. Loading the default library or
    // following an import would cost real work for an answer nobody reads.
    noLib: true,
    noResolve: true,
  },
  include: ["**/*"],
});

/** The extensions a caller may ask for; anything else is a caller bug. */
const PARSEABLE = [".tsx", ".mts", ".cts", ".ts"];

/**
 * The compiler is spawned on first use and kept for the life of the process.
 *
 * Starting it costs a process launch, so doing it per file would turn a sweep
 * over a few hundred modules into a few hundred compiler launches. Reusing it
 * costs well under a millisecond per file instead, including a full walk of the
 * tree.
 */
let session = null;

function sessionOf() {
  if (session === null) {
    const fs = createVirtualFileSystem({ [TSCONFIG]: TSCONFIG_TEXT });
    session = { api: new API({ cwd: PARSE_DIR, fs }), fs, mounted: null, snapshot: null };
  }
  return session;
}

/**
 * The syntax tree for `source`, parsed as though it were the file at
 * `fileName` (a path or bare name, used for its extension and in errors).
 */
export function parseSourceFile(fileName, source) {
  const state = sessionOf();

  const extension = PARSEABLE.find((candidate) => fileName.endsWith(candidate));
  if (extension === undefined) {
    throw new Error(
      `ts-ast: ${fileName} has no TypeScript extension, so there is no grammar to parse it with`,
    );
  }

  // One file at a time. Leaving previous parses mounted would grow the program
  // by one file per call, and `include` would have the compiler re-read all of
  // them on every snapshot.
  const path = `${PARSE_DIR}/source${extension}`;
  const previousPath = state.mounted;
  if (previousPath !== null && previousPath !== path) {
    state.fs.removeFile(previousPath);
  }
  state.fs.writeFile(path, source);
  state.mounted = path;

  // Rewriting one file is a change; switching grammars is a different file
  // appearing and the old one going away, and the compiler has to be told which
  // it was. Reporting a new path as merely `changed` leaves the wildcard
  // project holding the root that no longer exists and never picking up the one
  // that does, and `getSourceFile` then returns nothing at all. Only `.ts` is in
  // this tree today, so the first `.tsx`, `.mts` or `.cts` module to arrive is
  // what would have found this -- by breaking the sweep that exists to greet it.
  const fileChanges =
    previousPath === path
      ? { changed: [path] }
      : previousPath === null
        ? { created: [path] }
        : { created: [path], deleted: [previousPath] };

  // `changed` is what invalidates the compiler's copy. Without it the snapshot
  // is new, the call succeeds, and the tree returned is the *previous* file's
  // -- so a sweep would examine its first input a few hundred times and report
  // nothing wrong with any of the others. That failure is silent and green,
  // which is why the assertion below exists rather than a comment saying to be
  // careful.
  const previous = state.snapshot;

  const snapshot = state.api.updateSnapshot({
    // Without `openProjects` the snapshot holds no program at all and every
    // `getSourceFile` returns undefined -- a sweep that checks nothing.
    openProjects: [TSCONFIG],
    fileChanges,
  });
  state.snapshot = snapshot;

  // The previous parse's snapshot is released here rather than left to
  // `disposeParser`. Each one holds the compiler's program and the trees
  // decoded from it, so keeping them all would grow memory with the number of
  // files swept -- a few hundred, over a suite that parses every module and
  // every test file. Releasing it after its successor exists is what keeps the
  // tree this function returns safe to walk: a caller reads its tree before
  // asking for the next one, and no caller holds one across a parse.
  //
  // Released only once its successor exists. Releasing it first looks tidier
  // and silently breaks invalidation: the next snapshot then reports no change
  // and hands back the previous file's tree. The assertion below caught that,
  // which is the whole reason it is there.
  if (previous !== null) {
    previous.dispose();
  }

  const project = snapshot.getProject(TSCONFIG);
  const tree = project?.program.getSourceFile(path);
  if (tree === undefined) {
    throw new Error(`ts-ast: the compiler did not return a tree for ${fileName}`);
  }
  if (tree.text !== source) {
    throw new Error(
      `ts-ast: the tree returned for ${fileName} is not the text that was asked about. ` +
        "A stale tree makes every sweep over it pass by finding nothing.",
    );
  }
  return tree;
}

/**
 * Shut the compiler down and release the last snapshot.
 *
 * The compiler is a child process and the snapshot holds its program and the
 * trees decoded from it, so this is how a caller hands back what parsing took.
 * On TypeScript 7.0.2 the child does not hold the event loop open, so a caller
 * that forgets still exits -- but that is a property of one patch release of an
 * `unstable` API, not a promise, and it is not what makes this the caller's
 * job. Every caller here disposes: the script in a `finally`, the suite through
 * `test/helpers/parser-lifecycle.ts`.
 */
export function disposeParser() {
  if (session !== null) {
    if (session.snapshot !== null) {
      session.snapshot.dispose();
    }
    session.api.close();
    session = null;
  }
}
