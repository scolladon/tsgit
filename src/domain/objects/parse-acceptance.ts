/**
 * git's commit and tag parse acceptance — a pure, streaming transcription of
 * `parse_commit_buffer` (`commit.c:516`) and `parse_tag_buffer` (`tag.c:130`)
 * in git 2.55.0. `parse_object_buffer` (`object.c:261`) refuses a commit or
 * tag either of these functions refuses, and the ref transaction then
 * reports the target as nonexistent — so this module answers exactly one
 * question: would git's own parser accept these bytes?
 *
 * Nothing stricter than git: tsgit's own domain parsers (`parseCommitContent`,
 * `parseTagContent`) require fields git does not (author/committer, a
 * non-empty tag name), so they are never used for this check.
 *
 * The scan is fed one chunk at a time and never throws — a hash mismatch,
 * checked by the caller from the same bytes, must always be reported first.
 * It retains at most one partial line's worth of bytes, whatever the
 * object's total size, so a caller never has to materialise a large body to
 * answer this question.
 */
import { sanitizeForDisplay } from '../error.js';
import { bytesEqual, concatBytes, decode, indexOf } from './encoding.js';

const LF = 0x0a;
const EMPTY: Uint8Array = new Uint8Array(0);
const MAX_TYPE_NAME_BYTES = 20;
const KNOWN_TAG_TYPES: ReadonlySet<string> = new Set(['blob', 'tree', 'commit', 'tag']);

const TREE_PREFIX = new TextEncoder().encode('tree ');
const PARENT_PREFIX = new TextEncoder().encode('parent ');
const OBJECT_PREFIX = new TextEncoder().encode('object ');
const TYPE_PREFIX = new TextEncoder().encode('type ');
const TAG_PREFIX = new TextEncoder().encode('tag ');

export interface ParseAcceptanceRefusal {
  readonly type: 'commit' | 'tag';
  readonly reason: string;
}

interface CommitScan {
  readonly kind: 'commit';
  readonly hexLength: 40 | 64;
  readonly totalBytes: number;
  readonly phase: 'tree' | 'parents' | 'tail';
  readonly carry: Uint8Array;
  readonly pc1ContentRefusal: string | undefined;
  readonly pc2Refusal: string | undefined;
  readonly treeHex: string | undefined;
  readonly pc4Candidate: string | undefined;
  readonly grammarRefusal: string | undefined;
}

interface TagScan {
  readonly kind: 'tag';
  readonly hexLength: 40 | 64;
  readonly totalBytes: number;
  readonly phase: 'object' | 'type' | 'tag-line-prefix' | 'tag-line-scan' | 'tail';
  readonly carry: Uint8Array;
  readonly pt2Refusal: string | undefined;
  readonly earlyRefusal: string | undefined;
}

/** Immutable, opaque to callers — every `feed` returns a new value. Carries
 *  at most one partial line (bounded by the hex length) plus a handful of
 *  short, already-decided fields. */
export type ParseAcceptanceScan = CommitScan | TagScan;

export const startParseAcceptance = (
  type: 'commit' | 'tag',
  hexLength: 40 | 64,
): ParseAcceptanceScan =>
  type === 'commit'
    ? {
        kind: 'commit',
        hexLength,
        totalBytes: 0,
        phase: 'tree',
        carry: EMPTY,
        pc1ContentRefusal: undefined,
        pc2Refusal: undefined,
        treeHex: undefined,
        pc4Candidate: undefined,
        grammarRefusal: undefined,
      }
    : {
        kind: 'tag',
        hexLength,
        totalBytes: 0,
        phase: 'object',
        carry: EMPTY,
        pt2Refusal: undefined,
        earlyRefusal: undefined,
      };

// `bytesEqual` itself refuses a length mismatch, so a `bytes` shorter than
// `prefix` already answers `false` without a separate guard here.
const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytesEqual(bytes.subarray(0, prefix.length), prefix);

const isHexByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x61 && byte <= 0x66) ||
  (byte >= 0x41 && byte <= 0x46);

