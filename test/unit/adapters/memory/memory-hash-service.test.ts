import { describe, expect, it } from 'vitest';
import { MemoryHashService } from '../../../../src/adapters/memory/memory-hash-service.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { hashServiceContractTests } from '../../ports/hash-service.contract.js';

describe('MemoryHashService', () => {
  hashServiceContractTests(async () => new MemoryHashService('sha1'));

  describe('memory-specific behaviors', () => {
    it('Given SHA-256 algorithm, When hashing, Then returns 32-byte digest', async () => {
      // Arrange
      const sut = new MemoryHashService('sha256');

      // Act
      const result = await sut.hash(new TextEncoder().encode('hello'));

      // Assert
      expect(sut.algorithm).toBe('sha256');
      expect(sut.digestLength).toBe(32);
      expect(result.length).toBe(32);
    });

    it('Given SHA-1 known vector, When hashHex, Then returns expected digest', async () => {
      // Arrange
      const sut = new MemoryHashService('sha1');

      // Act
      const result = await sut.hashHex(new TextEncoder().encode('abc'));

      // Assert
      expect(result).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    });

    it('Given Hasher after digestHex, When calling update, Then throws HASH_FAILED with update-after-digest reason', async () => {
      // Arrange
      const sut = new MemoryHashService('sha1');
      const hasher = sut.createHasher();
      hasher.update(new Uint8Array([1]));
      await hasher.digestHex();

      // Act
      let caught: unknown;
      try {
        hasher.update(new Uint8Array([2]));
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('HASH_FAILED');
      expect(data.code === 'HASH_FAILED' && data.reason).toBe('cannot update after digest');
    });

    it('Given Hasher after digest, When digesting again, Then throws HASH_FAILED with digest-after-digest reason', async () => {
      // Arrange
      const sut = new MemoryHashService('sha1');
      const hasher = sut.createHasher();
      hasher.update(new Uint8Array([1]));
      await hasher.digest();

      // Act
      let caught: unknown;
      try {
        await hasher.digestHex();
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('HASH_FAILED');
      expect(data.code === 'HASH_FAILED' && data.reason).toBe('cannot digest after digest');
    });

    it('Given Hasher mutated input buffer after update, When digesting, Then uses original bytes', async () => {
      // Arrange
      const sut = new MemoryHashService('sha1');
      const hasher = sut.createHasher();
      const input = new TextEncoder().encode('hello');
      const oneShot = await sut.hashHex(input);
      hasher.update(input);

      // Act
      input[0] = 0;
      const digest = await hasher.digestHex();

      // Assert
      expect(digest).toBe(oneShot);
    });

    it('Given crypto.subtle unavailable, When constructing, Then throws HASH_FAILED with subtle-unavailable reason', () => {
      // Arrange
      const original = globalThis.crypto;
      Object.defineProperty(globalThis, 'crypto', {
        value: undefined,
        configurable: true,
      });

      try {
        // Act
        let caught: unknown;
        try {
          new MemoryHashService('sha1');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('HASH_FAILED');
        expect(data.code === 'HASH_FAILED' && data.reason).toBe('crypto.subtle unavailable');
      } finally {
        Object.defineProperty(globalThis, 'crypto', {
          value: original,
          configurable: true,
        });
      }
    });
  });
});
