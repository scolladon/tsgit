import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AddChange } from '../../../../src/domain/diff/diff-change.js';
import { kindOf } from '../../../../src/domain/diff/mode-kind.js';
import type { MatrixCandidate, RenameSource } from '../../../../src/domain/diff/rename-pairing.js';
import {
  compareCandidates,
  labelRenameCopy,
  pairIdenticalFiles,
  selectPairs,
  uniqueBasenamePairs,
} from '../../../../src/domain/diff/rename-pairing.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { arbSourcesAndDestinations } from './arbitraries.js';

type PairingMode = 'rename' | 'copy';

// Restates exactKey's mode-class rule independently of the module under test:
// both sides regular-file-kind pair freely, everything else keys on itself.
function isSameExactKey(source: RenameSource, destination: AddChange): boolean {
  if (source.id !== destination.newId) return false;
  const modeMatches = kindOf(source.mode) === 'file' && kindOf(destination.newMode) === 'file';
  return modeMatches || source.mode === destination.newMode;
}

function referenceKey(id: ObjectId, mode: FileMode): string {
  return kindOf(mode) === 'file' ? `${id}:file` : `${id}:${mode}`;
}

// Restates "a destination pairs iff some same-key source was unused when
// visited" as a running unused-count per key, independent of the candidate
// scan/cap loop the module under test uses to reach the same answer.
function pairsUnderUnusedRule(
  sources: ReadonlyArray<RenameSource>,
  destinations: ReadonlyArray<AddChange>,
): boolean[] {
  const unusedByKey = new Map<string, number>();
  for (const source of sources) {
    if (source.seedUses > 0) continue;
    const key = referenceKey(source.id, source.mode);
    unusedByKey.set(key, (unusedByKey.get(key) ?? 0) + 1);
  }
  return destinations.map((destination) => {
    const key = referenceKey(destination.newId, destination.newMode);
    const remaining = unusedByKey.get(key) ?? 0;
    if (remaining === 0) return false;
    unusedByKey.set(key, remaining - 1);
    return true;
  });
}