const isAllHex = (bytes: Uint8Array): boolean => {
  for (let i = 0; i < bytes.length; i += 1) {
    if (!isHexByte(bytes[i] as number)) return false;
  }
  return true;
};

const decodeLowerHex = (bytes: Uint8Array): string => decode(bytes).toLowerCase();

/**
 * One step of the commit tree-line window: once `h + 6` bytes are
 * available, the line's grammar and hex content are decided immediately —
 * only the body-length condition needs the total, deferred to the verdict.
 */
function feedCommitTree(scan: CommitScan): CommitScan {
  const h = scan.hexLength;
  if (scan.carry.length < h + 6) return scan;
  const window = scan.carry.subarray(0, h + 6);
  const rest = scan.carry.subarray(h + 6);
  const pc1Content = !startsWith(window, TREE_PREFIX) || window[h + 5] !== LF;
  const pc2 = !pc1Content && !isAllHex(window.subarray(5, 5 + h));
  const treeHex = pc1Content ? undefined : decodeLowerHex(window.subarray(5, 5 + h));
  return {
    ...scan,
    phase: 'parents',
    carry: rest,
    pc1ContentRefusal: pc1Content ? 'bogus commit object' : undefined,
    pc2Refusal: pc2 ? 'bad tree pointer' : undefined,
    treeHex,
  };
}

/**
 * One step of the commit parent-line scan. A line needs `h + 9` bytes to
 * decide — the extra byte proves more of the body follows, since a parent
 * line landing exactly on the body's last `h + 8` bytes is itself refused
 * (checked at the verdict, once no more bytes are coming).
 */
function feedCommitParents(scan: CommitScan): CommitScan {
  const h = scan.hexLength;
  if (scan.carry.length < 7) return scan;
  if (!startsWith(scan.carry, PARENT_PREFIX)) return { ...scan, phase: 'tail', carry: EMPTY };
  if (scan.carry.length < h + 9) return scan;
  const line = scan.carry.subarray(0, h + 8);
  const hexPart = line.subarray(7, 7 + h);
  if (!isAllHex(hexPart) || line[h + 7] !== LF) {
    return { ...scan, phase: 'tail', carry: EMPTY, grammarRefusal: 'bad parents' };
  }
  const parentHex = decodeLowerHex(hexPart);
  const pc4Candidate =
    scan.pc4Candidate === undefined && parentHex === scan.treeHex ? parentHex : scan.pc4Candidate;
  return { ...scan, carry: scan.carry.subarray(h + 8), pc4Candidate };
}

const COMMIT_STEPPERS: Readonly<Record<CommitScan['phase'], (scan: CommitScan) => CommitScan>> = {
  tree: feedCommitTree,
  parents: feedCommitParents,
  tail: (scan) => scan,
};

/** Drains as much of the carried bytes as the current phase allows,
 *  advancing through phases within one call — a stepper that returns its
 *  own input back unchanged means "wait for more bytes". */
function drain<Scan extends ParseAcceptanceScan>(scan: Scan, step: (scan: Scan) => Scan): Scan {
  let next = scan;
  for (;;) {
    const stepped = step(next);
    if (stepped === next) return next;
    next = stepped;
  }
}

// An empty carry needs no copy: the steppers only read the bytes, and the
// partial line left afterwards is copied out of `chunk` by `feedScan`.
const appendToCarry = (carry: Uint8Array, chunk: Uint8Array): Uint8Array =>
  carry.length === 0 ? chunk : concatBytes([carry, chunk]);

/** Once a scan reaches its tail, no later byte can change the verdict — only
 *  the total still matters, so the chunk itself is never carried. Whatever
 *  partial line remains is copied, so the scan neither aliases nor keeps
 *  alive the caller's chunk. */
function feedScan<Scan extends ParseAcceptanceScan>(
  scan: Scan,
  chunk: Uint8Array,
  step: (scan: Scan) => Scan,
): Scan {
  const counted: Scan = { ...scan, totalBytes: scan.totalBytes + chunk.length };
  if (scan.phase === 'tail') return counted;
  const drained = drain({ ...counted, carry: appendToCarry(scan.carry, chunk) }, step);
  return { ...drained, carry: drained.carry.slice() };
}

