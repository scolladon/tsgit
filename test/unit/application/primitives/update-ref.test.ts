import { describe, expect, it } from 'vitest';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;

describe('updateRef', () => {
  it('Given a fresh ref, When updateRef is called, Then resolveRef returns the new id', async () => {
    const ctx = await buildSeededContext();
    await updateRef(ctx, 'refs/heads/new' as RefName, ID_A);
    const sut = await resolveRef(ctx, 'refs/heads/new' as RefName);
    expect(sut).toBe(ID_A);
  });

  it('Given a pre-existing .lock file, When updateRef is called, Then throws REF_LOCKED', async () => {
    const ctx = await buildSeededContext();
    await ctx.fs.write('/repo/.git/refs/heads/busy.lock', new Uint8Array([0]));
    try {
      await updateRef(ctx, 'refs/heads/busy' as RefName, ID_A);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_LOCKED');
    }
  });

  it('Given CAS hit (expected matches current), When updateRef is called, Then succeeds', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/main' as RefName, id: ID_A }],
    });
    await updateRef(ctx, 'refs/heads/main' as RefName, ID_B, { expected: ID_A });
    const sut = await resolveRef(ctx, 'refs/heads/main' as RefName);
    expect(sut).toBe(ID_B);
  });

  it('Given CAS miss (expected differs from current), When updateRef is called, Then throws REF_UPDATE_CONFLICT with data.expected and data.actual populated', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/main' as RefName, id: ID_A }],
    });
    try {
      await updateRef(ctx, 'refs/heads/main' as RefName, ID_B, { expected: ID_B });
      expect.unreachable();
    } catch (error) {
      const data = (error as TsgitError).data;
      expect(data.code).toBe('REF_UPDATE_CONFLICT');
      if (data.code === 'REF_UPDATE_CONFLICT') {
        expect(data.expected).toBe(ID_B);
        expect(data.actual).toBe(ID_A);
      }
    }
  });

  it('Given CAS expected="absent" on a missing ref, When updateRef is called, Then succeeds', async () => {
    const ctx = await buildSeededContext();
    await updateRef(ctx, 'refs/heads/fresh' as RefName, ID_A, { expected: 'absent' });
    const sut = await resolveRef(ctx, 'refs/heads/fresh' as RefName);
    expect(sut).toBe(ID_A);
  });

  it('Given CAS expected="absent" on an existing ref, When updateRef is called, Then throws REF_UPDATE_CONFLICT', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/main' as RefName, id: ID_A }],
    });
    try {
      await updateRef(ctx, 'refs/heads/main' as RefName, ID_B, { expected: 'absent' });
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_UPDATE_CONFLICT');
    }
  });

  it('Given an invalid ref name, When updateRef is called, Then throws INVALID_REF', async () => {
    const ctx = await buildSeededContext();
    try {
      await updateRef(ctx, '..' as RefName, ID_A);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_REF');
    }
  });

  it('Given delete=true on a loose ref, When updateRef is called, Then ref is removed', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/tmp' as RefName, id: ID_A }],
    });
    await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { delete: true });
    expect(await ctx.fs.exists('/repo/.git/refs/heads/tmp')).toBe(false);
  });

  it('Given delete=true on a packed-only ref, When updateRef is called, Then throws UNSUPPORTED_OPERATION with operation and reason set', async () => {
    const ctx = await buildSeededContext({
      packedRefs: [{ name: 'refs/tags/old' as RefName, id: ID_A }],
    });
    try {
      await updateRef(ctx, 'refs/tags/old' as RefName, ID_A, { delete: true });
      expect.unreachable();
    } catch (error) {
      const data = (error as TsgitError).data;
      expect(data.code).toBe('UNSUPPORTED_OPERATION');
      if (data.code === 'UNSUPPORTED_OPERATION') {
        expect(data.operation).toBe('delete-packed-ref');
        expect(data.reason).toMatch(/packed-only refs/);
      }
    }
  });

  it('Given delete=true on a ref that exists in neither loose nor packed storage, When updateRef is called, Then throws REF_NOT_FOUND', async () => {
    const ctx = await buildSeededContext();
    try {
      await updateRef(ctx, 'refs/heads/never-existed' as RefName, ID_A, { delete: true });
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_NOT_FOUND');
    }
  });
});
