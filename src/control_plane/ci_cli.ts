/**
 * `continuo ci observe` and `continuo ci show` (`D-1113`).
 *
 * Mounted into the unified CLI by `src/cli.ts`, which owns no flag of its own
 * here: the subtree's module declares its parser (`D-0030`).
 *
 * **Why this subtree exists.** Recording CI outcomes and folding them into a
 * verdict lived in rondo (`joinChecks`), which is the wrong home: continuo has
 * had the evidence table, its identity and the fold (`ci_ingest.ts`, `D-0033`)
 * since the port, and no producer. The split `D-1113` records is that fetching
 * stays with whoever holds the credential -- the operator's own `gh`, run by the
 * host -- and continuo reads what `gh` printed, records it, and answers the
 * verdict. So `observe` takes three documents as files and never reaches the
 * network, and `show` is a read.
 *
 * **What `observe` is handed and why all three.** The pull request document
 * (`gh api repos/<o>/<n>/pulls/<number>`) is where the head comes from: the
 * gate answer in `D-1113` is that green is judged on the head of the pull
 * request being merged, so the head is the forge's statement of it, not a
 * value the caller asserts. The check-runs and status documents
 * (`gh api --paginate --slurp repos/<o>/<n>/commits/<head>/{check-runs,status}`)
 * are the checks, and both must be about that head or nothing is written.
 *
 * **`--repo` and `--pr` are required and checked against the document.** The
 * 2026-08-06 incident (`docs/production-schema.md` section 7.1) was a pull
 * request number resolved against the wrong repository and stored anyway; a
 * document for another pull request passed by mistake is the same defect by
 * another route, so the operator names what they asked about and the verb
 * refuses a document that disagrees.
 *
 * **Thin, in the way the other subtrees are thin.** The repository row is
 * `upsertRepository`'s, the head projection `observePullRequest`'s, each check
 * `recordCiObservation`'s, the list of checks `recordCiScopeSnapshot`'s and the
 * verdict `pullRequestCi`'s; this module parses, calls them, and reports.
 * `observe` runs them all in one transaction (each joins it), so it commits
 * whole or not at all, and a repeat is safe: every write is keyed by an identity
 * that makes a re-run an idempotent no-op.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives. A check's
 * name is forge text and is printed escaped when it could break a line or a
 * cp932 console; the documents are refused with messages that escape what they
 * quote (`ci_github.ts`). `--db` is the one exception, and it is the standing
 * one `run_cli.ts` records: echoed verbatim, as every subtree echoes it, until
 * one entry settles echoed paths for every verb at once.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  addJsonArgument,
  type JsonValue,
  jsonRequested,
  refusalLine,
  successLine,
} from "../cli/json_output.js";
import type { Namespace, Subparsers } from "../cli/parser.js";
import { ArgparseExit, type ArgumentParser } from "../cli/parser.js";
import {
  type GithubCheckEntry,
  GithubChecksUnreadable,
  readGithubChecks,
  readGithubPullRequest,
} from "./ci_github.js";
import { pullRequestCi, recordCiObservation, recordCiScopeSnapshot } from "./ci_ingest.js";
import { openProductionControlPlane } from "./migrator.js";
import { pythonJsonString } from "./python_json.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { observePullRequest, resolveRepository, upsertRepository } from "./repo_link.js";
import { transaction } from "./txn.js";

// ASCII only: these reach --help on a cp932 console.
const DB_HELP =
  "path to the production control plane database file. It must already exist " +
  "and be at this build's head; 'db create' and 'db migrate' are what put it " +
  "there.";
const REPO_HELP =
  "the repository, OWNER/NAME. Required and never defaulted: a document about " +
  "another repository is refused rather than recorded against this one.";
const PR_HELP = "the pull request number. A document about another pull request is refused.";
const PULL_REQUEST_HELP =
  "file holding what 'gh api repos/OWNER/NAME/pulls/PR' printed. The head the " +
  "checks are recorded against is this document's head.sha.";
const CHECK_RUNS_HELP =
  "file holding what 'gh api --paginate --slurp " +
  "repos/OWNER/NAME/commits/HEAD/check-runs?per_page=100' printed.";
const STATUS_HELP =
  "file holding what 'gh api --paginate --slurp " +
  "repos/OWNER/NAME/commits/HEAD/status?per_page=100' printed.";
const OBSERVER_HELP =
  "who produced these documents, recorded as every row's observer and every " +
  "event's producer (for example the host that ran gh).";
const NOW_MS_HELP =
  "the clock, epoch milliseconds, stamped as every row's ingested time. Read " +
  "once from the system clock when omitted; the forge's own timestamps are the " +
  "observed times.";

const OBSERVE_DESCRIPTION =
  "Record what gh printed about a pull request's head: the repository, the " +
  "head, and one observation per check run and per commit status. Writes " +
  "nothing when a document is unreadable, short of a page, or about another " +
  "repository, pull request or commit. Safe to repeat.";
const SHOW_DESCRIPTION =
  "The CI verdict of a pull request's current head, most severe first: " +
  "failed, timed_out, cancelled, indeterminate, pending, passed; no_run when " +
  "nothing was observed for that head. Writes nothing.";

/** The pinned document identifiers (`D-0090`). */
const OBSERVE_SCHEMA = "continuo.ci.observe/1";
const SHOW_SCHEMA = "continuo.ci.show/1";

