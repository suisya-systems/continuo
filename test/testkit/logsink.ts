import { onTestFinished } from "vitest";

/**
 * pytest's `caplog`, as a structured sink rather than a console spy.
 *
 * Nothing in the pilot's source file uses `caplog` -- interlock's suite does
 * not use it anywhere -- so this ships now, with the rest of the frozen
 * testkit, and is pinned by a **target-only** contract test that translates no
 * source case and is not counted in the parity ledger.
 *
 * The mapping rule it exists to record: a `caplog` assertion is about
 * **records**, not about text. `caplog.records` carries the level, the logger
 * name, the message, the exception, and the order; `caplog.at_level` bounds
 * what is captured. A `vi.spyOn(console, "error")` translation keeps only the
 * rendered string, so an assertion on level or logger name has to be rewritten
 * as a substring match against the formatted line -- which passes when the
 * formatter changes and the level does not, and fails when the formatter
 * changes and nothing else does.
 *
 * So continuo's rule is: code under test takes a {@link LogSink}, and tests
 * inject {@link recordingSink}. There is no ambient logger to spy on, which
 * makes the naive translation unavailable rather than merely discouraged.
 */

/** Severity, named as Python's `logging` names them. */
export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

/** One emitted record, with everything an assertion might be about. */
export interface LogRecord {
  readonly level: LogLevel;
  /** The logger's dotted name, as `logging.getLogger(__name__)` would give. */
  readonly logger: string;
  readonly message: string;
  /** Present when the record was emitted with an exception attached. */
  readonly error?: unknown;
}

/** What code under test is handed. */
export interface LogSink {
  emit(record: LogRecord): void;
}

/** A sink that remembers, for tests to assert against. */
export interface RecordingSink extends LogSink {
  /** Every record, in emission order. */
  readonly records: readonly LogRecord[];
  /** The records at one level, in emission order. */
  at(level: LogLevel): readonly LogRecord[];
  /** Just the messages, for the assertions that really are about text. */
  readonly messages: readonly string[];
  /** Forget everything captured so far. */
  clear(): void;
}

/**
 * A recording sink for the running test.
 *
 * Cleared when the test finishes, so a sink that a helper accidentally shares
 * between tests cannot carry records across a shuffled boundary and make one
 * test's assertion depend on which test ran before it.
 */
export function recordingSink(): RecordingSink {
  const records: LogRecord[] = [];
  const sink: RecordingSink = {
    emit(record: LogRecord): void {
      records.push(record);
    },
    get records(): readonly LogRecord[] {
      return records;
    },
    at(level: LogLevel): readonly LogRecord[] {
      return records.filter((record) => record.level === level);
    },
    get messages(): readonly string[] {
      return records.map((record) => record.message);
    },
    clear(): void {
      records.length = 0;
    },
  };
  onTestFinished(() => {
    sink.clear();
  });
  return sink;
}
