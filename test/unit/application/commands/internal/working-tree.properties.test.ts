/**
 * Lens 1 (counting invariant) — every entry of the source maps 1:1 to the destination
 * with the same relative path, kind and bytes, empty directories included.
 * Lens 2 (independent oracle) — the memory adapter's own `renameDirectory` moves the
 * same tree in one step; the entry-by-entry move must leave the identical listing.
 * Lenses 3 and 4 do not fit: the move is neither a total function over a safe subset
 * nor an operation that composes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { renameInWorkingTree } from '../../../../../src/application/commands/internal/working-tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { directoryTreeArb, type TreeEntry } from './arbitraries.js';

const NUM_RUNS = 100;

const seed = async (
  ctx: Context,
  dir: string,
  entries: Readonly<Record<string, TreeEntry>>,
): Promise<void> => {
  await ctx.fs.mkdir(dir);
  for (const [name, entry] of Object.entries(entries)) {
    const path = `${dir}/${name}`;
    if (entry.kind === 'file') await ctx.fs.write(path, entry.bytes);
    else if (entry.kind === 'symlink') await ctx.fs.symlink(entry.target, path);
    else await seed(ctx, path, entry.entries);
  }
};

const listing = async (ctx: Context, dir: string, prefix = ''): Promise<string[]> => {
  const lines: string[] = [];
  for (const entry of await ctx.fs.readdir(dir)) {
    const path = `${dir}/${entry.name}`;
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory) lines.push(`d ${rel}`, ...(await listing(ctx, path, rel)));
    else if (entry.isSymbolicLink) lines.push(`l ${rel} ${await ctx.fs.readlink(path)}`);
    else lines.push(`f ${rel} ${Array.from(await ctx.fs.read(path)).join(',')}`);
  }
  return lines.sort();
};

const moved = async (
  entries: Readonly<Record<string, TreeEntry>>,
  withCapability: boolean,
): Promise<{ readonly ctx: Context; readonly root: string }> => {
  const base = createMemoryContext();
  const root = `${base.layout.workDir}`;
  await seed(base, `${root}/old`, entries);
  const { renameDirectory: _absent, ...bare } = base.fs;
  const ctx: Context = withCapability ? base : { ...base, fs: bare };
  await renameInWorkingTree(ctx, 'old', 'new');
  return { ctx, root };
};

describe('renameInWorkingTree entry by entry', () => {
  describe('Given any generated directory tree', () => {
    describe('When it is moved without renameDirectory', () => {
      it('Then the destination lists exactly what a one-step move lists and the source is gone', async () => {
        await fc.assert(
          fc.asyncProperty(directoryTreeArb(), async (entries) => {
            // Arrange
            const oracle = await moved(entries, true);

            // Act
            const sut = await moved(entries, false);

            // Assert
            expect(await listing(sut.ctx, `${sut.root}/new`)).toEqual(
              await listing(oracle.ctx, `${oracle.root}/new`),
            );
            expect(await sut.ctx.fs.exists(`${sut.root}/old`)).toBe(false);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
