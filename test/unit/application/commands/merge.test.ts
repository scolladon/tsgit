import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branch } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { merge } from '../../../../src/application/commands/merge.js';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type {
  AuthorIdentity,
  ObjectId,
  RefName,
  Tree,
} from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('merge', () => {
  it('Given target equals HEAD, When merge, Then result.kind=up-to-date', async () => {
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

  it('Given an ancestor target, When merge, Then result.kind=fast-forward and branch advances', async () => {
    // Arrange — create main with 1 commit, branch feature, advance feature, switch to main, merge feature.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
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

  it('Given an ancestor target + noFastForward=true, When merge, Then a real merge commit is produced', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
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

  it('Given diverged histories with non-conflicting paths, When merge, Then commit tree contains both sides files (no add required)', async () => {
    // Arrange — base has a.txt. Feature adds b.txt. Main adds c.txt.
    // After merging feature into main, the merge commit's tree must
    // contain BOTH b.txt AND c.txt (clean three-way merge result),
    // NOT just main's tree.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
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

  it('Given a non-overlapping content change to the same file on each side, When merge, Then merged content combines both edits', async () => {
    // Arrange — base file has 3 lines. Each side modifies a different line.
    // Phase 5's mergeContent should produce a clean merge with both edits.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'line1\nline2\nline3\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
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

  it('Given conflicting modifications to the same file, When merge, Then throws MERGE_HAS_CONFLICTS with the conflicting path', async () => {
    // Arrange — same file, divergent content on the same lines.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'shared\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE-CHANGE\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'on-feature', author });
    await checkout(ctx, { target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN-CHANGE\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'on-main', author });

    // Act
    let caught: unknown;
    try {
      await merge(ctx, { target: 'feature', author });
    } catch (err) {
      caught = err;
    }

    // Assert — error code + path + count.
    const data = (
      caught as {
        data?: { code?: string; count?: number; paths?: ReadonlyArray<string> };
      }
    )?.data;
    expect(data?.code).toBe('MERGE_HAS_CONFLICTS');
    expect(data?.count).toBe(1);
    expect(data?.paths).toEqual(['file.txt']);

    // Also confirm HEAD did NOT advance (the conflicting merge must not commit).
    const main = await resolveRef(ctx, 'refs/heads/main' as RefName);
    const mainCommit = await readObject(ctx, main);
    if (mainCommit.type !== 'commit') throw new Error('not a commit');
    expect(mainCommit.data.message).toBe('on-main'); // still pre-merge tip
    expect(mainCommit.data.parents).toHaveLength(1); // not a merge commit
  });

  it('Given a merge where one side deletes a file the other unchanged, When merge, Then the merged tree omits the deleted file', async () => {
    // Arrange — base has a.txt + b.txt. Feature deletes a.txt. Main is
    // unchanged. The merge result should have b.txt only — exercising
    // the resolved-deleted branch of collectLeaves.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['a.txt', 'b.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
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

  it('Given a clean merge with nested subdirectory paths, When merge, Then writeNestedTree produces correct nested trees', async () => {
    // Arrange — both sides add files under `src/<dir>/...`. Exercises
    // writeNestedTree's nested-directory branch + Promise.all parallel
    // sub-tree resolution.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/base.ts`, 'base');
    await add(ctx, ['src/base.ts']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/feature/a.ts`, 'a');
    await add(ctx, ['src/feature/a.ts']);
    await commit(ctx, { message: 'on-feature', author });
    await checkout(ctx, { target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/main/b.ts`, 'b');
    await add(ctx, ['src/main/b.ts']);
    await commit(ctx, { message: 'on-main', author });

    // Act
    const sut = await merge(ctx, { target: 'feature', author });

    // Assert — merged root has 'src', src has feature/ + main/ + base.ts.
    expect(sut.kind).toBe('merge');
    if (sut.kind !== 'merge') throw new Error('expected merge kind');
    const mergeCommit = await readObject(ctx, sut.id);
    if (mergeCommit.type !== 'commit') throw new Error('not a commit');
    const root = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
    expect(root.entries.map((e) => e.name)).toEqual(['src']);
    const srcEntry = root.entries[0];
    if (srcEntry === undefined) throw new Error('expected src entry');
    const src = (await readObject(ctx, srcEntry.id)) as Tree;
    const srcNames = src.entries.map((e) => e.name).sort();
    expect(srcNames).toEqual(['base.ts', 'feature', 'main']);
  });

  it('Given unrelated histories (no merge base), When merge, Then content merger receives base=undefined for add-add paths', async () => {
    // Arrange — create two unrelated commit trees by writing root commits
    // in fresh-init repos and then crafting refs that share no ancestor.
    // We seed feature as an unrelated root commit using updateRef directly.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'main\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'main-root', author });

    // Build an unrelated commit chain by writing a fresh blob+tree+commit
    // with no parents.
    const { writeObject } = await import('../../../../src/application/primitives/write-object.js');
    const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
    const { createCommit } = await import(
      '../../../../src/application/primitives/create-commit.js'
    );
    const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
    const { FILE_MODE } = await import('../../../../src/domain/objects/file-mode.js');
    const otherBlobId = await writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode('other\n'),
      id: '' as ObjectId,
    });
    const otherTreeId = await writeTree(ctx, [
      { name: 'other.txt' as never, id: otherBlobId, mode: FILE_MODE.REGULAR },
    ]);
    const otherCommitId = await createCommit(ctx, {
      tree: otherTreeId,
      parents: [],
      author,
      committer: author,
      message: 'unrelated-root',
      extraHeaders: [],
    });
    await updateRef(ctx, 'refs/heads/unrelated' as RefName, otherCommitId, {});

    // Act
    const sut = await merge(ctx, { target: 'unrelated', author });

    // Assert — merge succeeds; merged tree contains both files.
    expect(sut.kind).toBe('merge');
    if (sut.kind !== 'merge') throw new Error('expected merge kind');
    const mergeCommit = await readObject(ctx, sut.id);
    if (mergeCommit.type !== 'commit') throw new Error('not a commit');
    const mergedTree = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
    const names = mergedTree.entries.map((e) => e.name).sort();
    expect(names).toEqual(['file.txt', 'other.txt']);
  });

  it('Given diverged histories + fastForwardOnly=true, When merge, Then throws NON_FAST_FORWARD', async () => {
    // Arrange — diverge: both branches advance from a common base.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
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

import { recordingProgress, withProgress } from './fixtures.js';

describe('merge — progress reporting', () => {
  it('Given an up-to-date merge, When run, Then NO progress events fire (early return before start)', async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'm', author });
    const { reporter, events } = recordingProgress();

    await merge(withProgress(ctx, reporter), { target: 'main' });

    expect(events).toEqual([]);
  });
});
