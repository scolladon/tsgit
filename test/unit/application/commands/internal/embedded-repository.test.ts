import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { embeddedRepositories } from '../../../../../src/application/commands/internal/embedded-repository.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const HEAD_COMMIT = 'c'.repeat(40);
const SUB = 'sub' as FilePath;

const entryAt = (path: string): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: HEAD_COMMIT as ObjectId,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

const countingLstat = (ctx: Context, seen: string[]): Context =>
  ({
    ...ctx,
    fs: Object.assign(Object.create(ctx.fs), {
      lstat: async (path: string) => {
        seen.push(path);
        return ctx.fs.lstat(path);
      },
    }),
  }) as Context;

const layOutRepository = async (ctx: Context, gitDir: string, head?: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${gitDir}/objects`);
  await ctx.fs.mkdir(`${gitDir}/refs`);
  if (head !== undefined) await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${head}\n`);
};

describe('embeddedRepositories', () => {
  describe('Given a repository at the directory and an empty index', () => {
    describe('When the directory is asked whether it holds a repository', () => {
      it('Then it does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await layOutRepository(ctx, `${ctx.layout.workDir}/sub/.git`, HEAD_COMMIT);
        const sut = embeddedRepositories;
        // Act
        const holds = await sut(ctx, []).holds(SUB);

        // Assert
        expect(holds).toBe(true);
      });
    });
  });

  describe('Given no .git at the directory', () => {
    describe('When the directory is asked whether it holds a repository', () => {
      it('Then it does not', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = embeddedRepositories;
        // Act
        const holds = await sut(ctx, []).holds(SUB);

        // Assert
        expect(holds).toBe(false);
      });
    });
  });

  describe('Given a gitfile that does not parse', () => {
    describe('When the directory is asked whether it holds a repository', () => {
      it('Then it does not', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { workDir } = ctx.layout;
        await ctx.fs.writeUtf8(`${workDir}/sub/.git`, 'garbage\n');
        const sut = embeddedRepositories;
        // Act
        const holds = await sut(ctx, []).holds(SUB);

        // Assert
        expect(holds).toBe(false);
      });
    });
  });

  describe('Given a .git directory whose HEAD is garbage', () => {
    describe('When the directory is asked whether it holds a repository', () => {
      it('Then it does not', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { workDir } = ctx.layout;
        await layOutRepository(ctx, `${workDir}/sub/.git`, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${workDir}/sub/.git/HEAD`, 'garbage\n');
        const sut = embeddedRepositories;
        // Act
        const holds = await sut(ctx, []).holds(SUB);

        // Assert
        expect(holds).toBe(false);
      });
    });
  });

  describe('Given a .git directory without objects', () => {
    describe('When the directory is asked whether it holds a repository', () => {
      it('Then it does not', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { workDir } = ctx.layout;
        await ctx.fs.writeUtf8(`${workDir}/sub/.git/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.mkdir(`${workDir}/sub/.git/refs`);
        const sut = embeddedRepositories;
        // Act
        const holds = await sut(ctx, []).holds(SUB);

        // Assert
        expect(holds).toBe(false);
      });
    });
  });

  describe('Given a .git symlink to a repository directory', () => {
    describe('When the directory is asked whether it holds a repository', () => {
      it('Then it does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { gitDir, workDir } = ctx.layout;
        await layOutRepository(ctx, `${gitDir}/modules/sub`, HEAD_COMMIT);
        await ctx.fs.symlink(`${gitDir}/modules/sub`, `${workDir}/sub/.git`);
        const sut = embeddedRepositories;
        // Act
        const holds = await sut(ctx, []).holds(SUB);

        // Assert
        expect(holds).toBe(true);
      });
    });
  });

  describe('Given an index entry beneath a directory that holds a repository', () => {
    describe('When the directory is asked whether it holds a repository', () => {
      it('Then it does not, and its .git is never read', async () => {
        // Arrange
        const base = createMemoryContext();
        const { workDir } = base.layout;
        await layOutRepository(base, `${workDir}/sub/.git`, HEAD_COMMIT);
        const seen: string[] = [];
        const sut = embeddedRepositories;
        // Act
        const holds = await sut(countingLstat(base, seen), [entryAt('sub/u')]).holds(SUB);

        // Assert
        expect(holds).toBe(false);
        expect(seen).toEqual([]);
      });
    });
  });

  describe('Given a repository whose branch holds a commit', () => {
    describe('When the head of the directory is asked', () => {
      it('Then it is the branch id', async () => {
        // Arrange
        const base = createMemoryContext();
        const { workDir } = base.layout;
        await layOutRepository(base, `${workDir}/sub/.git`, HEAD_COMMIT);
        const sut = embeddedRepositories;
        // Act
        const head = await sut(base, []).headOf(SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a repository on an unborn branch', () => {
    describe('When the head of the directory is asked', () => {
      it('Then there is none', async () => {
        // Arrange
        const base = createMemoryContext();
        const { workDir } = base.layout;
        await layOutRepository(base, `${workDir}/sub/.git`);
        const sut = embeddedRepositories;
        // Act
        const head = await sut(base, []).headOf(SUB);

        // Assert
        expect(head).toBe(undefined);
      });
    });
  });

  describe('Given a repository whose format version git refuses', () => {
    describe('When the head of the directory is asked', () => {
      it('Then there is none, instead of the refusal', async () => {
        // Arrange
        const base = createMemoryContext();
        const { workDir } = base.layout;
        await layOutRepository(base, `${workDir}/sub/.git`, HEAD_COMMIT);
        await base.fs.writeUtf8(
          `${workDir}/sub/.git/config`,
          '[core]\n\trepositoryformatversion = 2\n',
        );
        const sut = embeddedRepositories;
        // Act
        const head = await sut(base, []).headOf(SUB);

        // Assert
        expect(head).toBe(undefined);
      });
    });
  });

  describe('Given a directory that is no repository', () => {
    describe('When the head of the directory is asked', () => {
      it('Then there is none', async () => {
        // Arrange
        const base = createMemoryContext();
        const { workDir } = base.layout;
        await base.fs.mkdir(`${workDir}/sub`);
        const sut = embeddedRepositories;
        // Act
        const head = await sut(base, []).headOf(SUB);

        // Assert
        expect(head).toBe(undefined);
      });
    });
  });

  describe('Given a directory asked whether it holds a repository, then for its head', () => {
    describe('When both are answered', () => {
      it('Then .git is read once', async () => {
        // Arrange
        const base = createMemoryContext();
        await layOutRepository(base, `${base.layout.workDir}/sub/.git`, HEAD_COMMIT);
        const seen: string[] = [];
        const sut = embeddedRepositories;

        // Act
        const repositories = sut(countingLstat(base, seen), []);
        await repositories.holds(SUB);
        await repositories.headOf(SUB);

        // Assert
        expect(seen.filter((path) => path.endsWith('/sub/.git'))).toHaveLength(1);
      });
    });
  });

  describe('Given a HEAD read that fails with something that is no tsgit error', () => {
    describe('When the head of the directory is asked', () => {
      it('Then the failure surfaces', async () => {
        // Arrange
        const base = createMemoryContext();
        await layOutRepository(base, `${base.layout.workDir}/sub/.git`, HEAD_COMMIT);
        const failing = {
          ...base,
          fs: new Proxy(base.fs, {
            get(target, property) {
              const member = Reflect.get(target, property, target);
              if (typeof member !== 'function') return member;
              return (...args: unknown[]) => {
                if (String(args[0]).endsWith('refs/heads/main')) throw new Error('disk on fire');
                return member.apply(target, args);
              };
            },
          }),
        } as Context;
        const sut = embeddedRepositories;

        // Act
        const err = await sut(failing, [])
          .headOf(SUB)
          .catch((e: unknown) => e);

        // Assert
        expect((err as Error).message).toBe('disk on fire');
      });
    });
  });
});
