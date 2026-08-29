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
import { decode } from '../objects/encoding.js';
import { ObjectId } from '../objects/object-id.js';
import { invalidReflogEntry } from './error.js';
import type { ReflogEntry } from './reflog-entry.js';

const FIELD_SEPARATOR = ' ';
const CONTROL_CHARS = /[\n\r]/;
const LINE_FEED = /\n/;
const TEXT_ENCODER = new TextEncoder();

/**
 * The two refusals shared by every reflog line serializer, string or bytes:
 * the object id width must match the repository's oid, and the timestamp
 * must be non-zero (git's own rewrite never emits a zero timestamp — a line
 * that did would fail to re-parse, see the zero-timestamp refusal below).
 */
function assertReflogLineFields(entry: ReflogEntry, hexLength: 40 | 64): void {
  if (entry.oldId.length !== hexLength || entry.newId.length !== hexLength) {
    throw invalidReflogEntry('object id does not match the repository oid width');
  }
  if (entry.identity.timestamp === 0) {
    throw invalidReflogEntry('timestamp must be non-zero');
  }
}

/**
 * Builds the meta portion (old id, new id, identity) common to both STRING
 * serializers — everything before the TAB/message. One path for every field
 * but the trailing TAB/message is what keeps the append and rewrite string
 * serializers from drifting apart. Message refusals live in each serializer:
 * the append writer refuses CR and LF, the rewrite writer only LF (git's
 * rewrite preserves a bare CR byte in the message — measured, git 2.55.0, a
 * CRLF reflog survives `expire --expire=never` with every `\r` intact).
 */
function reflogLineMeta(entry: ReflogEntry, hexLength: 40 | 64): string {
  assertReflogLineFields(entry, hexLength);
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

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const LINE_FEED_BYTE = new Uint8Array([0x0a]);

/**
 * `serializeReflogRewriteLine`'s byte-faithful counterpart. When
 * `entry.raw` is present — the files backend attaches it while parsing an
 * entry from disk — the identity and message are re-emitted from their
 * VERBATIM on-disk byte slices instead of the entry's decoded display
 * strings: a display string that lost a non-UTF-8 byte to U+FFFD on read
 * would otherwise re-encode that replacement character on write, mangling
 * the file irreversibly. Only the timestamp/timezone are recomputed from
 * the parsed identity fields (ASCII, decode-invariant either way), matching
 * git's own rewrite recompute. A raw-less entry — built programmatically,
 * never read from disk — falls back to the string serializer, UTF-8 encoded.
 */
export function serializeReflogRewriteLineBytes(
  entry: ReflogEntry,
  hexLength: 40 | 64,
): Uint8Array {
  if (entry.raw === undefined) {
    return TEXT_ENCODER.encode(serializeReflogRewriteLine(entry, hexLength));
  }
  assertReflogLineFields(entry, hexLength);
  const prefix = TEXT_ENCODER.encode(`${entry.oldId} ${entry.newId} `);
  const suffix = TEXT_ENCODER.encode(
    ` ${entry.identity.timestamp} ${entry.identity.timezoneOffset}\t`,
  );
  return concatBytes([prefix, entry.raw.identity, suffix, entry.raw.message, LINE_FEED_BYTE]);
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

/**
 * Code units built per `String.fromCharCode` call — comfortably under every
 * engine's argument-count ceiling, so no file length can overflow the call.
 */
const LATIN1_DECODE_CHUNK = 8_192;

/**
 * One code unit per byte, chunked and joined — a lossless, position-
 * preserving projection: byte value N always becomes code point N, so any
 * string index found by scanning this projection IS the byte offset in the
 * source array. The byte-tier parsers run their grammar on this projection
 * rather than a UTF-8 decode, because a UTF-8 decode can collapse several
 * invalid bytes into a single U+FFFD — that would silently shift every
 * field offset after the invalid byte, making it impossible to recover
 * which original bytes a field came from.
 *
 * `TextDecoder('latin1')` is NOT a substitute: the Encoding Standard aliases
 * that label to windows-1252, which remaps 0x80–0x9F to other code points.
 */
function latin1Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += LATIN1_DECODE_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + LATIN1_DECODE_CHUNK)));
  }
  return parts.join('');
}

/**
 * `splitReflogLines`, plus each line's starting byte offset. Offsets are
 * recovered by walking the same LF-delimited layout the split already
 * computed: cumulative `line.length + 1` (for the consumed LF) is an exact
 * byte offset because `latin1Decode` never collapses bytes, so a code-unit
 * length here IS a byte length.
 */
