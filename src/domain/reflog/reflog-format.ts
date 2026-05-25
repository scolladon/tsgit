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

const OID_LENGTH = 40;
const NEW_ID_START = OID_LENGTH + 1;
const NEW_ID_END = NEW_ID_START + OID_LENGTH;
const IDENTITY_START = NEW_ID_END + 1;
const FIELD_SEPARATOR = ' ';
const CONTROL_CHARS = /[\n\r]/;

/** Serialize one entry to a single LF-terminated reflog line. */
export function serializeReflogLine(entry: ReflogEntry): string {
  if (CONTROL_CHARS.test(entry.message)) {
    throw invalidReflogEntry('message contains a line break');
  }
  const identity = serializeIdentity(entry.identity);
  return `${entry.oldId} ${entry.newId} ${identity}\t${entry.message}\n`;
}

/** Parse one reflog line (LF already stripped). Throws INVALID_REFLOG_ENTRY. */
export function parseReflogLine(line: string): ReflogEntry {
  const tab = line.indexOf('\t');
  if (tab === -1) {
    throw invalidReflogEntry('missing tab separator');
  }
  const meta = line.slice(0, tab);
  const message = line.slice(tab + 1);
  if (meta[OID_LENGTH] !== FIELD_SEPARATOR || meta[NEW_ID_END] !== FIELD_SEPARATOR) {
    throw invalidReflogEntry('misplaced field separator');
  }
  const oldId = parseOid(meta.slice(0, OID_LENGTH));
  const newId = parseOid(meta.slice(NEW_ID_START, NEW_ID_END));
  const identity = parseReflogIdentity(meta.slice(IDENTITY_START));
  return { oldId, newId, identity, message };
}

/** Parse a whole reflog file. Oldest-first. A trailing blank line is tolerated. */
export function parseReflog(text: string): ReadonlyArray<ReflogEntry> {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map(parseReflogLine);
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