const stepCommit = (scan: CommitScan): CommitScan => COMMIT_STEPPERS[scan.phase](scan);

/** The object-line window: `object <h hex>\n`, decided immediately once
 *  `h + 8` bytes are available — no total-length ambiguity, unlike the
 *  tag's own too-short check. */
function feedTagObject(scan: TagScan): TagScan {
  const h = scan.hexLength;
  if (scan.carry.length < h + 8) return scan;
  const window = scan.carry.subarray(0, h + 8);
  const rest = scan.carry.subarray(h + 8);
  const bad =
    !startsWith(window, OBJECT_PREFIX) ||
    !isAllHex(window.subarray(7, 7 + h)) ||
    window[h + 7] !== LF;
  return { ...scan, phase: 'type', carry: rest, pt2Refusal: bad ? 'bad object line' : undefined };
}

const unknownTagTypeReason = (name: string): string =>
  `unknown tag type '${sanitizeForDisplay(name)}'`;

/** The type-line window: `type <name>\n`, `name` capped at
 *  `MAX_TYPE_NAME_BYTES` — a name that long, LF or not, already refuses. */
function feedTagType(scan: TagScan): TagScan {
  if (scan.carry.length < TYPE_PREFIX.length) return scan;
  if (!startsWith(scan.carry, TYPE_PREFIX)) {
    return { ...scan, phase: 'tail', carry: EMPTY, earlyRefusal: 'bad type line' };
  }
  const zoneEnd = Math.min(scan.carry.length, TYPE_PREFIX.length + MAX_TYPE_NAME_BYTES);
  const nameZone = scan.carry.subarray(TYPE_PREFIX.length, zoneEnd);
  const lf = indexOf(nameZone, LF, 0);
  if (lf === -1) {
    if (nameZone.length >= MAX_TYPE_NAME_BYTES) {
      return { ...scan, phase: 'tail', carry: EMPTY, earlyRefusal: 'bad type line' };
    }
    return scan;
  }
  const name = decode(nameZone.subarray(0, lf));
  const rest = scan.carry.subarray(TYPE_PREFIX.length + lf + 1);
  const nulAt = name.indexOf('\0');
  const comparedName = nulAt === -1 ? name : name.slice(0, nulAt);
  if (!KNOWN_TAG_TYPES.has(comparedName)) {
    return { ...scan, phase: 'tail', carry: EMPTY, earlyRefusal: unknownTagTypeReason(name) };
  }
  return { ...scan, phase: 'tag-line-prefix', carry: rest };
}

/** The `tag ` prefix: needs its own 4 bytes, decided immediately on mismatch. */
function feedTagLinePrefix(scan: TagScan): TagScan {
  if (scan.carry.length < TAG_PREFIX.length) return scan;
  if (!startsWith(scan.carry, TAG_PREFIX)) {
    return { ...scan, phase: 'tail', carry: EMPTY, earlyRefusal: 'bad tag line' };
  }
  return { ...scan, phase: 'tag-line-scan', carry: scan.carry.subarray(TAG_PREFIX.length) };
}

/** Once `tag ` is confirmed, only whether an LF ever follows matters — no
 *  content past that point is part of the grammar, so nothing is retained.
 *  Returns the identical `scan` (not a same-valued copy) whenever nothing
 *  changed — the dispatch loop's only "wait for more input" signal. */
function feedTagLineScan(scan: TagScan): TagScan {
  const lf = indexOf(scan.carry, LF, 0);
  if (lf === -1) return scan.carry.length === 0 ? scan : { ...scan, carry: EMPTY };
  return { ...scan, phase: 'tail', carry: EMPTY };
}

const TAG_STEPPERS: Readonly<Record<TagScan['phase'], (scan: TagScan) => TagScan>> = {
  object: feedTagObject,
  type: feedTagType,
  'tag-line-prefix': feedTagLinePrefix,
  'tag-line-scan': feedTagLineScan,
  tail: (scan) => scan,
};

