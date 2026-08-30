import { compareBytes, indexOf } from '../objects/encoding.js';
import { entryNameKey, hasNonOctalByte, matchesDotgitAlias } from '../objects/tree-entry-bytes.js';
import {
  MSG_BAD_FILEMODE,
  MSG_BAD_TREE,
  MSG_DUPLICATE_ENTRIES,
  MSG_FULL_PATHNAME,
  MSG_GITATTRIBUTES_BLOB,
  MSG_GITATTRIBUTES_SYMLINK,
  MSG_GITIGNORE_SYMLINK,
  MSG_GITMODULES_BLOB,
  MSG_GITMODULES_SYMLINK,
  MSG_HAS_DOT,
  MSG_HAS_DOTDOT,
  MSG_HAS_DOTGIT,
  MSG_LARGE_PATHNAME,
  MSG_MAILMAP_SYMLINK,
  MSG_NULL_SHA1,
  MSG_TREE_NOT_SORTED,
  MSG_ZERO_PADDED_FILEMODE,
} from './msg-ids.js';
import { resolveSeverity } from './severity.js';
import type { FsckSeverity } from './types.js';

export interface TreeFinding {
  readonly msgId: string;
  readonly severity: FsckSeverity;
}

interface TreeEntry {
  readonly mode: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly sha: Uint8Array;
  readonly offset: number;
}

// Decodes the mode span only. Safe because parseTreeEntriesTolerant rejects
// any non-octal byte in that span before this ever runs — every mode that
// reaches it is already pure ASCII octal digits. Names are never decoded:
// fsck compares and keys them on raw bytes (see entryNameKey).
const DECODER = new TextDecoder();

const VALID_MODES: ReadonlySet<string> = new Set(['100644', '100755', '120000', '40000', '160000']);

const MAX_NAME_BYTES = 4096;

