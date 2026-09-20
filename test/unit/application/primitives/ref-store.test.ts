import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { validateHead } from '../../../../src/application/primitives/internal/head-file.js';
import { assertRepository } from '../../../../src/application/primitives/internal/repo-state.js';
import {
  createRefStore,
  getRefStore,
  type RefUpdate,
} from '../../../../src/application/primitives/ref-store.js';
import { appendReflog, readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { MAX_REFLOG_BYTES } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  fileNotFound,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
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

/** Every port method a loose ref's content can be read through. */
const LOOSE_READS: ReadonlySet<string> = new Set(['readUtf8', 'openWithNoFollow']);

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

        // Assert — one no-follow open and no `exists` or `lstat` probe on the loose path.
        const loosePath = `${ctx.layout.gitDir}/refs/heads/main`;
        expect(calls().filter((c) => c.path === loosePath)).toEqual([
          { method: 'openWithNoFollow', path: loosePath },
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

  describe('Given a loose-and-packed ref (the loose value shadows the packed one)', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then both the loose file and the packed-refs line are gone — resolveDirect reports it missing', async () => {
        // Arrange — git's `-d` on a loose-and-packed ref removes both; the
        // packed value must never resurrect once the loose shadow is gone.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: 'c'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/main' as RefName }]);
        const result = await sut.resolveDirect('refs/heads/main' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'missing' });
        expect(await ctx.fs.exists('/repo/.git/refs/heads/main')).toBe(false);
        const packedContent = await ctx.fs.readUtf8('/repo/.git/packed-refs');
        expect(packedContent).not.toContain('refs/heads/main');
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
      it('Then packed-refs is rewritten without it and resolveDirect reports it missing', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [
            { name: 'refs/heads/kept' as RefName, id: 'b'.repeat(40) as ObjectId },
            { name: 'refs/tags/old' as RefName, id: 'a'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/tags/old' as RefName }]);

        // Assert
        expect(await sut.resolveDirect('refs/tags/old' as RefName)).toEqual({ kind: 'missing' });
        expect(await sut.resolveDirect('refs/heads/kept' as RefName)).toEqual({
          kind: 'direct',
          id: 'b'.repeat(40),
        });
        const packedContent = await ctx.fs.readUtf8('/repo/.git/packed-refs');
        expect(packedContent).not.toContain('refs/tags/old');
        expect(packedContent.startsWith('# pack-refs with: peeled fully-peeled sorted ')).toBe(
          true,
        );
      });
    });
  });

  describe('Given a loose-only ref with a canonical packed-refs present', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then the packed-refs lock is taken and released but nothing is written through it or renamed onto packed-refs', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/lo' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const packedRefsPath = '/repo/.git/packed-refs';
        const canonical = `# pack-refs with: peeled fully-peeled sorted \n${'b'.repeat(40)} refs/tags/other\n`;
        await base.fs.writeUtf8(packedRefsPath, canonical);
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/lo' as RefName }]);

        // Assert
        const lockPath = `${packedRefsPath}.lock`;
        const log = calls();
        expect(
          log.filter((c) => c.method === 'writeExclusive' && c.path === lockPath),
        ).toHaveLength(1);
        expect(log.filter((c) => c.method === 'write' && c.path === lockPath)).toEqual([]);
        expect(
          log.filter((c) => c.method === 'rename' && c.path.endsWith(`->${packedRefsPath}`)),
        ).toEqual([]);
        expect(await base.fs.readUtf8(packedRefsPath)).toBe(canonical);
        expect(await base.fs.exists(lockPath)).toBe(false);
        expect(await base.fs.exists('/repo/.git/refs/heads/lo')).toBe(false);
      });
    });
  });

  describe('Given two loose and two packed-only tracking refs under one remote directory, and a ref outside it', () => {
    const PACKED_REFS = '/repo/.git/packed-refs';
    const ORIGIN_DIR = '/repo/.git/refs/remotes/origin';
    const names = [
      'refs/remotes/origin/a',
      'refs/remotes/origin/b',
      'refs/remotes/origin/c',
      'refs/remotes/origin/d',
    ] as RefName[];
    const seed = (): Promise<Context> =>
      buildSeededContext({
        refs: [
          { name: 'refs/remotes/origin/a' as RefName, id: 'a'.repeat(40) as ObjectId },
          { name: 'refs/remotes/origin/b' as RefName, id: 'b'.repeat(40) as ObjectId },
        ],
        packedRefs: [
          { name: 'refs/heads/kept' as RefName, id: 'e'.repeat(40) as ObjectId },
          { name: 'refs/remotes/origin/c' as RefName, id: 'c'.repeat(40) as ObjectId },
          { name: 'refs/remotes/origin/d' as RefName, id: 'd'.repeat(40) as ObjectId },
        ],
      });

    describe('When one applyRefUpdates call deletes all four', () => {
      it('Then packed-refs is locked and rewritten once, the directory pruned with one removal attempt, and every ref gone', async () => {
        // Arrange
        const base = await seed();
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates(names.map((name) => ({ kind: 'delete' as const, name })));

        // Assert
        const log = calls();
        expect(
          log.filter((c) => c.method === 'writeExclusive' && c.path === `${PACKED_REFS}.lock`),
        ).toHaveLength(1);
        expect(
          log.filter(
            (c) => c.method === 'rename' && c.path === `${PACKED_REFS}.lock->${PACKED_REFS}`,
          ),
        ).toHaveLength(1);
        expect(log.filter((c) => c.method === 'rm' && c.path === ORIGIN_DIR)).toHaveLength(1);
        expect(await base.fs.exists(ORIGIN_DIR)).toBe(false);
        expect(await base.fs.readUtf8(PACKED_REFS)).toBe(
          `# pack-refs with: peeled fully-peeled sorted \n${'e'.repeat(40)} refs/heads/kept\n`,
        );
        for (const name of names) {
          expect(await sut.resolveDirect(name)).toEqual({ kind: 'missing' });
        }
      });
    });

    describe('When the last delete in the call carries a mismatched expected id', () => {
      it('Then it refuses REF_UPDATE_CONFLICT before any ref, file or lock is touched', async () => {
        // Arrange
        const ctx = await seed();
        const packedBefore = await ctx.fs.readUtf8(PACKED_REFS);
        const sut = createRefStore(ctx);
        const updates = names.map((name) => ({ kind: 'delete' as const, name }));
        const mismatched = { ...updates[3], expected: 'f'.repeat(40) as ObjectId } as RefUpdate;

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([...updates.slice(0, 3), mismatched]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'REF_UPDATE_CONFLICT',
          name: 'refs/remotes/origin/d',
          expected: 'f'.repeat(40),
          actual: 'd'.repeat(40),
        });
        expect(await ctx.fs.readUtf8(`${ORIGIN_DIR}/a`)).toBe(`${'a'.repeat(40)}\n`);
        expect(await ctx.fs.readUtf8(PACKED_REFS)).toBe(packedBefore);
      });
    });

    describe("When the second delete's loose lock is already held", () => {
      it('Then it refuses REF_LOCKED naming it, the first ref is untouched and no lock it took remains', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.write(`${ORIGIN_DIR}/b.lock`, new Uint8Array(0));
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates(names.map((name) => ({ kind: 'delete' as const, name })));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'REF_LOCKED',
          name: 'refs/remotes/origin/b',
        });
        expect(await ctx.fs.readUtf8(`${ORIGIN_DIR}/a`)).toBe(`${'a'.repeat(40)}\n`);
        expect(await ctx.fs.exists(`${ORIGIN_DIR}/a.lock`)).toBe(false);
        expect(await ctx.fs.exists(`${PACKED_REFS}.lock`)).toBe(false);
      });
    });
  });

  describe('Given branches a and b, and a held lock on a', () => {
    const seedAB = async (): Promise<Context> => {
      const ctx = await buildSeededContext({
        refs: [
          { name: 'refs/heads/a' as RefName, id: 'a'.repeat(40) as ObjectId },
          { name: 'refs/heads/b' as RefName, id: 'b'.repeat(40) as ObjectId },
        ],
      });
      await ctx.fs.write('/repo/.git/refs/heads/a.lock', new Uint8Array(0));
      return ctx;
    };

    describe('When one applyRefUpdates call deletes a name more than once', () => {
      it.each([
        {
          label: 'the smallest duplicated name is named, as git sorts before rejecting',
          updates: ['refs/heads/b', 'refs/heads/b', 'refs/heads/a', 'refs/heads/a'],
          duplicate: 'refs/heads/a',
          expected: undefined,
        },
        {
          label: 'the duplicate refuses before the held lock on a is met',
          updates: ['refs/heads/a', 'refs/heads/b', 'refs/heads/b'],
          duplicate: 'refs/heads/b',
          expected: undefined,
        },
        {
          label: 'the duplicate refuses before a mismatched compare-and-swap',
          updates: ['refs/heads/b', 'refs/heads/b'],
          duplicate: 'refs/heads/b',
          expected: 'f'.repeat(40),
        },
      ])('Then $label and nothing changes', async ({ updates, duplicate, expected }) => {
        // Arrange
        const ctx = await seedAB();
        const sut = createRefStore(ctx);
        const deletes = updates.map(
          (name): RefUpdate => ({
            kind: 'delete',
            name: name as RefName,
            ...(expected === undefined ? {} : { expected: expected as ObjectId }),
          }),
        );

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates(deletes);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'REF_CYCLE_DETECTED',
          chain: [duplicate, duplicate],
        });
        expect(await sut.resolveDirect('refs/heads/a' as RefName)).toEqual({
          kind: 'direct',
          id: 'a'.repeat(40),
        });
        expect(await sut.resolveDirect('refs/heads/b' as RefName)).toEqual({
          kind: 'direct',
          id: 'b'.repeat(40),
        });
        expect(await ctx.fs.exists('/repo/.git/refs/heads/a.lock')).toBe(true);
        expect(await ctx.fs.exists('/repo/.git/refs/heads/b.lock')).toBe(false);
      });
    });
  });

  describe('Given a packed-refs snapshot the store has already loaded', () => {
    describe('When a loose-only ref is deleted', () => {
      it('Then the packed-refs file is not read again', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/lo' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/tags/p' as RefName, id: 'b'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);
        await sut.resolveDirect('refs/tags/p' as RefName);
        const before = calls().length;

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/lo' as RefName }]);

        // Assert
        const reads = calls()
          .slice(before)
          .filter((c) => c.path === '/repo/.git/packed-refs' && c.method !== 'stat');
        expect(reads).toEqual([]);
        expect(await sut.resolveDirect('refs/heads/lo' as RefName)).toEqual({ kind: 'missing' });
      });
    });

    describe('When a packed-only ref is deleted and another packed ref is resolved afterwards', () => {
      it('Then the rewrite re-seeds the snapshot — the later lookup reads no packed-refs bytes', async () => {
        // Arrange
        const base = await buildSeededContext({
          packedRefs: [
            { name: 'refs/heads/kept' as RefName, id: 'b'.repeat(40) as ObjectId },
            { name: 'refs/tags/old' as RefName, id: 'a'.repeat(40) as ObjectId },
          ],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/tags/old' as RefName }]);
        const before = calls().length;

        // Act
        const result = await sut.resolveDirect('refs/heads/kept' as RefName);

        // Assert
        const reads = calls()
          .slice(before)
          .filter((c) => c.path === '/repo/.git/packed-refs' && c.method !== 'stat');
        expect(reads).toEqual([]);
        expect(result).toEqual({ kind: 'direct', id: 'b'.repeat(40) });
        expect(await sut.resolveDirect('refs/tags/old' as RefName)).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given the only ref under a nested namespace directory', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then the now-empty nested directory is pruned, matching git', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/remotes/origin/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'delete', name: 'refs/remotes/origin/main' as RefName },
        ]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/remotes/origin')).toBe(false);
      });
    });
  });

  describe('Given the only ref under a nested namespace directory, with a reflog', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then the now-empty nested LOG directory is pruned too, matching git', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/remotes/origin/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        await appendReflog(ctx, 'refs/remotes/origin/main' as RefName, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'delete', name: 'refs/remotes/origin/main' as RefName },
        ]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/logs/refs/remotes/origin')).toBe(false);
      });
    });
  });

  describe('Given a two-component ref that is the only ref and the only reflog', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then refs, logs and logs/refs all survive — no parent at or above the namespace root is pruned', async () => {
        // Arrange
        const name = 'refs/foo' as RefName;
        const ctx = await buildSeededContext({ refs: [{ name, id: 'a'.repeat(40) as ObjectId }] });
        await appendReflog(ctx, name, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name }]);

        // Assert
        expect(await ctx.fs.readdir('/repo/.git/refs')).toEqual([]);
        expect(await ctx.fs.readdir('/repo/.git/logs/refs')).toEqual([]);
        expect((await ctx.fs.readdir('/repo/.git/logs')).map((entry) => entry.name)).toEqual([
          'refs',
        ]);
      });
    });
  });

  describe('Given the only ref and log under a nested namespace directory', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then both nested directories are pruned without listing any directory', async () => {
        // Arrange
        const name = 'refs/remotes/origin/main' as RefName;
        const base = await buildSeededContext({ refs: [{ name, id: 'a'.repeat(40) as ObjectId }] });
        await appendReflog(base, name, reflogEntry());
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name }]);

        // Assert
        expect(calls().filter((call) => call.method === 'readdir')).toEqual([]);
        expect(await base.fs.exists('/repo/.git/refs/remotes/origin')).toBe(false);
        expect(await base.fs.exists('/repo/.git/logs/refs/remotes/origin')).toBe(false);
        expect(await base.fs.exists('/repo/.git/refs/remotes')).toBe(true);
        expect(await base.fs.exists('/repo/.git/logs/refs/remotes')).toBe(true);
      });
    });
  });

  describe('Given the only branch in the repository, with a reflog', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then logs/refs/heads survives empty, matching git', async () => {
        // Arrange
        const name = 'refs/heads/main' as RefName;
        const ctx = await buildSeededContext({ refs: [{ name, id: 'a'.repeat(40) as ObjectId }] });
        await appendReflog(ctx, name, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name }]);

        // Assert
        expect(await ctx.fs.readdir('/repo/.git/logs/refs/heads')).toEqual([]);
      });
    });
  });

  describe("Given an orphan log file where a nested ref's log directory would be, on an adapter whose exists reports a path under a file as absent", () => {
    describe('When applyRefUpdates deletes that nested ref', () => {
      it.each([
        { label: 'the log parent itself is the file', name: 'refs/remotes/q/z' },
        { label: 'a component above the log parent is the file', name: 'refs/remotes/q/sub/z' },
      ])('Then $label and the orphan log survives byte-unchanged', async ({ name }) => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: name as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        await base.fs.writeUtf8('/repo/.git/logs/refs/remotes/q', 'orphan log\n');
        const logPath = `/repo/.git/logs/${name}`;
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            exists: async (path) => (path === logPath ? false : base.fs.exists(path)),
          },
        };
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: name as RefName }]);

        // Assert
        expect(await base.fs.readUtf8('/repo/.git/logs/refs/remotes/q')).toBe('orphan log\n');
        expect(await base.fs.exists('/repo/.git/refs/remotes/q')).toBe(false);
      });
    });
  });

  describe('Given a packed-only ref whose loose directory does not exist', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then no removal is attempted on the directory that was never there', async () => {
        // Arrange
        const base = await buildSeededContext({
          packedRefs: [{ name: 'refs/remotes/gone/z' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/remotes/gone/z' as RefName }]);

        // Assert
        expect(
          calls().filter((c) => c.method === 'rm' && c.path.startsWith('/repo/.git/refs/')),
        ).toEqual([]);
        expect(await sut.resolveDirect('refs/remotes/gone/z' as RefName)).toEqual({
          kind: 'missing',
        });
      });
    });
  });

  describe('Given a loose ref file refs/remotes/q in the way of packed refs under it', () => {
    const PACKED = '/repo/.git/packed-refs';
    const BLOCKING = '/repo/.git/refs/remotes/q';
    const seedInTheWay = (): Promise<Context> =>
      buildSeededContext({
        refs: [{ name: 'refs/remotes/q' as RefName, id: 'b'.repeat(40) as ObjectId }],
        packedRefs: [
          { name: 'refs/heads/pk' as RefName, id: 'c'.repeat(40) as ObjectId },
          { name: 'refs/remotes/q/z' as RefName, id: 'a'.repeat(40) as ObjectId },
          { name: 'refs/remotes/q/sub/z' as RefName, id: 'a'.repeat(40) as ObjectId },
        ],
      });
    /** An `fs` answering as the browser adapter does for a path under a
     *  regular file: absent, never "not a directory". */
    const browserLike = (base: Context): Context => {
      const underFile = (p: string): boolean => p.startsWith(`${BLOCKING}/`);
      return {
        ...base,
        fs: {
          ...base.fs,
          exists: async (p) => (underFile(p) ? false : base.fs.exists(p)),
          stat: async (p) => (underFile(p) ? Promise.reject(fileNotFound(p)) : base.fs.stat(p)),
          readUtf8: async (p) =>
            underFile(p) ? Promise.reject(fileNotFound(p)) : base.fs.readUtf8(p),
          writeExclusive: async (p, d) =>
            underFile(p) ? Promise.reject(fileNotFound(p)) : base.fs.writeExclusive(p, d),
        },
      };
    };
    const asIs = (ctx: Context): Context => ctx;

    describe('When applyRefUpdates applies updates under refs/remotes/q', () => {
      it.each([
        {
          label: 'a delete of a packed ref directly under it',
          updates: [{ kind: 'delete', name: 'refs/remotes/q/z' }],
          adapt: asIs,
        },
        {
          label: 'a delete of a packed ref two levels under it',
          updates: [{ kind: 'delete', name: 'refs/remotes/q/sub/z' }],
          adapt: asIs,
        },
        {
          label: 'a delete run whose other delete is a plain packed ref',
          updates: [
            { kind: 'delete', name: 'refs/heads/pk' },
            { kind: 'delete', name: 'refs/remotes/q/z' },
          ],
          adapt: asIs,
        },
        {
          label: 'a delete on an adapter reporting paths under a file as absent',
          updates: [{ kind: 'delete', name: 'refs/remotes/q/sub/z' }],
          adapt: browserLike,
        },
        {
          label: 'a write of a new ref under it',
          updates: [{ kind: 'set', name: 'refs/remotes/q/new', id: 'd'.repeat(40) }],
          adapt: asIs,
        },
        {
          label: 'a write on an adapter reporting paths under a file as absent',
          updates: [{ kind: 'set', name: 'refs/remotes/q/sub/new', id: 'd'.repeat(40) }],
          adapt: browserLike,
        },
      ])(
        'Then $label refuses NOT_A_DIRECTORY naming refs/remotes/q and changes nothing',
        async ({ updates, adapt }) => {
          // Arrange
          const base = await seedInTheWay();
          const packedBefore = await base.fs.readUtf8(PACKED);
          const sut = createRefStore(adapt(base));

          // Act
          let caught: unknown;
          try {
            await sut.applyRefUpdates(updates as RefUpdate[]);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({ code: 'NOT_A_DIRECTORY', path: BLOCKING });
          expect(await base.fs.readUtf8(PACKED)).toBe(packedBefore);
          expect(await base.fs.readUtf8(BLOCKING)).toBe(`${'b'.repeat(40)}\n`);
          expect(await base.fs.exists(`${PACKED}.lock`)).toBe(false);
          expect(await base.fs.exists(`${BLOCKING}.lock`)).toBe(false);
        },
      );
    });
  });

  describe('Given refs under refs/remotes/d while refs/remotes/d itself is written, deleted or read', () => {
    const PACKED = '/repo/.git/packed-refs';
    const D = 'refs/remotes/d' as RefName;
    const ID_D = 'a'.repeat(40) as ObjectId;
    const ID_X = 'b'.repeat(40) as ObjectId;
    const NEW_ID = 'd'.repeat(40) as ObjectId;
    const header = '# pack-refs with: peeled fully-peeled sorted ';
    /** Answers as the browser adapter does around a directory: reading it
     *  reports it absent, writing or renaming onto it is denied, removing a
     *  non-empty one reports it absent. */
    const browserLike = (base: Context): Context => ({
      ...base,
      fs: {
        ...base.fs,
        readUtf8: async (p) =>
          (await base.fs.exists(p)) && (await base.fs.stat(p)).isDirectory
            ? Promise.reject(fileNotFound(p))
            : base.fs.readUtf8(p),
        rm: async (p) =>
          (await base.fs.exists(p)) && (await base.fs.stat(p)).isDirectory
            ? Promise.reject(fileNotFound(p))
            : base.fs.rm(p),
      },
    });
    const asIs = (ctx: Context): Context => ctx;
    const seed = async (layout: {
      readonly loose?: ReadonlyArray<string>;
      readonly packed?: ReadonlyArray<string>;
      readonly logged?: ReadonlyArray<string>;
    }): Promise<Context> => {
      const ctx = await buildSeededContext({
        refs: (layout.loose ?? []).map((name) => ({ name: name as RefName, id: ID_X })),
        packedRefs: [
          { name: 'refs/heads/pk' as RefName, id: ID_D },
          ...(layout.packed ?? []).map((name) => ({ name: name as RefName, id: ID_D })),
        ],
      });
      for (const name of layout.logged ?? []) {
        await appendReflog(ctx, name as RefName, reflogEntry());
      }
      return ctx;
    };

    describe('When resolveDirect reads packed refs/remotes/d over a loose directory', () => {
      it.each([
        { label: 'as git reads a directory at a loose path', adapt: asIs },
        { label: 'on an adapter reporting the directory absent', adapt: browserLike },
      ])('Then it resolves the packed value, $label', async ({ adapt }) => {
        // Arrange
        const base = await seed({ loose: ['refs/remotes/d/x'], packed: [D] });
        const sut = createRefStore(adapt(base));

        // Act
        const result = await sut.resolveDirect(D);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: ID_D });
      });
    });

    describe('When applyRefUpdates deletes packed refs/remotes/d over a loose directory', () => {
      it.each([
        {
          label: 'the packed line goes and the directory with its ref stays',
          layout: { loose: ['refs/remotes/d/x'], packed: [D] },
          updates: [D],
          adapt: asIs,
        },
        {
          label: 'a logged ref under it keeps its log directory',
          layout: { loose: ['refs/remotes/d/x'], packed: [D], logged: ['refs/remotes/d/x'] },
          updates: [D],
          adapt: asIs,
        },
        {
          label: 'a run deleting another packed ref first changes both lines',
          layout: { loose: ['refs/remotes/d/x'], packed: [D] },
          updates: ['refs/heads/pk', D],
          adapt: asIs,
        },
        {
          label: 'on an adapter reporting the directory absent',
          layout: { loose: ['refs/remotes/d/x'], packed: [D] },
          updates: [D],
          adapt: browserLike,
        },
      ])('Then $label', async ({ layout, updates, adapt }) => {
        // Arrange
        const base = await seed(layout);
        const logBefore = (layout.logged ?? []).length
          ? await base.fs.readUtf8('/repo/.git/logs/refs/remotes/d/x')
          : undefined;
        const sut = createRefStore(adapt(base));

        // Act
        await sut.applyRefUpdates(
          updates.map((name) => ({ kind: 'delete', name: name as RefName })),
        );

        // Assert
        const pk = updates.some((name) => name === 'refs/heads/pk')
          ? ''
          : `${ID_D} refs/heads/pk\n`;
        expect(await base.fs.readUtf8(PACKED)).toBe(`${header}\n${pk}`);
        expect(await base.fs.readUtf8('/repo/.git/refs/remotes/d/x')).toBe(`${ID_X}\n`);
        expect(await base.fs.exists('/repo/.git/refs/remotes/d.lock')).toBe(false);
        expect(await base.fs.exists(`${PACKED}.lock`)).toBe(false);
        if (logBefore !== undefined) {
          expect(await base.fs.readUtf8('/repo/.git/logs/refs/remotes/d/x')).toBe(logBefore);
        }
      });

      it('Then an empty directory at refs/remotes/d is left in place, as git leaves it', async () => {
        // Arrange
        const base = await seed({ packed: [D] });
        await base.fs.mkdir('/repo/.git/refs/remotes/d');
        const sut = createRefStore(base);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: D }]);

        // Assert
        expect((await base.fs.stat('/repo/.git/refs/remotes/d')).isDirectory).toBe(true);
        expect(await sut.resolveDirect(D)).toEqual({ kind: 'missing' });
      });
    });

    describe('When applyRefUpdates writes refs/remotes/d while refs sit under it', () => {
      it.each([
        {
          label: 'a loose ref under it',
          layout: { loose: ['refs/remotes/d/x'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/x',
          adapt: asIs,
        },
        {
          label: 'a packed-only ref under it',
          layout: { packed: ['refs/remotes/d/x'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/x',
          adapt: asIs,
        },
        {
          label: 'a smaller packed ref beside a loose one',
          layout: { loose: ['refs/remotes/d/y'], packed: ['refs/remotes/d/a'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/a',
          adapt: asIs,
        },
        {
          label: 'a smaller loose ref beside a packed one',
          layout: { loose: ['refs/remotes/d/a'], packed: ['refs/remotes/d/y'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/a',
          adapt: asIs,
        },
        {
          label: 'the smaller of two packed refs under it',
          layout: { packed: ['refs/remotes/d/a', 'refs/remotes/d/y'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/a',
          adapt: asIs,
        },
        {
          label: 'a loose ref beside a smaller lock file, which is not a ref',
          layout: { loose: ['refs/remotes/d/x', 'refs/remotes/d/a.lock'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/x',
          adapt: asIs,
        },
        {
          label: 'a loose ref nested two levels under it',
          layout: { loose: ['refs/remotes/d/sub/x'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/sub/x',
          adapt: asIs,
        },
        {
          label: 'a loose ref under it, written symbolic',
          layout: { loose: ['refs/remotes/d/x'] },
          update: { kind: 'setSymbolic', name: D, target: 'refs/heads/pk' },
          existing: 'refs/remotes/d/x',
          adapt: asIs,
        },
        {
          label: 'a loose ref under it, on an adapter reporting the directory absent',
          layout: { loose: ['refs/remotes/d/x'] },
          update: { kind: 'set', name: D, id: NEW_ID },
          existing: 'refs/remotes/d/x',
          adapt: browserLike,
        },
      ])(
        'Then $label refuses FILE_EXISTS naming it and changes nothing',
        async ({ layout, update, existing, adapt }) => {
          // Arrange
          const base = await seed(layout);
          const packedBefore = await base.fs.readUtf8(PACKED);
          const sut = createRefStore(adapt(base));

          // Act
          let caught: unknown;
          try {
            await sut.applyRefUpdates([update as RefUpdate]);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'FILE_EXISTS',
            path: `/repo/.git/${existing}`,
          });
          expect(await base.fs.readUtf8(PACKED)).toBe(packedBefore);
          expect(await base.fs.exists('/repo/.git/refs/remotes/d.lock')).toBe(false);
          expect(await sut.resolveDirect(D)).toEqual({ kind: 'missing' });
        },
      );

      it('Then writing HEAD never reads packed-refs for refs under it', async () => {
        // Arrange
        const base = await seed({ packed: ['refs/remotes/d/x'] });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'set', name: 'HEAD' as RefName, id: NEW_ID }]);

        // Assert
        expect(calls().filter((c) => c.path === PACKED)).toEqual([]);
      });

      it('Then a held lock on refs/remotes/d refuses REF_LOCKED first, as git takes the lock before checking', async () => {
        // Arrange
        const base = await seed({ packed: ['refs/remotes/d/x'] });
        await base.fs.write('/repo/.git/refs/remotes/d.lock', new Uint8Array(0));
        const sut = createRefStore(base);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([{ kind: 'set', name: D, id: NEW_ID }]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'REF_LOCKED', name: D });
      });
    });
  });

  describe("Given the loose ref's parent directory cannot be stat'ed for a reason other than absence", () => {
    describe('When applyRefUpdates deletes the ref', () => {
      it('Then that error propagates and the loose file stays', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/lo' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const denied = permissionDenied('/repo/.git/refs/heads');
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            stat: async (path) => {
              if (path === '/repo/.git/refs/heads') throw denied;
              return base.fs.stat(path);
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/lo' as RefName }]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(denied);
        expect(await base.fs.exists('/repo/.git/refs/heads/lo')).toBe(true);
      });
    });
  });

  describe('Given an adapter that reports removing a non-empty directory as absent, and a sibling ref remaining', () => {
    describe('When applyRefUpdates deletes the other ref in the nested directory', () => {
      it('Then the delete completes and the directory and sibling are kept', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [
            { name: 'refs/remotes/origin/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/remotes/origin/dev' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            rm: async (path) => {
              if (path === '/repo/.git/refs/remotes/origin') throw fileNotFound(path);
              return base.fs.rm(path);
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'delete', name: 'refs/remotes/origin/main' as RefName },
        ]);

        // Assert
        expect(await base.fs.exists('/repo/.git/refs/remotes/origin/main')).toBe(false);
        expect(await base.fs.exists('/repo/.git/refs/remotes/origin/dev')).toBe(true);
      });
    });
  });

  describe('Given a nested directory whose removal fails for a reason other than being non-empty or absent', () => {
    describe('When applyRefUpdates deletes the only ref in it', () => {
      it('Then that error propagates after the ref is gone', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [{ name: 'refs/remotes/origin/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const denied = permissionDenied('/repo/.git/refs/remotes/origin');
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            rm: async (path) => {
              if (path === '/repo/.git/refs/remotes/origin') throw denied;
              return base.fs.rm(path);
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([
            { kind: 'delete', name: 'refs/remotes/origin/main' as RefName },
          ]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(denied);
        expect(await base.fs.exists('/repo/.git/refs/remotes/origin/main')).toBe(false);
      });
    });
  });

  describe('Given HEAD has the only reflog in the repository', () => {
    describe('When applyRefUpdates deletes HEAD through the store', () => {
      it('Then logs/ itself survives — the refs/ pruning never applies to a bare pseudo-ref', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'HEAD' as RefName, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'HEAD' as RefName }]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/logs')).toBe(true);
      });
    });
  });

  describe('Given the only branch in the repository', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then refs/heads itself survives empty, matching git', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/main' as RefName }]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads')).toBe(true);
        expect(await ctx.fs.readdir('/repo/.git/refs/heads')).toEqual([]);
      });
    });
  });

  describe('Given a sibling ref remaining under a nested namespace directory', () => {
    describe('When applyRefUpdates deletes the other ref in it', () => {
      it('Then the directory is kept — it is not empty', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/remotes/origin/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/remotes/origin/dev' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'delete', name: 'refs/remotes/origin/main' as RefName },
        ]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/remotes/origin')).toBe(true);
        expect(await ctx.fs.exists('/repo/.git/refs/remotes/origin/dev')).toBe(true);
      });
    });
  });

  describe('Given a packed-refs.lock already held', () => {
    describe('When a delete of a packed-only ref is applied', () => {
      it('Then it refuses RESOURCE_LOCKED naming the ref resource and packed-refs.lock path', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/p' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        await ctx.fs.write('/repo/.git/packed-refs.lock', new Uint8Array(0));
        const sut = createRefStore(ctx);

        // Act + Assert
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/tags/p' as RefName }]);
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('RESOURCE_LOCKED');
          if (data.code === 'RESOURCE_LOCKED') {
            expect(data.resource).toBe('ref');
            expect(data.path).toBe('/repo/.git/packed-refs.lock');
          }
        }
      });
    });

    describe('When a delete of a loose-only ref is applied', () => {
      it('Then it refuses RESOURCE_LOCKED and the loose file stays', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/lo' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        await ctx.fs.write('/repo/.git/packed-refs.lock', new Uint8Array(0));
        const sut = createRefStore(ctx);

        // Act + Assert
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/lo' as RefName }]);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('RESOURCE_LOCKED');
        }
        expect(await ctx.fs.exists('/repo/.git/refs/heads/lo')).toBe(true);
      });
    });

    describe('When a delete of an absent ref is applied', () => {
      it('Then it refuses RESOURCE_LOCKED too — the no-op delete is still gated by the lock', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/packed-refs.lock', new Uint8Array(0));
        const sut = createRefStore(ctx);

        // Act + Assert
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/never' as RefName }]);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('RESOURCE_LOCKED');
        }
      });
    });
  });

  describe('Given a <ref>.lock already held', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then it refuses REF_LOCKED naming the ref, winning over a held packed-refs.lock', async () => {
        // Arrange — both locks are held; REF_LOCKED must win since the
        // loose-ref lock is acquired before the packed-refs lock is ever
        // attempted.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/busy' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        await ctx.fs.write('/repo/.git/refs/heads/busy.lock', new Uint8Array(0));
        await ctx.fs.write('/repo/.git/packed-refs.lock', new Uint8Array(0));
        const sut = createRefStore(ctx);

        // Act + Assert
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/busy' as RefName }]);
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REF_LOCKED');
          if (data.code === 'REF_LOCKED') expect(data.name).toBe('refs/heads/busy');
        }
      });
    });
  });

  describe('Given an absent ref under a directory that does not exist', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then it resolves without creating the intermediate directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'delete', name: 'refs/heads/deep/er/absent' as RefName },
        ]);

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/deep')).toBe(false);
      });
    });
  });

  describe('Given a malformed packed-refs file', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then it refuses INVALID_PACKED_REFS, leaves the loose file intact and removes the lock', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/lo' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        await ctx.fs.writeUtf8('/repo/.git/packed-refs', 'not-a-line\n');
        const sut = createRefStore(ctx);

        // Act + Assert
        try {
          await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/lo' as RefName }]);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
        }
        expect(await ctx.fs.exists('/repo/.git/refs/heads/lo')).toBe(true);
        expect(await ctx.fs.exists('/repo/.git/packed-refs.lock')).toBe(false);
      });
    });
  });

  describe('Given HEAD deleted through the store', () => {
    describe('When applyRefUpdates applies a delete update', () => {
      it('Then the HEAD slot is invalidated — a later resolveDirect(HEAD) observes it missing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', `${'a'.repeat(40)}\n`);
        await assertRepository(ctx);
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'HEAD' as RefName }]);
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'missing' });
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

  describe('Given listRefNames already ran once', () => {
    describe('When resolveDirect looks up a packed-only ref afterward', () => {
      it('Then it still resolves correctly — resolution does not depend on listRefNames having run first', async () => {
        // Arrange — `listRefNames`/`listRefs` scan `packed.entries` directly
        // and never call `packed.byName()`, so this only proves the two
        // paths coexist correctly against the same cached `loaded` instance,
        // not that `byName()`'s index is built lazily (that stays an
        // internal memoisation detail, unobserved here).
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);
        await sut.listRefNames();

        // Act
        const result = await sut.resolveDirect('refs/tags/v1' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: 'b'.repeat(40) });
      });
    });
  });

  describe('Given a delete update on a ref that exists in neither loose nor packed storage', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then it resolves without creating anything', async () => {
        // Arrange
        // Kills the `if (await ctx.fs.exists(path))` ConditionalExpression `true`
        // mutant: under `true`, rm is always called and would fail on missing path.
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/never' as RefName }]);

        // Assert
        expect(await sut.resolveDirect('refs/heads/never' as RefName)).toEqual({
          kind: 'missing',
        });
        expect(await ctx.fs.exists('/repo/.git/refs/heads/never')).toBe(false);
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

  describe('Given packed-refs is absent', () => {
    describe('When resolveDirect falls through to loadPackedRefs', () => {
      it('Then it issues one stat and no exists probe on the packed-refs path', async () => {
        // Arrange
        // Kills a mutant that reintroduces the old `exists`-then-`stat` pair:
        // the packed-refs path must see exactly one `stat` call and zero
        // `exists` calls.
        const base = await buildSeededContext();
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);
        const packedPath = `${ctx.layout.gitDir}/packed-refs`;

        // Act
        await sut.resolveDirect('refs/tags/missing' as RefName);

        // Assert
        expect(calls().filter((c) => c.path === packedPath)).toEqual([
          { method: 'stat', path: packedPath },
        ]);
      });
    });
  });

  describe('Given a directory sitting at the packed-refs path', () => {
    describe('When resolveDirect falls through to loadPackedRefs', () => {
      it('Then the filesystem fault still propagates instead of reading as absent packed-refs', async () => {
        // Arrange — the `stat`-based absence check must scope its
        // FILE_NOT_FOUND swallow to the `stat` call alone: a directory
        // stats successfully (isDirectory: true) and only fails downstream,
        // at the read step. A mutant that widens the try/catch to also cover
        // that read would wrongly resolve this as "no packed refs".
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/packed-refs`);
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.resolveDirect('refs/tags/missing' as RefName);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert — a directory read refuses PERMISSION_DENIED, as the Node adapter's EISDIR
        // mapping does
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('PERMISSION_DENIED');
        if (data.code === 'PERMISSION_DENIED') {
          expect(data.path).toBe(`${ctx.layout.gitDir}/packed-refs`);
        }
      });
    });
  });

  describe('Given packed refs listed in descending name order', () => {
    describe('When listRefNames runs with no prefix', () => {
      it('Then the result is still sorted ascending — the comparator actually swaps', async () => {
        // Arrange — descending insertion order forces `.sort` to actually
        // reorder elements; an already-ascending fixture would pass even
        // with a comparator that never returns 1.
        const ctx = await buildSeededContext({
          packedRefs: [
            { name: 'refs/heads/zebra' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/mango' as RefName, id: 'b'.repeat(40) as ObjectId },
            { name: 'refs/heads/apple' as RefName, id: 'c'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefNames();

        // Assert
        expect(result).toEqual(['refs/heads/apple', 'refs/heads/mango', 'refs/heads/zebra']);
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

  describe('Given the same ref name loose AND packed (loose shadows packed)', () => {
    describe('When listing refs with no prefix', () => {
      it('Then exactly one entry is returned, carrying the LOOSE oid', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: 'c'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs();

        // Assert — a flipped/dropped `!looseSet.has(entry.name)` dedup guard
        // would emit the packed oid as a second, duplicate entry.
        const matches = result.filter((entry) => entry.name === 'refs/heads/main');
        expect(matches).toHaveLength(1);
        expect(matches[0]?.value).toEqual({ kind: 'direct', id: 'a'.repeat(40) });
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

  describe('Given 64 packed-only tag names and no loose refs', () => {
    describe('When listRefs runs with the tags prefix', () => {
      it('Then no packed-only name is probed as a loose file', async () => {
        // Arrange — before this part, each packed-only name still went
        // through `resolveEntry`, costing one `readUtf8` ENOENT per name;
        // the snapshot already carries every packed oid.
        const packedRefs = Array.from({ length: 64 }, (_, i) => ({
          name: `refs/tags/t${String(i).padStart(3, '0')}` as RefName,
          id: (i % 10 === 9 ? 'f' : `${i % 10}`).repeat(40) as ObjectId,
        }));
        const base = await buildSeededContext({ packedRefs });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);
        const tagsDir = `${ctx.layout.gitDir}/refs/tags/`;

        // Act
        const result = await sut.listRefs('refs/tags/' as RefName);

        // Assert
        expect(result).toHaveLength(64);
        expect(calls().some((c) => LOOSE_READS.has(c.method) && c.path.startsWith(tagsDir))).toBe(
          false,
        );
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

  describe('Given a prefix that is exactly refs, with no trailing slash', () => {
    describe('When listing refs with that prefix', () => {
      it('Then the whole refs tree is still walked — the boundary itself still matches', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs('refs' as RefName);

        // Assert
        expect(result.map((entry) => entry.name)).toEqual(['refs/heads/main']);
      });
    });
  });

  describe('Given a prefix that is a single segment directly under refs/, with no further slash', () => {
    describe('When listing refs with that prefix', () => {
      it('Then the walk root pushes down only to refs itself, not the slash-free segment', async () => {
        // Arrange — isolates `lastSlash === -1` (no further `/` after
        // `refs/`), never exercised by the mid-segment fixture below (which
        // always has a further `/` to find).
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/tags/v1' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/main' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.listRefs('refs/tags' as RefName);

        // Assert
        expect(result.map((entry) => entry.name)).toEqual(['refs/tags/v1']);
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
        // a `refs/**` directory. The pre-push-down whole-tree walk would
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

  describe('Given the refs root cannot be statted for a reason other than FILE_NOT_FOUND', () => {
    describe('When listing refs', () => {
      it('Then the fault propagates rather than reading as an absent refs directory', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const refsRoot = `${ctx.layout.gitDir}/refs`;
        const fault = permissionDenied(refsRoot);
        const originalStat = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) => {
          if (path === refsRoot) throw fault;
          return originalStat(path);
        });
        const sut = createRefStore(ctx);

        // Act + Assert
        await expect(sut.listRefs()).rejects.toBe(fault);
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

  describe('Given a symlinked HEAD whose link text is a valid refname outside refs/', () => {
    describe('When resolveDirect(HEAD) runs', () => {
      it('Then the link is read through to the file it names, never reported symbolic', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = 'a'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8('/repo/.git/heads/main', `${id}\n`);
        await ctx.fs.symlink('heads/main', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id });
      });
    });
  });

  describe('Given a SYMLINKED HEAD whose link text names a ref', () => {
    describe('When resolveDirect(HEAD) runs', () => {
      it('Then it reports symbolic, matching git, without dereferencing the link', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.symlink('refs/heads/main', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
      });
    });
  });

  describe('Given a DANGLING symlinked HEAD (its target ref does not exist)', () => {
    describe('When resolveDirect(HEAD) runs', () => {
      it('Then it still reports symbolic — judged by link text, not target existence', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.symlink('refs/heads/ghost', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/ghost' });
      });
    });
  });

  describe('Given a symlinked HEAD whose link text is refs/-prefixed but not a valid refname', () => {
    describe('When resolveDirect(HEAD) runs', () => {
      it('Then an absent target reads through to missing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.symlink('refs/heads/a..b', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'missing' });
      });

      it('Then a target file holding an oid reads through to a direct result', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = 'a'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/a..b', `${id}\n`);
        await ctx.fs.symlink('refs/heads/a..b', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert — proves the read-through: a dangling link's `missing` alone would pass
        // on any adapter without ever reading the target
        expect(result).toEqual({ kind: 'direct', id });
      });

      it('Then a target file holding a symbolic-ref line reads through to a symbolic result', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/a..b', 'ref: refs/heads/side\n');
        await ctx.fs.symlink('refs/heads/a..b', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/side' });
      });

      it('Then a link text with a `..` segment that resolves to a valid refname still reads through', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = 'b'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/side', `${id}\n`);
        await ctx.fs.symlink('refs/heads/../heads/side', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id });
      });

      it('Then a `.lock`-suffixed link text reads through', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = 'c'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/x.lock', `${id}\n`);
        await ctx.fs.symlink('refs/heads/x.lock', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id });
      });

      it('Then a link text carrying a space reads through', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = 'd'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/sp ace', `${id}\n`);
        await ctx.fs.symlink('refs/heads/sp ace', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id });
      });

      it('Then a directory at the target path reads through to missing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir('/repo/.git/refs/heads/a..b');
        await ctx.fs.symlink('refs/heads/a..b', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert — the directory check runs before the read, so this stays `missing`
        // rather than surfacing the memory adapter's PERMISSION_DENIED directory-read refusal
        expect(result).toEqual({ kind: 'missing' });
      });

      it('Then a backslash-separated link text is normalised before the refname check', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.symlink('refs\\heads\\main', '/repo/.git/HEAD');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
      });

      it.each([
        { label: 'content that is neither an id nor a ref line', content: 'PRIVATE-LINE\n' },
        { label: 'a ref line naming an invalid refname', content: 'ref: refs/heads/..PRIVATE\n' },
      ])(
        'Then $label refuses INVALID_REF for HEAD without echoing the followed bytes',
        async ({ content }) => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.writeUtf8('/repo/secret.txt', content);
          await ctx.fs.symlink('refs/../../secret.txt', '/repo/.git/HEAD');
          const sut = createRefStore(ctx);

          // Act
          let caught: unknown;
          try {
            await sut.resolveDirect('HEAD' as RefName);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_REF',
            reason: 'HEAD is a symbolic link to content that is not a ref',
          });
          expect(JSON.stringify((caught as TsgitError).data)).not.toContain('PRIVATE');
        },
      );

      it('Then a stat fault on the followed target propagates instead of reading as missing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.symlink('refs/heads/a..b', '/repo/.git/HEAD');
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (p: string) =>
              p === '/repo/.git/HEAD' ? Promise.reject(permissionDenied(p)) : ctx.fs.stat(p),
          },
        };
        const sut = createRefStore(wrappedCtx);

        // Act
        let caught: unknown;
        try {
          await sut.resolveDirect('HEAD' as RefName);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given loose refs holding content that is not a ref', () => {
    describe('When resolveDirect reads each', () => {
      it('Then a symlinked ref refuses INVALID_REF naming it without echoing the followed bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/secret.txt', 'PRIVATE-LINE\n');
        await ctx.fs.symlink('../../../secret.txt', '/repo/.git/refs/heads/x');
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.resolveDirect('refs/heads/x' as RefName);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'refs/heads/x is a symbolic link to content that is not a ref',
        });
        expect(JSON.stringify((caught as TsgitError).data)).not.toContain('PRIVATE');
      });

      it('Then a regular ref file refuses INVALID_REF naming it, never echoing its bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/g', 'garbage\n');
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.resolveDirect('refs/heads/g' as RefName);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'refs/heads/g is broken',
        });
      });

      it('Then a name composed through a symlinked directory refuses without the file bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir('/repo/foreign');
        await ctx.fs.writeUtf8('/repo/foreign/passwd', `PRIVATE-LINE\n${'z'.repeat(5000)}\n`);
        await ctx.fs.symlink('../../../foreign', '/repo/.git/refs/heads/x');
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.resolveDirect('refs/heads/x/passwd' as RefName);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'refs/heads/x/passwd is broken',
        });
        expect(JSON.stringify((caught as TsgitError).data)).not.toContain('PRIVATE');
      });
    });
  });

  describe('Given a gate already validated a symlinked, format-invalid HEAD on this Context', () => {
    describe('When resolveDirect(HEAD) is called again after the target is rewritten', () => {
      it('Then the freshly-read target is returned — the followed content is never slotted', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idX = 'e'.repeat(40) as ObjectId;
        const idY = 'f'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/a..b', `${idX}\n`);
        await ctx.fs.symlink('refs/heads/a..b', '/repo/.git/HEAD');
        await validateHead(ctx);
        const sut = createRefStore(ctx);
        const first = await sut.resolveDirect('HEAD' as RefName);

        // Act
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/a..b', `${idY}\n`);
        const second = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(first).toEqual({ kind: 'direct', id: idX });
        expect(second).toEqual({ kind: 'direct', id: idY });
        expect((await ctx.fs.lstat('/repo/.git/HEAD')).isSymbolicLink).toBe(true);
      });
    });
  });

  describe('Given a gate has already validated HEAD on this Context', () => {
    describe('When resolveDirect(HEAD) runs afterward', () => {
      it("Then it issues no readUtf8 at all — the store shares the gate's read", async () => {
        // Arrange — the gate must run against the SAME Context object the
        // store resolves against: the slot is keyed on Context identity, so
        // a freshly-derived instrumented Context would never see it.
        const base = await buildSeededContext();
        await base.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
        const { ctx, calls } = instrumentedContext(base);
        await assertRepository(ctx);
        const sut = createRefStore(ctx);
        const before = calls().length;

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);
        const duringCall = calls().slice(before);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
        expect(duringCall).toEqual([]);
      });
    });
  });

  describe('Given a primitive-only sequence that never calls the gate', () => {
    describe('When resolveDirect(HEAD) runs twice in a row', () => {
      it('Then each call re-validates by lstat — neither trusts the other', async () => {
        // Arrange
        const base = await buildSeededContext();
        await base.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        await sut.resolveDirect('HEAD' as RefName);
        const firstLstats = calls().filter(
          (c) => c.method === 'lstat' && c.path === '/repo/.git/HEAD',
        ).length;
        await sut.resolveDirect('HEAD' as RefName);
        const totalLstats = calls().filter(
          (c) => c.method === 'lstat' && c.path === '/repo/.git/HEAD',
        ).length;

        // Assert
        expect(firstLstats).toBe(1);
        expect(totalLstats).toBe(2);
      });
    });
  });

  describe('Given HEAD is unreadable (EACCES-equivalent) at the lstat probe', () => {
    describe('When resolveDirect(HEAD) runs', () => {
      it('Then it rethrows PERMISSION_DENIED rather than collapsing to missing', async () => {
        // Arrange
        const base = await buildSeededContext();
        await base.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
        const target = '/repo/.git/HEAD';
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            lstat: async (path: string) => {
              if (path === target) throw permissionDenied(path);
              return base.fs.lstat(path);
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.resolveDirect('HEAD' as RefName);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given a trusted HEAD slot from a prior gate check', () => {
    describe('When applyRefUpdates sets HEAD symbolically', () => {
      it('Then the slot is invalidated — a later resolveDirect(HEAD) observes the new target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
        await assertRepository(ctx);
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'setSymbolic', name: 'HEAD' as RefName, target: 'refs/heads/other' as RefName },
        ]);
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/other' });
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

  describe('Given loose refs whose content is never read for listRefNames', () => {
    describe('When listRefNames runs', () => {
      it('Then no loose ref file content is read — names only', async () => {
        // Arrange
        const base = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/other' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const { ctx, calls } = instrumentedContext(base);
        const sut = createRefStore(ctx);

        // Act
        const names = await sut.listRefNames();

        // Assert — scoped to the loose refs tree: an unrelated legitimate
        // readUtf8 (a `core.*` config read, say) is not this test's concern
        // and must not turn it red for an unrelated reason.
        expect(names).toEqual(['refs/heads/main', 'refs/heads/other']);
        const looseRefsDir = `${ctx.layout.gitDir}/refs/`;
        expect(
          calls().some((c) => LOOSE_READS.has(c.method) && c.path.startsWith(looseRefsDir)),
        ).toBe(false);
      });
    });
  });

  describe('Given resolveDirect throws something other than a TsgitError while listing', () => {
    describe('When listing refs', () => {
      it('Then the fault propagates rather than silently excluding the ref', async () => {
        // Arrange — distinct from the malformed-loose-ref case below, which
        // is a recognised TsgitError parse failure the enumeration is
        // designed to tolerate; an UNEXPECTED failure shape must still
        // surface as a bug, not vanish from the listing.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const loosePath = `${ctx.layout.gitDir}/refs/heads/main`;
        const fault = new Error('boom');
        const originalOpen = ctx.fs.openWithNoFollow.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'openWithNoFollow').mockImplementation(async (path, mode) => {
          if (path === loosePath) throw fault;
          return originalOpen(path, mode);
        });
        const sut = createRefStore(ctx);

        // Act + Assert
        await expect(sut.listRefs()).rejects.toBe(fault);
      });
    });
  });

  describe('Given a loose ref whose body is neither an oid nor a symbolic ref', () => {
    describe('When listRefNames runs', () => {
      it('Then the malformed ref name is still included, unlike listRefs', async () => {
        // Arrange — listRefNames is the pre-migration "zero per-ref reads"
        // enumeration: it never opens a loose file to validate its content,
        // so a name it finds is reported regardless of what that file holds.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/garbage', 'not-a-valid-sha\n');
        const sut = createRefStore(ctx);

        // Act
        const names = await sut.listRefNames();
        const entries = await sut.listRefs();

        // Assert
        expect(names).toContain('refs/heads/garbage');
        expect(entries.map((entry) => entry.name)).not.toContain('refs/heads/garbage');
      });
    });
  });

  describe('Given a loose ref whose body is neither an oid nor a symbolic ref', () => {
    describe('When verifyIntegrity is called', () => {
      it('Then a badRefContent finding is returned, marked as reachable without a link', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/garbage', 'not-a-valid-sha\n');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(result).toContainEqual({
          ref: 'refs/heads/garbage',
          msgId: 'badRefContent',
          throughSymlink: false,
        });
      });
    });
  });

  describe('Given a link onto a ref whose body is neither an oid nor a symbolic ref', () => {
    describe('When verifyIntegrity is called', () => {
      it('Then the linked name is marked as read through a link, the real name is not', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/garbage', 'not-a-valid-sha\n');
        await ctx.fs.symlink('garbage', '/repo/.git/refs/heads/link');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(
          result
            .filter((f) => 'msgId' in f && f.msgId === 'badRefContent')
            .slice()
            .sort((a, b) => ('ref' in a && 'ref' in b && a.ref < b.ref ? -1 : 1)),
        ).toEqual([
          { ref: 'refs/heads/garbage', msgId: 'badRefContent', throughSymlink: false },
          { ref: 'refs/heads/link', msgId: 'badRefContent', throughSymlink: true },
        ]);
      });
    });
  });

  describe('Given a link onto a directory holding a ref with an unreadable body', () => {
    describe('When verifyIntegrity is called', () => {
      it('Then the name beneath the link is marked as read through a link', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/other/garbage', 'not-a-valid-sha\n');
        await ctx.fs.symlink('../other', '/repo/.git/refs/heads/dl');
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(
          result
            .filter((f) => 'msgId' in f && f.msgId === 'badRefContent')
            .slice()
            .sort((a, b) => ('ref' in a && 'ref' in b && a.ref < b.ref ? -1 : 1)),
        ).toEqual([
          { ref: 'refs/heads/dl/garbage', msgId: 'badRefContent', throughSymlink: true },
          { ref: 'refs/other/garbage', msgId: 'badRefContent', throughSymlink: false },
        ]);
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

  describe('Given more loose ref names than the ioBound limit', () => {
    describe('When listRefs runs', () => {
      it('Then loose-name resolution peaks at exactly the bound, and the result stays sorted', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a
        // bucket-swap regression fails loudly. A `boundedMapFor` →
        // `for…await` mutant would read a max in-flight of 1 here.
        const ioBound = 4;
        const width = 64;
        const refs = Array.from({ length: width }, (_, i) => ({
          name: `refs/heads/b${String(i).padStart(3, '0')}` as RefName,
          id: (i % 10 === 9 ? 'f' : `${i % 10}`).repeat(40) as ObjectId,
        }));
        const base = await buildSeededContext({ refs });
        const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
        let inFlight = 0;
        let maxInFlight = 0;
        const originalOpen = ctx.fs.openWithNoFollow.bind(ctx.fs);
        const instrumented: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path, mode) => {
              inFlight += 1;
              if (inFlight > maxInFlight) maxInFlight = inFlight;
              await Promise.resolve();
              inFlight -= 1;
              return originalOpen(path, mode);
            },
          },
        };
        const sut = createRefStore(instrumented);

        // Act
        const result = await sut.listRefs();

        // Assert
        expect(maxInFlight).toBe(ioBound);
        expect(result.map((entry) => entry.name)).toEqual(
          refs
            .map((ref) => ref.name)
            .slice()
            .sort(),
        );
      });
    });
  });

  describe('Given a ref and refs under its name coexisting across loose and packed storage', () => {
    const header = '# pack-refs with: peeled fully-peeled sorted ';
    const blob = (ctx: Context, text: string): Promise<ObjectId> =>
      writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode(text),
      });

    describe('When packRefs packs a loose file refs/remotes/q with a packed refs/remotes/q/z', () => {
      it('Then both are packed and the loose file is pruned, as git pack-refs --all does', async () => {
        // Arrange
        const base = await buildSeededContext();
        const idQ = await blob(base, 'q');
        const idZ = await blob(base, 'q/z');
        await base.fs.writeUtf8('/repo/.git/refs/remotes/q', `${idQ}\n`);
        await base.fs.writeUtf8('/repo/.git/packed-refs', `${header}\n${idZ} refs/remotes/q/z\n`);
        const sut = createRefStore(base);

        // Act
        const result = await sut.packRefs();

        // Assert
        expect(result).toEqual({
          packedRefCount: 2,
          prunedLooseRefCount: 1,
          removedOrphanCount: 0,
        });
        expect(await base.fs.readUtf8('/repo/.git/packed-refs')).toBe(
          `${header}\n${idQ} refs/remotes/q\n${idZ} refs/remotes/q/z\n`,
        );
        expect(await base.fs.exists('/repo/.git/refs/remotes/q')).toBe(false);
      });
    });

    describe('When packRefs packs a packed refs/remotes/d with a loose refs/remotes/d/x', () => {
      it('Then both are packed and only the loose file under it is pruned', async () => {
        // Arrange
        const base = await buildSeededContext();
        const idD = await blob(base, 'd');
        const idX = await blob(base, 'd/x');
        await base.fs.writeUtf8('/repo/.git/refs/remotes/d/x', `${idX}\n`);
        await base.fs.writeUtf8('/repo/.git/packed-refs', `${header}\n${idD} refs/remotes/d\n`);
        const sut = createRefStore(base);

        // Act
        const result = await sut.packRefs();

        // Assert
        expect(result).toEqual({
          packedRefCount: 2,
          prunedLooseRefCount: 1,
          removedOrphanCount: 0,
        });
        expect(await base.fs.readUtf8('/repo/.git/packed-refs')).toBe(
          `${header}\n${idD} refs/remotes/d\n${idX} refs/remotes/d/x\n`,
        );
        expect(await base.fs.exists('/repo/.git/refs/remotes/d/x')).toBe(false);
      });
    });

    describe('When the refs are listed and the one under a loose file is resolved', () => {
      it('Then both are listed, as git for-each-ref lists them, while the blocked name does not resolve', async () => {
        // Arrange
        const base = await buildSeededContext();
        const id = 'a'.repeat(40) as ObjectId;
        await base.fs.writeUtf8('/repo/.git/refs/remotes/q', `${id}\n`);
        await base.fs.writeUtf8('/repo/.git/packed-refs', `${header}\n${id} refs/remotes/q/z\n`);
        const sut = createRefStore(base);

        // Act
        const names = await sut.listRefNames();
        const entries = await sut.listRefs();

        // Assert
        expect(names).toEqual(['refs/remotes/q', 'refs/remotes/q/z']);
        expect(entries).toEqual([
          { name: 'refs/remotes/q', value: { kind: 'direct', id } },
          { name: 'refs/remotes/q/z', value: { kind: 'direct', id } },
        ]);
        // git's own read stops at the regular file in the path and never
        // reaches `packed-refs`, so the name resolves to nothing at all.
        expect(await sut.resolveDirect('refs/remotes/q/z' as RefName)).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given more packable loose refs than the ioBound limit', () => {
    describe('When packRefs probes which packed entries still have a duplicate loose file', () => {
      it('Then the existence probe peaks at exactly the bound', async () => {
        // Arrange
        const ioBound = 3;
        const width = ioBound + 4;
        const base = await buildSeededContext();
        for (let i = 0; i < width; i++) {
          const id = await writeObject(base, {
            type: 'blob',
            content: new TextEncoder().encode(`prune-probe-${i}`),
            id: '' as ObjectId,
          });
          const name = `refs/heads/b${String(i).padStart(3, '0')}`;
          await base.fs.writeUtf8(`${base.layout.gitDir}/${name}`, `${id}\n`);
        }
        const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const looseHeadsDir = `${ctx.layout.gitDir}/refs/heads/`;
        let inFlight = 0;
        let maxInFlight = 0;
        const originalLstat = ctx.fs.lstat.bind(ctx.fs);
        const instrumented: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              if (!path.startsWith(looseHeadsDir)) return originalLstat(path);
              inFlight += 1;
              if (inFlight > maxInFlight) maxInFlight = inFlight;
              await Promise.resolve();
              inFlight -= 1;
              return originalLstat(path);
            },
          },
        };
        const sut = createRefStore(instrumented);

        // Act
        const result = await sut.packRefs();

        // Assert
        expect(result.prunedLooseRefCount).toBe(width);
        expect(maxInFlight).toBe(ioBound);
      });
    });

    describe('When packRefs removes the loose files it just packed', () => {
      it('Then the removal peaks at exactly the bound', async () => {
        // Arrange
        const ioBound = 3;
        const width = ioBound + 4;
        const base = await buildSeededContext();
        for (let i = 0; i < width; i++) {
          const id = await writeObject(base, {
            type: 'blob',
            content: new TextEncoder().encode(`prune-rm-${i}`),
            id: '' as ObjectId,
          });
          const name = `refs/heads/b${String(i).padStart(3, '0')}`;
          await base.fs.writeUtf8(`${base.layout.gitDir}/${name}`, `${id}\n`);
        }
        const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const looseHeadsDir = `${ctx.layout.gitDir}/refs/heads/`;
        let inFlight = 0;
        let maxInFlight = 0;
        const originalRm = ctx.fs.rm.bind(ctx.fs);
        const instrumented: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rm: async (path: string) => {
              if (!path.startsWith(looseHeadsDir)) return originalRm(path);
              inFlight += 1;
              if (inFlight > maxInFlight) maxInFlight = inFlight;
              await Promise.resolve();
              inFlight -= 1;
              return originalRm(path);
            },
          },
        };
        const sut = createRefStore(instrumented);

        // Act
        const result = await sut.packRefs();

        // Assert
        expect(result.prunedLooseRefCount).toBe(width);
        expect(maxInFlight).toBe(ioBound);
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

        // Assert — files-backend reads attach `raw` (the on-disk byte
        // slices), so the entry is a superset of the appended fixture.
        expect(result).toEqual([expect.objectContaining(first), expect.objectContaining(second)]);
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

  describe('Given a reflog path that is a directory because a sibling ref nests under it', () => {
    describe('When readReflogLenient is called on the store', () => {
      it('Then it answers no-reflog with an empty array, never a raw EISDIR', async () => {
        // Arrange — same D/F shape hasReflog handles; the read path must
        // give the same "absent" answer instead of surfacing an adapter
        // fault from reading a directory.
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'refs/heads/feature/x' as RefName, reflogEntry());
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.readReflogLenient('refs/heads/feature' as RefName);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a reflog stat fails for a reason other than FILE_NOT_FOUND', () => {
    describe('When readReflog is called on the store', () => {
      it('Then the fault propagates rather than reading as an empty reflog', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'refs/heads/main' as RefName, reflogEntry());
        const reflogFilePath = `${ctx.layout.gitDir}/logs/refs/heads/main`;
        const fault = permissionDenied(reflogFilePath);
        const originalStat = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) => {
          if (path === reflogFilePath) throw fault;
          return originalStat(path);
        });
        const sut = createRefStore(ctx);

        // Act + Assert
        await expect(sut.readReflog('refs/heads/main' as RefName)).rejects.toBe(fault);
      });
    });
  });

  describe('Given a reflog stat fails for a reason other than FILE_NOT_FOUND', () => {
    describe('When hasReflog is called on the store', () => {
      it('Then the fault propagates rather than reading as no reflog', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'refs/heads/main' as RefName, reflogEntry());
        const reflogFilePath = `${ctx.layout.gitDir}/logs/refs/heads/main`;
        const fault = permissionDenied(reflogFilePath);
        const originalStat = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) => {
          if (path === reflogFilePath) throw fault;
          return originalStat(path);
        });
        const sut = createRefStore(ctx);

        // Act + Assert
        await expect(sut.hasReflog('refs/heads/main' as RefName)).rejects.toBe(fault);
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

  describe('Given a files-backed reflog with a garbage line between two valid entries', () => {
    describe('When readReflogLenient runs', () => {
      it('Then both valid entries are returned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const first = reflogEntry({ message: 'first' });
        const second = reflogEntry({ oldId: first.newId, message: 'second' });
        await appendReflog(ctx, 'refs/heads/main' as RefName, first);
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/logs/refs/heads/main`,
          'this is not a valid reflog line at all\n',
        );
        await appendReflog(ctx, 'refs/heads/main' as RefName, second);
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.readReflogLenient('refs/heads/main' as RefName);

        // Assert — files-backend reads attach `raw` (the on-disk byte
        // slices), so each entry is a superset of the appended fixture.
        expect(result).toEqual([expect.objectContaining(first), expect.objectContaining(second)]);
      });
    });
  });

  describe('Given a files-backed reflog file one byte past MAX_REFLOG_BYTES', () => {
    describe('When readReflogLenient runs', () => {
      it('Then it still throws INVALID_REFLOG_ENTRY — the cap is not tolerated', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/logs/refs/heads/main`,
          'x'.repeat(MAX_REFLOG_BYTES + 1),
        );
        const sut = createRefStore(ctx);

        // Act + Assert
        try {
          await sut.readReflogLenient('refs/heads/main' as RefName);
          expect.fail('expected INVALID_REFLOG_ENTRY');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as TsgitError).data).toEqual({
            code: 'INVALID_REFLOG_ENTRY',
            reason: `reflog file exceeds ${MAX_REFLOG_BYTES} bytes`,
          });
        }
      });
    });
  });

  describe('Given no reflog file for the ref', () => {
    describe('When readReflogLenient runs', () => {
      it('Then it returns an empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.readReflogLenient('refs/heads/absent' as RefName);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a files-backed reflog containing a malformed line', () => {
    describe('When moveReflog moves it to a new ref name', () => {
      it('Then the destination text is byte-identical to the source and the source is gone', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const first = reflogEntry({ message: 'first' });
        const second = reflogEntry({ oldId: first.newId, message: 'second' });
        await appendReflog(ctx, 'refs/heads/main' as RefName, first);
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/logs/refs/heads/main`,
          'this is not a valid reflog line at all\n',
        );
        await appendReflog(ctx, 'refs/heads/main' as RefName, second);
        const before = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`);
        const sut = createRefStore(ctx);

        // Act
        await sut.moveReflog('refs/heads/main' as RefName, 'refs/heads/renamed' as RefName);

        // Assert
        const after = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/renamed`);
        expect(after).toBe(before);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/heads/main`)).toBe(false);
      });
    });
  });

  describe('Given a source ref with no reflog and a destination ref that has one', () => {
    describe('When moveReflog moves the source onto the destination', () => {
      it('Then the destination reflog is kept untouched', async () => {
        // Arrange — the move is pure: dropping the destination's log on a
        // forced rename is the caller's decision (git keeps an orphan log
        // and appends to it; measured, 2.55.0).
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'refs/heads/trunk' as RefName, reflogEntry());
        const before = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/trunk`);
        const sut = createRefStore(ctx);

        // Act
        await sut.moveReflog('refs/heads/main' as RefName, 'refs/heads/trunk' as RefName);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/trunk`)).toBe(before);
      });
    });
  });

  describe('Given a files-backed reflog containing a malformed line', () => {
    describe('When copyReflog copies it to a new ref name', () => {
      it('Then the destination text is byte-identical to the source AND the source survives untouched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const first = reflogEntry({ message: 'first' });
        const second = reflogEntry({ oldId: first.newId, message: 'second' });
        await appendReflog(ctx, 'refs/heads/main' as RefName, first);
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/logs/refs/heads/main`,
          'this is not a valid reflog line at all\n',
        );
        await appendReflog(ctx, 'refs/heads/main' as RefName, second);
        const before = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`);
        const sut = createRefStore(ctx);

        // Act
        await sut.copyReflog('refs/heads/main' as RefName, 'refs/heads/copied' as RefName);

        // Assert
        const after = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/copied`);
        expect(after).toBe(before);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`)).toBe(before);
      });
    });
  });

  describe('Given a source ref with no reflog', () => {
    describe('When copyReflog is called', () => {
      it('Then no destination reflog is created', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        await sut.copyReflog('refs/heads/absent' as RefName, 'refs/heads/copied' as RefName);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/heads/copied`)).toBe(false);
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

        // Assert — reading back parses from disk, so the entry carries `raw`
        // (the on-disk byte slices) on top of the written fields.
        expect(await readReflog(ctx, 'refs/heads/main' as RefName)).toEqual([
          expect.objectContaining(kept),
        ]);
      });
    });
  });

  describe('Given a pre-existing logs/<ref>.lock file', () => {
    describe('When applyRefUpdates applies a reflogReplace update', () => {
      it('Then it refuses with REF_LOCKED', async () => {
        // Arrange — git locks and renames the rewrite; a bare writeUtf8 would
        // ignore the lock file entirely.
        const ctx = await buildSeededContext();
        await appendReflog(ctx, 'refs/heads/main' as RefName, reflogEntry());
        await ctx.fs.write(`${ctx.layout.gitDir}/logs/refs/heads/main.lock`, new Uint8Array([0]));
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([
            {
              kind: 'reflogReplace',
              name: 'refs/heads/main' as RefName,
              entries: [reflogEntry({ message: 'kept' })],
            },
          ]);
          expect.fail('expected REF_LOCKED');
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'REF_LOCKED',
          name: 'refs/heads/main',
        });
      });
    });
  });

  describe('Given a reflogReplace update with an entry whose message is empty', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then the on-disk bytes end with a trailing TAB before the line feed', async () => {
        // Arrange — the rewrite serializer always emits the message TAB, unlike
        // the append writer, which omits it for an empty message.
        const ctx = await buildSeededContext();
        const empty = reflogEntry({ message: '' });
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([
          { kind: 'reflogReplace', name: 'refs/heads/main' as RefName, entries: [empty] },
        ]);

        // Assert
        const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`);
        expect(raw.endsWith('\t\n')).toBe(true);
      });
    });
  });

  describe('Given a reflogReplace update whose only survivor carries a non-UTF-8 byte', () => {
    describe('When applyRefUpdates is called', () => {
      it('Then the reflog is rewritten byte-identical to the original on-disk bytes', async () => {
        // Arrange — a latin1 0xE9 in the message; the files backend must
        // carry it through the read-then-rewrite round trip untouched
        // rather than mangling it through a decode/re-encode.
        const ctx = await buildSeededContext();
        const path = `${ctx.layout.gitDir}/logs/refs/heads/main`;
        const idA = 'a'.repeat(40) as ObjectId;
        const idB = 'b'.repeat(40) as ObjectId;
        const original = new Uint8Array([
          ...new TextEncoder().encode(
            `${idA} ${idB} Ada <ada@example.com> 1716240000 +0000\tmessage caf`,
          ),
          0xe9,
          ...new TextEncoder().encode('\n'),
        ]);
        await ctx.fs.write(path, original);
        const sut = createRefStore(ctx);
        const survivors = await sut.readReflog('refs/heads/main' as RefName);

        // Act
        await sut.applyRefUpdates([
          { kind: 'reflogReplace', name: 'refs/heads/main' as RefName, entries: survivors },
        ]);

        // Assert — file bytes identical, and the read attached the verbatim
        // raw slices the rewrite depends on (the display string carries the
        // U+FFFD the invalid byte decodes to; raw carries the byte itself).
        expect(await ctx.fs.read(path)).toEqual(original);
        expect(survivors[0]?.raw?.message).toEqual(
          Uint8Array.from([...new TextEncoder().encode('message caf'), 0xe9]),
        );
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

  describe('Given a packed snapshot holding several refs', () => {
    describe('When resolveDirect names the byte-smallest of them', () => {
      it('Then the bisection steps back and finds it', async () => {
        // Arrange — a lookup that only ever steps forward lands past every
        // record below the first midpoint, so the first name is the one that
        // proves the search narrows in both directions.
        const ctx = await buildSeededContext({
          packedRefs: [
            { name: 'refs/heads/a' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/b' as RefName, id: 'b'.repeat(40) as ObjectId },
            { name: 'refs/heads/c' as RefName, id: 'c'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/heads/a' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: 'a'.repeat(40) });
      });
    });
  });

  describe('Given a packed-refs file whose lines are out of order under no sorted trait', () => {
    describe('When resolveDirect names one of them', () => {
      it('Then the snapshot is sorted before it is searched', async () => {
        // Arrange — git sorts a snapshot that does not claim the trait once,
        // at load, and every lookup bisects what that leaves; unsorted lines
        // left as they are would be stepped over instead.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/packed-refs`,
          `${'c'.repeat(40)} refs/heads/c\n${'b'.repeat(40)} refs/heads/b\n${'a'.repeat(40)} refs/heads/a\n`,
        );
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/heads/a' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: 'a'.repeat(40) });
      });
    });
  });

  describe('Given an adapter without the no-follow open and a packed-only ref', () => {
    describe('When resolveDirect names it', () => {
      it('Then the absent loose file reads as no such loose ref and the packed value answers', async () => {
        // Arrange — the plain reader decides a refusal the no-follow open
        // cannot; an absent file there is git's `ENOENT`, not a failure.
        const base = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
        });
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            openWithNoFollow: async () => {
              throw unsupportedOperation('openWithNoFollow', 'not supported');
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/tags/v1' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: 'b'.repeat(40) });
      });
    });
  });

  describe('Given a plain reader that refuses a directory with a code of its own', () => {
    describe('When resolveDirect names the directory', () => {
      it('Then a directory at the ref path reads as no such ref', async () => {
        // Arrange — an adapter may report reading a directory however it
        // likes; one `stat` settles it, and git's own `EISDIR` is no ref.
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/dir/child' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const dirPath = `${base.layout.gitDir}/refs/heads/dir`;
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            openWithNoFollow: async () => {
              throw unsupportedOperation('openWithNoFollow', 'not supported');
            },
            readUtf8: async (path) => {
              if (path === dirPath) throw permissionDenied(path);
              return base.fs.readUtf8(path);
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect('refs/heads/dir' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given an lstat that refuses a loose ref for a reason no path fault explains', () => {
    describe('When packRefs probes that ref', () => {
      it('Then the refusal carries out rather than reading as an absent file', async () => {
        // Arrange — only "absent, or a regular file above it" reads as no
        // loose file; anything else is a fault the caller must see.
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const loosePath = `${base.layout.gitDir}/refs/heads/main`;
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            lstat: async (path) => {
              if (path === loosePath) throw permissionDenied(path);
              return base.fs.lstat(path);
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.packRefs();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'PERMISSION_DENIED',
          path: loosePath,
        });
      });
    });
  });

  describe('Given a lock refusal no path fault explains, over a ref blocked by a regular file', () => {
    describe('When a set writes the ref', () => {
      it('Then the lock refusal carries out untouched, with no file-in-the-way probe', async () => {
        // Arrange — a file at a prefix would make the probe refuse
        // NOT_A_DIRECTORY, so the reported code tells whether the probe ran;
        // only a lock that could not be created FOR A PATH REASON pays it.
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/blocked' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            writeExclusive: async (path, data) => {
              if (path.endsWith('.lock')) throw permissionDenied(path);
              return base.fs.writeExclusive(path, data);
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/heads/blocked/deep' as RefName,
              id: 'b'.repeat(40) as ObjectId,
            },
          ]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'PERMISSION_DENIED',
          path: `${base.layout.gitDir}/refs/heads/blocked/deep.lock`,
        });
      });
    });
  });

  describe('Given a delete of the last ref in a directory the climb may never remove', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then that parent is never even stat-ed for the log tree', async () => {
        // Arrange — `logs/refs/heads` is an immediate child of the log climb's
        // root, so it can never be pruned; asking what sits there is work the
        // answer could not use.
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const logParent = `${base.layout.gitDir}/logs/refs/heads`;
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/main' as RefName }]);

        // Assert
        expect(calls().filter((call) => call.path === logParent)).toEqual([]);
      });
    });
  });

  describe('Given a delete of a ref whose loose directory is already there', () => {
    describe('When applyRefUpdates deletes it', () => {
      it('Then availability above it is never probed — the directory answered that', async () => {
        // Arrange — the file-in-the-way search exists for a parent that is
        // NOT a directory; one that is has already answered the question, and
        // a repeat walk up the prefixes is pure cost.
        const base = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const { ctx, calls } = instrumentedContext(base);
        const refParent = `${base.layout.gitDir}/refs/heads`;
        const sut = createRefStore(ctx);

        // Act
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/main' as RefName }]);

        // Assert
        expect(calls().filter((call) => call.path === refParent)).toHaveLength(1);
      });
    });
  });

  describe('Given a trusted HEAD slot and a delete of another ref', () => {
    describe('When resolveDirect reads HEAD afterwards', () => {
      it('Then the slot still answers it with no I/O — only a HEAD write drops it', async () => {
        // Arrange — the slot is dropped by writes to `HEAD` itself; a delete
        // of any other name leaves the bytes it holds still current.
        const base = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/heads/other' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        await base.fs.writeUtf8(`${base.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const { ctx, calls } = instrumentedContext(base);
        await validateHead(ctx);
        const sut = createRefStore(ctx);
        await sut.applyRefUpdates([{ kind: 'delete', name: 'refs/heads/other' as RefName }]);
        const before = calls().length;

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
        expect(calls()).toHaveLength(before);
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
