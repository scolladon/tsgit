import { describe, expect, it } from 'vitest';

import type { DiffChange, PatchFile } from '../../../../src/domain/diff/index.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import {
  buildStatEntries,
  renderDiffStat,
  renderNumstat,
  type StatEntry,
} from '../../../../src/domain/show/diff-stat.js';

const REGULAR = '100644' as FileMode;
const OID = 'ae7617af6291aabc261ad7f1f06d54044b943043' as ObjectId;
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
// Binary content: a NUL byte makes `isBinary` flag the file.
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const entry = (over: Partial<StatEntry> & { path: string }): StatEntry => ({
  added: 0,
  deleted: 0,
  binary: false,
  oldSize: 0,
  newSize: 0,
  ...over,
});

describe('Given renderNumstat', () => {
  describe('When entries mix text and binary', () => {
    it('Then text rows are tab-separated counts and binary rows are dashes', () => {
      // Arrange
      const entries = [
        entry({ path: 'a.txt', added: 2, deleted: 1 }),
        entry({ path: 'bin', binary: true }),
      ];

      // Act + Assert
      expect(renderNumstat(entries)).toBe('2\t1\ta.txt\n-\t-\tbin\n');
    });
  });
});

describe('Given renderDiffStat', () => {
  describe('When changes fit within the graph width', () => {
    it('Then names align, counts right-justify, and the graph is 1:1', () => {
      // Arrange
      const entries = [
        entry({ path: 'a.txt', added: 1, deleted: 1 }),
        entry({ path: 'big.txt', added: 30, deleted: 30 }),
        entry({ path: 'new.txt', added: 1, deleted: 0 }),
      ];

      // Act + Assert — matches `git show --stat` for the same change set.
      expect(renderDiffStat(entries)).toBe(
        ' a.txt   |  2 +-\n' +
          ` big.txt | 60 ${'+'.repeat(30)}${'-'.repeat(30)}\n` +
          ' new.txt |  1 +\n' +
          ' 3 files changed, 32 insertions(+), 31 deletions(-)\n',
      );
    });
  });

  describe('When the busiest file exceeds the graph width', () => {
    it('Then the graph scales with git scale_linear while the count stays the total', () => {
      // Arrange — 200/200 over an 80-column budget scales to 31/31. The
      // delete-only file feeds 0 added into scale_linear (the zero short-circuit).
      const entries = [
        entry({ path: 'big.txt', added: 200, deleted: 200 }),
        entry({ path: 'small.txt', added: 1, deleted: 1 }),
        entry({ path: 'del.txt', added: 0, deleted: 8 }),
      ];

      // Act
      const sut = renderDiffStat(entries);

      // Assert
      expect(sut).toContain(` big.txt   | 400 ${'+'.repeat(31)}${'-'.repeat(31)}\n`);
      expect(sut).toContain(' small.txt |   2 +-\n');
      // 0 added → no `+`; the scaled deletions are all `-`.
      expect(sut).toMatch(/ del\.txt {3}\| {3}8 -+\n/);
    });
  });

  describe('When a file is binary', () => {
    it('Then it renders Bin <old> -> <new> bytes and is excluded from counts', () => {
      // Arrange
      const entries = [entry({ path: 'bin.bin', binary: true, oldSize: 8, newSize: 7 })];

      // Act + Assert
      expect(renderDiffStat(entries)).toBe(
        ' bin.bin | Bin 8 -> 7 bytes\n 1 file changed, 0 insertions(+), 0 deletions(-)\n',
      );
    });
  });

  describe('When a file has zero changes (a pure rename)', () => {
    it('Then the count has no trailing space before the empty graph', () => {
      // Arrange + Act
      const sut = renderDiffStat([entry({ path: 'a.txt => renamed.txt', added: 0, deleted: 0 })]);

      // Assert
      expect(sut).toBe(
        ' a.txt => renamed.txt | 0\n 1 file changed, 0 insertions(+), 0 deletions(-)\n',
      );
    });
  });

  describe('When only insertions occur', () => {
    it('Then the deletions clause is dropped', () => {
      // Arrange + Act
      const sut = renderDiffStat([entry({ path: 'a', added: 3, deleted: 0 })]);

      // Assert
      expect(sut.endsWith(' 1 file changed, 3 insertions(+)\n')).toBe(true);
    });
  });

  describe('When only deletions occur', () => {
    it('Then the insertions clause is dropped', () => {
      // Arrange + Act
      const sut = renderDiffStat([entry({ path: 'a', added: 0, deleted: 1 })]);

      // Assert
      expect(sut.endsWith(' 1 file changed, 1 deletion(-)\n')).toBe(true);
    });
  });
});

describe('Given a path with a control character', () => {
  describe('When stat or numstat renders it', () => {
    it('Then both reject it (forged-line guard)', () => {
      // Arrange
      const evil = [entry({ path: 'a\ndiff --git forged', added: 1, deleted: 0 })];

      // Act + Assert
      expect(() => renderDiffStat(evil)).toThrow();
      expect(() => renderNumstat(evil)).toThrow();
    });
  });
});

describe('Given buildStatEntries', () => {
  describe('When a file is modified, added, renamed, or binary', () => {
    it('Then counts, paths, and binary flags resolve from the content', () => {
      // Arrange
      const modify: DiffChange = {
        type: 'modify',
        path: 'a.txt' as FilePath,
        oldId: OID,
        newId: OID,
        oldMode: REGULAR,
        newMode: REGULAR,
      };
      const rename: DiffChange = {
        type: 'rename',
        oldPath: 'old.txt' as FilePath,
        newPath: 'new.txt' as FilePath,
        id: OID,
        mode: REGULAR,
      };
      const add: DiffChange = {
        type: 'add',
        newPath: 'added.txt' as FilePath,
        newId: OID,
        newMode: REGULAR,
      };
      const remove: DiffChange = {
        type: 'delete',
        oldPath: 'gone.txt' as FilePath,
        oldId: OID,
        oldMode: REGULAR,
      };
      const binary: DiffChange = {
        type: 'modify',
        path: 'bin.bin' as FilePath,
        oldId: OID,
        newId: OID,
        oldMode: REGULAR,
        newMode: REGULAR,
      };
      const files: ReadonlyArray<PatchFile> = [
        { change: modify, oldContent: text('a\nb\n'), newContent: text('A\nb\n') },
        { change: rename, oldContent: text('x\n'), newContent: text('x\n') },
        { change: add, newContent: text('one\ntwo\n') },
        { change: remove, oldContent: text('bye\n') },
        { change: binary, oldContent: bytes(0, 1, 2, 3), newContent: bytes(4, 5, 6) },
      ];

      // Act
      const sut = buildStatEntries(files);

      // Assert
      expect(sut[0]).toMatchObject({ path: 'a.txt', added: 1, deleted: 1, binary: false });
      expect(sut[1]).toMatchObject({ path: 'old.txt => new.txt', added: 0, deleted: 0 });
      expect(sut[2]).toMatchObject({ path: 'added.txt', added: 2, deleted: 0 });
      expect(sut[3]).toMatchObject({ path: 'gone.txt', added: 0, deleted: 1 });
      expect(sut[4]).toMatchObject({ path: 'bin.bin', binary: true, oldSize: 4, newSize: 3 });
    });
  });
});
