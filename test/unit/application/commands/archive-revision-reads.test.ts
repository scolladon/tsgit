import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { archive } from '../../../../src/application/commands/archive.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DANGLING = 'ignoring dangling symref refs/tags/dg';

/** One commit on `dg`, and `refs/tags/dg` a symref to nothing — every read of `dg` warns once. */
const danglingRepo = async (warnings: string[]): Promise<Context> => {
  const base = createMemoryContext();
  const { commitIds } = await seedRepo(base, { commits: [{ tree: EMPTY_TREE }] });
  const tip = commitIds[0] as ObjectId;
  await seedRepo(base, { refs: { 'refs/heads/main': tip, 'refs/heads/dg': tip } });
  await base.fs.writeUtf8(`${base.layout.gitDir}/refs/tags/dg`, 'ref: refs/tags/nope\n');
  return { ...base, logger: { warn: (message: string) => warnings.push(message) } } as Context;
};

describe('Given a name whose every read warns', () => {
  describe('When archive exports it', () => {
    it('Then it reads the name as a ref, then as an object name', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo(warnings);
      const sut = archive;

      // Act
      await sut(ctx, { treeish: 'dg' });

      // Assert
      expect(warnings).toEqual([DANGLING, DANGLING]);
    });
  });

  describe.each([
    { treeish: 'dg~5', reads: 1, code: 'OBJECT_NOT_FOUND' },
    { treeish: 'dg:absent', reads: 1, code: 'PATH_NOT_IN_TREE' },
    { treeish: 'dg..nope', reads: 0, code: 'OBJECT_NOT_FOUND' },
    { treeish: 'nope..dg', reads: 0, code: 'OBJECT_NOT_FOUND' },
  ])('When archive exports $treeish, which names no object', ({ treeish, reads, code }) => {
    it('Then it refuses after reading the whole name once, with no range sides', async () => {
      // Arrange
      const warnings: string[] = [];
      const ctx = await danglingRepo(warnings);
      const sut = archive;

      // Act
      const result = await sut(ctx, { treeish }).catch((error: TsgitError) => error.data.code);

      // Assert
      expect(result).toBe(code);
      expect(warnings).toEqual(Array.from({ length: reads }, () => DANGLING));
    });
  });
});
