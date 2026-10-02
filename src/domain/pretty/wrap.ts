import { concatBytes } from '../objects/encoding.js';
import { isAsciiDigit, isAsciiSpace } from './ascii.js';
import { type Glyph, glyphAt } from './utf8-width.js';

/** The largest width or indent `%w(...)` accepts; it bounds how much a format can prepend. */
export const FORMATTING_LIMIT = 16 * 1024;

const NUL = 0;
const LINE_FEED = 0x0a;
const TAB = 0x09;
const SPACE = 0x20;
const ESCAPE = 0x1b;
const LEFT_BRACKET = 0x5b;
const SEMICOLON = 0x3b;
const LOWER_M = 0x6d;
const COMMA = 0x2c;
const TAB_STOP_MASK = 0x07;
const LAYOUT_SLOTS = 3;
const LINE_FEED_BYTES = Uint8Array.of(LINE_FEED);
const SPACE_BYTES = Uint8Array.of(SPACE);

export interface WrapLayout {
  readonly width: number;
  readonly indent1: number;
  readonly indent2: number;
}

/** The layout in force and where, in the output so far, the text it governs begins. */
export interface Wrapping {
  readonly layout: WrapLayout;
  readonly start: number;
}

export const NO_WRAPPING: Wrapping = {
  layout: { width: 0, indent1: 0, indent2: 0 },
  start: 0,
};

type Measure = (text: Uint8Array, at: number) => Glyph | undefined;
type Outcome = 'more' | 'done' | 'invalid-utf8';

const ONE_COLUMN_PER_BYTE: Measure = () => ({ columns: 1, length: 1 });

const spaces = (count: number): Uint8Array => new Uint8Array(count).fill(SPACE);

const isAsciiAlphanumeric = (byte: number): boolean =>
  isAsciiDigit(byte) || ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x7a);

const byteAt = (text: Uint8Array, at: number): number => text[at] ?? NUL;

const untilNul = (text: Uint8Array): Uint8Array => {
  const end = text.indexOf(NUL);
  return end === -1 ? text : text.subarray(0, end);
};

const indentLines = (text: Uint8Array, indent1: number, indent2: number): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let indent = indent1;
  let at = 0;
  while (at < text.length) {
    const lineFeed = text.indexOf(LINE_FEED, at);
    const end = lineFeed === -1 ? text.length : lineFeed + 1;
    chunks.push(spaces(indent), text.subarray(at, end));
    at = end;
    indent = indent2;
  }
  return concatBytes(chunks);
};

/** Bytes of the SGR escape (`ESC [ digits;… m`) starting at `at`, 0 when none starts there. */
export const escapeLengthAt = (text: Uint8Array, at: number): number => {
  if (byteAt(text, at) !== ESCAPE || byteAt(text, at + 1) !== LEFT_BRACKET) return 0;
  let end = at + 2;
  while (isAsciiDigit(byteAt(text, end)) || byteAt(text, end) === SEMICOLON) end++;
  return byteAt(text, end) === LOWER_M ? end + 1 - at : 0;
};

const skipEscapes = (text: Uint8Array, from: number): number => {
  let at = from;
  for (let length = escapeLengthAt(text, at); length > 0; length = escapeLengthAt(text, at)) {
    at += length;
  }
  return at;
};

/** Mutable cursor of one `wrapText` pass; never escapes it. */
interface Run {
  at: number;
  lineStart: number;
  lastSpace: number | undefined;
  column: number;
  indent: number;
  readonly chunks: Uint8Array[];
}

const startNextLine = (run: Run, text: Uint8Array, indent2: number): void => {
  const space = run.lastSpace as number;
  run.chunks.push(LINE_FEED_BYTES);
  run.lineStart = space + (isAsciiSpace(byteAt(text, space)) ? 1 : 0);
  run.at = run.lineStart;
  run.lastSpace = undefined;
  run.column = indent2;
  run.indent = indent2;
};

const emitWord = (run: Run, text: Uint8Array, atEnd: boolean): boolean => {
  if (atEnd && run.at === run.lineStart) return true;
  if (run.lastSpace === undefined) run.chunks.push(spaces(run.indent));
  run.chunks.push(text.subarray(run.lastSpace ?? run.lineStart, run.at));
  return atEnd;
};

/** Consumes the separator at the cursor; true when the next word must start a fresh line. */
const consumeSeparator = (run: Run, text: Uint8Array, separator: number): boolean => {
  run.lastSpace = run.at;
  if (separator === TAB) run.column |= TAB_STOP_MASK;
  if (separator === LINE_FEED) {
    run.lastSpace++;
    const next = byteAt(text, run.lastSpace);
    if (next === LINE_FEED) run.chunks.push(LINE_FEED_BYTES);
    if (next === LINE_FEED || !isAsciiAlphanumeric(next)) return true;
    run.chunks.push(SPACE_BYTES);
  }
  run.column++;
  run.at++;
  return false;
};

