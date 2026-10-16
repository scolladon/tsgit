import { describe, expect, it } from 'vitest';
import type { FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import type { PathEntries } from '../../../../src/domain/merge/file-directory.js';
import { directoryBlockers } from '../../../../src/domain/merge/file-directory.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const BASE = entry('a'.repeat(40) as ObjectId);
const CHANGED = entry('b'.repeat(40) as ObjectId);
const NESTED = 'p/q/x' as FilePath;

function entry(id: ObjectId): FlatTreeEntry {
  return { id, mode: FILE_MODE.REGULAR };
}

function blockersOf(entries: PathEntries) {
  return directoryBlockers([[NESTED, entries]]);
}

describe('directoryBlockers', () => {
  describe('Given a nested path both sides hold, as a rename carries it', () => {
    describe('When directoryBlockers is called', () => {
      it('Then each ancestor blocks a file on both sides', () => {
        // Arrange
        const sut = blockersOf;

        // Act
        const result = sut([BASE, BASE, CHANGED]);

        // Assert
        expect(result).toEqual({ our: new Set(['p', 'p/q']), their: new Set(['p', 'p/q']) });
      });
    });
  });

  describe.each([
    { side: 'ours', entries: [BASE, CHANGED, undefined] as PathEntries },
    { side: 'theirs', entries: [BASE, undefined, CHANGED] as PathEntries },
    { side: 'ours as an add', entries: [undefined, CHANGED, undefined] as PathEntries },
    { side: 'theirs as an add', entries: [undefined, undefined, CHANGED] as PathEntries },
  ])('Given a nested path only $side holds, changed from base', ({ entries }) => {
    describe('When directoryBlockers is called', () => {
      it('Then each ancestor blocks a file on both sides', () => {
        // Arrange
        const sut = blockersOf;

        // Act
        const result = sut(entries);

        // Assert
        expect(result).toEqual({ our: new Set(['p', 'p/q']), their: new Set(['p', 'p/q']) });
      });
    });
  });

  describe.each([
    { label: 'only ours holds unchanged', entries: [BASE, BASE, undefined] as PathEntries },
    { label: 'only theirs holds unchanged', entries: [BASE, undefined, BASE] as PathEntries },
    { label: 'both sides deleted', entries: [BASE, undefined, undefined] as PathEntries },
  ])('Given a nested path $label', ({ entries }) => {
    describe('When directoryBlockers is called', () => {
      it('Then no directory blocks a file', () => {
        // Arrange
        const sut = blockersOf;

        // Act
        const result = sut(entries);

        // Assert
        expect(result).toEqual({ our: new Set(), their: new Set() });
      });
    });
  });
});