/**
 * `observer_epoch` for every row this verb writes.
 *
 * The column is a fenced producer's epoch, and the producer here -- a host
 * running `gh` -- holds no lease and is not fenced, so there is no epoch to
 * carry. `1` is the first valid value (the DDL requires `> 0`), not a claim.
 */
const OBSERVER_EPOCH = 1;

/** A GitHub `OWNER/NAME`: GitHub allows only these characters in either half. */
const REPO_SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/**
 * The effects this module has on the world, as a replaceable record, for the
 * reason `run_cli.ts`'s `runCliSeams` gives. `newId` is here because every event
 * and observation needs an identifier and a test needs to name them.
 *
 * Not re-exported from `src/index.ts`: a seam for the tests that own this
 * module, not public API.
 */
export const ciCliSeams = {
  nowMs: (): number => Date.now(),
  newId: (): string => randomUUID(),
  write: (text: string): void => {
    process.stdout.write(text);
  },
  writeError: (text: string): void => {
    process.stderr.write(text);
  },
  readFile: (path: string): Buffer => readFileSync(path),
};

/**
 * The document disagrees with what the operator named; nothing was written.
 *
 * Its own class because the operator's next move differs from an unreadable
 * document's: the fetch was of the wrong thing, not a bad fetch.
 */
export class GithubDocumentMismatch extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "GithubDocumentMismatch";
    Object.setPrototypeOf(this, GithubDocumentMismatch.prototype);
  }
}

function refuse(error: Error, schema: string, db: string, json: boolean): never {
  ciCliSeams.writeError(json ? refusalLine(schema, db, error) : `error: ${error.message}\n`);
  throw new ArgparseExit(2, "refused ci verb");
}

/** Run `action`, reporting a `ControlPlaneRefusal` as one stderr line and exit 2. */
function reportingRefusals(schema: string, args: Namespace, action: () => void): number {
  try {
    action();
  } catch (error) {
    if (error instanceof ControlPlaneRefusal) {
      refuse(error, schema, String(args["db"]), jsonRequested(args));
    }
    throw error;
  }
  return 0;
}

/** Open the database, use it, close it whatever happened. */
function withDatabase(path: string, use: (connection: SqliteDatabase) => void): void {
  const connection = openProductionControlPlane(path);
  try {
    use(connection);
  } finally {
    connection.close();
  }
}

/** `--repo`, split, or a refusal naming the shape it wanted. */
function slugOf(args: Namespace): { readonly owner: string; readonly name: string } {
  const repo = String(args["repo"]);
  const match = REPO_SLUG.exec(repo);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new GithubDocumentMismatch(`--repo ${pythonJsonString(repo)} is not OWNER/NAME`);
  }
  return { owner: match[1], name: match[2] };
}

/**
 * One document file, decoded strictly.
 *
 * Fatal on a malformed byte for the reason `run_cli.ts`'s `delegationRecordOf`
 * gives: a document silently altered on the way in is not what the forge said.
 */
function documentAt(path: string, flag: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(ciCliSeams.readFile(path));
  } catch (error) {
    throw new GithubChecksUnreadable(
      `${flag} ${pythonJsonString(path)} could not be read as a UTF-8 document`,
      { cause: error },
    );
  }
}

/** The one line an entry's name is printed on, escaped when it could break it. */
function printable(value: string): string {
  return /^[\x21-\x7e]+$/.test(value) && !value.includes('"') ? value : pythonJsonString(value);
}

