/**
 * Shared fast-check arbitraries for archive unit property tests.
 * Used by tar.properties.test.ts (and later zip.properties.test.ts).
 */
import fc from 'fast-check';
import type { ArchiveEntry, ArchiveResult } from '../../../../src/domain/archive/types.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';

// ---------------------------------------------------------------------------
// Primitive arbitraries
// ---------------------------------------------------------------------------

export function arbObjectId(): fc.Arbitrary<ObjectId> {
  return fc
    .array(fc.constantFrom(...'0123456789abcdef'.split('')), {
      minLength: 40,
      maxLength: 40,
    })
    .map((chars) => chars.join('') as unknown as ObjectId);
}

/** Flat path component: 1–12 lowercase ASCII chars + digits, no '/' separator. */
function arbPathComponent(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom('a', 'b', 'c', 'd', 'x', 'y', 'z', '1', '2', 'f'), {
      minLength: 1,
      maxLength: 12,
    })
    .map((chars) => chars.join(''));
}

/**
 * Flat file path: 1–2 components joined with '/'.
 * Total length stays ≤80 bytes so the ustar name field never splits.
 * Extensions are omitted to keep the generator minimal.
 */
export function arbFilePath(): fc.Arbitrary<FilePath> {
  return fc
    .tuple(arbPathComponent(), fc.option(arbPathComponent(), { nil: undefined }))
    .map(([a, b]) => (b !== undefined ? `${a}/${b}` : a) as unknown as FilePath);
}

/** Entry content: 0–64 raw bytes (non-empty for blobs). */
function arbContent(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: 0, maxLength: 64 });
}

// ---------------------------------------------------------------------------
// ArchiveEntry arbitraries — one per mode so the oracle can verify mode mapping
// ---------------------------------------------------------------------------

export function arbRegularEntry(): fc.Arbitrary<ArchiveEntry> {
  return fc.tuple(arbFilePath(), arbObjectId(), arbContent()).map(([path, oid, content]) => ({
    path,
    mode: '100644' as ArchiveEntry['mode'],
    oid,
    content,
  }));
}

export function arbExecEntry(): fc.Arbitrary<ArchiveEntry> {
  return fc.tuple(arbFilePath(), arbObjectId(), arbContent()).map(([path, oid, content]) => ({
    path,
    mode: '100755' as ArchiveEntry['mode'],
    oid,
    content,
  }));
}

export function arbSymlinkEntry(): fc.Arbitrary<ArchiveEntry> {
  // Symlink targets are file-system paths — null bytes are invalid in paths on
  // all supported platforms, so we exclude them to keep the oracle's null-terminated
  // linkname read unambiguous.
  const arbLinkTarget = fc
    .array(fc.integer({ min: 1, max: 255 }), { minLength: 1, maxLength: 64 })
    .map((bytes) => new Uint8Array(bytes));
  return fc.tuple(arbFilePath(), arbObjectId(), arbLinkTarget).map(([path, oid, content]) => ({
    path,
    mode: '120000' as ArchiveEntry['mode'],
    oid,
    content,
  }));
}

export function arbDirEntry(): fc.Arbitrary<ArchiveEntry> {
  return fc
    .tuple(arbFilePath(), arbObjectId())
    .map(([path, oid]) => ({ path, mode: '40000' as ArchiveEntry['mode'], oid }));
}

export function arbGitlinkEntry(): fc.Arbitrary<ArchiveEntry> {
  return fc
    .tuple(arbFilePath(), arbObjectId())
    .map(([path, oid]) => ({ path, mode: '160000' as ArchiveEntry['mode'], oid }));
}

/** Any single ArchiveEntry. */
export function arbArchiveEntry(): fc.Arbitrary<ArchiveEntry> {
  return fc.oneof(
    arbRegularEntry(),
    arbExecEntry(),
    arbSymlinkEntry(),
    arbDirEntry(),
    arbGitlinkEntry(),
  );
}

// ---------------------------------------------------------------------------
// ArchiveResult arbitrary
// ---------------------------------------------------------------------------

/**
 * Builds an ArchiveResult with 0–4 flat entries and an optional commit.
 *
 * All entry paths are forced to be unique within the generated set to
 * avoid duplicate-path collisions in the round-trip oracle.
 */
export function arbArchiveResult(): fc.Arbitrary<{
  entries: ArchiveEntry[];
  result: ArchiveResult;
  commitOid: string | undefined;
  commitTime: number | undefined;
}> {
  const arbEntries = fc.array(arbArchiveEntry(), { minLength: 0, maxLength: 4 }).map((entries) => {
    // De-duplicate by path so the oracle sees each path only once
    const seen = new Set<string>();
    return entries.filter((e) => {
      if (seen.has(e.path)) return false;
      seen.add(e.path);
      return true;
    });
  });

  const arbCommit = fc.option(arbObjectId(), { nil: undefined });
  const arbTime = fc.integer({ min: 0, max: 2_000_000_000 });

  return fc.tuple(arbEntries, arbCommit, arbTime).map(([entries, commit, time]) => {
    const commitOid = commit !== undefined ? String(commit) : undefined;
    const commitTime = commit !== undefined ? time : undefined;

    const base = {
      tree: 'aaaa000000000000000000000000000000000001' as unknown as ObjectId,
      entries: (async function* () {
        for (const e of entries) yield e;
      })(),
    };
    const result: ArchiveResult = {
      ...base,
      ...(commit !== undefined ? { commit } : {}),
      ...(commitTime !== undefined ? { commitTime } : {}),
    };

    return { entries, result, commitOid, commitTime };
  });
}
