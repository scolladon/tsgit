import { describe, expect, it } from 'vitest';
import type { AddChange } from '../../../../src/domain/diff/diff-change.js';
import type {
  RankedCandidate,
  RenameSource,
  SourceOrigin,
} from '../../../../src/domain/diff/rename-pairing.js';
import {
  compareCandidates,
  pairIdenticalFiles,
} from '../../../../src/domain/diff/rename-pairing.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const ID_A = 'a'.repeat(40) as ObjectId;

function renameSource(
  path: string,
  id: ObjectId,
  options: {
    readonly origin?: SourceOrigin;
    readonly seedUses?: 0 | 1;
    readonly mode?: FileMode;
  } = {},
): RenameSource {
  return {
    path: path as FilePath,
    id,
    mode: options.mode ?? FILE_MODE.REGULAR,
    origin: options.origin ?? 'deleted',
    seedUses: options.seedUses ?? 0,
  };
}

function addChange(path: string, id: ObjectId, mode: FileMode = FILE_MODE.REGULAR): AddChange {
  return { type: 'add', newPath: path as FilePath, newId: id, newMode: mode };
}

// Retained (-C preimage) sources already spent their seed use — none share a
// basename with any destination in these tests.
function usedSources(count: number, id: ObjectId): RenameSource[] {
  return Array.from({ length: count }, (_, i) =>
    renameSource(`used/${i}.meta`, id, { origin: 'modified', seedUses: 1 }),
  );
}

const sut = pairIdenticalFiles;

describe('pairIdenticalFiles', () => {
  describe('Given 101 already-used same-key sources ahead of one fresh source', () => {
    describe('When paired in rename mode', () => {
      it('Then the fresh source still pairs — used sources never count toward the cap', () => {
        // Arrange
        const sources = [...usedSources(101, ID_A), renameSource('fresh.meta', ID_A)];
        const destination = addChange('dest.meta', ID_A);

        // Act
        const result = sut(sources, [destination], 'rename');

        // Assert
        expect(result.pairs).toEqual([{ source: 101, destination, score: MAX_SCORE }]);
        expect(result.unpaired).toEqual([]);
        expect(result.uses[101]).toBe(1);
      });
    });
  });

  describe('Given one identical source and two identical destinations', () => {
    describe('When paired in copy mode', () => {
      it('Then both destinations pair with the sole source, whose uses becomes 2', () => {
        // Arrange
        const sources = [renameSource('a/Foo.meta', ID_A)];
        const destinations = [addChange('b/Bar.meta', ID_A), addChange('b/Baz.meta', ID_A)];

        // Act
        const result = sut(sources, destinations, 'copy');

        // Assert
        expect(result.pairs).toEqual([
          { source: 0, destination: destinations[0], score: MAX_SCORE },
          { source: 0, destination: destinations[1], score: MAX_SCORE },
        ]);
        expect(result.unpaired).toEqual([]);
        expect(result.uses).toEqual([2]);
      });
    });
  });

  describe('Given one identical source and three identical destinations', () => {
    describe('When paired in copy mode', () => {
      it('Then all three destinations pair with the sole source, whose uses becomes 3', () => {
        // Arrange
        const sources = [renameSource('a/Foo.meta', ID_A)];
        const destinations = [
          addChange('b/A.meta', ID_A),
          addChange('b/B.meta', ID_A),
          addChange('b/C.meta', ID_A),
        ];

        // Act
        const result = sut(sources, destinations, 'copy');

        // Assert
        expect(result.pairs.map((pair) => pair.source)).toEqual([0, 0, 0]);
        expect(result.uses).toEqual([3]);
      });
    });
  });

  describe('Given two identical sources and three destinations with no basename overlap', () => {
    describe('When paired in copy mode', () => {
      it('Then an unused source beats a used one, and ties fall back to the first source examined', () => {
        // Arrange — A pairs Foo (both unused, first wins); B then prefers unused Qux over used Foo;
        // C ties Foo (used) and Qux (used), Foo wins as the one examined first
        const sources = [renameSource('a/Foo.meta', ID_A), renameSource('a/Qux.meta', ID_A)];
        const destinations = [
          addChange('b/A.meta', ID_A),
          addChange('b/B.meta', ID_A),
          addChange('b/C.meta', ID_A),
        ];

        // Act
        const result = sut(sources, destinations, 'copy');

        // Assert
        expect(result.pairs.map((pair) => pair.source)).toEqual([0, 1, 0]);
        expect(result.uses).toEqual([2, 1]);
      });
    });
  });

  describe('Given a retained modified source that basename-matches ahead of an unused deleted source that does not', () => {
    describe('When paired in copy mode', () => {
      it('Then the used, basename-matching source wins the tie by being examined first', () => {
        // Arrange — a/Bar (modified, seedUses 1) precedes z/Aaa (deleted, seedUses 0); both score 1
        const sources = [
          renameSource('a/Bar.meta', ID_A, { origin: 'modified', seedUses: 1 }),
          renameSource('z/Aaa.meta', ID_A, { origin: 'deleted', seedUses: 0 }),
        ];
        const destination = addChange('c/Bar.meta', ID_A);

        // Act
        const result = sut(sources, [destination], 'copy');

        // Assert
        expect(result.pairs).toEqual([{ source: 0, destination, score: MAX_SCORE }]);
        expect(result.uses).toEqual([2, 0]);
      });
    });
  });

  describe('Given the same tie with an unchanged retained source instead of a modified one', () => {
    describe('When paired in copy mode', () => {
      it('Then the outcome is identical — origin does not affect scoring', () => {
        // Arrange
        const sources = [
          renameSource('a/Bar.meta', ID_A, { origin: 'unchanged', seedUses: 1 }),
          renameSource('z/Aaa.meta', ID_A, { origin: 'deleted', seedUses: 0 }),
        ];
        const destination = addChange('c/Bar.meta', ID_A);

        // Act
        const result = sut(sources, [destination], 'copy');

        // Assert
        expect(result.pairs).toEqual([{ source: 0, destination, score: MAX_SCORE }]);
        expect(result.uses).toEqual([2, 0]);
      });
    });
  });

  describe('Given 100 used same-key sources ahead of one unused basename-matching source', () => {
    describe('When paired in copy mode', () => {
      it('Then the cap hides the basename match — the destination pairs with the first used source', () => {
        // Arrange — the 100 used sources never share a basename with the destination
        const sources = [
          ...usedSources(100, ID_A),
          renameSource('a/dest.meta', ID_A, { origin: 'deleted', seedUses: 0 }),
        ];
        const destination = addChange('b/dest.meta', ID_A);

        // Act
        const result = sut(sources, [destination], 'copy');

        // Assert
        expect(result.pairs).toEqual([{ source: 0, destination, score: MAX_SCORE }]);
        expect(result.uses[100]).toBe(0);
      });
    });
  });
});