describe('Given an arbitrary pool of rename sources and destinations colliding on id and basename', () => {
  describe('When paired in copy mode', () => {
    it('Then every destination sharing an exact key with a source is paired', () => {
      fc.assert(
        fc.property(arbSourcesAndDestinations(), ({ sources, destinations }) => {
          // Arrange
          const sut = pairIdenticalFiles;

          // Act
          const result = sut(sources, destinations, 'copy');

          // Assert
          for (const destination of destinations) {
            const hasSameKeySource = sources.some((source) => isSameExactKey(source, destination));
            const isPaired = result.pairs.some((pair) => pair.destination === destination);
            if (hasSameKeySource) expect(isPaired).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('When paired in rename mode', () => {
    it('Then no source is used more than one beyond its seed', () => {
      fc.assert(
        fc.property(arbSourcesAndDestinations(), ({ sources, destinations }) => {
          // Arrange
          const sut = pairIdenticalFiles;

          // Act
          const result = sut(sources, destinations, 'rename');

          // Assert
          sources.forEach((source, index) => {
            expect(result.uses[index]).toBeLessThanOrEqual(source.seedUses + 1);
          });
        }),
        { numRuns: 100 },
      );
    });

    it('Then a destination pairs iff some same-key source was unused when it was visited', () => {
      fc.assert(
        fc.property(arbSourcesAndDestinations(), ({ sources, destinations }) => {
          // Arrange
          const sut = pairIdenticalFiles;

          // Act
          const result = sut(sources, destinations, 'rename');

          // Assert
          const actuallyPaired = destinations.map((destination) =>
            result.pairs.some((pair) => pair.destination === destination),
          );
          const expectedPaired = pairsUnderUnusedRule(sources, destinations);
          expect(actuallyPaired).toEqual(expectedPaired);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('When paired in either mode', () => {
    it('Then uses[i] minus its seed equals the number of pairs naming source i', () => {
      fc.assert(
        fc.property(
          arbSourcesAndDestinations(),
          fc.constantFrom<PairingMode>('rename', 'copy'),
          ({ sources, destinations }, mode) => {
            // Arrange
            const sut = pairIdenticalFiles;

            // Act
            const result = sut(sources, destinations, mode);

            // Assert
            sources.forEach((source, index) => {
              const pairCount = result.pairs.filter((pair) => pair.source === index).length;
              expect((result.uses[index] as number) - source.seedUses).toBe(pairCount);
            });
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

function basenameOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

function countByBasename<T>(
  items: ReadonlyArray<T>,
  basenameOfItem: (item: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const basename = basenameOfItem(item);
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }
  return counts;
}

describe('Given an arbitrary pool of rename sources and destinations', () => {
  describe('When uniqueBasenamePairs is called', () => {
    it('Then every returned pair shares a basename occurring exactly once on each side', () => {
      fc.assert(
        fc.property(arbSourcesAndDestinations(), ({ sources, destinations }) => {
          // Arrange
          const sut = uniqueBasenamePairs;
          const sourceCounts = countByBasename(sources, (source) => basenameOf(source.path));
          const destinationCounts = countByBasename(destinations, (destination) =>
            basenameOf(destination.newPath),
          );

          // Act
          const result = sut(sources, destinations);

          // Assert
          for (const { source, destination } of result) {
            const sourceBasename = basenameOf((sources[source] as RenameSource).path);
            const destinationBasename = basenameOf(
              (destinations[destination] as AddChange).newPath,
            );
            expect(sourceBasename).toBe(destinationBasename);
            expect(sourceCounts.get(sourceBasename)).toBe(1);
            expect(destinationCounts.get(destinationBasename)).toBe(1);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});

const SELECT_PAIRS_MAX_SOURCES = 4;
const SELECT_PAIRS_MAX_DESTS = 4;
const SELECT_PAIRS_MAX_SCORE = 100;

interface SelectPairsScenario {
  readonly seedUses: ReadonlyArray<0 | 1>;
  readonly destinations: ReadonlyArray<AddChange>;
  readonly candidates: ReadonlyArray<MatrixCandidate>;
}

function destinationAt(index: number): AddChange {
  return {
    type: 'add',
    newPath: `d${index}.txt` as FilePath,
    newId: 'a'.repeat(40) as ObjectId,
    newMode: '100644' as FileMode,
  };
}

/** A small pool of sources (each either "deleted-like" seed 0 or
 *  "retained-like" seed 1) and destinations, plus a handful of candidate
 *  (source, destination) pairs scoring above zero — the input shape
 *  `selectPairs` consumes once sorted by `compareCandidates`. */
function arbSelectPairsScenario(): fc.Arbitrary<SelectPairsScenario> {
  return fc
    .record({
      sourceCount: fc.integer({ min: 1, max: SELECT_PAIRS_MAX_SOURCES }),
      destCount: fc.integer({ min: 1, max: SELECT_PAIRS_MAX_DESTS }),
    })
    .chain(({ sourceCount, destCount }) =>
      fc
        .record({
          seedUses: fc.array(fc.constantFrom<0 | 1>(0, 1), {
            minLength: sourceCount,
            maxLength: sourceCount,
          }),
          raw: fc.array(
            fc.record({
              source: fc.integer({ min: 0, max: sourceCount - 1 }),
              destIndex: fc.integer({ min: 0, max: destCount - 1 }),
              score: fc.integer({ min: 1, max: SELECT_PAIRS_MAX_SCORE }),
              nameScore: fc.constantFrom<0 | 1>(0, 1),
            }),
            { minLength: 0, maxLength: sourceCount * destCount },
          ),
        })
        .map(({ seedUses, raw }) => {
          const destinations = Array.from({ length: destCount }, (_unused, i) => destinationAt(i));
          const candidates = raw.map((entry) => ({
            source: entry.source,
            destination: destinations[entry.destIndex] as AddChange,
            score: entry.score,
            nameScore: entry.nameScore,
          }));
          return { seedUses, destinations, candidates };
        }),
    );
}

describe('Given an arbitrary pool of sources and candidates for selectPairs', () => {
  describe('When selectPairs runs with either copies setting', () => {
    it('Then no destination is ever paired more than once', () => {
      fc.assert(
        fc.property(arbSelectPairsScenario(), fc.boolean(), ({ seedUses, candidates }, copies) => {
          // Arrange
          const sut = selectPairs;
          const sorted = [...candidates].sort(compareCandidates);

          // Act
          const result = sut(sorted, seedUses, { copies, threshold: 0 });

          // Assert
          const pairedDestinations = result.pairs.map((pair) => pair.destination);
          expect(new Set(pairedDestinations).size).toBe(pairedDestinations.length);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('When selectPairs runs with copies on and its pairs are labelled', () => {
    it('Then each deleted-like source yields k-1 copies and a final rename, and each retained-like source yields only copies', () => {
      fc.assert(
        fc.property(arbSelectPairsScenario(), ({ seedUses, candidates }) => {
          // Arrange
          const sut = selectPairs;
          const sorted = [...candidates].sort(compareCandidates);

          // Act
          const result = sut(sorted, seedUses, { copies: true, threshold: 0 });
          const labelled = labelRenameCopy(result.pairs, result.uses);

          // Assert
          const bySource = new Map<number, Array<(typeof labelled)[number]>>();
          for (const entry of labelled) {
            const list = bySource.get(entry.pair.source) ?? [];
            list.push(entry);
            bySource.set(entry.pair.source, list);
          }

          for (const [sourceIndex, entries] of bySource) {
            const seed = seedUses[sourceIndex] as 0 | 1;
            if (seed === 1) {
              expect(entries.every((entry) => entry.kind === 'copy')).toBe(true);
              continue;
            }
            const renames = entries.filter((entry) => entry.kind === 'rename');
            const copies = entries.filter((entry) => entry.kind === 'copy');
            expect(renames).toHaveLength(1);
            expect(copies).toHaveLength(entries.length - 1);
            const lastByPath = [...entries].sort((a, b) =>
              a.pair.destination.newPath < b.pair.destination.newPath ? -1 : 1,
            );
            expect(lastByPath[lastByPath.length - 1]?.kind).toBe('rename');
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
