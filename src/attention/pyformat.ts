/**
 * CPython's format-string machinery, transcribed: `string.Formatter().parse`, `str.format_map`
 * and `str.__format__`.
 *
 * Ported for interlock `claude_org_runtime/attention/notify.py` at `65f36c5`, which is the one
 * module in the subsystem that formats a template **the operator wrote**. Everything else in the
 * attention belt formats a template the port itself ships: `classifier.ts`'s `defaultText` runs a
 * closed set of bundled strings through a private substitution, and a private substitution is the
 * right size for a closed set. This file exists because `notify.render_text` is the opposite case
 * -- arbitrary text from `attention.json` -- and its whole contract is that a *misspelled* one
 * must produce a warning and a fallback rather than a crash or a wrong render. That contract is
 * only as good as the parser behind it:
 *
 * - `_placeholders` decides which names a template references, and the section 6 allowlist is checked
 *   against that answer. A parser that misses `{summary!r:>10}`'s name, or that reads `{{pr}}` as
 *   a reference to `pr`, hands the allowlist the wrong set -- so it either lets a template reach
 *   into a field the design forbids, or refuses one the design allows.
 * - `_format_with_event` then renders, and the source catches exactly `(ValueError, IndexError)`
 *   around it. Which inputs raise which is CPython's answer, not a detail: a template this
 *   transcription refuses where CPython renders is an operator's template silently replaced by
 *   the English default, and one it renders where CPython refuses is a crash in the watcher.
 *
 * **The domain is deliberately narrow: every value formatted here is a `str`.**
 * `_format_with_event` builds its mapping out of six strings and nothing else, so
 * {@link formatValue} implements `str.__format__` and no other type's. A number reaching it is a
 * caller error rather than a case to guess at, and it is refused rather than formatted by some
 * near-miss of CPython's numeric mini-language.
 *
 * **What is NOT carried, disclosed rather than left to be discovered.** CPython's width and
 * precision readers accept any Unicode decimal digit (`Py_UNICODE_TODECIMAL`), so a width written with an
 * Arabic-Indic digit three (U+0663) is
 * a width of 3 there and an invalid specifier here. Reproducing it needs the Unicode decimal
 * table; nothing in the attention belt reaches it, and the divergence is a *refusal* -- the
 * watcher warns and falls back to its default template -- rather than a wrong render. The wording
 * of the `ValueError` messages is likewise approximate where CPython's own text varies between
 * versions: the source prints them inside a warning and no case in either suite reads one.
 */

import { pyRepr } from "../fencing/pyrepr.js";
import { getOwn, PyValueError } from "../fencing/pysemantics.js";

/**
 * One tuple `string.Formatter().parse()` yields.
 *
 * `fieldName` is `null` where CPython yields `None` -- trailing literal text with no replacement
 * field after it -- and `""` for the auto-numbered `{}`, which is a different thing and which
 * `notify._placeholders` skips by testing `if not field_name`. Keeping the two apart is the whole
 * reason this is `string | null` rather than a string that happens to be empty.
 */
export interface FormatChunk {
  readonly literal: string;
  readonly fieldName: string | null;
  readonly formatSpec: string;
  readonly conversion: string | null;
}

/**
 * `string.Formatter().parse(template)`, as a list.
 *
 * A transcription of CPython's `MarkupIterator_next` and `parse_field`
 * (`Objects/stringlib/unicode_format.h`), including the four `ValueError`s they raise, because
 * `notify._placeholders` treats "this template does not parse" as one of its two failure modes
 * and the source's own case for it (`{summary[0]}`) is only one of them.
 *
 * The scan looks for `{` and `}` by UTF-16 unit while CPython looks by code point, and the two
 * agree: neither brace is expressible as a surrogate, so no cut this function makes can land
 * inside a surrogate pair.
 */
