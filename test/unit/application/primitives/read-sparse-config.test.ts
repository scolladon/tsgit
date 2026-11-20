import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { __resetSectionsCacheForTests } from '../../../../src/application/primitives/config-scoped-read.js';
import { commonGitDir } from '../../../../src/application/primitives/path-layout.js';
import {
  isWorktreeConfigExtensionOn,
  readSparseConfig,
} from '../../../../src/application/primitives/read-sparse-config.js';
import type { Context } from '../../../../src/ports/context.js';
import { instrumentedContext } from './fixtures.js';

const seedLocal = (ctx: Context, text: string): Promise<void> =>
  ctx.fs.writeUtf8(`${commonGitDir(ctx)}/config`, text);
const seedWorktree = (ctx: Context, text: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config.worktree`, text);

const linked = (base: Context): Context => ({
  ...base,
  layout: {
    ...base.layout,
    gitDir: `${base.layout.gitDir}/worktrees/wt`,
    commonDir: base.layout.gitDir,
  },
});

const EXT_ON = '[extensions]\n\tworktreeConfig = true\n';
const SPARSE = '\tsparseCheckout = true\n';
const CONE = '\tsparseCheckoutCone = true\n';

interface Row {
  readonly id: string;
  readonly local: string;
  readonly worktree: string;
  readonly expected: { readonly enabled: boolean; readonly cone: boolean };
}

const ROWS: ReadonlyArray<Row> = [
  {
    id: 'R1',
    local: '',
    worktree: `[core]\n${SPARSE}${CONE}`,
    expected: { enabled: false, cone: false },
  },
  {
    id: 'R13',
    local: '[extensions]\n\tworktreeConfig = false\n',
    worktree: `[core]\n${SPARSE}${CONE}`,
    expected: { enabled: false, cone: false },
  },
  {
    id: 'R2',
    local: `${EXT_ON}[core]\n${CONE}`,
    worktree: `[core]\n${SPARSE}`,
    expected: { enabled: true, cone: true },
  },
  {
    id: 'R3',
    local: `${EXT_ON}[core]\n${SPARSE}`,
    worktree: '',
    expected: { enabled: true, cone: false },
  },
  {
    id: 'R4',
    local: `${EXT_ON}[core]\n${SPARSE}`,
    worktree: '[core]\n\tsparseCheckout = false\n',
    expected: { enabled: false, cone: false },
  },
  {
    id: 'R5',
    local: `${EXT_ON}[core]\n\tsparseCheckout = false\n`,
    worktree: `[core]\n${SPARSE}`,
    expected: { enabled: true, cone: false },
  },
  {
    id: 'R7',
    local: `${EXT_ON}[core]\n${CONE}`,
    worktree: `[core]\n${SPARSE}\tsparseCheckoutCone = false\n`,
    expected: { enabled: true, cone: false },
  },
  {
    id: 'R8',
    local: `${EXT_ON}[core]\n\tsparseCheckoutCone = false\n`,
    worktree: `[core]\n${SPARSE}${CONE}`,
    expected: { enabled: true, cone: true },
  },
  {
    id: 'R9',
    local: `[core]\n${SPARSE}${CONE}`,
    worktree: '[core]\n\tsparseCheckoutCone = false\n',
    expected: { enabled: true, cone: true },
  },
  {
    id: 'V1',
    local: EXT_ON,
    worktree: '[core]\n\tsparseCheckout\n',
    expected: { enabled: true, cone: false },
  },
  {
    id: 'D1',
    local: EXT_ON,
    worktree: `[core]\n${SPARSE}\tsparseCheckout = false\n`,
    expected: { enabled: false, cone: false },
  },
  {
    id: 'X1',
    local: '[extensions]\n\tworktreeConfig = yes\n',
    worktree: `[core]\n${SPARSE}`,
    expected: { enabled: true, cone: false },
  },
  {
    id: 'subsection guard',
    local: EXT_ON,
    worktree: `[core "x"]\n${SPARSE}`,
    expected: { enabled: false, cone: false },
  },
  {
    id: 'non-core section',
    local: EXT_ON,
    worktree: `[other]\n${SPARSE}`,
    expected: { enabled: false, cone: false },
  },
  {
    id: 'upper-case keys',
    local: EXT_ON,
    worktree: '[CORE]\n\tSPARSECHECKOUT = true\n',
    expected: { enabled: true, cone: false },
  },
  {
    id: 'bogus value',
    local: EXT_ON,
    worktree: '[core]\n\tsparseCheckout = bogus\n',
    expected: { enabled: false, cone: false },
  },
  {
    id: 'valid then bogus',
    local: EXT_ON,
    worktree: `[core]\n${SPARSE}\tsparseCheckout = bogus\n`,
    expected: { enabled: true, cone: false },
  },
];

describe('primitives/read-sparse-config', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe.each(ROWS)('Given the local and worktree files of row $id', (row) => {
    describe('When readSparseConfig', () => {
      it('Then the resolved pair is returned', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedLocal(ctx, row.local);
        await seedWorktree(ctx, row.worktree);
        const sut = readSparseConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ ...row.expected, expectFilesOutsideOfPatterns: false });
      });
    });
  });

  describe('Given the extension on and no worktree file', () => {
    describe('When readSparseConfig', () => {
      it('Then nothing is enabled', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedLocal(ctx, EXT_ON);
        const sut = readSparseConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({
          enabled: false,
          cone: false,
          expectFilesOutsideOfPatterns: false,
        });
      });
    });
  });

  describe('Given only the linked worktree file sets sparse', () => {
    describe('When readSparseConfig runs for each worktree', () => {
      it('Then only the linked context is sparse', async () => {
        // Arrange
        const main = createMemoryContext();
        const wt = linked(main);
        await seedLocal(main, EXT_ON);
        await seedWorktree(wt, `[core]\n${SPARSE}${CONE}`);
        const sut = readSparseConfig;

        // Act
        const inLinked = await sut(wt);
        const inMain = await sut(main);

        // Assert
        expect(inLinked).toEqual({
          enabled: true,
          cone: true,
          expectFilesOutsideOfPatterns: false,
        });
        expect(inMain).toEqual({
          enabled: false,
          cone: false,
          expectFilesOutsideOfPatterns: false,
        });
      });
    });
  });

  describe('Given only the main worktree file sets sparse', () => {
    describe('When readSparseConfig runs for each worktree', () => {
      it('Then only the main context is sparse', async () => {
        // Arrange
        const main = createMemoryContext();
        const wt = linked(main);
        await seedLocal(main, EXT_ON);
        await seedWorktree(main, `[core]\n${SPARSE}${CONE}`);
        const sut = readSparseConfig;

        // Act
        const inMain = await sut(main);
        const inLinked = await sut(wt);

        // Assert
        expect(inMain).toEqual({ enabled: true, cone: true, expectFilesOutsideOfPatterns: false });
        expect(inLinked).toEqual({
          enabled: false,
          cone: false,
          expectFilesOutsideOfPatterns: false,
        });
      });
    });
  });

  describe('Given a refused layout with the extension and worktree keys on', () => {
    describe('When readSparseConfig', () => {
      it('Then it resolves false without reading the worktree file', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedLocal(base, EXT_ON);
        await seedWorktree(base, `[core]\n${SPARSE}${CONE}`);
        const { ctx, calls } = instrumentedContext({
          ...base,
          layout: { ...base.layout, untrusted: true as const },
        });
        const sut = readSparseConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({
          enabled: false,
          cone: false,
          expectFilesOutsideOfPatterns: false,
        });
        expect(calls().filter((c) => c.path.endsWith('/config.worktree'))).toEqual([]);
      });
    });
  });
});

const EXPECT_KEY = 'expectFilesOutsideOfPatterns';

describe('primitives/read-sparse-config expectFilesOutsideOfPatterns', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('Given an unset expectFilesOutsideOfPatterns', () => {
    describe('When readSparseConfig runs', () => {
      it('Then expectFilesOutsideOfPatterns is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedLocal(ctx, '');
        const sut = readSparseConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.expectFilesOutsideOfPatterns).toBe(false);
      });
    });
  });

  describe.each([
    [
      'S4: config.worktree true with the extension on',
      EXT_ON,
      `[sparse]\n\t${EXPECT_KEY} = true\n`,
      true,
    ],
    ['E4: local true', `[sparse]\n\t${EXPECT_KEY} = true\n`, '', true],
    ['E4d: local 1', `[sparse]\n\t${EXPECT_KEY} = 1\n`, '', true],
    [
      'E4c: local true then false',
      `[sparse]\n\t${EXPECT_KEY} = true\n\t${EXPECT_KEY} = false\n`,
      '',
      false,
    ],
    ['O4: local valueless', `[sparse]\n\t${EXPECT_KEY}\n`, '', true],
    [
      'E4b: local true, worktree false, extension on',
      `${EXT_ON}[sparse]\n\t${EXPECT_KEY} = true\n`,
      `[sparse]\n\t${EXPECT_KEY} = false\n`,
      false,
    ],
    ['worktree true with the extension off', '', `[sparse]\n\t${EXPECT_KEY} = true\n`, false],
  ])('Given %s', (_label, local, worktree, expected) => {
    describe('When readSparseConfig runs', () => {
      it(`Then expectFilesOutsideOfPatterns is ${String(expected)}`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedLocal(ctx, local);
        await seedWorktree(ctx, worktree);
        const sut = readSparseConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.expectFilesOutsideOfPatterns).toBe(expected);
      });
    });
  });
});

describe('isWorktreeConfigExtensionOn', () => {
  describe.each([
    ['true', '[extensions]\n\tworktreeConfig = true\n', true],
    ['yes', '[extensions]\n\tworktreeConfig = yes\n', true],
    ['valueless', '[extensions]\n\tworktreeConfig\n', true],
    ['false', '[extensions]\n\tworktreeConfig = false\n', false],
    ['a refused value', '[extensions]\n\tworktreeConfig = bogus\n', false],
    ['absent', '[core]\n\tbare = false\n', false],
    ['under a subsection', '[extensions "x"]\n\tworktreeConfig = true\n', false],
  ])('Given the local config holds worktreeConfig as %s', (_label, text, expected) => {
    describe('When the extension is asked', () => {
      it(`Then it answers ${String(expected)}`, async () => {
        // Arrange
        __resetConfigCacheForTests();
        const ctx = createMemoryContext();
        await seedLocal(ctx, text);
        const sut = isWorktreeConfigExtensionOn;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isWorktreeConfigExtensionOn on a refused layout', () => {
  describe('Given the extension on in a repository whose format is refused', () => {
    describe('When the extension is asked', () => {
      it('Then it answers false', async () => {
        // Arrange
        __resetConfigCacheForTests();
        const base = createMemoryContext();
        await seedLocal(base, EXT_ON);
        const ctx: Context = {
          ...base,
          layout: { ...base.layout, formatRefusal: { kind: 'version', version: 99 } },
        };
        const sut = isWorktreeConfigExtensionOn;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
