import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  buildConflictIndexEntries,
  MAX_MERGE_TREE_DEPTH,
  materialiseConflictBytes,
  merge,
  parentDir,
  removeWorkingTreeFile,
  resolveMergeAuthor,
  resolveMergeCommitter,
  resolveTarget,
  writeNestedTree,
  writeOutcomeToTree,
} from '../../../../src/application/commands/merge.js';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { MergeConflict, MergeOutcome } from '../../../../src/domain/merge/index.js';
import type {
  AuthorIdentity,
  FilePath,
  ObjectId,
  RefName,
  Tag,
  Tree,
} from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('merge', () => {
  describe('Given target equals HEAD', () => {
    describe('When merge', () => {
      it('Then result.kind=up-to-date', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'first', author });

        // Act
        const sut = await merge(ctx, { target: c.id });

        // Assert
        expect(sut.kind).toBe('up-to-date');
      });
    });
  });

  describe('Given an ancestor target', () => {
    describe('When merge', () => {
      it('Then result.kind=fast-forward and branch advances', async () => {
        // Arrange — create main with 1 commit, branch feature, advance feature, switch to main, merge feature.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const c2 = await commit(ctx, { message: 'second', author });
        await checkout(ctx, { target: 'main' });

        // Act
        const sut = await merge(ctx, { target: 'feature' });

        // Assert
        expect(sut.kind).toBe('fast-forward');
        if (sut.kind === 'fast-forward') {
          expect(sut.id).toBe(c2.id);
        }
      });
    });
  });

  describe('Given an ancestor target + noFastForward=true', () => {
    describe('When merge', () => {
      it('Then a real merge commit is produced', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        await checkout(ctx, { target: 'main' });

        // Act
        const sut = await merge(ctx, {
          target: 'feature',
          noFastForward: true,
          message: 'merge',
          author,
        });

        // Assert
        expect(sut.kind).toBe('merge');
        if (sut.kind === 'merge') {
          expect(sut.parents).toHaveLength(2);
        }
      });
    });
  });

  describe('Given diverged histories with non-conflicting paths', () => {
    describe('When merge', () => {
      it('Then commit tree contains both sides files (no add required)', async () => {
        // Arrange — base has a.txt. Feature adds b.txt. Main adds c.txt.
        // After merging feature into main, the merge commit's tree must
        // contain BOTH b.txt AND c.txt (clean three-way merge result),
        // NOT just main's tree.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        // Note: checkout to main reverts the working tree, so b.txt is gone here.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const sut = await merge(ctx, { target: 'feature', author });

        // Assert — the merge commit's tree contains a.txt + b.txt + c.txt.
        expect(sut.kind).toBe('merge');
        if (sut.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, sut.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const mergedTree = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const names = mergedTree.entries.map((e) => e.name).sort();
        expect(names).toEqual(['a.txt', 'b.txt', 'c.txt']);
      });
    });
  });

  describe('Given a non-overlapping content change to the same file on each side', () => {
    describe('When merge', () => {
      it('Then merged content combines both edits', async () => {
        // Arrange — base file has 3 lines. Each side modifies a different line.
        // mergeContent should produce a clean merge with both edits.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'line1\nline2\nline3\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'line1\nline2\nFEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\nline2\nline3\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const sut = await merge(ctx, { target: 'feature', author });

        // Assert — merged content combines both line edits.
        expect(sut.kind).toBe('merge');
        if (sut.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, sut.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const mergedTree = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const fileEntry = mergedTree.entries.find((e) => e.name === 'file.txt');
        expect(fileEntry).toBeDefined();
        const blob = await readBlob(ctx, fileEntry?.id as ObjectId);
        const content = new TextDecoder().decode(blob.content);
        expect(content).toBe('MAIN\nline2\nFEATURE\n');
      });
    });
  });

  describe('Given conflicting modifications to the same file', () => {
    describe('When merge runs', () => {
      it('Then returns kind=conflict with the conflicting path and HEAD does NOT advance', async () => {
        // Arrange — same file, divergent content on the same lines.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'shared\n');
        await add(ctx, ['file.txt']);
        const baseCommit = await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE-CHANGE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN-CHANGE\n');
        await add(ctx, ['file.txt']);
        const mainTip = await commit(ctx, { message: 'on-main', author });

        // Act
        const sut = await merge(ctx, { target: 'feature', author });

        // Assert — kind='conflict' with path + type + heads.
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') throw new Error('expected conflict kind');
        expect(sut.conflicts).toHaveLength(1);
        expect(sut.conflicts[0]?.path).toBe('file.txt');
        expect(sut.conflicts[0]?.type).toBe('content');
        expect(sut.origHead).toBe(mainTip.id);
        expect(sut.mergeHead).not.toBe(baseCommit.id); // points at the feature tip

        // Also confirm HEAD did NOT advance (the conflicting merge must not commit).
        const main = await resolveRef(ctx, 'refs/heads/main' as RefName);
        const mainHeadCommit = await readObject(ctx, main);
        if (mainHeadCommit.type !== 'commit') throw new Error('not a commit');
        expect(mainHeadCommit.data.message).toBe('on-main\n'); // still pre-merge tip
        expect(mainHeadCommit.data.parents).toHaveLength(1); // not a merge commit
      });
    });
  });

  describe('Given a merge where one side deletes a file the other unchanged', () => {
    describe('When merge', () => {
      it('Then the merged tree omits the deleted file', async () => {
        // Arrange — base has a.txt + b.txt. Feature deletes a.txt. Main is
        // unchanged. The merge result should have b.txt only — exercising
        // the resolved-deleted branch of collectLeaves.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['a.txt', 'b.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        // Remove a.txt by re-staging an empty list — use rm command surface.
        const { rm } = await import('../../../../src/application/commands/rm.js');
        await rm(ctx, ['a.txt']);
        await commit(ctx, { message: 'feature-delete', author });
        await checkout(ctx, { target: 'main' });
        // Advance main without touching a.txt or b.txt so they're force-unchanged.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const sut = await merge(ctx, { target: 'feature', author });

        // Assert — merged tree has b.txt (unchanged) + c.txt (added on main),
        // but a.txt is GONE (resolved-deleted on feature's side).
        expect(sut.kind).toBe('merge');
        if (sut.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, sut.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const mergedTree = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const names = mergedTree.entries.map((e) => e.name).sort();
        expect(names).toEqual(['b.txt', 'c.txt']);
      });
    });
  });

  describe('Given a clean merge with multiple top-level subdirectories on each side', () => {
    describe('When merge', () => {
      it('Then writeNestedTree resolves all subdirs in parallel and produces correct nested trees', async () => {
        // Arrange — feature and main each add files under DIFFERENT top-level
        // directories. The merged root must have >= 2 top-level subdirs so
        // the root-level Promise.all over `subdirs` is genuinely exercised
        // with multi-element parallelism (a mutation swapping Promise.all
        // for a serial for-await loop would survive single-subdir test).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/base.ts`, 'base');
        await add(ctx, ['src/base.ts']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/feature/a.ts`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/lib/x.ts`, 'x');
        await add(ctx, ['src/feature/a.ts', 'lib/x.ts']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/main/b.ts`, 'b');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/pkg/y.ts`, 'y');
        await add(ctx, ['src/main/b.ts', 'pkg/y.ts']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const sut = await merge(ctx, { target: 'feature', author });

        // Assert — merged root has THREE top-level subdirs: src, lib, pkg.
        expect(sut.kind).toBe('merge');
        if (sut.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, sut.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const root = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const rootNames = root.entries.map((e) => e.name).sort();
        expect(rootNames).toEqual(['lib', 'pkg', 'src']);
        // And src/ has feature/ + main/ + base.ts — nested depth-2 parallelism.
        const srcEntry = root.entries.find((e) => e.name === 'src');
        if (srcEntry === undefined) throw new Error('expected src entry');
        const src = (await readObject(ctx, srcEntry.id)) as Tree;
        const srcNames = src.entries.map((e) => e.name).sort();
        expect(srcNames).toEqual(['base.ts', 'feature', 'main']);
      });
    });
  });

  describe('Given unrelated histories sharing a path with divergent content', () => {
    describe('When merge', () => {
      it('Then add-add conflict surfaces (proves baseFlat is undefined, not silently substituted)', async () => {
        // Arrange — both unrelated roots write `shared.txt` with DIFFERENT
        // content. With `baseFlat = undefined` (the correct behaviour for
        // unrelated histories), `mergeTrees` falls into `resolveAddAdd`
        // which fires `add-add` conflict for divergent entries — exactly
        // what we want to assert.
        //
        // If a mutation substituted ourTree (or theirTree) as a stand-in for
        // baseFlat, the path would match the substituted "base" on one side,
        // resolve via the `oneSideAbsent / unchanged` path, and produce a
        // silent clean merge. So asserting the conflict throw discriminates
        // the `undefined` branch from any "silent substitution" mutation.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/shared.txt`, 'main-version\n');
        await add(ctx, ['shared.txt']);
        await commit(ctx, { message: 'main-root', author });

        // Build an unrelated commit chain with a divergent shared.txt.
        const { writeObject } = await import(
          '../../../../src/application/primitives/write-object.js'
        );
        const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
        const { createCommit } = await import(
          '../../../../src/application/primitives/create-commit.js'
        );
        const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
        const { FILE_MODE } = await import('../../../../src/domain/objects/file-mode.js');
        const otherBlobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('unrelated-version\n'),
          id: '' as ObjectId,
        });
        const otherTreeId = await writeTree(ctx, [
          { name: 'shared.txt' as never, id: otherBlobId, mode: FILE_MODE.REGULAR },
        ]);
        const otherCommitId = await createCommit(ctx, {
          tree: otherTreeId,
          parents: [],
          author,
          committer: author,
          message: 'unrelated-root',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/unrelated' as RefName, otherCommitId, {
          reflogMessage: 'branch: Created from seed',
        });

        // Act
        const sut = await merge(ctx, { target: 'unrelated', author });

        // Assert — kind='conflict' with add-add for shared.txt.
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') throw new Error('expected conflict kind');
        expect(sut.conflicts).toHaveLength(1);
        expect(sut.conflicts[0]?.path).toBe('shared.txt');
        expect(sut.conflicts[0]?.type).toBe('add-add');
      });
    });
  });

  describe('Given diverged histories + fastForwardOnly=true', () => {
    describe('When merge', () => {
      it('Then throws NON_FAST_FORWARD', async () => {
        // Arrange — diverge: both branches advance from a common base.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature', fastForwardOnly: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NON_FAST_FORWARD');
      });
    });
  });
});

describe('merge.4b conflict persistence', () => {
  const setupConflictingMerge = async (
    ctx: ReturnType<typeof createMemoryContext>,
  ): Promise<{ readonly preMergeMain: ObjectId; readonly featureTip: ObjectId }> => {
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'base', author });
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
    await add(ctx, ['file.txt']);
    const featureTip = await commit(ctx, { message: 'on-feature', author });
    await checkout(ctx, { target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
    await add(ctx, ['file.txt']);
    const mainTip = await commit(ctx, { message: 'on-main', author });
    return { preMergeMain: mainTip.id, featureTip: featureTip.id };
  };

  describe('Given a content conflict', () => {
    describe('When merge runs', () => {
      it('Then the working-tree file contains the <<<<<<< / ======= / >>>>>>> marker block', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);

        // Act
        await merge(ctx, { target: 'feature', author });

        // Assert
        const sut = await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`);
        expect(sut).toContain('<<<<<<<');
        expect(sut).toContain('=======');
        expect(sut).toContain('>>>>>>>');
        expect(sut).toContain('MAIN');
        expect(sut).toContain('FEATURE');
      });
      it('Then .git/MERGE_HEAD records the target tip id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { featureTip } = await setupConflictingMerge(ctx);

        // Act
        await merge(ctx, { target: 'feature', author });

        // Assert — exact content (id + LF), kills mutants that drop LF or
        // record the wrong id.
        const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`);
        expect(sut).toBe(`${featureTip}\n`);
      });
      it('Then .git/ORIG_HEAD records the pre-merge HEAD id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);

        // Act
        await merge(ctx, { target: 'feature', author });

        // Assert
        const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`);
        expect(sut).toBe(`${preMergeMain}\n`);
      });
      it('Then the index has stage-1, stage-2, and stage-3 entries for the conflicting path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);

        // Act
        await merge(ctx, { target: 'feature', author });

        // Assert
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const sut = await readIndex(ctx);
        const fileEntries = sut.entries.filter((e) => e.path === 'file.txt');
        const stages = fileEntries.map((e) => e.flags.stage).sort();
        expect(stages).toEqual([1, 2, 3]);
      });
    });
    describe('When merge runs with a message', () => {
      it('Then .git/MERGE_MSG records the message', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);

        // Act
        await merge(ctx, { target: 'feature', author, message: 'Merge feature into main' });

        // Assert
        const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(sut).toBe('Merge feature into main\n');
      });
    });
  });

  describe('Given a resolved content conflict', () => {
    describe('When add + commit run', () => {
      it('Then a merge commit is created with two parents (origHead + mergeHead)', async () => {
        // Arrange — merge produces conflict; user resolves by overwriting the
        // file and running add + commit. The resulting commit must have
        // parents=[preMergeMain, featureTip].
        const ctx = createMemoryContext();
        const { preMergeMain, featureTip } = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act — manual resolution.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'RESOLVED\n');
        await add(ctx, ['file.txt']);
        const sut = await commit(ctx, { message: 'resolved merge', author });

        // Assert — two parents in the right order.
        expect(sut.parents).toEqual([preMergeMain, featureTip]);

        // Verify the merge-state markers were cleared (recovery aid ORIG_HEAD
        // remains; MERGE_HEAD and MERGE_MSG are gone).
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(true);
      });
    });
  });

  describe('Given a conflicting merge already in progress', () => {
    describe('When merge is called again', () => {
      it('Then throws OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act / Assert
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature', author });
        } catch (err) {
          caught = err;
        }
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        // Assert
        expect(data?.code).toBe('OPERATION_IN_PROGRESS');
        expect(data?.operation).toBe('merge');
      });
    });
  });

  describe('Given an unmerged index', () => {
    describe('When commit runs without resolving', () => {
      it('Then throws MERGE_HAS_CONFLICTS', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act / Assert — user tries to commit BEFORE running `add` on the
        // resolved file; the unmerged stage-1/2/3 entries remain.
        let caught: unknown;
        try {
          await commit(ctx, { message: 'cannot commit', author });
        } catch (err) {
          caught = err;
        }
        const data = (caught as { data?: { code?: string; count?: number } })?.data;
        // Assert
        expect(data?.code).toBe('MERGE_HAS_CONFLICTS');
        expect(data?.count).toBe(1);
      });
    });
  });

  describe('runBounded (direct)', () => {
    describe('Given an empty array', () => {
      describe('When runBounded is called', () => {
        it('Then resolves without invoking fn', async () => {
          // Arrange
          const { runBounded } = await import('../../../../src/application/commands/merge.js');
          let calls = 0;
          const fn = async (): Promise<void> => {
            calls += 1;
          };

          // Act
          await runBounded([], 4, fn);

          // Assert
          expect(calls).toBe(0);
        });
      });
    });

    describe('Given an array of 10 items with limit=3', () => {
      describe('When runBounded runs', () => {
        it('Then fn is invoked exactly 10 times with each item once', async () => {
          // Arrange
          const { runBounded } = await import('../../../../src/application/commands/merge.js');
          const seen: number[] = [];
          const fn = async (item: number): Promise<void> => {
            seen.push(item);
          };

          // Act
          await runBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, fn);

          // Assert — every item processed, no dupes, no skips.
          expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        });
      });
    });

    describe('Given limit greater than array size', () => {
      describe('When runBounded runs', () => {
        it('Then concurrency caps at array length (no over-spawned workers)', async () => {
          // Arrange — track max concurrent in-flight via a counter.
          const { runBounded } = await import('../../../../src/application/commands/merge.js');
          let inFlight = 0;
          let maxInFlight = 0;
          const fn = async (): Promise<void> => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
          };

          // Act
          await runBounded([1, 2, 3], 100, fn);

          // Assert — at most 3 workers (item count), not 100.
          expect(maxInFlight).toBeLessThanOrEqual(3);
        });
      });
    });

    describe('Given limit smaller than array size', () => {
      describe('When runBounded runs', () => {
        it('Then maxInFlight equals limit (bounded concurrency)', async () => {
          // Arrange
          const { runBounded } = await import('../../../../src/application/commands/merge.js');
          let inFlight = 0;
          let maxInFlight = 0;
          const items = Array.from({ length: 50 }, (_, i) => i);
          const fn = async (): Promise<void> => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
          };

          // Act
          await runBounded(items, 4, fn);

          // Assert — concurrency cap respected.
          expect(maxInFlight).toBeLessThanOrEqual(4);
          expect(maxInFlight).toBeGreaterThan(1); // genuine parallelism
        });
      });
    });

    describe('Given fn rejects on one item', () => {
      describe('When runBounded runs', () => {
        it('Then the rejection propagates', async () => {
          // Arrange
          const { runBounded } = await import('../../../../src/application/commands/merge.js');
          const fn = async (item: number): Promise<void> => {
            if (item === 5) throw new Error('boom');
          };

          // Act / Assert
          await expect(runBounded([1, 2, 3, 4, 5, 6], 2, fn)).rejects.toThrow('boom');
        });
      });
    });
  });

  describe('rejectUnsupportedConflicts (direct)', () => {
    describe('Given a %s MergeConflict', () => {
      describe('When rejectUnsupportedConflicts is called', () => {
        it.each([
          'rename-rename',
          'gitlink',
        ] as const)('Then throws UNSUPPORTED_OPERATION with operation=merge', async (conflictType) => {
          // Arrange
          const { rejectUnsupportedConflicts } = await import(
            '../../../../src/application/commands/merge.js'
          );
          const conflict = {
            type: conflictType,
            path: 'sub/path.txt' as never,
          } as never;

          // Act
          let caught: unknown;
          try {
            rejectUnsupportedConflicts([conflict]);
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as { data?: { code?: string; operation?: string; reason?: string } })
            ?.data;
          expect(data?.code).toBe('UNSUPPORTED_OPERATION');
          expect(data?.operation).toBe('merge');
          expect(data?.reason).toContain(conflictType);
          expect(data?.reason).toContain('sub/path.txt');
        });
        it.each([
          'content',
          'add-add',
          'modify-delete',
          'type-change',
          'binary',
        ] as const)('Then does not throw (supported type)', async (conflictType) => {
          // Arrange
          const { rejectUnsupportedConflicts } = await import(
            '../../../../src/application/commands/merge.js'
          );
          const conflict = { type: conflictType, path: 'x.txt' as never } as never;

          // Act / Assert — no throw.
          expect(() => rejectUnsupportedConflicts([conflict])).not.toThrow();
        });
      });
    });

    describe('Given an empty conflicts array', () => {
      describe('When rejectUnsupportedConflicts is called', () => {
        it('Then does not throw', async () => {
          // Arrange
          const { rejectUnsupportedConflicts } = await import(
            '../../../../src/application/commands/merge.js'
          );

          // Act / Assert
          expect(() => rejectUnsupportedConflicts([])).not.toThrow();
        });
      });
    });
  });

  describe('Given a partially-resolved index (one path stage-0, another stage-1/2/3)', () => {
    describe('When commit runs', () => {
      it('Then throws MERGE_HAS_CONFLICTS reporting only the still-unmerged path', async () => {
        // Arrange — start from a multi-conflict setup, resolve ONE path, then
        // attempt to commit. Only the unresolved path should appear in the
        // error's `paths`. Kills `!==` → `===` mutations on
        // rejectUnmergedIndex's stage check, and confirms the set deduplicates
        // stage-1/2/3 entries to a single path.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'base-a\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-b.txt`, 'base-b\n');
        await add(ctx, ['file-a.txt', 'file-b.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'FEAT-A\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-b.txt`, 'FEAT-B\n');
        await add(ctx, ['file-a.txt', 'file-b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'MAIN-A\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-b.txt`, 'MAIN-B\n');
        await add(ctx, ['file-a.txt', 'file-b.txt']);
        await commit(ctx, { message: 'on-main', author });
        await merge(ctx, { target: 'feature', author });

        // Resolve only file-a (move stage-1/2/3 to stage-0); leave file-b
        // unmerged.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'resolved-a\n');
        await add(ctx, ['file-a.txt']);

        // Act / Assert
        let caught: unknown;
        try {
          await commit(ctx, { message: 'partial', author });
        } catch (err) {
          caught = err;
        }
        const data = (
          caught as { data?: { code?: string; count?: number; paths?: ReadonlyArray<string> } }
        )?.data;
        // Assert
        expect(data?.code).toBe('MERGE_HAS_CONFLICTS');
        expect(data?.count).toBe(1);
        expect(data?.paths).toEqual(['file-b.txt']);
      });
    });
  });

  describe('Given a resolved conflict with no MERGE_MSG draft', () => {
    describe('When commit runs with empty message', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE (the empty user message + no draft branch)', async () => {
        // Arrange — set up a conflict, resolve it, manually delete
        // MERGE_MSG to exercise the (c) branch of resolveCommitMessage
        // (empty user message + no MERGE_MSG → sanitizeMessage rejects).
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'RESOLVED\n');
        await add(ctx, ['file.txt']);
        await ctx.fs.rm(`${ctx.layout.gitDir}/MERGE_MSG`);

        // Act / Assert
        let caught: unknown;
        try {
          await commit(ctx, { message: '', author });
        } catch (err) {
          caught = err;
        }
        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('EMPTY_COMMIT_MESSAGE');
      });
    });
  });

  describe('Given a resolved conflict and an empty commit message', () => {
    describe('When commit runs', () => {
      it('Then the MERGE_MSG draft is used as the commit message', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author, message: 'Merge feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'RESOLVED\n');
        await add(ctx, ['file.txt']);

        // Act — empty user message; commit should fall back to MERGE_MSG.
        const sut = await commit(ctx, { message: '', author });

        // Assert
        const { readObject } = await import(
          '../../../../src/application/primitives/read-object.js'
        );
        const commitObj = await readObject(ctx, sut.id);
        if (commitObj.type !== 'commit') throw new Error('not a commit');
        expect(commitObj.data.message).toBe('Merge feature\n');
      });
    });
  });
});

