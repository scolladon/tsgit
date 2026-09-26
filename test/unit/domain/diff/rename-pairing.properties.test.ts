import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AddChange } from '../../../../src/domain/diff/diff-change.js';
import { kindOf } from '../../../../src/domain/diff/mode-kind.js';
import type { RenameSource } from '../../../../src/domain/diff/rename-pairing.js';
import { pairIdenticalFiles } from '../../../../src/domain/diff/rename-pairing.js';
import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
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

const sut = pairIdenticalFiles;

describe('Given a small pool of rename sources and destinations colliding on id and basename', () => {
  describe('When paired in copy mode', () => {
    it('Then every destination sharing an exact key with a source is paired', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbSourcesAndDestinations(), ({ sources, destinations }) => {
          const result = sut(sources, destinations, 'copy');

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
      // Arrange + Assert
      fc.assert(
        fc.property(arbSourcesAndDestinations(), ({ sources, destinations }) => {
          const result = sut(sources, destinations, 'rename');

          sources.forEach((source, index) => {
            expect(result.uses[index]).toBeLessThanOrEqual(source.seedUses + 1);
          });
        }),
        { numRuns: 100 },
      );
    });

    it('Then a destination pairs iff some same-key source was unused when it was visited', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbSourcesAndDestinations(), ({ sources, destinations }) => {
          const result = sut(sources, destinations, 'rename');

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
      // Arrange + Assert
      fc.assert(
        fc.property(
          arbSourcesAndDestinations(),
          fc.constantFrom<PairingMode>('rename', 'copy'),
          ({ sources, destinations }, mode) => {
            const result = sut(sources, destinations, mode);

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
