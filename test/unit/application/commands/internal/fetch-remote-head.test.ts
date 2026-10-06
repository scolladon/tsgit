import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  followRemoteHead,
  readRemoteHeadPolicy,
} from '../../../../../src/application/commands/internal/fetch-remote-head.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import { getRefStore } from '../../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../../src/application/primitives/reflog-store.js';
import { updateRef } from '../../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../../src/application/primitives/write-symbolic-ref.js';
import type { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Advertisement } from '../../../../../src/domain/protocol/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const ORIGIN_HEAD = 'refs/remotes/origin/HEAD' as RefName;
const ZERO = '0'.repeat(40);

const repoWithTracking = async (): Promise<{ ctx: Context; id: ObjectId; warnings: string[] }> => {
  const warnings: string[] = [];
  const base = createMemoryContext();
  const ctx = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a`, 'a');
  await add(ctx, ['a']);
  const author = { name: 'A', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' };
  const { id } = await commit(ctx, { message: 'a', author });
  for (const name of ['main', 'side']) {
    await updateRef(ctx, `refs/remotes/origin/${name}` as RefName, id, { reflogMessage: 'seed' });
  }
  return { ctx, id, warnings };
};

const advertising = (id: ObjectId, symref: string | undefined, branches = ['main', 'side']) =>
  ({
    capabilities: symref === undefined ? [] : [`symref=HEAD:${symref}`],
    refs: [
      { name: 'HEAD', id },
      ...branches.map((branch) => ({ name: `refs/heads/${branch}`, id })),
    ],
  }) as Advertisement;

const originHead = async (ctx: Context) => getRefStore(ctx).resolveDirect(ORIGIN_HEAD);

const originHeadLog = async (ctx: Context) =>
  (await readReflog(ctx, ORIGIN_HEAD)).map((e) => [e.oldId, e.newId, e.message]);

describe('followRemoteHead', () => {
  describe('Given no local remote HEAD and a remote HEAD naming main', () => {
    describe('When the policy is create', () => {
      it('Then refs/remotes/origin/HEAD points at origin/main with a "fetch" reflog entry', async () => {
        // Arrange
        const { ctx, id } = await repoWithTracking();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/main'), { mode: 'create' });

        // Assert
        expect(await originHead(ctx)).toEqual({
          kind: 'symbolic',
          target: 'refs/remotes/origin/main',
        });
        expect(await originHeadLog(ctx)).toEqual([[ZERO, id, 'fetch']]);
      });
    });

    describe('When the policy is never', () => {
      it('Then no remote HEAD is written', async () => {
        // Arrange
        const { ctx, id } = await repoWithTracking();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/main'), { mode: 'never' });

        // Assert
        expect(await originHead(ctx)).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given a local remote HEAD naming main and a remote HEAD naming side', () => {
    const arrange = async () => {
      const repo = await repoWithTracking();
      await writeSymbolicRef(repo.ctx, ORIGIN_HEAD, 'refs/remotes/origin/main' as RefName);
      return repo;
    };

    describe('When the policy is create', () => {
      it('Then the local remote HEAD is kept and nothing is reported', async () => {
        // Arrange
        const { ctx, id, warnings } = await arrange();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/side'), { mode: 'create' });

        // Assert
        expect(await originHead(ctx)).toEqual({
          kind: 'symbolic',
          target: 'refs/remotes/origin/main',
        });
        expect(warnings).toEqual([]);
      });
    });

    describe('When the policy is always', () => {
      it('Then the local remote HEAD follows to side with a "fetch" reflog entry', async () => {
        // Arrange
        const { ctx, id } = await arrange();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/side'), { mode: 'always' });

        // Assert
        expect(await originHead(ctx)).toEqual({
          kind: 'symbolic',
          target: 'refs/remotes/origin/side',
        });
        expect((await originHeadLog(ctx)).at(-1)).toEqual([id, id, 'fetch']);
      });
    });

    describe('When the policy is warn', () => {
      it('Then the local remote HEAD is kept and the difference is reported', async () => {
        // Arrange
        const { ctx, id, warnings } = await arrange();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/side'), { mode: 'warn' });

        // Assert
        expect(await originHead(ctx)).toEqual({
          kind: 'symbolic',
          target: 'refs/remotes/origin/main',
        });
        expect(warnings).toEqual(["'HEAD' at 'origin' is 'side', but we have 'main' locally."]);
      });
    });

    describe('When the policy is warn unless the remote HEAD is side', () => {
      it('Then nothing is reported', async () => {
        // Arrange
        const { ctx, id, warnings } = await arrange();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/side'), {
          mode: 'warn',
          noWarnBranch: 'side',
        });

        // Assert
        expect(warnings).toEqual([]);
      });
    });

    describe('When the policy is warn unless the remote HEAD is another branch', () => {
      it('Then the difference is reported', async () => {
        // Arrange
        const { ctx, id, warnings } = await arrange();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/side'), {
          mode: 'warn',
          noWarnBranch: 'branch-side',
        });

        // Assert
        expect(warnings).toEqual(["'HEAD' at 'origin' is 'side', but we have 'main' locally."]);
      });
    });
  });

  describe('Given a detached local remote HEAD', () => {
    describe('When the policy is warn', () => {
      it('Then the detached HEAD is kept and reported', async () => {
        // Arrange
        const { ctx, id, warnings } = await repoWithTracking();
        await updateRef(ctx, ORIGIN_HEAD, id, { reflogMessage: 'seed' });
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/side'), { mode: 'warn' });

        // Assert
        expect(await originHead(ctx)).toEqual({ kind: 'direct', id });
        expect(warnings).toEqual([
          `'HEAD' at 'origin' is 'side', but we have a detached HEAD pointing to '${id}' locally.`,
        ]);
      });
    });
  });

  describe('Given a remote HEAD advertised without its symref', () => {
    describe('When exactly one remote branch carries its oid', () => {
      it('Then that branch is taken as the remote HEAD', async () => {
        // Arrange
        const { ctx, id } = await repoWithTracking();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, undefined, ['side']), { mode: 'create' });

        // Assert
        expect(await originHead(ctx)).toEqual({
          kind: 'symbolic',
          target: 'refs/remotes/origin/side',
        });
      });
    });

    describe('When several remote branches carry its oid', () => {
      it('Then no remote HEAD is written', async () => {
        // Arrange
        const { ctx, id } = await repoWithTracking();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, undefined), { mode: 'create' });

        // Assert
        expect(await originHead(ctx)).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given an advertisement without HEAD', () => {
    describe('When the policy is create', () => {
      it('Then no remote HEAD is written', async () => {
        // Arrange
        const { ctx, id } = await repoWithTracking();
        const advertisement = { capabilities: [], refs: [{ name: 'refs/heads/main', id }] };
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertisement as Advertisement, { mode: 'create' });

        // Assert
        expect(await originHead(ctx)).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given a remote HEAD whose tracking ref is absent locally', () => {
    describe('When the policy is create', () => {
      it('Then no remote HEAD is written', async () => {
        // Arrange
        const { ctx, id } = await repoWithTracking();
        const sut = followRemoteHead;

        // Act
        await sut(ctx, 'origin', advertising(id, 'refs/heads/other', ['other']), {
          mode: 'create',
        });

        // Assert
        expect(await originHead(ctx)).toEqual({ kind: 'missing' });
      });
    });
  });
});

describe('readRemoteHeadPolicy', () => {
  describe.each([
    { values: [], expected: { mode: 'create' } },
    { values: ['never'], expected: { mode: 'never' } },
    { values: ['always'], expected: { mode: 'always' } },
    { values: ['warn-if-not-side', 'warn'], expected: { mode: 'warn' } },
    { values: ['warn-if-not-side'], expected: { mode: 'warn', noWarnBranch: 'side' } },
    { values: ['always', 'create'], expected: { mode: 'create' } },
    { values: ['always', 'bogus'], expected: { mode: 'always' } },
  ])('Given remote.origin.followRemoteHEAD set to $values', ({ values, expected }) => {
    describe('When read', () => {
      it('Then the last recognised value wins', async () => {
        // Arrange
        const { ctx } = await repoWithTracking();
        const lines = values.map((value) => `\tfollowRemoteHEAD = ${value}\n`).join('');
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, `[remote "origin"]\n${lines}`);
        invalidateConfigCache(ctx);
        const sut = readRemoteHeadPolicy;

        // Act
        const result = await sut(ctx, 'origin');

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given an unrecognised followRemoteHEAD value', () => {
    describe('When read', () => {
      it('Then git warns that it is ignored', async () => {
        // Arrange
        const { ctx, warnings } = await repoWithTracking();
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n\tfollowRemoteHEAD = bogus\n',
        );
        invalidateConfigCache(ctx);
        const sut = readRemoteHeadPolicy;

        // Act
        await sut(ctx, 'origin');

        // Assert
        expect(warnings).toEqual(["unrecognized followRemoteHEAD value 'bogus' ignored"]);
      });
    });
  });
});
