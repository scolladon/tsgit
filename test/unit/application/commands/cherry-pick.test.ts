import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { cherryPickRun } from '../../../../src/application/commands/cherry-pick.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { writeMergeHead } from '../../../../src/application/commands/internal/merge-state.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  AuthorIdentity,
  CommitData,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const COMMITTER: AuthorIdentity = {
  name: 'Picker',
  email: 'pick@x',
  timestamp: 5,
  timezoneOffset: '+0000',
};
const FEAT_AUTHOR: AuthorIdentity = {
  name: 'Feat',
  email: 'feat@y',
  timestamp: 100,
  timezoneOffset: '+0200',
};
const MAIN_AUTHOR: AuthorIdentity = {
  name: 'Main',
  email: 'main@z',
  timestamp: 1,
  timezoneOffset: '+0000',
};

const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

const setUser = (ctx: Context): Promise<void> =>
  ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Picker\n\temail = pick@x\n');

const readCommit = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw new Error('not a commit');
  return obj.data;
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as TsgitError).data.code;
  }
};

/** main: base.txt; feature branch off base adds feat.txt. Returns ctx + feature tip. */
const seedFeature = async (
  baseBody = 'a\nb\n',
  featBody = 'feat\n',
): Promise<{ ctx: Context; feature: ObjectId; base: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'base.txt'), baseBody);
  await add(ctx, ['base.txt']);
  const base = await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { target: 'feature' });
  await ctx.fs.writeUtf8(work(ctx, 'feat.txt'), featBody);
  await add(ctx, ['feat.txt']);
  const feature = await commit(ctx, { message: 'add feat\n\nbody line', author: FEAT_AUTHOR });
  await checkout(ctx, { target: 'main' });
  return { ctx, feature: feature.id, base: base.id };
};

