import { describe, expect, it } from 'vitest';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ZERO = '0'.repeat(40) as ObjectId;
const MAIN = 'refs/heads/main' as RefName;
const HEAD = 'HEAD' as RefName;
const REASON = 'commit: test';

describe('updateRef', () => {
  it('Given a fresh ref, When updateRef is called, Then resolveRef returns the new id', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await updateRef(ctx, 'refs/heads/new' as RefName, ID_A, { reflogMessage: REASON });
    const sut = await resolveRef(ctx, 'refs/heads/new' as RefName);
    // Assert
    expect(sut).toBe(ID_A);
  });

  it('Given a pre-existing .lock file, When updateRef is called, Then throws REF_LOCKED', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.write('/repo/.git/refs/heads/busy.lock', new Uint8Array([0]));
    try {
      await updateRef(ctx, 'refs/heads/busy' as RefName, ID_A, { reflogMessage: REASON });
      // Assert
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_LOCKED');
    }
  });

  it('Given CAS hit (expected matches current), When updateRef is called, Then succeeds', async () => {
    // Arrange
    const ctx = await buildSeededContext({
      refs: [{ name: MAIN, id: ID_A }],
    });
    await updateRef(ctx, MAIN, ID_B, { expected: ID_A, reflogMessage: REASON });
    const sut = await resolveRef(ctx, MAIN);
    // Assert
    expect(sut).toBe(ID_B);
  });

  it('Given CAS miss (expected differs from current), When updateRef is called, Then throws REF_UPDATE_CONFLICT with data.expected and data.actual populated', async () => {
    // Arrange
    const ctx = await buildSeededContext({
      refs: [{ name: MAIN, id: ID_A }],
    });
    try {
      await updateRef(ctx, MAIN, ID_B, { expected: ID_B, reflogMessage: REASON });
      // Assert
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
    // Arrange
    const ctx = await buildSeededContext();
    await updateRef(ctx, 'refs/heads/fresh' as RefName, ID_A, {
      expected: 'absent',
      reflogMessage: REASON,
    });
    const sut = await resolveRef(ctx, 'refs/heads/fresh' as RefName);
    // Assert
    expect(sut).toBe(ID_A);
  });

  it('Given CAS expected="absent" on an existing ref, When updateRef is called, Then throws REF_UPDATE_CONFLICT', async () => {
    // Arrange
    const ctx = await buildSeededContext({
      refs: [{ name: MAIN, id: ID_A }],
    });
    try {
      await updateRef(ctx, MAIN, ID_B, { expected: 'absent', reflogMessage: REASON });
      // Assert
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_UPDATE_CONFLICT');
    }
  });

  it('Given an invalid ref name, When updateRef is called, Then throws INVALID_REF', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    try {
      await updateRef(ctx, '..' as RefName, ID_A, { reflogMessage: REASON });
      // Assert
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_REF');
    }
  });

  it('Given delete=true on a loose ref, When updateRef is called, Then ref is removed', async () => {
    // Arrange
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/tmp' as RefName, id: ID_A }],
    });
    await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { delete: true });
    // Assert
    expect(await ctx.fs.exists('/repo/.git/refs/heads/tmp')).toBe(false);
  });

  it('Given delete=true on a packed-only ref, When updateRef is called, Then throws UNSUPPORTED_OPERATION with operation and reason set', async () => {
    // Arrange
    const ctx = await buildSeededContext({
      packedRefs: [{ name: 'refs/tags/old' as RefName, id: ID_A }],
    });
    try {
      await updateRef(ctx, 'refs/tags/old' as RefName, ID_A, { delete: true });
      // Assert
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
    // Arrange
    const ctx = await buildSeededContext();
    try {
      await updateRef(ctx, 'refs/heads/never-existed' as RefName, ID_A, { delete: true });
      // Assert
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_NOT_FOUND');
    }
  });

  describe('reflog logging', () => {
    it('Given a fresh branch write, When updateRef is called, Then a reflog entry records ZERO_OID → newId with the message', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      await updateRef(ctx, MAIN, ID_A, { reflogMessage: 'commit (initial): seed' });
      const sut = await readReflog(ctx, MAIN);
      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.oldId).toBe(ZERO);
      expect(sut[0]?.newId).toBe(ID_A);
      expect(sut[0]?.message).toBe('commit (initial): seed');
    });

    it('Given an existing branch, When updateRef moves it, Then the reflog entry records the prior id as oldId', async () => {
      // Arrange
      const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
      await updateRef(ctx, MAIN, ID_B, { reflogMessage: REASON });
      const sut = await readReflog(ctx, MAIN);
      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.oldId).toBe(ID_A);
      expect(sut[0]?.newId).toBe(ID_B);
    });

    it('Given HEAD symbolically points at the updated branch, When updateRef is called, Then a second entry is appended to HEAD', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      await writeSymbolicRef(ctx, HEAD, MAIN);
      await updateRef(ctx, MAIN, ID_A, { reflogMessage: REASON });
      const sut = await readReflog(ctx, HEAD);
      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.newId).toBe(ID_A);
      expect(sut[0]?.message).toBe(REASON);
    });

    it('Given HEAD is symbolic but targets a different branch, When updateRef is called, Then HEAD is not logged', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      await writeSymbolicRef(ctx, HEAD, 'refs/heads/other' as RefName);
      await updateRef(ctx, MAIN, ID_A, { reflogMessage: REASON });
      const sut = await readReflog(ctx, HEAD);
      // Assert
      expect(sut).toEqual([]);
    });

    it('Given HEAD is detached (a direct id), When updateRef updates a branch, Then HEAD is not logged', async () => {
      // Arrange
      const ctx = await buildSeededContext({ refs: [{ name: HEAD, id: ID_B }] });
      await updateRef(ctx, MAIN, ID_A, { reflogMessage: REASON });
      const sut = await readReflog(ctx, HEAD);
      // Assert
      expect(sut).toEqual([]);
    });

    it('Given a branch with a reflog, When updateRef deletes it, Then the reflog file is removed', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { reflogMessage: REASON });
      await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { delete: true });
      const sut = await readReflog(ctx, 'refs/heads/tmp' as RefName);
      // Assert
      expect(sut).toEqual([]);
      expect(await ctx.fs.exists('/repo/.git/logs/refs/heads/tmp')).toBe(false);
    });
  });
});
