/**
 * `@writes` tag parser for the write-surfaces audit. Pure-string scan — no
 * AST. Mirrors `parseProvesHeader`'s discipline so contributors switching
 * between the two audits read the same grammar.
 *
 * Grammar (ADR-140):
 *   - the `@writes` block lives in the first JSDoc of the file (after an
 *     optional shebang).
 *   - exactly three keys: `surface`, `kind`, `format`.
 *   - `surface` matches `surfaceRegex` (same regex as `@proves surface:`).
 *   - `kind` ∈ { byte-identical, equivalent-under-readback, readback-only }.
 *   - `format` matches `formatRegex` and falls within the length window.
 *   - at most one `@writes` block per file.
 */
export const WRITE_KINDS = [
  'byte-identical',
  'equivalent-under-readback',
  'readback-only',
] as const;

export type WriteKind = (typeof WRITE_KINDS)[number];

export interface WritesTag {
  readonly surface: string;
  readonly kind: WriteKind;
  readonly format: string;
}

export type WritesErrorReason =
  | 'no-jsdoc-at-top'
  | 'no-writes-block'
  | 'missing-key'
  | 'bad-surface'
  | 'bad-kind'
  | 'bad-format'
  | 'duplicate-writes-block';

export interface WritesError {
  readonly reason: WritesErrorReason;
  readonly detail?: string;
}

export type WritesResult =
  | { readonly ok: true; readonly tag: WritesTag }
  | { readonly ok: false; readonly error: WritesError };

export interface WritesTagConfig {
  readonly surfaceRegex: RegExp;
  readonly formatRegex: RegExp;
  readonly formatMinLength: number;
  readonly formatMaxLength: number;
}

const SHEBANG = /^#![^\n]*\n/;
const KEY_LINE = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/;
const KIND_SET: ReadonlySet<string> = new Set<string>(WRITE_KINDS);

const stripCommentStar = (line: string): string => line.replace(/^\s*\*\s?/, '');

const findFirstJsdoc = (
  source: string,
): { readonly start: number; readonly end: number } | null => {
  const open = source.indexOf('/**');
  if (open !== 0) return null;
  const close = source.indexOf('*/', open + 3);
  if (close === -1) return null;
  return { start: open, end: close };
};

interface CollectedKeys {
  readonly surface?: string;
  readonly kind?: string;
  readonly format?: string;
}

type MutableKeys = { surface?: string; kind?: string; format?: string };

const KNOWN_KEYS = new Set(['surface', 'kind', 'format']);

/** The key a line names together with its value, or `undefined` when the
 *  line is blank, is not a `key: value` pair, or names a key this tag
 *  does not carry. */
const readKeyLine = (raw: string): readonly [keyof MutableKeys, string] | undefined => {
  const inner = stripCommentStar(raw);
  if (inner.trim().length === 0) return undefined;
  const match = inner.match(KEY_LINE);
  if (match === null) return undefined;
  const [, key, value] = match;
  if (key === undefined || value === undefined) return undefined;
  if (!KNOWN_KEYS.has(key)) return undefined;
  return [key as keyof MutableKeys, value];
};

const collectKeys = (block: string): CollectedKeys => {
  const writesIdx = block.indexOf('@writes');
  if (writesIdx === -1) return {};
  const out: MutableKeys = {};
  for (const raw of block.slice(writesIdx).split('\n').slice(1)) {
    const pair = readKeyLine(raw);
    // First entry wins: a repeated key inside one block is the author's own
    // duplicate, and the tag reads top-down like git's own config does.
    if (pair !== undefined && out[pair[0]] === undefined) out[pair[0]] = pair[1];
  }
  return out;
};

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
};

const validateFormat = (value: string, config: WritesTagConfig): WritesError | null => {
  if (value.length < config.formatMinLength || value.length > config.formatMaxLength) {
    return {
      reason: 'bad-format',
      detail: `length out of range [${config.formatMinLength}, ${config.formatMaxLength}] (got ${value.length})`,
    };
  }
  if (!config.formatRegex.test(value)) {
    return { reason: 'bad-format', detail: value };
  }
  return null;
};

export const parseWritesTag = (rawSource: string, config: WritesTagConfig): WritesResult => {
  const normalised = rawSource.replace(/\r\n/g, '\n');
  if (countOccurrences(normalised, '@writes') > 1) {
    return { ok: false, error: { reason: 'duplicate-writes-block' } };
  }
  const trimmed = normalised.replace(SHEBANG, '');
  const span = findFirstJsdoc(trimmed);
  if (span === null) {
    return { ok: false, error: { reason: 'no-jsdoc-at-top' } };
  }
  const block = trimmed.slice(span.start, span.end);
  if (!block.includes('@writes')) {
    return { ok: false, error: { reason: 'no-writes-block' } };
  }
  return validateKeys(collectKeys(block), config);
};

const REQUIRED_KEYS = ['surface', 'kind', 'format'] as const;

/** The keys the block left out, in declaration order. */
const missingKeys = (keys: CollectedKeys): ReadonlyArray<string> =>
  REQUIRED_KEYS.filter((key) => keys[key] === undefined);

/** Every value check the three keys carry, once all three are present. */
const validateValues = (
  surface: string,
  kind: string,
  format: string,
  config: WritesTagConfig,
): WritesError | null => {
  if (!config.surfaceRegex.test(surface)) return { reason: 'bad-surface', detail: surface };
  if (!KIND_SET.has(kind)) return { reason: 'bad-kind', detail: kind };
  return validateFormat(format, config);
};

const validateKeys = (keys: CollectedKeys, config: WritesTagConfig): WritesResult => {
  const missing = missingKeys(keys);
  if (missing.length > 0) {
    return { ok: false, error: { reason: 'missing-key', detail: missing.join(', ') } };
  }
  const surface = keys.surface as string;
  const kind = keys.kind as string;
  const format = keys.format as string;
  const error = validateValues(surface, kind, format, config);
  if (error !== null) return { ok: false, error };
  return { ok: true, tag: { surface, kind: kind as WriteKind, format } };
};
