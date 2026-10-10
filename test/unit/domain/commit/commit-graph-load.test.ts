import { describe, expect, it } from 'vitest';
import { commitGraphLoadFailure } from '../../../../src/domain/commit/commit-graph-load.js';
import { serializeCommitGraph } from '../../../../src/domain/commit/commit-graph-writer.js';
import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';

const HASH_LENGTH = 20;
const MIN_SIZE = 8 + 4 * 12 + 1024 + HASH_LENGTH;
const HEADER_SIZE = 8;
const ROW_SIZE = 12;

const graph = (ids: ReadonlyArray<string> = ['a'.repeat(40), 'c'.repeat(40)]): Uint8Array =>
  serializeCommitGraph(
    ids.map((id) => ({
      id: id as ObjectId,
      rootTree: 'b'.repeat(40) as ObjectId,
      parents: [],
      committerDate: 1,
    })),
    SHA1_CONFIG,
  );

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const rowOf = (bytes: Uint8Array, id: string): number => {
  for (let row = 0; row < (bytes[6] as number); row += 1) {
    const at = HEADER_SIZE + row * ROW_SIZE;
    if (new TextDecoder().decode(bytes.subarray(at, at + 4)) === id) return at;
  }
  throw new Error(`no ${id} row`);
};

const renamed = (bytes: Uint8Array, id: string, to: string): Uint8Array => {
  bytes.set(new TextEncoder().encode(to), rowOf(bytes, id));
  return bytes;
};

const offsetAt = (bytes: Uint8Array, row: number): number =>
  view(bytes).getUint32(HEADER_SIZE + row * ROW_SIZE + 8);

const setOffset = (bytes: Uint8Array, row: number, offset: number): Uint8Array => {
  view(bytes).setUint32(HEADER_SIZE + row * ROW_SIZE + 8, offset);
  return bytes;
};

