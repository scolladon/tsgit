import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  type MergeRenameConfig,
  readConflictStyle,
  readMergeRenameConfig,
  readMergeRenormalize,
} from '../../../../../src/application/primitives/internal/merge-rename-config.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

const withConfig = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return ctx;
};

const refusalData = async (attempt: Promise<unknown>): Promise<unknown> => {
  const caught = await attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof TsgitError)) throw new Error('expected a TsgitError');
  return caught.data;
};

const DEFAULTS: MergeRenameConfig = { detect: true, limit: 7000, directoryRenames: 'conflict' };

describe('readMergeRenameConfig', () => {
  describe('Given no rename configuration', () => {
    describe('When it is read', () => {
      it('Then git ort defaults apply', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = readMergeRenameConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual(DEFAULTS);
      });
    });
  });

  describe.each([
    ['diff.renameLimit alone', '[diff]\n\trenameLimit = 5\n', { limit: 5 }],
    ['merge.renameLimit alone', '[merge]\n\trenameLimit = 6\n', { limit: 6 }],
    [
      'both limits (merge wins)',
      '[diff]\n\trenameLimit = 5\n[merge]\n\trenameLimit = 6\n',
      { limit: 6 },
    ],
    ['a zero limit', '[merge]\n\trenameLimit = 0\n', { limit: 7000 }],
    ['a negative limit', '[merge]\n\trenameLimit = -1\n', { limit: 7000 }],
    ['a limit of one', '[merge]\n\trenameLimit = 1\n', { limit: 1 }],
    ['the largest C int limit', '[merge]\n\trenameLimit = 2147483647\n', { limit: 2147483647 }],
    ['the smallest C int limit', '[merge]\n\trenameLimit = -2147483648\n', { limit: 7000 }],
    ['diff.renames off', '[diff]\n\trenames = false\n', { detect: false }],
    ['merge.renames off', '[merge]\n\trenames = false\n', { detect: false }],
    [
      'merge.renames on over diff.renames off',
      '[diff]\n\trenames = false\n[merge]\n\trenames = true\n',
      { detect: true },
    ],
    [
      'merge.renames off over diff.renames on',
      '[diff]\n\trenames = true\n[merge]\n\trenames = false\n',
      { detect: false },
    ],
    ['merge.renames copies', '[merge]\n\trenames = copies\n', { detect: true }],
    [
      'merge.renames COPY',
      '[merge]\n\trenames = COPY\n[diff]\n\trenames = false\n',
      { detect: true },
    ],
    ['diff.renames copy over nothing', '[diff]\n\trenames = Copy\n', { detect: true }],
    ['directory renames on', '[merge]\n\tdirectoryRenames = true\n', { directoryRenames: 'apply' }],
    [
      'directory renames off',
      '[merge]\n\tdirectoryRenames = false\n',
      { directoryRenames: 'none' },
    ],
    [
      'directory renames conflict',
      '[merge]\n\tdirectoryRenames = conflict\n',
      { directoryRenames: 'conflict' },
    ],
    [
      'directory renames of a future value',
      '[merge]\n\tdirectoryRenames = whatever\n',
      { directoryRenames: 'conflict' },
    ],
  ] as const)('Given %s', (_title, config, expected) => {
    describe('When it is read', () => {
      it('Then the resolved configuration reflects it', async () => {
        // Arrange
        const ctx = await withConfig(config);
        const sut = readMergeRenameConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ ...DEFAULTS, ...expected });
      });
    });
  });

  describe.each([
    [
      'diff.renameLimit',
      '[diff]\n\trenameLimit = 2147483648\n',
      'diff.renamelimit',
      'out of range',
    ],
    [
      'merge.renameLimit',
      '[merge]\n\trenameLimit = -2147483649\n',
      'merge.renamelimit',
      'out of range',
    ],
    ['merge.renameLimit', '[merge]\n\trenameLimit = 12q\n', 'merge.renamelimit', 'invalid unit'],
  ] as const)('Given %s beyond the C int grammar', (_title, config, key, reason) => {
    describe('When it is read', () => {
      it('Then it is refused as a bad numeric value', async () => {
        // Arrange
        const ctx = await withConfig(config);
        const sut = readMergeRenameConfig;

        // Act
        const result = await refusalData(sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key,
          source: `${ctx.layout.gitDir}/config`,
          value: config.split('= ')[1]?.trim(),
          reason,
        });
      });
    });
  });

  describe('Given a valueless rename limit', () => {
    describe('When it is read', () => {
      it('Then it is refused as a missing value at its line', async () => {
        // Arrange
        const ctx = await withConfig('[merge]\n\trenameLimit\n');
        const sut = readMergeRenameConfig;

        // Act
        const result = await refusalData(sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'merge.renamelimit',
          source: `${ctx.layout.gitDir}/config`,
          line: 2,
        });
      });
    });
  });

  describe('Given a rename setting that is no boolean', () => {
    describe('When it is read', () => {
      it('Then it is refused as a bad boolean value', async () => {
        // Arrange
        const ctx = await withConfig('[diff]\n\trenames = sometimes\n');
        const sut = readMergeRenameConfig;

        // Act
        const result = await refusalData(sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'diff.renames',
          source: `${ctx.layout.gitDir}/config`,
          value: 'sometimes',
        });
      });
    });
  });
});

describe('readConflictStyle', () => {
  describe('Given no merge.conflictStyle', () => {
    describe('When it is read', () => {
      it('Then no style is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = readConflictStyle;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe.each(['merge', 'diff3', 'zdiff3'] as const)('Given the style %s', (style) => {
    describe('When it is read', () => {
      it('Then that style is chosen', async () => {
        // Arrange
        const ctx = await withConfig(`[merge]\n\tconflictStyle = ${style}\n`);
        const sut = readConflictStyle;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(style);
      });
    });
  });

  describe('Given a style git does not know', () => {
    describe('When it is read', () => {
      it('Then it is refused as an unknown value at its line', async () => {
        // Arrange
        const ctx = await withConfig('[merge]\n\tconflictStyle = bogus\n');
        const sut = readConflictStyle;

        // Act
        const result = await refusalData(sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_UNKNOWN_VALUE',
          key: 'merge.conflictstyle',
          value: 'bogus',
          source: `${ctx.layout.gitDir}/config`,
          line: 2,
        });
      });
    });
  });
});

describe('readMergeRenormalize', () => {
  describe('Given no merge.renormalize', () => {
    describe('When it is read', () => {
      it('Then no choice is made', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = readMergeRenormalize;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe.each([
    ['true', '[merge]\n\trenormalize = true\n', true],
    ['false', '[merge]\n\trenormalize = false\n', false],
    ['valueless', '[merge]\n\trenormalize\n', true],
    ['the last of two', '[merge]\n\trenormalize = true\n\trenormalize = no\n', false],
  ])('Given merge.renormalize %s', (_label, config, expected) => {
    describe('When it is read', () => {
      it('Then it reads as the boolean', async () => {
        // Arrange
        const ctx = await withConfig(config);
        const sut = readMergeRenormalize;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given merge.renormalize = foo', () => {
    describe('When it is read', () => {
      it('Then it is refused as a bad boolean value', async () => {
        // Arrange
        const ctx = await withConfig('[merge]\n\trenormalize = foo\n');
        const sut = readMergeRenormalize;

        // Act
        const result = await refusalData(sut(ctx));

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'merge.renormalize',
          value: 'foo',
        });
      });
    });
  });
});
