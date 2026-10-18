import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { computeChangeset } from '../../../../src/application/primitives/compute-changeset.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { compareEntryPath, STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';

const OIDS = ['a', 'b'].map((c) => c.repeat(40) as ObjectId);

const pathArb = fc
  .array(fc.constantFrom('a', 'b', '/', '-', '', '�', '\u{1F600}', '\u{10FFFF}'), {
    minLength: 1,
    maxLength: 5,
  })
  .map((chars) => chars.join('') as FilePath);

const sideArb = fc.uniqueArray(fc.tuple(pathArb, fc.constantFrom(...OIDS)), {
  selector: ([path]) => path,
  maxLength: 8,
});

const entryOf = ([path, id]: readonly [FilePath, ObjectId]): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path,
});

const indexOf = (entries: IndexEntry[]): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

describe('computeChangeset properties', () => {
  describe('Given arbitrary index and target sides', () => {
    describe('When computeChangeset runs', () => {
      it('Then entries are in git byte order and cover the union of paths exactly once', () => {
        fc.assert(
          fc.property(sideArb, sideArb, (indexSide, targetSide) => {
            // Arrange
            const index = indexOf(indexSide.map(entryOf));
            const target = targetSide.map(([path, id]) => ({ path, id, mode: FILE_MODE.REGULAR }));

            // Act
            const result = computeChangeset(index, target);

            // Assert
            const union = new Set([...indexSide, ...targetSide].map(([path]) => path));
            const emitted = result.entries.map((e) => e.path);
            expect(new Set(emitted).size).toBe(emitted.length);
            expect(new Set(emitted)).toEqual(union);
            const sorted = [...emitted].sort((a, b) => compareEntryPath({ path: a }, { path: b }));
            expect(emitted).toEqual(sorted);
          }),
        );
      });
    });
  });
});
