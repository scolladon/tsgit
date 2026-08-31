import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from '../../../../src/domain/objects/encoding.js';

vi.mock('../../../../src/domain/objects/tree-entry-bytes.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/domain/objects/tree-entry-bytes.js')>();
  return { ...actual, entryNameKey: vi.fn(actual.entryNameKey) };
});

const { entryNameKey } = await import('../../../../src/domain/objects/tree-entry-bytes.js');
const { validateTree } = await import('../../../../src/domain/fsck/validate-tree.js');

const entryNameKeySpy = vi.mocked(entryNameKey);

function buildTreeEntry(name: string): Uint8Array {
  const modeBytes = encode('100644');
  const nameBytes = encode(name);
  const sha = new Uint8Array(20).fill(0xab);
  const entry = new Uint8Array(modeBytes.length + 1 + nameBytes.length + 1 + sha.length);
  let offset = 0;
  entry.set(modeBytes, offset);
  offset += modeBytes.length;
  entry[offset++] = 0x20;
  entry.set(nameBytes, offset);
  offset += nameBytes.length;
  entry[offset++] = 0x00;
  entry.set(sha, offset);
  return entry;
}

function buildTree(...entries: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = entries.reduce((sum, e) => sum + e.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    result.set(entry, offset);
    offset += entry.length;
  }
  return result;
}

describe('Given a tree with three entries', () => {
  beforeEach(() => {
    entryNameKeySpy.mockClear();
  });

  describe('When validateTree runs', () => {
    it('Then entryNameKey is called exactly once per entry, never twice', () => {
      // Arrange
      const sut = validateTree;
      const rawBytes = buildTree(
        buildTreeEntry('a.txt'),
        buildTreeEntry('b.txt'),
        buildTreeEntry('c.txt'),
      );

      // Act
      sut(rawBytes, false, 20);

      // Assert — one call per entry: checkEntryFaults and the duplicate-set
      // insertion share the SAME computed key, they do not each compute it.
      expect(entryNameKeySpy).toHaveBeenCalledTimes(3);
    });
  });
});
