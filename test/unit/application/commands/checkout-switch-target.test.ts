import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { readHeadRaw as readHead } from '../../../../src/application/primitives/internal/repo-state.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import { pathspecNoMatch } from '../../../../src/domain/commands/error.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  type AuthorIdentity,
  type ObjectId,
  zeroOid,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** `main` with one commit and a `side` branch at it; no checkout recorded yet. */
const seed = async (): Promise<{ readonly ctx: Context; readonly base: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await updateConfigEntries(ctx, [
    { section: 'user', key: 'name', value: author.name },
    { section: 'user', key: 'email', value: author.email },
  ]);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, 'base\n');
  await add(ctx, ['f']);
  const base = (await commit(ctx, { message: 'base', author })).id;
  await branchCreate(ctx, { name: 'side' });
  return { ctx, base };
};

const write = (ctx: Context, rel: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);

const read = (ctx: Context, rel: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.workDir}/${rel}`);

const HEAD_ON_MAIN = 'ref: refs/heads/main\n';

const readHeadFile = (ctx: Context): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);

const CONFLICT_STAGES: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];

/** Replaces the index entry of `rel` by its stages 1 to 3, as an unfinished merge leaves it. */
const unmerge = async (ctx: Context, rel: string): Promise<void> => {
  const index = await readIndex(ctx);
  const entries = index.entries.flatMap((entry) =>
    entry.path === rel
      ? CONFLICT_STAGES.map((stage) => ({ ...entry, flags: { ...entry.flags, stage } }))
      : [entry],
  );
  const lock = await acquireIndexLock(ctx);
  await lock.commit(entries, 'replace');
  await lock.release();
};

const refusal = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => (error as TsgitError).data,
  );

describe('checkout of a switch target git cannot switch to', () => {
  describe.each(['nope', 'nope~1', 'HEAD~5', 'nope^{tree}', 'HEAD^{/nomatch}', '-'])(
    'Given %s names no revision',
    (rev) => {
      describe('When checkout switches to it', () => {
        it('Then it refuses as an unmatched pathspec and HEAD stays', async () => {
          // Arrange
          const { ctx } = await seed();
          const sut = checkout;

          // Act
          const result = await refusal(sut(ctx, { rev }));

          // Assert
          expect(result).toEqual(pathspecNoMatch(rev).data);
          expect(await readHead(ctx)).toMatchObject({ kind: 'symbolic' });
        });
      });
    },
  );

  describe.each([
    ['a plain switch', {}],
    ['a detached switch', { detach: true }],
    ['a branch-creating switch', { createBranch: { name: 'fresh' } }],
  ] as const)('Given a revision naming a tree and %s', (_label, extra) => {
    describe('When checkout switches to it', () => {
      it('Then it refuses to switch to a non-commit', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'HEAD^{tree}', ...extra }));

        // Assert
        expect(result).toEqual({ code: 'CHECKOUT_NON_COMMIT', revision: 'HEAD^{tree}' });
        expect(await readHead(ctx)).toMatchObject({ kind: 'symbolic' });
      });
    });
  });

  describe('Given a branch to create that exists and a revision naming a tree', () => {
    describe('When checkout switches to it', () => {
      it('Then the existing branch refuses first', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(
          sut(ctx, { rev: 'HEAD^{tree}', createBranch: { name: 'side' } }),
        );

        // Assert
        expect(result).toEqual({ code: 'BRANCH_EXISTS', name: 'refs/heads/side' });
      });
    });
  });

  describe('Given a branch to create that exists and a start point naming nothing', () => {
    describe('When checkout switches to it', () => {
      it('Then the start point refuses first, naming both', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'nope', createBranch: { name: 'side' } }));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_START_POINT_NOT_COMMIT',
          revision: 'nope',
          branch: 'side',
        });
      });
    });
  });

  describe('Given an annotated tag', () => {
    describe('When checkout switches to it', () => {
      it('Then HEAD detaches at the commit it tags', async () => {
        // Arrange
        const { ctx, base } = await seed();
        await tagCreate(ctx, { name: 'v1', target: 'main', message: 'v1' });
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'v1' });

        // Assert
        expect(result).toMatchObject({ id: base, detached: true });
        expect(await readHead(ctx)).toEqual({ kind: 'direct', id: base });
      });
    });
  });

  describe('Given an unborn HEAD', () => {
    describe.each(['HEAD', 'main'])('When checkout switches to %s', (rev) => {
      it('Then it refuses as an unmatched pathspec and HEAD stays', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, 'a');
        await add(ctx, ['f']);
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev }));

        // Assert
        expect(result).toEqual(pathspecNoMatch(rev).data);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given a name no revision answers and detach', () => {
    describe('When checkout switches to it', () => {
      it('Then it refuses a path argument to detach and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'nope', detach: true }));

        // Assert
        expect(result).toEqual({ code: 'CHECKOUT_DETACH_PATH_ARGUMENT', argument: 'nope' });
        expect(await readHeadFile(ctx)).toBe(HEAD_ON_MAIN);
      });
    });
  });

  describe('Given a name no revision answers, a branch to create and detach', () => {
    describe('When checkout switches to it', () => {
      it('Then it refuses the start point before the path argument to detach', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(
          sut(ctx, { rev: 'nope', detach: true, createBranch: { name: 'x' } }),
        );

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_START_POINT_NOT_COMMIT',
          revision: 'nope',
          branch: 'x',
        });
      });
    });
  });

  describe('Given a switch argument outside the work tree', () => {
    describe.each([
      { label: 'while creating a branch', opts: { rev: '../zz', createBranch: { name: 'x' } } },
      { label: 'while detaching', opts: { rev: '../zz', detach: true } },
    ])('When checkout switches to it $label', ({ opts }) => {
      it('Then it refuses the pathspec before the switch options and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, opts));

        // Assert
        expect(result).toEqual({ code: 'PATHSPEC_OUTSIDE_REPO', path: '../zz' });
        expect(await readHeadFile(ctx)).toBe(HEAD_ON_MAIN);
      });
    });
  });

  describe('Given a dirty tracked path and detach', () => {
    describe('When checkout switches to the path', () => {
      it('Then it refuses naming the path and leaves the file dirty', async () => {
        // Arrange
        const { ctx } = await seed();
        await write(ctx, 'f', 'dirty\n');
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'f', detach: true }));

        // Assert
        expect(result).toEqual({ code: 'CHECKOUT_DETACH_PATH_ARGUMENT', argument: 'f' });
        expect(await read(ctx, 'f')).toBe('dirty\n');
      });
    });
  });

  describe('Given a dirty tracked path', () => {
    describe('When checkout switches to the path', () => {
      it('Then it restores the path from the index and HEAD stays', async () => {
        // Arrange
        const { ctx, base } = await seed();
        await write(ctx, 'f', 'dirty\n');
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'f' });

        // Assert
        expect(result).toEqual({ branch: undefined, id: base, detached: false, changedPaths: 1 });
        expect(await read(ctx, 'f')).toBe('base\n');
        expect(await readHeadFile(ctx)).toBe(HEAD_ON_MAIN);
      });
    });
  });

  describe('Given two dirty tracked paths a glob matches', () => {
    describe('When checkout switches to the glob', () => {
      it('Then it restores both paths', async () => {
        // Arrange
        const { ctx } = await seed();
        await write(ctx, 'g.txt', 'g\n');
        await write(ctx, 'h.txt', 'h\n');
        await add(ctx, ['g.txt', 'h.txt']);
        await write(ctx, 'g.txt', 'dirty\n');
        await write(ctx, 'h.txt', 'dirty\n');
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: '*.txt' });

        // Assert
        expect(result).toMatchObject({ changedPaths: 2 });
        expect(await read(ctx, 'g.txt')).toBe('g\n');
        expect(await read(ctx, 'h.txt')).toBe('h\n');
      });
    });
  });

  describe('Given a dirty tracked path and force', () => {
    describe('When checkout switches to the path', () => {
      it('Then it restores the path as a plain restore does', async () => {
        // Arrange
        const { ctx, base } = await seed();
        await write(ctx, 'f', 'dirty\n');
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'f', force: true });

        // Assert
        expect(result).toEqual({ branch: undefined, id: base, detached: false, changedPaths: 1 });
        expect(await read(ctx, 'f')).toBe('base\n');
      });
    });
  });

  describe('Given an unmerged tracked path', () => {
    describe('When checkout switches to the path', () => {
      it('Then it refuses the unmerged path and writes nothing', async () => {
        // Arrange
        const { ctx } = await seed();
        await unmerge(ctx, 'f');
        await write(ctx, 'f', 'dirty\n');
        const before = await readIndex(ctx);
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'f' }));

        // Assert
        expect(result).toEqual({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['f'] });
        expect((await readIndex(ctx)).entries).toEqual(before.entries);
        expect(await read(ctx, 'f')).toBe('dirty\n');
      });
    });
  });

  describe('Given an unborn HEAD and a staged path made dirty', () => {
    describe('When checkout switches to the path', () => {
      it('Then it restores the path from the index and reports the null id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await write(ctx, 'g', 'staged\n');
        await add(ctx, ['g']);
        await write(ctx, 'g', 'dirty\n');
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'g' });

        // Assert
        expect(result).toEqual({
          branch: undefined,
          id: zeroOid(ctx.hashConfig),
          detached: false,
          changedPaths: 1,
        });
        expect(await read(ctx, 'g')).toBe('staged\n');
        expect(await readHeadFile(ctx)).toBe(HEAD_ON_MAIN);
      });
    });
  });

  describe('Given a tracked path and a branch to create', () => {
    describe('When checkout switches to the path', () => {
      it('Then the start point refuses, naming both', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'f', createBranch: { name: 'x' } }));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_START_POINT_NOT_COMMIT',
          revision: 'f',
          branch: 'x',
        });
      });
    });
  });
});
