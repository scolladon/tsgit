import { describe, expect, it } from 'vitest';
import type { Blob, Commit, ObjectId, Tag, Tree } from '../../../../src/domain/objects/index.js';
import { peelOneLevel } from '../../../../src/domain/refs/peel.js';

const SHA1 = '0'.repeat(40) as ReturnType<typeof ObjectId.from>;
const SHA2 = 'a'.repeat(40) as ReturnType<typeof ObjectId.from>;
const SHA3 = 'b'.repeat(40) as ReturnType<typeof ObjectId.from>;

describe('peelOneLevel', () => {
  describe('Given a Tag object', () => {
    describe('When peeling', () => {
      it('Then returns { type: tag.data.objectType, id: tag.data.object }', () => {
        // Arrange
        const tag: Tag = {
          type: 'tag',
          id: SHA1,
          data: {
            object: SHA2,
            objectType: 'commit',
            tagName: 'v1.0',
            message: '',
            extraHeaders: [],
          },
        };

        // Act
        const sut = peelOneLevel(tag);

        // Assert
        expect(sut).toEqual({ type: 'commit', id: SHA2 });
      });
    });
  });

  describe('Given a Commit object', () => {
    describe('When peeling', () => {
      it('Then returns { type: tree, id: commit.data.tree }', () => {
        // Arrange
        const commit: Commit = {
          type: 'commit',
          id: SHA1,
          data: {
            tree: SHA3,
            parents: [],
            author: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
            committer: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
            message: '',
            extraHeaders: [],
          },
        };

        // Act
        const sut = peelOneLevel(commit);

        // Assert
        expect(sut).toEqual({ type: 'tree', id: SHA3 });
      });
    });
  });

  describe('Given a Blob object', () => {
    describe('When peeling', () => {
      it('Then returns undefined', () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          id: SHA1,
          content: new Uint8Array(0),
        };

        // Act
        const sut = peelOneLevel(blob);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a Tree object', () => {
    describe('When peeling', () => {
      it('Then returns undefined', () => {
        // Arrange
        const tree: Tree = {
          type: 'tree',
          id: SHA1,
          entries: [],
        };

        // Act
        const sut = peelOneLevel(tree);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });
});
