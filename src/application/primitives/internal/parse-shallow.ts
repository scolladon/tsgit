/**
 * `.git/shallow` line grammar — pure, no `Context`, no I/O. Shared by the
 * reader (`shallow-file.ts`) and the per-`Context` shallow-set memo
 * (`internal/shallow-set.ts`) without creating a
 * `shallow-file.ts <-> shallow-set.ts` import cycle.
 *
 * git's line reader: a 0-byte file yields no lines; a trailing LF is
 * stripped before splitting on LF; a missing trailing LF still yields the
 * final line. Each line's first 40 characters must be hex (upper or lower,
 * normalised to lowercase); anything after that prefix is ignored. Any other
 * line — blank, short, non-hex — is a fatal refusal: canonical git's
 * shallow-line reader does not tolerate malformed content.
 *
 * The parsed-line count is capped at `MAX_SHALLOW_ENTRIES` (mirrors
 * `MAX_ADVERTISED_REFS`) rather than a byte cap: a byte cap would need a
 * `stat` call, and the per-`Context` shallow memo budgets exactly one
 * filesystem probe (the read itself). The outer bound is the transport's
 * 512 MiB `maxResponseBytes`.
 */
import { shallowFileMalformed } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/object-id.js';
import { ObjectId as OID } from '../../../domain/objects/object-id.js';
import { REASON_SHALLOW_BAD_LINE, REASON_SHALLOW_TOO_MANY_ENTRIES } from '../validators.js';

export const MAX_SHALLOW_ENTRIES = 500_000;

const OID_PREFIX_LENGTH = 40;
const OID_PREFIX_RE = /^[0-9a-fA-F]{40}$/;

export const parseShallowFile = (raw: string): ReadonlyArray<ObjectId> =>
  splitShallowLines(raw).map((line, index) => parseShallowLine(line, index + 1));

const splitShallowLines = (raw: string): ReadonlyArray<string> => {
  if (raw === '') return [];
  if (raw.endsWith('\n')) return raw.slice(0, -1).split('\n');
  return raw.split('\n');
};

const parseShallowLine = (line: string, lineNumber: number): ObjectId => {
  if (lineNumber > MAX_SHALLOW_ENTRIES) {
    throw shallowFileMalformed(REASON_SHALLOW_TOO_MANY_ENTRIES, lineNumber);
  }
  const prefix = oidPrefixOf(line);
  if (prefix === undefined) {
    throw shallowFileMalformed(REASON_SHALLOW_BAD_LINE, lineNumber);
  }
  return OID.from(prefix.toLowerCase());
};

const oidPrefixOf = (line: string): string | undefined => {
  const prefix = line.slice(0, OID_PREFIX_LENGTH);
  return OID_PREFIX_RE.test(prefix) ? prefix : undefined;
};
