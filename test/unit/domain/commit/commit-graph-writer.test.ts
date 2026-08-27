import { describe, expect, it } from 'vitest';
import {
  EDGE_LAST_FLAG,
  GENERATION_OVERFLOW_FLAG,
  NO_PARENT,
  OCTOPUS_FLAG,
} from '../../../../src/domain/commit/commit-graph.js';
import type { CommitGraphWriterCommit } from '../../../../src/domain/commit/commit-graph-writer.js';
import { serializeCommitGraph } from '../../../../src/domain/commit/commit-graph-writer.js';
import { decode } from '../../../../src/domain/objects/encoding.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';

// --- Fixture helpers -------------------------------------------------------

function oid(prefix: string, length: 40 | 64 = 40): ObjectId {
  return (prefix + '0'.repeat(length - prefix.length)) as ObjectId;
}

function commit(
  idPrefix: string,
  parents: readonly ObjectId[],
  overrides: Partial<CommitGraphWriterCommit> = {},
  length: 40 | 64 = 40,
): CommitGraphWriterCommit {
  return {
    id: oid(idPrefix, length),
    rootTree: oid(`e${idPrefix}`, length),
    parents,
    committerDate: 1_700_000_000,
    ...overrides,
  };
}

function findChunkRowIndex(bytes: Uint8Array, id: string): number {
  const numChunks = bytes[6]!;
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 8 + i * 12;
    if (decode(bytes.subarray(rowStart, rowStart + 4)) === id) return i;
  }
  throw new Error(`chunk ${id} not present`);
}

function chunkRange(bytes: Uint8Array, view: DataView, id: string): { start: number; end: number } {
  const rowIndex = findChunkRowIndex(bytes, id);
  const readOffset = (row: number): number => {
    const rowStart = 8 + row * 12;
    return view.getUint32(rowStart + 4) * 0x100000000 + view.getUint32(rowStart + 8);
  };
  return { start: readOffset(rowIndex), end: readOffset(rowIndex + 1) };
}

