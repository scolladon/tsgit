/**
 * Builtins whose prologue runs `prepare_repo_settings` before reading their
 * config — `diff`, `merge` (and `--abort`/`--continue`), `rebase` (and
 * `--continue`/`--skip`/`--abort`), `pack-objects` — name a malformed
 * repo-settings key ahead of a malformed eager `[core]` key on an earlier
 * line; every other builtin names the eager key first.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { mergeAbort } from '../../../../src/application/commands/abort-merge.js';
import { mergeContinue } from '../../../../src/application/commands/continue-merge.js';
import { diff } from '../../../../src/application/commands/diff.js';
import { log } from '../../../../src/application/commands/log.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { packObjects } from '../../../../src/application/commands/pack-objects.js';
import {
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from '../../../../src/application/commands/rebase.js';
import type { Context } from '../../../../src/ports/context.js';

/** An unborn repository whose config holds a bad eager key above a bad repo-settings key. */
const repoWithBothClassesBad = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/config`,
    '[core]\n\tignorecase = x\n\tmaxTreeDepth = x\n',
  );
  return ctx;
};

/** The config key a command's refusal names. */
const refusedKey = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as { readonly data?: { readonly key?: unknown } }).data?.key;
  }
};

describe('Given a malformed core.ignorecase above a malformed core.maxTreeDepth', () => {
  describe.each([
    { verb: 'diff', run: (ctx: Context) => diff(ctx), key: 'core.maxtreedepth' },
    {
      verb: 'merge',
      run: (ctx: Context) => mergeRun(ctx, { rev: 'HEAD' }),
      key: 'core.maxtreedepth',
    },
    { verb: 'merge --abort', run: (ctx: Context) => mergeAbort(ctx), key: 'core.maxtreedepth' },
    {
      verb: 'merge --continue',
      run: (ctx: Context) => mergeContinue(ctx),
      key: 'core.maxtreedepth',
    },
    {
      verb: 'rebase',
      run: (ctx: Context) => rebaseRun(ctx, { upstream: 'HEAD' }),
      key: 'core.maxtreedepth',
    },
    {
      verb: 'rebase --continue',
      run: (ctx: Context) => rebaseContinue(ctx),
      key: 'core.maxtreedepth',
    },
    { verb: 'rebase --skip', run: (ctx: Context) => rebaseSkip(ctx), key: 'core.maxtreedepth' },
    { verb: 'rebase --abort', run: (ctx: Context) => rebaseAbort(ctx), key: 'core.maxtreedepth' },
    {
      verb: 'pack-objects',
      run: (ctx: Context) => packObjects(ctx, { wants: ['HEAD'] }),
      key: 'core.maxtreedepth',
    },
    { verb: 'log', run: (ctx: Context) => log(ctx), key: 'core.ignorecase' },
  ])('When $verb runs', ({ run, key }) => {
    it(`Then it names ${key}, as git does`, async () => {
      // Arrange
      const ctx = await repoWithBothClassesBad();
      const sut = run;

      // Act
      const result = await refusedKey(() => sut(ctx));

      // Assert
      expect(result).toBe(key);
    });
  });
});
