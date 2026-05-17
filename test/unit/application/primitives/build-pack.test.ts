/**
 * Unit tests for the Phase 12.3 `buildPack` non-delta packfile assembler.
 *
 * Coverage:
 *  - empty oid list → 32-byte minimal pack (header + trailer)
 *  - single blob   → header + 1 entry + trailer; parsePackHeader sees count=1
 *  - mixed types   → entries round-trip through parsePackEntryHeader
 *  - trailer       → SHA over the body bytes, byte-equal
 */
import { describe, expect, it } from 'vitest';
import { buildPack } from '../../../../src/application/primitives/build-pack.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { bytesToHex } from '../../../../src/domain/objects/encoding.js';
import type { Blob, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import {
  PACK_ENTRY_TYPE,
  parsePackEntryHeader,
  parsePackHeader,
} from '../../../../src/domain/storage/index.js';
import { buildSeededContext } from './fixtures.js';

const PACK_HEADER_BYTES = 12;
const TRAILER_BYTES = 20;

describe('buildPack', () => {
  it('Given an empty oid list, When buildPack runs, Then output is 12 header bytes + 20 trailer bytes', async () => {
    // Arrange
    const ctx = await buildSeededContext();

    // Act
    const sut = await buildPack(ctx, { oids: [] });

    // Assert — header + trailer only, no entries.
    expect(sut.bytes.length).toBe(PACK_HEADER_BYTES + TRAILER_BYTES);
    expect(sut.objectCount).toBe(0);
    const header = parsePackHeader(sut.bytes);
    expect(header.version).toBe(2);
    expect(header.objectCount).toBe(0);
    // Trailer is the SHA of the pack body (12 header bytes only when empty).
    const expectedTrailer = await ctx.hash.hash(sut.bytes.subarray(0, PACK_HEADER_BYTES));
    expect(sut.bytes.subarray(PACK_HEADER_BYTES)).toEqual(expectedTrailer);
    expect(sut.sha).toBe(bytesToHex(expectedTrailer));
  });

  it('Given a single blob oid, When buildPack runs, Then header reports objectCount=1 and entry header decodes as BLOB', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blob: Blob = {
      type: 'blob',
      content: new TextEncoder().encode('hello'),
      id: '' as ObjectId,
    };
    const blobId = await writeObject(ctx, blob);

    // Act
    const sut = await buildPack(ctx, { oids: [blobId] });

    // Assert
    expect(sut.objectCount).toBe(1);
    const header = parsePackHeader(sut.bytes);
    expect(header.objectCount).toBe(1);
    const firstEntry = parsePackEntryHeader(sut.bytes, PACK_HEADER_BYTES, ctx.hashConfig);
    expect(firstEntry.type).toBe(PACK_ENTRY_TYPE.BLOB);
    expect(firstEntry.size).toBe(5);
  });

  it('Given mixed types (blob + tree), When buildPack runs, Then each entry type is preserved in order', async () => {
    // Arrange — write a blob, then a tree referencing it, then pack both.
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
    const blobId = await writeObject(ctx, blob);
    const treeId = await writeTree(ctx, [
      { name: 'a.bin', mode: '100644' as FileMode, id: blobId },
    ]);

    // Act
    const sut = await buildPack(ctx, { oids: [blobId, treeId] });

    // Assert — two entries; the first is the BLOB, the second is the TREE.
    expect(sut.objectCount).toBe(2);
    const first = parsePackEntryHeader(sut.bytes, PACK_HEADER_BYTES, ctx.hashConfig);
    expect(first.type).toBe(PACK_ENTRY_TYPE.BLOB);
  });

  it('Given any pack, When buildPack returns, Then the trailer SHA matches the body hash exactly', async () => {
    // Arrange — a non-empty pack so we exercise both the header-and-trailer
    // path and the body composition.
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([0xff]), id: '' as ObjectId };
    const blobId = await writeObject(ctx, blob);

    // Act
    const sut = await buildPack(ctx, { oids: [blobId] });

    // Assert — kills the swap-the-trailer mutant: bytes must end in
    // hash(body), not hash(anything-else).
    const body = sut.bytes.subarray(0, sut.bytes.length - TRAILER_BYTES);
    const expectedTrailer = await ctx.hash.hash(body);
    expect(sut.bytes.subarray(sut.bytes.length - TRAILER_BYTES)).toEqual(expectedTrailer);
    expect(sut.sha).toBe(bytesToHex(expectedTrailer));
  });
});
