import { CiObservationRefused } from "./ci_ingest.js";
import { pythonJsonString } from "./python_json.js";

/**
 * What GitHub printed about one commit's checks, read into one entry per check.
 *
 * The producer half of `ci observe`: the operator's `gh` fetches, and this reads
 * what it printed. It is pure -- two strings in, a list out -- so every rule
 * about what a commit's checks come to is a unit case with no forge to ask.
 * Carried from rondo's `readEntries` / `joinChecks` (`src/access/forge.ts` at
 * rondo `87e62f0`), which it replaces; what it deliberately does *not* carry is
 * the fold. Folding the entries into one answer is `ci_current_verdict` and
 * `prVerdict`'s job, and a second fold here would be a second answer to
 * "is this PR green".
 *
 * **Both documents, because a repository can use either.** A commit status is
 * what an external service posts; a check run is what an app (including the
 * forge's own actions) records. Reading one would report a repository that uses
 * the other as having no checks at all.
 *
 * **One page is a wrong answer, not a partial one.** Both documents are read as
 * `gh api --paginate --slurp` prints them -- an array of pages -- and the forge's
 * own `total_count` is checked against what arrived, so a page nothing fetched
 * is a refusal rather than a green over the failure that sat on it.
 *
 * **The rollup fields are not read.** The combined status carries a `state` of
 * its own, and it is a rollup over statuses alone, so a commit with a green
 * status and a failing check run reports `success` there.
 */

const FULL_SHA = /^[0-9a-fA-F]{40}$/;

/** The state of one check, before any fold. `pending` is "not finished yet". */
export type GithubCheckState = "passed" | "failed" | "cancelled" | "timed_out" | "pending";

/** One check as the forge reported it. */
export interface GithubCheckEntry {
  /** Which document it came from. */
  readonly kind: "check_run" | "commit_status";
  /** The check run's `name`, or the status's `context`. */
  readonly name: string;
  readonly state: GithubCheckState;
  /**
   * The forge's own word for the outcome (`conclusion` of a completed run, the
   * status's `state`, or a run's `status` while it is in flight), kept because
   * `state` folds `neutral` and `skipped` into `passed` and a reader may still
   * want to know no test ran.
   */
  readonly detail: string;
  /**
   * The forge's clock for this state: `completed_at` for a completed run,
   * `started_at` for one in flight, `updated_at` for a status.
   */
  readonly occurredAtMs: number;
}

/** Both documents read, and the one commit they are about. */
export interface GithubChecks {
  /** The commit, full and lowercase, as the forge named it. */
  readonly headSha: string;
  readonly entries: readonly GithubCheckEntry[];
}

/**
 * The forge's documents could not be read as a whole answer; nothing is known.
 *
 * A refusal and never an empty list: "the forge answered with something else"
 * and "this commit has no checks" are two different facts.
 */
export class GithubChecksUnreadable extends CiObservationRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "GithubChecksUnreadable";
    Object.setPrototypeOf(this, GithubChecksUnreadable.prototype);
  }
}

/**
 * Read `commits/<sha>/check-runs` and `commits/<sha>/status`, as `gh api
 * --paginate --slurp` printed them, into one entry per check.
 *
 * Every entry, and the status document itself, must name the same commit: two
 * documents about two commits joined into one answer would be a verdict about
 * neither.
 *
 * @throws {GithubChecksUnreadable} for a document that is not JSON, not the
 *   shape the endpoint answers, short of its own `total_count`, carrying an
 *   unparseable timestamp, or about more than one commit.
 */
