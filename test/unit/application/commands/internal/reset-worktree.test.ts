import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../../src/application/commands/branch.js';
import { checkout } from '../../../../../src/application/commands/checkout.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  attemptCheckoutWorktreeToCommit,
  checkoutWorktreeToCommit,
  hardResetWorktreeToCommit,
  mergeResetWorktreeToCommit,
  protectedResetWorktreeToCommit,
} from '../../../../../src/application/commands/internal/reset-worktree.js';
import { mergeRun } from '../../../../../src/application/commands/merge.js';
import { rm } from '../../../../../src/application/commands/rm.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import { resolveRef } from '../../../../../src/application/primitives/resolve-ref.js';
import { updateCoreConfig } from '../../../../../src/application/primitives/update-config.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const sut = hardResetWorktreeToCommit;

// Cone file: root files in, subdirs out, `/src/` back in — so `src/*` is
// in-pattern and `docs/*` is excluded. Sparse is flipped on AFTER the commit so
// both index entries start normal and the reset itself must apply the matcher.
const enableSparseSrcOnly = async (ctx: ReturnType<typeof createMemoryContext>): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '/*\n!/*/\n/src/\n');
  await updateCoreConfig(ctx, { sparseCheckout: 'true', sparseCheckoutCone: 'true' });
};

const seedSrcAndDocs = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');
  await add(ctx, ['src/a.txt', 'docs/b.txt']);
  const c1 = await commit(ctx, { message: 'first', author });
  return { ctx, c1: c1.id };
};

describe('hardResetWorktreeToCommit', () => {
  describe('Given a dirty working tree over a committed file', () => {
    describe('When hard-reset to the commit runs', () => {
      it('Then the tracked file is restored on disk and re-indexed', async () => {
        // Arrange — commit `a`, then dirty the working copy.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const first = await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty');

        // Act
        await sut(ctx, first.id);

        // Assert — content reverted and the entry is back in the index.
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('a');
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'a.txt')?.id).toBeDefined();
      });
    });
  });

  describe('Given a sparse repo excluding docs/', () => {
    describe('When hard-reset to the commit runs', () => {
      it('Then the excluded path is dropped from disk and flagged skip-worktree', async () => {
        // Arrange — `src/a.txt` in-pattern, `docs/b.txt` excluded; both on disk.
        const { ctx, c1 } = await seedSrcAndDocs();
        await enableSparseSrcOnly(ctx);

        // Act
        await sut(ctx, c1);

        // Assert — the matcher must reach materializeTree: excluded `docs/b.txt`
        // is removed from disk and marked skip-worktree while `src/a.txt` stays.
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'src/a.txt')?.flags.skipWorktree).toBe(false);
        expect(index.entries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a commit id that resolves to a blob', () => {
    describe('When hard-reset runs', () => {
      it('Then it throws UNEXPECTED_OBJECT_TYPE expecting a commit', async () => {
        // Arrange — a real blob OID that is not a commit.
        const ctx = createMemoryContext();
        await init(ctx);
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('not a commit'),
          id: '' as ObjectId,
        });

        // Act
        let caught: unknown;
        try {
          await sut(ctx, blobId);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; expected?: string; actual?: string } })
          ?.data;
        expect(data?.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(data?.expected).toBe('commit');
        expect(data?.actual).toBe('blob');
      });
    });
  });
});

type MemoryContext = ReturnType<typeof createMemoryContext>;

const write = (ctx: MemoryContext, rel: string, content: string) =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);

const commitFiles = async (ctx: MemoryContext, files: Readonly<Record<string, string>>) => {
  for (const [rel, content] of Object.entries(files)) await write(ctx, rel, content);
  await add(ctx, Object.keys(files));
  return (await commit(ctx, { message: 'c', author })).id;
};

const catchData = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    return (err as { data?: Record<string, unknown> }).data;
  }
  return undefined;
};

const seedConflictedMerge = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await commitFiles(ctx, { 'file.txt': 'base\n' });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFiles(ctx, { 'file.txt': 'FEATURE\n' });
  await checkout(ctx, { rev: 'main' });
  const mainTip = await commitFiles(ctx, { 'file.txt': 'MAIN\n' });
  await mergeRun(ctx, { rev: 'feature', author });
  return { ctx, mainTip };
};

const replaceFileWithDirectory = async (ctx: MemoryContext, rel: string, child: string) => {
  await ctx.fs.rmRecursive(`${ctx.layout.workDir}/${rel}`);
  await write(ctx, `${rel}/${child}`, 'untracked\n');
};