describe('commitGraphLoadFailure', () => {
  describe('Given a graph as git writes it, When classified', () => {
    it('Then it loads', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(graph(), HASH_LENGTH);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a file one byte short of the smallest graph, When classified', () => {
    it('Then it is too small', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(new Uint8Array(MIN_SIZE - 1), HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'too-small' });
    });
  });

  describe('Given a file of exactly the smallest size but no signature, When classified', () => {
    it('Then the signature it found is named', () => {
      // Arrange
      const bytes = new Uint8Array(MIN_SIZE);
      bytes.set([0x58, 0x47, 0x50, 0x48]);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'signature', found: 0x58475048 });
    });
  });

  describe('Given another graph version, When classified', () => {
    it('Then the version it found is named', () => {
      // Arrange
      const bytes = graph();
      bytes[4] = 9;
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'version', found: 9 });
    });
  });

  describe('Given a SHA-256 hash version in a SHA-1 repository, When classified', () => {
    it('Then both hash versions are named', () => {
      // Arrange
      const bytes = graph();
      bytes[5] = 2;
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'hash-version', found: 2, expected: 1 });
    });
  });

  describe('Given a SHA-1 hash version in a SHA-256 repository, When classified', () => {
    it('Then SHA-256 is the expected version', () => {
      // Arrange
      const bytes = graph();
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(new Uint8Array([...bytes, ...new Uint8Array(12)]), 32);

      // Assert
      expect(result).toEqual({ kind: 'hash-version', found: 1, expected: 2 });
    });
  });

  describe('Given more chunks declared than the file can hold, When classified', () => {
    it('Then the declared count is named', () => {
      // Arrange
      const bytes = graph();
      bytes[6] = 200;
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'too-small-for-chunks', chunkCount: 200 });
    });
  });

  describe('Given exactly as many chunks as the file can hold, When classified', () => {
    it('Then the table is read', () => {
      // Arrange
      const bytes = new Uint8Array(MIN_SIZE + ROW_SIZE);
      bytes.set([0x43, 0x47, 0x50, 0x48, 1, 1, 4]);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'early-terminator' });
    });
  });

  describe('Given a file one byte short of the chunks it declares, When classified', () => {
    it('Then the declared count is named', () => {
      // Arrange
      const bytes = new Uint8Array(MIN_SIZE + ROW_SIZE - 1);
      bytes.set([0x43, 0x47, 0x50, 0x48, 1, 1, 4]);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'too-small-for-chunks', chunkCount: 4 });
    });
  });

  describe('Given a chunk offset with its high word set, When classified', () => {
    it('Then the 64-bit offset lands past the file', () => {
      // Arrange
      const bytes = graph();
      const start = offsetAt(bytes, 0);
      const end = offsetAt(bytes, 1);
      view(bytes).setUint32(HEADER_SIZE + ROW_SIZE + 4, 1);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'improper-offsets', offset: start, next: 0x100000000 + end });
    });
  });

  describe('Given a graph of no commits, whose lookup and data chunks are empty, When classified', () => {
    it('Then it loads', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(graph([]), HASH_LENGTH);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a graph whose first oid opens with zero bytes, When classified', () => {
    it('Then the fanout check stops at its own last entry and the graph loads', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(graph(['0'.repeat(40), 'c'.repeat(40)]), HASH_LENGTH);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a chunk ending before it starts, When classified', () => {
    it('Then both offsets are named', () => {
      // Arrange
      const bytes = graph();
      const start = offsetAt(bytes, 1);
      setOffset(bytes, 2, start - 1);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'improper-offsets', offset: start, next: start - 1 });
    });
  });

  describe('Given a chunk ending inside the trailer, When classified', () => {
    it('Then both offsets are named', () => {
      // Arrange
      const bytes = graph();
      const rows = bytes[6] as number;
      const start = offsetAt(bytes, rows - 1);
      setOffset(bytes, rows, bytes.length - HASH_LENGTH + 1);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({
        kind: 'improper-offsets',
        offset: start,
        next: bytes.length - HASH_LENGTH + 1,
      });
    });
  });

  describe('Given a chunk ending exactly at the trailer, When classified', () => {
    it('Then it loads', () => {
      // Arrange
      const bytes = graph();
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(offsetAt(bytes, bytes[6] as number)).toBe(bytes.length - HASH_LENGTH);
      expect(result).toBeUndefined();
    });
  });

  describe('Given a chunk id written twice, When classified', () => {
    it('Then the duplicate id is named', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(renamed(graph(), 'CDAT', 'OIDL'), HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'duplicate-chunk', chunkId: 0x4f49444c });
    });
  });

  describe('Given a table whose last row is not the terminator, When classified', () => {
    it('Then the final id is named', () => {
      // Arrange
      const bytes = graph();
      bytes.set([0x41, 0x42, 0x43, 0x44], HEADER_SIZE + (bytes[6] as number) * ROW_SIZE);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'final-chunk-id', chunkId: 0x41424344 });
    });
  });

  describe.each([
    ['OIDF', 'oid-fanout'],
    ['OIDL', 'oid-lookup'],
    ['CDAT', 'commit-data'],
  ] as const)('Given no %s chunk, When classified', (id, chunk) => {
    it('Then the required chunk is missing', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(renamed(graph(), id, 'XXXX'), HASH_LENGTH);

      // Assert
      expect(result).toEqual({ kind: 'required-chunk', chunk, problem: 'missing' });
    });
  });

  describe('Given an OID fanout chunk one entry short, When classified', () => {
    it('Then the fanout is the wrong size', () => {
      // Arrange
      const bytes = graph();
      setOffset(bytes, 0, offsetAt(bytes, 0) + 4);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({
        kind: 'required-chunk',
        chunk: 'oid-fanout',
        problem: 'wrong-size',
      });
    });
  });

  describe('Given a fanout whose counts decrease, When classified', () => {
    it('Then the fanout is out of order', () => {
      // Arrange
      const bytes = graph();
      view(bytes).setUint32(offsetAt(bytes, 0), 5);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({
        kind: 'required-chunk',
        chunk: 'oid-fanout',
        problem: 'out-of-order',
      });
    });
  });

  describe('Given a fanout whose last two counts decrease, When classified', () => {
    it('Then the fanout is out of order', () => {
      // Arrange
      const bytes = graph();
      view(bytes).setUint32(offsetAt(bytes, 0) + 254 * 4, 3);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({
        kind: 'required-chunk',
        chunk: 'oid-fanout',
        problem: 'out-of-order',
      });
    });
  });

  describe('Given an OID lookup chunk short of a whole hash, When classified', () => {
    it('Then the lookup is the wrong size', () => {
      // Arrange
      const bytes = graph();
      setOffset(bytes, 2, offsetAt(bytes, 2) - 1);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({
        kind: 'required-chunk',
        chunk: 'oid-lookup',
        problem: 'wrong-size',
      });
    });
  });

  describe('Given a commit data chunk short of a whole entry, When classified', () => {
    it('Then the commit data is the wrong size', () => {
      // Arrange
      const bytes = graph();
      setOffset(bytes, 3, offsetAt(bytes, 3) - 1);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toEqual({
        kind: 'required-chunk',
        chunk: 'commit-data',
        problem: 'wrong-size',
      });
    });
  });

  describe('Given a commit data chunk with a ragged tail past its whole entries, When classified', () => {
    it('Then it loads as git sizes it by whole entries', () => {
      // Arrange
      const bytes = graph();
      setOffset(bytes, 3, offsetAt(bytes, 3) + 1);
      const sut = commitGraphLoadFailure;

      // Act
      const result = sut(bytes, HASH_LENGTH);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
