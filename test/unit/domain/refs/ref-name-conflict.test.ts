import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  firstRefNameConflict,
  hasPrefixRelatedNames,
  type RefNameFacts,
  refNamePrefixes,
  smallestNameUnder,
  transactionNamesOf,
} from '../../../../src/domain/refs/ref-name-conflict.js';

const name = (text: string): RefName => text as RefName;
const NO_FACTS: RefNameFacts = { existingPrefixes: new Set(), smallestExistingUnder: undefined };

describe('ref-name-conflict', () => {
  describe('Given a nested ref name', () => {
    describe('When refNamePrefixes lists its prefixes', () => {
      it('Then every slash-bounded proper prefix is listed shortest first', () => {
        // Arrange
        const sut = refNamePrefixes;

        // Act
        const result = sut(name('refs/remotes/d/x'));

        // Assert
        expect(result).toEqual(['refs', 'refs/remotes', 'refs/remotes/d']);
      });
    });
  });

  describe('Given a name without a slash', () => {
    describe('When refNamePrefixes lists its prefixes', () => {
      it('Then there are none', () => {
        // Arrange
        const sut = refNamePrefixes;

        // Act
        const result = sut(name('HEAD'));

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given sorted names around a name', () => {
    describe('When smallestNameUnder searches under it', () => {
      it.each([
        {
          label: 'the first name under it, past a sibling sorting between',
          sorted: ['refs/d', 'refs/d-e', 'refs/d/a', 'refs/d/b'],
          expected: 'refs/d/a',
        },
        {
          label: 'nothing when only siblings follow',
          sorted: ['refs/d', 'refs/d-e', 'refs/e'],
          expected: undefined,
        },
        { label: 'nothing past the end', sorted: ['refs/a', 'refs/c'], expected: undefined },
        { label: 'nothing for the name itself', sorted: ['refs/d'], expected: undefined },
      ])('Then it returns $label', ({ sorted, expected }) => {
        // Arrange
        const sut = smallestNameUnder;

        // Act
        const result = sut(sorted.map(name), name('refs/d'));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given sets of transaction names', () => {
    describe('When hasPrefixRelatedNames tests them', () => {
      it.each([
        { label: 'a name and a name under it', names: ['refs/d/x', 'refs/d'], expected: true },
        {
          label: 'a name and one two levels under it',
          names: ['refs/d', 'refs/d/x/y'],
          expected: true,
        },
        {
          label: 'siblings sharing a text prefix only',
          names: ['refs/d', 'refs/d-x', 'refs/dx'],
          expected: false,
        },
        { label: 'a single name', names: ['refs/d/x'], expected: false },
      ])('Then $label is $expected', ({ names, expected }) => {
        // Arrange
        const sut = hasPrefixRelatedNames;

        // Act
        const result = sut(new Set(names.map(name)));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the transaction names', () => {
    describe('When transactionNamesOf collects them', () => {
      it('Then it keeps the distinct names in byte order', () => {
        // Arrange
        const sut = transactionNamesOf;

        // Act
        const result = sut([name('refs/d/x'), name('refs/d'), name('refs/d/x')]);

        // Assert
        expect([...result.names]).toEqual(['refs/d/x', 'refs/d']);
        expect(result.sorted).toEqual(['refs/d', 'refs/d/x']);
      });
    });
  });

  describe('Given a name a transaction creates', () => {
    describe('When firstRefNameConflict applies git order', () => {
      it.each([
        {
          label: 'an existing prefix before a transaction prefix nested deeper',
          target: 'refs/a/b/c',
          facts: { existingPrefixes: new Set([name('refs/a')]), smallestExistingUnder: undefined },
          transaction: ['refs/a/b', 'refs/a/b/c'],
          expected: { position: 'above', blocking: 'refs/a' },
        },
        {
          label: 'a transaction prefix before an existing prefix nested deeper',
          target: 'refs/a/b/c',
          facts: {
            existingPrefixes: new Set([name('refs/a/b')]),
            smallestExistingUnder: undefined,
          },
          transaction: ['refs/a', 'refs/a/b/c'],
          expected: { position: 'above', blocking: 'refs/a' },
        },
        {
          label: 'a prefix before a ref under it',
          target: 'refs/a/b',
          facts: {
            existingPrefixes: new Set([name('refs/a')]),
            smallestExistingUnder: name('refs/a/b/z'),
          },
          transaction: ['refs/a/b'],
          expected: { position: 'above', blocking: 'refs/a' },
        },
        {
          label: 'an existing ref under it before a smaller transaction name under it',
          target: 'refs/a',
          facts: { existingPrefixes: new Set<RefName>(), smallestExistingUnder: name('refs/a/z') },
          transaction: ['refs/a', 'refs/a/b'],
          expected: { position: 'below', blocking: 'refs/a/z' },
        },
        {
          label: 'the smallest transaction name under it',
          target: 'refs/a',
          facts: NO_FACTS,
          transaction: ['refs/a/y', 'refs/a', 'refs/a/b'],
          expected: { position: 'below', blocking: 'refs/a/b' },
        },
        {
          label: 'no conflict among unrelated names',
          target: 'refs/a',
          facts: NO_FACTS,
          transaction: ['refs/a', 'refs/b/a'],
          expected: undefined,
        },
      ])('Then it reports $label', ({ target, facts, transaction, expected }) => {
        // Arrange
        const sut = firstRefNameConflict;

        // Act
        const result = sut(name(target), facts, transactionNamesOf(transaction.map(name)));

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