describe('mergeResetWorktreeToCommit', () => {
  describe('Given a directory occupying a path the index and the target agree on', () => {
    describe('When the merge reset runs', () => {
      it('Then the occupant stays', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { f: 'v1\n' });
        await replaceFileWithDirectory(ctx, 'f', 'u');

        // Act
        await mergeResetWorktreeToCommit(ctx, c1);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f/u`)).toBe('untracked\n');
      });
    });
  });

  describe('Given a local modification on a path the index and the target agree on', () => {
    describe('When the merge reset runs', () => {
      it('Then the modification stays', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { f: 'v1\n' });
        await write(ctx, 'f', 'modified\n');

        // Act
        await mergeResetWorktreeToCommit(ctx, c1);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('modified\n');
      });
    });
  });

  describe('Given an untracked file where the target adds a path', () => {
    describe('When the merge reset runs', () => {
      it('Then it refuses WORKING_TREE_DIRTY and leaves the work tree and index', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { a: 'v1\n', b: 'v1\n' });
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/b`);
        await add(ctx, ['b']);
        await commit(ctx, { message: 'drop b', author });
        await write(ctx, 'b', 'untracked\n');
        const indexBefore = await readIndex(ctx);

        // Act
        const data = await catchData(() => mergeResetWorktreeToCommit(ctx, c1));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['b'] });
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/b`)).toBe('untracked\n');
        expect(await readIndex(ctx)).toEqual(indexBefore);
      });
    });
  });

  describe('Given a local change on a then an untracked file on z, both blocking', () => {
    describe('When the merge reset runs', () => {
      it('Then only the first path is named, in its class', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { a: 'v1\n', z: 'v1\n' });
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/z`);
        await add(ctx, ['z']);
        await commitFiles(ctx, { a: 'v2\n' });
        await write(ctx, 'a', 'modified\n');
        await write(ctx, 'z', 'untracked\n');

        // Act
        const data = await catchData(() => mergeResetWorktreeToCommit(ctx, c1));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: ['a'], untracked: [] });
      });
    });
  });

  describe('Given two local changes both blocking', () => {
    describe('When the merge reset runs', () => {
      it('Then only the first path is named', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { a: 'v1\n', b: 'v1\n' });
        await commitFiles(ctx, { a: 'v2\n', b: 'v2\n' });
        await write(ctx, 'a', 'modified\n');
        await write(ctx, 'b', 'modified\n');

        // Act
        const data = await catchData(() => mergeResetWorktreeToCommit(ctx, c1));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: ['a'], untracked: [] });
      });
    });
  });

  describe('Given two untracked files where the target adds paths', () => {
    describe('When the merge reset runs', () => {
      it('Then only the first path is named', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { a: 'v1\n', b: 'v1\n' });
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/a`);
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/b`);
        await add(ctx, ['a', 'b']);
        await commit(ctx, { message: 'drop both', author });
        await write(ctx, 'a', 'untracked\n');
        await write(ctx, 'b', 'untracked\n');

        // Act
        const data = await catchData(() => mergeResetWorktreeToCommit(ctx, c1));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['a'] });
      });
    });
  });

  describe('Given only a local change blocks', () => {
    describe('When the merge reset runs', () => {
      it('Then it names that path as a local change', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { x: 'v1\n' });
        await commitFiles(ctx, { x: 'v2\n' });
        await write(ctx, 'x', 'modified\n');

        // Act
        const data = await catchData(() => mergeResetWorktreeToCommit(ctx, c1));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: ['x'], untracked: [] });
      });
    });
  });

  describe('Given an untracked file on a then a local change on z, both blocking', () => {
    describe('When the merge reset runs', () => {
      it('Then only the first path is named, in its class', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const c1 = await commitFiles(ctx, { a: 'v1\n', z: 'v1\n' });
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/a`);
        await add(ctx, ['a']);
        await commitFiles(ctx, { z: 'v2\n' });
        await write(ctx, 'a', 'untracked\n');
        await write(ctx, 'z', 'modified\n');

        // Act
        const data = await catchData(() => mergeResetWorktreeToCommit(ctx, c1));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['a'] });
      });
    });
  });

  describe('Given an unmerged path holding a directory with an untracked file', () => {
    describe('When the merge reset runs', () => {
      it('Then it refuses naming the path as untracked', async () => {
        // Arrange
        const { ctx, mainTip } = await seedConflictedMerge();
        await replaceFileWithDirectory(ctx, 'file.txt', 'u');

        // Act
        const data = await catchData(() => mergeResetWorktreeToCommit(ctx, mainTip));

        // Assert
        expect(data).toEqual({
          code: 'WORKING_TREE_DIRTY',
          localChanges: [],
          untracked: ['file.txt'],
        });
      });
    });
  });

  describe('Given an unmerged path holding a directory with only ignored files', () => {
    describe('When the merge reset runs', () => {
      it('Then the path is reset to the target', async () => {
        // Arrange
        const { ctx, mainTip } = await seedConflictedMerge();
        await write(ctx, '.gitignore', 'ign\n');
        await replaceFileWithDirectory(ctx, 'file.txt', 'ign');

        // Act
        await mergeResetWorktreeToCommit(ctx, mainTip);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`)).toBe('MAIN\n');
      });
    });
  });
});