const stepSeparator = (run: Run, text: Uint8Array, width: number, indent2: number): Outcome => {
  const separator = byteAt(text, run.at);
  const overflows = run.column > width && run.lastSpace !== undefined;
  if (!overflows) {
    if (emitWord(run, text, separator === NUL)) return 'done';
    if (!consumeSeparator(run, text, separator)) return 'more';
  }
  startNextLine(run, text, indent2);
  return 'more';
};

const stepGlyph = (run: Run, text: Uint8Array, measure: Measure): Outcome => {
  const glyph = measure(text, run.at);
  if (!glyph) return 'invalid-utf8';
  run.column += glyph.columns;
  run.at += glyph.length;
  return 'more';
};

const wrapWith = (text: Uint8Array, layout: WrapLayout, measure: Measure): Uint8Array => {
  const { width, indent1, indent2 } = layout;
  const run: Run = {
    at: 0,
    lineStart: 0,
    lastSpace: undefined,
    column: indent1,
    indent: indent1,
    chunks: [],
  };
  for (;;) {
    run.at = skipEscapes(text, run.at);
    const next = byteAt(text, run.at);
    const outcome =
      next === NUL || isAsciiSpace(next)
        ? stepSeparator(run, text, width, indent2)
        : stepGlyph(run, text, measure);
    if (outcome === 'invalid-utf8') return wrapWith(text, layout, ONE_COLUMN_PER_BYTE);
    if (outcome === 'done') return concatBytes(run.chunks);
  }
};

/** git's `strbuf_add_wrapped_text`: C-string semantics, so the text ends at the first NUL. */
export const wrapText = (
  input: Uint8Array,
  indent1: number,
  indent2: number,
  width: number,
): Uint8Array => {
  const text = untilNul(input);
  if (width <= 0) return indentLines(text, indent1, indent2);
  return wrapWith(text, { width, indent1, indent2 }, glyphAt);
};

const sameLayout = (left: WrapLayout, right: WrapLayout): boolean =>
  left.width === right.width && left.indent1 === right.indent1 && left.indent2 === right.indent2;

/** git's `rewrap_message_tail`: wraps what was emitted under the current layout, then adopts `next`. */
export const rewrapTail = (pieces: Uint8Array[], current: Wrapping, next: WrapLayout): Wrapping => {
  if (sameLayout(current.layout, next)) return current;
  const emitted = concatBytes(pieces);
  const { width, indent1, indent2 } = current.layout;
  const wrapped =
    current.start < emitted.length
      ? concatBytes([
          emitted.subarray(0, current.start),
          wrapText(emitted.subarray(current.start), indent1, indent2, width),
        ])
      : emitted;
  pieces.splice(0, pieces.length, wrapped);
  return { layout: next, start: wrapped.length };
};

const UNSIGNED = /^[ \t\n\v\f\r]*([+-]?)(\d+)/;

interface Reading {
  readonly value: number;
  readonly next: number;
}

/** C unsigned-long parse: no digits reads nothing and leaves the cursor where it was. */
const readUnsigned = (text: string, from: number): Reading => {
  const match = UNSIGNED.exec(text.slice(from));
  if (!match) return { value: 0, next: from };
  const magnitude = Number(match[2]);
  const negated = match[1] === '-' && magnitude !== 0;
  return { value: negated ? Number.POSITIVE_INFINITY : magnitude, next: from + match[0].length };
};

const readLayout = (args: string): WrapLayout | undefined => {
  if (args === '') return NO_WRAPPING.layout;
  const values: number[] = [];
  let next = 0;
  for (let slot = 0; slot < LAYOUT_SLOTS; slot++) {
    const reading = readUnsigned(args, next);
    values.push(reading.value);
    next = reading.next;
    if (slot === LAYOUT_SLOTS - 1 || args.charCodeAt(next) !== COMMA) break;
    next++;
  }
  const [width = 0, indent1 = 0, indent2 = 0] = values;
  const withinLimit = values.every((value) => value <= FORMATTING_LIMIT);
  return next === args.length && withinLimit ? { width, indent1, indent2 } : undefined;
};

export interface ParsedWrap {
  readonly layout: WrapLayout;
  readonly length: number;
}

/** Parses `w(width,indent1,indent2)` starting at the `w` of `fmt[at]`; `length` counts through `)`. */
export const parseWrapLayout = (fmt: Uint8Array, at: number): ParsedWrap | undefined => {
  if (fmt[at + 1] !== 0x28) return undefined;
  const close = fmt.indexOf(0x29, at + 2);
  if (close === -1) return undefined;
  const layout = readLayout(new TextDecoder('latin1').decode(fmt.subarray(at + 2, close)));
  return layout && { layout, length: close - at + 1 };
};
