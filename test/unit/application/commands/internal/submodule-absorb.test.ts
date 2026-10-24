import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  absorbGitDirs,
  gitfileCheckoutOf,
  gitlinkLocalModification,
  isEmptyDirectory,
  validateSubmodulePath,
} from '../../../../../src/application/commands/internal/submodule-absorb.js';
import { status } from '../../../../../src/application/commands/status.js';
import { deriveGitlinkContext } from '../../../../../src/application/primitives/internal/submodule-context.js';
import { createLeadingPathScanner } from '../../../../../src/application/primitives/internal/symlinked-leading-path.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import { permissionDenied } from '../../../../../src/domain/error.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';
import { resolveWorktreePath } from '../../../../../src/domain/worktree/resolve-path.js';
import type { Context } from '../../../../../src/ports/context.js';
import { seedIndex } from '../add-index-fixtures.js';
import {
  SUBMODULE_AUTHOR as AUTHOR,
  embedRepository as embed,
  unmergeEntry,
  withNestedSubmodule as withNested,
  withSubmodule,
  workPath,
} from '../submodule-fixtures.js';

const work = workPath;
const ROWS_SUB = [{ name: 'sub', path: 'sub' as FilePath, url: '../up' }];

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as { data: unknown }).data;
  }
  return undefined;
};

const gitlinkEntry = async (ctx: Context, path: string): Promise<IndexEntry> => {
  const entry = (await readIndex(ctx)).entries.find((e) => e.path === path);
  if (entry === undefined) throw new Error(`no entry at ${path}`);
  return entry;
};

/** Replace `sub/.git` by a symbolic link to `target`, as written relative to `sub/`. */
const linkDotGitTo = async (ctx: Context, target: string): Promise<void> => {
  await ctx.fs.rm(work(ctx, 'sub/.git'));
  await ctx.fs.symlink(target, work(ctx, 'sub/.git'));
};

/** Move the submodule's repository beside it in the working tree and point `sub/.git` at it; the repository's new path. */
const repositoryLinkedFromBeside = async (ctx: Context): Promise<string> => {
  const beside = resolveWorktreePath(work(ctx, 'sub'), '../ext');
  await ctx.fs.rename(`${ctx.layout.gitDir}/modules/sub`, beside);
  await linkDotGitTo(ctx, '../ext');
  return beside;
};

/** Leave an empty directory in place of `sub/.git`, its repository gone. */
const dotGitAsEmptyDirectory = async (ctx: Context): Promise<void> => {
  await ctx.fs.rmRecursive(`${ctx.layout.gitDir}/modules/sub`);
  await ctx.fs.rm(work(ctx, 'sub/.git'));
  await ctx.fs.mkdir(work(ctx, 'sub/.git'));
};

const isSymbolicLink = async (ctx: Context, absolute: string): Promise<boolean> =>
  (await ctx.fs.lstat(absolute)).isSymbolicLink;

describe('validateSubmodulePath', () => {
  describe('Given a submodule path made of real directories', () => {
    describe('When it is validated', () => {
      it('Then it passes', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        const sut = validateSubmodulePath;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), 'sub' as FilePath),
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a submodule path that is itself a symbolic link', () => {
    describe('When it is validated', () => {
      it('Then it refuses with the path and no component', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rename(work(ctx, 'sub'), work(ctx, 'c'));
        await ctx.fs.symlink('c', work(ctx, 'sub'));
        const sut = validateSubmodulePath;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), 'sub' as FilePath),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' });
      });
    });
  });

  describe('Given a submodule path whose leading directory is a symbolic link', () => {
    describe('When it is validated', () => {
      it('Then it refuses naming that component', async () => {
        // Arrange
        const { ctx } = await withSubmodule('a/sub', 'sub');
        await ctx.fs.rename(work(ctx, 'a'), work(ctx, 'c'));
        await ctx.fs.symlink('c', work(ctx, 'a'));
        const sut = validateSubmodulePath;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), 'a/sub' as FilePath),
        );

        // Assert
        expect(result).toEqual({
          code: 'SUBMODULE_PATH_IS_SYMLINK',
          path: 'a/sub',
          component: 'a',
        });
      });
    });
  });
});

