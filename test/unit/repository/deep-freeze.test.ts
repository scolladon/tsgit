import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../../src/repository/deep-freeze.js';

describe('deepFreeze', () => {
  describe('Given a flat object', () => {
    describe('When deepFreeze runs', () => {
      it('Then the returned object is frozen', () => {
        // Arrange
        const sut = deepFreeze({ a: 1, b: 'two' });

        // Assert
        expect(Object.isFrozen(sut)).toBe(true);
      });
    });
  });

  describe('Given a nested object', () => {
    describe('When deepFreeze runs', () => {
      it('Then every nested plain object is frozen', () => {
        // Arrange
        const sut = deepFreeze({ outer: { inner: { leaf: 1 } } });

        // Assert
        expect(Object.isFrozen(sut)).toBe(true);
        expect(Object.isFrozen(sut.outer)).toBe(true);
        expect(Object.isFrozen(sut.outer.inner)).toBe(true);
      });
    });
  });

  describe('Given an object containing an array', () => {
    describe('When deepFreeze runs', () => {
      it('Then the array and its plain-object elements are frozen', () => {
        // Arrange
        const sut = deepFreeze({ items: [{ id: 1 }, { id: 2 }] });

        // Assert
        expect(Object.isFrozen(sut.items)).toBe(true);
        expect(Object.isFrozen(sut.items[0])).toBe(true);
        expect(Object.isFrozen(sut.items[1])).toBe(true);
      });
    });
  });

  describe('Given an object containing a function-valued slot', () => {
    describe('When deepFreeze runs', () => {
      it('Then the slot is frozen-by-reference (function not modified)', () => {
        // Arrange
        const fn = (): number => 42;
        const sut = deepFreeze({ resolver: fn });

        // Assert — the slot cannot be reassigned, but the closure scope of fn is the user's responsibility.
        expect(Object.isFrozen(sut)).toBe(true);
        expect(sut.resolver).toBe(fn);
      });
    });
  });

  describe('Given an already-frozen nested object', () => {
    describe('When deepFreeze runs', () => {
      it('Then it returns without error', () => {
        // Arrange
        const inner = Object.freeze({ x: 1 });
        const sut = deepFreeze({ inner });

        // Assert
        expect(Object.isFrozen(sut.inner)).toBe(true);
      });
    });
  });

  describe('Given an already-frozen nested object whose deeper child is NOT frozen', () => {
    describe('When deepFreeze runs', () => {
      it('Then the deeper child is NOT touched (short-circuits at the frozen ancestor)', () => {
        // Arrange — kills `if (Object.isFrozen(value)) return;` mutants by proving
        // the early-return prevents recursive descent.
        const innerChild = { mutable: 'still mutable' };
        const inner = Object.freeze({ child: innerChild });
        deepFreeze({ inner });

        // Assert — the unfrozen deep child is preserved as-is when its parent
        // was already frozen (deepFreeze short-circuits).
        expect(Object.isFrozen(innerChild)).toBe(false);
      });
    });
  });

  describe('Given an array of plain objects', () => {
    describe('When deepFreeze runs', () => {
      it('Then array element objects are individually frozen (kills the Array.isArray branch removal)', () => {
        // Arrange
        const elements = [{ a: 1 }, { b: 2 }];
        const sut = deepFreeze(elements);

        // Assert — proves the Array.isArray branch ran (vs. the empty-block mutant
        // which would skip element-wise freezing).
        expect(Object.isFrozen(sut[0])).toBe(true);
        expect(Object.isFrozen(sut[1])).toBe(true);
      });
    });
  });

  describe('Given a cyclic graph (object referencing itself)', () => {
    describe('When deepFreeze runs', () => {
      it('Then it terminates without stack overflow (kills the seen.has cycle-guard removal)', () => {
        // Arrange — kills `if (seen.has(value)) return;` mutants by proving the
        // guard prevents infinite recursion.
        const obj: { self?: unknown } = {};
        obj.self = obj;
        const sut = deepFreeze(obj);

        // Assert — execution returned (no stack overflow), and the object is frozen.
        expect(Object.isFrozen(sut)).toBe(true);
      });
    });
  });

  describe('Given a primitive', () => {
    describe('When deepFreeze runs', () => {
      it('Then it returns the primitive unchanged', () => {
        // Arrange / Act
        const sut = deepFreeze(42);

        // Assert
        expect(sut).toBe(42);
      });
    });
  });

  describe('Given undefined', () => {
    describe('When deepFreeze runs', () => {
      it('Then it returns undefined', () => {
        // Arrange / Act
        const sut = deepFreeze(undefined);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given null', () => {
    describe('When deepFreeze runs', () => {
      it('Then it returns null', () => {
        // Arrange / Act
        const sut = deepFreeze(null);

        // Assert
        expect(sut).toBeNull();
      });
    });
  });
});
