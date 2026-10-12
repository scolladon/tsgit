import { concatBytes } from '../objects/encoding.js';
import { glyphAt } from './utf8-width.js';
import { escapeLengthAt, FORMATTING_LIMIT } from './wrap.js';

export type Align = 'text-left' | 'text-right' | 'centered' | 'text-right-stealing';
export type Truncation = 'none' | 'right' | 'left' | 'middle';

export interface PadRequest {
  readonly width: number;
  readonly fromColumn: boolean;
  readonly align: Align;
}

export interface ParsedPadding {
  readonly request: PadRequest;
  /** `undefined` keeps whatever truncation an earlier placeholder chose, as git's context does. */
  readonly truncate: Truncation | undefined;
  /** Bytes through the closing `)`; 0 when git sets the request but leaves the text literal. */
  readonly length: number;
}

const LEFT_ANGLE = 0x3c;
const RIGHT_ANGLE = 0x3e;
const PIPE = 0x7c;
const LEFT_PAREN = 0x28;
const COMMA = 0x2c;
const RIGHT_PAREN = 0x29;
const SPACE = 0x20;
const LINE_FEED = 0x0a;
const ESCAPE = 0x1b;
const MAX_ESCAPE_REACH = 10;
const ELLIPSIS = new TextEncoder().encode('..');
const TERMINAL_COLUMNS = 80;
const INT_BITS = 32;
const LONG_MAX = 2n ** 63n - 1n;
const LONG_MIN = -(2n ** 63n);
const TRUNCATIONS: ReadonlyArray<readonly [string, Truncation]> = [
  ['trunc)', 'right'],
  ['ltrunc)', 'left'],
  ['mtrunc)', 'middle'],
];
const STRTOL = /^[ \t\n\v\f\r]*([+-]?\d+)/;

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

/** C `strtol` into an `int`: out-of-range saturates to a long, then wraps to 32 bits. */
const readInt = (text: string): number | undefined => {
  const digits = STRTOL.exec(text)?.[1];
  if (digits === undefined) return undefined;
  const clamped = [BigInt(digits)].map((n) =>
    n > LONG_MAX ? LONG_MAX : n < LONG_MIN ? LONG_MIN : n,
  )[0] as bigint;
  return Number(BigInt.asIntN(INT_BITS, clamped));
};

const alignOf = (fmt: Uint8Array, at: number): { align: Align; next: number } | undefined => {
  if (fmt[at] === LEFT_ANGLE) return { align: 'text-left', next: at + 1 };
  if (fmt[at] !== RIGHT_ANGLE) return undefined;
  if (fmt[at + 1] === LEFT_ANGLE) return { align: 'centered', next: at + 2 };
  if (fmt[at + 1] === RIGHT_ANGLE) return { align: 'text-right-stealing', next: at + 2 };
  return { align: 'text-right', next: at + 1 };
};

const truncationAt = (fmt: Uint8Array, at: number): Truncation | undefined => {
  const rest = latin1(fmt.subarray(at));
  return TRUNCATIONS.find(([name]) => rest.startsWith(name))?.[1];
};

const cursorWidth = (width: number): number | undefined => (width < 0 ? undefined : width);

/** `|(…)` counts a negative width back from the terminal's right edge. */
const columnWidth = (width: number): number | undefined =>
  cursorWidth(width < 0 ? width + TERMINAL_COLUMNS : width);

/** git's `parse_padding_placeholder`, `at` being the `<` or `>`. */
export const parsePadding = (fmt: Uint8Array, at: number): ParsedPadding | undefined => {
  const aligned = alignOf(fmt, at);
  if (!aligned) return undefined;
  const toColumn = fmt[aligned.next] === PIPE;
  const open = toColumn ? aligned.next + 1 : aligned.next;
  if (fmt[open] !== LEFT_PAREN) return undefined;
  const start = open + 1;
  let end = start;
  while (end < fmt.length && fmt[end] !== COMMA && fmt[end] !== RIGHT_PAREN) end++;
  if (end >= fmt.length) return undefined;
  const raw = readInt(latin1(fmt.subarray(start, end)));
  if (raw === undefined || raw === 0 || Math.abs(raw) > FORMATTING_LIMIT) return undefined;
  const width = toColumn ? columnWidth(raw) : cursorWidth(raw);
  if (width === undefined) return undefined;
  const request: PadRequest = { width, fromColumn: toColumn && width !== 0, align: aligned.align };
  if (fmt[end] !== COMMA) return { request, truncate: undefined, length: end - at + 1 };
  const truncate = truncationAt(fmt, end + 1);
  return truncate === undefined
    ? { request, truncate: undefined, length: 0 }
    : { request, truncate, length: fmt.indexOf(RIGHT_PAREN, end) - at + 1 };
};

