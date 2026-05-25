import { describe, expect, it } from 'vitest';
import {
  type InteropSurfaceConfig,
  parseInteropSurface,
} from '../../../audit-write-surfaces/parse-interop-surface.js';

const sutConfig = (): InteropSurfaceConfig => ({
  surfaceRegex: /^[a-z][a-zA-Z0-9.-]{1,40}$/,
  interopBuckets: new Set(['cross-tool-interop']),
});

const sourceWith = (line: string | null): string => {
  const interopLine = line === null ? '' : ` * interopSurface: ${line}\n`;
  return `/**
 * @proves
 *   surface: tree
 *   bucket:  cross-tool-interop
 *   unique:  …
${interopLine} */
`;
};

describe('parseInteropSurface', () => {
  describe('Given bucket=cross-tool-interop with a single interopSurface name', () => {
    describe('When parsed', () => {
      it('Then returns ok=true with a singleton surface set', () => {
        // Arrange
        const source = sourceWith('tree');

        // Act
        const sut = parseInteropSurface(source, 'cross-tool-interop', sutConfig());

        // Assert
        expect(sut.ok).toBe(true);
        if (sut.ok) {
          expect([...sut.surfaces]).toEqual(['tree']);
        }
      });
    });
  });

  describe('Given bucket=cross-tool-interop with a comma-separated list', () => {
    describe('When parsed', () => {
      it('Then returns a set with every listed surface name', () => {
        // Arrange
        const source = sourceWith('packfile, packIndex');

        // Act
        const sut = parseInteropSurface(source, 'cross-tool-interop', sutConfig());

        // Assert
        expect(sut.ok).toBe(true);
        if (sut.ok) {
          expect([...sut.surfaces].sort()).toEqual(['packIndex', 'packfile']);
        }
      });
    });
  });

  describe('Given bucket=cross-tool-interop without an interopSurface line', () => {
    describe('When parsed', () => {
      it('Then returns missing-interop-surface', () => {
        // Arrange
        const source = sourceWith(null);

        // Act
        const sut = parseInteropSurface(source, 'cross-tool-interop', sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) expect(sut.error.reason).toBe('missing-interop-surface');
      });
    });
  });

  describe('Given bucket=real-fs with an interopSurface line', () => {
    describe('When parsed', () => {
      it('Then returns unexpected-interop-surface with bucket name in detail', () => {
        // Arrange
        const source = sourceWith('tree');

        // Act
        const sut = parseInteropSurface(source, 'real-fs', sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('unexpected-interop-surface');
          expect(sut.error.detail).toBe('real-fs');
        }
      });
    });
  });

  describe('Given bucket=real-fs without an interopSurface line', () => {
    describe('When parsed', () => {
      it('Then returns ok=true with an empty surface set', () => {
        // Arrange
        const source = sourceWith(null);

        // Act
        const sut = parseInteropSurface(source, 'real-fs', sutConfig());

        // Assert
        expect(sut.ok).toBe(true);
        if (sut.ok) expect(sut.surfaces.size).toBe(0);
      });
    });
  });

  describe('Given an interopSurface line that is only whitespace', () => {
    describe('When parsed', () => {
      it('Then returns empty-interop-surface', () => {
        // Arrange
        const source = `/**
 * @proves
 *   surface: tree
 *   bucket:  cross-tool-interop
 *   unique:  …
 * interopSurface:   ,  , ,
 */
`;

        // Act
        const sut = parseInteropSurface(source, 'cross-tool-interop', sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) expect(sut.error.reason).toBe('empty-interop-surface');
      });
    });
  });

  describe('Given an interopSurface name that violates surfaceRegex', () => {
    describe('When parsed', () => {
      it('Then returns bad-interop-surface with the offending name', () => {
        // Arrange
        const source = sourceWith('NotKebab');

        // Act
        const sut = parseInteropSurface(source, 'cross-tool-interop', sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) {
          expect(sut.error.reason).toBe('bad-interop-surface');
          expect(sut.error.detail).toBe('NotKebab');
        }
      });
    });
  });

  describe('Given a source without a JSDoc block', () => {
    describe('When parsed for cross-tool-interop', () => {
      it('Then returns missing-interop-surface', () => {
        // Arrange
        const source = '// no jsdoc here\n';

        // Act
        const sut = parseInteropSurface(source, 'cross-tool-interop', sutConfig());

        // Assert
        expect(sut.ok).toBe(false);
        if (!sut.ok) expect(sut.error.reason).toBe('missing-interop-surface');
      });
    });
  });
});
