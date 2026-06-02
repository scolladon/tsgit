import { describe, expect, it } from 'vitest';

import { parseShowOptions } from '../../../../../src/application/commands/internal/show-options.js';
import type { TsgitError } from '../../../../../src/domain/error.js';

const codeOf = (run: () => unknown): TsgitError['data'] => {
  try {
    run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  throw new Error('expected parseShowOptions to throw');
};

describe('Given show option resolution', () => {
  describe('When no options are provided', () => {
    it('Then it resolves the medium / default / dense plan', () => {
      // Arrange / Act
      const sut = parseShowOptions({});

      // Assert
      expect(sut).toEqual({
        noPatch: false,
        format: { kind: 'builtin', name: 'medium' },
        dateMode: { kind: 'default' },
        numstat: false,
        mergeDiff: 'dense',
      });
    });
  });

  describe('When contextLines is provided', () => {
    it('Then it threads contextLines into the plan', () => {
      // Arrange / Act
      const sut = parseShowOptions({ contextLines: 1 });

      // Assert
      expect(sut.contextLines).toBe(1);
    });
  });

  describe('When noPatch is set', () => {
    it('Then the plan suppresses the patch', () => {
      // Arrange / Act
      const sut = parseShowOptions({ noPatch: true });

      // Assert
      expect(sut.noPatch).toBe(true);
    });
  });

  describe('When an unsupported format is given', () => {
    it('Then it throws INVALID_OPTION for format', () => {
      // Arrange / Act
      const data = codeOf(() => parseShowOptions({ format: 'nope' }));

      // Assert
      expect(data.code).toBe('INVALID_OPTION');
      expect(data).toMatchObject({ option: 'format' });
    });
  });

  describe('When an unsupported date mode is given', () => {
    it('Then it throws INVALID_OPTION for date', () => {
      // Arrange / Act
      const data = codeOf(() => parseShowOptions({ date: 'nope' }));

      // Assert
      expect(data.code).toBe('INVALID_OPTION');
      expect(data).toMatchObject({ option: 'date' });
    });
  });

  describe('When the alias date mode "normal" is given', () => {
    it('Then it normalises to the default mode', () => {
      // Arrange / Act
      const sut = parseShowOptions({ date: 'normal' });

      // Assert
      expect(sut.dateMode).toEqual({ kind: 'default' });
    });
  });

  describe('When a known date mode is given', () => {
    it('Then it resolves the mode', () => {
      // Arrange / Act
      const sut = parseShowOptions({ date: 'iso-strict' });

      // Assert
      expect(sut.dateMode).toEqual({ kind: 'iso-strict' });
    });
  });

  describe('When numstat is requested', () => {
    it('Then the plan enables numstat', () => {
      // Arrange / Act
      const sut = parseShowOptions({ numstat: true });

      // Assert
      expect(sut.numstat).toBe(true);
    });
  });

  describe('When stat is requested as a boolean', () => {
    it('Then it resolves to the default width', () => {
      // Arrange / Act
      const sut = parseShowOptions({ stat: true });

      // Assert
      expect(sut.stat).toEqual({ width: 80 });
    });
  });

  describe('When stat is requested with width overrides', () => {
    it('Then the overrides flow into the plan', () => {
      // Arrange / Act
      const sut = parseShowOptions({ stat: { width: 120, nameWidth: 30, count: 5 } });

      // Assert
      expect(sut.stat).toEqual({ width: 120, nameWidth: 30, count: 5 });
    });
  });

  describe('When a merge-diff mode is requested before it lands', () => {
    it('Then it throws INVALID_OPTION for mergeDiff', () => {
      // Arrange / Act
      const data = codeOf(() => parseShowOptions({ mergeDiff: 'separate' }));

      // Assert
      expect(data.code).toBe('INVALID_OPTION');
      expect(data).toMatchObject({ option: 'mergeDiff' });
    });
  });
});