import { recordingProgress, withProgress } from './fixtures.js';

describe('merge — bounded blob reads', () => {
  describe('Given a conflicting merge', () => {
    describe('When the merger runs', () => {
      it('Then ours/theirs/base blob reads OVERLAP at the content-merger phase (parallelism)', async () => {
        // Arrange — set up a conflicting merge so the three blob reads
        // (ours/theirs/base) all happen inside `buildContentMerger`. Pre-
        // compute the three loose-object paths for the conflicting `file.txt`
        // blob on each side; scope the in-flight counter to ONLY those three
        // paths so the earlier `flattenTree` parallel walks (3 tree reads in
        // parallel) don't taint the assertion. A serial mutation of
        // `Promise.all` inside `buildContentMerger` would drop the conflict-
        // blob in-flight count to 1.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Compute the three blob ids (base/feature/main) then derive their
        // loose-object paths. Only reads to these specific paths bump the
        // counter — flattenTree's tree reads are excluded.
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const blobIds = new Set<string>();
        const collectBlob = async (branchName: string): Promise<void> => {
          const tip = await resolveRef(ctx, `refs/heads/${branchName}` as RefName);
          const commitObj = await readObject(ctx, tip);
          if (commitObj.type !== 'commit') throw new Error('not a commit');
          const tree = (await readObject(ctx, commitObj.data.tree)) as Tree;
          const entry = tree.entries.find((e) => e.name === 'file.txt');
          if (entry !== undefined) blobIds.add(entry.id);
        };
        await collectBlob('main');
        await collectBlob('feature');
        // Walk main's parent to grab the base blob id.
        const mainTip = await resolveRef(ctx, 'refs/heads/main' as RefName);
        const mainCommit = await readObject(ctx, mainTip);
        if (mainCommit.type !== 'commit') throw new Error('not a commit');
        const baseCommitId = mainCommit.data.parents[0];
        if (baseCommitId !== undefined) {
          const baseCommit = await readObject(ctx, baseCommitId);
          if (baseCommit.type === 'commit') {
            const baseTree = (await readObject(ctx, baseCommit.data.tree)) as Tree;
            const baseEntry = baseTree.entries.find((e) => e.name === 'file.txt');
            if (baseEntry !== undefined) blobIds.add(baseEntry.id);
          }
        }
        const objectsDir = `${ctx.layout.gitDir}/objects/`;
        const conflictBlobPaths = new Set(
          [...blobIds].map((id) => `${objectsDir}${computeLooseObjectPath(id as ObjectId)}`),
        );

        let inFlight = 0;
        let maxInFlight = 0;
        const originalRead = ctx.fs.read.bind(ctx.fs);
        const originalExists = ctx.fs.exists.bind(ctx.fs);
        const trackConflictBlobOp = async <T>(path: string, op: () => Promise<T>): Promise<T> => {
          if (!conflictBlobPaths.has(path)) return op();
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          try {
            await Promise.resolve();
            return await op();
          } finally {
            inFlight -= 1;
          }
        };
        (ctx.fs as { read: typeof originalRead }).read = (path: string) =>
          trackConflictBlobOp(path, () => originalRead(path));
        (ctx.fs as { exists: typeof originalExists }).exists = (path: string) =>
          trackConflictBlobOp(path, () => originalExists(path));

        // Act — conflicting merge invokes contentMerger which reads the
        // three blobs via Promise.all. Throws MERGE_HAS_CONFLICTS after.
        try {
          await merge(ctx, { target: 'feature', author });
        } catch {
          // expected MERGE_HAS_CONFLICTS — irrelevant to the assertion.
        }

        // Assert — at some moment ≥ 2 CONFLICT-BLOB reads were in flight
        // simultaneously. A sequential merger over the three blob ids would
        // never observe inFlight ≥ 2 for THIS scoped set.
        expect(maxInFlight).toBeGreaterThanOrEqual(2);
      });
    });
  });
});

