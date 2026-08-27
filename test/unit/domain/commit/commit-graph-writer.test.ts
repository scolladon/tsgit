import { describe, expect, it } from 'vitest';
import {
  EDGE_LAST_FLAG,
  NO_PARENT,
  OCTOPUS_FLAG,
} from '../../../../src/domain/commit/commit-graph.js';
import type { CommitGraphWriterCommit } from '../../../../src/domain/commit/commit-graph-writer.js';
import { serializeCommitGraph } from '../../../../src/domain/commit/commit-graph-writer.js';
import { TsgitError } from '../../../../src/domain/error.js';
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

function expectCommitGraphError(
  act: () => void,
  code: 'COMMIT_GRAPH_DATE_TOO_LARGE' | 'COMMIT_GRAPH_GENERATION_OVERFLOW',
): TsgitError {
  let caught: unknown;
  try {
    act();
    expect.unreachable('expected serializeCommitGraph to throw');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const error = caught as TsgitError;
  expect(error.data.code).toBe(code);
  return error;
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

  describe('Given a commit with a committer date at the 34-bit ceiling', () => {
    describe('When serialized', () => {
      it('Then it refuses with COMMIT_GRAPH_DATE_TOO_LARGE and writes nothing', () => {
        // Arrange
        const bad = commit('c0', [], { committerDate: 2 ** 34 });

        // Act & Assert
        const error = expectCommitGraphError(
          () => serializeCommitGraph([bad], SHA1_CONFIG),
          'COMMIT_GRAPH_DATE_TOO_LARGE',
        );
        if (error.data.code !== 'COMMIT_GRAPH_DATE_TOO_LARGE') throw new Error('unexpected shape');
        expect(error.data.id).toBe(bad.id);
        expect(error.data.committerDate).toBe(2 ** 34);
        expect(error.data.limit).toBe(2 ** 34);
      });
    });
  });

  describe('Given a chain whose corrected-date offset would exceed 0x7fffffff', () => {
    describe('When serialized', () => {
      it('Then it refuses with COMMIT_GRAPH_GENERATION_OVERFLOW rather than emitting GDO2', () => {
        // Arrange — parent's own correctedDate (= its committerDate, a root) is
        // just past 0x7fffffff; the child's correctedDate is pulled up to
        // parentCorrected + 1, while its OWN committerDate stays 0 — the gap
        // between them is the offset GDA2 would have to carry.
        const parentDate = 0x7fffffff + 5;
        const parent = commit('c0', [], { committerDate: parentDate });
        const child = commit('c1', [parent.id], { committerDate: 0 });

        // Act & Assert
        const error = expectCommitGraphError(
          () => serializeCommitGraph([parent, child], SHA1_CONFIG),
          'COMMIT_GRAPH_GENERATION_OVERFLOW',
        );
        if (error.data.code !== 'COMMIT_GRAPH_GENERATION_OVERFLOW')
          throw new Error('unexpected shape');
        expect(error.data.id).toBe(child.id);
        expect(error.data.offset).toBe(parentDate + 1);
        expect(error.data.limit).toBe(0x7fffffff);
      });
    });
  });
});
