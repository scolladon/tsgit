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
  it('Given "blob:none", When parsed, Then returns the blob-none filter', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('blob:none');
    // Assert
    expect(result).toEqual({ kind: 'blob-none' });
  });

  it('Given "blob:limit=0", When parsed, Then returns a zero-byte limit', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('blob:limit=0');
    // Assert
    expect(result).toEqual({ kind: 'blob-limit', bytes: 0 });
  });

  it('Given "blob:limit=100", When parsed, Then returns the literal byte count', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('blob:limit=100');
    // Assert
    expect(result).toEqual({ kind: 'blob-limit', bytes: 100 });
  });

  it('Given a "k" suffix, When parsed, Then multiplies by 1024', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('blob:limit=1k');
    // Assert
    expect(result).toEqual({ kind: 'blob-limit', bytes: 1024 });
  });

  it('Given an uppercase "M" suffix, When parsed, Then multiplies by 1024^2', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('blob:limit=2M');
    // Assert
    expect(result).toEqual({ kind: 'blob-limit', bytes: 2 * 1024 * 1024 });
  });

  it('Given a "g" suffix, When parsed, Then multiplies by 1024^3', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('blob:limit=3g');
    // Assert
    expect(result).toEqual({ kind: 'blob-limit', bytes: 3 * 1024 * 1024 * 1024 });
  });

  it('Given "tree:0", When parsed, Then returns a zero-depth tree filter', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('tree:0');
    // Assert
    expect(result).toEqual({ kind: 'tree-depth', depth: 0 });
  });

  it('Given "tree:5", When parsed, Then returns the requested depth', () => {
    // Arrange
    const sut = parseObjectFilter;
    // Act
    const result = sut('tree:5');
    // Assert
    expect(result).toEqual({ kind: 'tree-depth', depth: 5 });
  });

  it('Given an empty string, When parsed, Then throws INVALID_FILTER_SPEC (empty)', () => {
    expectInvalid('', 'empty');
  });

  it('Given an unknown kind, When parsed, Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
    expectInvalid('unknown:x', 'unknown-kind');
  });

  it('Given "sparse:oid", When parsed, Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
    expectInvalid('sparse:oid=HEAD', 'unknown-kind');
  });

  it('Given "combine:", When parsed, Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
    expectInvalid('combine:blob:none', 'unknown-kind');
  });

  it('Given "blob:all", When parsed, Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
    expectInvalid('blob:all', 'unknown-kind');
  });

  it('Given "blob:limit=" with no number, When parsed, Then throws (bad-blob-limit)', () => {
    expectInvalid('blob:limit=', 'bad-blob-limit');
  });

  it('Given a negative blob limit, When parsed, Then throws (bad-blob-limit)', () => {
    expectInvalid('blob:limit=-1', 'bad-blob-limit');
  });

  it('Given a fractional blob limit, When parsed, Then throws (bad-blob-limit)', () => {
    expectInvalid('blob:limit=1.5', 'bad-blob-limit');
  });

  it('Given a non-numeric blob limit, When parsed, Then throws (bad-blob-limit)', () => {
    expectInvalid('blob:limit=abc', 'bad-blob-limit');
  });

  it('Given a bad suffix on a blob limit, When parsed, Then throws (bad-blob-limit)', () => {
    expectInvalid('blob:limit=1x', 'bad-blob-limit');
  });

  it('Given a blob limit beyond MAX_SAFE_INTEGER, When parsed, Then throws (bad-blob-limit)', () => {
    expectInvalid('blob:limit=99999999999999999999', 'bad-blob-limit');
  });

  it('Given a "g"-scaled limit that overflows safe range, When parsed, Then throws (bad-blob-limit)', () => {
    expectInvalid('blob:limit=9999999999999g', 'bad-blob-limit');
  });

  it('Given "tree:" with no depth, When parsed, Then throws (bad-tree-depth)', () => {
    expectInvalid('tree:', 'bad-tree-depth');
  });

  it('Given a negative tree depth, When parsed, Then throws (bad-tree-depth)', () => {
    expectInvalid('tree:-1', 'bad-tree-depth');
  });

  it('Given a fractional tree depth, When parsed, Then throws (bad-tree-depth)', () => {
    expectInvalid('tree:1.5', 'bad-tree-depth');
  });

  it('Given a non-numeric tree depth, When parsed, Then throws (bad-tree-depth)', () => {
    expectInvalid('tree:abc', 'bad-tree-depth');
  });

  it('Given a tree depth beyond MAX_SAFE_INTEGER, When parsed, Then throws (bad-tree-depth)', () => {
    expectInvalid('tree:99999999999999999999', 'bad-tree-depth');
  });
});

describe('formatObjectFilter', () => {
  it('Given the blob-none filter, When formatted, Then renders "blob:none"', () => {
    // Arrange
    const sut = formatObjectFilter;
    // Act
    const result = sut({ kind: 'blob-none' });
    // Assert
    expect(result).toBe('blob:none');
  });

  it('Given a blob-limit filter, When formatted, Then renders the byte count', () => {
    // Arrange
    const sut = formatObjectFilter;
    // Act
    const result = sut({ kind: 'blob-limit', bytes: 4096 });
    // Assert
    expect(result).toBe('blob:limit=4096');
  });

  it('Given a tree-depth filter, When formatted, Then renders the depth', () => {
    // Arrange
    const sut = formatObjectFilter;
    // Act
    const result = sut({ kind: 'tree-depth', depth: 3 });
    // Assert
    expect(result).toBe('tree:3');
  });

  it.each<string>([
    'blob:none',
    'blob:limit=1k',
    'blob:limit=2M',
    'tree:0',
    'tree:7',
  ])('Given %s, When parsed then formatted then re-parsed, Then the filter is stable', (spec: string) => {
    // Arrange
    const first: ObjectFilter = parseObjectFilter(spec);
    // Act
    const reparsed = parseObjectFilter(formatObjectFilter(first));
    // Assert
    expect(reparsed).toEqual(first);
  });
});
