/**
 * `interopSurface:` key reader for the write-surfaces audit. Lives outside
 * 19.4's `parseProvesHeader` so the test-pyramid audit doesn't need to
 * learn interop semantics (ADR-140 §Composition).
 *
 * Contract:
 *   - on a `@proves` block whose bucket is in `interopBuckets`,
 *     `interopSurface:` is required.
 *   - on any other bucket, `interopSurface:` MUST be absent.
 *   - the value is a comma-separated list of surface names; each name
 *     must match `surfaceRegex` (same regex as 19.4 `@proves surface:`).
 */
export type InteropSurfaceErrorReason =
  | 'missing-interop-surface'
  | 'unexpected-interop-surface'
  | 'empty-interop-surface'
  | 'bad-interop-surface';

export interface InteropSurfaceError {
  readonly reason: InteropSurfaceErrorReason;
  readonly detail?: string;
}

export type InteropSurfaceResult =
  | { readonly ok: true; readonly surfaces: ReadonlySet<string> }
  | { readonly ok: false; readonly error: InteropSurfaceError };

export interface InteropSurfaceConfig {
  readonly surfaceRegex: RegExp;
  readonly interopBuckets: ReadonlySet<string>;
}

const INTEROP_LINE = /^\s*\*\s*interopSurface\s*:\s*(.+?)\s*$/m;

const extractInteropLine = (rawSource: string): string | null => {
  const normalised = rawSource.replace(/\r\n/g, '\n');
  const openIdx = normalised.indexOf('/**');
  if (openIdx === -1) return null;
  const closeIdx = normalised.indexOf('*/', openIdx + 3);
  if (closeIdx === -1) return null;
  const block = normalised.slice(openIdx, closeIdx);
  const match = block.match(INTEROP_LINE);
  if (match === null) return null;
  return match[1] ?? null;
};

const splitNames = (raw: string): ReadonlyArray<string> =>
  raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export const parseInteropSurface = (
  rawSource: string,
  bucket: string,
  config: InteropSurfaceConfig,
): InteropSurfaceResult => {
  const value = extractInteropLine(rawSource);
  const requiredForBucket = config.interopBuckets.has(bucket);

  if (value === null) {
    if (requiredForBucket) {
      return { ok: false, error: { reason: 'missing-interop-surface' } };
    }
    return { ok: true, surfaces: new Set<string>() };
  }

  if (!requiredForBucket) {
    return {
      ok: false,
      error: { reason: 'unexpected-interop-surface', detail: bucket },
    };
  }

  const names = splitNames(value);
  if (names.length === 0) {
    return { ok: false, error: { reason: 'empty-interop-surface' } };
  }
  for (const name of names) {
    if (!config.surfaceRegex.test(name)) {
      return {
        ok: false,
        error: { reason: 'bad-interop-surface', detail: name },
      };
    }
  }
  return { ok: true, surfaces: new Set<string>(names) };
};
