/**
 * Integration tests — adapter + domain interop via the Memory adapter.
 *
 * Unlike unit tests (which test single modules in isolation), these tests exercise
 * end-to-end flows that compose the real port + real domain code. As application-layer
 * primitives (Phase 7) arrive, this suite will grow to cover full read/write flows
 * against real git repositories.
 *
 * Current scope: prove that Phase 4 adapters correctly roundtrip the bytes produced
 * and consumed by Phase 1-3 domain serializers/parsers.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { parseIndex } from '../../src/domain/git-index/index-parser.js';
import { serializeIndex } from '../../src/domain/git-index/index-writer.js';
import { parseBlobContent, serializeBlobContent } from '../../src/domain/objects/blob.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';

describe('adapter + domain interop', () => {
  it('Given a blob serialized by the domain, When written via Memory FS and read back, Then roundtrips byte-identical', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const fakeId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as unknown as ObjectId;
    const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const serialized = serializeBlobContent({ type: 'blob', id: fakeId, content: original });

    // Act
    await ctx.fs.write('/repo/blob.bin', serialized);
    const readBack = await ctx.fs.read('/repo/blob.bin');
    const parsed = parseBlobContent(fakeId, readBack);

    // Assert
    expect(parsed.content).toEqual(original);
  });

  it('Given a blob hashed by the HashService, When hashed again via Hasher, Then produces identical digest', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    // Act
    const oneShot = await ctx.hash.hashHex(data);
    const hasher = ctx.hash.createHasher();
    hasher.update(data);
    const incremental = await hasher.digestHex();

    // Assert
    expect(incremental).toBe(oneShot);
  });

  it('Given deflated bytes round-tripped through the Compressor, When compared to original, Then matches', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const original = new TextEncoder().encode('git is content-addressed storage');

    // Act
    const deflated = await ctx.compressor.deflate(original);
    const inflated = await ctx.compressor.inflate(deflated);

    // Assert
    expect(inflated).toEqual(original);
  });

  it('Given an index serialized by the domain, When written via Memory FS and re-parsed, Then the round-trip preserves all entries', async () => {
    // Arrange — an empty index (0 entries, 0 extensions). v2 header + 20-byte trailing SHA-1.
    const ctx = createMemoryContext();
    const emptyIndex = {
      version: 2 as const,
      entries: [],
      extensions: [],
    };
    const body = serializeIndex(emptyIndex);
    // Append a 20-byte SHA-1 trailer computed via the HashService
    const checksum = await ctx.hash.hash(body);
    const full = new Uint8Array(body.length + checksum.length);
    full.set(body, 0);
    full.set(checksum, body.length);

    // Act
    await ctx.fs.write('/repo/.git/index', full);
    const readBack = await ctx.fs.read('/repo/.git/index');
    const parsed = parseIndex(readBack);

    // Assert
    expect(parsed.version).toBe(2);
    expect(parsed.entries).toEqual([]);
    expect(parsed.extensions).toEqual([]);
  });
});