function candidate(score: number, nameScore: 0 | 1): RankedCandidate {
  return { score, nameScore };
}

describe('compareCandidates', () => {
  describe('Given two candidates with different scores', () => {
    describe('When compareCandidates is called', () => {
      it('Then the higher-scoring candidate ranks first regardless of nameScore', () => {
        // Arrange
        const higher = candidate(90, 0);
        const lower = candidate(10, 1);

        // Act
        const result = compareCandidates(higher, lower);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two candidates tied on score but not on nameScore', () => {
    describe('When compareCandidates is called with the basename-matching candidate first', () => {
      it('Then the basename-matching candidate ranks first', () => {
        // Arrange
        const matching = candidate(50, 1);
        const nonMatching = candidate(50, 0);

        // Act
        const result = compareCandidates(matching, nonMatching);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });

    describe('When compareCandidates is called with the basename-matching candidate second', () => {
      it('Then the basename-matching candidate still ranks first', () => {
        // Arrange
        const matching = candidate(50, 1);
        const nonMatching = candidate(50, 0);

        // Act
        const result = compareCandidates(nonMatching, matching);

        // Assert
        expect(result).toBeGreaterThan(0);
      });
    });
  });

  describe('Given two candidates tied on both score and nameScore', () => {
    describe('When compareCandidates is called', () => {
      it('Then neither ranks ahead of the other', () => {
        // Arrange
        const a = candidate(50, 1);
        const b = candidate(50, 1);

        // Act
        const result = compareCandidates(a, b);

        // Assert
        expect(result).toBe(0);
      });
    });
  });
});
