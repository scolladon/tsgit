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
import { getRefStore, type RefUpdate } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { withReftableStorage } from '../primitives/reftable-fixtures.js';

const seed = async (ctx: Context, content?: string): Promise<void> => {
  await init(ctx);
  if (content !== undefined) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
    __resetConfigCacheForTests();
  }
};

const ORIGIN_ID = 'a'.repeat(40) as ObjectId;
const STALE_ID = 'b'.repeat(40) as ObjectId;
const ZERO_ID = '0'.repeat(40) as ObjectId;
const ORIGIN_MAIN = 'refs/remotes/origin/main' as RefName;
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD' as RefName;
const UP2_MAIN = 'refs/remotes/up2/main' as RefName;
const UP2_HEAD = 'refs/remotes/up2/HEAD' as RefName;

/** Records every `applyRefUpdates` batch the Context's store receives. */
const recordBatches = (ctx: Context): RefUpdate[][] => {
  const store = getRefStore(ctx);
  const batches: RefUpdate[][] = [];
  const original = store.applyRefUpdates.bind(store);
  store.applyRefUpdates = async (updates) => {
    batches.push([...updates]);
    return original(updates);
  };
  return batches;
};

/** Renames `origin` to `to`, returning what it threw (or `undefined`). */
const renameRefusal = async (ctx: Context, to: string): Promise<unknown> => {
  try {
    await remoteRename(ctx, { from: 'origin', to });
  } catch (err) {
    return err;
  }
  return undefined;
};