describe('isEmptyDirectory', () => {
  describe('Given a directory holding nothing', () => {
    describe('When it is probed', () => {
      it('Then it is empty', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.mkdir(work(ctx, 'e'));
        const sut = isEmptyDirectory;

        // Act
        const result = await sut(ctx, work(ctx, 'e'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a directory holding a file, a missing path and a regular file', () => {
    describe('When each is probed', () => {
      it('Then none is an empty directory', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'd/f'), 'f\n');
        const sut = isEmptyDirectory;

        // Act
        const result = await Promise.all([
          sut(ctx, work(ctx, 'd')),
          sut(ctx, work(ctx, 'missing')),
          sut(ctx, work(ctx, 'd/f')),
        ]);

        // Assert
        expect(result).toEqual([false, false, false]);
      });
    });
  });
});

describe('isEmptyDirectory', () => {
  describe('Given a directory the file system refuses to list', () => {
    describe('When it is probed', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const base = createMemoryContext();
        await init(base);
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            readdir: async () => {
              throw permissionDenied(workPath(base, 'd'));
            },
          },
        };
        const sut = isEmptyDirectory;

        // Act
        const result = await refusalOf(() => sut(ctx, workPath(base, 'd')));

        // Assert
        expect(result).toEqual({ code: 'PERMISSION_DENIED', path: workPath(base, 'd') });
      });
    });
  });
});

