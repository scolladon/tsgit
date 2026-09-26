import { describe, expect, it } from 'vitest';
import type { AddChange } from '../../../../src/domain/diff/diff-change.js';
import type {
  MatrixCandidate,
  RankedCandidate,
  RenameSource,
  SourceOrigin,
  SourcePair,
} from '../../../../src/domain/diff/rename-pairing.js';
import {
  compareCandidates,
  labelRenameCopy,
  pairIdenticalFiles,
  selectPairs,
  uniqueBasenamePairs,
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

function pair(source: number, destination: AddChange, score: number = MAX_SCORE): SourcePair {
  return { source, destination, score };
}

describe('labelRenameCopy', () => {
  describe('Given one delete source used twice, both destinations produced by the exact pass', () => {
    describe('When labelRenameCopy is called', () => {
      it('Then the first destination in path order labels copy, the last labels rename', () => {
        // Arrange — b/Bar sorts before b/Baz; source used twice (uses[0] = 2)
        const bar = addChange('b/Bar.meta', ID_A);
        const baz = addChange('b/Baz.meta', ID_A);
        const pairs = [pair(0, bar), pair(0, baz)];

        // Act
        const result = labelRenameCopy(pairs, [2]);

        // Assert
        expect(result).toEqual([
          { pair: pairs[0], kind: 'copy' },
          { pair: pairs[1], kind: 'rename' },
        ]);
      });
    });
  });

  describe('Given one delete source used three times', () => {
    describe('When labelRenameCopy is called', () => {
      it('Then the first two destinations in path order label copy, the last labels rename', () => {
        // Arrange
        const a = addChange('b/A.meta', ID_A);
        const b = addChange('b/B.meta', ID_A);
        const c = addChange('b/C.meta', ID_A);
        const pairs = [pair(0, a), pair(0, b), pair(0, c)];

        // Act
        const result = labelRenameCopy(pairs, [3]);

        // Assert
        expect(result).toEqual([
          { pair: pairs[0], kind: 'copy' },
          { pair: pairs[1], kind: 'copy' },
          { pair: pairs[2], kind: 'rename' },
        ]);
      });
    });
  });

  describe('Given one delete source paired exactly to a later path and inexactly to an earlier one', () => {
    describe('When labelRenameCopy is called', () => {
      it('Then the rename lands on the last destination in path order regardless of which pass produced it', () => {
        // Arrange — pairs arrive in input order Zulu (exact) then Alpha (inexact); path
        // order is Alpha, Zulu — the rename must land on Zulu (last in path order).
        const alpha = addChange('p/Alpha.meta', ID_A);
        const zulu = addChange('p/Zulu.meta', ID_A);
        const pairs = [pair(0, zulu, MAX_SCORE), pair(0, alpha, MAX_SCORE - 1000)];

        // Act
        const result = labelRenameCopy(pairs, [2]);

        // Assert
        expect(result).toEqual([
          { pair: pairs[1], kind: 'copy' },
          { pair: pairs[0], kind: 'rename' },
        ]);
      });
    });
  });

  describe('Given a retained source (seedUses 1) used once by a pair', () => {
    describe('When labelRenameCopy is called', () => {
      it('Then the pair labels copy — a retained source never yields a rename', () => {
        // Arrange — the seed use is the preimage file itself, never in `pairs`, so the
        // one real pair can never take the counter to 0.
        const destination = addChange('c/Bar.meta', ID_A);
        const pairs = [pair(0, destination)];

        // Act
        const result = labelRenameCopy(pairs, [2]);

        // Assert
        expect(result).toEqual([{ pair: pairs[0], kind: 'copy' }]);
      });
    });
  });
});

function matrixCandidate(
  source: number,
  destination: AddChange,
  score: number,
  nameScore: 0 | 1 = 0,
): MatrixCandidate {
  return { source, destination, score, nameScore };
}

const sutSelectPairs = selectPairs;

describe('selectPairs', () => {
  describe('Given a used source scoring higher than an unused source for the same destination', () => {
    describe('When selectPairs runs pass 1 (copies off)', () => {
      it('Then the unused source pairs despite scoring lower — pass 1 never considers a used source', () => {
        // Arrange
        const destination = addChange('dst.meta', ID_A);
        const sorted = [matrixCandidate(0, destination, 90), matrixCandidate(1, destination, 40)];
        const uses = [1, 0];

        // Act
        const result = sutSelectPairs(sorted, uses, { copies: false, threshold: 0 });

        // Assert
        expect(result.pairs).toEqual([{ source: 1, destination, score: 40 }]);
        expect(result.uses).toEqual([1, 1]);
      });
    });
  });

  describe('Given every candidate source already used', () => {
    describe('When selectPairs runs with copies off', () => {
      it('Then the destination stays unpaired — pass 2 never runs without copies', () => {
        // Arrange
        const destination = addChange('dst.meta', ID_A);
        const sorted = [matrixCandidate(0, destination, 90)];
        const uses = [1];

        // Act
        const result = sutSelectPairs(sorted, uses, { copies: false, threshold: 0 });

        // Assert
        expect(result.pairs).toEqual([]);
        expect(result.uses).toEqual([1]);
      });
    });

    describe('When selectPairs runs with copies on', () => {
      it('Then pass 2 pairs the used source as a copy candidate', () => {
        // Arrange
        const destination = addChange('dst.meta', ID_A);
        const sorted = [matrixCandidate(0, destination, 90)];
        const uses = [1];

        // Act
        const result = sutSelectPairs(sorted, uses, { copies: true, threshold: 0 });

        // Assert
        expect(result.pairs).toEqual([{ source: 0, destination, score: 90 }]);
        expect(result.uses).toEqual([2]);
      });
    });
  });

  describe('Given a sorted candidate list with a below-threshold entry after an eligible one', () => {
    describe('When selectPairs runs pass 1', () => {
      it('Then the scan stops at the first below-threshold candidate, even for a fresh source further down the list', () => {
        // Arrange — destB's candidate is fresh (uses=0) but scores below threshold; the
        // scan must stop at destA's threshold boundary rather than skip ahead to it.
        const destA = addChange('a.meta', ID_A);
        const destB = addChange('b.meta', ID_A);
        const sorted = [matrixCandidate(0, destA, 90), matrixCandidate(1, destB, 10)];
        const uses = [0, 0];

        // Act
        const result = sutSelectPairs(sorted, uses, { copies: false, threshold: 50 });

        // Assert
        expect(result.pairs).toEqual([{ source: 0, destination: destA, score: 90 }]);
        expect(result.uses).toEqual([1, 0]);
      });
    });
  });

  describe('Given a below-threshold candidate whose source is already used', () => {
    describe('When selectPairs runs pass 2', () => {
      it('Then the below-threshold candidate is never paired', () => {
        // Arrange
        const destination = addChange('a.meta', ID_A);
        const sorted = [matrixCandidate(0, destination, 10)];
        const uses = [1];

        // Act
        const result = sutSelectPairs(sorted, uses, { copies: true, threshold: 50 });

        // Assert
        expect(result.pairs).toEqual([]);
        expect(result.uses).toEqual([1]);
      });
    });
  });

  describe('Given a destination already paired in pass 1 and a used source that would otherwise qualify in pass 2', () => {
    describe('When selectPairs runs with copies on', () => {
      it('Then pass 2 does not pair the same destination a second time', () => {
        // Arrange
        const destination = addChange('dst.meta', ID_A);
        const sorted = [matrixCandidate(0, destination, 90), matrixCandidate(1, destination, 80)];
        const uses = [0, 1];

        // Act
        const result = sutSelectPairs(sorted, uses, { copies: true, threshold: 0 });

        // Assert
        expect(result.pairs).toEqual([{ source: 0, destination, score: 90 }]);
        expect(result.uses).toEqual([1, 1]);
      });
    });
  });
});

const sutUniqueBasenamePairs = uniqueBasenamePairs;

describe('uniqueBasenamePairs', () => {
  describe('Given one source and one destination sharing a unique basename', () => {
    describe('When uniqueBasenamePairs is called', () => {
      it('Then the pair is returned', () => {
        // Arrange
        const source = renameSource('a/foo.c', ID_A);
        const destination = addChange('b/foo.c', ID_A);

        // Act
        const result = sutUniqueBasenamePairs([source], [destination]);

        // Assert
        expect(result).toEqual([{ source: 0, destination: 0 }]);
      });
    });
  });

  describe('Given two sources sharing the same basename', () => {
    describe('When uniqueBasenamePairs is called', () => {
      it('Then neither source pairs, even though the destination basename is unique', () => {
        // Arrange
        const sources = [renameSource('a/foo.c', ID_A), renameSource('x/foo.c', ID_A)];
        const destination = addChange('b/foo.c', ID_A);

        // Act
        const result = sutUniqueBasenamePairs(sources, [destination]);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given two destinations sharing the same basename', () => {
    describe('When uniqueBasenamePairs is called', () => {
      it('Then the source does not pair, even though its own basename is unique', () => {
        // Arrange
        const source = renameSource('a/foo.c', ID_A);
        const destinations = [addChange('b/foo.c', ID_A), addChange('x/foo.c', ID_A)];

        // Act
        const result = sutUniqueBasenamePairs([source], destinations);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a non-regular source sharing a basename with the only regular source', () => {
    describe('When uniqueBasenamePairs is called', () => {
      it('Then the basename still counts as non-unique and neither source pairs', () => {
        // Arrange — mode is irrelevant to uniqueness; only the path's basename counts.
        const sources = [
          renameSource('a/foo.c', ID_A),
          renameSource('x/foo.c', ID_A, { mode: FILE_MODE.SYMLINK }),
        ];
        const destination = addChange('b/foo.c', ID_A);

        // Act
        const result = sutUniqueBasenamePairs(sources, [destination]);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given several sources, only some with a uniquely-matching destination', () => {
    describe('When uniqueBasenamePairs is called', () => {
      it('Then the returned pairs stay in source order', () => {
        // Arrange — bar.c has no destination at all; baz.c collides on the source side.
        const sources = [
          renameSource('a/foo.c', ID_A),
          renameSource('a/bar.c', ID_A),
          renameSource('a/baz.c', ID_A),
          renameSource('x/baz.c', ID_A),
          renameSource('a/qux.c', ID_A),
        ];
        const destinations = [
          addChange('b/qux.c', ID_A),
          addChange('b/baz.c', ID_A),
          addChange('b/foo.c', ID_A),
        ];

        // Act
        const result = sutUniqueBasenamePairs(sources, destinations);

        // Assert
        expect(result).toEqual([
          { source: 0, destination: 2 },
          { source: 4, destination: 0 },
        ]);
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
