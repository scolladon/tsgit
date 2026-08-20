/**
 * Schema validator + loader for `audit-assert-tier.allowlist.json`.
 *
 * Structure:
 *   { "callers": [ { "module", "verb", "reason" } ],
 *     "ungated": [ { "module", "verb", "reason" } ] }
 *
 * `callers` exempts a verb that calls the bare tier; `ungated` exempts a verb
 * that calls no tier at all. Both carry the measurement that justifies them.
 *
 * Any malformation throws `AllowlistError` — a malformed allowlist is an
 * audit failure, never a silent empty set. Matching entries against the
 * scanned call sites (unguarded caller / stale entry) lives in
 * `compute-findings.ts`, not here — this loader only validates the file's
 * own shape.
 */
export type AllowlistErrorReason =
  | 'invalid-json'
  | 'not-an-object'
  | 'missing-callers-array'
  | 'missing-ungated-array'
  | 'entry-not-an-object'
  | 'missing-field'
  | 'wrong-field-type'
  | 'empty-string';

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

export interface AllowEntry {
  readonly module: string;
  readonly verb: string;
  readonly reason: string;
}

const REQUIRED_FIELDS: ReadonlyArray<keyof AllowEntry> = ['module', 'verb', 'reason'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateEntry = (raw: unknown, index: number): AllowEntry => {
  if (!isPlainObject(raw)) {
    throw new AllowlistError('entry-not-an-object', `entry #${index}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in raw)) {
      throw new AllowlistError('missing-field', `entry #${index} ${field}`);
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof raw[field] !== 'string') {
      throw new AllowlistError('wrong-field-type', `entry #${index} ${field} must be string`);
    }
  }
  const reason = raw.reason as string;
  if (reason.trim().length === 0) {
    throw new AllowlistError('empty-string', `entry #${index} reason`);
  }
  return {
    module: raw.module as string,
    verb: raw.verb as string,
    reason,
  };
};

export interface Allowlist {
  readonly callers: ReadonlyArray<AllowEntry>;
  readonly ungated: ReadonlyArray<AllowEntry>;
}

export const parseAllowlist = (rawContent: string): Allowlist => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (cause) {
    throw new AllowlistError('invalid-json', cause instanceof Error ? cause.message : undefined);
  }
  if (!isPlainObject(parsed)) {
    throw new AllowlistError('not-an-object');
  }
  if (!('callers' in parsed) || !Array.isArray(parsed.callers)) {
    throw new AllowlistError('missing-callers-array');
  }
  if (!('ungated' in parsed) || !Array.isArray(parsed.ungated)) {
    throw new AllowlistError('missing-ungated-array');
  }
  return {
    callers: parsed.callers.map((entry, idx) => validateEntry(entry, idx)),
    ungated: parsed.ungated.map((entry, idx) => validateEntry(entry, idx)),
  };
};
