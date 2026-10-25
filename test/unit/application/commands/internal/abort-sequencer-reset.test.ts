import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  abortSequencerReset,
  skipSequencerReset,
} from '../../../../../src/application/commands/internal/abort-sequencer-reset.js';
import { readOrigHead } from '../../../../../src/application/commands/internal/merge-state.js';
import { readSequencerHead } from '../../../../../src/application/commands/internal/sequencer-state.js';
import { resolveRef } from '../../../../../src/application/primitives/resolve-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const HEAD = 'HEAD' as RefName;

interface StoppedPick {
  readonly ctx: Context;
  readonly first: ObjectId;
  readonly second: ObjectId;
}

const writeWork = (ctx: Context, rel: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);

const commitFile = async (ctx: Context, content: string): Promise<ObjectId> => {
  await writeWork(ctx, 'f', content);
  await add(ctx, ['f']);
  return (await commit(ctx, { message: content, author })).id;
};

const replaceFileWithDirectory = async (ctx: Context): Promise<void> => {
  await ctx.fs.rm(`${ctx.layout.workDir}/f`);
  await writeWork(ctx, 'f/u', 'untracked\n');
};

const stoppedPick = async (): Promise<StoppedPick> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const first = await commitFile(ctx, 'v1\n');
  const second = await commitFile(ctx, 'v2\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/sequencer/head`, `${first}\n`);
  return { ctx, first, second };
};

const catchData = async (run: () => Promise<void>): Promise<Record<string, unknown>> => {
  try {
    await run();
  } catch (err) {
    return (err as { data: Record<string, unknown> }).data;
  }
  throw new Error('expected a refusal');
};

describe('skipSequencerReset', () => {
  describe('Given a directory replacing a file the stopped pick changed', () => {
    describe('When skipSequencerReset runs', () => {
      it('Then it refuses with the first local change and leaves ORIG_HEAD absent and HEAD put', async () => {
        // Arrange
        const { ctx, second } = await stoppedPick();
        await writeWork(ctx, 'f', 'v3\n');
        await add(ctx, ['f']);
        await replaceFileWithDirectory(ctx);

        // Act
        const data = await catchData(() => skipSequencerReset(ctx, second));

        // Assert
        expect(data).toMatchObject({
          code: 'WORKING_TREE_DIRTY',
          localChanges: ['f'],
          untracked: [],
        });
        expect(await readOrigHead(ctx)).toBeUndefined();
        expect(await resolveRef(ctx, HEAD)).toBe(second);
      });
    });
  });

  describe('Given a clean stopped pick', () => {
    describe('When skipSequencerReset runs', () => {
      it('Then ORIG_HEAD is the HEAD it left', async () => {
        // Arrange
        const { ctx, second } = await stoppedPick();

        // Act
        await skipSequencerReset(ctx, second);

        // Assert
        expect(await readOrigHead(ctx)).toBe(second);
      });
    });
  });
});

describe('abortSequencerReset', () => {
  describe('Given a directory replacing a file the target differs on', () => {
    describe('When abortSequencerReset runs', () => {
      it('Then it refuses with the first local change and leaves HEAD, ORIG_HEAD and sequencer put', async () => {
        // Arrange
        const { ctx, first, second } = await stoppedPick();
        await replaceFileWithDirectory(ctx);

        // Act
        const data = await catchData(() => abortSequencerReset(ctx, { target: first }));

        // Assert
        expect(data).toMatchObject({
          code: 'WORKING_TREE_DIRTY',
          localChanges: ['f'],
          untracked: [],
        });
        expect(await readOrigHead(ctx)).toBeUndefined();
        expect(await resolveRef(ctx, HEAD)).toBe(second);
        expect(await readSequencerHead(ctx)).toBe(first);
      });
    });
  });

  describe('Given a clean stopped pick', () => {
    describe('When abortSequencerReset runs', () => {
      it('Then HEAD moves to the target, ORIG_HEAD is the HEAD it left and the sequencer is gone', async () => {
        // Arrange
        const { ctx, first, second } = await stoppedPick();

        // Act
        await abortSequencerReset(ctx, { target: first });

        // Assert
        expect(await resolveRef(ctx, HEAD)).toBe(first);
        expect(await readOrigHead(ctx)).toBe(second);
        expect(await readSequencerHead(ctx)).toBeUndefined();
      });
    });
  });
});