export function readGithubChecks(checkRuns: string, status: string): GithubChecks {
  const runs = every(checkRuns, "check_runs");
  const statusPages = pages(status);
  const statuses = every(status, "statuses");
  const shas = new Set<string>();
  for (const page of statusPages) {
    shas.add(requiredString(page, "sha", "the status document"));
  }
  const entries: GithubCheckEntry[] = [];
  for (const run of runs) {
    const name = requiredString(run, "name", "a check run");
    shas.add(requiredString(run, "head_sha", `check run ${pythonJsonString(name)}`));
    const inFlight = stringAt(run, "status") !== "completed";
    const detail = inFlight
      ? (stringAt(run, "status") ?? "unknown")
      : (stringAt(run, "conclusion") ?? "none");
    entries.push({
      kind: "check_run",
      name,
      state: inFlight ? "pending" : conclusionState(detail),
      detail,
      occurredAtMs: timestamp(
        run,
        inFlight ? "started_at" : "completed_at",
        `check run ${pythonJsonString(name)}`,
      ),
    });
  }
  for (const one of statuses) {
    const name = requiredString(one, "context", "a commit status");
    const detail = requiredString(one, "state", `status ${pythonJsonString(name)}`);
    entries.push({
      kind: "commit_status",
      name,
      state: statusState(detail),
      detail,
      occurredAtMs: timestamp(one, "updated_at", `status ${pythonJsonString(name)}`),
    });
  }
  const [headSha, ...others] = shas;
  if (headSha === undefined || others.length > 0) {
    throw new GithubChecksUnreadable(
      `the documents name ${shas.size} commits (${[...shas].map((sha) => pythonJsonString(sha)).join(", ")}); ` +
        "one answer is about exactly one commit",
    );
  }
  if (!FULL_SHA.test(headSha)) {
    throw new GithubChecksUnreadable(
      `the documents name the commit ${pythonJsonString(headSha)}, which is not a full SHA`,
    );
  }
  return { headSha: headSha.toLowerCase(), entries };
}

/**
 * What a completed check run's conclusion comes to.
 *
 * `neutral` and `skipped` are a check that ran and asked for nothing, and count
 * as passing (the window's gate answer recorded in `D-1112`). `cancelled` and
 * `timed_out` keep their own names because continuo's vocabulary does. Anything
 * else -- a failure, one asking for an action, one the forge called stale, one
 * this does not know the name of -- is `failed`: a conclusion nobody has named
 * here must not read as green.
 */
function conclusionState(conclusion: string): GithubCheckState {
  switch (conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "passed";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    default:
      return "failed";
  }
}

/** A commit status's state: `error` is a failure its poster could not even run. */
function statusState(state: string): GithubCheckState {
  if (state === "success") {
    return "passed";
  }
  return state === "pending" ? "pending" : "failed";
}

/** The printed document as its pages: `--slurp` prints an array, one page is an object. */
function pages(printed: string): readonly unknown[] {
  let json: unknown;
  try {
    json = JSON.parse(printed);
  } catch (error) {
    // The parser's own message is not carried: it quotes the input, and the
    // input is forge text that may hold what an ASCII console cannot print.
    throw new GithubChecksUnreadable("the forge's answer was not JSON", { cause: error });
  }
  return Array.isArray(json) ? json : [json];
}

/**
 * Every entry of one kind across every page, held to the forge's own count.
 *
 * `total_count` says how many entries of this kind the commit has; fewer in hand
 * means a page is missing, and a missing page is exactly where the failure that
 * makes the reading wrong would be.
 */
function every(printed: string, key: string): readonly unknown[] {
  const entries: unknown[] = [];
  let counted = 0;
  for (const page of pages(printed)) {
    const list = at(page, key);
    if (!Array.isArray(list)) {
      throw new GithubChecksUnreadable(`the forge's answer carried no '${key}' list`);
    }
    entries.push(...list);
    const total = at(page, "total_count");
    if (typeof total === "number" && Number.isFinite(total)) {
      counted = Math.max(counted, total);
    }
  }
  if (entries.length < counted) {
    throw new GithubChecksUnreadable(
      `the forge reported ${counted} '${key}' on this commit and answered with ${entries.length}`,
    );
  }
  return entries;
}

function at(json: unknown, key: string): unknown {
  return typeof json === "object" && json !== null
    ? (json as Record<string, unknown>)[key]
    : undefined;
}

function stringAt(json: unknown, key: string): string | null {
  const value = at(json, key);
  return typeof value === "string" && value !== "" ? value : null;
}

function requiredString(json: unknown, key: string, what: string): string {
  const value = stringAt(json, key);
  if (value === null) {
    throw new GithubChecksUnreadable(`${what} carried no '${key}'`);
  }
  return value;
}

function timestamp(json: unknown, key: string, what: string): number {
  const ms = Date.parse(requiredString(json, key, what));
  if (!Number.isFinite(ms)) {
    throw new GithubChecksUnreadable(`${what} carried an unreadable '${key}'`);
  }
  return ms;
}