function reflogLineByteRanges(
  bytes: Uint8Array,
): ReadonlyArray<{ readonly line: string; readonly start: number }> {
  const projected = latin1Decode(bytes);
  const ranges: { line: string; start: number }[] = [];
  let position = 0;
  for (const line of splitReflogLines(projected)) {
    ranges.push({ line, start: position });
    position += line.length + 1;
  }
  return ranges;
}

/**
 * Parses one line's grammar from its latin1 projection — `parseReflogLine`
 * itself, unchanged, so there is exactly one grammar for both the string
 * and byte tiers, zero-timestamp refusal included — then rebuilds the entry
 * with display strings UTF-8-decoded from the line's own byte slices and
 * the verbatim on-disk `raw` slices attached. The identity/message byte
 * boundaries are recovered from the SAME latin1 projection the grammar
 * parse just validated, so they always agree with what it accepted. Name's
 * byte length is read off `grammar.identity.name` (itself latin1-decoded,
 * so its `.length` already accounts for `parseIdentity`'s one-space trim)
 * rather than re-deriving the trim rule here.
 */
function parseReflogEntryFromBytes(
  bytes: Uint8Array,
  projectedLine: string,
  lineStart: number,
  hexLength: 40 | 64,
): ReflogEntry {
  const grammar = parseReflogLine(projectedLine, hexLength);
  const newIdStart = hexLength + 1;
  const newIdEnd = newIdStart + hexLength;
  const identityStart = newIdEnd + 1;
  const tab = projectedLine.indexOf('\t');
  const meta = tab === -1 ? projectedLine : projectedLine.slice(0, tab);
  const identityRegion = meta.slice(identityStart);
  const lastClose = identityRegion.lastIndexOf('>');
  const lastOpen = identityRegion.lastIndexOf('<', lastClose);

  const nameStart = lineStart + identityStart;
  const nameEnd = nameStart + grammar.identity.name.length;
  const emailStart = lineStart + identityStart + lastOpen + 1;
  const emailEnd = lineStart + identityStart + lastClose;
  const identityBytes = bytes.subarray(
    lineStart + identityStart,
    lineStart + identityStart + lastClose + 1,
  );
  const messageStart = tab === -1 ? projectedLine.length : tab + 1;
  const messageBytes = bytes.subarray(lineStart + messageStart, lineStart + projectedLine.length);

  return {
    oldId: grammar.oldId,
    newId: grammar.newId,
    identity: {
      name: decode(bytes.subarray(nameStart, nameEnd)),
      email: decode(bytes.subarray(emailStart, emailEnd)),
      timestamp: grammar.identity.timestamp,
      timezoneOffset: grammar.identity.timezoneOffset,
    },
    message: decode(messageBytes),
    raw: { identity: identityBytes, message: messageBytes },
  };
}

/**
 * `parseReflog`'s byte-faithful counterpart: same strict, all-or-nothing
 * contract, but every returned entry carries its verbatim on-disk `raw`
 * slices so a subsequent rewrite can re-emit non-UTF-8 content byte for
 * byte. Display strings are UTF-8-decoded per-field from the file's own
 * bytes rather than from one whole-file decode, so an invalid byte degrades
 * to U+FFFD only where it occurs.
 */
export function parseReflogBytes(
  bytes: Uint8Array,
  hexLength: 40 | 64,
): ReadonlyArray<ReflogEntry> {
  return reflogLineByteRanges(bytes)
    .filter(({ line }) => line !== '')
    .map(({ line, start }) => parseReflogEntryFromBytes(bytes, line, start, hexLength));
}

/**
 * `parseReflogLenient`'s byte-faithful counterpart: a line that does not
 * parse is skipped, and every surviving entry carries its `raw` on-disk
 * slices. Mirrors `parseReflogLenient`'s cheap shape pre-check so a corrupt
 * file still skips a garbage line without constructing a `TsgitError` for
 * it — an empty line needs no separate guard here: it fails that same
 * pre-check (`''[hexLength]` is `undefined`, never a space) and is skipped
 * exactly like any other malformed line.
 */
export function parseReflogLenientBytes(
  bytes: Uint8Array,
  hexLength: 40 | 64,
): ReadonlyArray<ReflogEntry> {
  const entries: ReflogEntry[] = [];
  for (const { line, start } of reflogLineByteRanges(bytes)) {
    if (line[hexLength] !== FIELD_SEPARATOR || line[2 * hexLength + 1] !== FIELD_SEPARATOR) {
      continue;
    }
    try {
      entries.push(parseReflogEntryFromBytes(bytes, line, start, hexLength));
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
