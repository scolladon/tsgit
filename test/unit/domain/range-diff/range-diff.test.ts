import { describe, expect, it } from 'vitest';
import { FILE_MODE, type FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { CommitPatchInput } from '../../../../src/domain/range-diff/index.js';
import { rangeDiffEntries } from '../../../../src/domain/range-diff/index.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;
const path = (p: string): FilePath => p as FilePath;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const addFile = (id: string, name: string, content: string, message: string): CommitPatchInput => ({
  id: oid(id),
  authorName: 'A',
  authorEmail: 'a@x',
  subject: message,
  message: `${message}\n`,
  files: [
    {
      change: { type: 'add', newPath: path(name), newId: oid('f'), newMode: FILE_MODE.REGULAR },
      newContent: bytes(content),
    },
  ],
});

describe('rangeDiffEntries', () => {
  describe('Given two single-commit series that add the same content under different messages, When run', () => {
    it('Then the commit is matched and reported as changed', () => {
      // Arrange
      const sut = rangeDiffEntries;
      const old = [addFile('1', 'f.txt', 'hello\n', 'old message')];
      const next = [addFile('2', 'f.txt', 'hello\n', 'new message')];

      // Act
      const result = sut(old, next, 60);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe('changed');
      expect(result[0]?.old?.position).toBe(1);
      expect(result[0]?.new?.position).toBe(1);
    });
  });

  describe('Given series that add unrelated files, When run', () => {
    it('Then the old commit is a deletion and the new commit a creation', () => {
      // Arrange
      const sut = rangeDiffEntries;
      const old = [addFile('1', 'a.txt', 'aaa\n', 'add a')];
      const next = [addFile('2', 'b.txt', 'bbb\n', 'add b')];

      // Act
      const result = sut(old, next, 60);

      // Assert
      expect(result.map((entry) => entry.status)).toEqual(['only-old', 'only-new']);
    });
  });

  describe('Given two empty series, When run', () => {
    it('Then there are no entries', () => {
      // Arrange
      const sut = rangeDiffEntries;

      // Act
      const result = sut([], [], 60);

      // Assert
      expect(result).toEqual([]);
    });
  });
});
