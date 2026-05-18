import { describe, expect, it } from 'vitest';
import { resolveObject } from '../../../../src/application/primitives/object-resolver.js';
import { createPackRegistry } from '../../../../src/application/primitives/pack-registry.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';
import { type EntrySpec, writeSyntheticPack } from './pack-fixture.js';

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

  describe('Phase 13.8 — bounded-size cap', () => {
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
});
