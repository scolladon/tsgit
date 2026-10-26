import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { applySparseCheckout } from '../../../../../src/application/commands/internal/apply-sparse-checkout.js';
import * as gitattributesMod from '../../../../../src/application/primitives/internal/read-gitattributes.js';
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
import {
  buildSparseMatcher,
  parseSparseCheckout,
  type SparseMatcher,
} from '../../../../../src/domain/sparse/index.js';
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
  const index: GitIndex = {
    version: 2,
    entries: [...entries],
    extensions: [],
    trailerSha: new Uint8Array(0),
  };
  const body = serializeIndex(index, ctx.hashConfig.digestLength);
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — docs/b deleted, its index entry skip-worktree; src/a kept.
        expect(result).toEqual({ materialized: 0, removed: 1, retained: [] });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a`)).toBe(true);
        const byPath = await readBackIndex(ctx);
        expect(byPath.get('docs/b' as FilePath)?.flags.skipWorktree).toBe(true);
        expect(byPath.get('src/a' as FilePath)?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe.each([
    ['dangling', 'nowhere'],
    ['live', 'src/a'],
  ])('Given an excluded tracked %s symlink', (_shape, target) => {
    describe('When applySparseCheckout narrows', () => {
      it('Then the link is removed and skip-worktree is set', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const srcId = await writeBlob(ctx, 'aaa');
        const linkId = await writeBlob(ctx, target);
        const link: IndexEntry = { ...makeEntry('l', linkId), mode: FILE_MODE.SYMLINK };
        await seedIndex(ctx, [makeEntry('src/a', srcId), link]);
        await seedWorkFile(ctx, 'src/a', 'aaa');
        await ctx.fs.symlink(target, `${ctx.layout.workDir}/l`);

        // Act
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert
        expect(result).toEqual({ materialized: 0, removed: 1, retained: [] });
        expect(
          await ctx.fs.lstat(`${ctx.layout.workDir}/l`).catch(() => undefined),
        ).toBeUndefined();
        expect((await readBackIndex(ctx)).get('l' as FilePath)?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given several excluded clean files', () => {
    describe('When applySparseCheckout narrows', () => {
      it('Then the attribute provider is built as often as for a single excluded file', async () => {
        // Arrange
        const seedExcluded = async (excluded: number): Promise<Context> => {
          const ctx = createMemoryContext();
          const id = await writeBlob(ctx, 'bbb');
          const names = Array.from({ length: excluded }, (_, i) => `docs/${i}`);
          await seedIndex(
            ctx,
            names.map((name) => makeEntry(name, id)),
          );
          for (const name of names) await seedWorkFile(ctx, name, 'bbb');
          return ctx;
        };
        const sut = applySparseCheckout;
        const spy = vi.spyOn(gitattributesMod, 'buildCheckinAttributeProvider');
        await sut(await seedExcluded(1), { matcher: srcOnly });
        const single = spy.mock.calls.length;
        spy.mockClear();

        // Act
        await sut(await seedExcluded(4), { matcher: srcOnly });

        // Assert
        expect(spy.mock.calls.length).toBe(single);
        spy.mockRestore();
      });
    });
  });

  describe('Given a lossy path excluded by the new patterns', () => {
    describe('When applySparseCheckout narrows', () => {
      it('Then its skip-worktree entry keeps the raw path bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await writeBlob(ctx, 'bbb');
        const bytes = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
        const lossy: IndexEntry = { ...makeEntry('\uFFFD.txt', id), pathBytes: bytes };
        await seedIndex(ctx, [lossy]);
        const sut = applySparseCheckout;

        // Act
        await sut(ctx, { matcher: srcOnly });

        // Assert
        const entry = (await readIndex(ctx)).entries[0];
        expect(entry?.flags.skipWorktree).toBe(true);
        expect(entry?.pathBytes).toEqual(bytes);
      });

      it('Then it counts no removal, its file never being on disk', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await writeBlob(ctx, 'bbb');
        const bytes = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
        const lossy: IndexEntry = { ...makeEntry('�.txt', id), pathBytes: bytes };
        await seedIndex(ctx, [lossy]);
        const sut = applySparseCheckout;

        // Act
        const result = await sut(ctx, { matcher: srcOnly });

        // Assert
        expect(result.removed).toBe(0);
      });
    });
  });

  describe('Given a lossy path and a UTF-8 path with the same view, both excluded then included', () => {
    const view = '�.txt';
    const lossyBytes = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
    const seedTwins = async (ctx: Context): Promise<{ utf8Id: ObjectId; lossyId: ObjectId }> => {
      const lossyId = await writeBlob(ctx, 'lossy');
      const utf8Id = await writeBlob(ctx, 'utf8');
      const lossy: IndexEntry = { ...makeEntry(view, lossyId), pathBytes: lossyBytes };
      await seedIndex(ctx, [makeEntry(view, utf8Id), lossy]);
      return { utf8Id, lossyId };
    };

    describe('When the working tree narrows then widens through the real apply route', () => {
      it('Then the UTF-8 entry keeps its blob and the lossy one keeps its bytes and blob', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { utf8Id, lossyId } = await seedTwins(ctx);
        await seedWorkFile(ctx, view, 'utf8');
        const sut = applySparseCheckout;
        await sut(ctx, { matcher: srcOnly });

        // Act
        await sut(ctx, { matcher: undefined });

        // Assert
        const entries = (await readIndex(ctx)).entries;
        const lossyBack = entries.find((e) => e.pathBytes !== undefined);
        const utf8Back = entries.find((e) => e.pathBytes === undefined);
        expect(utf8Back?.id).toBe(utf8Id);
        expect(lossyBack?.id).toBe(lossyId);
        expect(lossyBack?.pathBytes).toEqual(lossyBytes);
        expect(decoder.decode(await ctx.fs.read(`${ctx.layout.workDir}/${view}`))).toBe('utf8');
      });
    });

    describe('When the file of the UTF-8 twin is on disk and both are excluded', () => {
      it('Then only the dirty UTF-8 twin is retained and the lossy entry is skip-worktree without a probe', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedTwins(ctx);
        await seedWorkFile(ctx, view, 'other');
        const exists = vi.spyOn(ctx.fs, 'lstatIfReachable');
        const sut = applySparseCheckout;

        // Act
        const result = await sut(ctx, { matcher: srcOnly });

        // Assert
        const probes = exists.mock.calls.filter(([p]) => String(p).endsWith(view));
        expect(probes).toHaveLength(1);
        expect(result.retained).toEqual([view]);
        const lossyBack = (await readIndex(ctx)).entries.find((e) => e.pathBytes !== undefined);
        expect(lossyBack?.flags.skipWorktree).toBe(true);
      });
    });

    describe('When the lossy entry is included and the UTF-8 twin name is on disk or absent', () => {
      it.each([
        { twin: 'absent', present: false },
        { twin: 'present', present: true },
      ])(
        'Then the outcome and the probes are the same with the twin $twin',
        async ({ present }) => {
          // Arrange
          const ctx = createMemoryContext();
          const lossyId = await writeBlob(ctx, 'lossy');
          const lossy: IndexEntry = { ...makeEntry(view, lossyId), pathBytes: lossyBytes };
          await seedIndex(ctx, [lossy]);
          if (present) await seedWorkFile(ctx, view, 'untracked');
          const exists = vi.spyOn(ctx.fs, 'lstatIfReachable');
          const sut = applySparseCheckout;

          // Act
          const result = await sut(ctx, { matcher: undefined });

          // Assert
          expect(exists.mock.calls.filter(([p]) => String(p).endsWith(view))).toHaveLength(0);
          expect(result.materialized).toBe(1);
          const back = (await readIndex(ctx)).entries[0];
          expect(back?.pathBytes).toEqual(lossyBytes);
          expect(back?.id).toBe(lossyId);
        },
      );
    });

    describe('When a literal pattern names the U+FFFD view', () => {
      it('Then the UTF-8 entry is included and the lossy one excluded', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedTwins(ctx);
        const matcher = buildSparseMatcher(parseSparseCheckout(view, false).spec);
        const sut = applySparseCheckout;

        // Act
        await sut(ctx, { matcher });

        // Assert
        const entries = (await readIndex(ctx)).entries;
        expect(entries.find((e) => e.pathBytes === undefined)?.flags.skipWorktree).toBe(false);
        expect(entries.find((e) => e.pathBytes !== undefined)?.flags.skipWorktree).toBe(true);
      });
    });

    describe('When a glob pattern matches every txt file', () => {
      it('Then both entries are included', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedTwins(ctx);
        const matcher = buildSparseMatcher(parseSparseCheckout('*.txt', false).spec);
        const sut = applySparseCheckout;

        // Act
        await sut(ctx, { matcher });

        // Assert
        const entries = (await readIndex(ctx)).entries;
        expect(entries.map((e) => e.flags.skipWorktree)).toEqual([false, false]);
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — file materialised, bit cleared.
        expect(result).toEqual({ materialized: 1, removed: 0, retained: [] });
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — dirty excludee left on disk, surfaced in `retained`, no skip bit.
        expect(result.removed).toBe(0);
        expect(result.retained).toEqual(['docs/b']);
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly, force: true });

        // Assert — dirty file forcibly removed, skip-worktree set, nothing retained.
        expect(result).toEqual({ materialized: 0, removed: 1, retained: [] });
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
        const result = await applySparseCheckout(ctx, { matcher: undefined });

        // Assert — docs/b re-materialised, every skip-worktree bit cleared.
        expect(result).toEqual({ materialized: 1, removed: 0, retained: [] });
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — exactly one add, one delete, no retain.
        expect(result).toEqual({ materialized: 1, removed: 1, retained: [] });
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — nothing removed, but the skip-worktree bit is still applied.
        expect(result).toEqual({ materialized: 0, removed: 0, retained: [] });
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — only the stage-0 entry survives the rewrite.
        expect(result.materialized).toBe(0);
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — no materialisation, but the stale bit is cleared.
        expect(result).toEqual({ materialized: 0, removed: 0, retained: [] });
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — retained, file left on disk, skip-worktree cleared.
        expect(result.retained).toEqual(['docs/b']);
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
        const result = await applySparseCheckout(ctx, { matcher: srcOnly });

        // Assert — the excluded file is found and removed despite the slash.
        expect(result).toEqual({ materialized: 0, removed: 1, retained: [] });
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

  describe("Given index '*.txt eol=crlf' and work tree '*.txt eol=lf'", () => {
    describe('When a path enters the cone', () => {
      it('Then it is written CRLF', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const rules = await writeBlob(ctx, '*.txt eol=crlf\n');
        const fileId = await writeBlob(ctx, 'a\nb\n');
        const skipped: IndexEntry = {
          ...makeEntry('src/a.txt', fileId),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [makeEntry('.gitattributes', rules), skipped]);
        await seedWorkFile(ctx, '.gitattributes', '*.txt eol=lf\n');
        const matcher: SparseMatcher = (path) => path === '.gitattributes' || srcOnly(path);
        const sut = applySparseCheckout;

        // Act
        await sut(ctx, { matcher });

        // Assert
        const written = await ctx.fs.read(`${ctx.layout.workDir}/src/a.txt`);
        expect(decoder.decode(written)).toBe('a\r\nb\r\n');
      });
    });
  });

  describe('Given a regular file where a re-included entry leading directory is due', () => {
    describe('When applySparseCheckout includes the entry', () => {
      it('Then nothing is written, the file is kept, skip-worktree is cleared and one warning names the file', async () => {
        // Arrange
        const base = createMemoryContext();
        const warnings: string[] = [];
        const ctx = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
        const id = await writeBlob(ctx, 'xxx');
        const skipped: IndexEntry = {
          ...makeEntry('d/x', id),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [skipped]);
        await seedWorkFile(ctx, 'd', 'occupant');
        const sut = applySparseCheckout;

        // Act
        const result = await sut(ctx, { matcher: undefined });

        // Assert
        expect(result).toEqual({ materialized: 0, removed: 0, retained: [] });
        expect(decoder.decode(await ctx.fs.read(`${ctx.layout.workDir}/d`))).toBe('occupant');
        expect((await readBackIndex(ctx)).get('d/x' as FilePath)?.flags.skipWorktree).toBe(false);
        expect(warnings).toEqual([
          'The following paths were already present and thus not updated despite sparse patterns:\n\td\n\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.',
        ]);
      });
    });
  });

  describe('Given a dangling symlink at a re-included path', () => {
    describe('When applySparseCheckout includes the entry', () => {
      it('Then the link is kept and nothing is warned', async () => {
        // Arrange
        const base = createMemoryContext();
        const warnings: string[] = [];
        const ctx = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
        const id = await writeBlob(ctx, 'xxx');
        const skipped: IndexEntry = {
          ...makeEntry('f', id),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await seedIndex(ctx, [skipped]);
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/f`);
        const sut = applySparseCheckout;

        // Act
        const result = await sut(ctx, { matcher: undefined });

        // Assert
        expect(result.materialized).toBe(0);
        expect(await ctx.fs.readlink(`${ctx.layout.workDir}/f`)).toBe('nowhere');
        expect(warnings).toEqual([]);
      });
    });
  });

  describe('Given two re-included entries under one file', () => {
    describe('When applySparseCheckout includes them', () => {
      it('Then one warning lists the file once per entry', async () => {
        // Arrange
        const base = createMemoryContext();
        const warnings: string[] = [];
        const ctx = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
        const id = await writeBlob(ctx, 'xxx');
        const skip = (path: string): IndexEntry => ({
          ...makeEntry(path, id),
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        });
        await seedIndex(ctx, [skip('d/x'), skip('d/y')]);
        await seedWorkFile(ctx, 'd', 'occupant');
        const sut = applySparseCheckout;

        // Act
        await sut(ctx, { matcher: undefined });

        // Assert
        expect(warnings).toEqual([
          'The following paths were already present and thus not updated despite sparse patterns:\n\td\n\td\n\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.',
        ]);
      });
    });
  });
});
