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

  describe('add', () => {
    describe('Given a new name and url', () => {
      describe('When remote({ kind: add }) runs', () => {
        it('Then the [remote] block is written with the canonical default fetch refspec', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const sut = await remote(ctx, {
            kind: 'add',
            name: 'upstream',
            url: 'https://e.com/up.git',
          });

          // Assert — result payload reflects what was written.
          expect(sut.kind).toBe('add');
          if (sut.kind !== 'add') throw new Error('unreachable');
          expect(sut.remote.name).toBe('upstream');
          expect(sut.remote.url).toBe('https://e.com/up.git');
          expect(sut.remote.fetchRefspecs).toEqual(['+refs/heads/*:refs/remotes/upstream/*']);
          // On-disk config matches.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "upstream"]');
          expect(written).toContain('url = https://e.com/up.git');
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/upstream/*');
        });
      });
    });

    describe('Given a custom fetch refspec', () => {
      describe('When remote({ kind: add, fetch }) runs', () => {
        it('Then the custom refspec is written verbatim', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const sut = await remote(ctx, {
            kind: 'add',
            name: 'upstream',
            url: 'https://e.com/u.git',
            fetch: '+refs/heads/release:refs/remotes/upstream/release',
          });

          // Assert
          if (sut.kind !== 'add') throw new Error('unreachable');
          expect(sut.remote.fetchRefspecs).toEqual([
            '+refs/heads/release:refs/remotes/upstream/release',
          ]);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('fetch = +refs/heads/release:refs/remotes/upstream/release');
          expect(written).not.toContain('refs/heads/*');
        });
      });
    });

    describe('Given an already-configured remote name', () => {
      describe('When remote({ kind: add }) runs with the same name', () => {
        it('Then it throws REMOTE_EXISTS', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remote(ctx, {
              kind: 'add',
              name: 'origin',
              url: 'https://e.com/new.git',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('REMOTE_EXISTS');
          if (data.code !== 'REMOTE_EXISTS') throw new Error('unreachable');
          expect(data.remote).toBe('origin');
        });
      });
    });

    describe('Given an empty name', () => {
      describe('When remote({ kind: add }) runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remote(ctx, { kind: 'add', name: '', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a name with a newline', () => {
      describe('When remote({ kind: add }) runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remote(ctx, { kind: 'add', name: 'a\nb', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a name with a closing bracket', () => {
      describe('When remote({ kind: add }) runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remote(ctx, { kind: 'add', name: 'a]b', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a url containing a newline', () => {
      describe('When remote({ kind: add }) runs', () => {
        it('Then it throws INVALID_OPTION', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remote(ctx, {
              kind: 'add',
              name: 'origin',
              url: 'https://e.com/\nrest',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
        });
      });
    });

    describe('Given a malformed custom fetch refspec', () => {
      describe('When remote({ kind: add, fetch }) runs', () => {
        it('Then it throws REFSPEC_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remote(ctx, {
              kind: 'add',
              name: 'origin',
              url: 'u',
              fetch: '',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REFSPEC_INVALID');
        });
      });
    });
  });
});
