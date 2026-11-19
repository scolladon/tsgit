import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { __resetSectionsCacheForTests } from '../../../../src/application/primitives/config-scoped-read.js';
import { commonGitDir } from '../../../../src/application/primitives/path-layout.js';
import { readExecutableBitTrust } from '../../../../src/application/primitives/read-executable-bit-trust.js';
import type { ExecutableBitTrust } from '../../../../src/domain/objects/file-mode.js';
import type { Context } from '../../../../src/ports/context.js';

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
const FILEMODE_OFF = '\tfilemode = false\n';

interface Row {
  readonly id: string;
  readonly local: string;
  readonly worktree: string;
  readonly expected: ExecutableBitTrust;
}

const ROWS: ReadonlyArray<Row> = [
  { id: 'C1 nothing set', local: '', worktree: '', expected: 'trusted' },
  { id: 'local false', local: `[core]\n${FILEMODE_OFF}`, worktree: '', expected: 'ignored' },
  {
    id: 'C2 worktree false over local true',
    local: `${EXT_ON}[core]\n\tfilemode = true\n`,
    worktree: `[core]\n${FILEMODE_OFF}`,
    expected: 'ignored',
  },
  {
    id: 'C2b worktree true over local false',
    local: `${EXT_ON}[core]\n${FILEMODE_OFF}`,
    worktree: '[core]\n\tfilemode = true\n',
    expected: 'trusted',
  },
  {
    id: 'C2c worktree false with the extension off',
    local: '',
    worktree: `[core]\n${FILEMODE_OFF}`,
    expected: 'trusted',
  },
  {
    id: 'C2c worktree false with the extension false',
    local: '[extensions]\n\tworktreeConfig = false\n',
    worktree: `[core]\n${FILEMODE_OFF}`,
    expected: 'trusted',
  },
  {
    id: 'C7 empty value',
    local: '[core]\n\tfilemode =\n',
    worktree: '',
    expected: 'ignored',
  },
  { id: 'C7 valueless', local: '[core]\n\tfilemode\n', worktree: '', expected: 'trusted' },
  { id: 'C7 No', local: '[core]\n\tfilemode = No\n', worktree: '', expected: 'ignored' },
  { id: 'C7 zero', local: '[core]\n\tfilemode = 0\n', worktree: '', expected: 'ignored' },
  {
    id: 'C7 worktree false then true',
    local: EXT_ON,
    worktree: `[core]\n${FILEMODE_OFF}\tfilemode = true\n`,
    expected: 'trusted',
  },
  {
    id: 'C7 worktree bogus over local false',
    local: `${EXT_ON}[core]\n${FILEMODE_OFF}`,
    worktree: '[core]\n\tfilemode = bogus\n',
    expected: 'ignored',
  },
  {
    id: 'C7 worktree key under a subsection',
    local: EXT_ON,
    worktree: `[core "x"]\n${FILEMODE_OFF}`,
    expected: 'trusted',
  },
];

describe('primitives/read-executable-bit-trust', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe.each(ROWS)('Given the local and worktree files of row $id', (row) => {
    describe('When readExecutableBitTrust', () => {
      it('Then it resolves the expected trust', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedLocal(ctx, row.local);
        await seedWorktree(ctx, row.worktree);
        const sut = readExecutableBitTrust;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(row.expected);
      });
    });
  });

  describe('Given only the linked worktree file sets filemode = false', () => {
    describe('When readExecutableBitTrust runs for each worktree', () => {
      it('Then only the linked context ignores the bit', async () => {
        // Arrange
        const main = createMemoryContext();
        const wt = linked(main);
        await seedLocal(main, EXT_ON);
        await seedWorktree(wt, `[core]\n${FILEMODE_OFF}`);
        const sut = readExecutableBitTrust;

        // Act
        const inLinked = await sut(wt);
        const inMain = await sut(main);

        // Assert
        expect(inLinked).toBe('ignored');
        expect(inMain).toBe('trusted');
      });
    });
  });
});
