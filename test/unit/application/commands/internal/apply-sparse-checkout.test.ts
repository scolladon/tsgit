import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { applySparseCheckout } from '../../../../../src/application/commands/internal/apply-sparse-checkout.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import {
  type GitIndex,
  type IndexEntry,
  STAGE0_FLAGS,
  serializeIndex,
} from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { SparseMatcher } from '../../../../../src/domain/sparse/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Write a blob object; its loose-object id is the entry id we seed. */
const writeBlob = async (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content: encoder.encode(content), id: '' as ObjectId });

/** A stage-0 index entry with a deterministic stat snapshot. */
const makeEntry = (path: string, id: ObjectId): IndexEntry => ({
  ctimeSeconds: 1,
  ctimeNanoseconds: 0,
  mtimeSeconds: 1,
  mtimeNanoseconds: 0,
  dev: 1,
  ino: 1,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

/** Seed `.git/index` with a SHA-1-trailer so `readIndex` accepts it. */
const seedIndex = async (ctx: Context, entries: ReadonlyArray<IndexEntry>): Promise<void> => {
  const index: GitIndex = { version: 2, entries: [...entries], extensions: [] };
  const body = serializeIndex(index);
  const checksum = await ctx.hash.hash(body);
  const bytes = new Uint8Array(body.length + checksum.length);
  bytes.set(body, 0);
  bytes.set(checksum, body.length);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, bytes);
};

/** Write a working-tree file at `path` under the repo root. */
const seedWorkFile = async (ctx: Context, path: string, content: string): Promise<void> => {
  await ctx.fs.write(`${ctx.layout.workDir}/${path}`, encoder.encode(content));
};

/** Re-read the committed index and project entries by path. */
const readBackIndex = async (ctx: Context): Promise<Map<FilePath, IndexEntry>> => {
  const index = await readIndex(ctx);
  const byPath = new Map<FilePath, IndexEntry>();
  for (const entry of index.entries) byPath.set(entry.path, entry);
  return byPath;
};

/** Matcher selecting everything directly under `src/`. */
const srcOnly: SparseMatcher = (path) => path.startsWith('src/');

describe('commands/internal/apply-sparse-checkout', () => {
  describe('Given an excluded clean file', () => {
    describe('When applySparseCheckout narrows', () => {
      it('Then the file is removed and skip-worktree is set', async () => {
        // Arrange — `src/a` stays, `docs/b` is excluded and clean.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const docId = await writeBlob(ctx, 'bbb');
        await seedIndex(ctx, [makeEntry('src/a', srcId), makeEntry('docs/b', docId)]);
        await seedWorkFile(ctx, 'src/a', 'aaa');
        await seedWorkFile(ctx, 'docs/b', 'bbb');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — docs/b deleted, its index entry skip-worktree; src/a kept.
        expect(sut).toEqual({ materialized: 0, removed: 1, retained: [] });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a`)).toBe(true);
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('docs/b' as FilePath)?.flags.skipWorktree).toBe(true);
        expect(byPath.get('src/a' as FilePath)?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given an included entry whose file is absent', () => {
    describe('When applySparseCheckout widens', () => {
      it('Then the file is written and skip-worktree is cleared', async () => {
        // Arrange — `src/a` was previously skip-worktree (absent on disk).
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const skipped: IndexEntry = {
          ...makeEntry('src/a', srcId),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [skipped]);

        // Act — the matcher now includes src/a.
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — file materialised, bit cleared.
        expect(sut).toEqual({ materialized: 1, removed: 0, retained: [] });
        const written = await ctx.fs.read(`${ctx.layout.workDir}/src/a`);
        expect(decoder.decode(written)).toBe('aaa');
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('src/a' as FilePath)?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given an excluded file with uncommitted edits and no force', () => {
    describe('When applySparseCheckout', () => {
      it('Then the file is retained', async () => {
        // Arrange — `docs/b` on disk differs from its indexed blob.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const docId = await writeBlob(ctx, 'bbb');
        await seedIndex(ctx, [makeEntry('src/a', srcId), makeEntry('docs/b', docId)]);
        await seedWorkFile(ctx, 'src/a', 'aaa');
        await seedWorkFile(ctx, 'docs/b', 'LOCALLY EDITED');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — dirty excludee left on disk, surfaced in `retained`, no skip bit.
        expect(sut.removed).toBe(0);
        expect(sut.retained).toEqual(['docs/b']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b`)).toBe(true);
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('docs/b' as FilePath)?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given an excluded file with uncommitted edits and force', () => {
    describe('When applySparseCheckout', () => {
      it('Then the file is removed', async () => {
        // Arrange — same dirty excludee, but `force` overrides the retain policy.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const docId = await writeBlob(ctx, 'bbb');
        await seedIndex(ctx, [makeEntry('src/a', srcId), makeEntry('docs/b', docId)]);
        await seedWorkFile(ctx, 'src/a', 'aaa');
        await seedWorkFile(ctx, 'docs/b', 'LOCALLY EDITED');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly, force: true });

        // Assert — dirty file forcibly removed, skip-worktree set, nothing retained.
        expect(sut).toEqual({ materialized: 0, removed: 1, retained: [] });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b`)).toBe(false);
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('docs/b' as FilePath)?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a matcher of undefined', () => {
    describe('When applySparseCheckout', () => {
      it('Then every absent file is re-materialised and every skip bit cleared', async () => {
        // Arrange — `docs/b` was skip-worktree (absent); `src/a` already present.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const docId = await writeBlob(ctx, 'bbb');
        const skippedDoc: IndexEntry = {
          ...makeEntry('docs/b', docId),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [makeEntry('src/a', srcId), skippedDoc]);
        await seedWorkFile(ctx, 'src/a', 'aaa');

        // Act — `disable` path: include everything.
        const sut = await applySparseCheckout(ctx, { matcher: undefined });

        // Assert — docs/b re-materialised, every skip-worktree bit cleared.
        expect(sut).toEqual({ materialized: 1, removed: 0, retained: [] });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b`)).toBe(true);
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('docs/b' as FilePath)?.flags.skipWorktree).toBe(false);
        expect(byPath.get('src/a' as FilePath)?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a mix of widen, narrow and noop entries', () => {
    describe('When applySparseCheckout', () => {
      it('Then materialized and removed counts are exact', async () => {
        // Arrange — src/a present+included (noop), src/c absent+included (add),
        // docs/b present+excluded (delete).
        const ctx = createMemoryContext();
        const aId = await writeBlob(ctx, 'aaa');
        const bId = await writeBlob(ctx, 'bbb');
        const cId = await writeBlob(ctx, 'ccc');
        await seedIndex(ctx, [
          makeEntry('src/a', aId),
          makeEntry('docs/b', bId),
          makeEntry('src/c', cId),
        ]);
        await seedWorkFile(ctx, 'src/a', 'aaa');
        await seedWorkFile(ctx, 'docs/b', 'bbb');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — exactly one add, one delete, no retain.
        expect(sut).toEqual({ materialized: 1, removed: 1, retained: [] });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/c`)).toBe(true);
      });
    });
  });

  describe('Given an excluded entry whose file is already absent', () => {
    describe('When applySparseCheckout narrows', () => {
      it('Then it is a noop and the bit is set', async () => {
        // Arrange — `docs/b` excluded but never on disk → no delete, just the bit.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const docId = await writeBlob(ctx, 'bbb');
        await seedIndex(ctx, [makeEntry('src/a', srcId), makeEntry('docs/b', docId)]);
        await seedWorkFile(ctx, 'src/a', 'aaa');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — nothing removed, but the skip-worktree bit is still applied.
        expect(sut).toEqual({ materialized: 0, removed: 0, retained: [] });
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('docs/b' as FilePath)?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a non-stage-0 entry', () => {
    describe('When applySparseCheckout', () => {
      it('Then it is ignored and absent from the new index', async () => {
        // Arrange — a stage-2 conflict entry is invisible to the apply.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const conflictId = await writeBlob(ctx, 'conflict');
        const conflict: IndexEntry = {
          ...makeEntry('src/x', conflictId),
          flags: { ...STAGE0_FLAGS, stage: 2 },
        };
        await seedIndex(ctx, [makeEntry('src/a', srcId), conflict]);
        await seedWorkFile(ctx, 'src/a', 'aaa');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — only the stage-0 entry survives the rewrite.
        expect(sut.materialized).toBe(0);
        const byPath = await readBackIndex(ctx);
        expect(byPath.has('src/x' as FilePath)).toBe(false);
        expect(byPath.has('src/a' as FilePath)).toBe(true);
      });
    });
  });

  describe('Given the index lock is already held', () => {
    describe('When applySparseCheckout', () => {
      it('Then it throws RESOURCE_LOCKED', async () => {
        // Arrange — a pre-existing lock file blocks acquisition.
        const ctx = createMemoryContext();
        await seedIndex(ctx, []);
        await ctx.fs.writeExclusive(`${ctx.layout.gitDir}/index.lock`, new Uint8Array());

        // Act
        let caught: unknown;
        try {
          await applySparseCheckout(ctx, { matcher: srcOnly });
        } catch (err) {
          caught = err;
        }

        // Assert — a contended lock surfaces as RESOURCE_LOCKED.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('RESOURCE_LOCKED');
      });
    });
  });

  describe('Given a widened entry', () => {
    describe('When applySparseCheckout', () => {
      it('Then its committed index entry carries the post-write stat', async () => {
        // Arrange — a written entry must take applyChangeset's fresh record, not
        // the stale seeded one.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const skipped: IndexEntry = {
          ...makeEntry('src/a', srcId),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [skipped]);

        // Act
        await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — fileSize reflects the 3-byte blob written to disk.
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('src/a' as FilePath)?.fileSize).toBe(3);
      });
    });
  });

  describe('Given an included entry that is skip-worktree but already on disk', () => {
    describe('When applySparseCheckout', () => {
      it('Then it is a noop that clears the bit', async () => {
        // Arrange — `src/a` is included AND present on disk, yet its index entry
        // still carries a stale skip-worktree bit. It is a noop (not re-written),
        // so it flows through the prior-record path which must clear the bit.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const staleSkip: IndexEntry = {
          ...makeEntry('src/a', srcId),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [staleSkip]);
        await seedWorkFile(ctx, 'src/a', 'aaa');

        // Act — nothing is written (the file already matches).
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — no materialisation, but the stale bit is cleared.
        expect(sut).toEqual({ materialized: 0, removed: 0, retained: [] });
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('src/a' as FilePath)?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a retained skip-worktree entry whose dirty file was re-created', () => {
    describe('When applySparseCheckout', () => {
      it('Then it is retained AND skip-worktree is cleared', async () => {
        // Arrange — `docs/b` came in as skip-worktree (an excluded file). The user
        // manually re-created it with dirty content. The matcher still excludes it
        // and there is no `force`, so it must be retained — and because the file
        // IS present on disk, its skip-worktree bit must be cleared so `status`
        // sees the now-present dirty file.
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const docId = await writeBlob(ctx, 'bbb');
        const skippedDoc: IndexEntry = {
          ...makeEntry('docs/b', docId),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [makeEntry('src/a', srcId), skippedDoc]);
        await seedWorkFile(ctx, 'src/a', 'aaa');
        await seedWorkFile(ctx, 'docs/b', 'MANUALLY RE-CREATED DIRTY');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — retained, file left on disk, skip-worktree cleared.
        expect(sut.retained).toEqual(['docs/b']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b`)).toBe(true);
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('docs/b' as FilePath)?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a workdir path that ends with a slash', () => {
    describe('When applySparseCheckout', () => {
      it('Then working-tree paths still resolve', async () => {
        // Arrange — a trailing-slash workDir exercises the `joinPath` slash branch.
        const base = createMemoryContext();
        const ctx: Context = {
          ...base,
          layout: { ...base.layout, workDir: `${base.layout.workDir}/` },
        };
        const srcId = await writeBlob(ctx, 'aaa');
        const docId = await writeBlob(ctx, 'bbb');
        await seedIndex(ctx, [makeEntry('src/a', srcId), makeEntry('docs/b', docId)]);
        await seedWorkFile(base, 'src/a', 'aaa');
        await seedWorkFile(base, 'docs/b', 'bbb');

        // Act
        const sut = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — the excluded file is found and removed despite the slash.
        expect(sut).toEqual({ materialized: 0, removed: 1, retained: [] });
        expect(await base.fs.exists(`${base.layout.workDir}/docs/b`)).toBe(false);
      });
    });
  });

  describe('Given a changeset with add/delete entries', () => {
    describe('When applySparseCheckout', () => {
      it('Then the progress total equals the non-noop entry count', async () => {
        // Arrange — one add, one delete; the changeset stats feed the progress
        // `total`. A mutated `stats[kind] += 1 → -= 1` would shift that total.
        const base = createMemoryContext();
        const update = vi.fn();
        const ctx: Context = {
          ...base,
          progress: { start: vi.fn(), update, end: vi.fn() },
        };
        const aId = await writeBlob(ctx, 'aaa');
        const bId = await writeBlob(ctx, 'bbb');
        const cId = await writeBlob(ctx, 'ccc');
        await seedIndex(ctx, [
          makeEntry('src/a', aId),
          makeEntry('docs/b', bId),
          makeEntry('src/c', cId),
        ]);
        await seedWorkFile(ctx, 'src/a', 'aaa');
        await seedWorkFile(ctx, 'docs/b', 'bbb');

        // Act
        await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — every progress tick reports total = 2 (one add + one delete).
        expect(update).toHaveBeenCalled();
        for (const call of update.mock.calls) {
          expect(call[2]).toBe(2);
        }
      });
    });
  });

  describe('Given applyChangeset throws mid-apply', () => {
    describe('When applySparseCheckout', () => {
      it('Then the index lock is released', async () => {
        // Arrange — a failing object read makes the `add` step throw; the `finally`
        // block must still release the lock so the repo is not left wedged.
        const ctx = createMemoryContext();
        const skipped: IndexEntry = {
          ...makeEntry('src/a', 'f'.repeat(40) as ObjectId),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [skipped]);

        // Act — the matcher includes src/a, so applyChangeset tries to read a
        // blob that does not exist and throws.
        let caught: unknown;
        try {
          await applySparseCheckout(ctx, { matcher: srcOnly });
        } catch (err) {
          caught = err;
        }

        // Assert — it threw a TsgitError, and the lock file was cleaned up by `finally`.
        expect(caught).toBeInstanceOf(TsgitError);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });
});
