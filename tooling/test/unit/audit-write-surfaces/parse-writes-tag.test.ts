import { describe, expect, it } from 'vitest';
import {
  type WritesTagConfig,
  parseWritesTag,
} from '../../../audit-write-surfaces/parse-writes-tag.js';

const sutConfig = (): WritesTagConfig => ({
  surfaceRegex: /^[a-z][a-zA-Z0-9.-]{1,40}$/,
  formatRegex: /^[a-z][a-z0-9-]+$/,
  formatMinLength: 4,
  formatMaxLength: 40,
});

const HAPPY_SOURCE = `/**
 * Tree serializer.
 *
 * @writes
 *   surface: tree
 *   kind:    byte-identical
 *   format:  git-tree-object
 */
import x from 'y';
`;

describe('parseWritesTag', () => {
  describe('Given a JSDoc with all three @writes keys', () => {
    describe('When parsed', () => {
      it('Then returns ok=true with the surface/kind/format triple', () => {
        // Arrange
        const source = HAPPY_SOURCE;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(true);
        if (sut.ok) {
          expect(sut.tag.surface).toBe('tree');
          expect(sut.tag.kind).toBe('byte-identical');
          expect(sut.tag.format).toBe('git-tree-object');
        }
      });
    });
  });

  describe('Given a shebang preceding the JSDoc', () => {
    describe('When parsed', () => {
      it('Then the parser skips the shebang and succeeds', () => {
        // Arrange
        const source = `#!/usr/bin/env tsx
${HAPPY_SOURCE}`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(true);
      });
    });
  });

  describe('Given CRLF line endings', () => {
    describe('When parsed', () => {
      it('Then line endings are normalised and parsing succeeds', () => {
        // Arrange
        const source = HAPPY_SOURCE.replace(/\n/g, '\r\n');

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(true);
        if (sut.ok) expect(sut.tag.surface).toBe('tree');
      });
    });
  });

  describe('Given two @writes blocks in the same file', () => {
    describe('When parsed', () => {
      it('Then returns ok=false with reason=duplicate-writes-block', () => {
        // Arrange
        const source = `${HAPPY_SOURCE}
/**
 * @writes
 *   surface: tree2
 *   kind:    byte-identical
 *   format:  git-tree-object
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) expect(sut.error.reason).toBe('duplicate-writes-block');
      });
    });
  });

  describe('Given a file without a leading JSDoc', () => {
    describe('When parsed', () => {
      it('Then returns ok=false with reason=no-jsdoc-at-top', () => {
        // Arrange
        const source = `// a line comment first
${HAPPY_SOURCE}`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) expect(sut.error.reason).toBe('no-jsdoc-at-top');
      });
    });
  });

  describe('Given a JSDoc without any @writes directive', () => {
    describe('When parsed', () => {
      it('Then returns ok=false with reason=no-writes-block', () => {
        // Arrange
        const source = `/**
 * Just prose, no directive.
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) expect(sut.error.reason).toBe('no-writes-block');
      });
    });
  });

  describe('Given a @writes block missing the kind key', () => {
    describe('When parsed', () => {
      it('Then returns missing-key with detail naming the missing key', () => {
        // Arrange
        const source = `/**
 * @writes
 *   surface: tree
 *   format:  git-tree-object
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('missing-key');
          expect(sut.error.detail).toContain('kind');
        }
      });
    });
  });

  describe('Given a @writes block missing both surface and format', () => {
    describe('When parsed', () => {
      it('Then missing-key detail lists every absent key', () => {
        // Arrange
        const source = `/**
 * @writes
 *   kind: byte-identical
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('missing-key');
          expect(sut.error.detail).toContain('surface');
          expect(sut.error.detail).toContain('format');
        }
      });
    });
  });

  describe('Given a surface value that violates the regex', () => {
    describe('When parsed', () => {
      it('Then returns bad-surface with the offending value in detail', () => {
        // Arrange
        const source = `/**
 * @writes
 *   surface: NotKebab
 *   kind:    byte-identical
 *   format:  git-tree-object
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('bad-surface');
          expect(sut.error.detail).toBe('NotKebab');
        }
      });
    });
  });

  describe('Given a kind value outside the enum', () => {
    describe('When parsed', () => {
      it('Then returns bad-kind with the offending value in detail', () => {
        // Arrange
        const source = `/**
 * @writes
 *   surface: tree
 *   kind:    snapshot
 *   format:  git-tree-object
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('bad-kind');
          expect(sut.error.detail).toBe('snapshot');
        }
      });
    });
  });

  describe('Given a format value shorter than the minimum length', () => {
    describe('When parsed', () => {
      it('Then returns bad-format with length-range detail', () => {
        // Arrange
        const source = `/**
 * @writes
 *   surface: tree
 *   kind:    byte-identical
 *   format:  abc
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('bad-format');
          expect(sut.error.detail).toContain('length out of range');
        }
      });
    });
  });

  describe('Given a format value that violates the regex', () => {
    describe('When parsed', () => {
      it('Then returns bad-format with the offending value in detail', () => {
        // Arrange
        const source = `/**
 * @writes
 *   surface: tree
 *   kind:    byte-identical
 *   format:  BadFormat
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('bad-format');
          expect(sut.error.detail).toBe('BadFormat');
        }
      });
    });
  });

  describe('Given prose surrounding the @writes directive', () => {
    describe('When parsed', () => {
      it('Then prose is ignored and the keys are extracted', () => {
        // Arrange
        const source = `/**
 * Long-form module description.
 * Multiple paragraphs.
 *
 * @writes
 *   surface: tree
 *   kind:    byte-identical
 *   format:  git-tree-object
 *
 * Trailing prose after.
 */
`;

        // Act
        const sut = parseWritesTag(source, sutConfig());

        // Assert
        expect(sut.ok).toBe(true);
        if (sut.ok) expect(sut.tag.surface).toBe('tree');
      });
    });
  });
});
