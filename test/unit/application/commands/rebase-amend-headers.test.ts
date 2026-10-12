import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  type RebaseInstruction,
  rebaseContinue,
  rebaseRun,
} from '../../../../src/application/commands/rebase.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { CommitData, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = { name: 'Ada', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' };
const MERGETAG = {
  key: 'mergetag',
  value: `object ${'1'.repeat(40)}\ntype commit\ntag t\ntagger T <t@x> 1700000000 +0000\n\nt`,
};
const CUSTOM = { key: 'x-custom', value: 'hello' };
const MAIN = 'refs/heads/main' as RefName;

const readCommit = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') throw new Error('not a commit');
  return object.data;
};

const commitFile = async (ctx: Context, name: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
  await add(ctx, [name]);
  return (await commit(ctx, { message: name, author: AUTHOR, committer: AUTHOR })).id;
};

/** base; X on base adds `x` and carries a gpgsig, a mergetag and a custom header; Y on X. */
const seedHeaderedCommit = async (): Promise<{
  ctx: Context;
  base: ObjectId;
  x: ObjectId;
  y: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  const base = await commitFile(ctx, 'a');
  const plain = await commitFile(ctx, 'x');
  const data: CommitData = {
    ...(await readCommit(ctx, plain)),
    message: 'X\n',
    gpgSignature: '-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----',
    extraHeaders: [MERGETAG, CUSTOM],
  };
  const x = await writeObject(ctx, { type: 'commit', id: '' as ObjectId, data });
  await updateRef(ctx, MAIN, x, { expected: plain, reflogMessage: 'headered' });
  const y = await commitFile(ctx, 'y');
  return { ctx, base, x, y };
};

const headerCarrier = async (ctx: Context, rev: 'HEAD' | 'HEAD~1'): Promise<CommitData> => {
  const head = await readCommit(ctx, await resolveRef(ctx, 'HEAD' as RefName));
  return rev === 'HEAD' ? head : readCommit(ctx, head.parents[0] as ObjectId);
};

describe('rebase amending a commit with extra headers', () => {
  describe.each([
    [
      'reword X',
      (x: ObjectId, y: ObjectId) => [
        { action: 'reword', oid: x, message: 'reworded' },
        { action: 'pick', oid: y },
      ],
      'HEAD~1',
    ],
    [
      'pick X then fixup Y',
      (x: ObjectId, y: ObjectId) => [
        { action: 'pick', oid: x },
        { action: 'fixup', oid: y },
      ],
      'HEAD',
    ],
  ] as const)('Given %s over a fast-forwarded X', (_, todo, carrier) => {
    describe('When the rebase amends X', () => {
      it('Then the amended commit keeps every extra header but the signature', async () => {
        // Arrange
        const { ctx, base, x, y } = await seedHeaderedCommit();
        const interactive = todo(x, y) as ReadonlyArray<RebaseInstruction>;

        // Act
        await rebaseRun(ctx, { upstream: base, interactive });
        const result = await headerCarrier(ctx, carrier);

        // Assert
        expect(result.extraHeaders).toEqual([MERGETAG, CUSTOM]);
        expect(result.gpgSignature).toBeUndefined();
      });
    });
  });

  describe('Given an edit stop on a fast-forwarded X with a change staged', () => {
    describe('When the rebase continues', () => {
      it('Then the amended commit keeps every extra header but the signature', async () => {
        // Arrange
        const { ctx, base, x, y } = await seedHeaderedCommit();
        const interactive: ReadonlyArray<RebaseInstruction> = [
          { action: 'edit', oid: x },
          { action: 'pick', oid: y },
        ];
        await rebaseRun(ctx, { upstream: base, interactive });
        await commitFileStaged(ctx, 'e');

        // Act
        await rebaseContinue(ctx);
        const result = await headerCarrier(ctx, 'HEAD~1');

        // Assert
        expect(result.extraHeaders).toEqual([MERGETAG, CUSTOM]);
        expect(result.gpgSignature).toBeUndefined();
      });
    });
  });

  describe('Given a fixup onto X that conflicts, resolved and staged', () => {
    describe('When the rebase continues', () => {
      it('Then the amended commit keeps every extra header but the signature', async () => {
        // Arrange
        const { ctx, base, x } = await seedHeaderedCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/y`, 'z\n');
        await add(ctx, ['y']);
        const z = (await commit(ctx, { message: 'Z', author: AUTHOR, committer: AUTHOR })).id;
        const interactive: ReadonlyArray<RebaseInstruction> = [
          { action: 'pick', oid: x },
          { action: 'fixup', oid: z },
        ];
        await rebaseRun(ctx, { upstream: base, interactive });
        await commitFileStaged(ctx, 'y');

        // Act
        await rebaseContinue(ctx);
        const result = await headerCarrier(ctx, 'HEAD');

        // Assert
        expect(result.extraHeaders).toEqual([MERGETAG, CUSTOM]);
        expect(result.gpgSignature).toBeUndefined();
      });
    });
  });
});

const commitFileStaged = async (ctx: Context, name: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
  await add(ctx, [name]);
};
