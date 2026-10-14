import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { status } from '../../../../src/application/commands/status.js';
import {
  filterChoiceFromSources,
  resolveFilterDriver,
} from '../../../../src/application/primitives/resolve-filter-driver.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

vi.mock(
  '../../../../src/application/primitives/resolve-filter-driver.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/application/primitives/resolve-filter-driver.js')
      >();
    return {
      ...actual,
      resolveFilterDriver: vi.fn(actual.resolveFilterDriver),
      filterChoiceFromSources: vi.fn(actual.filterChoiceFromSources),
    };
  },
);

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const FILES = ['a.txt', 'b.txt', 'c.txt'];
const T0 = 1_700_000_000_000;

/** Three committed files under `* text=auto`, each rewritten later so its stat no longer matches. */
const seedModifiedStatRepository = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* text=auto\n');
  for (const file of FILES) await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, file);
  // The index lands after the files, so no entry is racy against it.
  vi.setSystemTime(T0 + 10_000);
  await add(ctx, ['.gitattributes', ...FILES]);
  await commit(ctx, { message: 'first', author: AUTHOR });
  vi.setSystemTime(T0 + 60_000);
  for (const file of FILES) await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, file);
  // Later than the rewrites, so the refresh write-back finds no racy entry to re-hash.
  vi.setSystemTime(T0 + 120_000);
  return ctx;
};

describe('Given .gitattributes "* text=auto", no [filter] section and three modified-stat files', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('When status runs', () => {
    it('Then no filter driver is resolved and the result equals one with an unused [filter] section', async () => {
      // Arrange
      const ctx = await seedModifiedStatRepository('[core]\n\tbare = false\n');
      vi.mocked(resolveFilterDriver).mockClear();
      vi.mocked(filterChoiceFromSources).mockClear();
      const sut = status;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(vi.mocked(resolveFilterDriver)).not.toHaveBeenCalled();
      expect(vi.mocked(filterChoiceFromSources)).not.toHaveBeenCalled();
      const withSection = await seedModifiedStatRepository(
        '[core]\n\tbare = false\n[filter "x"]\n\tclean = cat\n',
      );
      expect(await sut(withSection)).toEqual(result);
    });
  });
});
