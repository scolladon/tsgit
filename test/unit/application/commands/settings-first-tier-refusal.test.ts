/**
 * The builtins that name repo settings first still take the operational tier:
 * a repository git refuses is refused before any of them reads its state.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { mergeAbort } from '../../../../src/application/commands/abort-merge.js';
import {
  cherryPickAbort,
  cherryPickContinue,
  cherryPickRun,
  cherryPickSkip,
} from '../../../../src/application/commands/cherry-pick.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { mergeContinue } from '../../../../src/application/commands/continue-merge.js';
import { diff } from '../../../../src/application/commands/diff.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { packObjects } from '../../../../src/application/commands/pack-objects.js';
import {
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from '../../../../src/application/commands/rebase.js';
import {
  revertAbort,
  revertContinue,
  revertRun,
  revertSkip,
} from '../../../../src/application/commands/revert.js';
import { status } from '../../../../src/application/commands/status.js';
import type { Context } from '../../../../src/ports/context.js';

const REFUSED_VERSION = 99;

/** An unborn repository whose format version git refuses. */
const rejectedRepository = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return {
    ...ctx,
    layout: { ...ctx.layout, formatRefusal: { kind: 'version', version: REFUSED_VERSION } },
  };
};

/** The refusal data a command raises, or undefined when it does not throw. */
const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as { readonly data?: unknown }).data;
  }
};

describe('Given a repository whose format version git refuses', () => {
  describe.each([
    { verb: 'commit', run: (ctx: Context) => commit(ctx, { message: 'm' }) },
    { verb: 'status', run: (ctx: Context) => status(ctx) },
    { verb: 'diff', run: (ctx: Context) => diff(ctx) },
    { verb: 'merge', run: (ctx: Context) => mergeRun(ctx, { rev: 'HEAD' }) },
    { verb: 'merge --abort', run: (ctx: Context) => mergeAbort(ctx) },
    { verb: 'merge --continue', run: (ctx: Context) => mergeContinue(ctx) },
    { verb: 'rebase', run: (ctx: Context) => rebaseRun(ctx, { upstream: 'HEAD' }) },
    { verb: 'rebase --continue', run: (ctx: Context) => rebaseContinue(ctx) },
    { verb: 'rebase --skip', run: (ctx: Context) => rebaseSkip(ctx) },
    { verb: 'rebase --abort', run: (ctx: Context) => rebaseAbort(ctx) },
    { verb: 'cherry-pick', run: (ctx: Context) => cherryPickRun(ctx, { commits: ['HEAD'] }) },
    { verb: 'cherry-pick --continue', run: (ctx: Context) => cherryPickContinue(ctx) },
    { verb: 'cherry-pick --skip', run: (ctx: Context) => cherryPickSkip(ctx) },
    { verb: 'cherry-pick --abort', run: (ctx: Context) => cherryPickAbort(ctx) },
    { verb: 'revert', run: (ctx: Context) => revertRun(ctx, { commits: ['HEAD'] }) },
    { verb: 'revert --continue', run: (ctx: Context) => revertContinue(ctx) },
    { verb: 'revert --skip', run: (ctx: Context) => revertSkip(ctx) },
    { verb: 'revert --abort', run: (ctx: Context) => revertAbort(ctx) },
    { verb: 'pack-objects', run: (ctx: Context) => packObjects(ctx, { wants: ['HEAD'] }) },
  ])('When $verb runs', ({ run }) => {
    it('Then it refuses the repository format version, as git does', async () => {
      // Arrange
      const ctx = await rejectedRepository();
      const sut = run;

      // Act
      const result = await refusalOf(() => sut(ctx));

      // Assert
      expect(result).toEqual({
        code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
        version: REFUSED_VERSION,
      });
    });
  });
});