export function parseFormat(template: string): FormatChunk[] {
  const out: FormatChunk[] = [];
  const end = template.length;
  let pos = 0;
  while (pos < end) {
    const start = pos;
    // CPython keeps the last character it read even when the scan runs off the end, and the two
    // single-brace errors below are asked of that character. A `c` reset per iteration would make
    // both unreachable.
    let c = "";
    while (pos < end) {
      c = template[pos++] as string;
      if (c === "{" || c === "}") {
        break;
      }
    }
    const atEnd = pos >= end;
    let literalLength = pos - start;
    let markupFollows = c === "{" || c === "}";
    if (c === "}" && (atEnd || template[pos] !== c)) {
      throw new PyValueError("Single '}' encountered in format string");
    }
    if (atEnd && c === "{") {
      throw new PyValueError("Single '{' encountered in format string");
    }
    if (!atEnd && markupFollows) {
      if (template[pos] === c) {
        // `{{` or `}}`: the literal keeps ONE brace and no replacement field follows.
        pos += 1;
        markupFollows = false;
      } else {
        literalLength -= 1;
      }
    }
    const literal = template.slice(start, start + literalLength);
    if (!markupFollows) {
      out.push({ literal, fieldName: null, formatSpec: "", conversion: null });
      continue;
    }
    const field = parseField(template, pos, end);
    pos = field.next;
    out.push({ literal, ...field.chunk });
  }
  return out;
}

/** CPython's `parse_field`, from just after the opening `{`. */
function parseField(
  template: string,
  from: number,
  end: number,
): { readonly chunk: Omit<FormatChunk, "literal">; readonly next: number } {
  let pos = from;
  let c = "";
  while (pos < end) {
    c = template[pos++] as string;
    if (c === "{") {
      throw new PyValueError("unexpected '{' in field name");
    }
    if (c === "[") {
      // A `:` or `!` inside an index is part of the field name, so the scan runs to the `]`
      // before it resumes looking for a terminator.
      while (pos < end && template[pos] !== "]") {
        pos += 1;
      }
      continue;
    }
    if (c === "}" || c === ":" || c === "!") {
      break;
    }
  }
  // CPython drops the terminator from the field name unconditionally -- including on the
  // exhausted-scan path, which the `expected '}'` refusal below then rejects anyway.
  const fieldName = template.slice(from, pos - 1);
  let conversion: string | null = null;
  if (c !== "!" && c !== ":") {
    if (c !== "}") {
      throw new PyValueError("expected '}' before end of string");
    }
    return { chunk: { fieldName, formatSpec: "", conversion: null }, next: pos };
  }
  if (c === "!") {
    if (pos >= end) {
      throw new PyValueError("end of string while looking for conversion specifier");
    }
    conversion = template[pos++] as string;
    if (pos >= end) {
      throw new PyValueError("unmatched '{' in format spec");
    }
    const after = template[pos++] as string;
    if (after === "}") {
      return { chunk: { fieldName, formatSpec: "", conversion }, next: pos };
    }
    if (after !== ":") {
      throw new PyValueError("expected ':' after conversion specifier");
    }
  }
  const specStart = pos;
  let depth = 1;
  while (pos < end) {
    const spec = template[pos++] as string;
    if (spec === "{") {
      depth += 1;
    } else if (spec === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          chunk: { fieldName, formatSpec: template.slice(specStart, pos - 1), conversion },
          next: pos,
        };
      }
    }
  }
  throw new PyValueError("unmatched '{' in format spec");
}

/**
 * `template.format_map(mapping)` where every value is a `str`.
 *
 * `mapping` is read with `getOwn`, per `docs/test-translation-conventions.md` rule 9: the field
 * name is operator-supplied text used as a map key and a Python `dict` has no inherited keys, so
 * `"{constructor}"` must be a lookup that misses rather than one that finds
 * `Object.prototype.constructor`.
 *
 * A field naming a positional argument raises `PyValueError("Format string contains positional
 * fields")`, which is what CPython raises here: `format_map` supplies a mapping and NO positional
 * argument tuple at all, and the null-tuple test comes before any index test. That is measured
 * rather than assumed -- see the comment at the raise -- and it is why this transcription raises
 * one class where `notify.render_text`'s source catches two.
 */