/** A repository the format-acceptance gate rejects — every `remote` verb moved onto it. */
const rejectedCtx = async (content?: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await seed(ctx, content);
  return { ...ctx, layout: { ...ctx.layout, formatRefusal: { kind: 'version', version: 99 } } };
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
          const result = await remoteList(ctx);

          // Assert
          expect(result).toEqual({ remotes: [] });
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
          const result = await remoteList(ctx);

          // Assert
          expect(result).toEqual({
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
          const result = await remoteList(ctx);

          // Assert — no `fetch` key, so the refspec list defaults to empty.
          expect(result.remotes[0]?.pushUrl).toBe('git@e.com:r.git');
          expect(result.remotes[0]?.fetchRefspecs).toEqual([]);
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
          const result = await remoteList(ctx);

          // Assert — the missing url falls back to '' (not undefined).
          expect(result.remotes[0]?.url).toBe('');
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
          const result = await remoteList(ctx);

          // Assert
          expect(result.remotes.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta']);
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
          const result = await remoteAdd(ctx, {
            name: 'upstream',
            url: 'https://e.com/up.git',
          });

          // Assert — result payload reflects what was written.
          expect(result.remote.name).toBe('upstream');
          expect(result.remote.url).toBe('https://e.com/up.git');
          expect(result.remote.fetchRefspecs).toEqual(['+refs/heads/*:refs/remotes/upstream/*']);
          // On-disk config matches.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "upstream"]');
          expect(written).toContain('url = https://e.com/up.git');
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/upstream/*');
        });
      });
    });

    describe('Given a new name and url', () => {
      describe('When the resulting config is read back', () => {
        it('Then remoteList binds both url and fetch to that remote section', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          await remoteAdd(ctx, { name: 'upstream', url: 'https://e.com/up.git' });
          __resetConfigCacheForTests();
          const result = await remoteList(ctx);

          // Assert — url and fetch must live UNDER `[remote "upstream"]`, not a
          // stray empty-section header. A loose substring match cannot prove this.
          expect(result.remotes).toEqual([
            {
              name: 'upstream',
              url: 'https://e.com/up.git',
              pushUrl: undefined,
              fetchRefspecs: ['+refs/heads/*:refs/remotes/upstream/*'],
            },
          ]);
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
          const result = await remoteAdd(ctx, {
            name: 'upstream',
            url: 'https://e.com/u.git',
            fetch: '+refs/heads/release:refs/remotes/upstream/release',
          });

          // Assert
          expect(result.remote.fetchRefspecs).toEqual([
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

    describe('Given a name that cannot form a tracking ref name', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws REMOTE_NAME_INVALID before writing any config', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          const configBefore = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: 'a b', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NAME_INVALID',
            name: 'a b',
            reason: 'name does not form a valid refs/remotes/<name>/ ref name',
          });
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).toBe(configBefore);
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
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.name).toBe('origin');
          expect(result.removedTrackingRefs).toEqual([]);
          expect(result.clearedBranches).toEqual([]);
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
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect([...result.removedTrackingRefs].sort()).toEqual([
            'refs/remotes/origin/dev',
            'refs/remotes/origin/main',
          ]);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(false);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/dev`)).toBe(false);
        });
      });
    });

    describe('Given a configured remote with a symbolic HEAD and two direct tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then every tracking ref is deleted in one ref transaction', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/dev`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          const batches = recordBatches(ctx);

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(batches).toEqual([
            [
              { kind: 'delete', name: ORIGIN_HEAD },
              { kind: 'delete', name: 'refs/remotes/origin/dev' },
              { kind: 'delete', name: ORIGIN_MAIN },
            ],
          ]);
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
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.clearedBranches).toEqual(['refs/heads/main']);
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
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.clearedBranches).toEqual([]);
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
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.clearedBranches).toEqual(['refs/heads/main']);
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
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect([...result.clearedBranches].sort()).toEqual(['refs/heads/dev', 'refs/heads/main']);
        });
      });
    });

    describe('Given a tracking symref (HEAD) among the tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then every tracking ref and the symref are gone, --no-deref', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await writeSymbolicRef(
            ctx,
            'refs/remotes/origin/HEAD' as RefName,
            'refs/remotes/origin/main' as RefName,
          );

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/origin/HEAD' as RefName),
          ).toEqual({ kind: 'missing' });
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/origin/main' as RefName),
          ).toEqual({ kind: 'missing' });
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

    describe('Given the canonical default refspec', () => {
      describe('When the renamed config is read back', () => {
        it('Then remoteList binds the rewritten fetch to the new remote section', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          __resetConfigCacheForTests();
          const result = await remoteList(ctx);

          // Assert — the re-emitted fetch spec must attach to `[remote "upstream"]`,
          // not a stray empty-section header.
          expect(result.remotes).toEqual([
            {
              name: 'upstream',
              url: 'u',
              pushUrl: undefined,
              fetchRefspecs: ['+refs/heads/*:refs/remotes/upstream/*'],
            },
          ]);
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
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.movedTrackingRefs).toEqual(['refs/remotes/upstream/main']);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(false);
          const moved = (
            await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/upstream/main`)
          ).trim();
          expect(moved).toBe(oid);
          // The source had no fetch refspec, so the renamed section gets none
          // either — the empty-spec path writes no `fetch` line.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('fetch');
        });
      });
    });

    describe('Given a tracking ref under the old name with an existing reflog', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name keeps that history and gains one full-ref-name rename entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/logs/refs/remotes/origin/main`,
            `${'0'.repeat(40)} ${oid} A <a@e.com> 1700000000 +0000\tfetch\n`,
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          const log = await readReflog(ctx, 'refs/remotes/upstream/main' as RefName);

          // Assert — the moved history, plus exactly one appended entry
          // naming the full ref paths, not the remote names.
          expect(log).toHaveLength(2);
          expect(log[0]?.newId).toBe(oid);
          expect(log[1]?.oldId).toBe(oid);
          expect(log[1]?.newId).toBe(oid);
          expect(log[1]?.message).toBe(
            'remote: renamed refs/remotes/origin/main to refs/remotes/upstream/main',
          );
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/remotes/origin/main`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given a tracking ref under the old name with NO existing reflog', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name has no reflog either', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/remotes/upstream/main`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given an unlogged direct tracking ref on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name has no reflog either', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/remotes/origin/main' as RefName,
              id: 'a'.repeat(40) as ObjectId,
            },
          ]);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(await readReflog(ctx, 'refs/remotes/upstream/main' as RefName)).toEqual([]);
        });
      });
    });

    describe('Given an unlogged symbolic tracking ref (HEAD) on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new HEAD symref exists with no reflog either', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/remotes/origin/main' as RefName,
              id: 'a'.repeat(40) as ObjectId,
            },
            {
              kind: 'setSymbolic',
              name: 'refs/remotes/origin/HEAD' as RefName,
              target: 'refs/remotes/origin/main' as RefName,
            },
          ]);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(await store.resolveDirect('refs/remotes/upstream/HEAD' as RefName)).toEqual({
            kind: 'symbolic',
            target: 'refs/remotes/upstream/main',
          });
          expect(await readReflog(ctx, 'refs/remotes/upstream/HEAD' as RefName)).toEqual([]);
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
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.rewrittenBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('remote = upstream');
          expect(written).not.toContain('remote = origin');
        });
      });
    });

    describe('Given a packed-only tracking ref under the old name', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name is written loose with the packed id and the old name is gone from packed-refs', async () => {
          // Arrange — write a `packed-refs` file that names
          // refs/remotes/origin/main; no loose file exists. `enumerateRefs`
          // surfaces the packed entry, and the move now rewrites
          // packed-refs to drop it, as `git remote rename` does.
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/remotes/origin/main\n`,
          );

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.movedTrackingRefs).toEqual(['refs/remotes/upstream/main']);
          const moved = (
            await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/upstream/main`)
          ).trim();
          expect(moved).toBe(oid);
          const packedContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/packed-refs`);
          expect(packedContent).not.toContain('refs/remotes/origin/main');
        });
      });
    });

    describe('Given a packed-only tracking ref under the old name, with an existing reflog', () => {
      describe('When remoteRename runs', () => {
        it('Then the moved history gains one rename entry and the old packed-refs line is gone', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/remotes/origin/main\n`,
          );
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/logs/refs/remotes/origin/main`,
            `${'0'.repeat(40)} ${oid} A <a@e.com> 1700000000 +0000\tfetch\n`,
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          const log = await readReflog(ctx, 'refs/remotes/upstream/main' as RefName);

          // Assert
          expect(log).toHaveLength(2);
          expect(log[1]?.message).toBe(
            'remote: renamed refs/remotes/origin/main to refs/remotes/upstream/main',
          );
          const packedContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/packed-refs`);
          expect(packedContent).not.toContain('refs/remotes/origin/main');
        });
      });
    });

    describe('Given a symbolic tracking ref (HEAD) on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new HEAD symref is re-created with a rewritten target and a null-id rename entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await writeSymbolicRef(
            ctx,
            'refs/remotes/origin/HEAD' as RefName,
            'refs/remotes/origin/main' as RefName,
          );

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.movedTrackingRefs).toEqual([
            'refs/remotes/upstream/HEAD',
            'refs/remotes/upstream/main',
          ]);
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/origin/HEAD' as RefName),
          ).toEqual({ kind: 'missing' });
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/upstream/HEAD' as RefName),
          ).toEqual({ kind: 'symbolic', target: 'refs/remotes/upstream/main' });
          const log = await readReflog(ctx, 'refs/remotes/upstream/HEAD' as RefName);
          expect(log).toHaveLength(1);
          expect(log[0]?.oldId).toBe('0'.repeat(40));
          expect(log[0]?.newId).toBe('0'.repeat(40));
          expect(log[0]?.message).toBe(
            'remote: renamed refs/remotes/origin/HEAD to refs/remotes/upstream/HEAD',
          );
        });
      });
    });

    describe('Given a symbolic tracking ref (HEAD) on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new HEAD symref carries the copied log and the old name keeps it too', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/remotes/origin/main' as RefName,
              id: 'a'.repeat(40) as ObjectId,
            },
            {
              kind: 'setSymbolic',
              name: 'refs/remotes/origin/HEAD' as RefName,
              target: 'refs/remotes/origin/main' as RefName,
              reflog: {
                oldId: '0'.repeat(40) as ObjectId,
                newId: '0'.repeat(40) as ObjectId,
                message: 'clone',
              },
            },
          ]);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert — the new symref carries the copied history with NO
          // trailing entry (reftable never gets one on the create side);
          // the old name keeps its own log too (copy, not move) — the
          // `noDeref` delete's own kept-with-entry rule (an empty message)
          // is a store-level concern already pinned elsewhere.
          expect(await store.resolveDirect('refs/remotes/upstream/HEAD' as RefName)).toEqual({
            kind: 'symbolic',
            target: 'refs/remotes/upstream/main',
          });
          const newLog = await readReflog(ctx, 'refs/remotes/upstream/HEAD' as RefName);
          expect(newLog).toHaveLength(1);
          expect(newLog[0]?.message).toBe('clone');
          const oldLog = await readReflog(ctx, 'refs/remotes/origin/HEAD' as RefName);
          expect(oldLog.length).toBeGreaterThanOrEqual(1);
          expect(oldLog[0]?.message).toBe('clone');
        });
      });
    });

    describe('Given two logged direct tracking refs and a symbolic HEAD on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the creates share one batch, every old name is deleted in one ref transaction, and HEAD is re-created last', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/dev`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(
            `${gitDir}/logs/refs/remotes/origin/dev`,
            `${ZERO_ID} ${STALE_ID} A <a@x> 1700000000 +0000\tfetch\n`,
          );
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(
            `${gitDir}/logs/refs/remotes/origin/main`,
            `${ZERO_ID} ${ORIGIN_ID} A <a@x> 1700000000 +0000\tfetch\n`,
          );
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          const batches = recordBatches(ctx);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert
          expect(batches).toEqual([
            [
              { kind: 'set', name: 'refs/remotes/up2/dev', id: STALE_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: 'refs/remotes/up2/dev',
                reflog: {
                  oldId: STALE_ID,
                  newId: STALE_ID,
                  message: 'remote: renamed refs/remotes/origin/dev to refs/remotes/up2/dev',
                },
              },
              { kind: 'set', name: UP2_MAIN, id: ORIGIN_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: UP2_MAIN,
                reflog: {
                  oldId: ORIGIN_ID,
                  newId: ORIGIN_ID,
                  message: 'remote: renamed refs/remotes/origin/main to refs/remotes/up2/main',
                },
              },
            ],
            [
              { kind: 'delete', name: ORIGIN_HEAD },
              { kind: 'delete', name: 'refs/remotes/origin/dev' },
              { kind: 'delete', name: ORIGIN_MAIN },
            ],
            [
              {
                kind: 'setSymbolic',
                name: UP2_HEAD,
                target: UP2_MAIN,
                reflog: {
                  oldId: ZERO_ID,
                  newId: ZERO_ID,
                  message: 'remote: renamed refs/remotes/origin/HEAD to refs/remotes/up2/HEAD',
                },
              },
            ],
          ]);
        });
      });
    });

    describe('Given two logged direct tracking refs and a symbolic HEAD on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it("Then the old names' deletes share one ref transaction with HEAD's kept-log entry", async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/remotes/origin/dev' as RefName,
              id: STALE_ID,
              reflog: { oldId: ZERO_ID, newId: STALE_ID, message: 'fetch' },
            },
            {
              kind: 'set',
              name: ORIGIN_MAIN,
              id: ORIGIN_ID,
              reflog: { oldId: ZERO_ID, newId: ORIGIN_ID, message: 'fetch' },
            },
            {
              kind: 'setSymbolic',
              name: ORIGIN_HEAD,
              target: ORIGIN_MAIN,
              reflog: { oldId: ZERO_ID, newId: ZERO_ID, message: 'clone' },
            },
          ]);
          const batches = recordBatches(ctx);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert
          expect(batches).toEqual([
            [
              { kind: 'set', name: 'refs/remotes/up2/dev', id: STALE_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: 'refs/remotes/up2/dev',
                reflog: {
                  oldId: STALE_ID,
                  newId: STALE_ID,
                  message: 'remote: renamed refs/remotes/origin/dev to refs/remotes/up2/dev',
                },
              },
              { kind: 'set', name: UP2_MAIN, id: ORIGIN_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: UP2_MAIN,
                reflog: {
                  oldId: ORIGIN_ID,
                  newId: ORIGIN_ID,
                  message: 'remote: renamed refs/remotes/origin/main to refs/remotes/up2/main',
                },
              },
            ],
            [
              { kind: 'delete', name: ORIGIN_HEAD },
              { kind: 'delete', name: 'refs/remotes/origin/dev' },
              { kind: 'delete', name: ORIGIN_MAIN },
              {
                kind: 'reflogOnly',
                name: ORIGIN_HEAD,
                reflog: { oldId: ORIGIN_ID, newId: ZERO_ID, message: '' },
              },
            ],
            [{ kind: 'setSymbolic', name: UP2_HEAD, target: UP2_MAIN }],
          ]);
        });
      });
    });

    describe('Given both direct and symbolic tracking refs under the old name', () => {
      describe('When remoteRename runs', () => {
        it('Then every direct ref moves before the symbolic ref does', async () => {
          // Arrange — git's own order: direct refs first, the symref last.
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await writeSymbolicRef(
            ctx,
            'refs/remotes/origin/HEAD' as RefName,
            'refs/remotes/origin/main' as RefName,
          );
          const store = getRefStore(ctx);
          const calls: Array<{ readonly kind: string }> = [];
          const originalApply = store.applyRefUpdates.bind(store);
          store.applyRefUpdates = async (updates) => {
            for (const update of updates) calls.push({ kind: update.kind });
            return originalApply(updates);
          };

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert — the LAST `setSymbolic` call is the HEAD re-creation;
          // every `set` (the direct ref) lands before it.
          const setSymbolicIndex = calls.findIndex((c) => c.kind === 'setSymbolic');
          const lastSetIndex = calls.map((c) => c.kind).lastIndexOf('set');
          expect(setSymbolicIndex).toBeGreaterThan(-1);
          expect(lastSetIndex).toBeGreaterThan(-1);
          expect(setSymbolicIndex).toBeGreaterThan(lastSetIndex);
        });
      });
    });

    describe('Given a logged tracking ref and a stale logged ref at its renamed name on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses the existing name before writing any ref or log', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          const originLog = `${ZERO_ID} ${ORIGIN_ID} A <a@x> 1700000000 +0000\tfetch origin\n`;
          const staleLog = `${ZERO_ID} ${STALE_ID} A <a@x> 1700000000 +0000\tstale up2\n`;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/logs/refs/remotes/origin/main`, originLog);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/main`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/logs/refs/remotes/up2/main`, staleLog);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/main',
            expected: 'absent',
            actual: STALE_ID,
          });
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/origin/main`)).toBe(
            `${ORIGIN_ID}\n`,
          );
          expect(await ctx.fs.readUtf8(`${gitDir}/logs/refs/remotes/origin/main`)).toBe(originLog);
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/up2/main`)).toBe(`${STALE_ID}\n`);
          expect(await ctx.fs.readUtf8(`${gitDir}/logs/refs/remotes/up2/main`)).toBe(staleLog);
        });
      });
    });

    describe('Given a logged tracking ref and a stale logged ref at its renamed name on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses the existing name before writing any ref or log', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: ORIGIN_MAIN,
              id: ORIGIN_ID,
              reflog: { oldId: ZERO_ID, newId: ORIGIN_ID, message: 'fetch origin' },
            },
            {
              kind: 'set',
              name: UP2_MAIN,
              id: STALE_ID,
              reflog: { oldId: ZERO_ID, newId: STALE_ID, message: 'stale up2' },
            },
          ]);
          const originLog = await readReflog(ctx, ORIGIN_MAIN);
          const staleLog = await readReflog(ctx, UP2_MAIN);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/main',
            expected: 'absent',
            actual: STALE_ID,
          });
          expect(originLog.map((entry) => entry.message)).toEqual(['fetch origin']);
          expect(staleLog.map((entry) => entry.message)).toEqual(['stale up2']);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'direct', id: STALE_ID });
          expect(await readReflog(ctx, ORIGIN_MAIN)).toEqual(originLog);
          expect(await readReflog(ctx, UP2_MAIN)).toEqual(staleLog);
        });
      });
    });

    describe('Given stale refs at two renamed names on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the refusal names the byte-smallest existing name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/zzz`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/zzz`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/main`, `${ORIGIN_ID}\n`);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/main',
            expected: 'absent',
            actual: ORIGIN_ID,
          });
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/origin/zzz`)).toBe(`${ORIGIN_ID}\n`);
        });
      });
    });

    describe('Given a symbolic ref already at the renamed HEAD on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses that name with its referent value and every ref stays put', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/HEAD`, 'ref: refs/heads/main\n');

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/HEAD',
            expected: 'absent',
            actual: STALE_ID,
          });
          const store = getRefStore(ctx);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(ORIGIN_HEAD)).toEqual({
            kind: 'symbolic',
            target: ORIGIN_MAIN,
          });
          expect(await store.resolveDirect(UP2_HEAD)).toEqual({
            kind: 'symbolic',
            target: 'refs/heads/main',
          });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given a symbolic ref already at the renamed HEAD on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses that name with its referent value and every ref stays put', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            { kind: 'set', name: 'refs/heads/main' as RefName, id: STALE_ID },
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
            { kind: 'setSymbolic', name: ORIGIN_HEAD, target: ORIGIN_MAIN },
            { kind: 'setSymbolic', name: UP2_HEAD, target: 'refs/heads/main' as RefName },
          ]);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/HEAD',
            expected: 'absent',
            actual: STALE_ID,
          });
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(ORIGIN_HEAD)).toEqual({
            kind: 'symbolic',
            target: ORIGIN_MAIN,
          });
          expect(await store.resolveDirect(UP2_HEAD)).toEqual({
            kind: 'symbolic',
            target: 'refs/heads/main',
          });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given a dangling symbolic ref already at the renamed HEAD', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses that name with an absent actual value and every ref stays put', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/HEAD`, 'ref: refs/heads/nope\n');

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/HEAD',
            expected: 'absent',
            actual: 'absent',
          });
          const store = getRefStore(ctx);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(UP2_HEAD)).toEqual({
            kind: 'symbolic',
            target: 'refs/heads/nope',
          });
        });
      });
    });

    describe('Given a cyclic symbolic ref already at the renamed HEAD', () => {
      describe('When remoteRename runs', () => {
        it('Then the unreadable referent refuses the rename and every ref stays put', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/HEAD`, 'ref: refs/remotes/up2/loop\n');
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/loop`, `ref: ${UP2_HEAD}\n`);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_CYCLE_DETECTED',
            chain: ['refs/remotes/up2/loop', 'refs/remotes/up2/HEAD', 'refs/remotes/up2/loop'],
          });
          const store = getRefStore(ctx);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
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

    describe('Given a `to` name that cannot form a tracking ref name', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_NAME_INVALID before moving any ref or rewriting the config', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          const configBefore = await ctx.fs.readUtf8(`${gitDir}/config`);

          // Act
          const caught = await renameRefusal(ctx, '..');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NAME_INVALID',
            name: '..',
            reason: 'name does not form a valid refs/remotes/<name>/ ref name',
          });
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/origin/main`)).toBe(
            `${ORIGIN_ID}\n`,
          );
          expect(await ctx.fs.readUtf8(`${gitDir}/config`)).toBe(configBefore);
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
          const result = await remoteSetUrl(ctx, {
            name: 'origin',
            url: 'new',
          });

          // Assert
          expect(result.remote.url).toBe('new');
          expect(result.remote.pushUrl).toBe('push-old');
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
          const result = await remoteSetUrl(ctx, {
            name: 'origin',
            url: 'push-new',
            push: true,
          });

          // Assert
          expect(result.remote.pushUrl).toBe('push-new');
          expect(result.remote.url).toBe('u');
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
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.url).toBe('https://e.com/r.git');
          expect(result.remote.fetchRefspecs).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
          expect(result.remote.trackingRefs.size).toBe(1);
          expect(result.remote.trackingRefs.get('refs/remotes/origin/main' as never)).toBe(oid);
          expect(result.remote.trackedBy).toEqual([
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
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.pushUrl).toBe('p');
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
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.trackingRefs.size).toBe(0);
          expect(result.remote.trackedBy).toEqual([]);
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
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.trackedBy).toEqual([
            { branch: 'refs/heads/main', merge: undefined },
          ]);
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

  describe('the format-acceptance tier', () => {
    describe('Given a repository the format-acceptance gate rejects', () => {
      describe('When remoteList runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx();

          // Act
          let caught: unknown;
          try {
            await remoteList(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteAdd runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx();

          // Act
          let caught: unknown;
          try {
            await remoteAdd(ctx, { name: 'origin', url: 'https://example.com/repo.git' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteRemove runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteRemove(ctx, { name: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteRename runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteSetUrl runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteSetUrl(ctx, { name: 'origin', url: 'https://example.com/other.git' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteShow runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteShow(ctx, { name: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });
    });
  });
});
