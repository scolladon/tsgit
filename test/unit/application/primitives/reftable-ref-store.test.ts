import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createReftableRefStore } from '../../../../src/application/primitives/reftable-ref-store.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  buildRefBlock,
  buildReftable,
  buildReftableHeader,
  buildReftableLogBlock,
} from '../../../fixtures/refs/reftable-writers.js';
import { commonReftableDir, withReftableStorage, writeReftableFiles } from './reftable-fixtures.js';

const oid = (fill: number): Uint8Array => new Uint8Array(20).fill(fill);
const hexOid = (fill: number): string => fill.toString(16).padStart(2, '0').repeat(20);
const ref = (name: string): RefName => RefName.from(name);

const ID_MAIN = oid(0x01);
const ID_GONE = oid(0x02);
const ID_TAG = oid(0x03);
const ID_TAG_PEELED = oid(0x04);

/**
 * A two-table stack: table 1 (older) carries `HEAD` (symbolic → main),
 * `refs/heads/gone` (live) and `refs/heads/main`; table 2 (newer) tombstones
 * `refs/heads/gone` and adds the annotated `refs/tags/v1`. Every record is
 * in ascending byte order within its block, as the block codec requires.
 */
function buildTwoTableStack(): { readonly table1: Uint8Array; readonly table2: Uint8Array } {
  const header1Spec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 3n };
  const header1 = buildReftableHeader(header1Spec);
  const block1 = buildRefBlock({
    records: [
      { name: 'HEAD', value: { kind: 'symbolic', target: 'refs/heads/main' } },
      { name: 'refs/heads/gone', updateIndexDelta: 1, value: { kind: 'direct', id: ID_GONE } },
      { name: 'refs/heads/main', updateIndexDelta: 2, value: { kind: 'direct', id: ID_MAIN } },
    ],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header1.length,
  });
  const table1 = buildReftable({ ...header1Spec, blocks: [block1] });

  const header2Spec = { version: 1 as const, minUpdateIndex: 4n, maxUpdateIndex: 5n };
  const header2 = buildReftableHeader(header2Spec);
  const block2 = buildRefBlock({
    records: [
      { name: 'refs/heads/gone', value: { kind: 'deletion' } },
      {
        name: 'refs/tags/v1',
        updateIndexDelta: 1,
        value: { kind: 'peeled', id: ID_TAG, peeled: ID_TAG_PEELED },
      },
    ],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header2.length,
  });
  const table2 = buildReftable({ ...header2Spec, blocks: [block2] });

  return { table1, table2 };
}

/** One raw `'g'`-type log block declaring `block_len =
 *  LOG_BLOCK_HEADER_LENGTH` (4) with a genuinely EMPTY inflated payload — no
 *  room for its own trailing `restart_count`, the exact shape a read-path
 *  `RangeError` regression was found in. `loadReftable` alone only inflates
 *  a log block; it never walks the records inside one, so this is what
 *  `verifyIntegrity` must consume its log iterator to catch. */
