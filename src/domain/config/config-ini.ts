/**
 * Pure git-config INI tokenizer/parser and value-grammar primitives
 * (boolean, integer) — text in, structured tokens/values out, with zero
 * dependency on `Context` or any scope/caching concern. Split out of
 * `config-read.ts` so the scope-resolution machinery
 * (`internal/config-scope.ts`, `config-scoped-read.ts`) can depend on it
 * without importing `config-read.ts` itself — that edge would otherwise
 * cycle back, since `config-read.ts`'s own scope-aware `readConfig`
 * depends on that same scope-resolution machinery.
 */
import { configParseError } from '../commands/error.js';

/**
 * One `[section "subsection"]` block of a git-config-format INI file: the
 * section name, an optional quoted subsection, and its key/value entries.
 * Exported so `.gitmodules` parsing — byte-identical grammar — reuses one
 * tokenizer (ADR-086).
 *
 * Entry `value`:
 *   - `string` — key present with `=` (possibly `''` for `key =`)
 *   - `null`   — key present with no `=` (git's internal NULL; boolean-true)
 *   - `undefined` is never used here; the absent-key state lives one layer up
 */
export interface IniSection {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string | null }>;
}

/** Internal builder shape — `entries` stays mutable while a section is collected. */
interface SectionBuilder {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: Array<{ readonly key: string; readonly value: string | null }>;
}

/** Physical-line classification of git-config text; the writer's surgery unit. */
export type ConfigToken =
  | {
      readonly kind: 'header';
      readonly section: string;
      readonly subsection: string | undefined;
      readonly line: number;
      /** Header line carries an unquoted inline `#`/`;` comment (blocks empty-section pruning). */
      readonly hasComment: boolean;
    }
  | {
      readonly kind: 'entry';
      readonly key: string;
      readonly value: string | null;
      readonly startLine: number;
      /** Exclusive — `parseConfigValue`'s `nextLineIdx`; `startLine + 1` for single-line entries. */
      readonly endLine: number;
      /**
       * Present when the entry shares the header's physical line (`[a] key = v`).
       * The header still owns the bytes before `startCol`; the writer re-emits the
       * header onto its own line before this entry when it rewrites the shared line.
       */
      readonly sharesHeaderLine?: true;
      /** Column where a shared-header-line entry begins (just past the header skip). */
      readonly startCol?: number;
    }
  | { readonly kind: 'comment'; readonly line: number }
  | { readonly kind: 'blank'; readonly line: number };

/** One scanned key: its name, its value (`null` when valueless), and the line after it. */
interface ScannedKey {
  readonly key: string;
  readonly value: string | null;
  readonly nextLineIdx: number;
}

/** A key character: the first must be a letter, the rest letters/digits/dash. */
const isKeyHead = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isKeyTail = (c: string): boolean => isKeyHead(c) || (c >= '0' && c <= '9') || c === '-';

/** Space and TAB only — the run git skips between a key and its `=` or EOL (no CR). */
const isKeyGap = (c: string): boolean => c === ' ' || c === '\t';

/**
 * git's one key scanner, shared by the `=` and no-`=` paths. From column `start`
 * on `lines[lineIdx]`: the first char must be a letter, then letters/digits/dash
 * run into the key, then space/TAB is skipped. End of line (or a trailing CR)
 * yields a valueless entry (`value: null`); an `=` hands the rest to the value
 * grammar; anything else — including a mid-key `#`/`;` — refuses the whole file
 * with `CONFIG_PARSE_ERROR`, mirroring git's `bad config line N`.
 */
const scanKey = (
  lines: ReadonlyArray<string>,
  lineIdx: number,
  start: number,
  source: string | undefined,
): ScannedKey => {
  const line = lines[lineIdx] as string;
  if (start >= line.length || !isKeyHead(line[start] as string)) {
    throw configParseError(lineIdx + 1, source);
  }
  let col = start + 1;
  while (col < line.length && isKeyTail(line[col] as string)) col += 1;
  const key = line.slice(start, col);
  while (col < line.length && isKeyGap(line[col] as string)) col += 1;
  const valueless: ScannedKey = { key, value: null, nextLineIdx: lineIdx + 1 };
  if (col >= line.length) return valueless;
  const c = line[col] as string;
  if (c === '\r' && col === line.length - 1) return valueless;
  if (c !== '=') throw configParseError(lineIdx + 1, source);
  const parsed = parseConfigValue(lines, lineIdx, col + 1, source);
  return { key, value: parsed.value, nextLineIdx: parsed.nextLineIdx };
};

