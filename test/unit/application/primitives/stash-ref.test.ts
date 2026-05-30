import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import {
  dropStashEntry,
  pushStashRef,
  readStashStack,
  resolveStashEntry,
} from '../../../../src/application/primitives/stash-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { type ObjectId, type RefName, ZERO_OID } from '../../../../src/domain/objects/index.js';

const STASH_REF = 'refs/stash' as RefName;
const W0 = 'a0'.repeat(20) as ObjectId;
const W1 = 'b1'.repeat(20) as ObjectId;
const W2 = 'c2'.repeat(20) as ObjectId;

describe('stash-ref primitive', () => {
  describe('Given an empty repository', () => {
    describe('When the stash stack is read', () => {
      it('Then it is empty', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readStashStack(ctx);

        // Assert
        expect(sut).toEqual([]);
      });
    });

    describe('When resolveStashEntry is called', () => {
      it('Then it throws STASH_NOT_FOUND with index and stack size', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const act = resolveStashEntry(ctx, 0);

        // Assert
        await expect(act).rejects.toBeInstanceOf(TsgitError);
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'STASH_NOT_FOUND', index: 0, stackSize: 0 });
        });
      });
    });
  });

  describe('Given a first push onto an absent stash ref', () => {
    describe('When pushStashRef writes the entry', () => {
      it('Then the ref + reflog are created and the entry resolves at index 0', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await pushStashRef(ctx, W0, 'WIP on main: 000 first');

        // Assert
        expect(await resolveStashEntry(ctx, 0)).toBe(W0);
        const stack = await readStashStack(ctx);
        expect(stack).toEqual([
          { index: 0, selector: 'stash@{0}', stash: W0, message: 'WIP on main: 000 first' },
        ]);
        const reflog = await readReflog(ctx, STASH_REF);
        expect(reflog[0]?.oldId).toBe(ZERO_OID);
        expect(reflog[0]?.newId).toBe(W0);
      });
    });
  });

  describe('Given two pushes', () => {
    describe('When the stack is read', () => {
      it('Then it is newest-first and the second entry chains from the first', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await pushStashRef(ctx, W0, 'WIP on main: 000 first');

        // Act
        await pushStashRef(ctx, W1, 'WIP on main: 111 second');

        // Assert — newest-first
        expect(await resolveStashEntry(ctx, 0)).toBe(W1);
        expect(await resolveStashEntry(ctx, 1)).toBe(W0);
        const stack = await readStashStack(ctx);
        expect(stack.map((e) => e.stash)).toEqual([W1, W0]);
        expect(stack.map((e) => e.selector)).toEqual(['stash@{0}', 'stash@{1}']);
        // The newest reflog entry's oldId chains from the previous tip.
        const reflog = await readReflog(ctx, STASH_REF);
        expect(reflog[1]?.oldId).toBe(W0);
        expect(reflog[1]?.newId).toBe(W1);
      });
    });
  });

  describe('Given a three-entry stack', () => {
    describe('When the middle entry is dropped', () => {
      it('Then the tip is unchanged and the reflog chain is repaired', async () => {
        // Arrange — stack newest-first: W2@0, W1@1, W0@2
        const ctx = createMemoryContext();
        await pushStashRef(ctx, W0, 'WIP on main: 000 a');
        await pushStashRef(ctx, W1, 'WIP on main: 111 b');
        await pushStashRef(ctx, W2, 'WIP on main: 222 c');

        // Act — drop index 1 (W1)
        const sut = await dropStashEntry(ctx, 1);

        // Assert
        expect(sut).toEqual({ dropped: W1, remaining: 2 });
        expect(await resolveStashEntry(ctx, 0)).toBe(W2);
        expect(await resolveStashEntry(ctx, 1)).toBe(W0);
        // refs/stash still points at the unchanged tip W2.
        const tip = await getRefStore(ctx).resolveDirect(STASH_REF);
        expect(tip).toEqual({ kind: 'direct', id: W2 });
        // The entry that followed the dropped one (W2) now chains from W0;
        // the entry BEFORE it keeps its original oldId (only `following` is rewritten).
        const reflog = await readReflog(ctx, STASH_REF);
        expect(reflog.map((e) => e.newId)).toEqual([W0, W2]);
        expect(reflog[0]?.oldId).toBe(ZERO_OID);
        expect(reflog[1]?.oldId).toBe(W0);
      });
    });

    describe('When the newest entry is dropped', () => {
      it('Then refs/stash repoints to the new tip', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await pushStashRef(ctx, W0, 'WIP on main: 000 a');
        await pushStashRef(ctx, W1, 'WIP on main: 111 b');

        // Act
        const sut = await dropStashEntry(ctx, 0);

        // Assert
        expect(sut).toEqual({ dropped: W1, remaining: 1 });
        expect(await resolveStashEntry(ctx, 0)).toBe(W0);
        const tip = await getRefStore(ctx).resolveDirect(STASH_REF);
        expect(tip).toEqual({ kind: 'direct', id: W0 });
      });
    });
  });

  describe('Given a single-entry stack', () => {
    describe('When the last entry is dropped', () => {
      it('Then refs/stash and its reflog are removed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await pushStashRef(ctx, W0, 'WIP on main: 000 a');

        // Act
        const sut = await dropStashEntry(ctx, 0);

        // Assert
        expect(sut).toEqual({ dropped: W0, remaining: 0 });
        expect(await readStashStack(ctx)).toEqual([]);
        const tip = await getRefStore(ctx).resolveDirect(STASH_REF);
        expect(tip).toEqual({ kind: 'missing' });
      });
    });

    describe('When an out-of-range entry is dropped', () => {
      it('Then it throws STASH_NOT_FOUND', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await pushStashRef(ctx, W0, 'WIP on main: 000 a');

        // Act
        const act = dropStashEntry(ctx, 5);

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'STASH_NOT_FOUND', index: 5, stackSize: 1 });
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });
});