describe('merge — progress reporting', () => {
  describe('Given an up-to-date merge', () => {
    describe('When run', () => {
      it('Then NO progress events fire (early return before start)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'm', author });
        const { reporter, events } = recordingProgress();

        await merge(withProgress(ctx, reporter), { target: 'main' });

        // Assert
        expect(events).toEqual([]);
      });
    });
  });

  describe('Given a real merge', () => {
    describe('When run', () => {
      it('Then a merge:write-files end event fires (finally block runs)', async () => {
        // Arrange — diverged histories force a true merge through mergeCommit's
        // try/finally; the `finally { progress.end }` block must emit an `end`.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });
        const { reporter, events } = recordingProgress();

        // Act
        await merge(withProgress(ctx, reporter), { target: 'feature', author });

        // Assert — both a start and the finally-block end fired for the op.
        expect(events).toContainEqual({ kind: 'start', op: 'merge:write-files' });
        expect(events).toContainEqual({ kind: 'end', op: 'merge:write-files' });
      });
    });
  });
});

describe('merge — guard rails', () => {
  describe('Given a bare repository', () => {
    describe('When merge runs', () => {
      it('Then throws BARE_REPOSITORY with operation=merge', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

        // Act
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — `operation` carries the literal 'merge'.
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('BARE_REPOSITORY');
        expect(data?.operation).toBe('merge');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When merge runs', () => {
      it('Then throws UNSUPPORTED_OPERATION with the detached-HEAD reason', async () => {
        // Arrange — point HEAD directly at a commit id (detached).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'base', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${c.id}\n`);

        // Act
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — both string args of unsupportedOperation are load-bearing.
        const data = (caught as { data?: { code?: string; operation?: string; reason?: string } })
          ?.data;
        expect(data?.code).toBe('UNSUPPORTED_OPERATION');
        expect(data?.operation).toBe('merge');
        expect(data?.reason).toBe('cannot merge with detached HEAD');
      });
    });
  });

  describe('Given a target that is a strict ancestor branch of HEAD', () => {
    describe('When merge runs', () => {
      it('Then result.kind=up-to-date (base===theirId short-circuit)', async () => {
        // Arrange — main advances two commits; `old` branch stays at the first.
        // The merge target `old` is a STRICT ancestor: base===theirId but
        // base!==ourId, so only the `base === theirId` guard catches it.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'old' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const second = await commit(ctx, { message: 'second', author });

        // Act
        const sut = await merge(ctx, { target: 'old', author });

        // Assert — up-to-date, NOT a fresh merge commit.
        expect(sut.kind).toBe('up-to-date');
        if (sut.kind !== 'up-to-date') throw new Error('expected up-to-date');
        expect(sut.id).toBe(second.id);
      });
    });
  });

  describe('Given a clean merge with an empty message', () => {
    describe('When merge runs', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE (allowEmpty=false)', async () => {
        // Arrange — diverged histories so a true clean merge is attempted.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature', author, message: '' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('EMPTY_COMMIT_MESSAGE');
      });
    });
  });

  describe('Given a conflicting merge with an empty message', () => {
    describe('When merge runs', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE (allowEmpty=false on the conflict path)', async () => {
        // Arrange — a content conflict so persistConflictState's sanitizeMessage runs.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature', author, message: '' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('EMPTY_COMMIT_MESSAGE');
      });
    });
  });

  describe('Given a clean merge', () => {
    describe('When merge runs', () => {
      it('Then the merge commit object records both parents', async () => {
        // Arrange — diverged histories; assert the commit OBJECT's parents
        // (commitData.parents), not just the result envelope.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        const preMain = await resolveRef(ctx, 'refs/heads/main' as RefName);
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const featureTip = await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        const mainTip = await commit(ctx, { message: 'on-main', author });

        // Act
        const sut = await merge(ctx, { target: 'feature', author });

        // Assert — exactly [ourId, theirId]; not an empty parents array.
        expect(sut.kind).toBe('merge');
        if (sut.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, sut.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        expect(mergeCommit.data.parents).toEqual([mainTip.id, featureTip.id]);
        expect(mergeCommit.data.parents).not.toEqual([]);
        expect(preMain).not.toBe(mainTip.id);
      });
    });
  });
});

