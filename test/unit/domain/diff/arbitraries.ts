import fc from 'fast-check';
import type { FileMode, ObjectId, Tree, TreeEntry } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { arbObjectId } from '../objects/arbitraries.js';

const NON_DIR_MODES: ReadonlyArray<FileMode> = [
  FILE_MODE.REGULAR,
  FILE_MODE.EXECUTABLE,
  FILE_MODE.SYMLINK,
  FILE_MODE.GITLINK,
];

export function arbNonDirMode(): fc.Arbitrary<FileMode> {
  return fc.constantFrom(...NON_DIR_MODES);
}

export function arbEntryName(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0x61, max: 0x7a }), { minLength: 1, maxLength: 8 })
    .map((codes) => String.fromCharCode(...codes));
}

export function arbTreeEntry(): fc.Arbitrary<TreeEntry> {
  return fc.record({
    name: arbEntryName(),
    mode: arbNonDirMode(),
    id: arbObjectId(),
  });
}

export function arbTree(): fc.Arbitrary<Tree> {
  return fc.array(arbTreeEntry(), { minLength: 0, maxLength: 12 }).map((rawEntries) => {
    const byName = new Map<string, TreeEntry>();
    for (const entry of rawEntries) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
    return {
      type: 'tree' as const,
      id: '0'.repeat(40) as ObjectId,
      entries: Array.from(byName.values()),
    };
  });
}
