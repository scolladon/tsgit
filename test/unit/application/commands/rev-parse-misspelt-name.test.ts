import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { evaluateRevision, revParse } from '../../../../src/application/commands/rev-parse.js';
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
    { arg: 'dg:../absent', failure: {} },
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
    it('Then it refuses after the one read', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo((message) => warnings.push(message));
      if (setup === 'file') await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${arg}`, '');
      const sut = revParse;

      // Act
      await failureOf(() => sut(ctx, arg));

      // Assert
      expect(warnings).toEqual([DANGLING]);
    });
  });

  describe('When revParse reads it in a bare repository whose git dir holds that path', () => {
    it('Then it refuses after the one read', async () => {
      // Arrange
      const warnings: string[] = [];
      const repo = await danglingRepo((message) => warnings.push(message));
      const { workDir: _workDir, ...bareLayout } = repo.layout;
      const ctx = { ...repo, layout: { ...bareLayout, bare: true } } as Context;
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/dg~5`, '');
      const sut = revParse;

      // Act
      await failureOf(() => sut(ctx, 'dg~5'));

      // Assert
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
    it('Then it refuses with the read failure, never probing outside', async () => {
      // Arrange
      const ctx = await danglingRepo(() => undefined);
      const sut = revParse;

      // Act
      const result = await failureOf(() => sut(ctx, '../outside~1'));

      // Assert
      expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: '../outside' });
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