async function buildCorruptLogBlock(ctx: Context): Promise<Uint8Array> {
  const compressed = await ctx.compressor.deflate(new Uint8Array(0));
  const bytes = new Uint8Array(4 + compressed.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 'g'.charCodeAt(0);
  view.setUint8(1, 0);
  view.setUint16(2, 4);
  bytes.set(compressed, 4);
  return bytes;
}

async function seedTwoTableStack(ctx: Context, dir: string): Promise<void> {
  const { table1, table2 } = buildTwoTableStack();
  await writeReftableFiles(ctx, dir, [
    { name: 'table1.ref', bytes: table1 },
    { name: 'table2.ref', bytes: table2 },
  ]);
}

/** Seeds the reftable spec's compatibility stub files a real
 *  `--ref-format=reftable` repository leaves under `.git`: a `ref:
 *  refs/heads/.invalid` `HEAD` stub, and a `refs/heads` REGULAR FILE (not a
 *  directory) under `refs/`. Neither is a legitimate ref source. */
async function seedCompatibilityStubs(ctx: Context): Promise<void> {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/refs/heads`,
    'this repository uses the reftable format\n',
  );
}

describe('reftable-ref-store', () => {
  describe('Given a two-table stack with a live direct ref', () => {
    describe('When resolveDirect resolves it', () => {
      it('Then it returns the direct id', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(ref('refs/heads/main'));

        // Assert
        expect(result).toEqual({ kind: 'direct', id: hexOid(0x01) });
      });
    });
  });

  describe('Given a two-table stack with a symbolic ref', () => {
    describe('When resolveDirect resolves HEAD', () => {
      it('Then it returns the symbolic target, one hop, unfollowed', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(ref('HEAD'));

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
      });
    });
  });

  describe('Given a two-table stack with an annotated (peeled) tag', () => {
    describe('When resolveDirect resolves it', () => {
      it('Then it returns the tag object id, not the peeled value', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(ref('refs/tags/v1'));

        // Assert
        expect(result).toEqual({ kind: 'direct', id: hexOid(0x03) });
      });
    });
  });

  describe('Given a ref tombstoned by a newer table', () => {
    describe('When resolveDirect resolves it', () => {
      it('Then it reads as missing, not deleted', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(ref('refs/heads/gone'));

        // Assert
        expect(result).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given a name absent from every table', () => {
    describe('When resolveDirect resolves it', () => {
      it('Then it reads as missing', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(ref('refs/heads/nope'));

        // Assert
        expect(result).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given a stack with the reftable compatibility stub files present', () => {
    describe('When listRefs and resolveDirect(HEAD) run', () => {
      it('Then no phantom refs/heads entry appears and HEAD never reads as .invalid', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        await seedCompatibilityStubs(ctx);
        const sut = createReftableRefStore(ctx);

        // Act
        const entries = await sut.listRefs();
        const head = await sut.resolveDirect(ref('HEAD'));

        // Assert
        expect(entries.map((entry) => entry.name)).not.toContain('refs/heads');
        expect(head).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
      });
    });
  });

  describe('Given a two-table stack', () => {
    describe('When listRefs runs with no prefix', () => {
      it('Then it returns every live ref, sorted, tombstones excluded', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const entries = await sut.listRefs();

        // Assert
        expect(entries.map((entry) => entry.name)).toEqual([
          'HEAD',
          'refs/heads/main',
          'refs/tags/v1',
        ]);
      });
    });

    describe('When listRefs runs with a refs/heads/ prefix', () => {
      it('Then only matching names come back', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const entries = await sut.listRefs(ref('refs/heads/'));

        // Assert
        expect(entries.map((entry) => entry.name)).toEqual(['refs/heads/main']);
      });
    });

    describe('When listRefNames runs with no prefix', () => {
      it('Then it returns the exact same names listRefs resolves, without a prefix restriction', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const names = await sut.listRefNames();

        // Assert
        expect(names).toEqual((await sut.listRefs()).map((entry) => entry.name));
      });
    });

    describe('When listRefNames runs with a refs/heads/ prefix', () => {
      it('Then only matching names come back', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const names = await sut.listRefNames(ref('refs/heads/'));

        // Assert
        expect(names).toEqual(['refs/heads/main']);
      });
    });
  });

  describe('Given a stack with a reflog for refs/heads/main', () => {
    describe('When readReflog runs', () => {
      it('Then entries come back oldest-first, tombstones excluded', async () => {
        // Arrange — an older table with two log records for the same ref
        // (key-sorted newest-update_index-first, the reverse-int64 log key
        // order, so a correct reader must reverse before returning), plus a
        // newer table that tombstones the update_index=2 entry — a correct
        // reader must SHADOW that entry, not merely skip the tombstone
        // record itself and leave the shadowed entry visible.
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 2n };
        const header = buildReftableHeader(headerSpec);
        const logBlock = await buildReftableLogBlock(
          {
            records: [
              {
                refName: 'refs/heads/main',
                updateIndex: 2n,
                entry: {
                  kind: 'entry',
                  oldId: ID_MAIN,
                  newId: ID_GONE,
                  name: 'Ada',
                  email: 'ada@example.com',
                  timestamp: 1_700_001_000,
                  tzOffset: '+0000',
                  message: 'commit: second',
                },
              },
              {
                refName: 'refs/heads/main',
                updateIndex: 1n,
                entry: {
                  kind: 'entry',
                  oldId: oid(0x00),
                  newId: ID_MAIN,
                  name: 'Ada',
                  email: 'ada@example.com',
                  timestamp: 1_700_000_000,
                  tzOffset: '+0000',
                  message: 'commit (initial): first',
                },
              },
            ],
          },
          ctx.compressor.deflate,
        );
        const bytes = buildReftable({
          ...headerSpec,
          blocks: [logBlock],
          logPosition: header.length,
          logIndexPosition: 0,
        });
        const tombstoneHeaderSpec = { version: 1 as const, minUpdateIndex: 3n, maxUpdateIndex: 3n };
        const tombstoneHeader = buildReftableHeader(tombstoneHeaderSpec);
        const tombstoneBlock = await buildReftableLogBlock(
          {
            records: [{ refName: 'refs/heads/main', updateIndex: 2n, entry: { kind: 'deletion' } }],
          },
          ctx.compressor.deflate,
        );
        const tombstoneBytes = buildReftable({
          ...tombstoneHeaderSpec,
          blocks: [tombstoneBlock],
          logPosition: tombstoneHeader.length,
          logIndexPosition: 0,
        });
        await writeReftableFiles(ctx, dir, [
          { name: 'table1.ref', bytes },
          { name: 'table2.ref', bytes: tombstoneBytes },
        ]);
        const sut = createReftableRefStore(ctx);

        // Act
        const entries = await sut.readReflog(ref('refs/heads/main'));

        // Assert — the update_index=2 entry ("commit: second") is shadowed
        // by table2's tombstone; only the unshadowed update_index=1 entry
        // survives.
        expect(entries).toHaveLength(1);
        expect(entries[0]?.message).toBe('commit (initial): first');
      });
    });

    describe('When listReflogs runs', () => {
      it('Then the logged ref name is returned', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
        const header = buildReftableHeader(headerSpec);
        const logBlock = await buildReftableLogBlock(
          {
            records: [
              {
                refName: 'refs/heads/main',
                updateIndex: 1n,
                entry: {
                  kind: 'entry',
                  oldId: oid(0x00),
                  newId: ID_MAIN,
                  name: 'Ada',
                  email: 'ada@example.com',
                  timestamp: 1_700_000_000,
                  tzOffset: '+0000',
                  message: 'commit (initial): first',
                },
              },
            ],
          },
          ctx.compressor.deflate,
        );
        const bytes = buildReftable({
          ...headerSpec,
          blocks: [logBlock],
          logPosition: header.length,
          logIndexPosition: 0,
        });
        await writeReftableFiles(ctx, dir, [{ name: 'table1.ref', bytes }]);
        const sut = createReftableRefStore(ctx);

        // Act
        const names = await sut.listReflogs();

        // Assert
        expect(names).toEqual(['refs/heads/main']);
      });
    });

    describe('When hasReflog runs for that ref', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
        const header = buildReftableHeader(headerSpec);
        const logBlock = await buildReftableLogBlock(
          {
            records: [
              {
                refName: 'refs/heads/main',
                updateIndex: 1n,
                entry: {
                  kind: 'entry',
                  oldId: oid(0x00),
                  newId: ID_MAIN,
                  name: 'Ada',
                  email: 'ada@example.com',
                  timestamp: 1_700_000_000,
                  tzOffset: '+0000',
                  message: 'commit (initial): first',
                },
              },
            ],
          },
          ctx.compressor.deflate,
        );
        const bytes = buildReftable({
          ...headerSpec,
          blocks: [logBlock],
          logPosition: header.length,
          logIndexPosition: 0,
        });
        await writeReftableFiles(ctx, dir, [{ name: 'table1.ref', bytes }]);
        const sut = createReftableRefStore(ctx);

        // Act
        const result = await sut.hasReflog(ref('refs/heads/main'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a stack with ref records but no log records at all', () => {
    describe('When hasReflog runs', () => {
      it('Then it returns false', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const result = await sut.hasReflog(ref('refs/heads/main'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a ref whose entire reflog is tombstoned by a newer table', () => {
    describe('When readReflog and listReflogs run', () => {
      it('Then the ref reads as having no history at all — not the deleted entries', async () => {
        // Arrange — table1 carries one live log record for
        // refs/heads/topic; table2 tombstones it at the same update_index,
        // mirroring what a ref delete leaves behind on disk.
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
        const header = buildReftableHeader(headerSpec);
        const logBlock = await buildReftableLogBlock(
          {
            records: [
              {
                refName: 'refs/heads/topic',
                updateIndex: 1n,
                entry: {
                  kind: 'entry',
                  oldId: oid(0x00),
                  newId: ID_MAIN,
                  name: 'Ada',
                  email: 'ada@example.com',
                  timestamp: 1_700_000_000,
                  tzOffset: '+0000',
                  message: 'commit (initial): first',
                },
              },
            ],
          },
          ctx.compressor.deflate,
        );
        const bytes = buildReftable({
          ...headerSpec,
          blocks: [logBlock],
          logPosition: header.length,
          logIndexPosition: 0,
        });
        const tombstoneHeaderSpec = { version: 1 as const, minUpdateIndex: 2n, maxUpdateIndex: 2n };
        const tombstoneHeader = buildReftableHeader(tombstoneHeaderSpec);
        const tombstoneBlock = await buildReftableLogBlock(
          {
            records: [
              { refName: 'refs/heads/topic', updateIndex: 1n, entry: { kind: 'deletion' } },
            ],
          },
          ctx.compressor.deflate,
        );
        const tombstoneBytes = buildReftable({
          ...tombstoneHeaderSpec,
          blocks: [tombstoneBlock],
          logPosition: tombstoneHeader.length,
          logIndexPosition: 0,
        });
        await writeReftableFiles(ctx, dir, [
          { name: 'table1.ref', bytes },
          { name: 'table2.ref', bytes: tombstoneBytes },
        ]);
        const sut = createReftableRefStore(ctx);

        // Act
        const entries = await sut.readReflog(ref('refs/heads/topic'));
        const names = await sut.listReflogs();

        // Assert — matches the files backend's own behaviour for a deleted
        // ref: no entries, and the name absent from the reflog listing.
        expect(entries).toEqual([]);
        expect(names).toEqual([]);
      });
    });
  });

  describe('Given a ref absent from every table', () => {
    describe('When readReflog runs', () => {
      it('Then it returns an empty reflog', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const entries = await sut.readReflog(ref('refs/heads/nope'));

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given the reftable backend', () => {
    describe('When verifyIntegrity runs', () => {
      it('Then it reports no findings', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);

        // Act
        const findings = await sut.verifyIntegrity();

        // Assert
        expect(findings).toEqual([]);
      });
    });

    describe('When verifyIntegrity runs over a stack with one structurally corrupt table', () => {
      it('Then it returns one finding naming that table and its failed check', async () => {
        // Arrange — a healthy one-record table alongside a second table
        // whose magic bytes were corrupted after the fact.
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
        const header = buildReftableHeader(headerSpec);
        const block = buildRefBlock({
          records: [{ name: 'refs/heads/main', value: { kind: 'direct', id: ID_MAIN } }],
          restartIndices: [0],
          isFirstBlock: true,
          headerLength: header.length,
        });
        const healthyTable = buildReftable({ ...headerSpec, blocks: [block] });
        const corruptTable = healthyTable.slice();
        corruptTable.set([0x58, 0x58, 0x58, 0x58], 0); // 'XXXX'
        await writeReftableFiles(ctx, dir, [
          { name: 'a.ref', bytes: healthyTable },
          { name: 'b.ref', bytes: corruptTable },
        ]);
        const sut = createReftableRefStore(ctx);

        // Act
        const findings = await sut.verifyIntegrity();

        // Assert — never badRefContent: there is no raw per-ref text in a
        // reftable, so that loose-grammar fault class cannot exist here.
        expect(findings).toEqual([{ table: 'b.ref', msgId: 'badReftableTable', check: 'magic' }]);
      });
    });

    describe('When verifyIntegrity runs over a stack whose only table has a structurally corrupt log block', () => {
      it('Then it returns a finding for that table instead of reporting the stack healthy', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const header = buildReftableHeader({ version: 1 });
        const logBlock = await buildCorruptLogBlock(ctx);
        const corruptTable = buildReftable({
          version: 1,
          blocks: [logBlock],
          logPosition: header.length,
        });
        await writeReftableFiles(ctx, dir, [{ name: 'corrupt.ref', bytes: corruptTable }]);
        const sut = createReftableRefStore(ctx);

        // Act
        const findings = await sut.verifyIntegrity();

        // Assert
        expect(findings).toEqual([
          { table: 'corrupt.ref', msgId: 'badReftableTable', check: 'block-bounds' },
        ]);
      });
    });

    describe('When verifyIntegrity runs over a stack whose table stat-reports past the per-table size ceiling', () => {
      it('Then it returns a tables-list finding instead of reading the oversized table into memory', async () => {
        // Arrange — `verifyOneTable` used to call `ctx.fs.read` directly,
        // with no size gate at all. Only `stat`'s REPORTED size is inflated
        // here, so this never actually allocates a 64MB+ buffer.
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        await seedTwoTableStack(ctx, dir);
        const oversizedPath = `${dir}/table1.ref`;
        const originalStat = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) => {
          const stat = await originalStat(path);
          return path === oversizedPath ? { ...stat, size: 64 * 1024 * 1024 + 1 } : stat;
        });
        const sut = createReftableRefStore(ctx);

        // Act
        const findings = await sut.verifyIntegrity();

        // Assert
        expect(findings).toEqual([
          { table: 'table1.ref', msgId: 'badReftableTable', check: 'tables-list' },
        ]);
      });
    });

    describe('When verifyIntegrity runs over a stack whose tables.list is absent', () => {
      it('Then it reports no findings — a legitimately empty stack', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const sut = createReftableRefStore(ctx);

        // Act
        const findings = await sut.verifyIntegrity();

        // Assert
        expect(findings).toEqual([]);
      });
    });

    describe('When applyRefUpdates commits a new ref through the store', () => {
      it('Then the ref resolves — the write path routes through reftable-transaction.ts', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await seedTwoTableStack(ctx, commonReftableDir(ctx));
        const sut = createReftableRefStore(ctx);
        const newId = ObjectId.fromRaw(oid(0x09));

        // Act
        await sut.applyRefUpdates([{ kind: 'set', name: ref('refs/heads/fresh'), id: newId }]);
        const result = await sut.resolveDirect(ref('refs/heads/fresh'));

        // Assert
        expect(result).toEqual({ kind: 'direct', id: newId });
      });
    });
  });

  describe('Given a linked-worktree child Context with distinct common and own stacks', () => {
    const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;
    const asWorktreeChild = (ctx: Context): Context => ({
      ...ctx,
      layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
    });

    describe('When resolveDirect resolves a shared ref name', () => {
      it('Then it reads from the common stack, not the worktree own stack', async () => {
        // Arrange
        const base = withReftableStorage(createMemoryContext());
        const common = commonReftableDir(base);
        await seedTwoTableStack(base, common);
        const sut = createReftableRefStore(asWorktreeChild(base));

        // Act
        const result = await sut.resolveDirect(ref('refs/heads/main'));

        // Assert
        expect(result).toEqual({ kind: 'direct', id: hexOid(0x01) });
      });
    });

    describe('When resolveDirect resolves a per-worktree ref name', () => {
      it('Then it reads from the worktree own stack, not the common stack', async () => {
        // Arrange
        const base = withReftableStorage(createMemoryContext());
        const sut = createReftableRefStore(asWorktreeChild(base));
        const ownDir = `${adminDir(base)}/reftable`;
        const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
        const header = buildReftableHeader(headerSpec);
        const block = buildRefBlock({
          records: [{ name: 'refs/bisect/bad', value: { kind: 'direct', id: ID_TAG } }],
          restartIndices: [0],
          isFirstBlock: true,
          headerLength: header.length,
        });
        const bytes = buildReftable({ ...headerSpec, blocks: [block] });
        await writeReftableFiles(base, ownDir, [{ name: 'table1.ref', bytes }]);

        // Act
        const result = await sut.resolveDirect(ref('refs/bisect/bad'));

        // Assert
        expect(result).toEqual({ kind: 'direct', id: hexOid(0x03) });
      });
    });

    describe('When listRefs runs and a per-worktree name exists in both the common and the own stack', () => {
      it('Then it resolves the name through its own stack, not whichever stack it was seen in first', async () => {
        // Arrange — the common stack holds the MAIN worktree's own HEAD
        // (symbolic to refs/heads/main), which `listRefs` must not surface
        // to a linked-worktree caller; the worktree's own stack holds a
        // DIFFERENT HEAD, symbolic to refs/heads/topic.
        const base = withReftableStorage(createMemoryContext());
        const common = commonReftableDir(base);
        await seedTwoTableStack(base, common);
        const sut = createReftableRefStore(asWorktreeChild(base));
        const ownDir = `${adminDir(base)}/reftable`;
        const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
        const header = buildReftableHeader(headerSpec);
        const block = buildRefBlock({
          records: [{ name: 'HEAD', value: { kind: 'symbolic', target: 'refs/heads/topic' } }],
          restartIndices: [0],
          isFirstBlock: true,
          headerLength: header.length,
        });
        const bytes = buildReftable({ ...headerSpec, blocks: [block] });
        await writeReftableFiles(base, ownDir, [{ name: 'table1.ref', bytes }]);

        // Act
        const entries = await sut.listRefs();
        const head = entries.find((entry) => entry.name === 'HEAD');

        // Assert — the worktree's own HEAD, matching resolveDirect(HEAD);
        // the main worktree's own HEAD (refs/heads/main) never appears.
        expect(head?.value).toEqual({ kind: 'symbolic', target: 'refs/heads/topic' });
        expect(entries.map((entry) => entry.name)).toContain('refs/heads/main');
      });
    });
  });
});
