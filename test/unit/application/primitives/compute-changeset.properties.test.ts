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

  describe('Given arbitrary index and target sides, shuffled or not', () => {
    describe('When computeChangeset runs', () => {
      it('Then entries and stats equal a Map-union reference', () => {
        fc.assert(
          fc.property(sideArb, sideArb, fc.boolean(), (indexSide, targetSide, reversed) => {
            // Arrange
            const indexEntries = indexSide.map(entryOf);
            const targetEntries = targetSide.map(([path, id]) => ({
              path,
              id,
              mode: FILE_MODE.REGULAR,
            }));
            const target = reversed ? [...targetEntries].reverse() : targetEntries;
            const reference = [...new Set([...indexSide, ...targetSide].map(([p]) => p))]
              .sort((a, b) => compareEntryPath({ path: a }, { path: b }))
              .map((path) => {
                const before = indexEntries.find((e) => e.path === path);
                const after = targetEntries.find((e) => e.path === path);
                if (before === undefined) return 'add';
                if (after === undefined) return 'delete';
                return before.id === after.id ? 'noop' : 'update';
              });

            // Act
            const result = computeChangeset(indexOf(indexEntries), target);

            // Assert
            expect(result.entries.map((e) => e.kind)).toEqual(reference);
            for (const kind of ['add', 'update', 'delete', 'noop'] as const) {
              expect(result.stats[kind]).toBe(reference.filter((k) => k === kind).length);
            }
          }),
        );
      });
    });
  });
});
