import { describe, expect, it } from 'vitest';
import { hashBlob } from '../../../../src/application/primitives/hash-blob.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';

const blobOf = (content: Uint8Array): Blob => ({
  type: 'blob',
  id: '' as ObjectId,
  content,
});

describe('hashBlob', () => {
  describe('Given content and no options', () => {
    describe('When called', () => {
      it('Then returns the canonical blob OID without touching the fs', async () => {
        // Arrange
        const base = await buildSeededContext();
        const wrapped = instrumentedContext(base);
        const content = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

        // Act
        const sut = await hashBlob(wrapped.ctx, content);

        // Assert
        expect(sut).toMatch(/^[0-9a-f]{40}$/);
        const writes = wrapped
          .calls()
          .filter(
            (c) => c.method === 'write' || c.method === 'writeExclusive' || c.method === 'mkdir',
          );
        expect(writes).toEqual([]);
      });
    });
  });

  describe('Given content and write: false', () => {
    describe('When called', () => {
      it('Then returns the same OID as the no-options call and writes nothing', async () => {
        // Arrange
        const base = await buildSeededContext();
        const wrapped = instrumentedContext(base);
        const content = new Uint8Array([1, 2, 3, 4]);

        // Act
        const sut = await hashBlob(wrapped.ctx, content, { write: false });

        // Assert
        const sutNoOpt = await hashBlob(base, content);
        expect(sut).toBe(sutNoOpt);
        const writes = wrapped
          .calls()
          .filter((c) => c.method === 'write' || c.method === 'writeExclusive');
        expect(writes).toEqual([]);
      });
    });
  });

  describe('Given content and write: true', () => {
    describe('When called', () => {
      it('Then returns the same OID and files the loose object', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new Uint8Array([0x68, 0x69]); // "hi"

        // Act
        const sut = await hashBlob(ctx, content, { write: true });

        // Assert
        expect(sut).toMatch(/^[0-9a-f]{40}$/);
        const roundtripped = await readObject(ctx, sut);
        expect(roundtripped.type).toBe('blob');
        if (roundtripped.type !== 'blob') return;
        expect(Array.from(roundtripped.content)).toEqual(Array.from(content));
      });
    });
  });

  describe('Given identical content hashed with write:false then writeObject', () => {
    describe('When OIDs are compared', () => {
      it('Then the two functions agree on the OID', async () => {
        // Arrange — pins that hashBlob shares serializeAndHash with writeObject.
        const ctx = await buildSeededContext();
        const content = new Uint8Array([7, 7, 7]);

        // Act
        const hashed = await hashBlob(ctx, content);
        const written = await writeObject(ctx, blobOf(content));

        // Assert
        expect(hashed).toBe(written);
      });
    });
  });

  describe('Given an empty content buffer', () => {
    describe('When called', () => {
      it('Then returns the well-known empty-blob OID', async () => {
        // Arrange — the canonical empty-blob SHA-1 is a fixed value across
        // all git implementations; a mutant to the header format would not
        // produce this OID.
        const ctx = await buildSeededContext();

        // Act
        const sut = await hashBlob(ctx, new Uint8Array(0));

        // Assert
        expect(sut).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When hashBlob is called', () => {
      it('Then the entry guard throws before any hashing or fs work', async () => {
        // Arrange — the early guard short-circuits before serializeAndHash.
        const controller = new AbortController();
        controller.abort();
        const base = await buildSeededContext({ signal: controller.signal });
        let hashHexCalls = 0;
        const ctx = {
          ...base,
          hash: {
            ...base.hash,
            hashHex: async (data: Uint8Array): Promise<string> => {
              hashHexCalls += 1;
              return base.hash.hashHex(data);
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await hashBlob(ctx, new Uint8Array([0]));
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
        expect(hashHexCalls).toBe(0);
      });
    });
  });

  describe('Given content larger than MAX_WORKING_TREE_BLOB_BYTES', () => {
    describe('When hashBlob is called', () => {
      it('Then it throws WORKING_TREE_FILE_TOO_LARGE before any hashing or fs work', async () => {
        // Arrange — fabricate a buffer ONE byte past the cap via a typed-array
        // view that does not actually allocate the full payload (subarray
        // shares its parent's backing store via byteOffset).
        const { MAX_WORKING_TREE_BLOB_BYTES } = await import(
          '../../../../src/application/primitives/types.js'
        );
        const huge = new Uint8Array(MAX_WORKING_TREE_BLOB_BYTES + 1);
        const ctx = await buildSeededContext();

        // Act
        let caught: unknown;
        try {
          await hashBlob(ctx, huge);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('WORKING_TREE_FILE_TOO_LARGE');
      });
    });
  });

  describe('Given content sized exactly at MAX_WORKING_TREE_BLOB_BYTES', () => {
    describe('When hashBlob is called', () => {
      it('Then the cap is exclusive so it hashes instead of refusing', async () => {
        // Arrange — the guard rejects only content STRICTLY larger than the cap;
        // exactly-at-cap must pass through to hashing. Stub hashHex so the
        // 256 MiB payload is not actually digested (the boundary guard, not the
        // hash, is under test).
        const { MAX_WORKING_TREE_BLOB_BYTES } = await import(
          '../../../../src/application/primitives/types.js'
        );
        const base = await buildSeededContext();
        const stubOid = 'a'.repeat(40) as ObjectId;
        const ctx = {
          ...base,
          hash: {
            ...base.hash,
            hashHex: async (): Promise<string> => stubOid,
          },
        };
        const atCap = new Uint8Array(MAX_WORKING_TREE_BLOB_BYTES);

        // Act
        const sut = await hashBlob(ctx, atCap);

        // Assert
        expect(sut).toBe(stubOid);
      });
    });
  });

  describe('Given a non-aborted then aborted signal between hash and write', () => {
    describe('When write: true is passed', () => {
      it('Then writeObject re-checks the signal and throws OPERATION_ABORTED', async () => {
        // Arrange — writeObject has its own post-hash signal guard. We
        // simulate "abort after hashing" by injecting an abort during hashHex.
        const controller = new AbortController();
        const base = await buildSeededContext({ signal: controller.signal });
        const ctx = {
          ...base,
          hash: {
            ...base.hash,
            hashHex: async (data: Uint8Array): Promise<string> => {
              const result = await base.hash.hashHex(data);
              controller.abort();
              return result;
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await hashBlob(ctx, new Uint8Array([1]), { write: true });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert — the second guard inside writeObject catches it.
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});
