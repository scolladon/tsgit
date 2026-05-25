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

const stripCommentStar = (line: string): string =>
  line.replace(/^\s*\*\s?/, '');

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

const collectKeys = (block: string): CollectedKeys => {
  const writesIdx = block.indexOf('@writes');
  if (writesIdx === -1) return {};
  const after = block.slice(writesIdx);
  const lines = after.split('\n').slice(1);
  const out: { surface?: string; kind?: string; format?: string } = {};
  for (const raw of lines) {
    const inner = stripCommentStar(raw);
    if (inner.trim().length === 0) continue;
    const match = inner.match(KEY_LINE);
    if (match === null) continue;
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    if (key === 'surface' && out.surface === undefined) out.surface = value;
    else if (key === 'kind' && out.kind === undefined) out.kind = value;
    else if (key === 'format' && out.format === undefined) out.format = value;
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

const validateFormat = (
  value: string,
  config: WritesTagConfig,
): WritesError | null => {
  if (
    value.length < config.formatMinLength ||
    value.length > config.formatMaxLength
  ) {
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

export const parseWritesTag = (
  rawSource: string,
  config: WritesTagConfig,
): WritesResult => {
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
  const { surface, kind, format } = collectKeys(block);
  const missing: string[] = [];
  if (surface === undefined) missing.push('surface');
  if (kind === undefined) missing.push('kind');
  if (format === undefined) missing.push('format');
  if (missing.length > 0) {
    return {
      ok: false,
      error: { reason: 'missing-key', detail: missing.join(', ') },
    };
  }
  const surfaceValue = surface as string;
  const kindValue = kind as string;
  const formatValue = format as string;
  if (!config.surfaceRegex.test(surfaceValue)) {
    return { ok: false, error: { reason: 'bad-surface', detail: surfaceValue } };
  }
  if (!KIND_SET.has(kindValue)) {
    return { ok: false, error: { reason: 'bad-kind', detail: kindValue } };
  }
  const formatError = validateFormat(formatValue, config);
  if (formatError !== null) return { ok: false, error: formatError };
  return {
    ok: true,
    tag: {
      surface: surfaceValue,
      kind: kindValue as WriteKind,
      format: formatValue,
    },
  };
};
