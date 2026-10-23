import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { pathspecNoMatch, TsgitError } from '../../../../src/domain/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;

const FILES: Readonly<Record<string, string>> = {
  x: 'x body',
  y: 'y body',
  'd/x': 'dx body',
  'a.txt': 'a body',
};

const untracked = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: FILES });
  return ctx;
};

const tracked = async (): Promise<Ctx> => {
  const ctx = await untracked();
  await add(ctx, [], { all: true });
  for (const [name, body] of Object.entries(FILES)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${body} rewritten`);
  }
  return ctx;
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof TsgitError) return err.data;
    throw err;
  }
  return undefined;
};

const looseObjectCount = async (ctx: Ctx): Promise<number> => {
  const objects = `${ctx.layout.gitDir}/objects`;
  if (!(await ctx.fs.exists(objects))) return 0;
  const prefixes = await ctx.fs.readdir(objects);
  const counts = await Promise.all(
    prefixes.map(async ({ name }) => (await ctx.fs.readdir(`${objects}/${name}`)).length),
  );
  return counts.reduce((sum, count) => sum + count, 0);
};

const stagedPaths = async (ctx: Ctx) => (await readIndex(ctx)).entries.map((e) => e.path);

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Paths whose staged blob equals the working-tree file: what this add just staged. */
const restagedPaths = async (ctx: Ctx): Promise<FilePath[]> => {
  const { entries } = await readIndex(ctx);
  const staged = await Promise.all(
    entries.map(async (entry) => {
      const working = await ctx.fs.readUtf8(`${ctx.layout.workDir}/${entry.path}`);
      return dec((await readBlob(ctx, entry.id)).content) === working ? entry.path : undefined;
    }),
  );
  return staged.filter((path): path is FilePath => path !== undefined).sort();
};

describe('Given an untracked file named by a literal and excluded by a negation', () => {
  describe('When add receives the literal followed by its exclusion', () => {
    it('Then nothing is staged and no blob is written', async () => {
      // Arrange
      const ctx = await untracked();
      const looseBefore = await looseObjectCount(ctx);
      const sut = add;

      // Act
      const result = await sut(ctx, ['x', '!x']);

      // Assert
      expect(result.added).toEqual([]);
      expect(await stagedPaths(ctx)).toEqual([]);
      expect(await looseObjectCount(ctx)).toBe(looseBefore);
    });
  });
});

const acceptedRows = [
  { fixture: 'untracked', args: ['d/x', '!d'], restaged: [] as string[] },
  { fixture: 'untracked', args: ['a.txt', '!*.txt'], restaged: [] as string[] },
  { fixture: 'untracked', args: ['x', '!y'], restaged: ['x'] },
  { fixture: 'untracked', args: ['x', 'y', '!x'], restaged: ['y'] },
  { fixture: 'untracked', args: ['x', '*.txt', '!x'], restaged: ['a.txt'] },
  { fixture: 'untracked', args: ['d', '!d/x'], restaged: [] as string[] },
  { fixture: 'tracked', args: ['x', '!x'], restaged: [] as string[] },
  { fixture: 'tracked', args: ['d/x', '!d'], restaged: [] as string[] },
  { fixture: 'tracked', args: ['a.txt', '!*.txt'], restaged: [] as string[] },
  { fixture: 'tracked', args: ['x', '!y'], restaged: ['x'] },
  { fixture: 'tracked', args: ['x', 'y', '!x'], restaged: ['y'] },
  { fixture: 'tracked', args: ['x', '*.txt', '!x'], restaged: ['a.txt'] },
];

describe.each(acceptedRows)('Given the $fixture fixture', ({ fixture, args, restaged }) => {
  describe(`When add receives ${JSON.stringify(args)}`, () => {
    it('Then it stages only the paths no exclusion removes', async () => {
      // Arrange
      const ctx = fixture === 'tracked' ? await tracked() : await untracked();
      const sut = add;

      // Act
      const result = await sut(ctx, [...args]);

      // Assert
      expect(await restagedPaths(ctx)).toEqual(restaged);
      expect(result.added).toEqual(fixture === 'untracked' ? restaged : []);
      expect(result.modified).toEqual(fixture === 'tracked' ? restaged : []);
      expect(result.removed).toEqual([]);
      expect(result.sparse).toEqual([]);
      expect(result.ignored).toEqual([]);
    });
  });
});

const refusedRows = [
  { args: ['missing', '!missing'], refused: 'missing' },
  { args: ['x*', '!x'], refused: 'x*' },
  { args: ['q*', '!q*'], refused: 'q*' },
  { args: ['x', '!x', 'nomatch*'], refused: 'nomatch*' },
];

describe.each(refusedRows)('Given an untracked fixture', ({ args, refused }) => {
  describe(`When add receives ${JSON.stringify(args)}`, () => {
    it('Then it refuses the unmatched pathspec and writes nothing', async () => {
      // Arrange
      const ctx = await untracked();
      const looseBefore = await looseObjectCount(ctx);
      const sut = add;

      // Act
      const result = await refusalOf(() => sut(ctx, [...args]));

      // Assert
      expect(result).toEqual(pathspecNoMatch(refused).data);
      expect(await stagedPaths(ctx)).toEqual([]);
      expect(await looseObjectCount(ctx)).toBe(looseBefore);
    });
  });
});