/** Index of the first non-space/TAB character at or after `start`, or the line length. */
const firstNonGap = (line: string, start: number): number => {
  let col = start;
  while (col < line.length && isKeyGap(line[col] as string)) col += 1;
  return col;
};

/**
 * Produce a flat token stream of physical-line classifications for git-config text.
 * The scan is char-wise like git's: a header may be followed on the same line by
 * an entry, so one physical line can yield a `header` token plus a same-line
 * `entry` token (marked `sharesHeaderLine`). The stream is the writer's surgery
 * unit. Degenerate case: empty text (`''`) yields one `blank` token at line 0,
 * because `''.split('\n')` produces a single empty line; consumers that skip
 * blanks see `[]`.
 *
 * Terminator handling: when `text` ends with `\n`, the final empty element from
 * `split('\n')` is the file terminator and emits no token. Continuation values may
 * still consume it (their `endLine` may equal `lines.length`).
 *
 * Throws `CONFIG_PARSE_ERROR` for malformed headers, unknown value escapes, unclosed
 * quotes, and invalid key grammar — mirroring `parseIniSections` exactly.
 */
export const tokenizeConfig = (text: string, source?: string): ReadonlyArray<ConfigToken> =>
  tokenizeConfigLines(text.split('\n'), text.endsWith('\n'), source);

/**
 * Same as `tokenizeConfig` over pre-split lines, so writers that already hold
 * the line array do not split the text twice. `endsWithNewline` tells whether
 * the final array element is the file terminator rather than a content line.
 */
export const tokenizeConfigLines = (
  lines: ReadonlyArray<string>,
  endsWithNewline: boolean,
  source?: string,
): ReadonlyArray<ConfigToken> => {
  const tokens: ConfigToken[] = [];
  const limit = endsWithNewline ? lines.length - 1 : lines.length;
  let lineIdx = 0;
  while (lineIdx < limit) {
    lineIdx = tokenizeLine(tokens, lines, lineIdx, source);
  }
  return tokens;
};

/** Tokenize one physical line, pushing its token(s) and returning the next line index. */
const tokenizeLine = (
  tokens: ConfigToken[],
  lines: ReadonlyArray<string>,
  lineIdx: number,
  source: string | undefined,
): number => {
  const line = lines[lineIdx] as string;
  const trimmed = stripInlineComment(line).trim();
  if (trimmed === '') {
    tokens.push(
      line.trim() === '' ? { kind: 'blank', line: lineIdx } : { kind: 'comment', line: lineIdx },
    );
    return lineIdx + 1;
  }
  const header = scanHeaderPrefix(line);
  if (header.parse.kind === 'header') {
    return emitHeaderLine(tokens, lines, lineIdx, header, source);
  }
  if (header.parse.kind === 'malformed') {
    throw configParseError(lineIdx + 1, source, header.parse.partialName);
  }
  // Not a header and not a comment: scan it as a key line. A bracket-shaped line
  // that is not a valid header (`[ core ]`, `[a b]`, `[half`) has no key character
  // at its first column, so `scanKey` refuses it — exactly as git does.
  return emitBodyEntry(tokens, lines, lineIdx, source);
};

/** Scan a whole-line entry from its first non-space column. */
const emitBodyEntry = (
  tokens: ConfigToken[],
  lines: ReadonlyArray<string>,
  lineIdx: number,
  source: string | undefined,
): number => {
  const start = firstNonGap(lines[lineIdx] as string, 0);
  const scanned = scanKey(lines, lineIdx, start, source);
  tokens.push({
    kind: 'entry',
    key: scanned.key,
    value: scanned.value,
    startLine: lineIdx,
    endLine: scanned.nextLineIdx,
  });
  return scanned.nextLineIdx;
};

/**
 * Push the header token(s) on this physical line, then scan its remainder.
 * git lets headers chain on one line (`[a][b]`): each `]`-closed bracket span
 * after GIT_SPACE that opens with `[` is another header, and the content after
 * the chain — same-line entry, `#`/`;` comment, or nothing — lands under the
 * LAST header (it is the open section when the body is read). A same-line entry
 * keeps its `sharesHeaderLine`/`startCol` marker relative to that last header.
 * Cost stays linear: a single integer cursor advances over the line, scanning
 * each bracket span in place from its offset — no per-span substring copy and
 * no re-scan from the line start, so a chain of K headers is O(line length).
 */