function isZeroSha(sha: Uint8Array): boolean {
  for (const byte of sha) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * Strips every leading zero, matching git's `canon_mode` — `0040000`
 * normalises to `40000`, not `040000`. Keeps at least one character so an
 * all-zero mode never normalises to the empty string.
 */
function stripLeadingZeros(mode: string): string {
  let i = 0;
  while (i < mode.length - 1 && mode[i] === '0') i++;
  return mode.slice(i);
}

/** Parse tree bytes tolerantly, returning entries and any badTree fault. */
function parseTreeEntriesTolerant(
  raw: Uint8Array,
  digestLength: 20 | 32,
): {
  readonly entries: ReadonlyArray<TreeEntry>;
  readonly badTree: boolean;
} {
  const entries: TreeEntry[] = [];
  let offset = 0;

  while (offset < raw.length) {
    const spaceIdx = indexOf(raw, 0x20, offset);
    if (spaceIdx === -1 || spaceIdx === offset) return { entries, badTree: true };
    if (hasNonOctalByte(raw, offset, spaceIdx)) return { entries, badTree: true };

    const nullIdx = indexOf(raw, 0x00, spaceIdx + 1);
    if (nullIdx === -1) return { entries, badTree: true };
    if (nullIdx === spaceIdx + 1) return { entries, badTree: true };

    const shaEnd = nullIdx + 1 + digestLength;
    if (shaEnd > raw.length) return { entries, badTree: true };

    const modeBytes = raw.subarray(offset, spaceIdx);
    const sha = raw.subarray(nullIdx + 1, shaEnd);

    // Safe to decode: hasNonOctalByte already rejected anything but ASCII
    // octal digits in this span, so no other byte value can reach here.
    const mode = DECODER.decode(modeBytes);

    entries.push({ mode, nameStart: spaceIdx + 1, nameEnd: nullIdx, sha, offset });
    offset = shaEnd;
  }

  return { entries, badTree: false };
}

/**
 * Compare two tree entries using git's canonical sort order.
 * Directories sort as if their name ends with '/'.
 */
function treeEntrySortKey(raw: Uint8Array, entry: TreeEntry): Uint8Array {
  const isDir = entry.mode === '40000' || entry.mode === '040000';
  const nameBytes = raw.subarray(entry.nameStart, entry.nameEnd);
  if (!isDir) return nameBytes;
  const result = new Uint8Array(nameBytes.length + 1);
  result.set(nameBytes);
  result[nameBytes.length] = 0x2f;
  return result;
}

function checkNameFaults(
  raw: Uint8Array,
  nameStart: number,
  nameEnd: number,
  key: string,
  byteLength: number,
  strict: boolean,
): ReadonlyArray<TreeFinding> {
  const findings: TreeFinding[] = [];
  if (key === '.') {
    findings.push({ msgId: MSG_HAS_DOT, severity: resolveSeverity(MSG_HAS_DOT, strict) });
  }
  if (key === '..') {
    findings.push({ msgId: MSG_HAS_DOTDOT, severity: resolveSeverity(MSG_HAS_DOTDOT, strict) });
  }
  if (matchesDotgitAlias(raw, nameStart, nameEnd, 'git')) {
    findings.push({ msgId: MSG_HAS_DOTGIT, severity: resolveSeverity(MSG_HAS_DOTGIT, strict) });
  }
  if (key.includes('/')) {
    findings.push({
      msgId: MSG_FULL_PATHNAME,
      severity: resolveSeverity(MSG_FULL_PATHNAME, strict),
    });
  }
  if (byteLength > MAX_NAME_BYTES) {
    findings.push({
      msgId: MSG_LARGE_PATHNAME,
      severity: resolveSeverity(MSG_LARGE_PATHNAME, strict),
    });
  }
  return findings;
}

function checkSpecialFileName(
  raw: Uint8Array,
  nameStart: number,
  nameEnd: number,
  mode: string,
  strict: boolean,
): ReadonlyArray<TreeFinding> {
  const findings: TreeFinding[] = [];
  const isSymlink = mode === '120000';
  const isRegular = mode === '100644' || mode === '100755';

  if (matchesDotgitAlias(raw, nameStart, nameEnd, 'gitmodules')) {
    if (isSymlink) {
      findings.push({
        msgId: MSG_GITMODULES_SYMLINK,
        severity: resolveSeverity(MSG_GITMODULES_SYMLINK, strict),
      });
    } else if (!isRegular) {
      findings.push({
        msgId: MSG_GITMODULES_BLOB,
        severity: resolveSeverity(MSG_GITMODULES_BLOB, strict),
      });
    }
  }
  if (matchesDotgitAlias(raw, nameStart, nameEnd, 'gitattributes')) {
    if (isSymlink) {
      findings.push({
        msgId: MSG_GITATTRIBUTES_SYMLINK,
        severity: resolveSeverity(MSG_GITATTRIBUTES_SYMLINK, strict),
      });
    } else if (!isRegular) {
      findings.push({
        msgId: MSG_GITATTRIBUTES_BLOB,
        severity: resolveSeverity(MSG_GITATTRIBUTES_BLOB, strict),
      });
    }
  }
  if (isSymlink && matchesDotgitAlias(raw, nameStart, nameEnd, 'gitignore')) {
    findings.push({
      msgId: MSG_GITIGNORE_SYMLINK,
      severity: resolveSeverity(MSG_GITIGNORE_SYMLINK, strict),
    });
  }
  if (isSymlink && matchesDotgitAlias(raw, nameStart, nameEnd, 'mailmap')) {
    findings.push({
      msgId: MSG_MAILMAP_SYMLINK,
      severity: resolveSeverity(MSG_MAILMAP_SYMLINK, strict),
    });
  }
  return findings;
}

function checkEntryFaults(
  raw: Uint8Array,
  entry: TreeEntry,
  key: string,
  prevEntry: TreeEntry | undefined,
  seenNames: Set<string>,
  strict: boolean,
): ReadonlyArray<TreeFinding> {
  const findings: TreeFinding[] = [];
  const { mode, nameStart, nameEnd, sha } = entry;

  if (mode.startsWith('0')) {
    findings.push({
      msgId: MSG_ZERO_PADDED_FILEMODE,
      severity: resolveSeverity(MSG_ZERO_PADDED_FILEMODE, strict),
    });
  }
  const normMode = stripLeadingZeros(mode);
  if (!VALID_MODES.has(normMode)) {
    findings.push({ msgId: MSG_BAD_FILEMODE, severity: resolveSeverity(MSG_BAD_FILEMODE, strict) });
  }
  if (isZeroSha(sha)) {
    findings.push({ msgId: MSG_NULL_SHA1, severity: resolveSeverity(MSG_NULL_SHA1, strict) });
  }
  for (const finding of checkNameFaults(
    raw,
    nameStart,
    nameEnd,
    key,
    nameEnd - nameStart,
    strict,
  )) {
    findings.push(finding);
  }

  if (seenNames.has(key)) {
    findings.push({
      msgId: MSG_DUPLICATE_ENTRIES,
      severity: resolveSeverity(MSG_DUPLICATE_ENTRIES, strict),
    });
  }

  if (
    prevEntry !== undefined &&
    compareBytes(treeEntrySortKey(raw, prevEntry), treeEntrySortKey(raw, entry)) > 0
  ) {
    findings.push({
      msgId: MSG_TREE_NOT_SORTED,
      severity: resolveSeverity(MSG_TREE_NOT_SORTED, strict),
    });
  }

  for (const finding of checkSpecialFileName(raw, nameStart, nameEnd, normMode, strict)) {
    findings.push(finding);
  }

  return findings;
}

/** Validate a raw tree object body, returning ordered findings. */
export function validateTree(
  raw: Uint8Array,
  strict: boolean,
  digestLength: 20 | 32,
): ReadonlyArray<TreeFinding> {
  const { entries, badTree } = parseTreeEntriesTolerant(raw, digestLength);
  if (badTree) {
    return [{ msgId: MSG_BAD_TREE, severity: resolveSeverity(MSG_BAD_TREE, strict) }];
  }

  const findings: TreeFinding[] = [];
  const seenNames = new Set<string>();
  let prevEntry: TreeEntry | undefined;

  for (const entry of entries) {
    const key = entryNameKey(raw, entry.nameStart, entry.nameEnd);
    for (const finding of checkEntryFaults(raw, entry, key, prevEntry, seenNames, strict)) {
      findings.push(finding);
    }
    seenNames.add(key);
    prevEntry = entry;
  }

  return findings;
}
