import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { reset } from '../../../../src/application/commands/reset.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedTwoCommits = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c1 = await commit(ctx, { message: 'first', author });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
  await add(ctx, ['b.txt']);
  const c2 = await commit(ctx, { message: 'second', author });
  return { ctx, c1: c1.id, c2: c2.id };
};

describe('reset', () => {
  describe('Given a soft reset to HEAD~1 (parent)', () => {
    describe('When reset', () => {
      it('Then current branch points at parent', async () => {
        // Arrange
        const { ctx, c1, c2 } = await seedTwoCommits();

        // Act
        const sut = await reset(ctx, { mode: 'soft', target: c1 });

        // Assert
        expect(sut.id).toBe(c1);
        expect(sut.branch).toBe('refs/heads/main');
        const ref = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
        expect(ref.trim()).toBe(c1);
        expect(c2).not.toBe(c1);
      });
    });
  });

  describe('Given mixed mode and target oid', () => {
    describe('When reset', () => {
      it('Then HEAD branch updated', async () => {
        // Arrange
        const { ctx, c1 } = await seedTwoCommits();
        const sut = await reset(ctx, { mode: 'mixed', target: c1 });
        // Assert
        expect(sut.mode).toBe('mixed');
        expect(sut.id).toBe(c1);
      });
    });
  });

  describe('Given hard mode and target oid', () => {
    describe('When reset', () => {
      it('Then result.mode=hard and HEAD branch updated', async () => {
        // Arrange
        const { ctx, c1 } = await seedTwoCommits();
        const sut = await reset(ctx, { mode: 'hard', target: c1 });
        // Assert
        expect(sut.mode).toBe('hard');
        expect(sut.id).toBe(c1);
      });
    });
  });

  describe('Given a hard reset to parent', () => {
    describe('When reset', () => {
      it('Then both index and working tree match parent tree', async () => {
        // Arrange — commit-2 adds b.txt. Hard-resetting to c1 must drop b.txt from
        // BOTH the working tree AND the index, while leaving a.txt at c1's content.
        const { ctx, c1 } = await seedTwoCommits();

        // Act
        const sut = await reset(ctx, { mode: 'hard', target: c1 });

        // Assert — index
        expect(sut.mode).toBe('hard');
        expect(sut.id).toBe(c1);
        const index = await readIndex(ctx);
        const paths = index.entries.filter((e) => e.flags.stage === 0).map((e) => e.path);
        expect(paths).toEqual(['a.txt']);

        // Assert — working tree
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(false);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('a');
      });
    });
  });

  describe('Given a hard reset over a locally-modified file', () => {
    describe('When reset', () => {
      it('Then the file is overwritten (force: true wired)', async () => {
        // Arrange — modify a.txt without staging, then hard-reset to current HEAD.
        // Without force=true, the dirty-tree guard would throw
        // CHECKOUT_OVERWRITE_DIRTY. Hard reset must always overwrite.
        const { ctx, c2 } = await seedTwoCommits();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'LOCALLY MODIFIED');

        // Act
        await reset(ctx, { mode: 'hard', target: c2 });

        // Assert — the file content reverts to the committed version.
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('a');
      });
    });
  });

  describe('Given a hard reset to current HEAD', () => {
    describe('When reset', () => {
      it('Then a clean tree is preserved (no spurious rewrites)', async () => {
        // Arrange
        const { ctx, c2 } = await seedTwoCommits();

        // Act
        await reset(ctx, { mode: 'hard', target: c2 });

        // Assert — both files still on disk with their committed content; index
        // still has both entries.
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('a');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/b.txt`)).toBe('b');
        const index = await readIndex(ctx);
        const paths = index.entries.filter((e) => e.flags.stage === 0).map((e) => e.path);
        expect(paths).toEqual(['a.txt', 'b.txt']);
      });
    });
  });

  describe('Given a corrupted index that makes readIndex throw mid-hard-reset', () => {
    describe('When reset', () => {
      it('Then the lock is released so a follow-up reset can succeed', async () => {
        // Arrange — seed two commits, then truncate `.git/index` so the next
        // readIndex throws. After the failing reset, the lock must be released.
        const { ctx, c1 } = await seedTwoCommits();
        const indexPath = `${ctx.layout.gitDir}/index`;
        await ctx.fs.write(indexPath, new Uint8Array([0x00, 0x00, 0x00, 0x00]));

        // Act — first reset must fail.
        let firstError: unknown;
        try {
          await reset(ctx, { mode: 'hard', target: c1 });
        } catch (err) {
          firstError = err;
        }
        expect(firstError).toBeDefined();

        // Repair the index so the follow-up read succeeds; the second reset must
        // NOT throw RESOURCE_LOCKED, proving the first attempt's lock was released.
        await ctx.fs.rm(indexPath);
        await reset(ctx, { mode: 'hard', target: c1 });

        // Assert
        const stillLocked = await ctx.fs.exists(`${indexPath}.lock`);
        expect(stillLocked).toBe(false);
      });
    });
  });

  describe('Given an index.lock already on disk', () => {
    describe('When hard reset', () => {
      it('Then throws RESOURCE_LOCKED before reading the index (lock-first ordering)', async () => {
        // Arrange — pre-acquire the index lock manually, simulating a concurrent
        // writer. If the lock acquire ever moves AFTER readIndex (regression
        // toward the pre-Phase-13.2 TOCTOU), this test would not see
        // RESOURCE_LOCKED — instead the corrupted-readIndex code path would surface.
        const { ctx, c1 } = await seedTwoCommits();
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        await ctx.fs.writeExclusive(lockPath, new Uint8Array());

        // Act
        let caught: unknown;
        try {
          await reset(ctx, { mode: 'hard', target: c1 });
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; resource?: string } })?.data;
        expect(data?.code).toBe('RESOURCE_LOCKED');
        expect(data?.resource).toBe('index');
      });
    });
  });

  describe('Given a hard reset target that resolves to a non-commit object', () => {
    describe('When reset', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE expected=commit', async () => {
        // Arrange — pass a blob oid as target.
        const { ctx } = await seedTwoCommits();
        const { writeObject } = await import(
          '../../../../src/application/primitives/write-object.js'
        );
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('not-a-commit'),
          id: '' as ObjectId,
        });

        // Act
        let caught: unknown;
        try {
          await reset(ctx, { mode: 'hard', target: blobId });
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; expected?: string } })?.data;
        expect(data?.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(data?.expected).toBe('commit');
      });
    });
  });

  describe('Given an unresolvable target', () => {
    describe('When reset', () => {
      it('Then throws REVPARSE_UNRESOLVED', async () => {
        // Arrange
        const { ctx } = await seedTwoCommits();
        let caught: unknown;
        try {
          await reset(ctx, { mode: 'soft', target: 'no-such-ref' });
        } catch (err) {
          caught = err;
        }
        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REVPARSE_UNRESOLVED');
      });
    });
  });

  describe('Given target as a branch name', () => {
    describe('When reset', () => {
      it('Then resolves via refs/heads/<name>', async () => {
        // Arrange
        const { ctx, c2 } = await seedTwoCommits();
        const sut = await reset(ctx, { mode: 'soft', target: 'main' });
        // Pin to the exact resolved oid so a mutation to the candidate list (e.g.
        // dropping the `refs/heads/${target}` prefix) is caught.
        // Assert
        expect(sut.id).toBe(c2);
      });
    });
  });

  describe('Given target as HEAD', () => {
    describe('When reset', () => {
      it('Then no-op (HEAD already points there)', async () => {
        // Arrange
        const { ctx, c2 } = await seedTwoCommits();
        const sut = await reset(ctx, { mode: 'soft', target: 'HEAD' });
        // Assert
        expect(sut.id).toBe(c2);
      });
    });
  });

  describe('Given a soft reset to parent', () => {
    describe('When reset', () => {
      it('Then index is NOT rebuilt (b.txt still staged)', async () => {
        // Arrange — soft mode must not call rebuildIndexFromCommit. After resetting
        // soft to c1, the index must still reflect the c2 state (a.txt + b.txt).
        const { ctx, c1 } = await seedTwoCommits();

        // Act
        await reset(ctx, { mode: 'soft', target: c1 });

        // Assert
        const index = await readIndex(ctx);
        const paths = index.entries.filter((e) => e.flags.stage === 0).map((e) => e.path);
        expect(paths).toEqual(['a.txt', 'b.txt']);
      });
    });
  });

  describe('Given a 41-hex target (boundary check on the oid regex)', () => {
    describe('When reset', () => {
      it('Then treated as a ref (REVPARSE_UNRESOLVED), not as an oid', async () => {
        // Arrange — 41 chars of `a` is hex but the wrong length. The /^[0-9a-f]{40}$/
        // anchors must reject it; a mutation that drops `^` or `$` would let a
        // 40-char substring match and route the string into the readObject path.
        const { ctx } = await seedTwoCommits();

        // Act
        let caught: unknown;
        try {
          await reset(ctx, { mode: 'soft', target: 'a'.repeat(41) });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REVPARSE_UNRESOLVED');
      });
    });
  });

  describe('Given a corrupted index that makes readIndex throw mid-reset', () => {
    describe('When reset', () => {
      it('Then the lock is released so a follow-up reset can succeed', async () => {
        // Arrange — seed two commits, then truncate `.git/index` to a header-only
        // stub so the NEXT readIndex throws. After the failing reset, the lock
        // file must be cleaned up by the `finally` block; otherwise the follow-up
        // acquire would surface as RESOURCE_LOCKED instead of recovering.
        const { ctx, c1 } = await seedTwoCommits();
        const indexPath = `${ctx.layout.gitDir}/index`;
        await ctx.fs.write(indexPath, new Uint8Array([0x00, 0x00, 0x00, 0x00])); // invalid header

        // Act — first reset must fail.
        let firstError: unknown;
        try {
          await reset(ctx, { mode: 'mixed', target: c1 });
        } catch (err) {
          firstError = err;
        }
        expect(firstError).toBeDefined();

        // Repair the index so the follow-up read succeeds, then re-attempt: the
        // follow-up reset must NOT throw RESOURCE_LOCKED — meaning the lock from
        // the first attempt was correctly released in the `finally`.
        await ctx.fs.rm(indexPath);
        await reset(ctx, { mode: 'mixed', target: c1 });

        // Assert — if we got here, the second reset succeeded; no stale lock.
        const stillLocked = await ctx.fs.exists(`${indexPath}.lock`);
        expect(stillLocked).toBe(false);
      });
    });
  });

  describe('Given a mixed reset target that resolves to a non-commit object', () => {
    describe('When reset', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE expected=commit', async () => {
        // Arrange — write a standalone blob and pass its oid as `target`. The mixed
        // path will resolve it to a non-commit object and must reject.
        const { ctx } = await seedTwoCommits();
        const { writeObject } = await import(
          '../../../../src/application/primitives/write-object.js'
        );
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('not-a-commit'),
          id: '' as ObjectId,
        });

        // Act
        let caught: unknown;
        try {
          await reset(ctx, { mode: 'mixed', target: blobId });
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; expected?: string } })?.data;
        expect(data?.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(data?.expected).toBe('commit');
      });
    });
  });

  describe('Given a mixed reset to parent', () => {
    describe('When reset', () => {
      it('Then index equals parent tree (later-commit entry dropped)', async () => {
        // Arrange — commit-2 adds b.txt; resetting --mixed to commit-1 must drop b.txt from the index.
        const { ctx, c1 } = await seedTwoCommits();

        // Act
        const sut = await reset(ctx, { mode: 'mixed', target: c1 });

        // Assert
        expect(sut.id).toBe(c1);
        const index = await readIndex(ctx);
        const paths = index.entries.filter((e) => e.flags.stage === 0).map((e) => e.path);
        expect(paths).toEqual(['a.txt']);
      });
      it('Then working tree is untouched', async () => {
        // Arrange
        const { ctx, c1 } = await seedTwoCommits();

        // Act
        await reset(ctx, { mode: 'mixed', target: c1 });

        // Assert — both files still present on disk; only the index changed.
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(true);
      });
    });
  });

  describe('Given a mixed reset to current HEAD', () => {
    describe('When reset', () => {
      it('Then stat-cache donor preserves mtime for unchanged paths', async () => {
        // Arrange — capture pre-reset stat fields for a.txt.
        const { ctx, c2 } = await seedTwoCommits();
        const before = await readIndex(ctx);
        const beforeA = before.entries.find((e) => e.path === 'a.txt');
        expect(beforeA?.mtimeSeconds).toBeGreaterThan(0); // sanity: add() recorded an mtime

        // Act
        await reset(ctx, { mode: 'mixed', target: c2 });

        // Assert — after reset to the same HEAD, donor entry's stat fields survive.
        const after = await readIndex(ctx);
        const afterA = after.entries.find((e) => e.path === 'a.txt');
        expect(afterA?.mtimeSeconds).toBe(beforeA?.mtimeSeconds);
        expect(afterA?.mtimeNanoseconds).toBe(beforeA?.mtimeNanoseconds);
        expect(afterA?.fileSize).toBe(beforeA?.fileSize);
        expect(afterA?.id).toBe(beforeA?.id);
      });
    });
  });

  describe('Given a mixed reset to parent', () => {
    describe('When reset', () => {
      it('Then changed path gets fresh zero stats', async () => {
        // Arrange — commit-2 modifies a.txt to new content (which changes its blob id).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'v1');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'v1', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'v2');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'v2', author });

        // Act — reset --mixed back to v1's commit; a.txt's blob id should revert,
        // and because the donor's id (v2) no longer matches the target tree's id (v1),
        // the donor is rejected and stat fields are zeroed.
        await reset(ctx, { mode: 'mixed', target: c1.id });

        // Assert
        const index = await readIndex(ctx);
        const entry = index.entries.find((e) => e.path === 'a.txt');
        expect(entry?.mtimeSeconds).toBe(0);
        expect(entry?.fileSize).toBe(0);
      });
    });
  });

  describe('Given a mixed reset on a bare repo', () => {
    describe('When reset', () => {
      it('Then does NOT throw BARE_REPOSITORY', async () => {
        // Arrange — fresh ctx with bare=true seeded BEFORE the first readConfig
        // call (readConfig is per-context cached; overwriting config after a read
        // wouldn't update the cache, so a fresh ctx is the only way to exercise
        // the bare-config branch).
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

        // Act — mixed reset must skip the assertNotBare guard. The resolve step
        // will fail later (no commits seeded), but the failure code must not be
        // BARE_REPOSITORY — that would prove the bare guard fired for mixed.
        let caught: unknown;
        try {
          await reset(ctx, { mode: 'mixed', target: 'HEAD' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).not.toBe('BARE_REPOSITORY');
      });
    });
  });

  describe('Given hard mode on a bare repo', () => {
    describe('When reset', () => {
      it('Then throws BARE_REPOSITORY with operation=reset --hard', async () => {
        // Arrange — fresh ctx with bare config seeded BEFORE any read.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

        // Act
        let caught: unknown;
        try {
          await reset(ctx, { mode: 'hard', target: 'HEAD' });
        } catch (err) {
          caught = err;
        }

        // Assert — pin both the code AND the operation string so a mutant that
        // empties the 'reset --hard' literal is killed.
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('BARE_REPOSITORY');
        expect(data?.operation).toBe('reset --hard');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When reset', () => {
      it('Then the HEAD file is rewritten to "<id>\\n" and branch is undefined', async () => {
        // Arrange — detach HEAD onto c2 by overwriting the HEAD file with a raw oid.
        const { ctx, c1, c2 } = await seedTwoCommits();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${c2}\n`);

        // Act
        const sut = await reset(ctx, { mode: 'soft', target: c1 });

        // Assert — the detached-HEAD branch writes `${gitDir}/HEAD` with `${id}\n`.
        // Killing L64 BlockStatement: a skipped write would leave HEAD at c2.
        // Killing L65 path literal: an empty path would leave HEAD at c2.
        // Killing L65 content literal: empty content would make headRaw === ''.
        expect(sut.branch).toBeUndefined();
        expect(sut.id).toBe(c1);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe(`${c1}\n`);
      });
    });
  });

  describe('Given a hard reset forward (written>0, deleted=0)', () => {
    describe('When reset', () => {
      it('Then the index commit runs and adds the new path', async () => {
        // Arrange — at c1 the working tree + index hold only a.txt. Resetting
        // forward to c2 writes b.txt (and re-writes a.txt via forceRewriteAll) so
        // written>0 while deleted=0. The lock.commit MUST run for b.txt to land in
        // the index. Kills the `result.written <= 0` mutant: that mutant turns the
        // guard into `false || false` → skip → index would stay ['a.txt'].
        const { ctx, c1, c2 } = await seedTwoCommits();
        await reset(ctx, { mode: 'hard', target: c1 });
        const mid = await readIndex(ctx);
        expect(mid.entries.filter((e) => e.flags.stage === 0).map((e) => e.path)).toEqual([
          'a.txt',
        ]);

        // Act
        await reset(ctx, { mode: 'hard', target: c2 });

        // Assert
        const index = await readIndex(ctx);
        const paths = index.entries.filter((e) => e.flags.stage === 0).map((e) => e.path);
        expect(paths).toEqual(['a.txt', 'b.txt']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(true);
      });
    });
  });

  describe('Given a hard reset to an empty-tree commit (written=0, deleted>0)', () => {
    describe('When reset', () => {
      it('Then the index commit runs and drops every path', async () => {
        // Arrange — c1 holds a.txt, cEmpty holds nothing. Resetting from c1 to
        // cEmpty deletes a.txt: deleted>0 while written=0. The lock.commit MUST run
        // for the index to empty. Kills `LogicalOperator -> &&` (false && true →
        // skip), `L125:31 ConditionalExpression -> false` (written>0 || false →
        // false → skip) and `deleted <= 0` (false || false → skip): every skip
        // would leave a.txt in the index.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'c1', author });
        await rm(ctx, ['a.txt'], {});
        const cEmpty = await commit(ctx, { message: 'empty', author });
        await reset(ctx, { mode: 'hard', target: c1.id });
        const mid = await readIndex(ctx);
        expect(mid.entries.filter((e) => e.flags.stage === 0).map((e) => e.path)).toEqual([
          'a.txt',
        ]);

        // Act
        await reset(ctx, { mode: 'hard', target: cEmpty.id });

        // Assert
        const index = await readIndex(ctx);
        expect(index.entries.filter((e) => e.flags.stage === 0)).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(false);
      });
    });
  });

  describe('Given a hard reset to an empty-tree commit on an empty repo (written=0, deleted=0)', () => {
    describe('When reset', () => {
      it('Then the index commit is skipped and no index file is written', async () => {
        // Arrange — a fresh repo with a single empty-tree commit. The hard reset
        // computes written=0 and deleted=0, so the genuine code skips lock.commit
        // and the index file is never created. Kills `ConditionalExpression ->
        // true`, `result.written >= 0` and `result.deleted >= 0`: each turns the
        // guard always-true → lock.commit([]) runs → an (empty) index file appears.
        const ctx = createMemoryContext();
        await init(ctx);
        const empty = await commit(ctx, { message: 'empty', author });

        // Act
        await reset(ctx, { mode: 'hard', target: empty.id });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index`)).toBe(false);
      });
    });
  });
});

describe('reset — sparse checkout', () => {
  // Sparse is flipped on AFTER the commit by writing `.git/info/sparse-checkout`
  // and the `core` config directly, so the index entries stay normal and the
  // reset itself must apply the matcher. Cone file: root files in, subdirs out,
  // `/src/` back in — so `src/*` is in-pattern and `docs/*` is excluded.
  const enableSparseSrcOnly = async (ctx: ReturnType<typeof createMemoryContext>) => {
    const { updateCoreConfig } = await import(
      '../../../../src/application/primitives/update-config.js'
    );
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

  describe('Given a sparse repo', () => {
    describe('When reset --mixed runs', () => {
      it('Then the rebuilt index marks excluded paths skip-worktree', async () => {
        // Arrange — sparse enabled after the commit; both entries are still normal.
        const { ctx, c1 } = await seedSrcAndDocs();
        await enableSparseSrcOnly(ctx);

        // Act
        const sut = await reset(ctx, { mode: 'mixed', target: c1 });

        // Assert — `docs/b.txt` is excluded, `src/a.txt` stays in-pattern.
        expect(sut.mode).toBe('mixed');
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'src/a.txt')?.flags.skipWorktree).toBe(false);
        expect(index.entries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a NON-sparse repo', () => {
    describe('When reset --mixed runs', () => {
      it('Then no index entry is skip-worktree (sparse threading is inert)', async () => {
        // Arrange — no sparse config: `loadSparseMatcher` returns undefined.
        const { ctx, c1 } = await seedSrcAndDocs();

        // Act
        await reset(ctx, { mode: 'mixed', target: c1 });

        // Assert
        const index = await readIndex(ctx);
        expect(index.entries.every((e) => e.flags.skipWorktree === false)).toBe(true);
      });
    });
  });

  describe('Given a sparse repo', () => {
    describe('When reset --hard runs', () => {
      it('Then excluded files are removed from disk and recorded skip-worktree', async () => {
        // Arrange — sparse enabled after the commit; `docs/b.txt` is on disk and a
        // normal index entry. The hard reset must drop it and flag it skip-worktree
        // while re-materialising the in-pattern `src/a.txt`.
        const { ctx, c1 } = await seedSrcAndDocs();
        await enableSparseSrcOnly(ctx);

        // Act
        const sut = await reset(ctx, { mode: 'hard', target: c1 });

        // Assert
        expect(sut.mode).toBe('hard');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'src/a.txt')?.flags.skipWorktree).toBe(false);
        expect(index.entries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a NON-sparse repo', () => {
    describe('When reset --hard runs', () => {
      it('Then every tracked file is materialised and no entry is skip-worktree', async () => {
        // Arrange — no sparse config: the materialize threading is inert.
        const { ctx, c1 } = await seedSrcAndDocs();

        // Act
        await reset(ctx, { mode: 'hard', target: c1 });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(true);
        const index = await readIndex(ctx);
        expect(index.entries.every((e) => e.flags.skipWorktree === false)).toBe(true);
      });
    });
  });

  describe('Given a sparse repo whose reset --hard target tree is entirely excluded', () => {
    describe('When reset --hard runs', () => {
      it('Then the index is still committed with the new excluded id', async () => {
        // Arrange — two commits differing only in an excluded (`docs/`) file. The
        // first sparse hard-reset leaves `docs/x.txt` as a skip-worktree index
        // entry; the SECOND hard-reset then writes/deletes nothing
        // (written=deleted=0) yet must still commit the index so the excluded
        // path's id advances to the new target — kills a mutant dropping the
        // `|| matcher !== undefined` clause of the commit guard.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/x.txt`, 'v1');
        await add(ctx, ['docs/x.txt']);
        const c1 = await commit(ctx, { message: 'v1', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/x.txt`, 'v2');
        await add(ctx, ['docs/x.txt']);
        const c2 = await commit(ctx, { message: 'v2', author });
        await enableSparseSrcOnly(ctx);
        await reset(ctx, { mode: 'hard', target: c1.id });
        const idBefore = (await readIndex(ctx)).entries.find((e) => e.path === 'docs/x.txt')?.id;

        // Act — c2's tree is entirely out-of-pattern; nothing is written or deleted.
        await reset(ctx, { mode: 'hard', target: c2.id });

        // Assert — the index advanced to c2's blob id for the excluded path.
        const entry = (await readIndex(ctx)).entries.find((e) => e.path === 'docs/x.txt');
        expect(entry?.flags.skipWorktree).toBe(true);
        expect(entry?.id).toBeDefined();
        expect(entry?.id).not.toBe(idBefore);
      });
    });
  });
});