const emitHeaderLine = (
  tokens: ConfigToken[],
  lines: ReadonlyArray<string>,
  lineIdx: number,
  header: HeaderPrefixScan,
  source: string | undefined,
): number => {
  const line = lines[lineIdx] as string;
  let current = header;
  let contentStart = skipGitSpace(line, current.endOffset);
  while (line[contentStart] === '[') {
    pushHeaderToken(tokens, current, lineIdx, false);
    current = scanHeaderPrefix(line, contentStart);
    if (current.parse.kind !== 'header') {
      throw configParseError(lineIdx + 1, source, malformedPartialName(current.parse));
    }
    contentStart = skipGitSpace(line, current.endOffset);
  }
  const next = line[contentStart];
  const hasComment = next === '#' || next === ';';
  pushHeaderToken(tokens, current, lineIdx, hasComment);
  if (contentStart >= line.length || hasComment) return lineIdx + 1;
  const scanned = scanKey(lines, lineIdx, contentStart, source);
  tokens.push({
    kind: 'entry',
    key: scanned.key,
    value: scanned.value,
    startLine: lineIdx,
    endLine: scanned.nextLineIdx,
    sharesHeaderLine: true,
    startCol: contentStart,
  });
  return scanned.nextLineIdx;
};

/** Push one header token from a recognised header scan onto the stream. */
const pushHeaderToken = (
  tokens: ConfigToken[],
  header: HeaderPrefixScan,
  lineIdx: number,
  hasComment: boolean,
): void => {
  const parse = header.parse as Extract<SectionHeaderParse, { kind: 'header' }>;
  tokens.push({
    kind: 'header',
    section: parse.section,
    subsection: parse.subsection,
    line: lineIdx,
    hasComment,
  });
};

/** Partial name carried by a malformed parse, for the refusal message. */
const malformedPartialName = (parse: SectionHeaderParse): string | undefined =>
  parse.kind === 'malformed' ? parse.partialName : undefined;

/** Index of the first non-GIT_SPACE character at or after `start` (space/TAB/CR skipped). */
export const skipGitSpace = (line: string, start: number): number => {
  let col = start;
  while (col < line.length && GIT_SPACE.has(line[col] as string)) col += 1;
  return col;
};

/**
 * Tokenize git-config-format INI text into its sections. Lenient on structure,
 * like git is with unknown keys: orphan key/values and malformed headers are
 * skipped. Values follow git's full quoted-value grammar — quotes stripped,
 * `\n`/`\t`/`\b`/`\"`/`\\` decoded, backslash-newline continuations, unquoted
 * `#`/`;` starting comments — and a malformed value (unknown escape, unclosed
 * quote) throws `CONFIG_PARSE_ERROR` with its 1-based physical line and the
 * optional `source` label, mirroring git's `bad config line N in file F`
 * refusal. A malformed quoted-subsection header (e.g. `[s"a"]`, `[s "a" x]`,
 * unclosed quote) also throws `CONFIG_PARSE_ERROR` with `partialSectionName`.
 *
 * Keys before the first header are recorded under an implicit orphan section
 * (`section: ''`, `subsection: undefined`), so they surface on the token stream
 * and porcelain `--list`, mirroring git, which dumps them with no section prefix
 * but refuses to address them. The orphan section is emitted only when it
 * gathered an entry — a header-only file yields no leading empty section.
 *
 * A line with no `=` records a valueless key (`value: null`); the key grammar
 * (alpha-first, `[a-zA-Z0-9-]`, then space/TAB and `=`-or-EOL) refuses anything
 * else — `bad!key`, `9key`, a mid-key `#`/`;` — with `CONFIG_PARSE_ERROR`.
 */
export const parseIniSections = (text: string, source?: string): ReadonlyArray<IniSection> =>
  parseIniSectionsFromTokens(tokenizeConfig(text, source));

/**
 * Assemble `IniSection`s from an already-tokenized config stream — the body of
 * `parseIniSections` minus its `tokenizeConfig` call, so a caller that already
 * holds the tokens (the per-context cache) does not tokenize the same bytes a
 * second time. `parseIniSections` is the thin wrapper for callers that hold text.
 */
