/**
 * `.git/shallow` line grammar — pure, no `Context`, no I/O. Shared by the
 * reader (`shallow-file.ts`) and the per-`Context` shallow-set memo
 * (`internal/shallow-set.ts`) without creating a
 * `shallow-file.ts <-> shallow-set.ts` import cycle.
 *
 * git's line reader: a 0-byte file yields no lines; a trailing LF ends a
 * line; a missing trailing LF still yields the final line. Each line's
 * first `hexLength` characters (the repository hash algorithm's hex size —
 * 40 for sha1, 64 for sha256, git's `hexsz`) must be hex (upper or lower,
 * normalised to lowercase); anything after that prefix is ignored. Any
 * other line — blank, short, non-hex — is a fatal refusal: canonical git's
 * shallow-line reader does not tolerate malformed content.
 *
 * The scan is cursor-based and refuses the moment the entry count crosses
 * `MAX_SHALLOW_ENTRIES`, before materialising further lines, so the cap
 * bounds peak allocation as well as the retained set. The cap sits at
 * parity with the protocol side (`MAX_V2_SECTION_ENTRIES`, itself
 * `MAX_ADVERTISED_REFS`), which bounds the `shallow-info` entries a fetch
 * can persist — a file tsgit wrote therefore always re-reads under it.
 */
import { shallowFileMalformed } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/object-id.js';
import { ObjectId as OID } from '../../../domain/objects/object-id.js';
import { REASON_SHALLOW_BAD_LINE, REASON_SHALLOW_TOO_MANY_ENTRIES } from '../validators.js';

export const MAX_SHALLOW_ENTRIES = 500_000;

const SHALLOW_HEX_RE = { 40: /^[0-9a-fA-F]{40}$/, 64: /^[0-9a-fA-F]{64}$/ } as const;

export const parseShallowFile = (raw: string, hexLength: 40 | 64): ReadonlyArray<ObjectId> => {
  const out: ObjectId[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    if (out.length >= MAX_SHALLOW_ENTRIES) {
      throw shallowFileMalformed(REASON_SHALLOW_TOO_MANY_ENTRIES, out.length + 1);
    }
    const lineEnd = nextLineEnd(raw, cursor);
    out.push(parseShallowLine(raw.slice(cursor, lineEnd), out.length + 1, hexLength));
    cursor = lineEnd + 1;
  }
  return out;
};

const nextLineEnd = (raw: string, cursor: number): number => {
  const lf = raw.indexOf('\n', cursor);
  return lf === -1 ? raw.length : lf;
};

const parseShallowLine = (line: string, lineNumber: number, hexLength: 40 | 64): ObjectId => {
  const prefix = line.slice(0, hexLength);
  if (!SHALLOW_HEX_RE[hexLength].test(prefix)) {
    throw shallowFileMalformed(REASON_SHALLOW_BAD_LINE, lineNumber);
  }
  return OID.from(prefix.toLowerCase());
};
