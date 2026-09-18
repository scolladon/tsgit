/**
 * Property tests for the transaction availability verdict: a name alone never
 * collides, a prefix added to the transaction always collides above it, and a
 * name added under it always collides below — whatever the name's shape. The
 * binary search for the smallest name under a name agrees with a linear scan.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  firstRefNameConflict,
  type RefNameFacts,
  refNamePrefixes,
  smallestNameUnder,
  transactionNamesOf,
} from '../../../../src/domain/refs/ref-name-conflict.js';
import { arbRefName } from './arbitraries.js';

const INVARIANT_NUM_RUNS = 100;
const NO_FACTS: RefNameFacts = { existingPrefixes: new Set(), smallestExistingUnder: undefined };

describe('ref-name-conflict properties', () => {
  describe('Given an arbitrary name alone in its transaction', () => {
    describe('When firstRefNameConflict checks it against empty storage', () => {
      it('Then it never collides', () => {
        // Arrange
        const sut = firstRefNameConflict;

        // Act + Assert
        fc.assert(
          fc.property(arbRefName(), (name) => {
            expect(sut(name, NO_FACTS, transactionNamesOf([name]))).toBeUndefined();
          }),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary name and one of its proper prefixes in the same transaction', () => {
    describe('When firstRefNameConflict checks the name', () => {
      it('Then it collides above that prefix', () => {
        // Arrange
        const sut = firstRefNameConflict;
        const arbNameAndPrefix = arbRefName().chain((name) =>
          fc.constantFrom(...refNamePrefixes(name)).map((prefix) => [name, prefix] as const),
        );

        // Act + Assert
        fc.assert(
          fc.property(arbNameAndPrefix, ([name, prefix]) => {
            const result = sut(name, NO_FACTS, transactionNamesOf([name, prefix]));
            expect(result).toEqual({ position: 'above', blocking: prefix });
          }),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary name and a name under it in the same transaction', () => {
    describe('When firstRefNameConflict checks the name', () => {
      it('Then it collides below that name', () => {
        // Arrange
        const sut = firstRefNameConflict;
        const arbNameAndChild = fc
          .tuple(arbRefName(), arbRefName())
          .map(([name, tail]) => [name, `${name}/${tail}` as RefName] as const);

        // Act + Assert
        fc.assert(
          fc.property(arbNameAndChild, ([name, child]) => {
            const result = sut(name, NO_FACTS, transactionNamesOf([child, name]));
            expect(result).toEqual({ position: 'below', blocking: child });
          }),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });

  describe('Given arbitrary sorted names and a name', () => {
    describe('When smallestNameUnder searches under it', () => {
      it('Then it returns the first name a linear scan finds under it', () => {
        // Arrange
        const sut = smallestNameUnder;
        const arbSortedAndName = fc
          .tuple(fc.uniqueArray(arbRefName(), { maxLength: 12 }), arbRefName())
          .map(([names, name]) => [[...names].sort(), name] as const);

        // Act + Assert
        fc.assert(
          fc.property(arbSortedAndName, ([sorted, name]) => {
            const linear = sorted.find((candidate) => candidate.startsWith(`${name}/`));
            expect(sut(sorted, name)).toBe(linear);
          }),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });
});
