import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { resolveWriteChain } from '../../../../../src/application/primitives/internal/ref-write-chain.js';
import { getRefStore } from '../../../../../src/application/primitives/ref-store.js';
import type { UpdateRefOptions } from '../../../../../src/application/primitives/types.js';
import { writeSymbolicRef } from '../../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ref = (name: string): RefName => name as RefName;

const setDirect = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
  await getRefStore(ctx).applyRefUpdates([{ kind: 'set', name, id }]);
};

const WRITE_OPTS: UpdateRefOptions = { reflogMessage: 'test' };
const NO_DEREF_OPTS: UpdateRefOptions = { reflogMessage: 'test', noDeref: true };
const noDerefWithExpected = (expected: ObjectId | 'absent'): UpdateRefOptions => ({
  reflogMessage: 'test',
  noDeref: true,
  expected,
});

describe('resolveWriteChain', () => {
  describe('Given a direct ref name', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then links is empty and terminal is the given name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/main'), ID_A);
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/main'), WRITE_OPTS);

        // Assert
        expect(result.links).toEqual([]);
        expect(result.terminal).toBe('refs/heads/main');
        expect(result.old).toBe(ID_A);
        expect(result.danglingSymref).toBe(false);
      });
    });
  });

  describe('Given an absent ref name', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then old is "absent"', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/gone'), WRITE_OPTS);

        // Assert
        expect(result.links).toEqual([]);
        expect(result.terminal).toBe('refs/heads/gone');
        expect(result.old).toBe('absent');
      });
    });
  });

  describe('Given one symbolic hop to a direct ref', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then links names the hop and terminal is the direct ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/x'), ID_A);
        await writeSymbolicRef(ctx, ref('refs/heads/s'), ref('refs/heads/x'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/s'), WRITE_OPTS);

        // Assert
        expect(result.links).toEqual(['refs/heads/s']);
        expect(result.terminal).toBe('refs/heads/x');
        expect(result.old).toBe(ID_A);
      });
    });
  });

  describe('Given two symbolic hops to a direct ref', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then links name both hops in walked order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/x'), ID_A);
        await writeSymbolicRef(ctx, ref('refs/heads/a2'), ref('refs/heads/x'));
        await writeSymbolicRef(ctx, ref('refs/heads/a1'), ref('refs/heads/a2'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/a1'), WRITE_OPTS);

        // Assert
        expect(result.links).toEqual(['refs/heads/a1', 'refs/heads/a2']);
        expect(result.terminal).toBe('refs/heads/x');
      });
    });
  });

  describe('Given a symbolic ref whose target does not exist', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then the terminal is the dangling target with old "absent"', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSymbolicRef(ctx, ref('refs/heads/s2'), ref('refs/heads/nope'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/s2'), WRITE_OPTS);

        // Assert
        expect(result.links).toEqual(['refs/heads/s2']);
        expect(result.terminal).toBe('refs/heads/nope');
        expect(result.old).toBe('absent');
        expect(result.danglingSymref).toBe(false);
      });
    });
  });

  describe('Given a two-symref cycle p -> q -> p', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then it throws REF_CYCLE_DETECTED naming the full chain', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSymbolicRef(ctx, ref('refs/heads/p'), ref('refs/heads/q'));
        await writeSymbolicRef(ctx, ref('refs/heads/q'), ref('refs/heads/p'));
        const store = getRefStore(ctx);

        // Act + Assert
        try {
          await resolveWriteChain(store, ref('refs/heads/p'), WRITE_OPTS);
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REF_CYCLE_DETECTED');
          if (data.code === 'REF_CYCLE_DETECTED') {
            expect(data.chain).toEqual(['refs/heads/p', 'refs/heads/q', 'refs/heads/p']);
          }
        }
      });
    });
  });

  describe('Given a self-referencing symref z -> z', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then it throws REF_CYCLE_DETECTED naming [z, z]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSymbolicRef(ctx, ref('refs/heads/z'), ref('refs/heads/z'));
        const store = getRefStore(ctx);

        // Act + Assert
        try {
          await resolveWriteChain(store, ref('refs/heads/z'), WRITE_OPTS);
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REF_CYCLE_DETECTED');
          if (data.code === 'REF_CYCLE_DETECTED') {
            expect(data.chain).toEqual(['refs/heads/z', 'refs/heads/z']);
          }
        }
      });
    });
  });

  describe('Given a chain of six symbolic hops ending in a direct ref', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then it resolves without refusing — the write walk has no depth cap', async () => {
        // Arrange — kills a copied read-path depth cap: MAX_SYMBOLIC_REF_DEPTH
        // is 5, so a naive copy of the read walk's cap would refuse here.
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/h6'), ID_A);
        await writeSymbolicRef(ctx, ref('refs/heads/h5'), ref('refs/heads/h6'));
        await writeSymbolicRef(ctx, ref('refs/heads/h4'), ref('refs/heads/h5'));
        await writeSymbolicRef(ctx, ref('refs/heads/h3'), ref('refs/heads/h4'));
        await writeSymbolicRef(ctx, ref('refs/heads/h2'), ref('refs/heads/h3'));
        await writeSymbolicRef(ctx, ref('refs/heads/h1'), ref('refs/heads/h2'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/h1'), WRITE_OPTS);

        // Assert
        expect(result.terminal).toBe('refs/heads/h6');
        expect(result.links).toHaveLength(5);
      });
    });
  });

  describe('Given noDeref on a direct name', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then it behaves exactly like the direct-name case', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/main'), ID_A);
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/main'), NO_DEREF_OPTS);

        // Assert
        expect(result.links).toEqual([]);
        expect(result.terminal).toBe('refs/heads/main');
        expect(result.old).toBe(ID_A);
      });
    });
  });

  describe('Given noDeref on a symbolic ref', () => {
    describe('When resolveWriteChain runs', () => {
      it("Then the name itself is the terminal, links stay empty, and old is the referent's value", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/x'), ID_A);
        await writeSymbolicRef(ctx, ref('refs/heads/s'), ref('refs/heads/x'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/s'), NO_DEREF_OPTS);

        // Assert
        expect(result.links).toEqual([]);
        expect(result.terminal).toBe('refs/heads/s');
        expect(result.old).toBe(ID_A);
        expect(result.danglingSymref).toBe(false);
        expect(result.terminalIsSymbolic).toBe(true);
      });
    });
  });

  describe('Given noDeref on a direct ref', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then terminalIsSymbolic is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/main'), ID_A);
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/main'), NO_DEREF_OPTS);

        // Assert
        expect(result.terminalIsSymbolic).toBe(false);
      });
    });
  });

  describe('Given dereferencing (no noDeref) through a symbolic ref', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then terminalIsSymbolic is false — the terminal is never symbolic when walked', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/x'), ID_A);
        await writeSymbolicRef(ctx, ref('refs/heads/s'), ref('refs/heads/x'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/s'), WRITE_OPTS);

        // Assert
        expect(result.terminalIsSymbolic).toBe(false);
      });
    });
  });

  describe('Given noDeref on a dangling symbolic ref', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then danglingSymref is true and old is "absent"', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSymbolicRef(ctx, ref('refs/heads/s7'), ref('refs/heads/nope7'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/s7'), NO_DEREF_OPTS);

        // Assert
        expect(result.terminal).toBe('refs/heads/s7');
        expect(result.old).toBe('absent');
        expect(result.danglingSymref).toBe(true);
      });
    });
  });

  describe('Given noDeref on a symref whose referent chain cycles, with no expected', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then the cycle is swallowed and old reads "absent"', async () => {
        // Arrange — `--no-deref` never walks the name itself, but the
        // referent READ still needs an answer for the old value, and a
        // failed read is swallowed only when no old value is checked.
        const ctx = createMemoryContext();
        await writeSymbolicRef(ctx, ref('refs/heads/q'), ref('refs/heads/p'));
        await writeSymbolicRef(ctx, ref('refs/heads/p'), ref('refs/heads/q'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/p'), NO_DEREF_OPTS);

        // Assert
        expect(result.terminal).toBe('refs/heads/p');
        expect(result.old).toBe('absent');
      });
    });
  });

  describe('Given noDeref on a symref whose referent chain cycles, with an expected value', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then the cycle error is rethrown', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSymbolicRef(ctx, ref('refs/heads/q'), ref('refs/heads/p'));
        await writeSymbolicRef(ctx, ref('refs/heads/p'), ref('refs/heads/q'));
        const store = getRefStore(ctx);

        // Act + Assert
        try {
          await resolveWriteChain(store, ref('refs/heads/p'), noDerefWithExpected(ID_B));
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('REF_CYCLE_DETECTED');
        }
      });
    });
  });

  describe('Given noDeref on a symref whose referent chain exceeds the read depth cap, with no expected', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then the over-depth fault is swallowed and old reads "absent"', async () => {
        // Arrange — the referent read reuses the read path's OWN depth cap
        // (distinct from the cycle fault covered above): six symbolic hops
        // past `s`'s own referent before a direct ref exceeds it.
        const ctx = createMemoryContext();
        await setDirect(ctx, ref('refs/heads/t7'), ID_A);
        await writeSymbolicRef(ctx, ref('refs/heads/t6'), ref('refs/heads/t7'));
        await writeSymbolicRef(ctx, ref('refs/heads/t5'), ref('refs/heads/t6'));
        await writeSymbolicRef(ctx, ref('refs/heads/t4'), ref('refs/heads/t5'));
        await writeSymbolicRef(ctx, ref('refs/heads/t3'), ref('refs/heads/t4'));
        await writeSymbolicRef(ctx, ref('refs/heads/t2'), ref('refs/heads/t3'));
        await writeSymbolicRef(ctx, ref('refs/heads/t1'), ref('refs/heads/t2'));
        await writeSymbolicRef(ctx, ref('refs/heads/s'), ref('refs/heads/t1'));
        const store = getRefStore(ctx);

        // Act
        const result = await resolveWriteChain(store, ref('refs/heads/s'), NO_DEREF_OPTS);

        // Assert
        expect(result.terminal).toBe('refs/heads/s');
        expect(result.old).toBe('absent');
      });
    });
  });

  describe('Given a symbolic ref whose link target is not a valid ref name', () => {
    describe('When resolveWriteChain runs', () => {
      it('Then it throws INVALID_REF before reading a second time', async () => {
        // Arrange — a hand-planted symref file with a `..`-escaping target.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/bad`, 'ref: ../../etc/passwd\n');
        const store = getRefStore(ctx);
        const spy = vi.spyOn(store, 'resolveDirect');

        // Act + Assert
        try {
          await resolveWriteChain(store, ref('refs/heads/bad'), WRITE_OPTS);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('INVALID_REF');
        }
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      });
    });
  });
});