describe('serializeCommitGraph', () => {
  describe('Given a single root commit', () => {
    describe('When serialized with the SHA-1 hash config', () => {
      it('Then the header is magic CGPH, version 1, hash version 1', () => {
        // Arrange
        const commits = [commit('c0', [])];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);

        // Assert
        expect(decode(bytes.subarray(0, 4))).toBe('CGPH');
        expect(bytes[4]).toBe(1);
        expect(bytes[5]).toBe(1);
      });
    });

    describe('When serialized with the SHA-256 hash config', () => {
      it('Then the header carries hash version 2', () => {
        // Arrange
        const commits = [commit('c0', [], {}, 64)];

        // Act
        const bytes = serializeCommitGraph(commits, SHA256_CONFIG);

        // Assert
        expect(decode(bytes.subarray(0, 4))).toBe('CGPH');
        expect(bytes[4]).toBe(1);
        expect(bytes[5]).toBe(2);
      });
    });

    describe('When serialized', () => {
      it('Then numChunks is 4 (OIDF OIDL CDAT GDA2, no EDGE)', () => {
        // Arrange
        const commits = [commit('c0', [])];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);

        // Assert
        expect(bytes[6]).toBe(4);
      });

      it('Then numBaseGraphs is 0 and no BASE chunk is present', () => {
        // Arrange
        const commits = [commit('c0', [])];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);

        // Assert
        expect(bytes[7]).toBe(0);
        expect(() => findChunkRowIndex(bytes, 'BASE')).toThrow();
      });

      it('Then the root commit CDAT entry carries NO_PARENT for both parent slots', () => {
        // Arrange
        const commits = [commit('c0', [])];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const cdat = chunkRange(bytes, view, 'CDAT');

        // Assert — hashLength(20) + 0 offset is parent1, +4 is parent2
        expect(view.getUint32(cdat.start + 20)).toBe(NO_PARENT);
        expect(view.getUint32(cdat.start + 24)).toBe(NO_PARENT);
      });
    });
  });

  describe('Given a commit with three parents (an octopus merge)', () => {
    describe('When serialized', () => {
      it('Then numChunks is 5 (adds EDGE)', () => {
        // Arrange
        const p0 = commit('c0', []);
        const p1 = commit('c1', []);
        const p2 = commit('c2', []);
        const merge = commit('c3', [p0.id, p1.id, p2.id]);

        // Act
        const bytes = serializeCommitGraph([p0, p1, p2, merge], SHA1_CONFIG);

        // Assert
        expect(bytes[6]).toBe(5);
      });

      it("Then the merge commit's parent2 slot is OCTOPUS_FLAG | edgeIndex", () => {
        // Arrange — sorted-oid order is c0 < c1 < c2 < c3 already, so the
        // merge commit (c3) lands at position 3 and its EDGE chain starts at 0.
        const p0 = commit('c0', []);
        const p1 = commit('c1', []);
        const p2 = commit('c2', []);
        const merge = commit('c3', [p0.id, p1.id, p2.id]);

        // Act
        const bytes = serializeCommitGraph([p0, p1, p2, merge], SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const cdat = chunkRange(bytes, view, 'CDAT');
        const mergeEntryStart = cdat.start + 3 * (20 + 16);

        // Assert
        expect(view.getUint32(mergeEntryStart + 24)).toBe((OCTOPUS_FLAG | 0) >>> 0);
      });

      it('Then the EDGE chunk holds parents[1] then parents[2] flagged EDGE_LAST_FLAG', () => {
        // Arrange
        const p0 = commit('c0', []);
        const p1 = commit('c1', []);
        const p2 = commit('c2', []);
        const merge = commit('c3', [p0.id, p1.id, p2.id]);

        // Act
        const bytes = serializeCommitGraph([p0, p1, p2, merge], SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const edge = chunkRange(bytes, view, 'EDGE');

        // Assert — positions: c0=0, c1=1, c2=2 (sorted-oid order)
        expect(view.getUint32(edge.start)).toBe(1);
        expect(view.getUint32(edge.start + 4)).toBe((2 | EDGE_LAST_FLAG) >>> 0);
      });
    });
  });

  describe('Given three commits with distinct first oid bytes', () => {
    describe('When serialized', () => {
      it('Then OIDF is exactly 1024 bytes with correct cumulative counts', () => {
        // Arrange
        const commits = [commit('10', []), commit('20', []), commit('30', [])];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const oidf = chunkRange(bytes, view, 'OIDF');

        // Assert
        expect(oidf.end - oidf.start).toBe(1024);
        expect(view.getUint32(oidf.start + 0x0f * 4)).toBe(0);
        expect(view.getUint32(oidf.start + 0x10 * 4)).toBe(1);
        expect(view.getUint32(oidf.start + 0x1f * 4)).toBe(1);
        expect(view.getUint32(oidf.start + 0x20 * 4)).toBe(2);
        expect(view.getUint32(oidf.start + 0x2f * 4)).toBe(2);
        expect(view.getUint32(oidf.start + 0x30 * 4)).toBe(3);
        expect(view.getUint32(oidf.start + 0xff * 4)).toBe(3);
      });
    });
  });

  describe('Given commits generated out of oid order', () => {
    describe('When serialized', () => {
      it('Then OIDL lists them oid-sorted', () => {
        // Arrange — construction order is c2, c0, c1; sorted-oid order is c0, c1, c2.
        const commits = [commit('c2', []), commit('c0', []), commit('c1', [])];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const oidl = chunkRange(bytes, view, 'OIDL');

        // Assert
        expect(view.getUint8(oidl.start + 0 * 20)).toBe(0xc0);
        expect(view.getUint8(oidl.start + 1 * 20)).toBe(0xc1);
        expect(view.getUint8(oidl.start + 2 * 20)).toBe(0xc2);
      });
    });
  });

  describe('Given a root commit with a committer date past the 32-bit boundary', () => {
    describe('When serialized', () => {
      it('Then CDAT splits genWord/dateWord as (level << 2) | (date >> 32) and date & 0xffffffff', () => {
        // Arrange — a root's level is 1 (git's convention), so
        // genWord === 1 * 4 + dateHigh exactly.
        const committerDate = 3 * 2 ** 32 + 12345; // dateHigh = 3, dateLow = 12345
        const commits = [commit('c0', [], { committerDate })];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const cdat = chunkRange(bytes, view, 'CDAT');

        // Assert
        expect(view.getUint32(cdat.start + 20 + 8)).toBe(1 * 4 + 3);
        expect(view.getUint32(cdat.start + 20 + 12)).toBe(12345);
      });
    });
  });

  describe('Given a chain whose child committer date does not exceed its parent', () => {
    describe('When serialized', () => {
      it("Then GDA2 holds each commit's corrected-date offset", () => {
        // Arrange — parent correctedDate=1000 (root); child correctedDate=max(1000,1001)=1001, offset=1.
        const parent = commit('c0', [], { committerDate: 1000 });
        const child = commit('c1', [parent.id], { committerDate: 1000 });

        // Act
        const bytes = serializeCommitGraph([parent, child], SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const gda2 = chunkRange(bytes, view, 'GDA2');

        // Assert — sorted-oid order: c0=0, c1=1
        expect(view.getUint32(gda2.start + 0 * 4)).toBe(0);
        expect(view.getUint32(gda2.start + 1 * 4)).toBe(1);
      });
    });
  });

  describe('Given a committer date at the 34-bit ceiling', () => {
    describe('When serialized', () => {
      it('Then genWord wraps mod 2**34 rather than refusing, matching git’s own silent truncation', () => {
        // Arrange — measured against real git: `git commit-graph write` on
        // this date exits 0 and produces the identical wrapped split; only
        // `git commit-graph verify` afterwards flags the mismatch. A root's
        // level is 1, so genWord === 1 * 4 + dateHigh, and 2**34's dateHigh
        // (`floor(date / 2**32) & 3`) wraps to 0, same as its dateLow.
        const committerDate = 2 ** 34;
        const commits = [commit('c0', [], { committerDate })];

        // Act
        const bytes = serializeCommitGraph(commits, SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const cdat = chunkRange(bytes, view, 'CDAT');

        // Assert
        expect(view.getUint32(cdat.start + 20 + 8)).toBe(1 * 4 + 0);
        expect(view.getUint32(cdat.start + 20 + 12)).toBe(0);
      });
    });
  });

  describe('Given a chain whose corrected-date offset exceeds 0x7fffffff', () => {
    describe('When serialized', () => {
      it('Then numChunks is 5 (adds GDO2, no EDGE)', () => {
        // Arrange — parent's own correctedDate (= its committerDate, a root)
        // is just past 0x7fffffff; the child's correctedDate is pulled up to
        // parentCorrected + 1, while its OWN committerDate stays 0 — the gap
        // between them is the offset GDA2's plain field cannot carry.
        const parentDate = 0x7fffffff + 5;
        const parent = commit('c0', [], { committerDate: parentDate });
        const child = commit('c1', [parent.id], { committerDate: 0 });

        // Act
        const bytes = serializeCommitGraph([parent, child], SHA1_CONFIG);

        // Assert
        expect(bytes[6]).toBe(5);
      });

      it("Then the overflowing commit's GDA2 entry is GENERATION_OVERFLOW_FLAG | 0 and GDO2 holds the true 64-bit offset", () => {
        // Arrange
        const parentDate = 0x7fffffff + 5;
        const parent = commit('c0', [], { committerDate: parentDate });
        const child = commit('c1', [parent.id], { committerDate: 0 });
        const expectedOffset = parentDate + 1;

        // Act
        const bytes = serializeCommitGraph([parent, child], SHA1_CONFIG);
        const view = new DataView(bytes.buffer);
        const gda2 = chunkRange(bytes, view, 'GDA2');
        const gdo2 = chunkRange(bytes, view, 'GDO2');

        // Assert — sorted-oid order: c0 (parent, no overflow) = 0, c1 (child) = 1
        expect(view.getUint32(gda2.start + 0 * 4)).toBe(0);
        expect(view.getUint32(gda2.start + 1 * 4)).toBe((GENERATION_OVERFLOW_FLAG | 0) >>> 0);
        expect(gdo2.end - gdo2.start).toBe(8);
        expect(view.getUint32(gdo2.start)).toBe(Math.floor(expectedOffset / 0x100000000));
        expect(view.getUint32(gdo2.start + 4)).toBe(expectedOffset % 0x100000000);
      });
    });
  });

  describe('Given an octopus merge whose ancestors also overflow the corrected-date offset', () => {
    describe('When serialized', () => {
      it('Then numChunks is 6 and GDO2 precedes EDGE in the chunk table', () => {
        // Arrange
        const root = commit('c0', [], { committerDate: 4_000_000_000 });
        const a = commit('c1', [root.id], { committerDate: 1_000_000_000 });
        const b = commit('c2', [root.id], { committerDate: 1_000_000_000 });
        const c = commit('c3', [root.id], { committerDate: 1_000_000_000 });
        const merge = commit('c4', [a.id, b.id, c.id], { committerDate: 1_000_000_000 });

        // Act
        const bytes = serializeCommitGraph([root, a, b, c, merge], SHA1_CONFIG);

        // Assert
        expect(bytes[6]).toBe(6);
        expect(findChunkRowIndex(bytes, 'GDO2')).toBeLessThan(findChunkRowIndex(bytes, 'EDGE'));
      });
    });
  });
});
