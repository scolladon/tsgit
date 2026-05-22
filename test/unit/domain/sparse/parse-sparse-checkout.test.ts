import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import { FilePath } from '../../../../src/domain/objects/object-id.js';
import { buildConeSpec, serializeCone } from '../../../../src/domain/sparse/cone.js';
import {
  buildSparseMatcher,
  MAX_SPARSE_PATTERN_BYTES,
  MAX_SPARSE_PATTERNS,
  parseSparseCheckout,
} from '../../../../src/domain/sparse/parse-sparse-checkout.js';

const path = (p: string): FilePath => FilePath.from(p);

describe('parseSparseCheckout', () => {
  it('Given a cone-shaped file and coneRequested, When parsed, Then it yields a cone spec and degraded false', () => {
    // Arrange
    const text = serializeCone(buildConeSpec(['src/app']));

    // Act
    const sut = parseSparseCheckout(text, true);

    // Assert
    expect(sut.spec.mode).toBe('cone');
    expect(sut.degraded).toBe(false);
  });

  it('Given a non-cone-shaped file and coneRequested, When parsed, Then it falls back with degraded true', () => {
    // Arrange — `*.ts` is not a cone-shaped line.
    const text = '/*\n!/*/\n*.ts\n';

    // Act
    const sut = parseSparseCheckout(text, true);

    // Assert
    expect(sut.spec.mode).toBe('no-cone');
    expect(sut.degraded).toBe(true);
  });

  it('Given a non-cone file and coneRequested false, When parsed, Then it yields a no-cone spec and degraded false', () => {
    // Arrange
    const text = '/src/\n*.ts\n';

    // Act
    const sut = parseSparseCheckout(text, false);

    // Assert
    expect(sut.spec.mode).toBe('no-cone');
    expect(sut.degraded).toBe(false);
  });

  it('Given a non-cone file with comment and blank lines, When parsed, Then those lines are skipped', () => {
    // Arrange
    const text = '# comment\n\n/src/\n';

    // Act
    const sut = parseSparseCheckout(text, false);

    // Assert
    expect(sut.spec).toMatchObject({ mode: 'no-cone' });
    if (sut.spec.mode === 'no-cone') {
      expect(sut.spec.rules).toHaveLength(1);
    }
  });

  it('Given a pattern of exactly the byte limit, When parsed, Then it is accepted', () => {
    // Arrange — a single line of `MAX_SPARSE_PATTERN_BYTES` ASCII bytes.
    const text = '/'.concat('a'.repeat(MAX_SPARSE_PATTERN_BYTES - 1));

    // Act
    const sut = parseSparseCheckout(text, false);

    // Assert
    expect(sut.spec.mode).toBe('no-cone');
  });

  it('Given a pattern one byte over the limit, When parsed, Then it throws INVALID_OPTION', () => {
    // Arrange
    const text = '/'.concat('a'.repeat(MAX_SPARSE_PATTERN_BYTES));

    // Act
    let caught: unknown;
    try {
      parseSparseCheckout(text, false);
    } catch (error) {
      caught = error;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_OPTION',
      option: 'patterns',
      reason: `pattern exceeds max length ${MAX_SPARSE_PATTERN_BYTES} bytes`,
    });
  });

  it('Given exactly the maximum number of patterns, When parsed, Then it is accepted', () => {
    // Arrange — `MAX_SPARSE_PATTERNS` lines.
    const text = Array.from({ length: MAX_SPARSE_PATTERNS }, () => '/src/').join('\n');

    // Act
    const sut = parseSparseCheckout(text, false);

    // Assert
    expect(sut.spec.mode).toBe('no-cone');
  });

  it('Given one pattern line over the maximum, When parsed, Then it throws INVALID_OPTION', () => {
    // Arrange — `MAX_SPARSE_PATTERNS + 1` lines.
    const text = Array.from({ length: MAX_SPARSE_PATTERNS + 1 }, () => '/src/').join('\n');

    // Act
    let caught: unknown;
    try {
      parseSparseCheckout(text, false);
    } catch (error) {
      caught = error;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_OPTION',
      option: 'patterns',
      reason: `pattern file exceeds max ${MAX_SPARSE_PATTERNS} patterns`,
    });
  });
});

describe('buildSparseMatcher', () => {
  it('Given a cone spec, When the matcher is built, Then it dispatches to the cone matcher', () => {
    // Arrange
    const { spec } = parseSparseCheckout(serializeCone(buildConeSpec(['src/app'])), true);

    // Act
    const sut = buildSparseMatcher(spec);

    // Assert
    expect(sut(path('src/app/main.ts'))).toBe(true);
    expect(sut(path('docs/guide.md'))).toBe(false);
  });

  it('Given a no-cone spec, When the matcher is built, Then it dispatches to the non-cone matcher', () => {
    // Arrange
    const { spec } = parseSparseCheckout('/src/\n', false);

    // Act
    const sut = buildSparseMatcher(spec);

    // Assert
    expect(sut(path('src/main.ts'))).toBe(true);
    expect(sut(path('docs/guide.md'))).toBe(false);
  });
});
