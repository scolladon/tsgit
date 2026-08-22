import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { loadReftableStack } from '../../../../src/application/primitives/load-reftable-stack.js';
import { fileNotFound, type TsgitError } from '../../../../src/domain/error.js';
import { RefName } from '../../../../src/domain/objects/index.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
import {
  buildRefBlock,
  buildReftable,
  buildReftableHeader,
  buildReftableLogBlock,
} from '../../../fixtures/refs/reftable-writers.js';
import { commonReftableDir, writeReftableFiles } from './reftable-fixtures.js';

const oid = (fill: number): Uint8Array => new Uint8Array(20).fill(fill);

/** A minimal one-record ref-block table: `refName -> id`, at `[minUpdateIndex, maxUpdateIndex]`. */
function buildSimpleTable(spec: {
  readonly minUpdateIndex?: bigint;
  readonly maxUpdateIndex?: bigint;
  readonly refName: string;
  readonly id: Uint8Array;
}): Uint8Array {
  const headerSpec = {
    version: 1 as const,
    minUpdateIndex: spec.minUpdateIndex ?? 1n,
    maxUpdateIndex: spec.maxUpdateIndex ?? 1n,
  };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: [{ name: spec.refName, value: { kind: 'direct', id: spec.id } }],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header.length,
  });
  return buildReftable({ ...headerSpec, blocks: [block] });
}

/** A log-only table: header, one log block, footer — no ref/index/obj section. */
async function buildLogOnlyTable(
  deflate: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
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
            newId: oid(0x01),
            name: 'Ada',
            email: 'ada@example.com',
            timestamp: 1_700_000_000,
            tzOffset: '+0000',
            message: 'commit: seed',
          },
        },
      ],
    },
    deflate,
  );
  return buildReftable({
    ...headerSpec,
    blocks: [logBlock],
    logPosition: header.length,
    logIndexPosition: 0,
  });
}

