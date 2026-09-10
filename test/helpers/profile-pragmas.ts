import Database from "better-sqlite3";

/**
 * A measurement arm, not a setting: forces every SQLite connection this worker
 * opens to the durability level named by `CONTINUO_PROFILE_SYNCHRONOUS`.
 *
 * Continuo's Windows CI cell spends 97% of its wall clock inside the two suite
 * runs, and the per-file excess over Linux on the same commit is concentrated
 * in the control-plane files rather than the child-process ones -- 20x to 60x
 * on files that do nothing but open a database and commit to it. Commit
 * durability (`synchronous = FULL`, D-0012) is the leading explanation and the
 * one a log cannot settle, because the two candidate mechanisms -- an fsync
 * that is genuinely slower on that filesystem, and a virus scanner walking
 * every file a commit touches -- produce the same per-test number. Running the
 * same files with the pragma weakened separates them.
 *
 * Why the level is applied on first *use* rather than at construction: the
 * connections that matter are not all opened through
 * `src/control_plane/connection.ts`. Several of the slowest files call
 * `new Database(...)` themselves, and a setup file cannot intercept a
 * constructor it only holds a reference to. Every connection does reach one of
 * the three entry points below before it commits anything, so hooking those
 * covers the ones `configureConnection` never sees.
 *
 * Unset -- which is every run except a profiling arm -- this module patches
 * nothing and costs one import per worker. It is NOT a way to make CI faster:
 * a weakened arm is green by luck, and D-0012's durability claim is exactly
 * what it removes.
 */
const LEVEL_ENV = "CONTINUO_PROFILE_SYNCHRONOUS";

const level = process.env[LEVEL_ENV];

if (level !== undefined && level !== "") {
  if (!/^(OFF|NORMAL|FULL)$/.test(level)) {
    throw new Error(`${LEVEL_ENV} must be OFF, NORMAL or FULL, got ${JSON.stringify(level)}.`);
  }

  type Hookable = Record<string, (this: object, ...args: unknown[]) => unknown>;
  const prototype = Database.prototype as unknown as Hookable;
  const forced = new WeakSet<object>();

  for (const method of ["pragma", "prepare", "exec"] as const) {
    const original = prototype[method] as (this: object, ...args: unknown[]) => unknown;
    prototype[method] = function patched(this: object, ...args: unknown[]) {
      if (!forced.has(this)) {
        // Before the guard is armed, not after: `pragma` is one of the hooked
        // methods, so an unguarded call here would recurse forever.
        forced.add(this);
        (prototype["pragma"] as (this: object, source: string) => unknown).call(
          this,
          `synchronous = ${level}`,
        );
      }
      return original.apply(this, args);
    };
  }

  process.stderr.write(`continuo: profiling arm -- synchronous forced to ${level}\n`);
}