const spaces = (count: number): Uint8Array => new Uint8Array(count).fill(SPACE);

const displayWidth = (bytes: Uint8Array): number => {
  let width = 0;
  let at = 0;
  while (at < bytes.length) {
    const skipped = escapeLengthAt(bytes, at);
    if (skipped > 0) {
      at += skipped;
      continue;
    }
    const glyph = glyphAt(bytes, at);
    if (!glyph) return bytes.length;
    width += Math.max(0, glyph.columns);
    at += glyph.length;
  }
  return width;
};

const occupiedColumns = (head: Uint8Array): number =>
  displayWidth(head.subarray(Math.max(0, head.lastIndexOf(LINE_FEED))));

/** git's `strbuf_utf8_replace`: the glyphs from column `from` for `span` columns become one `..`. */
const replaceColumns = (value: Uint8Array, from: number, span: number): Uint8Array => {
  const out: number[] = [];
  let column = 0;
  let at = 0;
  let marked = false;
  while (at < value.length) {
    const skipped = escapeLengthAt(value, at);
    const glyph = skipped > 0 ? { columns: 0, length: skipped } : glyphAt(value, at);
    if (!glyph) return value;
    const columns = Math.max(0, glyph.columns);
    const replaced = columns > 0 && column >= from && column < from + span;
    if (replaced && !marked) out.push(...ELLIPSIS);
    if (!replaced) out.push(...value.subarray(at, at + glyph.length));
    marked ||= replaced;
    column += columns;
    at += glyph.length;
  }
  return Uint8Array.from(out);
};

const truncated = (
  value: Uint8Array,
  len: number,
  padding: number,
  how: Truncation,
): Uint8Array => {
  const span = len - (padding - ELLIPSIS.length);
  if (how === 'left') return replaceColumns(value, 0, span);
  if (how === 'middle') return replaceColumns(value, Math.trunc(padding / 2) - 1, span);
  return how === 'right' ? replaceColumns(value, padding - ELLIPSIS.length, span) : value;
};

const aligned = (value: Uint8Array, len: number, padding: number, align: Align): Uint8Array => {
  const spare = padding - len;
  const before = align === 'text-left' ? 0 : align === 'centered' ? Math.trunc(spare / 2) : spare;
  return concatBytes([spaces(before), value, spaces(spare - before)]);
};

interface Stolen {
  readonly head: Uint8Array;
  readonly value: Uint8Array;
  readonly padding: number;
}

const trailingEscapeStart = (head: Uint8Array, last: number): number | undefined => {
  let start = last - 1;
  // Past the head's start the bytes read undefined, so the reach alone ends the scan.
  while (last - start < MAX_ESCAPE_REACH && head[start] !== ESCAPE) start--;
  // Only an escape at `start` ending in the `m` at `last` spans this exactly.
  const complete = last + 1 - start === escapeLengthAt(head, start);
  return complete ? start : undefined;
};

/** `flush_left_and_steal`: trailing spaces (and the escapes between them) of `head` make room for `value`. */
const steal = (head: Uint8Array, value: Uint8Array, len: number, padding: number): Stolen => {
  let last = head.length - 1;
  let moved = value;
  let room = padding;
  while (len > room && last > 0) {
    if (head[last] === SPACE) {
      last--;
      room++;
      continue;
    }
    const start = trailingEscapeStart(head, last);
    if (start === undefined) break;
    moved = concatBytes([head.subarray(start, last + 1), moved]);
    last = start - 1;
  }
  return { head: head.subarray(0, last + 1), value: moved, padding: room };
};

export interface Padded {
  /** What was already emitted, shortened when a stealing pad took its trailing spaces. */
  readonly head: Uint8Array;
  readonly body: Uint8Array;
}

/** git's `format_and_pad_commit` over the `head` emitted so far and the placeholder's `value`. */
export const padValue = (
  head: Uint8Array,
  value: Uint8Array,
  request: PadRequest,
  truncate: Truncation,
): Padded => {
  const len = displayWidth(value);
  const padding = request.fromColumn ? request.width - occupiedColumns(head) : request.width;
  const stealing = request.align === 'text-right-stealing';
  const taken = stealing ? steal(head, value, len, padding) : { head, value, padding };
  const align = stealing ? 'text-right' : request.align;
  const body =
    len > taken.padding
      ? truncated(taken.value, len, taken.padding, truncate)
      : aligned(taken.value, len, taken.padding, align);
  return { head: taken.head, body };
};