describe('merge — updateRef CAS guard', () => {
  // Patch readUtf8 so the SECOND read of `refs/heads/main` (the updateRef
  // CAS read) returns a fabricated id, simulating a concurrent ref move.
  // resolveRef reads it once first; the CAS reads it again.
  const patchStaleMainRef = (ctx: ReturnType<typeof createMemoryContext>): void => {
    const refPath = `${ctx.layout.gitDir}/refs/heads/main`;
    const staleId = '1'.repeat(40);
    let mainReads = 0;
    const original = ctx.fs.readUtf8.bind(ctx.fs);
    (ctx.fs as { readUtf8: typeof original }).readUtf8 = async (path: string) => {
      if (path !== refPath) return original(path);
      mainReads += 1;
      return mainReads === 1 ? original(path) : `${staleId}\n`;
    };
  };

  describe('Given the branch ref moved before a fast-forward updateRef', () => {
    describe('When merge runs', () => {
      it('Then throws REF_UPDATE_CONFLICT (expected guard)', async () => {
        // Arrange — fast-forward setup.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        await checkout(ctx, { target: 'main' });
        patchStaleMainRef(ctx);

        // Act
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — the `{ expected: ourId }` CAS rejects the stale ref.
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_UPDATE_CONFLICT');
      });
    });
  });

  describe('Given the branch ref moved before a clean-merge updateRef', () => {
    describe('When merge runs', () => {
      it('Then throws REF_UPDATE_CONFLICT (expected guard)', async () => {
        // Arrange — diverged histories → clean merge → commitCleanMerge's updateRef.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });
        patchStaleMainRef(ctx);

        // Act
        let caught: unknown;
        try {
          await merge(ctx, { target: 'feature', author });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_UPDATE_CONFLICT');
      });
    });
  });

  describe('Given a working-tree write fails mid conflict-persist', () => {
    describe('When merge runs', () => {
      it('Then the index lock is released so a retry is not RESOURCE_LOCKED', async () => {
        // Arrange — a content conflict; patch fs.write to throw on the
        // working-tree conflict file the FIRST time so writeConflictingWorkingTree
        // fails inside persistConflictState's try. The finally block must
        // release the index lock.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        const conflictFile = `${ctx.layout.workDir}/file.txt`;
        const originalWrite = ctx.fs.write.bind(ctx.fs);
        let failOnce = true;
        (ctx.fs as { write: typeof originalWrite }).write = async (path, data) => {
          if (failOnce && path === conflictFile) {
            failOnce = false;
            throw new Error('injected working-tree write failure');
          }
          return originalWrite(path, data);
        };

        // Act — first merge fails mid-persist; lock must be released by finally.
        let firstError: unknown;
        try {
          await merge(ctx, { target: 'feature', author });
        } catch (err) {
          firstError = err;
        }

        // Assert — first merge threw the injected error, AND the lock file is gone.
        expect((firstError as Error)?.message).toBe('injected working-tree write failure');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });
});

describe('resolveTarget (direct)', () => {
  describe('Given an exact 40-hex object id', () => {
    describe('When resolveTarget is called', () => {
      it('Then returns it verbatim as an ObjectId', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = 'a'.repeat(40);

        // Act
        const sut = await resolveTarget(ctx, id);

        // Assert
        expect(sut).toBe(id);
      });
    });
  });

  describe('Given a 40-hex id with a leading non-hex char', () => {
    describe('When resolveTarget is called', () => {
      it('Then it is NOT treated as an oid (anchored ^ regex)', async () => {
        // Arrange — `z` + 40 hex: a substring matches but the anchored regex must
        // reject it, so resolveTarget falls through to a branch-name lookup.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'm', author });
        const target = `z${'a'.repeat(40)}`;

        // Act / Assert — resolves as `refs/heads/<target>`, which does not exist.
        let caught: unknown;
        try {
          await resolveTarget(ctx, target);
        } catch (err) {
          caught = err;
        }
        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given a 40-hex id with a trailing extra char', () => {
    describe('When resolveTarget is called', () => {
      it('Then it is NOT treated as an oid (anchored $ regex)', async () => {
        // Arrange — 40 hex + `0`: 41 chars; the anchored `$` must reject it.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'm', author });
        const target = `${'a'.repeat(40)}0`;

        // Act / Assert
        let caught: unknown;
        try {
          await resolveTarget(ctx, target);
        } catch (err) {
          caught = err;
        }
        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_NOT_FOUND');
      });
    });
  });
});

describe('merge — reflogLabel', () => {
  const seedFastForward = async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['b.txt']);
    await commit(ctx, { message: 'second', author });
    await checkout(ctx, { target: 'main' });
    return ctx;
  };

  describe('Given no reflogLabel and a fast-forward', () => {
    describe('When merge', () => {
      it('Then the branch reflog records the default "merge <target>" prefix', async () => {
        // Arrange
        const ctx = await seedFastForward();

        // Act
        await merge(ctx, { target: 'feature' });

        // Assert
        const messages = (await readReflog(ctx, 'refs/heads/main' as RefName)).map(
          (e) => e.message,
        );
        expect(messages).toContain('merge feature: Fast-forward');
      });
    });
  });

  describe('Given reflogLabel "pull" and a fast-forward', () => {
    describe('When merge', () => {
      it('Then the branch reflog records "pull: Fast-forward"', async () => {
        // Arrange
        const ctx = await seedFastForward();

        // Act
        await merge(ctx, { target: 'feature', reflogLabel: 'pull' });

        // Assert
        const messages = (await readReflog(ctx, 'refs/heads/main' as RefName)).map(
          (e) => e.message,
        );
        expect(messages).toContain('pull: Fast-forward');
      });
    });
  });

  describe('Given reflogLabel "pull" and a forced merge commit', () => {
    describe('When merge', () => {
      it('Then the branch reflog records "pull: Merge made by the \'tsgit\' strategy."', async () => {
        // Arrange
        const ctx = await seedFastForward();

        // Act
        await merge(ctx, {
          target: 'feature',
          noFastForward: true,
          message: 'merge',
          author,
          reflogLabel: 'pull',
        });

        // Assert
        const messages = (await readReflog(ctx, 'refs/heads/main' as RefName)).map(
          (e) => e.message,
        );
        expect(messages).toContain("pull: Merge made by the 'tsgit' strategy.");
      });
    });
  });
});

describe('resolveTarget (gitrevisions ref-DWIM)', () => {
  describe('Given a remote-tracking ref and the short name origin/<branch>', () => {
    describe('When resolveTarget is called', () => {
      it('Then resolves via refs/remotes/<base>', async () => {
        // Arrange — seed refs/remotes/origin/main → a real commit.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'm', author });
        await updateRef(ctx, 'refs/remotes/origin/main' as RefName, c.id, {
          reflogMessage: 'seed',
        });

        // Act
        const sut = await resolveTarget(ctx, 'origin/main');

        // Assert
        expect(sut).toBe(c.id);
      });
    });
  });

  describe('Given a bare branch name with a same-named remote-tracking ref absent', () => {
    describe('When resolveTarget is called', () => {
      it('Then still resolves via refs/heads/<base> (regression)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'm', author });
        await branchCreate(ctx, { name: 'feature' });
        const head = await resolveRef(ctx, 'refs/heads/feature' as RefName);

        // Act
        const sut = await resolveTarget(ctx, 'feature');

        // Assert
        expect(sut).toBe(head);
      });
    });
  });

  describe('Given an annotated tag pointing to a commit', () => {
    describe('When resolveTarget is called by the tag short name', () => {
      it('Then peels the tag to its commit', async () => {
        // Arrange — annotated tag object (NOT a lightweight tag) under refs/tags/v1.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'm', author });
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: c.id,
            objectType: 'commit',
            tagName: 'v1',
            tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
            message: 'v1',
            extraHeaders: [],
          },
        };
        const tagId = await writeObject(ctx, tag);
        await updateRef(ctx, 'refs/tags/v1' as RefName, tagId, { reflogMessage: 'seed' });

        // Act
        const sut = await resolveTarget(ctx, 'v1');

        // Assert — peeled to the commit, NOT the tag object id.
        expect(sut).toBe(c.id);
        expect(sut).not.toBe(tagId);
      });
    });
  });

  describe('Given a name resolvable by none of the candidates', () => {
    describe('When resolveTarget is called', () => {
      it('Then throws REF_NOT_FOUND', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);

        // Act
        let caught: unknown;
        try {
          await resolveTarget(ctx, 'origin/nope');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_NOT_FOUND');
      });
    });
  });
});

describe('resolveMergeAuthor / resolveMergeCommitter (direct)', () => {
  describe('Given no explicit author and a configured user', () => {
    describe('When resolveMergeAuthor runs', () => {
      it('Then returns the config user with a sane timestamp and +0000 offset', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n  name = Grace\n  email = grace@example.com\n',
        );
        const before = Math.floor(Date.now() / 1000);

        // Act
        const sut = await resolveMergeAuthor(ctx, { target: 'feature' });

        // Assert — name/email from config; timestamp is Date.now()/1000 (seconds,
        // not ms — kills the `/1000`→`*1000` mutant); offset is the literal +0000.
        const after = Math.floor(Date.now() / 1000);
        expect(sut.name).toBe('Grace');
        expect(sut.email).toBe('grace@example.com');
        expect(sut.timezoneOffset).toBe('+0000');
        expect(sut.timestamp).toBeGreaterThanOrEqual(before);
        expect(sut.timestamp).toBeLessThanOrEqual(after);
      });
    });
  });

  describe('Given an explicit author', () => {
    describe('When resolveMergeAuthor runs', () => {
      it('Then the explicit author wins over config', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n  name = Grace\n  email = grace@example.com\n',
        );

        // Act
        const sut = await resolveMergeAuthor(ctx, { target: 'feature', author });

        // Assert
        expect(sut).toEqual(author);
      });
    });
  });

  describe('Given an explicit committer', () => {
    describe('When resolveMergeCommitter runs', () => {
      it('Then the explicit committer wins over the author', async () => {
        // Arrange
        const committer: AuthorIdentity = {
          name: 'Linus',
          email: 'linus@example.com',
          timestamp: 1_700_000_500,
          timezoneOffset: '+0100',
        };

        // Act
        const sut = resolveMergeCommitter({ target: 'feature', committer }, author);

        // Assert
        expect(sut).toEqual(committer);
      });
    });
  });

  describe('Given no explicit committer', () => {
    describe('When resolveMergeCommitter runs', () => {
      it('Then it falls back to the author', async () => {
        // Arrange
        const sut = resolveMergeCommitter({ target: 'feature' }, author);

        // Assert
        expect(sut).toEqual(author);
      });
    });
  });
});

