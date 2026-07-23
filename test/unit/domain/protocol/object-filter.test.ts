import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import {
  formatObjectFilter,
  type ObjectFilter,
  parseObjectFilter,
} from '../../../../src/domain/protocol/object-filter.js';

const expectInvalid = (spec: string, reason: string): void => {
  // Act
  let caught: unknown;
  try {
    parseObjectFilter(spec);
  } catch (err) {
    caught = err;
  }
  // Assert
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data;
  expect(data.code).toBe('INVALID_FILTER_SPEC');
  if (data.code !== 'INVALID_FILTER_SPEC') throw new Error('unreachable');
  expect(data.spec).toBe(spec);
  expect(data.reason).toBe(reason);
};

describe('parseObjectFilter', () => {
  describe('Given a valid filter spec', () => {
    describe('When parsed', () => {
      it.each([
        {
          spec: 'blob:none',
          expected: { kind: 'blob-none' },
          label: 'returns the blob-none filter',
        },
        {
          spec: 'blob:limit=0',
          expected: { kind: 'blob-limit', bytes: 0 },
          label: 'returns a zero-byte limit',
        },
        {
          spec: 'blob:limit=100',
          expected: { kind: 'blob-limit', bytes: 100 },
          label: 'returns the literal byte count',
        },
        {
          spec: 'blob:limit=1k',
          expected: { kind: 'blob-limit', bytes: 1024 },
          label: 'multiplies a "k" suffix by 1024',
        },
        {
          spec: 'blob:limit=2M',
          expected: { kind: 'blob-limit', bytes: 2 * 1024 * 1024 },
          label: 'multiplies an uppercase "M" suffix by 1024^2',
        },
        {
          spec: 'blob:limit=3g',
          expected: { kind: 'blob-limit', bytes: 3 * 1024 * 1024 * 1024 },
          label: 'multiplies a "g" suffix by 1024^3',
        },
        {
          spec: 'tree:0',
          expected: { kind: 'tree-depth', depth: 0 },
          label: 'returns a zero-depth tree filter',
        },
        {
          spec: 'tree:5',
          expected: { kind: 'tree-depth', depth: 5 },
          label: 'returns the requested depth',
        },
        {
          spec: 'tree:42',
          expected: { kind: 'tree-depth', depth: 42 },
          label: 'returns the full depth for a multi-digit tree depth',
        },
      ])('Then $label', ({ spec, expected }) => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut(spec);
        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given an invalid filter spec', () => {
    describe('When parsed', () => {
      it.each([
        { spec: '', reason: 'empty', label: 'an empty string' },
        { spec: 'unknown:x', reason: 'unknown-kind', label: 'an unknown kind' },
        { spec: 'sparse:oid=HEAD', reason: 'unknown-kind', label: '"sparse:oid"' },
        { spec: 'combine:blob:none', reason: 'unknown-kind', label: '"combine:"' },
        { spec: 'blob:all', reason: 'unknown-kind', label: '"blob:all"' },
        { spec: 'blob:limit=', reason: 'bad-blob-limit', label: '"blob:limit=" with no number' },
        { spec: 'blob:limit=-1', reason: 'bad-blob-limit', label: 'a negative blob limit' },
        { spec: 'blob:limit=1.5', reason: 'bad-blob-limit', label: 'a fractional blob limit' },
        { spec: 'blob:limit=abc', reason: 'bad-blob-limit', label: 'a non-numeric blob limit' },
        { spec: 'blob:limit=1x', reason: 'bad-blob-limit', label: 'a bad suffix on a blob limit' },
        {
          spec: 'blob:limit=99999999999999999999',
          reason: 'bad-blob-limit',
          label: 'a blob limit beyond MAX_SAFE_INTEGER',
        },
        {
          spec: 'blob:limit=9999999999999g',
          reason: 'bad-blob-limit',
          label: 'a "g"-scaled limit that overflows safe range',
        },
        { spec: 'tree:', reason: 'bad-tree-depth', label: '"tree:" with no depth' },
        { spec: 'tree:-1', reason: 'bad-tree-depth', label: 'a negative tree depth' },
        { spec: 'tree:1.5', reason: 'bad-tree-depth', label: 'a fractional tree depth' },
        {
          spec: 'tree:5.0',
          reason: 'bad-tree-depth',
          label: 'a tree depth with trailing content after the integer',
        },
        { spec: 'tree:abc', reason: 'bad-tree-depth', label: 'a non-numeric tree depth' },
        {
          spec: 'tree:99999999999999999999',
          reason: 'bad-tree-depth',
          label: 'a tree depth beyond MAX_SAFE_INTEGER',
        },
      ])('Then throws INVALID_FILTER_SPEC ($reason) for $label', ({ spec, reason }) => {
        // Arrange + Assert
        expectInvalid(spec, reason);
      });
    });
  });
});

describe('formatObjectFilter', () => {
  describe('Given a filter', () => {
    describe('When formatted', () => {
      it.each([
        {
          filter: { kind: 'blob-none' as const },
          expected: 'blob:none',
          label: 'renders "blob:none"',
        },
        {
          filter: { kind: 'blob-limit' as const, bytes: 4096 },
          expected: 'blob:limit=4096',
          label: 'renders the byte count',
        },
        {
          filter: { kind: 'tree-depth' as const, depth: 3 },
          expected: 'tree:3',
          label: 'renders the depth',
        },
      ])('Then $label', ({ filter, expected }) => {
        // Arrange
        const sut = formatObjectFilter;
        // Act
        const result = sut(filter);
        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  it.each<string>(['blob:none', 'blob:limit=1k', 'blob:limit=2M', 'tree:0', 'tree:7'])(
    'Given %s, When parsed then formatted then re-parsed, Then the filter is stable',
    (spec: string) => {
      // Arrange
      const first: ObjectFilter = parseObjectFilter(spec);
      // Act
      const reparsed = parseObjectFilter(formatObjectFilter(first));
      // Assert
      expect(reparsed).toEqual(first);
    },
  );
});
