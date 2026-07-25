import { describe, expect, it } from 'vitest';

import { substituteDriverPlaceholders } from '../../../../src/domain/attributes/index.js';

const values = {
  O: '/tmp/base',
  A: '/tmp/ours',
  B: '/tmp/theirs',
  L: '7',
  P: 'src/a.txt',
  S: 'parent of 2c77705 (subject)',
  X: 'HEAD',
  Y: '2c77705 (subject)',
};

describe('substituteDriverPlaceholders', () => {
  describe('Given a template using every placeholder', () => {
    describe('When substituted', () => {
      it('Then each placeholder is replaced by its value', () => {
        // Arrange
        const template = 'merge %O %A %B %L %P';

        // Act
        const result = substituteDriverPlaceholders(template, values);

        // Assert
        expect(result).toBe('merge /tmp/base /tmp/ours /tmp/theirs 7 src/a.txt');
      });
    });
  });

  describe('Given a template using the label placeholders', () => {
    describe('When substituted', () => {
      it('Then `%S` `%X` `%Y` are replaced by the base / ours / theirs labels', () => {
        // Arrange
        const template = 'drv %L %S %X %Y';

        // Act
        const result = substituteDriverPlaceholders(template, values);

        // Assert
        expect(result).toBe('drv 7 parent of 2c77705 (subject) HEAD 2c77705 (subject)');
      });
    });
  });

  describe('Given a `%%` escape', () => {
    describe('When substituted', () => {
      it('Then it collapses to a single `%`', () => {
        // Arrange
        const template = '100%% sure %A';

        // Act
        const result = substituteDriverPlaceholders(template, values);

        // Assert
        expect(result).toBe('100% sure /tmp/ours');
      });
    });
  });

  describe('Given an unknown placeholder', () => {
    describe('When substituted', () => {
      it('Then the `%` and the character are emitted literally', () => {
        // Arrange
        const template = 'x %Z y';

        // Act
        const result = substituteDriverPlaceholders(template, values);

        // Assert
        expect(result).toBe('x %Z y');
      });
    });
  });

  describe('Given adjacent placeholders', () => {
    describe('When substituted', () => {
      it('Then both are replaced with no separator', () => {
        // Arrange
        const template = '%O%B';

        // Act
        const result = substituteDriverPlaceholders(template, values);

        // Assert
        expect(result).toBe('/tmp/base/tmp/theirs');
      });
    });
  });

  describe('Given a value that itself contains a `%` sequence', () => {
    describe('When substituted', () => {
      it('Then the inserted value is not re-scanned', () => {
        // Arrange
        const template = '%P';

        // Act
        const result = substituteDriverPlaceholders(template, { ...values, P: 'a%Ob' });

        // Assert
        expect(result).toBe('a%Ob');
      });
    });
  });

  describe('Given a trailing lone `%`', () => {
    describe('When substituted', () => {
      it('Then the dangling `%` is emitted literally', () => {
        // Arrange
        const template = 'run %A %';

        // Act
        const result = substituteDriverPlaceholders(template, values);

        // Assert
        expect(result).toBe('run /tmp/ours %');
      });
    });
  });

  describe('Given a template with no placeholders', () => {
    describe('When substituted', () => {
      it('Then it is returned unchanged', () => {
        // Arrange
        const template = 'plain command';

        // Act
        const result = substituteDriverPlaceholders(template, values);

        // Assert
        expect(result).toBe('plain command');
      });
    });
  });
});
