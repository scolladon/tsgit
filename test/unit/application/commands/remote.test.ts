import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  remoteAdd,
  remoteList,
  remoteRemove,
  remoteRename,
  remoteSetUrl,
  remoteShow,
} from '../../../../src/application/commands/remote.js';
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
      describe('When remoteList runs', () => {
        it('Then it throws NOT_A_REPOSITORY', async () => {
          // Arrange
          const ctx = createMemoryContext();
          let caught: unknown;

          // Act
          try {
            await remoteList(ctx);
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
      describe('When remoteList runs', () => {
        it('Then it returns an empty list', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const sut = await remoteList(ctx);

          // Assert
          expect(sut).toEqual({ remotes: [] });
        });
      });
    });

    describe('Given a single remote origin', () => {
      describe('When remoteList runs', () => {
        it('Then it returns the entry with url and fetch refspec', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          const sut = await remoteList(ctx);

          // Assert
          expect(sut).toEqual({
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
      describe('When remoteList runs', () => {
        it('Then pushUrl is populated', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tpushurl = git@e.com:r.git\n',
          );

          // Act
          const sut = await remoteList(ctx);

          // Assert — no `fetch` key, so the refspec list defaults to empty.
          expect(sut.remotes[0]?.pushUrl).toBe('git@e.com:r.git');
          expect(sut.remotes[0]?.fetchRefspecs).toEqual([]);
        });
      });
    });

    describe('Given a remote section with no url key', () => {
      describe('When remoteList runs', () => {
        it('Then the url defaults to an empty string', async () => {
          // Arrange — a `[remote]` block carrying only a fetch refspec.
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');

          // Act
          const sut = await remoteList(ctx);

          // Assert — the missing url falls back to '' (not undefined).
          expect(sut.remotes[0]?.url).toBe('');
        });
      });
    });

    describe('Given multiple remotes', () => {
      describe('When remoteList runs', () => {
        it('Then they come back sorted by name byte-wise', async () => {
          // Arrange — write in non-sorted order to prove the sort.
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "zeta"]\n\turl = z\n[remote "alpha"]\n\turl = a\n[remote "mid"]\n\turl = m\n',
          );

          // Act
          const sut = await remoteList(ctx);

          // Assert
          expect(sut.remotes.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta']);
        });
      });
    });
  });

  describe('add', () => {
    describe('Given a new name and url', () => {
      describe('When remoteAdd runs', () => {
        it('Then the [remote] block is written with the canonical default fetch refspec', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const sut = await remoteAdd(ctx, {
            name: 'upstream',
            url: 'https://e.com/up.git',
          });

          // Assert — result payload reflects what was written.
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
      describe('When remoteAdd runs with a fetch refspec', () => {
        it('Then the custom refspec is written verbatim', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const sut = await remoteAdd(ctx, {
            name: 'upstream',
            url: 'https://e.com/u.git',
            fetch: '+refs/heads/release:refs/remotes/upstream/release',
          });

          // Assert
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
      describe('When remoteAdd runs with the same name', () => {
        it('Then it throws REMOTE_EXISTS', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, {
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
      describe('When remoteAdd runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: '', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a name with a newline', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: 'a\nb', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a name with a closing bracket', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: 'a]b', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a url containing a newline', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws INVALID_OPTION', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, {
              name: 'origin',
              url: 'https://e.com/\nrest',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('remote.url');
          expect(data.reason).toContain('newline');
        });
      });
    });

    describe('Given a malformed custom fetch refspec', () => {
      describe('When remoteAdd runs with a fetch refspec', () => {
        it('Then it throws REFSPEC_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, {
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

  describe('remove', () => {
    describe('Given an unknown remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then it throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteRemove(ctx, { name: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
        });
      });
    });

    describe('Given a configured remote with no tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then the config block is gone and removedTrackingRefs is empty', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          const sut = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(sut.name).toBe('origin');
          expect(sut.removedTrackingRefs).toEqual([]);
          expect(sut.clearedBranches).toEqual([]);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('[remote "origin"]');
        });
      });
    });

    describe('Given a configured remote with two tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then both refs are deleted and reported', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/dev`,
            `${'b'.repeat(40)}\n`,
          );

          // Act
          const sut = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect([...sut.removedTrackingRefs].sort()).toEqual([
            'refs/remotes/origin/dev',
            'refs/remotes/origin/main',
          ]);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(false);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/dev`)).toBe(false);
        });
      });
    });

    describe('Given branches tracking the removed remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then branch.<X>.remote and branch.<X>.merge are cleared', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
          );

          // Act
          const sut = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(sut.clearedBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('remote = origin');
          expect(written).not.toContain('merge = refs/heads/main');
        });
      });
    });

    describe('Given a branch tracking a different remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then the other branch is not cleared', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = other\n\tmerge = refs/heads/main\n',
          );

          // Act
          const sut = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(sut.clearedBranches).toEqual([]);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('remote = other');
        });
      });
    });

    describe('Given a branch tracking the remote without a paired merge', () => {
      describe('When remoteRemove runs', () => {
        it('Then only branch.<X>.remote is cleared (merge already absent)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n');

          // Act
          const sut = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(sut.clearedBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('remote = origin');
        });
      });
    });

    describe('Given two branches tracking the same remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then both are cleared', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n[branch "dev"]\n\tremote = origin\n\tmerge = refs/heads/dev\n',
          );

          // Act
          const sut = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect([...sut.clearedBranches].sort()).toEqual(['refs/heads/dev', 'refs/heads/main']);
        });
      });
    });

    describe('Given a tracking ref with a reflog file', () => {
      describe('When remoteRemove runs', () => {
        it('Then the reflog file is gone', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          // Reflog entry (synthetic — one line is enough; the parser is forgiving).
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/logs/refs/remotes/origin/main`,
            `${'0'.repeat(40)} ${'a'.repeat(40)} Tester <t@e.com> 1700000000 +0000\tfetch\n`,
          );

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/remotes/origin/main`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given an invalid remote name', () => {
      describe('When remoteRemove runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteRemove(ctx, { name: '' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });
  });

  describe('rename', () => {
    describe('Given an unknown `from`', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'missing', to: 'new' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
        });
      });
    });

    describe('Given to equals from', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws INVALID_OPTION', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'origin', to: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('remote.rename');
          expect(data.reason).toContain('differ');
        });
      });
    });

    describe('Given an existing `to`', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_EXISTS', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = a\n[remote "upstream"]\n\turl = b\n');
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_EXISTS');
        });
      });
    });

    describe('Given the canonical default refspec', () => {
      describe('When remoteRename runs', () => {
        it('Then it is rewritten for the new name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "upstream"]');
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/upstream/*');
          expect(written).not.toContain('refs/remotes/origin/');
        });
      });
    });

    describe('Given a custom (non-canonical) fetch refspec', () => {
      describe('When remoteRename runs', () => {
        it('Then the refspec is preserved verbatim', async () => {
          // Arrange — note: leading `+` missing, so the canonical heuristic does NOT match.
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = refs/heads/release:refs/remotes/origin/release\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('fetch = refs/heads/release:refs/remotes/origin/release');
        });
      });
    });

    describe('Given a mixed list (canonical and custom refspecs)', () => {
      describe('When remoteRename runs', () => {
        it('Then only the canonical entry is rewritten AND refspec order is preserved', async () => {
          // Arrange — order matters: the canonical-first/custom-second
          // arrangement must survive the rename so `.git/config` byte
          // layout matches canonical git.
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tfetch = +refs/heads/release:refs/remotes/origin/release\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert — both refspecs present in the original order.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          const canonicalAt = written.indexOf('fetch = +refs/heads/*:refs/remotes/upstream/*');
          const customAt = written.indexOf(
            'fetch = +refs/heads/release:refs/remotes/origin/release',
          );
          expect(canonicalAt).toBeGreaterThan(-1);
          expect(customAt).toBeGreaterThan(-1);
          expect(canonicalAt).toBeLessThan(customAt);
        });
      });
    });

    describe('Given tracking refs under the old name', () => {
      describe('When remoteRename runs', () => {
        it('Then they are moved with the same OIDs', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);

          // Act
          const sut = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(sut.movedTrackingRefs).toEqual(['refs/remotes/upstream/main']);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(false);
          const moved = (
            await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/upstream/main`)
          ).trim();
          expect(moved).toBe(oid);
          // The source had no fetch refspec, so the renamed section gets none
          // either — the empty-spec path writes no `fetch` line.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('fetch');
          // The move records the rename reflog message on the new ref.
          const movedLog = await ctx.fs.readUtf8(
            `${ctx.layout.gitDir}/logs/refs/remotes/upstream/main`,
          );
          expect(movedLog).toContain('remote: renamed origin to upstream');
        });
      });
    });

    describe('Given a branch tracking the renamed remote', () => {
      describe('When remoteRename runs', () => {
        it('Then branch.<X>.remote is rewritten to the new name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
          );

          // Act
          const sut = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(sut.rewrittenBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('remote = upstream');
          expect(written).not.toContain('remote = origin');
        });
      });
    });

    describe('Given a packed-only tracking ref under the old name', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws UNSUPPORTED_OPERATION before touching anything', async () => {
          // Arrange — write a `packed-refs` file that names
          // refs/remotes/origin/main; no loose file exists. `enumerateRefs`
          // surfaces the packed entry, and the move must reject early.
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/remotes/origin/main\n`,
          );

          // Act
          let caught: unknown;
          try {
            await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          } catch (err) {
            caught = err;
          }

          // Assert — the new ref must NOT exist (no partial move).
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code !== 'UNSUPPORTED_OPERATION') throw new Error('unreachable');
          expect(data.operation).toBe('rename-packed-tracking-ref');
          expect(data.reason).toContain('packed-only ref refs/remotes/origin/main');
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/upstream/main`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given an invalid `to` name', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'origin', to: 'a"b' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });
  });

  describe('setUrl', () => {
    describe('Given an unknown remote', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then it throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteSetUrl(ctx, { name: 'origin', url: 'x' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
        });
      });
    });

    describe('Given a known remote and a new url', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then remote.<n>.url is replaced and pushurl is untouched', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = old\n\tpushurl = push-old\n');

          // Act
          const sut = await remoteSetUrl(ctx, {
            name: 'origin',
            url: 'new',
          });

          // Assert
          expect(sut.remote.url).toBe('new');
          expect(sut.remote.pushUrl).toBe('push-old');
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('url = new');
          expect(written).toContain('pushurl = push-old');
          expect(written).not.toContain('url = old');
        });
      });
    });

    describe('Given a known remote and { push: true }', () => {
      describe('When remoteSetUrl runs with push: true', () => {
        it('Then remote.<n>.pushurl is replaced and url is untouched', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');

          // Act
          const sut = await remoteSetUrl(ctx, {
            name: 'origin',
            url: 'push-new',
            push: true,
          });

          // Assert
          expect(sut.remote.pushUrl).toBe('push-new');
          expect(sut.remote.url).toBe('u');
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('pushurl = push-new');
          expect(written).toContain('url = u');
        });
      });
    });

    describe('Given a url with a newline', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then it throws INVALID_OPTION', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteSetUrl(ctx, {
              name: 'origin',
              url: 'bad\nurl',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('remote.url');
          expect(data.reason).toContain('newline');
        });
      });
    });

    describe('Given an invalid remote name', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteSetUrl(ctx, { name: '', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });
  });

  describe('show', () => {
    describe('Given an unknown remote', () => {
      describe('When remoteShow runs', () => {
        it('Then it throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteShow(ctx, { name: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
        });
      });
    });

    describe('Given a remote with tracking refs and tracking branches', () => {
      describe('When remoteShow runs', () => {
        it('Then trackingRefs and trackedBy reflect them', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
          );
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);

          // Act
          const sut = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(sut.remote.url).toBe('https://e.com/r.git');
          expect(sut.remote.fetchRefspecs).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
          expect(sut.remote.trackingRefs.size).toBe(1);
          expect(sut.remote.trackingRefs.get('refs/remotes/origin/main' as never)).toBe(oid);
          expect(sut.remote.trackedBy).toEqual([
            { branch: 'refs/heads/main', merge: 'refs/heads/main' },
          ]);
        });
      });
    });

    describe('Given a remote with pushurl set', () => {
      describe('When remoteShow runs', () => {
        it('Then pushUrl is populated', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n\tpushurl = p\n');

          // Act
          const sut = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(sut.remote.pushUrl).toBe('p');
        });
      });
    });

    describe('Given a remote with no tracking refs', () => {
      describe('When remoteShow runs', () => {
        it('Then trackingRefs is an empty Map', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');

          // Act
          const sut = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(sut.remote.trackingRefs.size).toBe(0);
          expect(sut.remote.trackedBy).toEqual([]);
        });
      });
    });

    describe('Given a remote tracked by a branch with no merge', () => {
      describe('When remoteShow runs', () => {
        it('Then trackedBy[i].merge is undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n');

          // Act
          const sut = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(sut.remote.trackedBy).toEqual([{ branch: 'refs/heads/main', merge: undefined }]);
        });
      });
    });

    describe('Given an invalid remote name', () => {
      describe('When remoteShow runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteShow(ctx, { name: '' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });
  });
});
