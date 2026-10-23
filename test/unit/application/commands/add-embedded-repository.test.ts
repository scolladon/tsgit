import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { serializeAndHash } from '../../../../src/application/primitives/internal/serialize-and-hash.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { FILE_MODE, type ObjectId } from '../../../../src/domain/objects/index.js';
import { seedIndex } from './add-index-fixtures.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;

const BRANCH_HEAD = 'c'.repeat(40);

/** A repository laid at `<dir>/.git`, with a commit on its branch unless `head` is null. */
const layOutRepository = async (
  ctx: Ctx,
  directory: string,
  head: string | null = BRANCH_HEAD,
): Promise<void> => {
  const gitDir = `${ctx.layout.workDir}/${directory}/.git`;
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${gitDir}/objects`);
  await ctx.fs.mkdir(`${gitDir}/refs`);
  if (head !== null) await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${head}\n`);
};

const embedded = async (
  workingTree: Readonly<Record<string, string>> = {},
  head: string | null = BRANCH_HEAD,
): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  await layOutRepository(ctx, 'sub', head);
  return ctx;
};

const entryOf = async (ctx: Ctx, path: string) =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === path);

describe('add over an untracked repository', () => {
  describe('Given an untracked repository with a commit', () => {
    describe('When the whole tree is added', () => {
      it('Then it is staged as a gitlink at its HEAD', async () => {
        // Arrange
        const ctx = await embedded();
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        const staged = await entryOf(ctx, 'sub');
        expect(result.added).toEqual(['sub']);
        expect(staged?.mode).toBe(FILE_MODE.GITLINK);
        expect(staged?.id).toBe(BRANCH_HEAD);
      });
    });
  });
});

describe.each([
  { label: 'a directory literal', spec: ['sub'] },
  { label: 'a directory literal with a trailing slash', spec: ['sub/'] },
  { label: 'a wildcard', spec: ['s*'] },
  { label: 'a wildcard with a trailing slash', spec: ['su?/'] },
])('add over an untracked repository, $label', ({ spec }) => {
  describe('Given an untracked repository with a commit', () => {
    describe('When it is added', () => {
      it('Then it is staged as a gitlink', async () => {
        // Arrange
        const ctx = await embedded();
        const sut = add;

        // Act
        const result = await sut(ctx, spec);

        // Assert
        expect(result.added).toEqual(['sub']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(BRANCH_HEAD);
      });
    });
  });
});

describe('add over an untracked repository, a wildcard that cannot reach a directory', () => {
  describe.each([{ spec: ['*b'] }, { spec: ['su?'] }])(
    'Given an untracked repository and $spec',
    ({ spec }) => {
      describe('When it is added', () => {
        it('Then the pathspec is refused as matching nothing', async () => {
          // Arrange
          const ctx = await embedded();
          const sut = add;

          // Act
          const refusal = await refusalOf(() => sut(ctx, spec));

          // Assert
          expect(refusal).toEqual({ code: 'PATHSPEC_NO_MATCH', pattern: spec[0], patterns: spec });
          expect(await entryOf(ctx, 'sub')).toBeUndefined();
        });
      });
    },
  );
});

const blobExists = async (ctx: Ctx, content: string) => {
  const { id } = await serializeAndHash(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode(content),
  });
  return ctx.fs.exists(`${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`);
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

describe('add over an untracked repository with no commit', () => {
  describe('Given such a repository beside an untracked file', () => {
    describe('When the whole tree is added', () => {
      it('Then it is refused before the file is written', async () => {
        // Arrange
        const ctx = await embedded({ a: 'a\n' }, null);
        const sut = add;

        // Act
        const refusal = await refusalOf(() => sut(ctx, ['.']));

        // Assert
        expect(refusal).toEqual({ code: 'NO_COMMIT_CHECKED_OUT', path: 'sub/' });
        expect(await blobExists(ctx, 'a\n')).toBe(false);
        expect((await readIndex(ctx)).entries).toEqual([]);
      });
    });
  });
});

describe('add over untracked repositories with no commit, in path order', () => {
  describe.each([{ spec: ['.'] }, { spec: ['b', 'a'] }])(
    'Given two such repositories and $spec',
    ({ spec }) => {
      describe('When they are added', () => {
        it('Then the first in path order is the one refused', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, { workingTree: {} });
          await layOutRepository(ctx, 'b', null);
          await layOutRepository(ctx, 'a', null);
          const sut = add;

          // Act
          const refusal = await refusalOf(() => sut(ctx, spec));

          // Assert
          expect(refusal).toEqual({ code: 'NO_COMMIT_CHECKED_OUT', path: 'a/' });
        });
      });
    },
  );
});

describe('add over a repository nested in a directory', () => {
  describe('Given a repository beside a file in a directory', () => {
    describe('When the directory is added', () => {
      it('Then the file and the gitlink are staged', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'd/f': 'f\n' } });
        await layOutRepository(ctx, 'd/sub');
        const sut = add;

        // Act
        const result = await sut(ctx, ['d']);

        // Assert
        expect(result.added).toEqual(['d/f', 'd/sub']);
        expect((await entryOf(ctx, 'd/sub'))?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });

  describe('Given a repository inside the repository', () => {
    describe('When the whole tree is added', () => {
      it('Then only the outer one is staged', async () => {
        // Arrange
        const ctx = await embedded();
        await layOutRepository(ctx, 'sub/inner', 'd'.repeat(40));
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.added).toEqual(['sub']);
      });
    });
  });
});

describe('add over a tracked file replaced by a repository', () => {
  describe('Given a tracked file where an untracked repository now stands', () => {
    describe('When the whole tree is added', () => {
      it('Then the path is reported as modified, not removed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: {} });
        await seedIndex(ctx, [{ path: 'sub', text: 'was a file\n' }]);
        await layOutRepository(ctx, 'sub');
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect(result.removed).toEqual([]);
        expect((await entryOf(ctx, 'sub'))?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });
});