describe('load-reftable-stack', () => {
  describe('Given a two-table stack on disk', () => {
    describe('When the stack is loaded', () => {
      it('Then tables are ordered oldest to newest', async () => {
        // Arrange — table B (newer) shadows table A's value for the same name.
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const tableA = buildSimpleTable({
          minUpdateIndex: 1n,
          maxUpdateIndex: 1n,
          refName: 'refs/heads/main',
          id: oid(0xaa),
        });
        const tableB = buildSimpleTable({
          minUpdateIndex: 2n,
          maxUpdateIndex: 2n,
          refName: 'refs/heads/main',
          id: oid(0xbb),
        });
        await writeReftableFiles(ctx, dir, [
          { name: 'a.ref', bytes: tableA },
          { name: 'b.ref', bytes: tableB },
        ]);
        const sut = loadReftableStack;

        // Act
        const result = await sut(ctx, dir);

        // Assert
        expect(result.tables.map((table) => table.header.minUpdateIndex)).toEqual([1n, 2n]);
        expect(result.lookup(RefName.from('refs/heads/main'))?.value).toEqual({
          kind: 'direct',
          id: expect.stringMatching(/^bb+$/),
        });
      });
    });
  });

  describe('Given a table named by tables.list that is missing on disk', () => {
    describe('When the table materializes before the retry runs', () => {
      it('Then exactly one reload absorbs the miss and the stack loads', async () => {
        // Arrange — table B is absent on the FIRST attempt; `readTableBytes`
        // now `stat`s before it `read`s (the size-ceiling gate), so the
        // race-simulating side effect lives on the `stat` spy — the first
        // filesystem call `readTableBytes` makes for the missing path —
        // rather than `read`, to still fire exactly once per absorbed miss.
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const tableA = buildSimpleTable({ refName: 'refs/heads/a', id: oid(0x01) });
        const tableB = buildSimpleTable({ refName: 'refs/heads/b', id: oid(0x02) });
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: tableA }]);
        await ctx.fs.writeUtf8(`${dir}/tables.list`, 'a.ref\nb.ref\n');
        const listSpy = vi.spyOn(ctx.fs, 'readUtf8');
        const originalStat = ctx.fs.stat;
        const missingPath = `${dir}/b.ref`;
        let materialized = false;
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) => {
          if (path === missingPath && !materialized) {
            materialized = true;
            await ctx.fs.write(path, tableB);
            throw fileNotFound(path);
          }
          return originalStat(path);
        });

        // Act
        const sut = loadReftableStack;
        const result = await sut(ctx, dir);

        // Assert
        expect(result.tables).toHaveLength(2);
        expect(listSpy).toHaveBeenCalledTimes(2);
      });
    });

    describe('When the table is still missing after the retry', () => {
      it('Then it refuses with check tables-list', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        await ctx.fs.writeUtf8(`${dir}/tables.list`, 'ghost.ref\n');
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({
            check: 'tables-list',
            reason: expect.any(String),
          });
        }
      });
    });
  });

  describe('Given a tables.list body that is not newline-terminated', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check tables-list', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        await ctx.fs.writeUtf8(`${dir}/tables.list`, 'a.ref');
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({ check: 'tables-list' });
        }
      });
    });
  });

  describe('Given a tables.list body with a blank line', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check tables-list', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        await ctx.fs.writeUtf8(`${dir}/tables.list`, 'a.ref\n\nb.ref\n');
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({ check: 'tables-list' });
        }
      });
    });
  });

  describe('Given a tables.list naming more tables than the stack ceiling allows', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check tables-list rather than opening thousands of files', async () => {
        // Arrange — one line per table name; content is irrelevant, only the
        // count matters, so this stays cheap to build.
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const names = Array.from({ length: 4097 }, (_, i) => `t${i}.ref`);
        await ctx.fs.writeUtf8(`${dir}/tables.list`, `${names.join('\n')}\n`);
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({ check: 'tables-list' });
          expect(((err as TsgitError).data as { reason: string }).reason).toContain('4097');
        }
      });
    });
  });

  describe('Given a table file larger than the per-table size ceiling', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check tables-list before parsing the oversized file', async () => {
        // Arrange — content is irrelevant; `stat` alone (before any `read`)
        // must be enough to refuse, so this never actually parses 64MB+ of
        // garbage as a reftable.
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
        await ctx.fs.writeUtf8(`${dir}/tables.list`, 'huge.ref\n');
        await ctx.fs.write(`${dir}/huge.ref`, oversized);
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({ check: 'tables-list' });
        }
      });
    });
  });

  describe('Given repeated loads with tables.list size held constant', () => {
    describe('When mtime changes between calls', () => {
      it('Then the stack reloads', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: table }]);
        const baseline = await ctx.fs.stat(`${dir}/tables.list`);
        const statSpy = vi.spyOn(ctx.fs, 'stat');
        const readSpy = vi.spyOn(ctx.fs, 'readUtf8');
        const stat = (mtimeMs: number): FileStat => ({ ...baseline, mtimeMs });
        statSpy.mockResolvedValueOnce(stat(1)).mockResolvedValueOnce(stat(2));
        const sut = loadReftableStack;

        // Act
        await sut(ctx, dir);
        await sut(ctx, dir);

        // Assert
        expect(readSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given repeated loads with tables.list mtime held constant', () => {
    describe('When size changes between calls', () => {
      it('Then the stack reloads', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: table }]);
        const baseline = await ctx.fs.stat(`${dir}/tables.list`);
        const statSpy = vi.spyOn(ctx.fs, 'stat');
        const readSpy = vi.spyOn(ctx.fs, 'readUtf8');
        const stat = (size: number): FileStat => ({ ...baseline, size });
        statSpy.mockResolvedValueOnce(stat(10)).mockResolvedValueOnce(stat(11));
        const sut = loadReftableStack;

        // Act
        await sut(ctx, dir);
        await sut(ctx, dir);

        // Assert
        expect(readSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given repeated loads with tables.list mtime and size unchanged', () => {
    describe('When loadReftableStack is called again', () => {
      it('Then the cached stack is reused without a second read', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: table }]);
        const readSpy = vi.spyOn(ctx.fs, 'readUtf8');
        const sut = loadReftableStack;

        // Act
        const first = await sut(ctx, dir);
        const second = await sut(ctx, dir);

        // Assert
        expect(second).toBe(first);
        expect(readSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given tables.list is absent but the reftable directory otherwise exists', () => {
    describe('When the stack is loaded', () => {
      it('Then it degrades to an empty stack', async () => {
        // Arrange — a stray leftover table with no tables.list naming it: the
        // "tables.list removed" fixture shape (a prior compaction step wrote
        // the table but never got to rewrite the manifest).
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        await ctx.fs.write(`${dir}/orphan.ref`, table);
        const sut = loadReftableStack;

        // Act
        const result = await sut(ctx, dir);

        // Assert
        expect(result.tables).toEqual([]);
        expect([...result.names()]).toEqual([]);
      });
    });
  });

  describe('Given the reftable directory itself is absent', () => {
    describe('When the stack is loaded', () => {
      it('Then it degrades to an empty stack', async () => {
        // Arrange — nothing at all is written under the stack directory: the
        // ".git/reftable/ removed" fixture shape, and also the ordinary shape
        // of a freshly-declared reftable repository before its first write.
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const sut = loadReftableStack;

        // Act
        const result = await sut(ctx, dir);

        // Assert
        expect(result.tables).toEqual([]);
        expect([...result.names()]).toEqual([]);
      });
    });
  });

  describe('Given a table whose magic bytes are corrupted', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check magic', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        const corrupted = table.slice();
        corrupted.set([0x58, 0x58, 0x58, 0x58], 0); // 'XXXX'
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: corrupted }]);
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({
            check: 'magic',
            reason: expect.any(String),
          });
        }
      });
    });
  });

  describe('Given a table truncated below its own header and footer length', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check truncated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        const truncated = table.slice(0, 50);
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: truncated }]);
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({
            check: 'truncated',
            reason: expect.any(String),
          });
        }
      });
    });
  });

  describe('Given a table whose footer CRC no longer matches its footer bytes', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check footer-crc', async () => {
        // Arrange — flipping the stored CRC's own last byte, not the bytes it
        // covers, keeps every other footer field valid and isolates the
        // fault to the checksum comparison alone.
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        const corrupted = table.slice();
        const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
        const lastIndex = corrupted.length - 1;
        view.setUint8(lastIndex, view.getUint8(lastIndex) ^ 0xff);
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: corrupted }]);
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({
            check: 'footer-crc',
            reason: expect.any(String),
          });
        }
      });
    });
  });

  describe('Given a table declaring an unsupported header version', () => {
    describe('When the stack is loaded', () => {
      it('Then it refuses with check version', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const table = buildSimpleTable({ refName: 'refs/heads/main', id: oid(0x01) });
        const corrupted = table.slice();
        corrupted[4] = 9;
        await writeReftableFiles(ctx, dir, [{ name: 'a.ref', bytes: corrupted }]);
        const sut = loadReftableStack;

        // Act + Assert
        try {
          await sut(ctx, dir);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((err as TsgitError).data).toMatchObject({
            check: 'version',
            reason: expect.any(String),
          });
        }
      });
    });
  });

  describe('Given a .log-extension entry carrying only log blocks', () => {
    describe('When the stack is loaded', () => {
      it('Then it loads — dispatch is by content, not by extension', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = commonReftableDir(ctx);
        const logOnly = await buildLogOnlyTable(ctx.compressor.deflate);
        await writeReftableFiles(ctx, dir, [{ name: 'table.log', bytes: logOnly }]);
        const sut = loadReftableStack;

        // Act
        const result = await sut(ctx, dir);

        // Assert
        expect(result.tables).toHaveLength(1);
        expect(result.tables[0]?.logBlocks).toHaveLength(1);
        expect([...result.names()]).toEqual([]);
      });
    });
  });
});
