import fc from 'fast-check';
import type {
  GitIndex,
  IndexEntry,
  IndexEntryFlags,
  StatData,
} from '../../../../src/domain/git-index/index-entry.js';
import type { FileMode } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, FilePath } from '../../../../src/domain/objects/index.js';
import { arbObjectId } from '../objects/arbitraries.js';

const MODES: ReadonlyArray<FileMode> = [
  FILE_MODE.REGULAR,
  FILE_MODE.EXECUTABLE,
  FILE_MODE.SYMLINK,
  FILE_MODE.DIRECTORY,
  FILE_MODE.GITLINK,
];

export function arbFileMode(): fc.Arbitrary<FileMode> {
  return fc.constantFrom(...MODES);
}

export function arbFlags(): fc.Arbitrary<IndexEntryFlags> {
  return fc.record({
    assumeValid: fc.boolean(),
    stage: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
    skipWorktree: fc.boolean(),
    intentToAdd: fc.boolean(),
  });
}

export function arbStatData(): fc.Arbitrary<StatData> {
  return fc.record({
    ctimeSeconds: fc.nat({ max: 0xffffffff }),
    ctimeNanoseconds: fc.nat({ max: 999999999 }),
    mtimeSeconds: fc.nat({ max: 0xffffffff }),
    mtimeNanoseconds: fc.nat({ max: 999999999 }),
    dev: fc.nat({ max: 0xffffffff }),
    ino: fc.nat({ max: 0xffffffff }),
    mode: arbFileMode(),
    uid: fc.nat({ max: 0xffffffff }),
    gid: fc.nat({ max: 0xffffffff }),
    fileSize: fc.nat({ max: 0xffffffff }),
  });
}

const PATH_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split('');

// `parseIndex` rejects paths equal to `.` or `..` (and other
// unsafe forms). The generator filters those out so round-trip tests
// exercise only paths the parser will accept.
const UNSAFE_PATHS: ReadonlySet<string> = new Set(['.', '..']);

export function arbFilePath(): fc.Arbitrary<ReturnType<typeof FilePath.from>> {
  return fc
    .array(fc.constantFrom(...PATH_CHARS), { minLength: 1, maxLength: 30 })
    .map((chars: ReadonlyArray<string>) => chars.join(''))
    .filter((s: string) => !UNSAFE_PATHS.has(s))
    .map((s: string) => FilePath.from(s));
}

export function arbIndexEntry(): fc.Arbitrary<IndexEntry> {
  return fc
    .tuple(arbStatData(), arbObjectId(), arbFlags(), arbFilePath())
    .map(([stat, id, flags, path]) => ({
      ...stat,
      id,
      flags,
      path,
    }));
}

// v2 round-trip uses the minimal-version writer: any extended-flag entry
// would force a v3 on-disk encoding regardless of `index.version`. The v2
// arbitrary forces both extended-flag bits to false so the writer/parser
// pair stays in the v2 grammar.
function arbFlagsV2Compatible(): fc.Arbitrary<IndexEntryFlags> {
  return fc.record({
    assumeValid: fc.boolean(),
    stage: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
    skipWorktree: fc.constant(false),
    intentToAdd: fc.constant(false),
  });
}

export function arbIndexEntryV2(): fc.Arbitrary<IndexEntry> {
  return fc
    .tuple(arbStatData(), arbObjectId(), arbFlagsV2Compatible(), arbFilePath())
    .map(([stat, id, flags, path]) => ({
      ...stat,
      id,
      flags,
      path,
    }));
}

// v3 round-trip requires at least one entry whose `skipWorktree` or
// `intentToAdd` flag is set; otherwise the writer falls back to v2. The
// arbitrary returns a flags record where at least one extended bit is
// guaranteed true.
function arbFlagsV3Required(): fc.Arbitrary<IndexEntryFlags> {
  const arbExtendedPair = fc
    .tuple(fc.boolean(), fc.boolean())
    .map(([skip, ita]) =>
      skip || ita
        ? { skipWorktree: skip, intentToAdd: ita }
        : { skipWorktree: true, intentToAdd: false },
    );
  return fc
    .tuple(
      fc.boolean(),
      fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
      arbExtendedPair,
    )
    .map(([assumeValid, stage, ext]) => ({
      assumeValid,
      stage,
      skipWorktree: ext.skipWorktree,
      intentToAdd: ext.intentToAdd,
    }));
}

export function arbIndexEntryV3Extended(): fc.Arbitrary<IndexEntry> {
  return fc
    .tuple(arbStatData(), arbObjectId(), arbFlagsV3Required(), arbFilePath())
    .map(([stat, id, flags, path]) => ({
      ...stat,
      id,
      flags,
      path,
    }));
}

// `parseIndex` keys entries by path; duplicates would round-trip but the
// equality assertion is path-sorted, so multiple entries sharing a path
// would compare in an unspecified order. Dedupe by path keeps the property
// deterministic.
function dedupeByPath(entries: ReadonlyArray<IndexEntry>): ReadonlyArray<IndexEntry> {
  const seen = new Set<string>();
  const result: IndexEntry[] = [];
  for (const entry of entries) {
    const path = entry.path as string;
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(entry);
  }
  return result;
}

export function arbGitIndexV2(): fc.Arbitrary<GitIndex> {
  return fc
    .array(arbIndexEntryV2(), { minLength: 0, maxLength: 12 })
    .map(dedupeByPath)
    .map((entries) => ({
      version: 2 as const,
      entries,
      extensions: [] as ReadonlyArray<never>,
    }));
}

export function arbGitIndexV3(): fc.Arbitrary<GitIndex> {
  // A v3 index must contain at least one extended-flag entry; mix one
  // guaranteed-extended entry with up to 11 v2-compatible peers.
  return fc
    .tuple(arbIndexEntryV3Extended(), fc.array(arbIndexEntryV2(), { minLength: 0, maxLength: 11 }))
    .map(([head, rest]) => dedupeByPath([head, ...rest]))
    .map((entries) => ({
      version: 3 as const,
      entries,
      extensions: [] as ReadonlyArray<never>,
    }));
}
