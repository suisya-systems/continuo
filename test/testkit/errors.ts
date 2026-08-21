import { expect } from "vitest";

/**
 * `pytest.raises(SomeError, match="...")`, with both halves kept.
 *
 * `pytest.raises` asserts two things at once: the exception's **class** and a
 * regular-expression **search** over its string form. Vitest's
 * `expect(fn).toThrow(/re/)` checks only the message, and
 * `.toThrow(SomeError)` only the class -- so the obvious translation of a
 * `pytest.raises(X, match=...)` silently drops one half, and which half it drops
 * depends on which overload the translator happened to reach for.
 *
 * Dropping the class half is the dangerous one: a refusal family whose members
 * differ only by type (`MigrationStepsRefused` is deliberately *not* a
 * `CorruptStateRefused`) still produces the same message, so a message-only
 * assertion stays green while the taxonomy the operator acts on is wrong.
 *
 * `match` is a `search`, not a full match, exactly as pytest's is.
 */
export function expectRefusal<T extends Error>(
  action: () => unknown,
  type: new (...args: never[]) => T,
  match?: RegExp | string,
): T {
  let thrown: unknown;
  let threw = false;
  try {
    action();
  } catch (error) {
    threw = true;
    thrown = error;
  }

  // Reported as its own assertion rather than folded into the type check: "did
  // not throw" and "threw the wrong type" are different bugs and the message
  // should say which one happened.
  expect(threw, `expected ${type.name} to be thrown, but nothing was thrown`).toBe(true);
  expect(thrown, `expected ${type.name}, got ${describeThrown(thrown)}`).toBeInstanceOf(type);

  if (match !== undefined) {
    const pattern = typeof match === "string" ? new RegExp(escapeRegExp(match)) : match;
    expect(String((thrown as Error).message)).toMatch(pattern);
  }
  return thrown as T;
}

/**
 * The same, for an error raised by SQLite rather than by the control plane.
 *
 * Takes the result **code** rather than a class, because better-sqlite3 raises
 * one error type for everything and the code is what carries the distinction
 * Python's exception hierarchy carried. Asserting the message alone would be
 * the same lost half as above: SQLite's message text is not a compatibility
 * surface, and its codes are.
 */
export function expectSqliteError(
  action: () => unknown,
  expected: { readonly code?: string | RegExp; readonly message?: RegExp | string },
): Error {
  let thrown: unknown;
  let threw = false;
  try {
    action();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  expect(threw, "expected a SQLite error to be thrown, but nothing was thrown").toBe(true);
  expect(thrown).toBeInstanceOf(Error);

  const code = (thrown as { code?: unknown }).code;
  if (expected.code !== undefined) {
    expect(typeof code, `expected a SQLite result code, got ${String(code)}`).toBe("string");
    if (typeof expected.code === "string") {
      expect(code).toBe(expected.code);
    } else {
      expect(String(code)).toMatch(expected.code);
    }
  }
  if (expected.message !== undefined) {
    const pattern =
      typeof expected.message === "string"
        ? new RegExp(escapeRegExp(expected.message))
        : expected.message;
    expect(String((thrown as Error).message)).toMatch(pattern);
  }
  return thrown as Error;
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return `${thrown.constructor.name}: ${thrown.message}`;
  }
  return String(thrown);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