/** `continuo ci observe`. */
export function cmdCiObserve(args: Namespace): number {
  const path = String(args["db"]);
  const json = jsonRequested(args);
  return reportingRefusals(OBSERVE_SCHEMA, args, () => {
    const slug = slugOf(args);
    const prNumber = Number(args["pr"]);
    const observer = String(args["observer"]);
    const pr = readGithubPullRequest(documentAt(String(args["pull_request"]), "--pull-request"));
    const checks = readGithubChecks(
      documentAt(String(args["check_runs"]), "--check-runs"),
      documentAt(String(args["status"]), "--status"),
    );
    // Every disagreement is refused BEFORE the database is opened, so a wrong
    // fetch costs no handle and writes no row.
    if (
      pr.owner.toLowerCase() !== slug.owner.toLowerCase() ||
      pr.name.toLowerCase() !== slug.name.toLowerCase()
    ) {
      throw new GithubDocumentMismatch(
        `the pull request document is about ${pythonJsonString(`${pr.owner}/${pr.name}`)}, ` +
          `not ${slug.owner}/${slug.name}`,
      );
    }
    if (pr.prNumber !== prNumber) {
      throw new GithubDocumentMismatch(
        `the pull request document is about #${pr.prNumber}, not #${prNumber}`,
      );
    }
    if (checks.headSha !== pr.headSha) {
      throw new GithubDocumentMismatch(
        `the checks are about ${checks.headSha} and the pull request's head is ` +
          `${pr.headSha}; a verdict is about the head only`,
      );
    }
    const nowMs =
      typeof args["now_ms"] === "number" ? (args["now_ms"] as number) : ciCliSeams.nowMs();

    // One transaction for the whole observation: the repository, the head, every
    // check and the scope snapshot commit together or not at all, so an observe
    // interrupted half way leaves nothing to reconcile. Each writer below joins
    // it (`txn.ts`).
    withDatabase(path, (outer) => {
      const written = transaction(outer, (connection) => {
        const repoId = upsertRepository(connection, {
          // A new repository's identity is its immutable node id, so a later
          // rename or transfer lands on this row rather than beside it.
          repoId: `github:${pr.providerRepoId}`,
          owner: pr.owner,
          name: pr.name,
          providerRepoId: pr.providerRepoId,
          nowMs,
        });
        const projected = observePullRequest(connection, {
          repoId,
          prNumber,
          headSha: pr.headSha,
          state: pr.state,
          observedAtMs: pr.updatedAtMs,
          ingestedAtMs: nowMs,
          eventId: ciCliSeams.newId(),
          producer: observer,
          producerEpoch: OBSERVER_EPOCH,
          providerPrId: pr.providerPrId,
          mergeCommitSha: pr.mergeCommitSha,
          mergedAtMs: pr.mergedAtMs,
          closedAtMs: pr.closedAtMs,
        });
        const recorded = checks.entries.filter((entry) =>
          record(connection, { repoId, prNumber, headSha: pr.headSha, entry, observer, nowMs }),
        ).length;
        // Which scopes the forge listed, so a check it no longer lists stops
        // counting (`D-1113` gate answer 5). After the observations, in the same
        // transaction.
        const scopesChanged = recordCiScopeSnapshot(connection, {
          repoId,
          prNumber,
          headSha: pr.headSha,
          scopes: checks.entries.map((entry) => ({ checkScope: entry.kind, scopeId: entry.name })),
          eventId: ciCliSeams.newId(),
          observer,
          observerEpoch: OBSERVER_EPOCH,
          ingestedAtMs: nowMs,
        });
        return { repoId, projected, recorded, scopesChanged };
      });
      const { repoId, projected, recorded, scopesChanged } = written;
      const duplicate = checks.entries.length - recorded;
      ciCliSeams.write(
        json
          ? successLine(OBSERVE_SCHEMA, path, {
              repo_id: repoId,
              pr_number: prNumber,
              head_sha: pr.headSha,
              pull_request_event: projected.eventType,
              observed: checks.entries.length,
              recorded,
              duplicate,
              scopes_changed: scopesChanged,
            })
          : `observed ${pr.owner}/${pr.name}#${prNumber} head ${pr.headSha} in ${path}: ` +
              `${checks.entries.length} checks, ${recorded} recorded, ${duplicate} already ` +
              `recorded; pull request ${projected.eventType ?? "unchanged"}; ` +
              `check list ${scopesChanged ? "changed" : "unchanged"}\n`,
      );
    });
  });
}

