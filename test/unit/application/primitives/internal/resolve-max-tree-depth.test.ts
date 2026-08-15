import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { resolveMaxTreeDepth } from '../../../../../src/application/primitives/internal/resolve-max-tree-depth.js';
import { DEFAULT_MAX_TREE_DEPTH } from '../../../../../src/domain/diff/flat-tree.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { seedMaxTreeDepth } from '../fixtures.js';

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly source: string;
  readonly value: string;
  readonly reason: string;
}

describe('primitives/internal/resolve-max-tree-depth', () => {
  describe('Given a config with a grammatically valid core.maxTreeDepth value', () => {
    describe('When resolveMaxTreeDepth is called', () => {
      // parseGitInt's own grammar is already covered by the config-read suite; these
      // rows pin the narrowing and default layered on top of it by this resolver,
      // not parseGitInt's parsing itself.
      it.each([
        { value: '2048', expected: 2048, label: '2048 (decimal)' },
        { value: '+6', expected: 6, label: '+6 (explicit sign)' },
        { value: ' 6', expected: 6, label: '" 6" (leading whitespace)' },
        { value: '1k', expected: 1024, label: '1k (unit multiplier)' },
        { value: '1m', expected: 1048576, label: '1m (unit multiplier)' },
        { value: '0x10', expected: 16, label: '0x10 (hex)' },
        { value: '010', expected: 8, label: '010 (leading-zero octal)' },
        { value: '07', expected: 7, label: '07 (octal)' },
        { value: '2147483647', expected: 2147483647, label: '2147483647 (C int max)' },
        { value: '-2147483648', expected: -2147483648, label: '-2147483648 (C int min)' },
      ])('Then it resolves $label to the parsed number', async ({ value, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seedMaxTreeDepth(ctx, value);

        // Act
        const result = await resolveMaxTreeDepth(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given core.maxTreeDepth = 2.5, When resolveMaxTreeDepth is called', () => {
    it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason invalid unit', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedMaxTreeDepth(ctx, '2.5');

      // Act
      let caught: unknown;
      try {
        await resolveMaxTreeDepth(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as BadNumericData;
      expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      expect(data.key).toBe('core.maxtreedepth');
      expect(data.value).toBe('2.5');
      expect(data.reason).toBe('invalid unit');
    });
  });

  // The only test proving the C-int narrowing sits on the resolver's refusal
  // path: parseGitInt alone accepts 2147483648 (its own bounds are int64).
  describe('Given core.maxTreeDepth = 2147483648, When resolveMaxTreeDepth is called', () => {
    it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason out of range', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedMaxTreeDepth(ctx, '2147483648');

      // Act
      let caught: unknown;
      try {
        await resolveMaxTreeDepth(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as BadNumericData;
      expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      expect(data.key).toBe('core.maxtreedepth');
      expect(data.value).toBe('2147483648');
      expect(data.reason).toBe('out of range');
    });
  });

  describe('Given core.maxTreeDepth = 0, When resolveMaxTreeDepth is called', () => {
    it('Then resolves to 0 (a cap of exactly top-level entries, not unlimited)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedMaxTreeDepth(ctx, '0');

      // Act
      const result = await resolveMaxTreeDepth(ctx);

      // Assert
      expect(result).toBe(0);
    });
  });

  describe('Given core.maxTreeDepth = -1, When resolveMaxTreeDepth is called', () => {
    it('Then resolves to -1 (refuses every entry, including a depth-0 tree)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedMaxTreeDepth(ctx, '-1');

      // Act
      const result = await resolveMaxTreeDepth(ctx);

      // Assert
      expect(result).toBe(-1);
    });
  });

  describe('Given core.maxTreeDepth = -2147483648, When resolveMaxTreeDepth is called', () => {
    it('Then resolves to -2147483648 (a valid value at the C int floor)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedMaxTreeDepth(ctx, '-2147483648');

      // Act
      const result = await resolveMaxTreeDepth(ctx);

      // Assert
      expect(result).toBe(-2147483648);
    });
  });

  describe('Given a [core] section with no maxTreeDepth key, When resolveMaxTreeDepth is called', () => {
    it('Then resolves to the 2048 default', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare = false\n');

      // Act
      const result = await resolveMaxTreeDepth(ctx);

      // Assert
      expect(result).toBe(DEFAULT_MAX_TREE_DEPTH);
    });
  });

  describe('Given no config file at all, When resolveMaxTreeDepth is called', () => {
    it('Then resolves to the 2048 default (absence is not failure)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const result = await resolveMaxTreeDepth(ctx);

      // Assert
      expect(result).toBe(DEFAULT_MAX_TREE_DEPTH);
    });
  });

  describe('Given a mixed-case core.MaxTreeDepth key, When resolveMaxTreeDepth is called', () => {
    it('Then resolves the value (case-insensitive key matching)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tMaxTreeDepth = 4\n');

      // Act
      const result = await resolveMaxTreeDepth(ctx);

      // Assert
      expect(result).toBe(4);
    });
  });
});
