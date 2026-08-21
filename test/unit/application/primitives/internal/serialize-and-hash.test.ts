import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { serializeAndHash } from '../../../../../src/application/primitives/internal/serialize-and-hash.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../../src/domain/objects/hash-config.js';
import type { GitObject, ObjectId } from '../../../../../src/domain/objects/index.js';
import { TsgitError } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const ENC = new TextEncoder();

function blob(content: Uint8Array): GitObject {
  return { type: 'blob', id: '' as ObjectId, content };
}

describe('serializeAndHash', () => {
  describe('Given a sha1 hash service under a SHA-256 declared hash config', () => {
    describe('When serializeAndHash is called', () => {
      it('Then throws INVALID_OBJECT_ID carrying the mismatched hex', async () => {
        // Arrange — a 40-hex digest cannot satisfy a 64-hex-wide config.
        const ctx: Context = {
          ...createMemoryContext({ algorithm: 'sha1' }),
          hashConfig: SHA256_CONFIG,
        };
        const sut = serializeAndHash;

        // Act
        try {
          await sut(ctx, blob(ENC.encode('sha1-under-sha256-config')));
          expect.unreachable();
        } catch (error) {
          // Assert
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_ID');
          if (data.code !== 'INVALID_OBJECT_ID') {
            expect.fail(`expected INVALID_OBJECT_ID, got ${data.code}`);
          }
          expect(data.value).toHaveLength(40);
        }
      });
    });
  });

  describe('Given a sha256 hash service under a SHA-1 declared hash config', () => {
    describe('When serializeAndHash is called', () => {
      it('Then throws INVALID_OBJECT_ID carrying the mismatched hex', async () => {
        // Arrange — a 64-hex digest cannot satisfy a 40-hex-wide config.
        const ctx: Context = {
          ...createMemoryContext({ algorithm: 'sha256' }),
          hashConfig: SHA1_CONFIG,
        };
        const sut = serializeAndHash;

        // Act
        try {
          await sut(ctx, blob(ENC.encode('sha256-under-sha1-config')));
          expect.unreachable();
        } catch (error) {
          // Assert
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_ID');
          if (data.code !== 'INVALID_OBJECT_ID') {
            expect.fail(`expected INVALID_OBJECT_ID, got ${data.code}`);
          }
          expect(data.value).toHaveLength(64);
        }
      });
    });
  });

  describe('Given a hash service whose output width agrees with the declared hash config', () => {
    describe('When serializeAndHash is called', () => {
      it('Then returns the serialised bytes and the computed id', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha1' });
        const sut = serializeAndHash;

        // Act
        const result = await sut(ctx, blob(ENC.encode('agreeing width')));

        // Assert
        expect(result.id).toHaveLength(40);
        expect(result.bytes.length).toBeGreaterThan(0);
      });
    });
  });
});