export const parseIniSectionsFromTokens = (
  tokens: ReadonlyArray<ConfigToken>,
): ReadonlyArray<IniSection> => {
  const sections: SectionBuilder[] = [];
  const orphan: SectionBuilder = { section: '', subsection: undefined, entries: [] };
  let current: SectionBuilder = orphan;
  for (const token of tokens) {
    if (token.kind === 'header') {
      current = { section: token.section, subsection: token.subsection, entries: [] };
      sections.push(current);
    } else if (token.kind === 'entry') {
      current.entries.push({ key: token.key, value: token.value });
    }
  }
  return orphan.entries.length > 0 ? [orphan, ...sections] : sections;
};

/** Escape sequences git's value grammar accepts; anything else is a parse error. */
const VALUE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['b', '\b'],
  ['\\', '\\'],
  ['"', '"'],
]);

/**
 * git sane-ctype `GIT_SPACE` minus LF (the line terminator): VT/FF are NOT
 * whitespace. Shared by the value parser and the quoted-subsection grammar
 * (the whitespace required before an opening subsection quote).
 */
const GIT_SPACE: ReadonlySet<string> = new Set([' ', '\t', '\r']);

/** Mutable accumulator for one value parse; local to `parseConfigValue`. */
interface ValueState {
  out: string;
  /** Length of `out` before the open trailing-whitespace run, or -1 when none. */
  trimLen: number;
  inQuotes: boolean;
  inComment: boolean;
}

/** Mutable read position; `lineIdx` advances on backslash-newline continuations. */
interface ValueCursor {
  lineIdx: number;
  col: number;
}

/** One parsed value plus the index of the first physical line after it. */
interface ParsedValue {
  readonly value: string;
  readonly nextLineIdx: number;
}

/**
 * Parse one value starting at `lines[startLine][startCol]` (just past the `=`),
 * mirroring git's `parse_value`: GIT_SPACE handling with trailing trim, quote
 * spans, escape decoding, unquoted `#`/`;` comments, and backslash-newline
 * continuations (which may consume following physical lines). Throws
 * `CONFIG_PARSE_ERROR` on an unknown escape or a quote span left open at end
 * of line; a continuation on the final line ends the value (git fakes an EOL
 * at EOF).
 */
const parseConfigValue = (
  lines: ReadonlyArray<string>,
  startLine: number,
  startCol: number,
  source: string | undefined,
): ParsedValue => {
  const cursor: ValueCursor = { lineIdx: startLine, col: startCol };
  const state: ValueState = { out: '', trimLen: -1, inQuotes: false, inComment: false };
  while (cursor.lineIdx < lines.length) {
    const line = lines[cursor.lineIdx] as string;
    if (cursor.col >= line.length) {
      if (state.inQuotes) throw configParseError(cursor.lineIdx + 1, source);
      return finishValue(state, cursor.lineIdx + 1);
    }
    stepValueChar(lines, cursor, state, source);
  }
  return finishValue(state, cursor.lineIdx);
};

/** Consume one char (or escape pair) at the cursor, updating state in place. */
const stepValueChar = (
  lines: ReadonlyArray<string>,
  cursor: ValueCursor,
  state: ValueState,
  source: string | undefined,
): void => {
  const line = lines[cursor.lineIdx] as string;
  const c = line[cursor.col] as string;
  cursor.col += 1;
  if (state.inComment) return;
  if (!state.inQuotes && GIT_SPACE.has(c)) {
    appendValueSpace(state, c);
    return;
  }
  if (!state.inQuotes && (c === '#' || c === ';')) {
    state.inComment = true;
    return;
  }
  if (c === '\\') {
    consumeEscape(lines, cursor, state, source);
    return;
  }
  if (c === '"') {
    state.inQuotes = !state.inQuotes;
    state.trimLen = -1;
    return;
  }
  state.out += c;
  state.trimLen = -1;
};

/**
 * Decode the char after a backslash. A backslash at end of line is a
 * continuation: the line break is consumed and parsing resumes at column 0 of
 * the next physical line (its leading whitespace is interior to the value).
 */
const consumeEscape = (
  lines: ReadonlyArray<string>,
  cursor: ValueCursor,
  state: ValueState,
  source: string | undefined,
): void => {
  const line = lines[cursor.lineIdx] as string;
  if (cursor.col >= line.length) {
    cursor.lineIdx += 1;
    cursor.col = 0;
    return;
  }
  const decoded = VALUE_ESCAPES.get(line[cursor.col] as string);
  if (decoded === undefined) throw configParseError(cursor.lineIdx + 1, source);
  cursor.col += 1;
  state.out += decoded;
  state.trimLen = -1;
};

/**
 * Unquoted whitespace is skipped while the value is still empty (leading),
 * otherwise appended with the start of the run latched for the trailing trim.
 */
