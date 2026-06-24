import { compareBytes, indexOf } from '../objects/encoding.js';
import {
  MSG_BAD_FILEMODE,
  MSG_BAD_TREE,
  MSG_DUPLICATE_ENTRIES,
  MSG_EMPTY_NAME,
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
  readonly name: string;
  readonly sha: Uint8Array;
  readonly offset: number;
}

const VALID_MODES: ReadonlySet<string> = new Set(['100644', '100755', '120000', '40000', '160000']);

const SHA_LENGTH = 20;
const MAX_NAME_BYTES = 4096;

function isZeroSha(sha: Uint8Array): boolean {
  for (const byte of sha) {
    if (byte !== 0) return false;
  }
  return true;
}

/** Parse tree bytes tolerantly, returning entries and any badTree fault. */
function parseTreeEntriesTolerant(raw: Uint8Array): {
  readonly entries: ReadonlyArray<TreeEntry>;
  readonly badTree: boolean;
} {
  const entries: TreeEntry[] = [];
  let offset = 0;

  while (offset < raw.length) {
    const spaceIdx = indexOf(raw, 0x20, offset);
    if (spaceIdx === -1 || spaceIdx === offset) return { entries, badTree: true };

    const nullIdx = indexOf(raw, 0x00, spaceIdx + 1);
    if (nullIdx === -1) return { entries, badTree: true };

    const shaEnd = nullIdx + 1 + SHA_LENGTH;
    if (shaEnd > raw.length) return { entries, badTree: true };

    const modeBytes = raw.subarray(offset, spaceIdx);
    const nameBytes = raw.subarray(spaceIdx + 1, nullIdx);
    const sha = raw.subarray(nullIdx + 1, shaEnd);

    const mode = new TextDecoder().decode(modeBytes);
    const name = new TextDecoder().decode(nameBytes);

    entries.push({ mode, name, sha, offset });
    offset = shaEnd;
  }

  return { entries, badTree: false };
}

/**
 * Compare two tree entries using git's canonical sort order.
 * Directories sort as if their name ends with '/'.
 */
function treeEntrySortKey(entry: TreeEntry): Uint8Array {
  const isDir = entry.mode === '40000' || entry.mode === '040000';
  const nameBytes = new TextEncoder().encode(entry.name);
  if (!isDir) return nameBytes;
  const result = new Uint8Array(nameBytes.length + 1);
  result.set(nameBytes);
  result[nameBytes.length] = 0x2f;
  return result;
}

function checkNameFaults(name: string, strict: boolean): ReadonlyArray<TreeFinding> {
  const findings: TreeFinding[] = [];
  if (name === '') {
    findings.push({ msgId: MSG_EMPTY_NAME, severity: resolveSeverity(MSG_EMPTY_NAME, strict) });
    return findings;
  }
  if (name === '.') {
    findings.push({ msgId: MSG_HAS_DOT, severity: resolveSeverity(MSG_HAS_DOT, strict) });
  }
  if (name === '..') {
    findings.push({ msgId: MSG_HAS_DOTDOT, severity: resolveSeverity(MSG_HAS_DOTDOT, strict) });
  }
  if (name === '.git') {
    findings.push({ msgId: MSG_HAS_DOTGIT, severity: resolveSeverity(MSG_HAS_DOTGIT, strict) });
  }
  if (name.includes('/')) {
    findings.push({
      msgId: MSG_FULL_PATHNAME,
      severity: resolveSeverity(MSG_FULL_PATHNAME, strict),
    });
  }
  const byteLength = new TextEncoder().encode(name).length;
  if (byteLength > MAX_NAME_BYTES) {
    findings.push({
      msgId: MSG_LARGE_PATHNAME,
      severity: resolveSeverity(MSG_LARGE_PATHNAME, strict),
    });
  }
  return findings;
}

function checkSpecialFileName(
  mode: string,
  name: string,
  strict: boolean,
): ReadonlyArray<TreeFinding> {
  const findings: TreeFinding[] = [];
  const isSymlink = mode === '120000';
  const isRegular = mode === '100644' || mode === '100755';

  if (name === '.gitmodules') {
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
  if (name === '.gitattributes') {
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
  if (name === '.gitignore' && isSymlink) {
    findings.push({
      msgId: MSG_GITIGNORE_SYMLINK,
      severity: resolveSeverity(MSG_GITIGNORE_SYMLINK, strict),
    });
  }
  if (name === '.mailmap' && isSymlink) {
    findings.push({
      msgId: MSG_MAILMAP_SYMLINK,
      severity: resolveSeverity(MSG_MAILMAP_SYMLINK, strict),
    });
  }
  return findings;
}

function checkEntryFaults(
  entry: TreeEntry,
  prevEntry: TreeEntry | undefined,
  seenNames: Set<string>,
  strict: boolean,
): ReadonlyArray<TreeFinding> {
  const findings: TreeFinding[] = [];
  const { mode, name, sha } = entry;

  if (mode.startsWith('0')) {
    findings.push({
      msgId: MSG_ZERO_PADDED_FILEMODE,
      severity: resolveSeverity(MSG_ZERO_PADDED_FILEMODE, strict),
    });
  }
  const normMode = mode.startsWith('0') ? mode.slice(1) : mode;
  if (!VALID_MODES.has(normMode)) {
    findings.push({ msgId: MSG_BAD_FILEMODE, severity: resolveSeverity(MSG_BAD_FILEMODE, strict) });
  }
  if (isZeroSha(sha)) {
    findings.push({ msgId: MSG_NULL_SHA1, severity: resolveSeverity(MSG_NULL_SHA1, strict) });
  }
  for (const finding of checkNameFaults(name, strict)) findings.push(finding);

  if (seenNames.has(name)) {
    findings.push({
      msgId: MSG_DUPLICATE_ENTRIES,
      severity: resolveSeverity(MSG_DUPLICATE_ENTRIES, strict),
    });
  }

  if (
    prevEntry !== undefined &&
    compareBytes(treeEntrySortKey(prevEntry), treeEntrySortKey(entry)) > 0
  ) {
    findings.push({
      msgId: MSG_TREE_NOT_SORTED,
      severity: resolveSeverity(MSG_TREE_NOT_SORTED, strict),
    });
  }

  for (const finding of checkSpecialFileName(mode, name, strict)) findings.push(finding);

  return findings;
}

/** Validate a raw tree object body, returning ordered findings. */
export function validateTree(raw: Uint8Array, strict: boolean): ReadonlyArray<TreeFinding> {
  const { entries, badTree } = parseTreeEntriesTolerant(raw);
  if (badTree) {
    return [{ msgId: MSG_BAD_TREE, severity: resolveSeverity(MSG_BAD_TREE, strict) }];
  }

  const findings: TreeFinding[] = [];
  const seenNames = new Set<string>();
  let prevEntry: TreeEntry | undefined;

  for (const entry of entries) {
    for (const finding of checkEntryFaults(entry, prevEntry, seenNames, strict)) {
      findings.push(finding);
    }
    seenNames.add(entry.name);
    prevEntry = entry;
  }

  return findings;
}