describe('cherryPickRun', () => {
  describe('Given a clean single pick', () => {
    describe('When run', () => {
      it('Then commits with preserved author, current committer, single parent, and reflog', async () => {
        // Arrange
        const { ctx, feature, base } = await seedFeature();

        // Act
        const sut = await cherryPickRun(ctx, { commits: ['feature'] });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind !== 'picked') return;
        const created = sut.commits[0]?.created as ObjectId;
        expect(sut.commits[0]?.source).toBe(feature);
        const data = await readCommit(ctx, created);
        expect(data.author).toEqual(FEAT_AUTHOR); // preserved
        expect(data.committer.name).toBe(COMMITTER.name); // current identity
        expect(data.parents).toEqual([base]); // single parent = old HEAD
        expect(data.message).toBe('add feat\n\nbody line\n'); // preserved verbatim (source's stripspace'd form)
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(created);
        expect(await ctx.fs.readUtf8(work(ctx, 'feat.txt'))).toBe('feat\n');
      });
    });
  });

  describe('Given two clean picks given as separate arguments', () => {
    describe('When run', () => {
      it('Then both are applied in order onto HEAD', async () => {
        // Arrange — feature has feat.txt; add a second feature commit
        const { ctx, feature } = await seedFeature();
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'feat2.txt'), 'feat2\n');
        await add(ctx, ['feat2.txt']);
        const second = await commit(ctx, { message: 'add feat2', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature, second.id] });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind !== 'picked') return;
        expect(sut.commits).toHaveLength(2);
        expect(await ctx.fs.readUtf8(work(ctx, 'feat.txt'))).toBe('feat\n');
        expect(await ctx.fs.readUtf8(work(ctx, 'feat2.txt'))).toBe('feat2\n');
      });
    });
  });

  describe('Given a parentless (root) commit to pick', () => {
    describe('When run', () => {
      it('Then applies it against an empty base', async () => {
        // Arrange — a root commit (no parents) adding r.txt
        const { ctx } = await seedFeature();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('r\n'),
        });
        const rTree = await writeTree(ctx, [{ name: 'r.txt', id: blob, mode: FILE_MODE.REGULAR }]);
        const root = await createCommit(ctx, {
          tree: rTree,
          parents: [],
          author: FEAT_AUTHOR,
          committer: FEAT_AUTHOR,
          message: 'root',
          extraHeaders: [],
        });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [root] });

        // Assert
        expect(sut.kind).toBe('picked');
        expect(await ctx.fs.readUtf8(work(ctx, 'r.txt'))).toBe('r\n');
      });
    });
  });

  describe('Given a pick that conflicts', () => {
    describe('When run', () => {
      it('Then stops with CHERRY_PICK_HEAD, MERGE_MSG, unmerged index, and markers', async () => {
        // Arrange — feature and main change the same line differently
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nl2\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nFEAT\n');
        await add(ctx, ['f.txt']);
        const feature = await commit(ctx, { message: 'feat change', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nMAIN\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'main change', author: MAIN_AUTHOR });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature.id] });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') return;
        expect(sut.commit).toBe(feature.id);
        expect(sut.conflicts.map((c) => c.path)).toContain('f.txt');
        expect(sut.remaining).toBe(0);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(
          `${feature.id}\n`,
        );
        const mergeMsg = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(mergeMsg).toContain('feat change');
        expect(mergeMsg).toContain('# Conflicts:');
        const index = await readIndex(ctx);
        expect(index.entries.some((e) => e.path === 'f.txt' && e.flags.stage !== 0)).toBe(true);
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toContain('<<<<<<<');
      });
    });
  });

  describe('Given a pick whose change is already applied', () => {
    describe('When run without --allow-empty', () => {
      it('Then stops as empty', async () => {
        // Arrange — pick feature once (clean), then pick it again (redundant)
        const { ctx, feature } = await seedFeature();
        await cherryPickRun(ctx, { commits: [feature] });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature] });

        // Assert
        expect(sut.kind).toBe('empty');
        if (sut.kind === 'empty') expect(sut.commit).toBe(feature);
      });
    });
  });

  describe('Given an untracked working file the pick would overwrite', () => {
    describe('When run', () => {
      it('Then refuses with WORKING_TREE_DIRTY', async () => {
        // Arrange — feat.txt exists untracked on main before the pick adds it
        const { ctx } = await seedFeature();
        await ctx.fs.writeUtf8(work(ctx, 'feat.txt'), 'untracked\n');

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given no configured committer identity', () => {
    describe('When a clean pick reaches the commit step', () => {
      it('Then refuses with AUTHOR_UNCONFIGURED', async () => {
        // Arrange — repo built with explicit authors but no [user] config
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'a\n');
        await add(ctx, ['base.txt']);
        await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'feat.txt'), 'feat\n');
        await add(ctx, ['feat.txt']);
        const feature = await commit(ctx, { message: 'add feat', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: [feature.id] }));

        // Assert
        expect(code).toBe('AUTHOR_UNCONFIGURED');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When run', () => {
      it('Then refuses with UNSUPPORTED_OPERATION', async () => {
        // Arrange
        const { ctx, base } = await seedFeature();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${base}\n`);

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('UNSUPPORTED_OPERATION');
      });
    });
  });

  describe('Given an unborn branch', () => {
    describe('When run', () => {
      it('Then refuses with NO_INITIAL_COMMIT', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['a'.repeat(40)] }));

        // Assert
        expect(code).toBe('NO_INITIAL_COMMIT');
      });
    });
  });

  describe('Given a dirty working tree', () => {
    describe('When run', () => {
      it('Then refuses with WORKING_TREE_DIRTY', async () => {
        // Arrange
        const { ctx } = await seedFeature();
        await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'dirty\n');

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given another operation already in progress', () => {
    describe('When run', () => {
      it('Then refuses with OPERATION_IN_PROGRESS', async () => {
        // Arrange — a stray MERGE_HEAD
        const { ctx, base } = await seedFeature();
        await writeMergeHead(ctx, base);

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('OPERATION_IN_PROGRESS');
      });
    });
  });
});