const appendValueSpace = (state: ValueState, c: string): void => {
  if (state.out === '') return;
  if (state.trimLen === -1) state.trimLen = state.out.length;
  state.out += c;
};

/** Apply the trailing-whitespace trim and package the parse result. */
const finishValue = (state: ValueState, nextLineIdx: number): ParsedValue => ({
  value: state.trimLen === -1 ? state.out : state.out.slice(0, state.trimLen),
  nextLineIdx,
});

const stripInlineComment = (line: string): string => {
  const hashAt = indexOfUnquoted(line, '#');
  const semiAt = indexOfUnquoted(line, ';');
  // Stryker disable next-line EqualityOperator: equivalent — a cut at index 0 means the whole line is a comment; whether it is truncated to '' (skipped) or kept (a '#'/';'-prefixed key that matches no consumed config key) the parsed result is identical.
  const cuts = [hashAt, semiAt].filter((n): n is number => n >= 0);
  // Stryker disable next-line ConditionalExpression: equivalent — with no cuts `Math.min(...[])` is `Infinity`, so `line.slice(0, Infinity)` returns the whole line, identical to the early `return line`.
  if (cuts.length === 0) return line;
  return line.slice(0, Math.min(...cuts));
};

const indexOfUnquoted = (line: string, ch: string): number => {
  let inQuotes = false;
  // Stryker disable next-line EqualityOperator: equivalent — at `i === line.length` `line[i]` is `undefined`, matching neither `'"'` nor `ch`, so the extra iteration is a no-op and the return value is unchanged.
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    // Inside a quoted span, `\` escapes the next byte — skip it so a `\"`
    // is not treated as the closing quote (matches canonical git's parser
    // and lets a value like `"foo\"#bar"` survive `stripInlineComment`).
    // Stryker disable next-line BlockStatement: equivalent — this skip fires only inside a quoted span, so an opening `"` (non-whitespace) always precedes any marker the escape would expose; the resulting cut never trims to '' (the sole observable via stripInlineComment), so emptying the block changes nothing.
    if (inQuotes && c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ch) return i;
  }
  return -1;
};

/**
 * Three-state result of parsing a trimmed `[…]`-shaped header line. Exported
 * so the sibling config writer (`update-config.ts`) shares one header parser.
 */
export type SectionHeaderParse =
  | { readonly kind: 'header'; readonly section: string; readonly subsection: string | undefined }
  | { readonly kind: 'malformed'; readonly partialName: string }
  | { readonly kind: 'not-header' };

/**
 * Scan the quoted-subsection branch of a `[section "subsection"]` header.
 * `contentStart` is the absolute index just past `[`; `quoteAt` the absolute
 * index of the opening `"`. The section name is the span between them.
 */
const parseQuotedSubsectionHeader = (
  line: string,
  contentStart: number,
  quoteAt: number,
): QuotedHeaderScan => {
  const section = line.slice(contentStart, quoteAt).trim();
  const sectionPart = section.toLowerCase();
  // A quote that opens the header content (no char between `[` and `"`) has no
  // separating whitespace, which the guard below treats as git's refusal.
  // equivalent-mutant: at quoteAt === contentStart, line[quoteAt-1] is the opening `[`, never GIT_SPACE, so `>`/`>=`/`true` all reach the same `!GIT_SPACE` refusal below.
  const charBeforeQuote = quoteAt > contentStart ? line[quoteAt - 1] : undefined;
  if (charBeforeQuote === undefined || !GIT_SPACE.has(charBeforeQuote)) {
    return { parse: { kind: 'malformed', partialName: sectionPart } };
  }
  return scanQuotedSpan(line, quoteAt, section, sectionPart);
};

/** A closed quoted subsection: its decoded text and the index of the closing `"`. */
interface ClosedSubsection {
  readonly subsection: string;
  readonly closeQuoteAt: number;
}

/**
 * Decode the quoted subsection starting at absolute `openAt` (the opening `"`)
 * in `line`, honouring `\`-escapes. Returns the decoded text and the absolute
 * closing `"` index, or the partial text on an unclosed/dangling span (so the
 * caller can build a `malformed` name).
 */
const decodeSubsection = (
  line: string,
  openAt: number,
): ClosedSubsection | { readonly partial: string } => {
  let subsection = '';
  let i = openAt + 1;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '\\') {
      if (i + 1 >= line.length) return { partial: subsection };
      subsection += line[i + 1] as string;
      i += 2;
      continue;
    }
    if (c === '"') return { subsection, closeQuoteAt: i };
    subsection += c;
    i += 1;
  }
  return { partial: subsection };
};