export function formatMap(
  template: string,
  mapping: Readonly<Record<string, string>>,
  options: { readonly depth?: number } = {},
): string {
  const depth = options.depth ?? 2;
  if (depth <= 0) {
    // CPython's `PyObject_Format` recursion guard: a format spec may itself contain replacement
    // fields, but only one level deep.
    throw new PyValueError("Max string recursion exceeded");
  }
  let out = "";
  for (const chunk of parseFormat(template)) {
    out += chunk.literal;
    if (chunk.fieldName === null) {
      continue;
    }
    const [head, accessors] = splitFieldName(chunk.fieldName);
    if (accessors !== "") {
      // Unreachable through `notify.render_text`, which refuses `.` and `[` in the allowlist
      // check before it ever formats. Refused rather than implemented, because implementing it
      // means implementing attribute and item access on the mapping's values -- the very reach
      // the section 6 allowlist exists to forbid.
      throw new PyValueError(
        `attribute and index access are not supported in this transcription: {${chunk.fieldName}}`,
      );
    }
    if (head === "" || /^[0-9]+$/.test(head)) {
      // MEASURED against CPython 3.12.3 rather than reasoned about, and the reasoned answer was
      // wrong. `format_map` passes NO positional argument tuple at all (`args == NULL`), and
      // `get_field_object` tests that before it tests the index, so BOTH the auto-numbered `{}`
      // and an explicit `{0}` raise this `ValueError` -- not the `IndexError` that an empty
      // tuple would have produced. The consequence is recorded in
      // `parity/attention.notify.ledger.json`: the `IndexError` half of the source's
      // `except (ValueError, IndexError)` is UNREACHABLE through `render_text`, because
      // `_format_with_event` only ever calls `format_map`.
      throw new PyValueError("Format string contains positional fields");
    }
    const value = getOwn(mapping, head);
    if (typeof value !== "string") {
      // `format_map` raises `KeyError` here. This transcription's callers pass a closed mapping
      // and check every name against the allowlist first, so reaching this is a bug in the
      // caller rather than an operator's typo -- and a `PyValueError` is what the one call site
      // handles. Named explicitly so it cannot be read as a rendered empty string.
      throw new PyValueError(`format_map has no value for field {${head}}`);
    }
    const converted = applyConversion(value, chunk.conversion);
    const spec =
      chunk.formatSpec.includes("{") || chunk.formatSpec.includes("}")
        ? formatMap(chunk.formatSpec, mapping, { depth: depth - 1 })
        : chunk.formatSpec;
    out += formatValue(converted, spec);
  }
  return out;
}

/** CPython's `field_name_split`: the first component, and whatever accessors follow it. */
function splitFieldName(fieldName: string): [string, string] {
  for (let index = 0; index < fieldName.length; index += 1) {
    const ch = fieldName[index];
    if (ch === "." || ch === "[") {
      return [fieldName.slice(0, index), fieldName.slice(index)];
    }
  }
  return [fieldName, ""];
}

/** `!s`, `!r` and `!a`, over a value already known to be a `str`. */
function applyConversion(value: string, conversion: string | null): string {
  if (conversion === null || conversion === "s") {
    return value;
  }
  if (conversion === "r") {
    return pyRepr(value);
  }
  if (conversion === "a") {
    return pyAscii(value);
  }
  throw new PyValueError(`Unknown conversion specifier ${conversion}`);
}

/**
 * Python's `ascii()` over a `str`.
 *
 * `repr()` already escapes every non-printable code point, so the only ones left above ASCII are
 * the *printable* non-ASCII characters `ascii()` additionally escapes. Built on {@link pyRepr}
 * rather than as a second escaping loop, so the two cannot disagree about which escape width
 * CPython chooses for a given code point.
 */
