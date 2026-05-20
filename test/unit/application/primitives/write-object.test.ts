import { describe, expect, it } from 'vitest';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('writeObject', () => {
  it('Given a fresh blob, When writeObject is called, Then returns the computed id and file exists', async () => {
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
    const id = await writeObject(ctx, blob);
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    const roundtripped = await readObject(ctx, id);
    expect(roundtripped.type).toBe('blob');
  });

  it('Given two identical writes, When writeObject is called twice, Then second call is idempotent (same id, no error)', async () => {
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([2, 3]), id: '' as ObjectId };
    const id1 = await writeObject(ctx, blob);
    const id2 = await writeObject(ctx, blob);
    expect(id1).toBe(id2);
  });

  it('Given an object whose id mismatches the computed hash, When writeObject is called, Then throws OBJECT_HASH_MISMATCH', async () => {
    const ctx = await buildSeededContext();
    const blob: Blob = {
      type: 'blob',
      content: new Uint8Array([0]),
      id: 'f'.repeat(40) as ObjectId,
    };
    try {
      await writeObject(ctx, blob);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
    }
  });

  it('Given an aborted signal, When writeObject is called, Then throws OPERATION_ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = await buildSeededContext({ signal: controller.signal });
    const blob: Blob = { type: 'blob', content: new Uint8Array([0]), id: '' as ObjectId };
    try {
      await writeObject(ctx, blob);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
    }
  });

  it('Given an aborted signal, When writeObject is called, Then the entry guard throws before hashHex runs', async () => {
    // Arrange — the second abort guard (line 19) would also throw, so to pin
    // the FIRST guard (line 9) we assert it short-circuits before any hashing.
    // A `false` mutant of line 9 lets execution reach `hashHex`.
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
    const blob: Blob = { type: 'blob', content: new Uint8Array([0]), id: '' as ObjectId };

    // Act
    let caught: unknown;
    try {
      await writeObject(ctx, blob);
      expect.unreachable();
    } catch (error) {
      caught = error;
    }

    // Assert — guard fired first: no hashing happened, abort code reported.
    expect(hashHexCalls).toBe(0);
    expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
  });

  it('Given a blob, When writeObject is followed by readObject, Then round-trips correctly', async () => {
    const ctx = await buildSeededContext();
    const content = new Uint8Array([10, 20, 30, 40]);
    const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
    const id = await writeObject(ctx, blob);
    const read = await readObject(ctx, id);
    expect((read as Blob).content).toEqual(content);
  });

  it('Given a pre-declared id that matches the computed hash, When writeObject is called, Then succeeds and returns the same id', async () => {
    // Kills the ConditionalExpression mutant on `hasDeclaredId(declaredId) && declaredId !== computed`:
    // under `true`, this would incorrectly reject a correctly-declared id.
    const ctx = await buildSeededContext();
    const blob: Blob = {
      type: 'blob',
      content: new Uint8Array([42]),
      id: '' as ObjectId,
    };
    // First, compute the id by writing with no declared id.
    const computedId = await writeObject(ctx, blob);
    // Now re-write with the id pre-declared.
    const declared: Blob = { ...blob, id: computedId };
    const id2 = await writeObject(ctx, declared);
    expect(id2).toBe(computedId);
  });

  it('Given writeExclusive throws a non-FILE_EXISTS TsgitError, When writeObject is called, Then propagates the original error', async () => {
    // Kills both `isFileExists` mutants and the conditional `true`/`false` at the
    // try/catch: under `true` the error would be swallowed and return a wrong id.
    const ctx = await buildSeededContext();
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        writeExclusive: async () => {
          throw new TsgitError({ code: 'PERMISSION_DENIED', path: '/x' });
        },
      },
    };
    const blob: Blob = { type: 'blob', content: new Uint8Array([9]), id: '' as ObjectId };
    try {
      await writeObject(wrapped, blob);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
    }
  });

  it('Given writeExclusive throws a plain Error (not TsgitError), When writeObject is called, Then propagates the plain Error', async () => {
    const ctx = await buildSeededContext();
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        writeExclusive: async () => {
          throw new Error('io boom');
        },
      },
    };
    const blob: Blob = { type: 'blob', content: new Uint8Array([10]), id: '' as ObjectId };
    try {
      await writeObject(wrapped, blob);
      expect.unreachable();
    } catch (error) {
      expect(error).not.toBeInstanceOf(TsgitError);
      expect((error as Error).message).toBe('io boom');
    }
  });

  it('Given a blob, When writeObject is called, Then the objects sub-directory is the 2-char id prefix (not the full id)', async () => {
    // Kills the MethodExpression mutant on `computed.slice(0, 2)`: dropping the
    // slice makes `prefix` the full 40-char id, so mkdir creates
    // `objects/<40-char-id>` instead of `objects/<2-char-prefix>`.
    // Arrange
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([77]), id: '' as ObjectId };

    // Act
    const id = await writeObject(ctx, blob);

    // Assert — the 2-char prefix directory exists; the full-id directory does not.
    expect(await ctx.fs.exists(`/repo/.git/objects/${id.slice(0, 2)}`)).toBe(true);
    expect(await ctx.fs.exists(`/repo/.git/objects/${id}`)).toBe(false);
  });

  it('Given the signal aborts between serialize and writeExclusive, When writeObject is called, Then throws OPERATION_ABORTED (not silently writes)', async () => {
    // Kills the second `ctx.signal?.aborted` check at line 19.
    const ctx = await buildSeededContext();
    const controller = new AbortController();
    // Abort after hashing finishes but before the second check. We use a
    // hash wrapper that triggers the abort as a side effect.
    const wrapped = {
      ...ctx,
      signal: controller.signal,
      hash: {
        ...ctx.hash,
        hashHex: async (bytes: Uint8Array) => {
          const out = await ctx.hash.hashHex(bytes);
          controller.abort();
          return out;
        },
      },
    };
    const blob: Blob = { type: 'blob', content: new Uint8Array([50]), id: '' as ObjectId };
    try {
      await writeObject(wrapped, blob);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
    }
  });
});
