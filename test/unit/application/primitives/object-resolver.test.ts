import { describe, expect, it } from 'vitest';
import { resolveObject } from '../../../../src/application/primitives/object-resolver.js';
import {
  createPackRegistry,
  type PackLookupHit,
  type PackRegistry,
  type RegisteredPack,
} from '../../../../src/application/primitives/pack-registry.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import {
  encodeOfsDistance,
  encodePackEntryHeader,
  PACK_ENTRY_TYPE,
  parsePackIndex,
  serializePackHeader,
} from '../../../../src/domain/storage/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';
import { buildSyntheticPack, type EntrySpec, writeSyntheticPack } from './pack-fixture.js';

const ENC = new TextEncoder();

/**
 * Build a single-entry packfile (header + `entryBytes` + trailer) and write it
 * to the memory fs. Returns the on-disk pack path so a stub registry can read
 * slices from it at a controlled offset.
 */
async function writeRawSingleEntryPack(
  ctx: Context,
  name: string,
  entryBytes: Uint8Array,
): Promise<string> {
  const header = serializePackHeader(2, 1);
  const body = new Uint8Array(header.length + entryBytes.length);
  body.set(header, 0);
  body.set(entryBytes, header.length);
  const trailerHex = await ctx.hash.hashHex(body);
  const trailer = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    trailer[i] = Number.parseInt(trailerHex.slice(i * 2, i * 2 + 2), 16);
  }
  const packBytes = new Uint8Array(body.length + trailer.length);
  packBytes.set(body, 0);
  packBytes.set(trailer, body.length);
  const packPath = `${ctx.layout.gitDir}/objects/pack/pack-${name}.pack`;
  await ctx.fs.write(packPath, packBytes);
  return packPath;
}

/**
 * A `PackRegistry` stub that resolves a fixed id to a fixed `{ packPath, offset }`
 * hit. `index` is a real (unrelated) `PackIndex` only to satisfy the type — the
 * object resolver never reads it. The entry at `offset` is whatever the caller
 * wrote into the pack file, so callers control exactly what the resolver parses.
 */
async function stubRegistry(
  ctx: Context,
  hits: ReadonlyArray<{
    readonly id: ObjectId;
    readonly packPath: string;
    readonly offset: number;
  }>,
): Promise<PackRegistry> {
  // A throwaway real PackIndex purely to fill the typed `index` field.
  const filler = await buildSyntheticPack(ctx, [
    { kind: 'base', type: 'blob', content: ENC.encode('filler') },
  ]);
  const fillerIndex = parsePackIndex(filler.idxBytes);
  const lookup = async (id: ObjectId): Promise<PackLookupHit | undefined> => {
    const match = hits.find((h) => h.id === id);
    if (match === undefined) return undefined;
    const pack: RegisteredPack = {
      name: 'stub',
      index: fillerIndex,
      packPath: match.packPath,
      idxPath: `${match.packPath}.idx`,
    };
    return { pack, offset: match.offset };
  };
  return { all: async () => [], refresh: () => undefined, lookup };
}