function pyAscii(value: string): string {
  let out = "";
  for (const ch of pyRepr(value)) {
    const code = ch.codePointAt(0) as number;
    if (code <= 0x7e) {
      out += ch;
      continue;
    }
    if (code < 0x100) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (code < 0x10000) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\U${code.toString(16).padStart(8, "0")}`;
    }
  }
  return out;
}

/** The pieces CPython's `parse_internal_render_format_spec` recognises. */
interface RenderSpec {
  fill: string;
  align: string;
  sign: string;
  noNegZero: boolean;
  alternate: boolean;
  width: number | null;
  thousands: string;
  precision: number | null;
  type: string;
}

/**
 * `format(value, spec)` for a `str`, i.e. CPython's `unicode__format__`.
 *
 * Width and precision count **code points**, as CPython counts them: `len()` on a `str` is a code
 * point count, so a body padded to a width in UTF-16 units would be short by one for every
 * astral character -- and an emoji in an operator's template is not a hypothetical.
 */
export function formatValue(value: string, spec: string): string {
  const parsed = parseRenderSpec(spec);
  if (parsed.type !== "" && parsed.type !== "s") {
    throw new PyValueError(
      `Unknown format code '${presentationTypeName(parsed.type)}' for object of type 'str'`,
    );
  }
  if (parsed.sign !== "") {
    throw new PyValueError("Sign not allowed in string format specifier");
  }
  if (parsed.noNegZero) {
    throw new PyValueError("Negative zero coercion (z) not allowed in string format specifier");
  }
  if (parsed.alternate) {
    throw new PyValueError("Alternate form (#) not allowed in string format specifier");
  }
  if (parsed.align === "=") {
    throw new PyValueError("'=' alignment not allowed in string format specifier");
  }
  if (parsed.thousands !== "") {
    throw new PyValueError(`Cannot specify '${parsed.thousands}' with 's'.`);
  }
  let points = [...value];
  if (parsed.precision !== null && points.length > parsed.precision) {
    points = points.slice(0, parsed.precision);
  }
  const width = parsed.width ?? 0;
  const padding = width - points.length;
  if (padding <= 0) {
    return points.join("");
  }
  const fill = parsed.fill === "" ? " " : parsed.fill;
  const align = parsed.align === "" ? "<" : parsed.align;
  const text = points.join("");
  if (align === "<") {
    return text + fill.repeat(padding);
  }
  if (align === ">") {
    return fill.repeat(padding) + text;
  }
  // `^`: CPython puts the smaller half on the left.
  const left = Math.floor(padding / 2);
  return fill.repeat(left) + text + fill.repeat(padding - left);
}

/** CPython's `parse_internal_render_format_spec`, in its documented order. */
function parseRenderSpec(spec: string): RenderSpec {
  const points = [...spec];
  const out: RenderSpec = {
    fill: "",
    align: "",
    sign: "",
    noNegZero: false,
    alternate: false,
    width: null,
    thousands: "",
    precision: null,
    type: "",
  };
  let index = 0;
  const isAlign = (ch: string | undefined): boolean =>
    ch === "<" || ch === ">" || ch === "=" || ch === "^";
  if (points.length >= 2 && isAlign(points[1])) {
    out.fill = points[0] as string;
    out.align = points[1] as string;
    index = 2;
  } else if (points.length >= 1 && isAlign(points[0])) {
    out.align = points[0] as string;
    index = 1;
  }
  const sign = points[index];
  if (sign === "+" || sign === "-" || sign === " ") {
    out.sign = sign;
    index += 1;
  }
  if (points[index] === "z") {
    // CPython 3.11's negative-zero coercion. PARSED here and REFUSED in `formatValue`, which is
    // where CPython refuses it -- the split matters because a spec is parsed once and then
    // handed to a type's `__format__`, and putting the refusal in the parser would make it a
    // property of every type rather than of `str`.
    out.noNegZero = true;
    index += 1;
  }
  if (points[index] === "#") {
    out.alternate = true;
    index += 1;
  }
  if (points[index] === "0") {
    // MEASURED: `format("42", "010")` is `"4200000000"` and `format("42", "0")` is `"42"`, so a
    // leading `0` sets the FILL and does NOT set `=` alignment here. CPython only takes the
    // alignment branch when the type's own `default_align` is `>`, which is the numeric types'
    // default and not `str`'s -- and `str.__format__` refuses `=` outright, so the reasoned-from-
    // the-grammar reading made both of those specifiers a refusal instead of a render.
    out.fill = "0";
    index += 1;
  }
  const widthStart = index;
  while (
    index < points.length &&
    (points[index] as string) >= "0" &&
    (points[index] as string) <= "9"
  ) {
    index += 1;
  }
  if (index > widthStart) {
    out.width = readInteger(points.slice(widthStart, index).join(""));
  }
  if (points[index] === "," || points[index] === "_") {
    out.thousands = points[index] as string;
    index += 1;
  }
  if (points[index] === ".") {
    index += 1;
    const precisionStart = index;
    while (
      index < points.length &&
      (points[index] as string) >= "0" &&
      (points[index] as string) <= "9"
    ) {
      index += 1;
    }
    if (index === precisionStart) {
      throw new PyValueError("Format specifier missing precision");
    }
    out.precision = readInteger(points.slice(precisionStart, index).join(""));
  }
  const remaining = points.length - index;
  if (remaining > 1) {
    throw new PyValueError(`Invalid format specifier '${spec}' for object of type 'str'`);
  }
  if (remaining === 1) {
    out.type = points[index] as string;
  }
  return out;
}

/**
 * How CPython spells the offending presentation type inside its own refusal.
 *
 * `unknown_presentation_type` prints the character itself only when it is in `(32, 128)`, and
 * `\x<hex>` otherwise -- unpadded, lowercase. MEASURED through the oracle rather than assumed: a
 * template whose format spec is a bare newline refuses with `Unknown format code '\xa' for object
 * of type 'str'`, and a naive `%c` transcription puts a literal newline in the middle of an
 * operator's warning line instead.
 */
function presentationTypeName(type: string): string {
  const code = type.codePointAt(0) as number;
  if (code > 32 && code < 128) {
    return type;
  }
  return `\\x${code.toString(16)}`;
}

/**
 * CPython's `get_integer`, including the overflow it refuses.
 *
 * `Number.parseInt` alone silently produces `1e33` for a width of thirty-three nines, and
 * `String.prototype.repeat` then throws a `RangeError` -- which is neither of the two classes
 * `notify.render_text` catches, so an operator's mistyped template takes the watcher down instead
 * of falling back to the default. CPython refuses the same input at the parse, with
 * `ValueError("Too many decimal digits in format string")` when the accumulator would pass
 * `PY_SSIZE_T_MAX`, and `render_text` falls back. MEASURED: `format("42", "9" * 33)` raises that
 * `ValueError` on CPython 3.12.3, and both are in the oracle's corpus.
 *
 * The comparison is done in `BigInt` rather than by counting digits, because the boundary is a
 * value and not a length: nineteen digits may be either side of it.
 *
 * **What this does NOT close, disclosed rather than left to be found.** Between V8's maximum
 * string length (about 2**29 characters) and `PY_SSIZE_T_MAX`, the two runtimes still differ:
 * CPython attempts the allocation -- `format("42", "1" * 10)` really does build a 1.1 GB string,
 * and `format("42", "99999999999")` raises `MemoryError`, which the source does not catch either
 * -- while this runtime raises `RangeError` from `repeat`. So a width in that range is a crash on
 * both sides, at different thresholds and with different exception names, rather than a render on
 * one and a crash on the other. Closing it would mean refusing a width CPython accepts, which is
 * a divergence in the other direction and a larger one.
 */
function readInteger(digits: string): number {
  if (BigInt(digits) > 9223372036854775807n) {
    throw new PyValueError("Too many decimal digits in format string");
  }
  return Number.parseInt(digits, 10);
}