describe('parentDir (direct)', () => {
  describe('Given a nested path', () => {
    describe('When parentDir is called', () => {
      it('Then returns the directory above the leaf', () => {
        // Arrange
        const sut = parentDir('/work/sub/file.txt');

        // Assert
        expect(sut).toBe('/work/sub');
      });
    });
  });

  describe('Given a path whose only slash is at index 0', () => {
    describe('When parentDir is called', () => {
      it('Then returns undefined (lastSlash <= 0)', () => {
        // Arrange
        const sut = parentDir('/abc');

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a path with no slash', () => {
    describe('When parentDir is called', () => {
      it('Then returns undefined (lastSlash === -1)', () => {
        // Arrange
        const sut = parentDir('abc');

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });
});

describe('writeNestedTree (direct)', () => {
  describe('Given flat leaves at depth exactly MAX_MERGE_TREE_DEPTH', () => {
    describe('When writeNestedTree runs', () => {
      it('Then it succeeds (depth > cap, not >=)', async () => {
        // Arrange — no subdirs, so no recursion; depth === cap must NOT throw.
        const ctx = createMemoryContext();
        await init(ctx);
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('x'),
          id: '' as ObjectId,
        });
        const leaves = [{ path: 'f.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act
        const sut = await writeNestedTree(ctx, leaves, MAX_MERGE_TREE_DEPTH);

        // Assert — a real tree id was produced.
        const tree = await readObject(ctx, sut);
        expect(tree.type).toBe('tree');
      });
    });
  });

  describe('Given a nested leaf at depth MAX_MERGE_TREE_DEPTH', () => {
    describe('When writeNestedTree recurses', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED with depth=cap+1', async () => {
        // Arrange — a leaf with a `/` forces one recursion to depth cap+1.
        const ctx = createMemoryContext();
        await init(ctx);
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('x'),
          id: '' as ObjectId,
        });
        const leaves = [{ path: 'sub/f.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act
        let caught: unknown;
        try {
          await writeNestedTree(ctx, leaves, MAX_MERGE_TREE_DEPTH);
        } catch (err) {
          caught = err;
        }

        // Assert — the recursion adds exactly 1 (depth + 1), tripping the cap at
        // cap+1; this kills `depth - 1` and the `false` conditional mutant.
        const data = (caught as { data?: { code?: string; depth?: number } })?.data;
        expect(data?.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data?.depth).toBe(MAX_MERGE_TREE_DEPTH + 1);
      });
    });
  });
});

describe('writeOutcomeToTree (direct)', () => {
  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(text),
      id: '' as ObjectId,
    });

  describe('Given an unchanged outcome', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the blob content is written to the working tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'UNCHANGED-BYTES');
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: 'u.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/u.txt`)).toBe('UNCHANGED-BYTES');
      });
    });
  });

  describe('Given a resolved-known outcome', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the blob content is written to the working tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'KNOWN-BYTES');
        const outcome: MergeOutcome = {
          status: 'resolved-known',
          path: 'k.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/k.txt`)).toBe('KNOWN-BYTES');
      });
    });
  });

  describe('Given a resolved-merged outcome', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the outcome bytes are written verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const outcome: MergeOutcome = {
          status: 'resolved-merged',
          path: 'm.txt' as FilePath,
          bytes: new TextEncoder().encode('MERGED-BYTES'),
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/m.txt`)).toBe('MERGED-BYTES');
      });
    });
  });

  describe('Given a resolved-deleted outcome for an existing file', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the working-tree file is removed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d.txt`, 'to-be-removed');
        const outcome: MergeOutcome = { status: 'resolved-deleted', path: 'd.txt' as FilePath };

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/d.txt`)).toBe(false);
      });
    });
  });
});

describe('removeWorkingTreeFile (direct)', () => {
  describe('Given an existing working-tree file', () => {
    describe('When removeWorkingTreeFile runs', () => {
      it('Then the file is deleted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/gone.txt`, 'bytes');

        // Act
        await removeWorkingTreeFile(ctx, 'gone.txt' as FilePath);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/gone.txt`)).toBe(false);
      });
    });
  });

  describe('Given a path with no working-tree file', () => {
    describe('When removeWorkingTreeFile runs', () => {
      it('Then it does NOT throw (exists guard)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);

        // Act / Assert — the `if (exists)` guard prevents an rm on a missing path.
        await expect(removeWorkingTreeFile(ctx, 'absent.txt' as FilePath)).resolves.toBeUndefined();
      });
    });
  });
});

describe('materialiseConflictBytes (direct)', () => {
  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(text),
      id: '' as ObjectId,
    });
  const conflictOf = (over: Partial<MergeConflict>): MergeConflict =>
    ({ path: 'c.txt' as FilePath, ...over }) as MergeConflict;
  const decode = (b: Uint8Array | undefined): string =>
    b === undefined ? '<undefined>' : new TextDecoder().decode(b);

  describe('Given a content conflict carrying conflictContent', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns that conflictContent verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const marker = new TextEncoder().encode('PRECOMPUTED-CONFLICT-CONTENT');
        const conflict = conflictOf({ type: 'content', conflictContent: marker });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(decode(sut)).toBe('PRECOMPUTED-CONFLICT-CONTENT');
      });
    });
  });

  describe('Given a non-content conflict that also carries conflictContent', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then conflictContent is NOT used (the type===content operand matters)', async () => {
        // Arrange — a type-change conflict with BOTH conflictContent and ourId.
        // The `type === 'content'` operand must gate the early return; otherwise
        // a mutant forcing it true would return conflictContent instead of ours.
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-TYPECHANGE');
        const conflict = conflictOf({
          type: 'type-change',
          conflictContent: new TextEncoder().encode('SHOULD-NOT-BE-USED'),
          ourId: oursId,
        });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert — ours blob wins, conflictContent ignored.
        expect(decode(sut)).toBe('OURS-TYPECHANGE');
      });
    });
  });

  describe('Given a binary conflict with ourId', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns the ours blob bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-BINARY');
        const conflict = conflictOf({ type: 'binary', ourId: oursId });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(decode(sut)).toBe('OURS-BINARY');
      });
    });
  });

  describe('Given a binary conflict with no ourId', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = conflictOf({ type: 'binary' });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given an add-add conflict with ourId', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns the ours blob bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-ADDADD');
        const conflict = conflictOf({ type: 'add-add', ourId: oursId });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(decode(sut)).toBe('OURS-ADDADD');
      });
    });
  });

  describe('Given an add-add conflict with no ourId', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = conflictOf({ type: 'add-add' });

        // Act / Assert
        expect(await materialiseConflictBytes(ctx, conflict)).toBeUndefined();
      });
    });
  });

  describe('Given a type-change conflict with ourId', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns the ours blob bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-TYPE-CHANGE');
        const conflict = conflictOf({ type: 'type-change', ourId: oursId });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(decode(sut)).toBe('OURS-TYPE-CHANGE');
      });
    });
  });

  describe('Given a modify-delete conflict with ourId only', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns the ours blob bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-MODDEL');
        const conflict = conflictOf({ type: 'modify-delete', ourId: oursId });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(decode(sut)).toBe('OURS-MODDEL');
      });
    });
  });

  describe('Given a modify-delete conflict with theirId only', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns the theirs blob bytes (?? falls through)', async () => {
        // Arrange — no ourId; the `ourId ?? theirId` must yield theirId.
        const ctx = createMemoryContext();
        await init(ctx);
        const theirsId = await seedBlob(ctx, 'THEIRS-MODDEL');
        const conflict = conflictOf({ type: 'modify-delete', theirId: theirsId });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(decode(sut)).toBe('THEIRS-MODDEL');
      });
    });
  });

  describe('Given a modify-delete conflict with neither id', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = conflictOf({ type: 'modify-delete' });

        // Act / Assert
        expect(await materialiseConflictBytes(ctx, conflict)).toBeUndefined();
      });
    });
  });

  describe('Given a content conflict with no conflictContent but ours+theirs ids', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it builds a marker block from both blobs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-LINE');
        const theirsId = await seedBlob(ctx, 'THEIRS-LINE');
        const conflict = conflictOf({ type: 'content', ourId: oursId, theirId: theirsId });

        // Act
        const sut = await materialiseConflictBytes(ctx, conflict);

        // Assert — a real conflict-marker block containing BOTH sides.
        const text = decode(sut);
        expect(text).toContain('<<<<<<<');
        expect(text).toContain('=======');
        expect(text).toContain('>>>>>>>');
        expect(text).toContain('OURS-LINE');
        expect(text).toContain('THEIRS-LINE');
      });
    });
  });

  describe('Given a content conflict with no conflictContent and only ourId', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns undefined (theirId operand required)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-ONLY');
        const conflict = conflictOf({ type: 'content', ourId: oursId });

        // Act / Assert
        expect(await materialiseConflictBytes(ctx, conflict)).toBeUndefined();
      });
    });
  });

  describe('Given an unhandled conflict type carrying ours+theirs ids', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns undefined (the second type===content guard matters)', async () => {
        // Arrange — a gitlink conflict reaches the final `if` block; the
        // `type === 'content'` operand must keep it out, returning undefined.
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-GITLINK');
        const theirsId = await seedBlob(ctx, 'THEIRS-GITLINK');
        const conflict = conflictOf({ type: 'gitlink', ourId: oursId, theirId: theirsId });

        // Act / Assert
        expect(await materialiseConflictBytes(ctx, conflict)).toBeUndefined();
      });
    });
  });
});

describe('buildConflictIndexEntries (direct)', () => {
  const fakeId = (c: string): ObjectId => c.repeat(40) as ObjectId;

  describe('Given an unchanged outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then a stage-0 entry is produced for it', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'u.txt' as FilePath,
            id: fakeId('a'),
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, [], undefined);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.path).toBe('u.txt');
        expect(sut[0]?.flags.stage).toBe(0);
      });
    });
  });

  describe('Given a resolved-known outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then a stage-0 entry is produced for it', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'resolved-known',
            path: 'k.txt' as FilePath,
            id: fakeId('b'),
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, [], undefined);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.path).toBe('k.txt');
        expect(sut[0]?.flags.stage).toBe(0);
      });
    });
  });

  describe('Given a resolved-deleted outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then no stage-0 entry is produced', () => {
        // Arrange — resolved-deleted/resolved-merged are excluded from stage-0.
        const outcomes: MergeOutcome[] = [
          { status: 'resolved-deleted', path: 'd.txt' as FilePath },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, [], undefined);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given a stage-0 outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then the entry flags are assumeValid=false and skipWorktree=false', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'f.txt' as FilePath,
            id: fakeId('c'),
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, [], undefined);

        // Assert — every flag is literally false.
        expect(sut[0]?.flags.assumeValid).toBe(false);
        expect(sut[0]?.flags.skipWorktree).toBe(false);
        expect(sut[0]?.flags.intentToAdd).toBe(false);
      });
    });
  });

  describe('Given stage-0 outcomes and a conflict whose paths interleave alphabetically', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then entries are sorted by (path, stage)', () => {
        // Arrange — stage-0 paths `zzz`/`aaa` and a content conflict on `mmm`.
        // `[...stage0, ...stageConflicts]` is `[zzz@0, aaa@0, mmm@1, mmm@2, mmm@3]`
        // — NOT sorted; the explicit `combined.sort` must reorder it.
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'zzz.txt' as FilePath,
            id: fakeId('e'),
            mode: FILE_MODE.REGULAR,
          },
          {
            status: 'resolved-known',
            path: 'aaa.txt' as FilePath,
            id: fakeId('d'),
            mode: FILE_MODE.REGULAR,
          },
        ];
        const conflicts: MergeConflict[] = [
          {
            type: 'content',
            path: 'mmm.txt' as FilePath,
            baseId: fakeId('1'),
            ourId: fakeId('2'),
            theirId: fakeId('3'),
            baseMode: FILE_MODE.REGULAR,
            ourMode: FILE_MODE.REGULAR,
            theirMode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, conflicts, undefined);

        // Assert — fully sorted by path, then by stage within `mmm.txt`.
        const order = sut.map((e) => `${e.path}@${e.flags.stage}`);
        expect(order).toEqual(['aaa.txt@0', 'mmm.txt@1', 'mmm.txt@2', 'mmm.txt@3', 'zzz.txt@0']);
      });
    });
  });
});

describe('merge — sparse checkout', () => {
  // Matcher excluding any path that starts with `drop`.
  const excludesDrop = (p: FilePath): boolean => !p.startsWith('drop');

  const enableSparseSrcOnly = async (ctx: ReturnType<typeof createMemoryContext>) => {
    const { updateCoreConfig } = await import(
      '../../../../src/application/primitives/update-config.js'
    );
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '/*\n!/*/\n/src/\n');
    await updateCoreConfig(ctx, { sparseCheckout: 'true', sparseCheckoutCone: 'true' });
  };

  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, { type: 'blob', content: new TextEncoder().encode(text), id: '' as ObjectId });

  describe('Given an unchanged outcome whose path the sparse matcher excludes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is not written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'X');
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: 'drop.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/drop.txt`)).toBe(false);
      });
    });
  });

  describe('Given an unchanged outcome whose path the sparse matcher includes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'KEPT');
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: 'keep.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/keep.txt`)).toBe('KEPT');
      });
    });
  });

  describe('Given a resolved-known outcome whose path the sparse matcher excludes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is not written', async () => {
        // Arrange — `resolved-known` is blob-backed like `unchanged`, so an
        // excluded path is skipped: its content is recoverable from the store.
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'X');
        const outcome: MergeOutcome = {
          status: 'resolved-known',
          path: 'drop.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/drop.txt`)).toBe(false);
      });
    });
  });

  describe('Given a resolved-merged outcome whose path the sparse matcher excludes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is still written (merged bytes have no other persistence)', async () => {
        // Arrange — `resolved-merged` carries its merged bytes in memory only;
        // the working-tree write is their sole persistence, so it must happen
        // even for an out-of-pattern path, unlike a blob-backed clean outcome.
        const ctx = createMemoryContext();
        await init(ctx);
        const outcome: MergeOutcome = {
          status: 'resolved-merged',
          path: 'drop.txt' as FilePath,
          bytes: new TextEncoder().encode('MERGED'),
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/drop.txt`)).toBe('MERGED');
      });
    });
  });

  describe('Given an unchanged outcome whose path the sparse matcher excludes', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then its stage-0 entry is skip-worktree', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'drop.txt' as FilePath,
            id: 'a'.repeat(40) as ObjectId,
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, [], excludesDrop);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.path).toBe('drop.txt');
        expect(sut[0]?.flags.stage).toBe(0);
        expect(sut[0]?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a resolved-known outcome whose path the sparse matcher excludes', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then its stage-0 entry is skip-worktree', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'resolved-known',
            path: 'drop.txt' as FilePath,
            id: 'b'.repeat(40) as ObjectId,
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, [], excludesDrop);

        // Assert
        expect(sut[0]?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given an unchanged outcome whose path the sparse matcher includes', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then its stage-0 entry is not skip-worktree', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'keep.txt' as FilePath,
            id: 'c'.repeat(40) as ObjectId,
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const sut = buildConflictIndexEntries(outcomes, [], excludesDrop);

        // Assert
        expect(sut[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a sparse repo', () => {
    describe('When a conflicting merge runs', () => {
      it('Then an excluded clean path is not re-materialised but the in-pattern conflict is', async () => {
        // Arrange — base has `src/a.txt` + `docs/b.txt`; main and feature each
        // change only `src/a.txt` (→ conflict). `docs/b.txt` is unchanged on every
        // side (→ a clean `unchanged` outcome). Sparse excludes `docs/`; the file
        // is removed from disk to mimic a sparse working tree.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'base-a\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'shared-b\n');
        await add(ctx, ['src/a.txt', 'docs/b.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'FEATURE-a\n');
        await add(ctx, ['src/a.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'MAIN-a\n');
        await add(ctx, ['src/a.txt']);
        await commit(ctx, { message: 'on-main', author });
        await enableSparseSrcOnly(ctx);
        await ctx.fs.rm(`${ctx.layout.workDir}/docs/b.txt`);

        // Act
        const sut = await merge(ctx, { target: 'feature', author });

        // Assert — the in-pattern conflict file is materialised with markers; the
        // excluded clean file stays absent (not re-materialised) and is recorded
        // skip-worktree.
        expect(sut.kind).toBe('conflict');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/src/a.txt`)).toContain('<<<<<<<');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree).toBe(true);
        const srcStages = index.entries
          .filter((e) => e.path === 'src/a.txt')
          .map((e) => e.flags.stage)
          .sort((a, b) => a - b);
        expect(srcStages).toEqual([1, 2, 3]);
      });
    });
  });
});
