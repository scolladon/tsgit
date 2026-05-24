import { describe, expect, it } from 'vitest';
import { NodeHashService } from '../../../../src/adapters/node/node-hash-service.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { hashServiceContractTests } from '../../ports/hash-service.contract.js';

describe('NodeHashService', () => {
  hashServiceContractTests(async () => new NodeHashService());

  describe('node-specific behaviors', () => {
    describe('Given sha256 algorithm', () => {
      describe('When hashing "abc"', () => {
        it('Then returns known sha256 digest', async () => {
          // Arrange
          const sut = new NodeHashService('sha256');
          const input = new TextEncoder().encode('abc');

          // Act
          const hex = await sut.hashHex(input);

          // Assert
          expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
          expect(sut.digestLength).toBe(32);
        });
      });
    });

    describe('Given default constructor', () => {
      describe('When instantiating', () => {
        it('Then algorithm is sha1', async () => {
          // Arrange / Act
          const sut = new NodeHashService();

          // Assert
          expect(sut.algorithm).toBe('sha1');
          expect(sut.digestLength).toBe(20);
        });
      });
    });

    describe('Given Hasher after digest', () => {
      describe('When digestHex', () => {
        it('Then throws HASH_FAILED with digest-after-digest reason', async () => {
          // Arrange
          const service = new NodeHashService();
          const sut = service.createHasher();
          sut.update(new Uint8Array([1]));
          await sut.digest();

          // Act
          let caught: unknown;
          try {
            await sut.digestHex();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('HASH_FAILED');
          expect(data.code === 'HASH_FAILED' && data.reason).toBe('cannot digest after digest');
        });
      });
    });

    describe('Given Hasher after digestHex', () => {
      describe('When digest', () => {
        it('Then throws HASH_FAILED with digest-after-digest reason', async () => {
          // Arrange — exercises the consumed=true flag set inside digestHex
          const service = new NodeHashService();
          const sut = service.createHasher();
          sut.update(new Uint8Array([1]));
          await sut.digestHex();

          // Act
          let caught: unknown;
          try {
            await sut.digest();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('HASH_FAILED');
          expect(data.code === 'HASH_FAILED' && data.reason).toBe('cannot digest after digest');
        });
      });
      describe('When calling update', () => {
        it('Then throws HASH_FAILED with update-after-digest reason', async () => {
          // Arrange — ensures digestHex flips `consumed` and that update asserts reason
          const service = new NodeHashService();
          const sut = service.createHasher();
          sut.update(new Uint8Array([1]));
          await sut.digestHex();

          // Act
          let caught: unknown;
          try {
            sut.update(new Uint8Array([2]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('HASH_FAILED');
          expect(data.code === 'HASH_FAILED' && data.reason).toBe('cannot update after digest');
        });
      });
    });
  });
});