/** Record one entry; true when it was new, false when the spine already held it. */
function record(
  connection: SqliteDatabase,
  options: {
    readonly repoId: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly entry: GithubCheckEntry;
    readonly observer: string;
    readonly nowMs: number;
  },
): boolean {
  const { repoId, prNumber, headSha, entry, observer, nowMs } = options;
  const appended = recordCiObservation(connection, {
    observationId: ciCliSeams.newId(),
    repoId,
    prNumber,
    headSha,
    checkScope: entry.kind,
    scopeId: entry.name,
    // The forge's id for the check run or status, not a count of reruns: the
    // endpoints carry no attempt, and the id is what one needs. A rerun is a
    // new check run with a larger id, so it leads the view's ordering and
    // replaces the run it reran; a re-poll of one run keeps its id, so the same
    // verdict is the same identity and a no-op. With a constant here instead, a
    // rerun that came back to an earlier verdict (pending -> passed -> pending)
    // would collide with the first row and the stale `passed` would stand
    // (Codex review of this change). Within one id, `occurred_at_ms` orders
    // pending before its completion.
    attempt: entry.sourceId,
    sourceId: String(entry.sourceId),
    verdict: entry.state,
    verdictDetail: entry.detail,
    observer,
    observerEpoch: OBSERVER_EPOCH,
    occurredAtMs: entry.occurredAtMs,
    ingestedAtMs: nowMs,
  });
  return !appended.duplicate;
}

/** `continuo ci show`. */
export function cmdCiShow(args: Namespace): number {
  const path = String(args["db"]);
  const json = jsonRequested(args);
  return reportingRefusals(SHOW_SCHEMA, args, () => {
    const slug = slugOf(args);
    const prNumber = Number(args["pr"]);
    withDatabase(path, (connection) => {
      const repoId = resolveRepository(connection, slug);
      // One statement for the head, the scopes and their details, folded here by
      // `prVerdict`'s own rule: an `observe` committing mid-read cannot make this
      // answer describe two databases (`pullRequestCi`, `D-1113`).
      const { headSha: head, verdict, scopes } = pullRequestCi(connection, { repoId, prNumber });
      if (json) {
        const payload: { readonly [key: string]: JsonValue } = {
          repo_id: repoId,
          pr_number: prNumber,
          // `null` when no head was ever observed: an absent head is a fact, and
          // the verdict beside it is then `no_run`.
          head_sha: head ?? null,
          verdict,
          scopes: scopes.map((scope) => ({
            check_scope: scope.checkScope,
            scope_id: scope.scopeId,
            verdict: scope.verdict,
            detail: scope.detail,
            attempt: scope.attempt,
            occurred_at_ms: scope.occurredAtMs,
          })),
        };
        ciCliSeams.write(successLine(SHOW_SCHEMA, path, payload));
        return;
      }
      ciCliSeams.write(
        `ci ${slug.owner}/${slug.name}#${prNumber} in ${path}: ${verdict} ` +
          `head=${head ?? "-"}\n`,
      );
      for (const scope of scopes) {
        ciCliSeams.write(
          `scope ${scope.checkScope} ${printable(scope.scopeId)} ${scope.verdict} ` +
            `detail=${printable(scope.detail ?? "-")} ` +
            `attempt=${scope.attempt} occurred=${scope.occurredAtMs}\n`,
        );
      }
    });
  });
}

function addCommonArguments(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--db"],
    dest: "db",
    required: true,
    metavar: "DB",
    help: DB_HELP,
  });
  parser.addArgument({
    optionStrings: ["--repo"],
    dest: "repo",
    required: true,
    metavar: "OWNER/NAME",
    help: REPO_HELP,
  });
  parser.addArgument({
    optionStrings: ["--pr"],
    dest: "pr",
    required: true,
    type: "int",
    metavar: "PR",
    help: PR_HELP,
  });
}

/** `add_subparsers`: mount `observe` and `show` under `ci`. */
export function addSubparsers(sub: Subparsers): void {
  const observe = sub.addParser("observe", OBSERVE_DESCRIPTION);
  addCommonArguments(observe);
  for (const [option, dest, help] of [
    ["--pull-request", "pull_request", PULL_REQUEST_HELP],
    ["--check-runs", "check_runs", CHECK_RUNS_HELP],
    ["--status", "status", STATUS_HELP],
    ["--observer", "observer", OBSERVER_HELP],
  ] as const) {
    observe.addArgument({
      optionStrings: [option],
      dest,
      required: true,
      metavar: dest.toUpperCase(),
      help,
    });
  }
  observe.addArgument({
    optionStrings: ["--now-ms"],
    dest: "now_ms",
    type: "int",
    metavar: "NOW_MS",
    help: NOW_MS_HELP,
  });
  addJsonArgument(observe);
  observe.setDefaults({ func: cmdCiObserve });

  const show = sub.addParser("show", SHOW_DESCRIPTION);
  addCommonArguments(show);
  addJsonArgument(show);
  show.setDefaults({ func: cmdCiShow });
}
