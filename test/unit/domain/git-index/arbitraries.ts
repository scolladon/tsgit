import fc from 'fast-check';
import type {
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
    extended: fc.constant(false as boolean),
    stage: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
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
