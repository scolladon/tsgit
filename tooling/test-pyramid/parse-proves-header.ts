/**
 * `@proves` header parser. Pure string scan — no AST. Accepts a JSDoc-style
 * comment block at the top of an integration test file and extracts the
 * `surface`, `bucket`, and `unique` keys declared under a `@proves` directive.
 *
 * Grammar lives in design `phase-19-4-integration-test-usefulness-audit.md` §3
 * and ADR-121.
 */
import type { IntegrationProofHeuristic } from './parse-manifest.ts';

export interface ProvesHeader {
  readonly surface: string;
  readonly bucket: string;
  readonly unique: string;
}

export type ProvesErrorReason =
  | 'no-jsdoc-at-top'
  | 'no-proves-block'
  | 'missing-key'
  | 'bad-surface'
  | 'bad-bucket'
  | 'bad-unique';

export interface ProvesError {
  readonly reason: ProvesErrorReason;
  readonly detail?: string;
}

export type ProvesResult =
  | { readonly ok: true; readonly header: ProvesHeader }
  | { readonly ok: false; readonly error: ProvesError };

const KEY_LINE = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/;
const SHEBANG = /^#![^\n]*\n/;

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

const collectKeys = (
  block: string,
): { readonly surface?: string; readonly bucket?: string; readonly unique?: string } => {
  const provesIdx = block.indexOf('@proves');
  if (provesIdx === -1) return {};
  const after = block.slice(provesIdx);
  const lines = after.split('\n').slice(1);
  const out: { surface?: string; bucket?: string; unique?: string } = {};
  for (const raw of lines) {
    const inner = stripCommentStar(raw);
    if (inner.trim().length === 0) continue;
    const match = inner.match(KEY_LINE);
    if (match === null) continue;
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    if (key === 'surface' && out.surface === undefined) out.surface = value;
    else if (key === 'bucket' && out.bucket === undefined) out.bucket = value;
    else if (key === 'unique' && out.unique === undefined) out.unique = value;
  }
  return out;
};

const validateUnique = (
  value: string,
  config: IntegrationProofHeuristic,
): ProvesError | null => {
  if (value.includes('\n')) {
    return { reason: 'bad-unique', detail: 'must be a single line' };
  }
  if (value.length < config.uniqueMinLength) {
    return {
      reason: 'bad-unique',
      detail: `must be at least ${config.uniqueMinLength} characters (got ${value.length})`,
    };
  }
  if (value.length > config.uniqueMaxLength) {
    return {
      reason: 'bad-unique',
      detail: `must be at most ${config.uniqueMaxLength} characters (got ${value.length})`,
    };
  }
  return null;
};

export const parseProvesHeader = (
  rawSource: string,
  config: IntegrationProofHeuristic,
): ProvesResult => {
  const normalised = rawSource.replace(/\r\n/g, '\n');
  const trimmed = normalised.replace(SHEBANG, '');
  const span = findFirstJsdoc(trimmed);
  if (span === null) {
    return { ok: false, error: { reason: 'no-jsdoc-at-top' } };
  }
  const block = trimmed.slice(span.start, span.end);
  if (!block.includes('@proves')) {
    return { ok: false, error: { reason: 'no-proves-block' } };
  }
  const { surface, bucket, unique } = collectKeys(block);
  const missing: string[] = [];
  if (surface === undefined) missing.push('surface');
  if (bucket === undefined) missing.push('bucket');
  if (unique === undefined) missing.push('unique');
  if (missing.length > 0) {
    return {
      ok: false,
      error: { reason: 'missing-key', detail: missing.join(', ') },
    };
  }
  const surfaceValue = surface as string;
  const bucketValue = bucket as string;
  const uniqueValue = unique as string;
  if (!config.surfaceRegex.test(surfaceValue)) {
    return { ok: false, error: { reason: 'bad-surface', detail: surfaceValue } };
  }
  const bucketSet = new Set(config.buckets);
  if (!bucketSet.has(bucketValue)) {
    return { ok: false, error: { reason: 'bad-bucket', detail: bucketValue } };
  }
  const uniqueError = validateUnique(uniqueValue, config);
  if (uniqueError !== null) return { ok: false, error: uniqueError };
  return {
    ok: true,
    header: { surface: surfaceValue, bucket: bucketValue, unique: uniqueValue },
  };
};
