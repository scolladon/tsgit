import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/index.js';
import type { HashService } from '../../../src/ports/hash-service.js';

export function hashServiceContractTests(createSut: () => Promise<HashService>): void {
  describe('HashService contract', () => {
    // SHA-1 known test vectors:
    // 'hello' → aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    // '' → da39a3ee5e6b4b0d3255bfef95601890afd80709
    // 'abc' → a9993e364706816aba3e25717850c26c9cd0d89d

    it('Given known input "hello", When hashHex, Then returns SHA-1 digest', async () => {
      const sut = await createSut();
      if (sut.algorithm !== 'sha1') return; // skip for non-sha1
      const input = new TextEncoder().encode('hello');
      expect(await sut.hashHex(input)).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('Given empty input, When hashHex, Then returns empty-string SHA-1 digest', async () => {
      const sut = await createSut();
      if (sut.algorithm !== 'sha1') return;
      expect(await sut.hashHex(new Uint8Array())).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    });

    it('Given input, When hash, Then returns Uint8Array of digestLength bytes', async () => {
      const sut = await createSut();
      const result = await sut.hash(new TextEncoder().encode('hello'));
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(sut.digestLength);
    });

    it('Given same input twice, When hashing, Then returns identical results', async () => {
      const sut = await createSut();
      const input = new TextEncoder().encode('deterministic');
      const a = await sut.hashHex(input);
      const b = await sut.hashHex(input);
      expect(a).toBe(b);
    });

    it("Given algorithm property, When reading, Then is 'sha1' or 'sha256'", async () => {
      const sut = await createSut();
      expect(['sha1', 'sha256']).toContain(sut.algorithm);
    });

    it('Given digestLength, When reading, Then matches algorithm (20 for sha1, 32 for sha256)', async () => {
      const sut = await createSut();
      expect(sut.digestLength).toBe(sut.algorithm === 'sha1' ? 20 : 32);
    });

    it('Given two-part input via Hasher, When digest, Then matches one-shot hash', async () => {
      const sut = await createSut();
      const oneShot = await sut.hashHex(new TextEncoder().encode('hello world'));
      const hasher = sut.createHasher();
      hasher.update(new TextEncoder().encode('hello '));
      hasher.update(new TextEncoder().encode('world'));
      const incremental = await hasher.digestHex();
      expect(incremental).toBe(oneShot);
    });

    it('Given Hasher after digest called, When update, Then throws HASH_FAILED', async () => {
      const sut = await createSut();
      const hasher = sut.createHasher();
      hasher.update(new Uint8Array([1]));
      await hasher.digest();
      try {
        hasher.update(new Uint8Array([2]));
        expect.fail('expected HASH_FAILED');
      } catch (err) {
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('HASH_FAILED');
      }
    });

    it('Given Hasher after digest called, When digest again, Then throws HASH_FAILED', async () => {
      const sut = await createSut();
      const hasher = sut.createHasher();
      hasher.update(new Uint8Array([1]));
      await hasher.digest();
      try {
        await hasher.digest();
        expect.fail('expected HASH_FAILED');
      } catch (err) {
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('HASH_FAILED');
      }
    });
  });
}
