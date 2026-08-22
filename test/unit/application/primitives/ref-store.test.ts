import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  assertRenamableTrackingRef,
  createRefStore,
  getRefStore,
} from '../../../../src/application/primitives/ref-store.js';
import { appendReflog, readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry } from '../../../../src/ports/file-system.js';
import {
  buildRefBlock,
  buildReftable,
  buildReftableHeader,
} from '../../../fixtures/refs/reftable-writers.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';
import { commonReftableDir, withReftableStorage, writeReftableFiles } from './reftable-fixtures.js';

/** A single-record ref-block table naming `refName -> id`. */
function buildSingleRefTable(refName: string, id: Uint8Array): Uint8Array {
  const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: [{ name: refName, value: { kind: 'direct', id } }],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header.length,
  });
  return buildReftable({ ...headerSpec, blocks: [block] });
}

const IDENTITY: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1716240000,
  timezoneOffset: '+0000',
};

const reflogEntry = (overrides: Partial<ReflogEntry> = {}): ReflogEntry => ({
  oldId: 'a'.repeat(40) as ObjectId,
  newId: 'b'.repeat(40) as ObjectId,
  identity: IDENTITY,
  message: 'commit: seed',
  ...overrides,
});

describe('ref-store', () => {
  describe('Given refs that resolve to a direct id', () => {
    describe('When resolveDirect', () => {
      it.each([
        {
          label: 'returns the direct id of a loose ref',
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [],
          name: 'refs/heads/main' as RefName,
          expected: 'a'.repeat(40),
        },
        {
          label: 'returns the direct id of a packed-only ref',
          refs: [],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
          name: 'refs/tags/v1' as RefName,
          expected: 'b'.repeat(40),
        },
        {
          label: 'returns the loose id when both a loose and packed ref exist (loose wins)',
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: 'c'.repeat(40) as ObjectId }],
          name: 'refs/heads/main' as RefName,
          expected: 'a'.repeat(40),
        },
      ])('Then $label', async ({ refs, packedRefs, name, expected }) => {
        // Arrange
        const ctx = await buildSeededContext({ refs, packedRefs });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(name);

        // Assert
        expect(result.kind).toBe('direct');
        if (result.kind === 'direct') {
          expect(result.id).toBe(expected);
        }
      });
    });
  });

  describe('Given a missing ref', () => {
    describe('When resolveDirect', () => {
      it('Then returns missing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/nope' as RefName);

        // Assert
        expect(result.kind).toBe('missing');
      });
    });
  });

  describe('Given a loose ref that exists', () => {
    describe('When resolveDirect reads it', () => {
      it('Then the loose content is read without a separate existence probe', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.resolveDirect('refs/heads/main' as RefName);

        // Assert — one `readUtf8` and no `exists` probe on the loose path.
        const loosePath = `${ctx.layout.gitDir}/refs/heads/main`;
        expect(calls().filter((c) => c.path === loosePath)).toEqual([
          { method: 'readUtf8', path: loosePath },
        ]);
      });
    });
  });

  describe('Given a symbolic loose ref', () => {
    describe('When resolveDirect', () => {
      it('Then returns symbolic target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result.kind).toBe('symbolic');
        if (result.kind === 'symbolic') expect(result.target).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a set update', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then resolveDirect returns the written id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'set', name: 'refs/heads/new' as RefName, id: 'd'.repeat(40) as ObjectId },
        ]);
        const result = await sut.resolveDirect('refs/heads/new' as RefName);

        // Assert
        expect(result.kind).toBe('direct');
        if (result.kind === 'direct') expect(result.id).toBe('d'.repeat(40));
      });
    });
  });

  describe('Given a delete update on a shadowing loose ref', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then resolveDirect falls through to packed', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: 'c'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/main' as RefName }]);
        const result = await sut.resolveDirect('refs/heads/main' as RefName);

        // Assert
        expect(result.kind).toBe('direct');
        if (result.kind === 'direct') expect(result.id).toBe('c'.repeat(40));
      });
    });
  });

  describe('Given two updates in one list', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then both refs are written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);
        const idA = 'a'.repeat(40) as ObjectId;
        const idB = 'b'.repeat(40) as ObjectId;

        // Act
        await sut.applyRefUpdates([
          { kind: 'set', name: 'refs/heads/one' as RefName, id: idA },
          { kind: 'set', name: 'refs/heads/two' as RefName, id: idB },
        ]);
        const one = await sut.resolveDirect('refs/heads/one' as RefName);
        const two = await sut.resolveDirect('refs/heads/two' as RefName);

        // Assert
        expect(one).toEqual({ kind: 'direct', id: idA });
        expect(two).toEqual({ kind: 'direct', id: idB });
      });
    });
  });

  describe('Given a list whose second update carries a mismatched expected', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then it throws REF_UPDATE_CONFLICT with name, expected and actual populated', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([
            { kind: 'set', name: 'refs/heads/one' as RefName, id: 'b'.repeat(40) as ObjectId },
            {
              kind: 'set',
              name: 'refs/heads/main' as RefName,
              id: 'c'.repeat(40) as ObjectId,
              expected: 'd'.repeat(40) as ObjectId,
            },
          ]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('REF_UPDATE_CONFLICT');
        if (data.code === 'REF_UPDATE_CONFLICT') {
          expect(data.name).toBe('refs/heads/main');
          expect(data.expected).toBe('d'.repeat(40));
          expect(data.actual).toBe('a'.repeat(40));
        }
      });
    });
  });

  describe('Given a set update', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then it writes through the ref lock (transient .lock, then gone)', async () => {
        // Arrange — kills a mutant that swaps `atomicWriteRef` for a plain
        // write: intercepting `rename` observes the lock file mid-flight,
        // right before atomicWriteRef renames it onto the final ref path.
        const ctx = await buildSeededContext();
        const lockPath = '/repo/.git/refs/heads/atomic.lock';
        let lockExistedDuringWrite = false;
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async (from: string, to: string) => {
              lockExistedDuringWrite = await ctx.fs.exists(lockPath);
              return ctx.fs.rename(from, to);
            },
          },
        };
        const sut = createRefStore(wrapped);

        // Act
        await sut.applyRefUpdates([
          { kind: 'set', name: 'refs/heads/atomic' as RefName, id: 'f'.repeat(40) as ObjectId },
        ]);

        // Assert
        expect(lockExistedDuringWrite).toBe(true);
        expect(await ctx.fs.exists(lockPath)).toBe(false);
      });
    });
  });

  describe('Given a reflogOnly update', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then it appends to the reflog without touching the ref', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);
        const name = 'refs/heads/untouched' as RefName;
        const idA = 'a'.repeat(40) as ObjectId;
        const idB = 'b'.repeat(40) as ObjectId;

        // Act
        await sut.applyRefUpdates([
          { kind: 'reflogOnly', name, reflog: { oldId: idA, newId: idB, message: 'reflog-only' } },
        ]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/untouched')).toBe(false);
        const log = await readReflog(ctx, name);
        expect(log).toHaveLength(1);
        expect(log[0]?.oldId).toBe(idA);
        expect(log[0]?.newId).toBe(idB);
        expect(log[0]?.message).toBe('reflog-only');
      });
    });
  });

  describe('Given an existing ref with a reflog', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then the ref and its reflog are both removed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);
        const name = 'refs/heads/tmp' as RefName;
        const idA = 'a'.repeat(40) as ObjectId;
        await sut.applyRefUpdates([
          {
            kind: 'set',
            name,
            id: idA,
            reflog: { oldId: 'e'.repeat(40) as ObjectId, newId: idA, message: 'seed' },
          },
        ]);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name }]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/tmp')).toBe(false);
        expect(await ctx.fs.exists('/repo/.git/logs/refs/heads/tmp')).toBe(false);
      });
    });
  });

  describe('Given a packed-only ref', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then it throws UNSUPPORTED_OPERATION with operation delete-packed-ref', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/old' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/tags/old' as RefName }]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('UNSUPPORTED_OPERATION');
        if (data.code === 'UNSUPPORTED_OPERATION') {
          expect(data.operation).toBe('delete-packed-ref');
          expect(data.reason).toMatch(/packed-only refs/);
        }
      });
    });
  });

  describe('Given a packed-only tracking ref', () => {
    describe('When assertRenamableTrackingRef is called', () => {
      it('Then it throws UNSUPPORTED_OPERATION with operation rename-packed-tracking-ref', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [
            { name: 'refs/remotes/origin/main' as RefName, id: 'a'.repeat(40) as ObjectId },
          ],
        });

        // Act
        let caught: unknown;
        try {
          await assertRenamableTrackingRef(ctx, 'refs/remotes/origin/main' as RefName);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('UNSUPPORTED_OPERATION');
        if (data.code === 'UNSUPPORTED_OPERATION') {
          expect(data.operation).toBe('rename-packed-tracking-ref');
          expect(data.reason).toContain('packed-only ref refs/remotes/origin/main');
        }
      });
    });
  });

  describe('Given a loose tracking ref', () => {
    describe('When assertRenamableTrackingRef is called', () => {
      it('Then it does not throw', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/remotes/origin/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });

        // Act + Assert
        await expect(
          assertRenamableTrackingRef(ctx, 'refs/remotes/origin/main' as RefName),
        ).resolves.toBeUndefined();
      });
    });
  });

  describe('Given packed-refs containing multiple entries and resolveDirect of the SECOND one', () => {
    describe('When called', () => {
      it('Then returns the second id (not the first)', async () => {
        // Arrange
        // Kills the `entry.name === name` ConditionalExpression `true` mutant: under
        // `true`, the first entry would always be returned regardless of name.
        const ctx = await buildSeededContext({
          packedRefs: [
            { name: 'refs/tags/first' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/tags/second' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/tags/second' as RefName);

        // Assert
        expect(result.kind).toBe('direct');
        if (result.kind === 'direct') expect(result.id).toBe('b'.repeat(40));
      });
    });
  });

  describe('Given a large packed-refs file', () => {
    describe('When resolveDirect looks up the very last entry', () => {
      it('Then it still returns the right id (name-indexed lookup, not a linear scan)', async () => {
        // Arrange
        const REF_COUNT = 500;
        const packedRefEntry = (i: number): { readonly name: RefName; readonly id: ObjectId } => ({
          name: `refs/tags/t${String(i).padStart(4, '0')}` as RefName,
          id: (i % 10 === 9 ? 'f' : `${i % 10}`).repeat(40) as ObjectId,
        });
        const packedRefs = Array.from({ length: REF_COUNT }, (_, i) => packedRefEntry(i));
        const last = packedRefEntry(REF_COUNT - 1);
        const ctx = await buildSeededContext({ packedRefs });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(last.name);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: last.id });
      });
    });
  });

  describe('Given a delete update on a ref that exists in neither loose nor packed storage', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then it throws REF_NOT_FOUND', async () => {
        // Arrange
        // Kills the `if (await ctx.fs.exists(path))` ConditionalExpression `true`
        // mutant: under `true`, rm is always called and would fail on missing path.
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/never' as RefName }]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given a set update', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then the loose file was created (applySet body is not empty)', async () => {
        // Arrange
        // Kills the BlockStatement `{}` mutant on applySet's body.
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'set', name: 'refs/heads/new2' as RefName, id: 'e'.repeat(40) as ObjectId },
        ]);
        const exists = await ctx.fs.exists('/repo/.git/refs/heads/new2');

        // Assert
        expect(exists).toBe(true);
      });
    });
  });

  describe('Given a packed-refs file whose mtime/size changes between lookups', () => {
    describe('When resolveDirect is called again', () => {
      it('Then the cache is invalidated (key mismatch reloads)', async () => {
        // Arrange
        // Kills `mtimeKey === key` ConditionalExpression `true`: under `true` the
        // cache would be returned stale despite a modification, and the second
        // lookup would yield the pre-update id instead of the new one.
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/vol' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const first = await sut.resolveDirect('refs/tags/vol' as RefName);

        // Assert
        expect(first.kind).toBe('direct');
        if (first.kind === 'direct') expect(first.id).toBe('a'.repeat(40));

        // Act — Rewrite packed-refs with a different id + different mtime/size.
        await ctx.fs.writeUtf8(
          '/repo/.git/packed-refs',
          `# pack-refs with: peeled\n${'b'.repeat(40)} refs/tags/vol\n`,
        );
        const second = await sut.resolveDirect('refs/tags/vol' as RefName);

        // Assert
        expect(second.kind).toBe('direct');
        if (second.kind === 'direct') expect(second.id).toBe('b'.repeat(40));
      });
    });
  });

  describe('Given two resolveDirect calls on the same packed-refs', () => {
    describe('When called back-to-back', () => {
      it('Then the file is read only once (mtime-based cache)', async () => {
        // Arrange
        // Kills the cache-key StringLiteral and the mtime-caching ConditionalExpression.
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/cached' as RefName, id: 'f'.repeat(40) as ObjectId }],
        });
        let reads = 0;
        const originalReadUtf8 = ctx.fs.readUtf8.bind(ctx.fs);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readUtf8: async (path: string) => {
              if (path === '/repo/.git/packed-refs') reads += 1;
              return originalReadUtf8(path);
            },
          },
        };
        const sut = createRefStore(wrapped);

        // Act
        await sut.resolveDirect('refs/tags/cached' as RefName);
        await sut.resolveDirect('refs/tags/cached' as RefName);

        // Assert — at-most-once: leaves room for a future legitimate
        // stat-then-read pair without pinning the implementation.
        expect(reads).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('Given a repository with a loose ref, a packed ref and a nested loose ref', () => {
    describe('When listing refs with no prefix', () => {
      it('Then all three are returned sorted by name', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/feat/x' as RefName, id: 'c'.repeat(40) as ObjectId },
          ],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs();

        // Assert
        expect(result.map((entry) => entry.name)).toEqual([
          'refs/heads/feat/x',
          'refs/heads/main',
          'refs/tags/v1',
        ]);
      });
    });

    describe('When listing refs with prefix refs/heads/', () => {
      it('Then only the heads refs are returned, including the nested one', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/feat/x' as RefName, id: 'c'.repeat(40) as ObjectId },
          ],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs('refs/heads/' as RefName);

        // Assert
        expect(result.map((entry) => entry.name)).toEqual(['refs/heads/feat/x', 'refs/heads/main']);
      });
    });
  });

  describe('Given loose refs under refs/heads/ and a sibling refs/tags/ namespace', () => {
    describe('When listing refs with prefix refs/heads/', () => {
      it('Then the walk never reads the refs/tags directory', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.listRefs('refs/heads/' as RefName);

        // Assert
        const tagsDir = `${ctx.layout.gitDir}/refs/tags`;
        expect(calls().some((c) => c.path === tagsDir)).toBe(false);
      });
    });
  });

  describe('Given a prefix that cannot match anything under refs/', () => {
    describe('When listing refs with that prefix', () => {
      it('Then no refs directory is ever read and the result is empty', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs('other/' as RefName);

        // Assert
        expect(result).toEqual([]);
        expect(calls().some((c) => c.path.includes('/refs'))).toBe(false);
      });
    });
  });

  describe('Given a prefix shorter than the refs/ root itself', () => {
    describe('When listing refs with that prefix', () => {
      it('Then the whole refs tree is still walked', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs('ref' as RefName);

        // Assert
        expect(result.map((entry) => entry.name)).toEqual(['refs/heads/main']);
      });
    });
  });

  describe('Given a prefix that ends mid-segment inside refs/heads/', () => {
    describe('When listing refs with that prefix', () => {
      it('Then only names sharing that partial segment are returned', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/feature' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/fix' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs('refs/heads/fea' as RefName);

        // Assert
        expect(result.map((entry) => entry.name)).toEqual(['refs/heads/feature']);
      });
    });
  });

  describe('Given a prefix whose pushed-down walk root is itself a loose ref FILE, not a directory', () => {
    describe('When listing ref names with that prefix', () => {
      it('Then it returns empty rather than throwing a filesystem not-a-directory error', async () => {
        // Arrange — `refsWalkRoot` pushes `refs/remotes/origin/main` down to
        // `refs/remotes/origin`; here that path is itself a loose ref
        // FILE (a D/F collision a fetch or a stray write can produce), not
        // a `refs/**` directory. The pre-pushdown whole-tree walk would
        // have silently contributed nothing for a root shaped like this
        // too — pushing the walk down must not change that.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin`, `${'a'.repeat(40)}\n`);
        const sut = createRefStore(ctx);

        // Act
        const names = await sut.listRefNames('refs/remotes/origin/main' as RefName);

        // Assert
        expect(names).toEqual([]);
      });
    });
  });

  describe('Given a prefix that only HEAD could match', () => {
    describe('When listing refs with that prefix', () => {
      it('Then the HEAD existence probe is skipped entirely', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs('refs/heads/' as RefName);

        // Assert
        expect(result.map((entry) => entry.name)).toEqual(['refs/heads/main']);
        const headPath = `${ctx.layout.gitDir}/HEAD`;
        expect(calls().some((c) => c.path === headPath)).toBe(false);
      });
    });
  });

  describe('Given a symbolic HEAD', () => {
    describe('When listing refs with no prefix', () => {
      it('Then HEAD is returned with its symbolic target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs();

        // Assert
        const head = result.find((entry) => entry.name === 'HEAD');
        expect(head?.value).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
      });
    });
  });

  describe('Given a repository with a loose ref, a packed ref and a nested loose ref', () => {
    describe('When listRefNames runs with no prefix', () => {
      it('Then it returns the exact same names listRefs resolves', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/feat/x' as RefName, id: 'c'.repeat(40) as ObjectId },
          ],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const names = await sut.listRefNames();

        // Assert
        expect(names).toEqual((await sut.listRefs()).map((entry) => entry.name));
      });
    });

    describe('When listRefNames runs with prefix refs/heads/', () => {
      it('Then only matching names come back', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/feat/x' as RefName, id: 'c'.repeat(40) as ObjectId },
          ],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const names = await sut.listRefNames('refs/heads/' as RefName);

        // Assert
        expect(names).toEqual(['refs/heads/feat/x', 'refs/heads/main']);
      });
    });
  });

  describe('Given loose refs and a packed-only ref', () => {
    describe('When listRefNames runs', () => {
      it('Then the packed-only ref never triggers a loose-content read', async () => {
        // Arrange — listRefNames still skips listRefs's own resolution cost
        // for a name that is packed-only: `parsePackedRefs` already
        // enforces the grammar on the whole file at load time, so no
        // per-name read is owed here. A LOOSE name's own content, by
        // contrast, must be read once to decide whether it is even a
        // legitimate result (see the sibling malformed-ref test).
        const base = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/other' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'c'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        const names = await sut.listRefNames();

        // Assert
        expect(names).toEqual(['refs/heads/main', 'refs/heads/other', 'refs/tags/v1']);
        const readUtf8Paths = calls()
          .filter((c) => c.method === 'readUtf8')
          .map((c) => c.path);
        expect(readUtf8Paths.some((p) => p.endsWith('refs/tags/v1'))).toBe(false);
      });
    });
  });

  describe('Given a loose ref whose body is neither an oid nor a symbolic ref', () => {
    describe('When listRefNames runs', () => {
      it('Then the malformed ref name is excluded, matching listRefs and real git’s for-each-ref/branch', async () => {
        // Arrange — measured against git 2.55.0: both `for-each-ref` and
        // `branch` warn ("ignoring broken ref …") and omit a ref shaped
        // like this from their own output, rather than reporting its name.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/garbage', 'not-a-valid-sha\n');
        const sut = createRefStore(ctx);

        // Act
        const names = await sut.listRefNames();
        const entries = await sut.listRefs();

        // Assert
        expect(names).not.toContain('refs/heads/garbage');
        expect(entries.map((entry) => entry.name)).not.toContain('refs/heads/garbage');
      });
    });
  });

  describe('Given a loose ref whose body is neither an oid nor a symbolic ref', () => {
    describe('When verifyIntegrity is called', () => {
      it('Then a badRefContent finding is returned for that ref', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/garbage', 'not-a-valid-sha\n');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(result).toContainEqual({ ref: 'refs/heads/garbage', msgId: 'badRefContent' });
      });
    });
  });

  describe('Given a loose ref naming a well-formed but unknown oid', () => {
    describe('When verifyIntegrity is called', () => {
      it('Then a badRefOid finding is returned with the target oid', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const unknownOid = 'a'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/broken', `${unknownOid}\n`);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(result).toContainEqual({
          ref: 'refs/heads/broken',
          msgId: 'badRefOid',
          target: unknownOid,
        });
      });
    });
  });

  describe('Given a loose ref naming a known oid', () => {
    describe('When verifyIntegrity is called', () => {
      it('Then no finding is returned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('x'),
          id: '' as ObjectId,
        });
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/main', `${blobId}\n`);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a refs root with far more entries than V8’s spread-call argument ceiling', () => {
    describe('When listRefNames runs', () => {
      it('Then it does not throw — the loose-name collector loops rather than spread-pushing', async () => {
        // Arrange — a large unpacked ref space (a mirror's `refs/pull/*`, a
        // fetch not yet followed by `pack-refs`) can legitimately exceed
        // V8's ~10^5 spread-argument ceiling; `names.push(...bigArray)`
        // throws `RangeError: Maximum call stack size exceeded` past it.
        // `readdir` is stubbed rather than seeding 150,000 real files, which
        // would make this test itself the slow thing.
        const ctx = await buildSeededContext();
        const entryCount = 150_000;
        const entries: readonly DirEntry[] = Array.from({ length: entryCount }, (_, i) => ({
          name: `ref${i}`,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        }));
        const refsDir = `${ctx.layout.gitDir}/refs`;
        await ctx.fs.writeUtf8(`${refsDir}/placeholder`, `${'a'.repeat(40)}\n`);
        const originalReaddir = ctx.fs.readdir.bind(ctx.fs);
        const patchedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => (path === refsDir ? entries : originalReaddir(path)),
          },
        };
        const sut = createRefStore(patchedCtx);

        // Act
        const names = await sut.listRefNames();

        // Assert
        expect(names).toHaveLength(entryCount);
      });
    });
  });

  describe('Given two getRefStore calls on the same Context', () => {
    describe('When invoked', () => {
      it('Then returns the same store instance (per-Context cache)', async () => {
        // Arrange
        // Kills any mutant that drops the WeakMap cache: a second call would
        // create a fresh store and the identity check would fail.
        const ctx = await buildSeededContext();

        // Act
        const a = getRefStore(ctx);
        const b = getRefStore(ctx);

        // Assert
        expect(a).toBe(b);
      });
    });
  });

  describe('Given getRefStore on two different Contexts', () => {
    describe('When invoked', () => {
      it('Then returns distinct store instances (cache is keyed by Context)', async () => {
        // Arrange
        // Kills the mutant where the cache key is shared across all contexts.
        const ctxA = await buildSeededContext();
        const ctxB = await buildSeededContext();

        // Act + Assert
        expect(getRefStore(ctxA)).not.toBe(getRefStore(ctxB));
      });
    });
  });

  describe('Given a ref with two reflog entries', () => {
    describe('When readReflog is called on the store', () => {
      it('Then both entries are returned newest last', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const first = reflogEntry({ message: 'first' });
        const second = reflogEntry({ oldId: first.newId, message: 'second' });
        await appendReflog(ctx, 'refs/heads/main' as RefName, first);
        await appendReflog(ctx, 'refs/heads/main' as RefName, second);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.readReflog('refs/heads/main' as RefName);

        // Assert
        expect(result).toEqual([first, second]);
      });
    });
  });

  describe('Given a ref with no reflog', () => {
    describe('When readReflog is called on the store', () => {
      it('Then an empty array is returned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.readReflog('refs/heads/absent' as RefName);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a ref with a reflog', () => {
    describe('When hasReflog is called on the store', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'refs/heads/main' as RefName, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.hasReflog('refs/heads/main' as RefName);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a ref with no reflog', () => {
    describe('When hasReflog is called on the store', () => {
      it('Then it returns false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.hasReflog('refs/heads/absent' as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a reflog path that is a directory because a sibling ref nests under it', () => {
    describe('When hasReflog is called on the store', () => {
      it('Then it returns false, matching real git’s S_ISREG requirement', async () => {
        // Arrange — measured against git 2.55.0: `git reflog exists
        // refs/heads/feature` exits 1 (absent) once
        // `.git/logs/refs/heads/feature` is a directory holding
        // `feature/x`'s own reflog file, not `feature`'s own.
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'refs/heads/feature/x' as RefName, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.hasReflog('refs/heads/feature' as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given many other reflogs but not the one being asked about', () => {
    describe('When hasReflog is called on the store', () => {
      it('Then it never walks the logs directory tree — a single existence probe', async () => {
        // Arrange
        const base = await buildSeededContext();
        for (let i = 0; i < 20; i += 1) {
          await appendReflog(base, `refs/heads/other${i}` as RefName, reflogEntry());
        }
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.hasReflog('refs/heads/absent' as RefName);

        // Assert
        expect(result).toBe(false);
        expect(calls().some((c) => c.method === 'readdir')).toBe(false);
      });
    });
  });

  describe('Given per-worktree and shared reflogs, including HEAD', () => {
    describe('When listReflogs is called on the store', () => {
      it('Then per-worktree and shared reflogs are returned merged and deduplicated', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'HEAD' as RefName, reflogEntry());
        await appendReflog(ctx, 'refs/heads/main' as RefName, reflogEntry());
        await appendReflog(ctx, 'refs/remotes/origin/main' as RefName, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listReflogs();

        // Assert
        expect([...result].sort()).toEqual(
          ['HEAD', 'refs/heads/main', 'refs/remotes/origin/main'].sort(),
        );
      });
    });
  });

  describe('Given a reflogReplace update with a shorter entries list', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then the reflog is replaced with exactly the given entries', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const first = reflogEntry({ message: 'first' });
        const second = reflogEntry({ oldId: first.newId, message: 'second' });
        await appendReflog(ctx, 'refs/heads/main' as RefName, first);
        await appendReflog(ctx, 'refs/heads/main' as RefName, second);
        const kept = reflogEntry({ message: 'kept' });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'reflogReplace', name: 'refs/heads/main' as RefName, entries: [kept] },
        ]);

        // Assert
        expect(await readReflog(ctx, 'refs/heads/main' as RefName)).toEqual([kept]);
      });
    });
  });

  describe('Given a set update with an unconditional reflog entry, no reflog file, and autocreate disabled', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then the reflog entry is appended anyway', async () => {
        // Arrange — refs/stash-shaped ref, outside the default-loggable set,
        // proves the isLoggable gate is bypassed rather than satisfied.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n\tlogallrefupdates = false\n',
        );
        const name = 'refs/stash' as RefName;
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          {
            kind: 'set',
            name,
            id: 'c'.repeat(40) as ObjectId,
            reflog: {
              oldId: 'a'.repeat(40) as ObjectId,
              newId: 'c'.repeat(40) as ObjectId,
              message: 'stash entry',
              unconditional: true,
            },
          },
        ]);

        // Assert
        const entries = await readReflog(ctx, name);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.message).toBe('stash entry');
      });
    });
  });

  describe('Given a Context whose layout declares refStorage: reftable', () => {
    describe('When createRefStore builds the backend', () => {
      it('Then it produces the reftable backend', async () => {
        // Arrange — no loose/packed files exist at all; only a reftable stack.
        const ctx = withReftableStorage(createMemoryContext());
        await writeReftableFiles(ctx, commonReftableDir(ctx), [
          {
            name: 'table1.ref',
            bytes: buildSingleRefTable('refs/heads/main', new Uint8Array(20).fill(0xaa)),
          },
        ]);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/heads/main' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: 'aa'.repeat(20) });
      });
    });
  });

  describe('Given a Context whose layout declares refStorage: files', () => {
    describe('When createRefStore builds the backend', () => {
      it('Then it produces the files backend, ignoring a reftable stack on disk', async () => {
        // Arrange — a reftable stack AND a loose ref disagree on the value;
        // the files backend must read the loose file, proving dispatch.
        const ctx = createMemoryContext();
        await writeReftableFiles(ctx, commonReftableDir(ctx), [
          {
            name: 'table1.ref',
            bytes: buildSingleRefTable('refs/heads/main', new Uint8Array(20).fill(0xaa)),
          },
        ]);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${'bb'.repeat(20)}\n`);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/heads/main' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: 'bb'.repeat(20) });
      });
    });
  });
});