/**
 * A quoted-header scan: the three-state parse plus, on success, the index of the
 * closing `"` so the raw-line scanner can derive the bracket end-offset from the
 * single identity decode rather than decoding the span a second time.
 */
interface QuotedHeaderScan {
  readonly parse: SectionHeaderParse;
  readonly closeQuoteAt?: number;
}

/**
 * Scan the quoted subsection span starting at absolute `openAt` (the index of
 * `"` in `line`). On success, the closing `"` must be immediately followed by
 * `]` — the last char on a trimmed line, or the bracket terminator before
 * same-line entry content on a raw line. Otherwise produces a `malformed` result.
 */
const scanQuotedSpan = (
  line: string,
  openAt: number,
  section: string,
  sectionPart: string,
): QuotedHeaderScan => {
  const decoded = decodeSubsection(line, openAt);
  if ('partial' in decoded) {
    return { parse: { kind: 'malformed', partialName: `${sectionPart}.${decoded.partial}` } };
  }
  if (line.startsWith(']', decoded.closeQuoteAt + 1)) {
    return {
      parse: { kind: 'header', section, subsection: decoded.subsection },
      closeQuoteAt: decoded.closeQuoteAt,
    };
  }
  return { parse: { kind: 'malformed', partialName: `${sectionPart}.${decoded.subsection}` } };
};

/**
 * A recognised header over a raw line plus `endOffset`: the column just past the
 * `]` that closes the bracket span. Same-line entry content (`[a] key = v`)
 * begins after `endOffset`; the writer slices the raw header bytes by it.
 */
export interface HeaderPrefixScan {
  readonly parse: SectionHeaderParse;
  readonly endOffset: number;
}

/**
 * Scan a header at offset `start` of a raw (untrimmed) line. It stops at the `]`
 * that closes the bracket span, so a same-line entry — or another chained header
 * — may follow it. `endOffset` is the absolute column just past that `]`, in the
 * original line. A char at `start` that is not `[` (after a leading-space skip),
 * or a malformed unquoted bracket span, reports `not-header` (the tokenizer keeps
 * its lenient skip); a malformed quoted subsection reports `malformed`. Scanning
 * from an offset (rather than a fresh slice) keeps a chain of headers linear in
 * the line length: the cursor advances over the line, never re-copying the tail.
 */
export const scanHeaderPrefix = (line: string, start = 0): HeaderPrefixScan => {
  const open = firstNonGap(line, start);
  if (line[open] !== '[') return NOT_HEADER_SCAN;
  const contentStart = open + 1;
  // The first `]` bounds the span; the `"` lookup only matters before it, so a
  // chain of quote-free `[a][b]...` headers never re-scans to end-of-line.
  const closeAt = line.indexOf(']', contentStart);
  const quoteAt = quoteBefore(line, contentStart, closeAt);
  if (quoteAt === -1) {
    return scanPlainHeaderPrefix(line, contentStart, closeAt);
  }
  return scanQuotedHeaderPrefix(line, contentStart, quoteAt);
};

/**
 * Absolute index of the first `"` in `[from, closeAt)`, or -1 when none. A quote
 * at or after the span's closing `]` is content of a later span, not this header's
 * subsection opener, so the search is bounded to the span: a chain of quote-free
 * `[a][b]...` headers never re-scans to end-of-line. With no closing `]` (an
 * unclosed span) the search runs to end-of-line — that line terminates anyway.
 */
const quoteBefore = (line: string, from: number, closeAt: number): number => {
  const limit = closeAt === -1 ? line.length : closeAt;
  for (let col = from; col < limit; col += 1) {
    if (line[col] === '"') return col;
  }
  return -1;
};

const NOT_HEADER_SCAN: HeaderPrefixScan = { parse: { kind: 'not-header' }, endOffset: 0 };

/**
 * git's unquoted section-name grammar: one or more of letter/digit/dot/dash,
 * with no whitespace, underscore, or other punctuation. Digit-first is allowed
 * for sections (unlike keys). A name outside this set makes the line not a
 * header, so it falls to the key path and refuses exactly as git does.
 */
const PLAIN_SECTION_NAME = /^[A-Za-z0-9.-]+$/;

