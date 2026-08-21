/**
 * Reflog line encoder/decoder. One LF-terminated line per entry, written
 * under `.git/logs/**`. Canonical Git format — no tsgit extensions.
 *
 * @writes
 *   surface: reflog
 *   kind:    byte-identical
 *   format:  git-reflog-line
 */
import { parseIdentity, serializeIdentity } from '../objects/author-identity.js';
import { ObjectId } from '../objects/object-id.js';
import { invalidReflogEntry } from './error.js';
import type { ReflogEntry } from './reflog-entry.js';

const FIELD_SEPARATOR = ' ';
const CONTROL_CHARS = /[\n\r]/;

/**
 * The old-id/new-id/identity field boundaries within a reflog line's meta
 * portion (everything before the TAB), derived from the repository's own
 * hex oid width — 40 for SHA-1, 64 for SHA-256. Both fields are `hexLength`
 * wide, so `newIdStart`/`newIdEnd`/`identityStart` are all offsets by that
 * one number.
 */
/** Serialize one entry to a single LF-terminated reflog line. */
export function serializeReflogLine(entry: ReflogEntry, hexLength: 40 | 64): string {
  if (CONTROL_CHARS.test(entry.message)) {
    throw invalidReflogEntry('message contains a line break');
  }
  if (entry.oldId.length !== hexLength || entry.newId.length !== hexLength) {
    throw invalidReflogEntry('object id does not match the repository oid width');
  }
  const identity = serializeIdentity(entry.identity);
  const meta = `${entry.oldId} ${entry.newId} ${identity}`;
  // git appends the TAB + message only when the message is non-empty
  // (`if (msg && *msg)`); an empty message ends the line at the timezone.
  return entry.message === '' ? `${meta}\n` : `${meta}\t${entry.message}\n`;
}

/** Parse one reflog line (LF already stripped). Throws INVALID_REFLOG_ENTRY. */
export function parseReflogLine(line: string, hexLength: 40 | 64): ReflogEntry {
  const tab = line.indexOf('\t');
  // A tab-less line is git's empty-message form: the committer runs to the end.
  const meta = tab === -1 ? line : line.slice(0, tab);
  const message = tab === -1 ? '' : line.slice(tab + 1);
  // Locals rather than a returned object: `parseReflog` maps this over every
  // line of the file, so an intermediate allocation per line buys nothing.
  const newIdStart = hexLength + 1;
  const newIdEnd = newIdStart + hexLength;
  const identityStart = newIdEnd + 1;
  if (meta[hexLength] !== FIELD_SEPARATOR || meta[newIdEnd] !== FIELD_SEPARATOR) {
    throw invalidReflogEntry('misplaced field separator');
  }
  const oldId = parseOid(meta.slice(0, hexLength));
  const newId = parseOid(meta.slice(newIdStart, newIdEnd));
  const identity = parseReflogIdentity(meta.slice(identityStart));
  return { oldId, newId, identity, message };
}

/** Parse a whole reflog file. Oldest-first. A trailing blank line is tolerated. */
export function parseReflog(text: string, hexLength: 40 | 64): ReadonlyArray<ReflogEntry> {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseReflogLine(line, hexLength));
}

/** Collapse CR/LF to spaces and trim — defends the reflog's one-line invariant. */
export function sanitizeReflogMessage(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').trim();
}

// `ObjectId.from` and `parseIdentity` only ever throw `TsgitError`; the catch
// arms rewrap any failure as a single, uniform reflog-entry error.
function parseOid(hex: string): ObjectId {
  try {
    return ObjectId.from(hex);
  } catch {
    throw invalidReflogEntry('invalid object id');
  }
}

function parseReflogIdentity(raw: string): ReflogEntry['identity'] {
  try {
    return parseIdentity(raw);
  } catch {
    throw invalidReflogEntry('invalid identity');
  }
}
