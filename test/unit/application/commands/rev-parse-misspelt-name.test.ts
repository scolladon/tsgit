import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  evaluateRevision,
  resolveRevision,
  revParse,
} from '../../../../src/application/commands/rev-parse.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DANGLING = 'ignoring dangling symref refs/tags/dg';

/** One commit on `dg`, and `refs/tags/dg` a symref to nothing — every read of `dg` warns once. */
const danglingRepo = async (warn: (message: string) => void): Promise<Context> => {
  const base = createMemoryContext();
  const { commitIds } = await seedRepo(base, { commits: [{ tree: EMPTY_TREE }] });
  const tip = commitIds[0] as ObjectId;
  await seedRepo(base, { refs: { 'refs/heads/main': tip, 'refs/heads/dg': tip } });
  await base.fs.writeUtf8(`${base.layout.gitDir}/refs/tags/dg`, 'ref: refs/tags/nope\n');
  return { ...base, logger: { warn } } as Context;
};

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('Given an expression whose name warns but which names no object', () => {
  describe.each([
    { arg: 'dg~5', failure: { code: 'OBJECT_NOT_FOUND' } },
    { arg: 'dg:absent', failure: { code: 'PATH_NOT_IN_TREE', rev: 'dg', path: 'absent' } },
    {
      arg: 'dg:absent/deeper',
      failure: { code: 'PATH_NOT_IN_TREE', rev: 'dg', path: 'absent/deeper' },
      file: 'dg:absent',
    },
  ])('When revParse reads $arg', ({ arg, failure, file }) => {
    it('Then it reads the name a second time before refusing, warning on each read', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      if (file !== undefined) await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, '');
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, arg));

      // Assert
      expect(result).toMatchObject(failure);
      expect(warnings).toEqual([DANGLING, DANGLING]);
    });
  });

  describe.each([
    { label: 'a working-tree file', arg: 'dg~5', setup: 'file' },
    { label: 'a glob a pathspec would match', arg: 'dg:absent*', setup: 'none' },
  ])('When revParse reads an argument that names $label', ({ arg, setup }) => {
    it('Then it answers the argument as a path after the one read', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      if (setup === 'file') await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${arg}`, '');
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual([{ kind: 'path', path: arg }]);
      expect(warnings).toEqual([DANGLING]);
    });
  });

  describe('When revParse reads it in a bare repository whose git dir holds that path', () => {
    it('Then it answers the argument as a path after the one read', async () => {
      // Arrange
      const warnings: string[] = [];
      const repo = await danglingRepo((message) => warnings.push(message));
      const { workDir: _workDir, ...bareLayout } = repo.layout;
      const ctx = { ...repo, layout: { ...bareLayout, bare: true } } as Context;
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/dg~5`, '');
      const sut = revParse;

      // Act
      const result = await sut(ctx, 'dg~5');

      // Assert
      expect(result).toEqual([{ kind: 'path', path: 'dg~5' }]);
      expect(warnings).toEqual([DANGLING]);
    });
  });

  describe('When the probe for a same-named path is refused', () => {
    it('Then revParse surfaces the refusal', async () => {
      // Arrange
      const repo = await danglingRepo(() => undefined);
      const denied = { code: 'PERMISSION_DENIED', path: 'dg~5' } as const;
      const lexists = (): Promise<boolean> => Promise.reject(new TsgitError(denied));
      const ctx = { ...repo, fs: { ...repo.fs, lexists } } as Context;
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, 'dg~5'));

      // Assert
      expect(result).toEqual(denied);
    });
  });

  describe('When its second read is refused for a reason other than naming nothing', () => {
    it('Then revParse surfaces that refusal as is', async () => {
      // Arrange
      const refusal = new TsgitError({ code: 'PERMISSION_DENIED', path: 'logger' });
      let reads = 0;
      const ctx = await danglingRepo(() => {
        reads += 1;
        if (reads > 1) throw refusal;
      });
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, 'dg~5'));

      // Assert
      expect(result).toBe(refusal.data);
    });
  });

  describe('When revParse is refused for a reason other than naming nothing', () => {
    it('Then it never probes for a same-named path', async () => {
      // Arrange
      const repo = await danglingRepo(() => undefined);
      await repo.fs.writeUtf8(
        `${repo.layout.gitDir}/config`,
        '[core]\n\trepositoryformatversion = 0\n\twarnAmbiguousRefs = maybe\n',
      );
      const probed: string[] = [];
      const lexists = (path: string): Promise<boolean> => {
        probed.push(path);
        return Promise.resolve(false);
      };
      const ctx = { ...repo, fs: { ...repo.fs, lexists } } as Context;
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, 'dg~5'));

      // Assert
      expect(result).toMatchObject({ code: 'CONFIG_BAD_BOOLEAN_VALUE' });
      expect(probed).toEqual([]);
    });
  });

  describe('When revParse reads an argument climbing out of the repository', () => {
    it('Then it refuses with the read failure, carrying the path line printed first', async () => {
      // Arrange
      const ctx = await danglingRepo(() => undefined);
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, '../outside~1'));

      // Assert
      expect(result).toEqual({
        code: 'OBJECT_NOT_FOUND',
        id: '../outside',
        printed: [{ kind: 'path', path: '../outside~1' }],
      });
    });
  });

  describe('When its relative path climbs out of the worktree', () => {
    it('Then it refuses the path after the one read', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, 'dg:../absent'));

      // Assert
      expect(result).toEqual({ code: 'PATHSPEC_OUTSIDE_REPO', path: '../absent' });
      expect(warnings).toEqual([DANGLING, DANGLING]);
    });
  });

  describe('When its parent hops climb to a path the filename probe finds', () => {
    it('Then it answers the path without a second read, probing it as written', async () => {
      // Arrange
      const warnings: string[] = [];
      const repo = await danglingRepo((message) => warnings.push(message));
      const probed: string[] = [];
      const filenameProbe = (path: string): Promise<boolean> => {
        probed.push(path);
        return Promise.resolve(true);
      };
      const ctx = { ...repo, filenameProbe } as Context;
      const sut = revParse;

      // Act
      const result = await sut(ctx, 'dg:a/../../outside');

      // Assert
      expect(result).toEqual([{ kind: 'path', path: 'dg:a/../../outside' }]);
      expect(warnings).toEqual([DANGLING, DANGLING]);
      expect(probed).toEqual([`${repo.layout.workDir}/dg:a/../../outside`]);
    });
  });

  describe('When its parent hops climb to a path the filename probe does not find', () => {
    it('Then it reads the name a second time before refusing', async () => {
      // Arrange
      const warnings: string[] = [];
      const repo = await danglingRepo((message) => warnings.push(message));
      const filenameProbe = (): Promise<boolean> => Promise.resolve(false);
      const ctx = { ...repo, filenameProbe } as Context;
      const sut = revParse;

      // Act
      await failureOf(() => sut(ctx, 'dg:a/../../absent'));

      // Assert
      expect(warnings).toEqual([DANGLING, DANGLING, DANGLING]);
    });
  });

  describe('When a bare repository probes parent hops', () => {
    it('Then the filename probe starts from the git dir', async () => {
      // Arrange
      const repo = await danglingRepo(() => undefined);
      const { workDir: _workDir, ...bareLayout } = repo.layout;
      const probed: string[] = [];
      const filenameProbe = (path: string): Promise<boolean> => {
        probed.push(path);
        return Promise.resolve(true);
      };
      const ctx = { ...repo, layout: { ...bareLayout, bare: true }, filenameProbe } as Context;
      const sut = revParse;

      // Act
      await failureOf(() => sut(ctx, 'dg:a/../../outside'));

      // Assert
      expect(probed).toEqual([`${repo.layout.gitDir}/dg:a/../../outside`]);
    });
  });

  describe.each([
    { arg: '/outside/x', path: '/outside/x' },
    { arg: '://outside/x', path: '/outside/x' },
    { arg: ':!/outside/x', path: '/outside/x' },
  ])('When it reads the absolute argument $arg the filename probe finds', ({ arg, path }) => {
    it('Then it answers the path, probing it where it stands', async () => {
      // Arrange
      const repo = await danglingRepo(() => undefined);
      const probed: string[] = [];
      const filenameProbe = (probedPath: string): Promise<boolean> => {
        probed.push(probedPath);
        return Promise.resolve(true);
      };
      const ctx = { ...repo, cwd: `${repo.layout.workDir}/sub`, filenameProbe } as Context;
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual([{ kind: 'path', path: arg }]);
      expect(probed).toEqual([path]);
    });
  });

  describe('When a Windows-syntax repository reads a drive-absolute argument', () => {
    it('Then the filename probe answers it where it stands', async () => {
      // Arrange
      const repo = await danglingRepo(() => undefined);
      const probed: string[] = [];
      const filenameProbe = (probedPath: string): Promise<boolean> => {
        probed.push(probedPath);
        return Promise.resolve(true);
      };
      const ctx = { ...repo, windowsPathSyntax: true, filenameProbe } as Context;
      const sut = revParse;

      // Act
      const result = await sut(ctx, 'C:/outside');

      // Assert
      expect(result).toEqual([{ kind: 'path', path: 'C:/outside' }]);
      expect(probed).toEqual(['C:/outside']);
    });
  });

  describe('When it reads an absolute argument with no filename probe', () => {
    it('Then the path reads as absent and the argument is refused', async () => {
      // Arrange
      const ctx = await danglingRepo(() => undefined);
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/outside`, '');
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, '/outside'));

      // Assert
      expect(result).toMatchObject({ printed: [{ kind: 'path', path: '/outside' }] });
    });
  });

  describe('When the filename probe is refused', () => {
    it('Then revParse surfaces the refusal', async () => {
      // Arrange
      const repo = await danglingRepo(() => undefined);
      const denied = { code: 'PERMISSION_DENIED', path: 'dg:a/../../x' } as const;
      const filenameProbe = (): Promise<boolean> => Promise.reject(new TsgitError(denied));
      const ctx = { ...repo, filenameProbe } as Context;
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, 'dg:a/../../x'));

      // Assert
      expect(result).toEqual(denied);
    });
  });

  describe('When a reader that cannot take it as a filename resolves it', () => {
    it('Then it refuses after the one read', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      const sut = resolveRevision;

      // Act
      const result = await failureOf(() => sut(ctx, 'dg~5', 'stdin'));

      // Assert
      expect(result).toMatchObject({ code: 'OBJECT_NOT_FOUND' });
      expect(warnings).toEqual([DANGLING]);
    });
  });

  describe('When a command evaluates it once', () => {
    it('Then it refuses after the one read', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      const sut = evaluateRevision;

      // Act
      const result = await failureOf(() => sut(ctx, 'dg~5'));

      // Assert
      expect(result).toMatchObject({ code: 'OBJECT_NOT_FOUND' });
      expect(warnings).toEqual([DANGLING]);
    });
  });
});

describe('Given an argument a `..` splits', () => {
  describe.each([
    { arg: 'dg..nope', reads: 1 },
    { arg: 'dg...nope', reads: 1 },
    { arg: 'dg~5..x', reads: 1 },
    { arg: 'nope..dg', reads: 0 },
    { arg: 'x..dg~5', reads: 0 },
    { arg: '..nope', reads: 0 },
    { arg: 'dg:a/..', reads: 3 },
  ])('When revParse reads $arg', ({ arg, reads }) => {
    it('Then it reads each side as git does before the whole', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      const sut = revParse;

      // Act
      await failureOf(() => sut(ctx, arg));

      // Assert
      expect(warnings).toEqual(Array.from({ length: reads }, () => DANGLING));
    });
  });

  describe('When revParse reads it and a side is refused for another reason', () => {
    it('Then it surfaces that refusal', async () => {
      // Arrange
      const ctx = await danglingRepo(() => undefined);
      const corrupt = 'ab'.padEnd(40, '0');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/objects/ab/${corrupt.slice(2)}`, 'garbage');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/c`, `${corrupt}\n`);
      const sut = revParse;
      const sideRefusal = await failureOf(() => sut(ctx, 'c^{commit}'));

      // Act
      const result = await failureOf(() => sut(ctx, 'c^{commit}..nope'));

      // Assert
      expect(result).toEqual(sideRefusal);
      expect(result).not.toMatchObject({ code: 'REVPARSE_UNRESOLVED' });
    });
  });
});

describe('Given an expression that resolves after a warning', () => {
  describe('When revParse reads it', () => {
    it('Then it reads the name once', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      const sut = revParse;

      // Act
      await sut(ctx, 'dg');

      // Assert
      expect(warnings).toEqual([DANGLING]);
    });
  });
});

describe('Given a dangling refs/tags/HEAD beside HEAD', () => {
  const headRepo = async (warn: (message: string) => void): Promise<Context> => {
    const ctx = await danglingRepo(warn);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/HEAD`, 'ref: refs/tags/nothing\n');
    return ctx;
  };
  const HEAD_DANGLING = 'ignoring dangling symref refs/tags/HEAD';

  describe.each([
    { source: 'stdin', reads: [HEAD_DANGLING, HEAD_DANGLING] },
    { source: 'command-line', reads: [] },
  ] as const)('When a $source reader resolves a bare ..', ({ source, reads }) => {
    it('Then it reads HEAD as both range sides only where .. cannot be a path', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await headRepo((message) => warnings.push(message));
      const sut = resolveRevision;

      // Act
      await failureOf(() => sut(ctx, '..', source));

      // Assert
      expect(warnings).toEqual(reads);
    });
  });
});