const dropFromHead = async (ctx: MemoryContext, rel: string) => {
  await ctx.fs.rmRecursive(`${ctx.layout.workDir}/${rel.split('/')[0]}`);
  await add(ctx, [rel]);
  await commit(ctx, { message: `drop ${rel}`, author });
};

/** The target holds `files`; HEAD and the index have since dropped `dropped`. */
const seedDropped = async (
  files: Readonly<Record<string, string>>,
  dropped: ReadonlyArray<string>,
) => {
  const ctx = createMemoryContext();
  await init(ctx);
  const target = await commitFiles(ctx, { keep: 'keep\n', ...files });
  for (const rel of dropped) await dropFromHead(ctx, rel);
  return { ctx, target };
};

type Occupy = (ctx: MemoryContext) => Promise<void>;

const asFile: Occupy = (ctx) => write(ctx, 'f', 'untracked\n');
const asDanglingLink: Occupy = (ctx) => ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/f`);
const asDirectory: Occupy = (ctx) => write(ctx, 'f/u', 'untracked\n');

describe('protectedResetWorktreeToCommit', () => {
  describe.each([
    ['an untracked file', asFile],
    ['a dangling symlink', asDanglingLink],
    ['a directory holding an untracked file', asDirectory],
  ] as const)('Given %s where the target adds f', (_shape, occupy) => {
    describe('When the protected reset runs', () => {
      it('Then it refuses naming f as untracked and leaves the occupant', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n' }, ['f']);
        await occupy(ctx);
        const indexBefore = await readIndex(ctx);

        // Act
        const data = await catchData(() => protectedResetWorktreeToCommit(ctx, target));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['f'] });
        expect(await readIndex(ctx)).toEqual(indexBefore);
      });
    });
  });

  describe.each([
    ['an untracked file', (ctx: MemoryContext) => write(ctx, 'd', 'untracked\n')],
    [
      'a dangling symlink',
      (ctx: MemoryContext) => ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/d`),
    ],
  ] as const)('Given %s where the target adds d/x', (_shape, occupy) => {
    describe('When the protected reset runs', () => {
      it('Then it refuses naming d as untracked', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ 'd/x': 'v1\n' }, ['d/x']);
        await occupy(ctx);

        // Act
        const data = await catchData(() => protectedResetWorktreeToCommit(ctx, target));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['d'] });
      });
    });
  });

  describe('Given a directory holding only an ignored file where the target adds f', () => {
    describe('When the protected reset runs', () => {
      it('Then the ignored occupant is overwritten', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n' }, ['f']);
        await write(ctx, '.gitignore', 'f/u\n');
        await asDirectory(ctx);

        // Act
        await protectedResetWorktreeToCommit(ctx, target);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('v1\n');
      });
    });
  });

  describe('Given an ignored file where the target adds f', () => {
    describe('When the protected reset runs', () => {
      it('Then the ignored occupant is overwritten', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n' }, ['f']);
        await write(ctx, '.gitignore', 'f\n');
        await asFile(ctx);

        // Act
        await protectedResetWorktreeToCommit(ctx, target);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('v1\n');
      });
    });
  });

  describe('Given a directory holding an untracked file where the target deletes f', () => {
    describe('When the protected reset runs', () => {
      it('Then it refuses naming f as untracked', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const target = await commitFiles(ctx, { keep: 'keep\n' });
        await commitFiles(ctx, { f: 'v1\n' });
        await replaceFileWithDirectory(ctx, 'f', 'u');

        // Act
        const data = await catchData(() => protectedResetWorktreeToCommit(ctx, target));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['f'] });
      });
    });
  });

  describe('Given a locally modified tracked file', () => {
    describe('When the protected reset runs', () => {
      it('Then the file is rewritten to the target', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const target = await commitFiles(ctx, { f: 'v1\n' });
        await write(ctx, 'f', 'modified\n');

        // Act
        await protectedResetWorktreeToCommit(ctx, target);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('v1\n');
      });
    });
  });

  describe('Given an unmerged path holding a directory with an untracked file', () => {
    describe('When the protected reset runs', () => {
      it('Then it refuses naming the path as untracked', async () => {
        // Arrange
        const { ctx, mainTip } = await seedConflictedMerge();
        await replaceFileWithDirectory(ctx, 'file.txt', 'u');

        // Act
        const data = await catchData(() => protectedResetWorktreeToCommit(ctx, mainTip));

        // Assert
        expect(data).toEqual({
          code: 'WORKING_TREE_DIRTY',
          localChanges: [],
          untracked: ['file.txt'],
        });
      });
    });
  });

  describe('Given an unmerged path holding a file', () => {
    describe('When the protected reset runs', () => {
      it('Then the path is rewritten to the target', async () => {
        // Arrange
        const { ctx, mainTip } = await seedConflictedMerge();

        // Act
        await protectedResetWorktreeToCommit(ctx, mainTip);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`)).toBe('MAIN\n');
      });
    });
  });

  describe('Given two untracked occupants where the target adds f and g', () => {
    describe('When the protected reset runs', () => {
      it('Then every offending path is listed', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n', g: 'v1\n' }, ['f', 'g']);
        await write(ctx, 'f', 'untracked\n');
        await write(ctx, 'g', 'untracked\n');

        // Act
        const data = await catchData(() => protectedResetWorktreeToCommit(ctx, target));

        // Assert
        expect(data).toEqual({
          code: 'WORKING_TREE_DIRTY',
          localChanges: [],
          untracked: ['f', 'g'],
        });
      });
    });
  });
});

describe('attemptCheckoutWorktreeToCommit', () => {
  describe('Given an untracked file where the target adds f', () => {
    describe('When the checkout is attempted', () => {
      it('Then it returns the refusal naming f and writes nothing', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n' }, ['f']);
        await asFile(ctx);
        const indexBefore = await readIndex(ctx);
        const headBefore = await resolveRef(ctx, 'HEAD' as RefName);
        const sut = attemptCheckoutWorktreeToCommit;

        // Act
        const result = await sut(ctx, target);

        // Assert
        expect(result).toEqual({ kind: 'refused', localChanges: [], untracked: ['f'] });
        expect(await readIndex(ctx)).toEqual(indexBefore);
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(headBefore);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('untracked\n');
      });
    });
  });

  describe('Given no occupant where the target adds f', () => {
    describe('When the checkout is attempted', () => {
      it('Then it reports checked-out and f is written', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n' }, ['f']);
        const sut = attemptCheckoutWorktreeToCommit;

        // Act
        const result = await sut(ctx, target);

        // Assert
        expect(result).toEqual({ kind: 'checked-out' });
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('v1\n');
      });
    });
  });
});

describe('checkoutWorktreeToCommit', () => {
  describe('Given an untracked file where the target adds f', () => {
    describe('When the checkout runs', () => {
      it('Then it refuses naming f and leaves HEAD, the index and the work tree untouched', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n' }, ['f']);
        await asFile(ctx);
        const indexBefore = await readIndex(ctx);
        const headBefore = await resolveRef(ctx, 'HEAD' as RefName);

        // Act
        const data = await catchData(() => checkoutWorktreeToCommit(ctx, target));

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['f'] });
        expect(await readIndex(ctx)).toEqual(indexBefore);
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(headBefore);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('untracked\n');
      });
    });
  });

  describe('Given an ignored file where the target adds f', () => {
    describe('When the checkout runs', () => {
      it('Then the ignored occupant is overwritten', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ f: 'v1\n' }, ['f']);
        await write(ctx, '.gitignore', 'f\n');
        await asFile(ctx);

        // Act
        await checkoutWorktreeToCommit(ctx, target);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('v1\n');
      });
    });
  });

  describe('Given an untracked file at a path HEAD and the target agree on', () => {
    describe('When the checkout runs', () => {
      it('Then the file stays and the index keeps no entry for it', async () => {
        // Arrange
        const { ctx, target } = await seedDropped({ g: 'g\n', h: 'h\n' }, ['h']);
        await rm(ctx, ['g'], { cached: true });
        await write(ctx, 'g', 'untracked\n');

        // Act
        await checkoutWorktreeToCommit(ctx, target);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/g`)).toBe('untracked\n');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/h`)).toBe('h\n');
        expect((await readIndex(ctx)).entries.map((e) => e.path)).not.toContain('g');
      });
    });
  });
});
