/**
 * Schema validator + loader for `audit-write-surfaces.allowlist.json`.
 *
 * Structure:
 *   { "surfaces": [
 *       { "surface": "<name>",
 *         "reason":  "<why>",
 *         "deferredTo": "<phase tag>" | null }
 *   ] }
 *
 * Any malformation throws `AllowlistError`. The "is this surface name
 * declared by a `@writes` tag?" cross-check lives in `computeGaps`
 * (`allowlistRot` output), not here — this loader sees only the file.
 */
import type { AllowEntry } from './compute-gaps.ts';

export type AllowlistErrorReason =
  | 'invalid-json'
  | 'not-an-object'
  | 'missing-surfaces-array'
  | 'entry-not-an-object'
  | 'missing-field'
  | 'wrong-field-type'
  | 'empty-string'
  | 'bad-surface-format';

export class AllowlistError extends Error {
  readonly reason: AllowlistErrorReason;
  readonly detail: string | undefined;
  constructor(reason: AllowlistErrorReason, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.name = 'AllowlistError';
    this.reason = reason;
    this.detail = detail;
  }
}

export interface LoadAllowlistConfig {
  readonly surfaceRegex: RegExp;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateEntry = (
  raw: unknown,
  index: number,
  config: LoadAllowlistConfig,
): AllowEntry => {
  if (!isPlainObject(raw)) {
    throw new AllowlistError('entry-not-an-object', `entry #${index}`);
  }
  if (!('surface' in raw)) {
    throw new AllowlistError('missing-field', `entry #${index} surface`);
  }
  if (!('reason' in raw)) {
    throw new AllowlistError('missing-field', `entry #${index} reason`);
  }
  if (!('deferredTo' in raw)) {
    throw new AllowlistError('missing-field', `entry #${index} deferredTo`);
  }
  if (typeof raw.surface !== 'string') {
    throw new AllowlistError('wrong-field-type', `entry #${index} surface must be string`);
  }
  if (typeof raw.reason !== 'string') {
    throw new AllowlistError('wrong-field-type', `entry #${index} reason must be string`);
  }
  if (raw.deferredTo !== null && typeof raw.deferredTo !== 'string') {
    throw new AllowlistError(
      'wrong-field-type',
      `entry #${index} deferredTo must be string or null`,
    );
  }
  if (raw.reason.trim().length === 0) {
    throw new AllowlistError('empty-string', `entry #${index} reason`);
  }
  if (!config.surfaceRegex.test(raw.surface)) {
    throw new AllowlistError('bad-surface-format', raw.surface);
  }
  return {
    surface: raw.surface,
    reason: raw.reason,
    deferredTo: raw.deferredTo as string | null,
  };
};

export const parseAllowlist = (
  rawContent: string,
  config: LoadAllowlistConfig,
): ReadonlyArray<AllowEntry> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (cause) {
    throw new AllowlistError(
      'invalid-json',
      cause instanceof Error ? cause.message : undefined,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new AllowlistError('not-an-object');
  }
  if (!('surfaces' in parsed) || !Array.isArray(parsed.surfaces)) {
    throw new AllowlistError('missing-surfaces-array');
  }
  return parsed.surfaces.map((entry, idx) => validateEntry(entry, idx, config));
};
