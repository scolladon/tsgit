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
const LINE_FEED = /\n/;

/**
 * Runs the two refusals shared by both reflog line serializers and builds
 * the meta portion (old id, new id, identity) common to both — everything
 * before the TAB/message. One path for every field but the trailing
 * TAB/message is what keeps the append and rewrite serializers from drifting
 * apart. Message refusals live in each serializer: the append writer refuses
 * CR and LF, the rewrite writer only LF (git's rewrite preserves a bare CR
 * byte in the message — measured, git 2.55.0, a CRLF reflog survives
 * `expire --expire=never` with every `\r` intact).
 */
function reflogLineMeta(entry: ReflogEntry, hexLength: 40 | 64): string {
  if (entry.oldId.length !== hexLength || entry.newId.length !== hexLength) {
    throw invalidReflogEntry('object id does not match the repository oid width');
  }
  if (entry.identity.timestamp === 0) {
    throw invalidReflogEntry('timestamp must be non-zero');
  }
  const identity = serializeIdentity(entry.identity);
  return `${entry.oldId} ${entry.newId} ${identity}`;
}

/** Serialize one entry to a single LF-terminated reflog line. */
export function serializeReflogLine(entry: ReflogEntry, hexLength: 40 | 64): string {
  if (CONTROL_CHARS.test(entry.message)) {
    throw invalidReflogEntry('message contains a line break');
  }
  const meta = reflogLineMeta(entry, hexLength);
  // git appends the TAB + message only when the message is non-empty
  // (`if (msg && *msg)`); an empty message ends the line at the timezone.
  return entry.message === '' ? `${meta}\n` : `${meta}\t${entry.message}\n`;
}

/**
 * Serialize one entry as git's expire/delete REWRITE writer does. Identical
 * to the append form except the message TAB is always emitted, even for an
 * empty message — measured against git 2.55.0, where a tab-less entry gains
 * a trailing TAB after `reflog expire --expire=never`. Two git writers, two
 * rules; the append writer's own rule stays in `serializeReflogLine`. A CR
 * in the message is legal here: parsed entries can carry one (CRLF files),
 * and git's rewrite emits it back verbatim.
 */
export function serializeReflogRewriteLine(entry: ReflogEntry, hexLength: 40 | 64): string {
  if (LINE_FEED.test(entry.message)) {
    throw invalidReflogEntry('message contains a line break');
  }
  const meta = reflogLineMeta(entry, hexLength);
  return `${meta}\t${entry.message}\n`;
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
  if (identity.timestamp === 0) {
    throw invalidReflogEntry('zero timestamp');
  }
  return { oldId, newId, identity, message };
}

/**
 * Splits reflog file text into lines, dropping a final line with no LF
 * terminator: git treats a torn trailing write as absent, not as an entry
 * (measured, git 2.55.0). This is a file-level rule on the split, not a
 * per-line predicate, so the strict and lenient parsers keep agreeing about
 * every file's line set.
 */
const splitReflogLines = (text: string): readonly string[] => {
  const lastTerminator = text.lastIndexOf('\n');
  return lastTerminator === -1 ? [] : text.slice(0, lastTerminator).split('\n');
};

/** Parse a whole reflog file. Oldest-first. A trailing blank line is tolerated. */
export function parseReflog(text: string, hexLength: 40 | 64): ReadonlyArray<ReflogEntry> {
  return splitReflogLines(text)
    .filter((line) => line !== '')
    .map((line) => parseReflogLine(line, hexLength));
}

/**
 * Parse a whole reflog file LINE-GRAINED: a line that does not parse is
 * skipped, never discarding the file's OTHER valid entries the way
 * `parseReflog`'s all-or-nothing `.map` does. Mirrors git's per-line reflog
 * machinery (`for_each_reflog_ent`), which skips a bad line and keeps
 * going — pinned against git 2.55.0. This is the reader for every surface
 * git reads leniently: the `reflog` command, `rev-parse @{n}`/`@{date}`,
 * the stash stack, stash snapshots, and gc's retention scan. `parseReflog`
 * stays strict for callers whose contract is strictness. Oldest-first,
 * same as `parseReflog`.
 */
export function parseReflogLenient(text: string, hexLength: 40 | 64): ReadonlyArray<ReflogEntry> {
  const entries: ReflogEntry[] = [];
  for (const line of splitReflogLines(text)) {
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — splitReflogLines can still yield an empty `line` (e.g. a blank line between two LFs); it always fails the separator pre-check below (undefined !== ' ') exactly like any other malformed line, so skipping this guard changes nothing observable.
    if (line === '') continue;
    // Cheap shape pre-check so a garbage line skips WITHOUT constructing a
    // TsgitError: error allocation dominates on corrupt files (measured
    // 67x — 18s vs 269ms on 16 MiB of garbage) now that user-facing
    // commands read through this path. Same predicate parseReflogLine
    // applies first; a line passing it but failing deeper (bad hex, bad
    // identity) still takes the throwing path, which is the rare shape.
    // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — any mutant that makes this pre-check skip FEWER lines (false; || to &&) only reroutes the same malformed line into parseReflogLine's identical separator throw caught below; every skip-MORE mutant is killed by the surviving-entry tests.
    if (line[hexLength] !== FIELD_SEPARATOR || line[2 * hexLength + 1] !== FIELD_SEPARATOR) {
      continue;
    }
    try {
      entries.push(parseReflogLine(line, hexLength));
    } catch {
      // Malformed line — skipped, not fatal to the rest of the file.
    }
  }
  return entries;
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
