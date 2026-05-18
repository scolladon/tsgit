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
import type { TsgitError } from '../../../../src/domain/error.js';
import { MAX_CONFLICT_OUTPUT_BYTES } from '../../../../src/domain/merge/index.js';
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

  it('Given a clean merge with multiple top-level subdirectories on each side, When merge, Then writeNestedTree resolves all subdirs in parallel and produces correct nested trees', async () => {
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
    await branch(ctx, { kind: 'create', name: 'feature' });
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

  it('Given unrelated histories sharing a path with divergent content, When merge, Then add-add conflict surfaces (proves baseFlat is undefined, not silently substituted)', async () => {
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
    const { writeObject } = await import('../../../../src/application/primitives/write-object.js');
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
    await updateRef(ctx, 'refs/heads/unrelated' as RefName, otherCommitId, {});

    // Act
    let caught: unknown;
    try {
      await merge(ctx, { target: 'unrelated', author });
    } catch (err) {
      caught = err;
    }

    // Assert — add-add conflict for shared.txt.
    const data = (caught as { data?: { code?: string; paths?: ReadonlyArray<string> } })?.data;
    expect(data?.code).toBe('MERGE_HAS_CONFLICTS');
    expect(data?.paths).toEqual(['shared.txt']);
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

describe('merge — bounded blob reads (Phase 13.8)', () => {
  it('Given a conflicting merge, When the merger reads a blob exceeding MAX_CONFLICT_OUTPUT_BYTES, Then it throws OBJECT_TOO_LARGE before line-diff work', async () => {
    // Arrange — set up a divergent conflict and substitute one side's
    // blob with a real loose object whose actual content exceeds
    // MAX_CONFLICT_OUTPUT_BYTES by one byte. Per ADR-024 §3.1 the loose
    // cap measures the actual inflated content (not the declared header
    // size), so this is the only way to exercise the merger-level
    // rejection path. Memory cost: ~256 MiB of zeros for the duration
    // of this single test.
    //
    // The blob is hash-correct (we let `writeObject` compute it from the
    // content), so `verifyHash` succeeds and the cap is the only thing
    // that can reject. A bypass would let `mergeContent` attempt to
    // line-diff the buffer.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    await checkout(ctx, { target: 'feature' });

    // Replace the working-tree content with a real MAX+1-byte payload
    // on the feature branch, stage, and commit. `add` will write the
    // loose object to .git/objects via writeObject.
    const { writeObject } = await import('../../../../src/application/primitives/write-object.js');
    const oversizeContent = new Uint8Array(MAX_CONFLICT_OUTPUT_BYTES + 1); // all zeros
    const oversizeId = await writeObject(ctx, {
      type: 'blob',
      content: oversizeContent,
      id: '' as ObjectId,
    });

    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'feat\n');
    await add(ctx, ['file.txt']);
    // Re-stage `file.txt`'s entry pointing at the oversize blob id by
    // forging the index. Simpler approach: just commit ANY content as
    // feat, then redirect the file.txt entry via the tree it produces.
    // For the test we only need merge to ATTEMPT to read the oversize
    // blob — so make HEAD on feature point at it directly via a forged
    // tree containing { file.txt -> oversizeId }.
    const { FILE_MODE } = await import('../../../../src/domain/objects/index.js');
    const featTreeId = await writeObject(ctx, {
      type: 'tree',
      entries: [
        {
          name: 'file.txt' as never,
          id: oversizeId,
          mode: FILE_MODE.REGULAR,
        },
      ],
      id: '' as ObjectId,
    });
    const { createCommit } = await import(
      '../../../../src/application/primitives/create-commit.js'
    );
    const featCommitId = await createCommit(ctx, {
      tree: featTreeId,
      parents: [(await resolveRef(ctx, 'refs/heads/feature' as RefName)) as ObjectId],
      author,
      committer: author,
      message: 'oversize on feature',
      extraHeaders: [],
    });
    const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
    await updateRef(ctx, 'refs/heads/feature' as RefName, featCommitId);

    await checkout(ctx, { target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'main\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'on-main', author });

    // Act
    let caught: unknown;
    try {
      await merge(ctx, { target: 'feature', author });
    } catch (err) {
      caught = err;
    }

    // Assert — cap fires with exact id, actualSize, limit.
    const data = (caught as TsgitError | undefined)?.data;
    expect(data?.code).toBe('OBJECT_TOO_LARGE');
    if (data?.code !== 'OBJECT_TOO_LARGE') {
      expect.fail(`expected OBJECT_TOO_LARGE, got ${data?.code}`);
    }
    expect(data.id).toBe(oversizeId);
    expect(data.actualSize).toBe(MAX_CONFLICT_OUTPUT_BYTES + 1);
    expect(data.limit).toBe(MAX_CONFLICT_OUTPUT_BYTES);
  }, 60_000);

  it('Given a conflicting merge, When the merger runs, Then ours/theirs/base blob reads issue concurrently (parallelism)', async () => {
    // Arrange — instrument the memory FS to record when read I/O starts and
    // ends. Build a conflicting merge with a base commit so all three reads
    // happen. If the merger ran reads sequentially, every read would END
    // before the next STARTS — the parallel implementation must show
    // overlap (≥ 2 reads in-flight simultaneously at some moment).
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'on-feature', author });
    await checkout(ctx, { target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'on-main', author });

    // Wrap BOTH fs.exists and fs.read on the objects path so the
    // instrumentation window spans the full readBlob I/O cycle
    // (`tryLoose` calls exists then read). A serial implementation would
    // exit one wrap before entering the next; a Promise.all dispatch
    // overlaps three wraps simultaneously.
    let inFlight = 0;
    let maxInFlight = 0;
    const objectsDir = `${ctx.layout.gitDir}/objects/`;
    const originalRead = ctx.fs.read.bind(ctx.fs);
    const originalExists = ctx.fs.exists.bind(ctx.fs);
    const trackObjectOp = async <T>(path: string, op: () => Promise<T>): Promise<T> => {
      const isObjectOp = path.startsWith(objectsDir);
      if (!isObjectOp) return op();
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        // Yield a microtask so concurrent dispatches overlap on the queue.
        await Promise.resolve();
        return await op();
      } finally {
        inFlight -= 1;
      }
    };
    (ctx.fs as { read: typeof originalRead }).read = (path: string) =>
      trackObjectOp(path, () => originalRead(path));
    (ctx.fs as { exists: typeof originalExists }).exists = (path: string) =>
      trackObjectOp(path, () => originalExists(path));

    // Act — clean three-way merge would NOT exercise content-merger (no
    // conflicting paths). Use the conflicting setup; the merger throws
    // MERGE_HAS_CONFLICTS after reading the three blobs. We only need the
    // reads to have happened concurrently.
    try {
      await merge(ctx, { target: 'feature', author });
    } catch {
      // expected MERGE_HAS_CONFLICTS — irrelevant to the assertion.
    }

    // Assert — at some moment ≥ 2 object reads were simultaneously in flight.
    // A sequential implementation would never exceed 1.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});

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
