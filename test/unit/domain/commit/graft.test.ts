import { describe, expect, it } from 'vitest';
import {
  applyGraft,
  applyGraftToData,
  graftedParents,
} from '../../../../src/domain/commit/graft.js';
import type { AuthorIdentity, Commit, ObjectId } from '../../../../src/domain/objects/index.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

const makeCommit = (id: string, parents: ReadonlyArray<string>): Commit => ({
  type: 'commit',
  id: id as ObjectId,
  data: {
    tree: 'a'.repeat(40) as ObjectId,
    parents: parents.map((p) => p as ObjectId),
    author: AUTHOR,
    committer: AUTHOR,
    message: 'msg',
    gpgSignature: '-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----',
    extraHeaders: [{ key: 'mergetag', value: 'object abc' }],
  },
});

describe('applyGraft', () => {
  describe('Given an empty shallow set', () => {
    describe('When applyGraft runs', () => {
      it('Then returns the identical commit reference', () => {
        // Arrange
        const sut = applyGraft;
        const commit = makeCommit('c'.repeat(40), ['p'.repeat(40)]);

        // Act
        const result = sut(commit, new Set());

        // Assert
        expect(result).toBe(commit);
      });
    });
  });

  describe('Given a non-empty shallow set that does not contain the commit', () => {
    describe('When applyGraft runs', () => {
      it('Then returns the identical commit reference', () => {
        // Arrange
        const sut = applyGraft;
        const commit = makeCommit('c'.repeat(40), ['p'.repeat(40)]);
        const shallow = new Set<ObjectId>(['d'.repeat(40) as ObjectId]);

        // Act
        const result = sut(commit, shallow);

        // Assert
        expect(result).toBe(commit);
      });
    });
  });

  describe('Given a shallow set containing the commit', () => {
    describe('When applyGraft runs', () => {
      it('Then parents become empty and every other field is preserved', () => {
        // Arrange
        const sut = applyGraft;
        const id = 'c'.repeat(40) as ObjectId;
        const commit = makeCommit(id, ['p'.repeat(40)]);
        const shallow = new Set<ObjectId>([id]);

        // Act
        const result = sut(commit, shallow);

        // Assert
        expect(result.data.parents).toEqual([]);
        expect(result.id).toBe(commit.id);
        expect(result.data.tree).toBe(commit.data.tree);
        expect(result.data.author).toBe(commit.data.author);
        expect(result.data.committer).toBe(commit.data.committer);
        expect(result.data.message).toBe(commit.data.message);
        expect(result.data.gpgSignature).toBe(commit.data.gpgSignature);
        expect(result.data.extraHeaders).toBe(commit.data.extraHeaders);
      });

      it('Then the input commit is not mutated', () => {
        // Arrange
        const sut = applyGraft;
        const id = 'c'.repeat(40) as ObjectId;
        const commit = makeCommit(id, ['p'.repeat(40)]);
        const originalParents = commit.data.parents;
        const shallow = new Set<ObjectId>([id]);

        // Act
        sut(commit, shallow);

        // Assert
        expect(commit.data.parents).toBe(originalParents);
        expect(commit.data.parents.length).toBe(1);
      });
    });
  });

  describe('Given a multi-parent (merge) boundary commit', () => {
    describe('When applyGraft runs', () => {
      it('Then all parents are dropped, not just the first', () => {
        // Arrange
        const sut = applyGraft;
        const id = 'c'.repeat(40) as ObjectId;
        const commit = makeCommit(id, ['p'.repeat(40), 'q'.repeat(40)]);
        const shallow = new Set<ObjectId>([id]);

        // Act
        const result = sut(commit, shallow);

        // Assert
        expect(result.data.parents).toEqual([]);
      });
    });
  });
});

describe('applyGraftToData', () => {
  describe('Given an empty shallow set', () => {
    describe('When applyGraftToData runs', () => {
      it('Then returns the identical data reference', () => {
        // Arrange
        const sut = applyGraftToData;
        const id = 'c'.repeat(40) as ObjectId;
        const data = makeCommit(id, ['p'.repeat(40)]).data;

        // Act
        const result = sut(id, data, new Set());

        // Assert
        expect(result).toBe(data);
      });
    });
  });

  describe('Given a non-empty shallow set that does not contain the id', () => {
    describe('When applyGraftToData runs', () => {
      it('Then returns the identical data reference', () => {
        // Arrange
        const sut = applyGraftToData;
        const id = 'c'.repeat(40) as ObjectId;
        const data = makeCommit(id, ['p'.repeat(40)]).data;
        const shallow = new Set<ObjectId>(['d'.repeat(40) as ObjectId]);

        // Act
        const result = sut(id, data, shallow);

        // Assert
        expect(result).toBe(data);
      });
    });
  });

  describe('Given a shallow set containing the id', () => {
    describe('When applyGraftToData runs', () => {
      it('Then parents become empty and every other field is preserved', () => {
        // Arrange
        const sut = applyGraftToData;
        const id = 'c'.repeat(40) as ObjectId;
        const data = makeCommit(id, ['p'.repeat(40)]).data;
        const shallow = new Set<ObjectId>([id]);

        // Act
        const result = sut(id, data, shallow);

        // Assert
        expect(result.parents).toEqual([]);
        expect(result.tree).toBe(data.tree);
        expect(result.author).toBe(data.author);
        expect(result.committer).toBe(data.committer);
        expect(result.message).toBe(data.message);
        expect(result.gpgSignature).toBe(data.gpgSignature);
        expect(result.extraHeaders).toBe(data.extraHeaders);
      });
    });
  });
});

describe('graftedParents', () => {
  describe('Given an empty shallow set', () => {
    describe('When graftedParents runs', () => {
      it('Then returns the input parents unchanged', () => {
        // Arrange
        const sut = graftedParents;
        const id = 'c'.repeat(40) as ObjectId;
        const parents = ['p'.repeat(40) as ObjectId];

        // Act
        const result = sut(id, parents, new Set());

        // Assert
        expect(result).toBe(parents);
      });
    });
  });

  describe('Given a non-empty shallow set not containing id', () => {
    describe('When graftedParents runs', () => {
      it('Then returns the input parents unchanged', () => {
        // Arrange
        const sut = graftedParents;
        const id = 'c'.repeat(40) as ObjectId;
        const parents = ['p'.repeat(40) as ObjectId];
        const shallow = new Set<ObjectId>(['d'.repeat(40) as ObjectId]);

        // Act
        const result = sut(id, parents, shallow);

        // Assert
        expect(result).toBe(parents);
      });
    });
  });

  describe('Given a shallow set containing id', () => {
    describe('When graftedParents runs', () => {
      it('Then returns an empty parents array', () => {
        // Arrange
        const sut = graftedParents;
        const id = 'c'.repeat(40) as ObjectId;
        const parents = ['p'.repeat(40) as ObjectId];
        const shallow = new Set<ObjectId>([id]);

        // Act
        const result = sut(id, parents, shallow);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});