/**
 * Plain `[section]` prefix: the section name is the exact (untrimmed) span from
 * `contentStart` (just past `[`) up to the closing `]` at absolute `closeAt`,
 * accepted only when it matches git's unquoted grammar. Interior or edge
 * whitespace (`[a ]`, `[ a]`, `[a b]`) is therefore refused, not trimmed.
 */
const scanPlainHeaderPrefix = (
  line: string,
  contentStart: number,
  closeAt: number,
): HeaderPrefixScan => {
  if (closeAt === -1) return NOT_HEADER_SCAN;
  const inner = line.slice(contentStart, closeAt);
  if (!PLAIN_SECTION_NAME.test(inner)) return NOT_HEADER_SCAN;
  return {
    parse: { kind: 'header', section: inner, subsection: undefined },
    endOffset: closeAt + 1,
  };
};

/**
 * Quoted `[section "sub"]` prefix: the closing `]` follows the closing `"`, so
 * the offset is taken from the single identity scan's quote index, not the first
 * `]` (which may be content inside the quotes). `quoteAt` is the absolute index
 * of the opening `"` in `line`; the scan works in place from `contentStart`.
 */
const scanQuotedHeaderPrefix = (
  line: string,
  contentStart: number,
  quoteAt: number,
): HeaderPrefixScan => {
  const { parse, closeQuoteAt } = parseQuotedSubsectionHeader(line, contentStart, quoteAt);
  // equivalent-mutant: every reader gates `endOffset` behind `parse.kind === 'header'` (which always carries a defined closeQuoteAt), so dropping the early return — its NaN endOffset on a malformed parse — is never observed.
  if (parse.kind !== 'header' || closeQuoteAt === undefined) return { parse, endOffset: 0 };
  return { parse, endOffset: closeQuoteAt + 2 };
};

type GitIntResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: 'invalid unit' | 'out of range' };

// git config --type=int uses strtoimax (int64_t on all modern platforms).
// Pinned against git 2.54.0: values outside this range yield "out of range".
const GIT_INT_MAX = BigInt('9223372036854775807');
const GIT_INT_MIN = BigInt('-9223372036854775808');

// Unit multipliers accepted by git_parse_signed (k/K/m/M/g/G = ×1024^n).
// t/T are NOT accepted by git 2.54.0 (pinned empirically).
const UNIT_SCALE: ReadonlyMap<string, bigint> = new Map([
  ['k', BigInt(1024)],
  ['K', BigInt(1024)],
  ['m', BigInt(1024) * BigInt(1024)],
  ['M', BigInt(1024) * BigInt(1024)],
  ['g', BigInt(1024) * BigInt(1024) * BigInt(1024)],
  ['G', BigInt(1024) * BigInt(1024) * BigInt(1024)],
]);

// No in-range git integer needs this many significant digits (octal int64 max is 22
// digits). A longer significant run is always out of range — and capping it before
// BigInt bounds the parse work, so a hostile config value cannot stall the parser.
const MAX_SIGNIFICANT_DIGITS = 32;

// Classify the digit run at the start of `body` (sign already stripped) the way
// strtoimax base-0 does: `0x`/`0X` → hex, a leading `0` → octal (greedy over 0-7,
// stopping at the first non-octal digit), otherwise decimal. Returns the consumed
// token and its radix, or null when no digit run starts here.
const matchDigits = (
  body: string,
): { readonly token: string; readonly radix: 8 | 10 | 16 } | null => {
  // equivalent-mutant: dropping the `^` anchor cannot change the verdict — a `0x`/digit run
  // found past position 0 leaves the preceding chars as the unit suffix, which is never a valid
  // unit, so the result is `invalid unit` either way (exhaustively checked over all len-≤4 inputs).
  const hex = /^0[xX][0-9a-fA-F]+/.exec(body);
  if (hex !== null) return { token: hex[0], radix: 16 };
  if (body[0] === '0') return { token: (/^0[0-7]*/.exec(body) as RegExpExecArray)[0], radix: 8 };
  const dec = /^[0-9]+/.exec(body);
  return dec === null ? null : { token: dec[0], radix: 10 };
};