describe('object-resolver', () => {
  it('Given a seeded loose blob, When resolveObject is called, Then returns the parsed Blob', async () => {
    // Arrange
    const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
    const ctx = await buildSeededContext({ objects: [blob] });
    const { serializeObject } = await import('../../../../src/domain/objects/index.js');
    const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, id, true);

    // Assert
    expect(result.type).toBe('blob');
    expect((result as Blob).content).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('Given a missing id, When resolveObject is called, Then throws OBJECT_NOT_FOUND', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const registry = createPackRegistry(ctx);

    // Act / Assert
    try {
      await resolveObject(ctx, registry, 'f'.repeat(40) as ObjectId, true);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    }
  });

  it('Given an aborted signal, When resolveObject is called, Then throws OPERATION_ABORTED before any fs call', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();
    const ctx = await buildSeededContext({ signal: controller.signal });
    const registry = createPackRegistry(ctx);

    // Act / Assert
    try {
      await resolveObject(ctx, registry, 'a'.repeat(40) as ObjectId, true);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
    }
  });

  it('Given verifyHash=false and a corrupted loose file, When resolveObject is called, Then returns without verification error', async () => {
    // Arrange — craft a loose file whose content hash ≠ id.
    const ctx = await buildSeededContext();
    const fakeId = 'a'.repeat(40) as ObjectId;
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`;
    const rawBytes = new TextEncoder().encode('blob 3\0xyz');
    const compressed = await ctx.compressor.deflate(rawBytes);
    await ctx.fs.write(loosePath, compressed);
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, fakeId, false);

    // Assert
    expect(result.type).toBe('blob');
  });

  it('Given verifyHash=true and a corrupted loose file, When resolveObject is called, Then throws OBJECT_HASH_MISMATCH', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const fakeId = 'a'.repeat(40) as ObjectId;
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`;
    const rawBytes = new TextEncoder().encode('blob 3\0xyz');
    const compressed = await ctx.compressor.deflate(rawBytes);
    await ctx.fs.write(loosePath, compressed);
    const registry = createPackRegistry(ctx);

    // Act / Assert
    try {
      await resolveObject(ctx, registry, fakeId, true);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
    }
  });

  it('Given a synthetic pack with a base blob, When resolveObject is called, Then returns the blob', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const content = new TextEncoder().encode('hello packed blob');
    const [id] = await writeSyntheticPack(ctx, 'base-only', [
      { kind: 'base', type: 'blob', content },
    ]);
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, id as ObjectId, true);

    // Assert
    expect(result.type).toBe('blob');
    expect((result as Blob).content).toEqual(content);
  });

  it('Given a synthetic pack with an OFS_DELTA entry, When resolveObject is called on the delta, Then reconstructs the target', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('ofs base content');
    const targetContent = new TextEncoder().encode('ofs target content — different');
    const ids = await writeSyntheticPack(ctx, 'ofs', [
      { kind: 'base', type: 'blob', content: baseContent },
      { kind: 'ofs-delta', baseIndex: 0, targetContent },
    ]);
    const deltaId = ids[1]!;
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, deltaId as ObjectId, true);

    // Assert
    expect(result.type).toBe('blob');
    expect((result as Blob).content).toEqual(targetContent);
  });

  it('Given a synthetic pack with a REF_DELTA entry, When resolveObject is called on the delta, Then reconstructs the target', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('ref base');
    const targetContent = new TextEncoder().encode('ref target — different bytes');
    const ids = await writeSyntheticPack(ctx, 'ref', [
      { kind: 'base', type: 'blob', content: baseContent },
    ]);
    const baseId = ids[0]!;
    const ids2 = await writeSyntheticPack(ctx, 'ref-delta', [
      { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
    ]);
    const deltaId = ids2[0]!;
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, deltaId as ObjectId, true);

    // Assert
    expect(result.type).toBe('blob');
    expect((result as Blob).content).toEqual(targetContent);
  });

  it.each([
    ['commit', `tree ${'0'.repeat(40)}\nauthor a <a@a> 1 +0000\ncommitter a <a@a> 1 +0000\n\nm\n`],
    ['tree', ''],
    ['tag', `object ${'0'.repeat(40)}\ntype commit\ntag v1\ntagger a <a@a> 1 +0000\n\nt\n`],
  ] as const)('Given a synthetic pack with a base %s entry, When resolveObject is called, Then result.type equals the kind', async (kind, text) => {
    // Arrange — valid minimal content for each kind so parseObject succeeds
    // and result.type is strictly asserted; this kills isBase / packTypeName
    // StringLiteral mutants for 'tree' and 'tag'.
    const ctx = await buildSeededContext();
    const content = new TextEncoder().encode(text);
    const [id] = await writeSyntheticPack(ctx, `base-${kind}`, [
      { kind: 'base', type: kind, content },
    ]);
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, id as ObjectId, false);

    // Assert
    expect(result.type).toBe(kind);
  });

  describe('bounded-size cap', () => {
    it('Given a cached REF_DELTA base at the exact maxBytes boundary, When resolveObject is called, Then accepts (cache-cap inclusive boundary)', async () => {
      // Arrange — cache contains a 5-byte payload, cap=5. Boundary kill
      // for the `actualSize > maxBytes` mutant: with `>=` it would
      // wrongly reject; with `>` it accepts.
      const ctx = await buildSeededContext();
      const baseContent = new TextEncoder().encode('abcde'); // 5 bytes
      const [baseId] = await writeSyntheticPack(ctx, 'cap-cache-eq-base', [
        { kind: 'base', type: 'blob', content: baseContent },
      ]);
      const [deltaId] = await writeSyntheticPack(ctx, 'cap-cache-eq-delta', [
        {
          kind: 'ref-delta',
          baseId: baseId!,
          baseUncompressed: baseContent,
          targetContent: new TextEncoder().encode('xy'),
        },
      ]);
      const registry = createPackRegistry(ctx);
      // Prime the cache with the base.
      await resolveObject(ctx, registry, baseId as ObjectId, false);

      // Act — exact boundary cap=5, base size=5 → accept.
      const sut = await resolveObject(ctx, registry, deltaId as ObjectId, false, 5);

      // Assert
      expect(sut.type).toBe('blob');
    });

    it('Given a REF_DELTA whose base is in the LRU cache and exceeds maxBytes, When resolveObject is called, Then throws OBJECT_TOO_LARGE from enforceCachedCap', async () => {
      // Arrange — prime the deltaCache with a base larger than the cap,
      // then issue a capped REF_DELTA read whose base resolves via the
      // cache hit. The enforceCachedCap path must fire and reject; without
      // it, an oversized object admitted by an earlier uncapped read
      // would silently bypass the cap on subsequent capped reads.
      const ctx = await buildSeededContext();
      const baseContent = new TextEncoder().encode('cached-base-bytes');
      // Build a synthetic pack with the base so we have a real ObjectId.
      const [baseId] = await writeSyntheticPack(ctx, 'cap-cache-base', [
        { kind: 'base', type: 'blob', content: baseContent },
      ]);
      const [deltaId] = await writeSyntheticPack(ctx, 'cap-cache-delta', [
        {
          kind: 'ref-delta',
          baseId: baseId!,
          baseUncompressed: baseContent,
          targetContent: new TextEncoder().encode('xx'),
        },
      ]);
      const registry = createPackRegistry(ctx);
      // Prime the cache: an uncapped read admits the base.
      await resolveObject(ctx, registry, baseId as ObjectId, false);
      expect(ctx.deltaCache.get(baseId as ObjectId)).toBeDefined();

      // Act — capped REF_DELTA read; base resolves via cache hit.
      try {
        await resolveObject(ctx, registry, deltaId as ObjectId, false, 4);
        expect.unreachable();
      } catch (error) {
        const data = (error as TsgitError).data;
        // Assert — must be OBJECT_TOO_LARGE, NOT some downstream code
        // like OBJECT_NOT_FOUND that would indicate a different bypass.
        expect(data.code).toBe('OBJECT_TOO_LARGE');
        if (data.code !== 'OBJECT_TOO_LARGE') {
          expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
        }
        expect(data.id).toBe(baseId);
        expect(data.actualSize).toBe(baseContent.length);
        expect(data.limit).toBe(4);
      }
    });

    it('Given a synthetic pack with an OFS_DELTA chain whose BASE exceeds maxBytes, When resolveObject is called, Then throws OBJECT_TOO_LARGE on the base (intermediate-base cap, not target-only)', async () => {
      // Arrange — base of 9 bytes + ofs-delta whose target is 2 bytes.
      // With maxBytes=4: the pre-apply check on the delta's target (2)
      // PASSES, but the base entry's declared size (9) exceeds the cap.
      // Without the fix (depth-gated enforcePackBaseCap), the base would
      // inflate into memory; the cap protects against this.
      const ctx = await buildSeededContext();
      const baseContent = new TextEncoder().encode('123456789');
      const targetContent = new TextEncoder().encode('xy');
      const ids = await writeSyntheticPack(ctx, 'cap-ofs-base-bypass', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent },
      ]);
      const deltaId = ids[1] as ObjectId;
      const registry = createPackRegistry(ctx);

      // Act / Assert — cap rejects on the base, not the target.
      try {
        await resolveObject(ctx, registry, deltaId, false, 4);
        expect.unreachable();
      } catch (error) {
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OBJECT_TOO_LARGE');
        if (data.code !== 'OBJECT_TOO_LARGE') {
          expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
        }
        // `actualSize=9` proves the cap fired on the BASE's declared size
        // (9 bytes) and not on the delta's target (2 bytes).
        expect(data.actualSize).toBe(9);
        expect(data.limit).toBe(4);
      }
    });

    it('Given a delta whose declared target-size varint exceeds maxBytes, When resolveObject is called, Then throws OBJECT_TOO_LARGE pre-apply (varint peek, not post-apply)', async () => {
      // Arrange — base 2 bytes, delta target 8 bytes, cap 4. The pre-
      // apply varint check reads targetSize=8 from the delta's leading
      // varints and rejects BEFORE the apply loop runs. Killing the
      // mutant that removes the pre-apply check leaves the post-apply
      // check still firing (with current.length=8 instead of declared 8).
      const ctx = await buildSeededContext();
      const baseContent = new TextEncoder().encode('ab');
      const targetContent = new TextEncoder().encode('abcdefgh');
      const ids = await writeSyntheticPack(ctx, 'cap-pre-apply', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent },
      ]);
      const deltaId = ids[1] as ObjectId;
      const registry = createPackRegistry(ctx);

      // Act / Assert
      try {
        await resolveObject(ctx, registry, deltaId, false, 4);
        expect.unreachable();
      } catch (error) {
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OBJECT_TOO_LARGE');
        if (data.code !== 'OBJECT_TOO_LARGE') {
          expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
        }
        expect(data.actualSize).toBe(8);
        expect(data.limit).toBe(4);
      }
    });
  });

  it('Given a pack-resolved target, When resolveObject is called, Then the reconstructed bytes land in the delta cache', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('cache base');
    const targetContent = new TextEncoder().encode('cache target — different');
    const ids = await writeSyntheticPack(ctx, 'cache', [
      { kind: 'base', type: 'blob', content: baseContent },
      { kind: 'ofs-delta', baseIndex: 0, targetContent },
    ]);
    const deltaId = ids[1]! as ObjectId;
    const registry = createPackRegistry(ctx);
    expect(ctx.deltaCache.get(deltaId)).toBeUndefined();

    // Act
    await resolveObject(ctx, registry, deltaId, true);

    // Assert — cacheEntry must have populated the cache; killing the
    // BlockStatement mutant that empties the function body.
    const cached = ctx.deltaCache.get(deltaId);
    expect(cached).toBeDefined();
    expect(cached!.length).toBeGreaterThan(0);
  });

  it('Given a synthetic pack with a 2-hop OFS_DELTA chain, When resolveObject is called on the tip, Then applies deltas in reverse order', async () => {
    // Arrange — base ← delta1 ← delta2. Correct reconstruction applies delta2 on
    // delta1's output. Reversing the apply-loop direction yields the wrong bytes.
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('AAAA');
    const mid = new TextEncoder().encode('BBBB');
    const tip = new TextEncoder().encode('CCCC');
    const ids = await writeSyntheticPack(ctx, 'ofs-chain', [
      { kind: 'base', type: 'blob', content: baseContent },
      { kind: 'ofs-delta', baseIndex: 0, targetContent: mid },
      { kind: 'ofs-delta', baseIndex: 1, targetContent: tip },
    ]);
    const tipId = ids[2]!;
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, tipId as ObjectId, true);

    // Assert
    expect(result.type).toBe('blob');
    expect((result as Blob).content).toEqual(tip);
  });

  it.each([
    ['tree', new Uint8Array()],
    [
      'tag',
      new TextEncoder().encode(
        `object ${'0'.repeat(40)}\ntype commit\ntag v1\ntagger a <a@a> 1 +0000\n\nt\n`,
      ),
    ],
  ] as const)('Given a REF_DELTA whose base is a %s, When resolveObject is called, Then typeNameToPackType matches the kind', async (kind, baseContent) => {
    // Arrange
    const ctx = await buildSeededContext();
    const [baseId] = await writeSyntheticPack(ctx, `ref-${kind}-base`, [
      { kind: 'base', type: kind, content: baseContent },
    ]);
    const [deltaId] = await writeSyntheticPack(ctx, `ref-${kind}-delta`, [
      {
        kind: 'ref-delta',
        baseId: baseId!,
        baseUncompressed: baseContent,
        targetContent: baseContent,
      },
    ]);
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, deltaId as ObjectId, false);

    // Assert
    expect(result.type).toBe(kind);
  });

  it('Given an OFS_DELTA chain of exactly length 50 (at cap), When resolveObject is called, Then reconstructs without throwing DELTA_CHAIN_TOO_DEEP', async () => {
    // Arrange — base + 50 chained OFS deltas. Depth walker hits exactly
    // MAX_DELTA_CHAIN_DEPTH=50, but the guard uses `>`, not `>=`, so this must
    // succeed. Kills the `depth >= MAX_DELTA_CHAIN_DEPTH` mutant.
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('x');
    const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
    for (let i = 0; i < 50; i += 1) {
      const target = new TextEncoder().encode(`t-${i}`);
      entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
    }
    const ids = await writeSyntheticPack(ctx, 'at-cap', entries);
    const tipId = ids.at(-1)! as ObjectId;
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, tipId, false);

    // Assert
    expect(result.type).toBe('blob');
  });

  it('Given a REF_DELTA whose base is a commit, When resolveObject is called, Then typeNameToPackType returns the commit constant', async () => {
    // Arrange — round-trip a valid commit base into the pack, then a REF_DELTA
    // pointing at it. Ensures splitHeader/typeNameToPackType hit the 'commit' arm.
    const ctx = await buildSeededContext();
    const { serializeObject } = await import('../../../../src/domain/objects/index.js');
    const treeId = 'a'.repeat(40) as ObjectId;
    const commitObj = {
      type: 'commit' as const,
      id: '' as ObjectId,
      data: {
        tree: treeId,
        parents: [],
        author: {
          name: 'a',
          email: 'a@a.com',
          timestamp: 1,
          timezoneOffset: '+0000' as const,
        },
        committer: {
          name: 'a',
          email: 'a@a.com',
          timestamp: 1,
          timezoneOffset: '+0000' as const,
        },
        message: 'm',
        extraHeaders: [],
      },
    };
    const commitBytes = serializeObject(commitObj, ctx.hashConfig);
    // Strip the `commit <n>\0` header so the pack stores only the content.
    const nul = commitBytes.indexOf(0);
    const commitContent = commitBytes.subarray(nul + 1);
    const [baseId] = await writeSyntheticPack(ctx, 'ref-commit-base', [
      { kind: 'base', type: 'commit', content: commitContent },
    ]);
    // REF_DELTA that rebuilds the same commit content (delta is a pure INSERT).
    const [deltaId] = await writeSyntheticPack(ctx, 'ref-commit-delta', [
      {
        kind: 'ref-delta',
        baseId: baseId!,
        baseUncompressed: commitContent,
        targetContent: commitContent,
      },
    ]);
    const registry = createPackRegistry(ctx);

    // Act
    const result = await resolveObject(ctx, registry, deltaId as ObjectId, false);

    // Assert — the reconstructed object must be a commit (not mis-typed as blob).
    expect(result.type).toBe('commit');
  });

  it('Given a REF_DELTA whose cached base bytes lack a NUL but contain a valid-looking type prefix, When resolveObject is called, Then splitHeader throws OBJECT_NOT_FOUND (not a downstream delta error)', async () => {
    // Arrange — poison the cache with `blob 9 garbage` (no NUL). If the nulIdx
    // guard is skipped, the subsequent space-based typeName parse would succeed
    // and return a wrong type/content, producing a delta error. We assert
    // OBJECT_NOT_FOUND to pin the nulIdx guard.
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('ref base');
    const targetContent = new TextEncoder().encode('ref target');
    const [baseId] = await writeSyntheticPack(ctx, 'ref-no-nul-base', [
      { kind: 'base', type: 'blob', content: baseContent },
    ]);
    const [deltaId] = await writeSyntheticPack(ctx, 'ref-no-nul-delta', [
      {
        kind: 'ref-delta',
        baseId: baseId!,
        baseUncompressed: baseContent,
        targetContent,
      },
    ]);
    const bad = new TextEncoder().encode('blob 9 garbage');
    ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
    const registry = createPackRegistry(ctx);

    // Act / Assert
    try {
      await resolveObject(ctx, registry, deltaId as ObjectId, false);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    }
  });

  it('Given cached bytes with a NUL but no space in the header slice, When resolveObject is called, Then splitHeader throws OBJECT_NOT_FOUND (not a downstream delta error)', async () => {
    // Arrange — `blob\0` gives a valid type name only if the space guard is
    // skipped (subarray(0, -1) on 5 bytes yields "blob"). We assert
    // OBJECT_NOT_FOUND to pin the space guard.
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('ref base');
    const targetContent = new TextEncoder().encode('ref target');
    const [baseId] = await writeSyntheticPack(ctx, 'ref-no-space-base', [
      { kind: 'base', type: 'blob', content: baseContent },
    ]);
    const [deltaId] = await writeSyntheticPack(ctx, 'ref-no-space-delta', [
      {
        kind: 'ref-delta',
        baseId: baseId!,
        baseUncompressed: baseContent,
        targetContent,
      },
    ]);
    const bad = new TextEncoder().encode('blob\0');
    ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
    const registry = createPackRegistry(ctx);

    // Act / Assert
    try {
      await resolveObject(ctx, registry, deltaId as ObjectId, false);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    }
  });

  it('Given an OFS_DELTA chain of length 51, When resolveObject is called, Then throws DELTA_CHAIN_TOO_DEEP', async () => {
    // Arrange — base + 51 chained OFS deltas, each delta reconstructs unique bytes
    // so every entry has a distinct id (prevents pack-lookup collisions).
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('base');
    const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
    for (let i = 0; i < 51; i += 1) {
      const target = new TextEncoder().encode(`target-${i}`);
      entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
    }
    const ids = await writeSyntheticPack(ctx, 'long-chain', entries);
    const tipId = ids.at(-1)! as ObjectId;
    const registry = createPackRegistry(ctx);

    // Act / Assert
    try {
      await resolveObject(ctx, registry, tipId, false);
      throw new Error('should not reach here');
    } catch (error) {
      if (!(error instanceof TsgitError)) throw error;
      expect(error.data.code).toBe('DELTA_CHAIN_TOO_DEEP');
    }
  });

  it('Given cached bytes with an unknown type name, When splitHeader runs typeNameToPackType, Then throws OBJECT_NOT_FOUND', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('ref base');
    const targetContent = new TextEncoder().encode('ref target');
    const [baseId] = await writeSyntheticPack(ctx, 'ref-unknown-base', [
      { kind: 'base', type: 'blob', content: baseContent },
    ]);
    const [deltaId] = await writeSyntheticPack(ctx, 'ref-unknown-delta', [
      {
        kind: 'ref-delta',
        baseId: baseId!,
        baseUncompressed: baseContent,
        targetContent,
      },
    ]);
    const bad = new TextEncoder().encode('weird 5\0hello');
    ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
    const registry = createPackRegistry(ctx);

    // Act / Assert
    try {
      await resolveObject(ctx, registry, deltaId as ObjectId, false);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    }
  });

  describe('enforceCachedCap guard', () => {
    it('Given a capped REF_DELTA whose cached base buffer has no NUL and exceeds the cap, When resolveObject runs, Then throws OBJECT_NOT_FOUND (kills the nulIdx<0 conditional)', async () => {
      // Arrange — poison the cache with a header-less buffer LARGER than the
      // cap, then issue a capped REF_DELTA read whose base resolves via the
      // cache hit. With the `if (nulIdx < 0) return` guard intact, the cap is
      // skipped and `splitHeader` rejects the buffer as OBJECT_NOT_FOUND. If
      // the conditional is forced `false`, the cap runs with `nulIdx = -1`,
      // computes `actualSize = cached.length`, and throws OBJECT_TOO_LARGE
      // instead — a different observable code.
      const ctx = await buildSeededContext();
      const baseContent = new TextEncoder().encode('cap-no-nul base');
      // Target stays at 2 bytes so the pre-apply cap passes and the base
      // (cache) path runs — the pre-apply cap fires on the delta target.
      const targetContent = new TextEncoder().encode('xy');
      const [baseId] = await writeSyntheticPack(ctx, 'cap-no-nul-base', [
        { kind: 'base', type: 'blob', content: baseContent },
      ]);
      const [deltaId] = await writeSyntheticPack(ctx, 'cap-no-nul-delta', [
        { kind: 'ref-delta', baseId: baseId!, baseUncompressed: baseContent, targetContent },
      ]);
      // 14-byte buffer, no NUL anywhere.
      const bad = new TextEncoder().encode('blob 9 garbage');
      ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
      const registry = createPackRegistry(ctx);

      // Act / Assert — cap = 4, far below the 14-byte poisoned buffer.
      try {
        await resolveObject(ctx, registry, deltaId as ObjectId, false, 4);
        expect.unreachable();
      } catch (error) {
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        if (data.code !== 'OBJECT_NOT_FOUND') {
          expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
        }
      }
    });

    it('Given a capped REF_DELTA whose cached base buffer starts with a NUL and exceeds the cap, When resolveObject runs, Then throws OBJECT_TOO_LARGE (kills the nulIdx<0 equality operator)', async () => {
      // Arrange — cached buffer with the NUL at index 0, so `nulIdx === 0`.
      // With `nulIdx < 0` the guard is false → the cap runs → content size
      // `length - 1` exceeds the cap → OBJECT_TOO_LARGE. The `<=` mutant
      // makes `0 <= 0` true → the guard returns early → `splitHeader` then
      // throws OBJECT_NOT_FOUND, a different code.
      const ctx = await buildSeededContext();
      const baseContent = new TextEncoder().encode('cap-nul0 base');
      // Target stays at 2 bytes so the pre-apply cap passes and the base
      // (cache) path runs — the pre-apply cap fires on the delta target.
      const targetContent = new TextEncoder().encode('xy');
      const [baseId] = await writeSyntheticPack(ctx, 'cap-nul0-base', [
        { kind: 'base', type: 'blob', content: baseContent },
      ]);
      const [deltaId] = await writeSyntheticPack(ctx, 'cap-nul0-delta', [
        { kind: 'ref-delta', baseId: baseId!, baseUncompressed: baseContent, targetContent },
      ]);
      // 21 bytes: NUL at index 0, then 20 content bytes → content size 20.
      const bad = new Uint8Array(21);
      bad[0] = 0x00;
      bad.fill(0x41, 1);
      ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
      const registry = createPackRegistry(ctx);

      // Act / Assert — cap = 4, content size 20 > 4.
      try {
        await resolveObject(ctx, registry, deltaId as ObjectId, false, 4);
        expect.unreachable();
      } catch (error) {
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OBJECT_TOO_LARGE');
        if (data.code !== 'OBJECT_TOO_LARGE') {
          expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
        }
        expect(data.id).toBe(baseId);
        expect(data.actualSize).toBe(20);
        expect(data.limit).toBe(4);
      }
    });
  });

  describe('OFS_DELTA base-offset guard', () => {
    it('Given an OFS_DELTA whose base distance points before the pack body (negative offset), When resolveObject runs, Then throws OBJECT_NOT_FOUND', async () => {
      // Arrange — a single OFS_DELTA at offset 12 with a base distance of
      // 100, so `nextOffset = 12 - 100 = -88`. The `if (nextOffset < 0)`
      // guard must throw OBJECT_NOT_FOUND. Forcing the conditional `false`
      // would carry a negative offset into the next chain hop instead.
      const ctx = await buildSeededContext();
      const deltaBody = await ctx.compressor.deflate(new Uint8Array([0x00, 0x00]));
      const entry = new Uint8Array([
        ...encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0),
        ...encodeOfsDistance(100),
        ...deltaBody,
      ]);
      const packPath = await writeRawSingleEntryPack(ctx, 'ofs-negative', entry);
      const targetId = 'a'.repeat(40) as ObjectId;
      const registry = await stubRegistry(ctx, [{ id: targetId, packPath, offset: 12 }]);

      // Act / Assert
      try {
        await resolveObject(ctx, registry, targetId, false);
        expect.unreachable();
      } catch (error) {
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        if (data.code !== 'OBJECT_NOT_FOUND') {
          expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
        }
      }
    });

    it('Given an OFS_DELTA whose base distance lands exactly on offset 0, When resolveObject runs, Then the chain walks into the pack magic and throws INVALID_PACK_ENTRY (kills the nextOffset<0 equality operator)', async () => {
      // Arrange — a single OFS_DELTA at offset 12 with base distance 12, so
      // `nextOffset = 12 - 12 = 0`. With `nextOffset < 0` the guard is false
      // → the walker continues to offset 0 and parses the `PACK` magic as an
      // entry header → reserved type 5 → INVALID_PACK_ENTRY. The `<=` mutant
      // makes `0 <= 0` true → it throws OBJECT_NOT_FOUND instead.
      const ctx = await buildSeededContext();
      const deltaBody = await ctx.compressor.deflate(new Uint8Array([0x00, 0x00]));
      const entry = new Uint8Array([
        ...encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0),
        ...encodeOfsDistance(12),
        ...deltaBody,
      ]);
      const packPath = await writeRawSingleEntryPack(ctx, 'ofs-zero', entry);
      const targetId = 'a'.repeat(40) as ObjectId;
      const registry = await stubRegistry(ctx, [{ id: targetId, packPath, offset: 12 }]);

      // Act / Assert — current code reaches offset 0 and rejects the magic.
      try {
        await resolveObject(ctx, registry, targetId, false);
        expect.unreachable();
      } catch (error) {
        const data = (error as TsgitError).data;
        expect(data.code).toBe('INVALID_PACK_ENTRY');
        if (data.code !== 'INVALID_PACK_ENTRY') {
          expect.fail(`expected INVALID_PACK_ENTRY, got ${data.code}`);
        }
      }
    });
  });

  it('Given a pack base entry whose declared size lies small but inflates large, When a capped resolveObject runs, Then the post-apply cap throws OBJECT_TOO_LARGE', async () => {
    // Arrange — a base blob entry whose header declares size 1 (so the
    // pre-inflate `enforcePackBaseCap` passes the cap of 4) while the zlib
    // body inflates to 40 bytes. With no deltas the post-apply check in
    // `resolvePackChain` is the only guard left; emptying its block lets the
    // oversized object through silently.
    const ctx = await buildSeededContext();
    const bigContent = new TextEncoder().encode('A'.repeat(40));
    const deflated = await ctx.compressor.deflate(bigContent);
    const entry = new Uint8Array([
      // Declares size 1, not 40 — the deliberate lie.
      ...encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, 1),
      ...deflated,
    ]);
    const packPath = await writeRawSingleEntryPack(ctx, 'lying-size-base', entry);
    const targetId = 'a'.repeat(40) as ObjectId;
    const registry = await stubRegistry(ctx, [{ id: targetId, packPath, offset: 12 }]);

    // Act / Assert — cap 4, actual inflated content 40 bytes.
    try {
      await resolveObject(ctx, registry, targetId, false, 4);
      expect.unreachable();
    } catch (error) {
      const data = (error as TsgitError).data;
      expect(data.code).toBe('OBJECT_TOO_LARGE');
      if (data.code !== 'OBJECT_TOO_LARGE') {
        expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
      }
      expect(data.actualSize).toBe(40);
      expect(data.limit).toBe(4);
    }
  });

  it('Given a REF_DELTA whose base id does not match the base content hash, When resolveObject runs, Then the base resolves without hash verification', async () => {
    // Arrange — the REF_DELTA declares base id `B`, but the entry the stub
    // registry maps `B` to holds content that hashes to something else.
    // `resolveBaseForRefDelta` resolves the base with verifyHash=false, so
    // the mismatch is tolerated. Flipping that argument to `true` makes the
    // recursive `resolveObject` verify the base and throw OBJECT_HASH_MISMATCH.
    const ctx = await buildSeededContext();
    const baseContent = new TextEncoder().encode('mismatch base content');
    const targetContent = new TextEncoder().encode('mismatch target content');
    const fakeBaseId = 'b'.repeat(40) as ObjectId;
    const targetId = 'd'.repeat(40) as ObjectId;
    // Pack A — the base blob, reached only via the stub's fake-id mapping.
    const basePack = await buildSyntheticPack(ctx, [
      { kind: 'base', type: 'blob', content: baseContent },
    ]);
    const basePackPath = `${ctx.layout.gitDir}/objects/pack/pack-mismatch-base.pack`;
    await ctx.fs.write(basePackPath, basePack.packBytes);
    // The base's real id must differ from the fake id we look it up by.
    expect(basePack.ids[0]).not.toBe(fakeBaseId);
    // Pack B — a REF_DELTA that declares `fakeBaseId` as its base.
    const deltaPack = await buildSyntheticPack(ctx, [
      {
        kind: 'ref-delta',
        baseId: fakeBaseId,
        baseUncompressed: baseContent,
        targetContent,
      },
    ]);
    const deltaPackPath = `${ctx.layout.gitDir}/objects/pack/pack-mismatch-delta.pack`;
    await ctx.fs.write(deltaPackPath, deltaPack.packBytes);
    const registry = await stubRegistry(ctx, [
      { id: targetId, packPath: deltaPackPath, offset: 12 },
      { id: fakeBaseId, packPath: basePackPath, offset: 12 },
    ]);

    // Act
    const result = await resolveObject(ctx, registry, targetId, false);

    // Assert — base resolved unverified; the delta reconstructs the target.
    expect(result.type).toBe('blob');
    expect((result as Blob).content).toEqual(targetContent);
  });
});