describe('gitfileCheckoutOf', () => {
  describe('Given a submodule reached through a gitfile', () => {
    describe('When its checkout is asked for', () => {
      it('Then the repository is answered', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result?.kind).toBe('repository');
      });
    });
  });

  describe('Given a populated directory without any .git', () => {
    describe('When its checkout is asked for', () => {
      it('Then nothing is answered', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rm(work(ctx, 'sub/.git'));
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a submodule carrying its repository in a .git directory', () => {
    describe('When its checkout is asked for', () => {
      it('Then nothing is answered', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await embed(ctx, 'sub', `${ctx.layout.gitDir}/modules/sub`);
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a .git file that is not a pointer', () => {
    describe('When its checkout is asked for', () => {
      it('Then it refuses as a repository git cannot read', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.writeUtf8(work(ctx, 'sub/.git'), 'garbage\n');
        const sut = gitfileCheckoutOf;

        // Act
        const result = await refusalOf(() => sut(ctx, 'sub' as FilePath));

        // Assert
        expect(result).toEqual({ code: 'NOT_A_REPOSITORY', path: 'sub/.git' });
      });
    });
  });

  describe('Given a nested submodule reached through a gitfile and named in the checkout', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then the repository is answered', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture);
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(fixture.ctx, 'sub' as FilePath);

        // Assert
        expect(result?.kind).toBe('repository');
      });
    });
  });

  describe('Given a nested submodule carrying its repository in a .git directory', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then nothing is answered', async () => {
        // Arrange
        const fixture = await withSubmodule();
        const nested = await withNested(fixture);
        await embed(fixture.ctx, 'sub/in', nested.layout.gitDir);
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(fixture.ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a nested submodule no .gitmodules row of the checkout names', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then nothing is answered', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture, { named: false });
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(fixture.ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('gitfileCheckoutOf over nested gitlinks git never visits', () => {
  describe('Given a nested gitlink with no directory and one holding a plain directory', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then both are skipped and the repository is answered', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture);
        const { ctx } = fixture;
        await ctx.fs.rmRecursive(work(ctx, 'sub/in'));
        await ctx.fs.mkdir(work(ctx, 'sub/in'));
        await ctx.fs.writeUtf8(work(ctx, 'sub/in/plain'), 'plain\n');
        const sut = gitfileCheckoutOf;

        // Act
        const populated = await sut(ctx, 'sub' as FilePath);
        await ctx.fs.rmRecursive(work(ctx, 'sub/in'));
        const missing = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(populated?.kind).toBe('repository');
        expect(missing?.kind).toBe('repository');
      });
    });
  });

  describe('Given a nested gitlink behind a leading directory that is a symbolic link', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then nothing is answered: git foreach fails on the link before looking inside', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture, { path: 'a/n' });
        const { ctx } = fixture;
        await ctx.fs.rename(work(ctx, 'sub/a'), work(ctx, 'sub/c'));
        await ctx.fs.symlink('c', work(ctx, 'sub/a'));
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a nested gitlink that is itself a symbolic link to its checkout', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then nothing is answered: git foreach fails on the link before looking inside', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture);
        const { ctx } = fixture;
        await ctx.fs.rename(work(ctx, 'sub/in'), work(ctx, 'sub/c'));
        await ctx.fs.symlink('c', work(ctx, 'sub/in'));
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a nested gitlink no .gitmodules row names, holding only an empty directory', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then nothing is answered: git names a gitlink before asking whether it is populated', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture, { named: false });
        const { ctx } = fixture;
        await ctx.fs.rmRecursive(work(ctx, 'sub/in'));
        await ctx.fs.mkdir(work(ctx, 'sub/in'));
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a regular file in place of a nested gitlink', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then it is skipped as unpopulated and the repository is answered', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture);
        const { ctx } = fixture;
        await ctx.fs.rmRecursive(work(ctx, 'sub/in'));
        await ctx.fs.writeUtf8(work(ctx, 'sub/in'), 'plain\n');
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result?.kind).toBe('repository');
      });
    });
  });

  describe('Given a nested gitlink whose .git is a directory holding no repository', () => {
    describe('When the outer checkout is asked for', () => {
      it('Then it is skipped as unpopulated and the repository is answered', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture);
        const { ctx } = fixture;
        await ctx.fs.rm(work(ctx, 'sub/in/.git'));
        await ctx.fs.mkdir(work(ctx, 'sub/in/.git'));
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result?.kind).toBe('repository');
      });
    });
  });

  describe('Given a submodule whose .git is a directory holding no repository', () => {
    describe('When its checkout is asked for', () => {
      it('Then nothing is answered and nothing refuses: git reads no gitfile from a directory', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await dotGitAsEmptyDirectory(ctx);
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a submodule whose .git is a link to its repository under .git/modules', () => {
    describe('When its checkout is asked for', () => {
      it('Then nothing is answered: a link to a directory is no gitfile', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await linkDotGitTo(ctx, '../.git/modules/sub');
        const sut = gitfileCheckoutOf;

        // Act
        const result = await sut(ctx, 'sub' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('absorbGitDirs', () => {
  describe('Given an embedded repository named in .gitmodules', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then the repository moves under modules with a gitfile and core.worktree left behind', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await embed(ctx, 'sub', `${ctx.layout.gitDir}/modules/sub`);
        const headBytes = await ctx.fs.readUtf8(work(ctx, 'sub/.git/HEAD'));
        const sut = absorbGitDirs;

        // Act
        await sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/HEAD`)).toBe(headBytes);
        expect(await ctx.fs.readUtf8(work(ctx, 'sub/.git'))).toBe('gitdir: ../.git/modules/sub\n');
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/config`)).toContain(
          'worktree = ../../../sub',
        );
      });
    });
  });

  describe('Given an embedded repository no .gitmodules row names', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it refuses before moving anything', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await embed(ctx, 'sub', `${ctx.layout.gitDir}/modules/sub`);
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], []),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_NAME_NOT_FOUND', path: 'sub' });
        expect((await ctx.fs.lstat(work(ctx, 'sub/.git'))).isDirectory).toBe(true);
      });
    });
  });

  describe('Given an embedded repository whose module name climbs into another module', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it refuses naming the enclosing module and moves nothing', async () => {
        // Arrange
        const { ctx } = await withSubmodule('sub', 'a');
        await embed(ctx, 'sub', `${ctx.layout.gitDir}/modules/a`);
        const other = deriveGitlinkContext(
          ctx,
          `${ctx.layout.gitDir}/modules/a`,
          'other' as FilePath,
        );
        await init(other);
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(
            ctx,
            createLeadingPathScanner(ctx),
            ['sub' as FilePath],
            [{ name: 'a/b', path: 'sub' as FilePath, url: '../up' }],
          ),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_GIT_DIR_NESTED', name: 'a/b', inside: 'a' });
        expect((await ctx.fs.lstat(work(ctx, 'sub/.git'))).isDirectory).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/a/b`)).toBe(false);
      });
    });
  });

  describe('Given a gitfile submodule holding a nested embedded repository', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then the nested repository moves under the submodule own modules directory', async () => {
        // Arrange
        const fixture = await withSubmodule();
        const nested = await withNested(fixture);
        await embed(fixture.ctx, 'sub/in', nested.layout.gitDir);
        const { ctx } = fixture;
        const sut = absorbGitDirs;

        // Act
        await sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB);

        // Assert
        const moduleDir = `${ctx.layout.gitDir}/modules/sub/modules/in`;
        expect(await ctx.fs.exists(`${moduleDir}/HEAD`)).toBe(true);
        expect(await ctx.fs.readUtf8(work(ctx, 'sub/in/.git'))).toBe(
          'gitdir: ../../.git/modules/sub/modules/in\n',
        );
        expect(await ctx.fs.readUtf8(`${moduleDir}/config`)).toContain(
          'worktree = ../../../../../sub/in',
        );
      });
    });
  });

  describe('Given a nested embedded repository no .gitmodules row of the checkout names', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it refuses naming the nested path', async () => {
        // Arrange
        const fixture = await withSubmodule();
        const nested = await withNested(fixture, { named: false });
        await embed(fixture.ctx, 'sub/in', nested.layout.gitDir);
        const { ctx } = fixture;
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_NAME_NOT_FOUND', path: 'in' });
      });
    });
  });

  describe('Given an embedded repository whose nested gitlink has no directory, then a plain one', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then the repository moves and the nested gitlink is left alone each time', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture, { named: false });
        const { ctx } = fixture;
        const moduleDir = `${ctx.layout.gitDir}/modules/sub`;
        await embed(ctx, 'sub', moduleDir);
        await ctx.fs.rmRecursive(work(ctx, 'sub/in'));
        const sut = absorbGitDirs;

        // Act
        const missing = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );
        await embed(ctx, 'sub', moduleDir);
        await ctx.fs.mkdir(work(ctx, 'sub/in'));
        await ctx.fs.writeUtf8(work(ctx, 'sub/in/plain'), 'plain\n');
        const populated = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect([missing, populated]).toEqual([undefined, undefined]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub/HEAD`)).toBe(true);
      });
    });
  });

  describe('Given an embedded repository whose module name has a leading part that is no repository', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it moves under the nested module path', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await embed(ctx, 'sub', `${ctx.layout.gitDir}/modules/sub`);
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/modules/grp/objects`);
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/modules/grp/refs`);
        const sut = absorbGitDirs;

        // Act
        await sut(
          ctx,
          createLeadingPathScanner(ctx),
          ['sub' as FilePath],
          [{ name: 'grp/sub', path: 'sub' as FilePath, url: '../up' }],
        );

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/grp/sub/HEAD`)).toBe(true);
        expect(await ctx.fs.readUtf8(work(ctx, 'sub/.git'))).toBe(
          'gitdir: ../.git/modules/grp/sub\n',
        );
      });
    });
  });

  describe('Given a gitlink with no directory and one with an empty directory', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then both are left alone', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rmRecursive(work(ctx, 'sub'));
        await ctx.fs.mkdir(work(ctx, 'e'));
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath, 'e' as FilePath], []),
        );

        // Assert
        expect(result).toBeUndefined();
        expect(await ctx.fs.exists(work(ctx, 'e'))).toBe(true);
      });
    });
  });

  describe('Given a submodule using gitfiles throughout', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then nothing moves and the gitfile stays', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture);
        const { ctx } = fixture;
        const gitfile = await ctx.fs.readUtf8(work(ctx, 'sub/.git'));
        const sut = absorbGitDirs;

        // Act
        await sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB);

        // Assert
        expect(await ctx.fs.readUtf8(work(ctx, 'sub/.git'))).toBe(gitfile);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub/modules/in/HEAD`)).toBe(true);
      });
    });
  });

  describe('Given a regular file in place of the submodule', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it is left alone', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rmRecursive(work(ctx, 'sub'));
        await ctx.fs.writeUtf8(work(ctx, 'sub'), 'plain\n');
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect(result).toBeUndefined();
        expect(await ctx.fs.readUtf8(work(ctx, 'sub'))).toBe('plain\n');
      });
    });
  });

  describe('Given a populated submodule path that is a symbolic link', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it refuses the link before looking inside', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rename(work(ctx, 'sub'), work(ctx, 'c'));
        await ctx.fs.symlink('c', work(ctx, 'sub'));
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' });
      });
    });
  });

  describe('Given a submodule whose .git is a link to a repository elsewhere in the working tree', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then the repository the link leads to moves under modules and a gitfile replaces the link', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        const beside = await repositoryLinkedFromBeside(ctx);
        const headBytes = await ctx.fs.readUtf8(`${beside}/HEAD`);
        const sut = absorbGitDirs;

        // Act
        await sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/HEAD`)).toBe(headBytes);
        expect(await ctx.fs.exists(beside)).toBe(false);
        expect(await isSymbolicLink(ctx, work(ctx, 'sub/.git'))).toBe(false);
        expect(await ctx.fs.readUtf8(work(ctx, 'sub/.git'))).toBe('gitdir: ../.git/modules/sub\n');
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/config`)).toContain(
          'worktree = ../../../sub',
        );
      });
    });
  });

  describe('Given a submodule whose .git is a link to its repository under .git/modules', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then nothing moves and the link stays: the repository already lies inside the git directory', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await linkDotGitTo(ctx, '../.git/modules/sub');
        const configBefore = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/config`);
        const sut = absorbGitDirs;

        // Act
        await sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB);

        // Assert
        expect(await isSymbolicLink(ctx, work(ctx, 'sub/.git'))).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub/HEAD`)).toBe(true);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/config`)).toBe(configBefore);
      });
    });
  });

  describe('Given a submodule whose .git is a directory holding no repository, named by no .gitmodules row', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it refuses for the missing name and creates nothing', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await dotGitAsEmptyDirectory(ctx);
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], []),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_NAME_NOT_FOUND', path: 'sub' });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub`)).toBe(false);
      });
    });
  });

  describe('Given a submodule whose .git is a directory holding no repository, named in .gitmodules', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then the module directory is created and the gitfile write over the directory refuses, as git dies there', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await dotGitAsEmptyDirectory(ctx);
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect(result).toEqual({ code: 'PERMISSION_DENIED', path: work(ctx, 'sub/.git') });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub/config`)).toBe(false);
        expect((await ctx.fs.lstat(work(ctx, 'sub/.git'))).isDirectory).toBe(true);
      });
    });
  });

  describe('Given a gitfile submodule holding a nested gitlink behind a leading directory that is a symbolic link', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it refuses naming the nested component, as git absorb-gitdirs dies inside the checkout', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture, { path: 'a/n' });
        const { ctx } = fixture;
        await ctx.fs.rename(work(ctx, 'sub/a'), work(ctx, 'sub/c'));
        await ctx.fs.symlink('c', work(ctx, 'sub/a'));
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'a/n', component: 'a' });
      });
    });
  });

  describe('Given an embedded submodule holding a nested gitlink that is itself a symbolic link', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then the outer repository moves first and the nested link then refuses, in git order', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture);
        const { ctx } = fixture;
        await embed(ctx, 'sub', `${ctx.layout.gitDir}/modules/sub`);
        await ctx.fs.rename(work(ctx, 'sub/in'), work(ctx, 'sub/c'));
        await ctx.fs.symlink('c', work(ctx, 'sub/in'));
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect(result).toEqual({ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'in' });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub/HEAD`)).toBe(true);
        expect(await ctx.fs.readUtf8(work(ctx, 'sub/.git'))).toBe('gitdir: ../.git/modules/sub\n');
      });
    });
  });

  describe('Given a gitlink whose leading directory is a link to a directory lacking it', () => {
    describe('When the matched gitlinks are absorbed', () => {
      it('Then it is skipped as unpopulated before the link is judged', async () => {
        // Arrange
        const { ctx } = await withSubmodule('a/sub', 'sub');
        await ctx.fs.rmRecursive(work(ctx, 'a/sub'));
        await ctx.fs.rename(work(ctx, 'a'), work(ctx, 'c'));
        await ctx.fs.symlink('c', work(ctx, 'a'));
        const sut = absorbGitDirs;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, createLeadingPathScanner(ctx), ['a/sub' as FilePath], ROWS_SUB),
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('gitlinkLocalModification', () => {
  const childStatusSpy = () => vi.fn((child: Context) => status(child));

  describe('Given a gitlink whose directory is gone', () => {
    describe('When its local modification is judged', () => {
      it('Then it has vanished', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rmRecursive(work(ctx, 'sub'));
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatusSpy(),
        );

        // Assert
        expect(result).toBe('vanished');
      });
    });
  });

  describe('Given a regular file in place of the submodule', () => {
    describe('When its local modification is judged', () => {
      it('Then it is modified without consulting the checkout', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rmRecursive(work(ctx, 'sub'));
        await ctx.fs.writeUtf8(work(ctx, 'sub'), 'plain\n');
        const childStatus = childStatusSpy();
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatus,
        );

        // Assert
        expect(result).toBe('modified');
        expect(childStatus).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a submodule whose HEAD moved off the recorded commit', () => {
    describe('When its local modification is judged', () => {
      it('Then it is modified without consulting the checkout', async () => {
        // Arrange
        const { ctx, child } = await withSubmodule();
        await ctx.fs.writeUtf8(work(ctx, 'sub/v'), 'v\n');
        await seedIndex(child, [
          { path: 'u', text: 'u\n' },
          { path: 'v', text: 'v\n' },
        ]);
        await commit(child, { message: 'advance', author: AUTHOR });
        const childStatus = childStatusSpy();
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatus,
        );

        // Assert
        expect(result).toBe('modified');
        expect(childStatus).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an empty directory at the gitlink', () => {
    describe('When its local modification is judged', () => {
      it('Then it is clean', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rmRecursive(work(ctx, 'sub'));
        await ctx.fs.mkdir(work(ctx, 'sub'));
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatusSpy(),
        );

        // Assert
        expect(result).toBe('clean');
      });
    });
  });

  describe('Given a populated directory without any .git', () => {
    describe('When its local modification is judged', () => {
      it('Then it is modified without consulting the checkout', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.rm(work(ctx, 'sub/.git'));
        const childStatus = childStatusSpy();
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatus,
        );

        // Assert
        expect(result).toBe('modified');
        expect(childStatus).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a clean submodule reached through a gitfile', () => {
    describe('When its local modification is judged', () => {
      it('Then the checkout is consulted once and it is clean', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        const childStatus = childStatusSpy();
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatus,
        );

        // Assert
        expect(result).toBe('clean');
        expect(childStatus).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a submodule holding an untracked file', () => {
    describe('When its local modification is judged', () => {
      it('Then it is modified', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await ctx.fs.writeUtf8(work(ctx, 'sub/stray'), 'stray\n');
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatusSpy(),
        );

        // Assert
        expect(result).toBe('modified');
      });
    });
  });

  describe('Given a submodule below a symlinked leading directory', () => {
    describe('When its local modification is judged', () => {
      it('Then it refuses naming the component', async () => {
        // Arrange
        const { ctx } = await withSubmodule('a/sub', 'sub');
        await ctx.fs.rename(work(ctx, 'a'), work(ctx, 'c'));
        await ctx.fs.symlink('c', work(ctx, 'a'));
        const sut = gitlinkLocalModification;

        // Act
        const result = await refusalOf(async () =>
          sut(
            ctx,
            createLeadingPathScanner(ctx),
            await gitlinkEntry(ctx, 'a/sub'),
            childStatusSpy(),
          ),
        );

        // Assert
        expect(result).toEqual({
          code: 'SUBMODULE_PATH_IS_SYMLINK',
          path: 'a/sub',
          component: 'a',
        });
      });
    });
  });

  describe('Given a skip-worktree gitlink whose HEAD moved', () => {
    describe('When its local modification is judged', () => {
      it('Then the moved HEAD is not counted and the clean checkout decides', async () => {
        // Arrange
        const { ctx, child } = await withSubmodule();
        await ctx.fs.writeUtf8(work(ctx, 'sub/v'), 'v\n');
        await seedIndex(child, [
          { path: 'u', text: 'u\n' },
          { path: 'v', text: 'v\n' },
        ]);
        await commit(child, { message: 'advance', author: AUTHOR });
        const entry = await gitlinkEntry(ctx, 'sub');
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          { ...entry, flags: { ...entry.flags, skipWorktree: true } },
          childStatusSpy(),
        );

        // Assert
        expect(result).toBe('clean');
      });
    });
  });

  describe('Given an assume-valid gitlink whose HEAD moved', () => {
    describe('When its local modification is judged', () => {
      it('Then the moved HEAD is not counted and the clean checkout decides', async () => {
        // Arrange
        const { ctx, child } = await withSubmodule();
        await ctx.fs.writeUtf8(work(ctx, 'sub/v'), 'v\n');
        await seedIndex(child, [
          { path: 'u', text: 'u\n' },
          { path: 'v', text: 'v\n' },
        ]);
        await commit(child, { message: 'advance', author: AUTHOR });
        const entry = await gitlinkEntry(ctx, 'sub');
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          { ...entry, flags: { ...entry.flags, assumeValid: true } },
          childStatusSpy(),
        );

        // Assert
        expect(result).toBe('clean');
      });
    });
  });

  describe('Given a submodule whose checkout holds an unmerged entry', () => {
    describe('When its local modification is judged', () => {
      it('Then it is modified', async () => {
        // Arrange
        const { ctx, child } = await withSubmodule();
        await unmergeEntry(child, 'u');
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatusSpy(),
        );

        // Assert
        expect(result).toBe('modified');
      });
    });
  });

  describe('Given a submodule whose checkout records an unnamed gitlink holding an empty directory', () => {
    describe('When its local modification is judged', () => {
      it('Then it is modified without consulting the checkout', async () => {
        // Arrange
        const fixture = await withSubmodule();
        await withNested(fixture, { named: false });
        const { ctx } = fixture;
        await ctx.fs.rmRecursive(work(ctx, 'sub/in'));
        await ctx.fs.mkdir(work(ctx, 'sub/in'));
        const childStatus = childStatusSpy();
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatus,
        );

        // Assert
        expect(result).toBe('modified');
        expect(childStatus).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a submodule whose .git is a link to its repository under .git/modules', () => {
    describe('When its local modification is judged', () => {
      it('Then it is modified without consulting the checkout: no gitfile is in use', async () => {
        // Arrange
        const { ctx } = await withSubmodule();
        await linkDotGitTo(ctx, '../.git/modules/sub');
        const childStatus = childStatusSpy();
        const sut = gitlinkLocalModification;

        // Act
        const result = await sut(
          ctx,
          createLeadingPathScanner(ctx),
          await gitlinkEntry(ctx, 'sub'),
          childStatus,
        );

        // Assert
        expect(result).toBe('modified');
        expect(childStatus).not.toHaveBeenCalled();
      });
    });
  });
});