// Convert a classified digit token to its magnitude, or null when it has more than
// MAX_SIGNIFICANT_DIGITS significant digits (always out of range). Leading zeros are
// stripped first, so a long all-zeros run is the value 0, not an out-of-range reject.
const magnitudeOf = (token: string, radix: 8 | 10 | 16): bigint | null => {
  // Strip the radix marker (`0x` = 2 chars, octal `0` = 1 char, decimal = none),
  // then the leading zeros, leaving the significant digits.
  // equivalent-mutant: for the octal branch, replacing `token.slice(1)` with `token` (or dropping
  // the `radix === 8` arm so it falls through to `token`) keeps the leading marker `0`, which the
  // next line's `replace(/^0+/, '')` strips anyway — `significant` is identical.
  const bare = radix === 16 ? token.slice(2) : radix === 8 ? token.slice(1) : token;
  const significant = bare.replace(/^0+/, '');
  // equivalent-mutant: a significant run of ≥32 digits (any radix ≤16) always exceeds int64, so the
  // final range check returns `out of range` regardless of this early cap — dropping the guard or
  // shifting `>` to `>=` leaves the verdict unchanged (the cap only bounds BigInt work, not output).
  if (significant.length > MAX_SIGNIFICANT_DIGITS) return null;
  if (significant === '') return BigInt(0);
  const prefix = radix === 16 ? '0x' : radix === 8 ? '0o' : '';
  return BigInt(`${prefix}${significant}`);
};

// Total pure function: mirrors git's strtoimax base-0 grammar (decimal, `0x` hex,
// leading-`0` octal, sign, single k/m/g unit ×1024^n). Returns ok+value on success,
// or not-ok+reason on failure — never throws.
export const parseGitInt = (value: string | null): GitIntResult => {
  // Trim leading ASCII whitespace (git's behaviour), then strip one optional sign.
  // equivalent-mutant: the `''` null-fallback only matters when `value` is null (a valueless key);
  // Stryker's non-numeric "Stryker was here!" replacement is rejected by `matchDigits` exactly as the
  // empty string is, so both null paths yield `invalid unit` and the verdict is unchanged.
  const trimmed = (value ?? '').replace(/^[ \t]+/, '');
  const signed = trimmed[0] === '+' || trimmed[0] === '-';
  const body = signed ? trimmed.slice(1) : trimmed;

  const digits = matchDigits(body);
  if (digits === null) return { ok: false, reason: 'invalid unit' };

  const unit = body.slice(digits.token.length);
  const multiplier = unit === '' ? BigInt(1) : UNIT_SCALE.get(unit);
  if (multiplier === undefined) return { ok: false, reason: 'invalid unit' };

  const magnitude = magnitudeOf(digits.token, digits.radix);
  if (magnitude === null) return { ok: false, reason: 'out of range' };

  const result = (trimmed[0] === '-' ? -magnitude : magnitude) * multiplier;
  if (result < GIT_INT_MIN || result > GIT_INT_MAX) return { ok: false, reason: 'out of range' };
  return { ok: true, value: Number(result) };
};

// Word arms of git's boolean grammar, case-insensitive. `1`/`0` are NOT words here —
// they resolve through the integer arm's arithmetic, which is what makes `2`, `007`
// and `0x1` come out right.
const TRUE_WORDS = new Set(['true', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'off']);

type GitBooleanResult = { readonly ok: true; readonly value: boolean } | { readonly ok: false };

// The shared C-`int` narrowing: git's boolean grammar and `core.maxTreeDepth`
// both narrow the parsed value to this range; parseGitInt's own `--type=int`
// path keeps its full 64-bit range, so these intentionally differ from
// GIT_INT_MIN/GIT_INT_MAX below.
export const GIT_C_INT_MAX = 2_147_483_647;
export const GIT_C_INT_MIN = -2_147_483_648;

/**
 * git's exact `git_config_bool` grammar: a valueless key (`null`, git's internal NULL)
 * is true; an empty value is false; the six words above are case-insensitive; anything
 * else is handed to `parseGitInt` and narrowed to the C `int` range — non-zero is true,
 * zero is false, and a magnitude `parseGitInt` accepts but that overflows `int` refuses
 * here even though `--type=int` would allow it.
 */
export const parseGitBoolean = (value: string | null): GitBooleanResult => {
  if (value === null) return { ok: true, value: true };
  if (value === '') return { ok: true, value: false };
  const lowered = value.toLowerCase();
  if (TRUE_WORDS.has(lowered)) return { ok: true, value: true };
  if (FALSE_WORDS.has(lowered)) return { ok: true, value: false };
  const asInt = parseGitInt(value);
  if (!asInt.ok || asInt.value < GIT_C_INT_MIN || asInt.value > GIT_C_INT_MAX) {
    return { ok: false };
  }
  return { ok: true, value: asInt.value !== 0 };
};