const stepTag = (scan: TagScan): TagScan => TAG_STEPPERS[scan.phase](scan);

/** Feeds one chunk of the object's body (in storage order) into the scan.
 *  Never throws — a grammar failure is recorded and scanning keeps counting
 *  bytes, so a hash mismatch (checked from the same bytes) is always
 *  reported first. */
export const feedParseAcceptance = (
  scan: ParseAcceptanceScan,
  chunk: Uint8Array,
): ParseAcceptanceScan =>
  scan.kind === 'commit' ? feedScan(scan, chunk, stepCommit) : feedScan(scan, chunk, stepTag);

/** Whether a commit parent line's id equalled the tree id — the one case
 *  git resolves with a lookup (a shallow boundary skips it) rather than
 *  from the bytes alone. Always `false` for a tag scan. */
export const needsParentLookups = (scan: ParseAcceptanceScan): boolean =>
  scan.kind === 'commit' && scan.pc4Candidate !== undefined;

function commitVerdict(
  scan: CommitScan,
  parentLookups: 'checked' | 'skipped',
): ParseAcceptanceRefusal | undefined {
  const h = scan.hexLength;
  if (scan.totalBytes <= h + 6) return { type: 'commit', reason: 'bogus commit object' };
  if (scan.pc1ContentRefusal !== undefined) {
    return { type: 'commit', reason: scan.pc1ContentRefusal };
  }
  if (scan.pc2Refusal !== undefined) return { type: 'commit', reason: scan.pc2Refusal };
  // A parent line still sitting in `carry` at exactly `h + 8` bytes, with no
  // more input coming, is the last `h + 8` bytes of the body — malformed,
  // decided only now that "no more bytes" is known. The scan only ever
  // reaches this phase with that much carried when the `parent ` prefix
  // already matched (`feedCommitParents` clears it to 'tail' immediately
  // otherwise).
  const trailingRefusal =
    scan.phase === 'parents' && scan.carry.length === h + 8 ? 'bad parents' : undefined;
  if (scan.pc4Candidate !== undefined && parentLookups === 'checked') {
    return { type: 'commit', reason: `bad parent ${scan.pc4Candidate}` };
  }
  const grammarRefusal = scan.grammarRefusal ?? trailingRefusal;
  if (grammarRefusal !== undefined) return { type: 'commit', reason: grammarRefusal };
  return undefined;
}

function tagVerdict(scan: TagScan): ParseAcceptanceRefusal | undefined {
  const h = scan.hexLength;
  if (scan.totalBytes < h + 24) return { type: 'tag', reason: 'tag object too short' };
  if (scan.pt2Refusal !== undefined) return { type: 'tag', reason: scan.pt2Refusal };
  if (scan.earlyRefusal !== undefined) return { type: 'tag', reason: scan.earlyRefusal };
  // Reached with no more input: 'type' means no LF ever closed the type
  // line; 'tag-line-scan' means `tag ` was confirmed but no LF ever
  // followed it. 'tag-line-prefix' needs no case of its own: the object and
  // type lines alone already total `h + 20` for every known type name, so
  // reaching here at all (the too-short check above passed, meaning
  // `totalBytes >= h + 24`) guarantees at least 4 more bytes arrived —
  // enough for `feedTagLinePrefix` to have already resolved the `tag `
  // prefix one way or the other.
  if (scan.phase === 'type') return { type: 'tag', reason: 'bad type line' };
  if (scan.phase === 'tag-line-scan') return { type: 'tag', reason: 'bad tag line' };
  return undefined;
}

/** The verdict, read only after the object's hash has already been verified
 *  from the same bytes. `parentLookups` is a single, whole-commit decision
 *  (`'skipped'` only when the commit itself is a recorded shallow
 *  boundary) — git's graft/shallow check is per-commit, not per-parent. */
export const parseAcceptanceVerdict = (
  scan: ParseAcceptanceScan,
  options: { readonly parentLookups: 'checked' | 'skipped' },
): ParseAcceptanceRefusal | undefined =>
  scan.kind === 'commit' ? commitVerdict(scan, options.parentLookups) : tagVerdict(scan);
