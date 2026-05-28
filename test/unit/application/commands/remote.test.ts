import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import { remote } from '../../../../src/application/commands/remote.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

const seed = async (ctx: Context, content?: string): Promise<void> => {
  await init(ctx);
  if (content !== undefined) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
    __resetConfigCacheForTests();
  }
};

describe('application/commands/remote', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('list', () => {
    describe('Given a non-repository', () => {
      describe('When remote({ kind: list }) runs', () => {
        it('Then it throws NOT_A_REPOSITORY', async () => {
          // Arrange
          const ctx = createMemoryContext();
          let caught: unknown;

          // Act
          try {
            await remote(ctx, { kind: 'list' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });

    describe('Given an initialized repo with no remotes', () => {
      describe('When remote({ kind: list }) runs', () => {
        it('Then it returns an empty list', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const sut = await remote(ctx, { kind: 'list' });

          // Assert
          expect(sut).toEqual({ kind: 'list', remotes: [] });
        });
      });
    });

    describe('Given a single remote origin', () => {
      describe('When remote({ kind: list }) runs', () => {
        it('Then it returns the entry with url and fetch refspec', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          const sut = await remote(ctx, { kind: 'list' });

          // Assert
          expect(sut).toEqual({
            kind: 'list',
            remotes: [
              {
                name: 'origin',
                url: 'https://e.com/r.git',
                pushUrl: undefined,
                fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
              },
            ],
          });
        });
      });
    });

    describe('Given a remote with both url and pushurl', () => {
      describe('When remote({ kind: list }) runs', () => {
        it('Then pushUrl is populated', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tpushurl = git@e.com:r.git\n',
          );

          // Act
          const sut = await remote(ctx, { kind: 'list' });

          // Assert
          if (sut.kind !== 'list') throw new Error('unreachable');
          expect(sut.remotes[0]?.pushUrl).toBe('git@e.com:r.git');
        });
      });
    });

    describe('Given multiple remotes', () => {
      describe('When remote({ kind: list }) runs', () => {
        it('Then they come back sorted by name byte-wise', async () => {
          // Arrange — write in non-sorted order to prove the sort.
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "zeta"]\n\turl = z\n[remote "alpha"]\n\turl = a\n[remote "mid"]\n\turl = m\n',
          );

          // Act
          const sut = await remote(ctx, { kind: 'list' });

          // Assert
          if (sut.kind !== 'list') throw new Error('unreachable');
          expect(sut.remotes.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta']);
        });
      });
    });
  });
});
