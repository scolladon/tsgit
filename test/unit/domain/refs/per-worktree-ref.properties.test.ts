import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  bareStoreRefName,
  isPerWorktreeRef,
  linkedWorktreeRefPrefix,
  mainWorktreeBareName,
} from '../../../../src/domain/refs/per-worktree-ref.js';
import { arbRefName } from './arbitraries.js';

const ROOT_REF = fc.stringMatching(/^[A-Z_-]{1,12}$/);
const PRIVATE_NAMESPACE = fc.constantFrom('refs/bisect/', 'refs/worktree/', 'refs/rewritten/');
const WORKTREE_ID = fc.stringMatching(/^[a-z0-9._-]{1,10}$/);

const arbPerWorktreeName: fc.Arbitrary<RefName> = fc.oneof(
  ROOT_REF.map((name) => name as RefName),
  fc.tuple(PRIVATE_NAMESPACE, arbRefName()).map(([prefix, rest]) => `${prefix}${rest}` as RefName),
);

const arbSharedName: fc.Arbitrary<RefName> = arbRefName().filter((name) => !isPerWorktreeRef(name));

describe('Given an arbitrary per-worktree name', () => {
  describe('When it is spelled under main-worktree/', () => {
    it('Then mainWorktreeBareName returns it', () => {
      // Arrange
      const sut = mainWorktreeBareName;

      // Act + Assert
      fc.assert(
        fc.property(arbPerWorktreeName, (name) => {
          expect(sut(`main-worktree/${name}` as RefName)).toBe(name);
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary shared ref name', () => {
  describe('When it is spelled under main-worktree/', () => {
    it('Then mainWorktreeBareName returns undefined', () => {
      // Arrange
      const sut = mainWorktreeBareName;

      // Act + Assert
      fc.assert(
        fc.property(arbSharedName, (name) => {
          expect(sut(`main-worktree/${name}` as RefName)).toBeUndefined();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an arbitrary ref name', () => {
  describe('When it carries no main-worktree/ prefix', () => {
    it('Then mainWorktreeBareName returns undefined', () => {
      // Arrange
      const sut = mainWorktreeBareName;

      // Act + Assert
      fc.assert(
        fc.property(fc.oneof(arbRefName(), arbPerWorktreeName), (name) => {
          expect(sut(name)).toBeUndefined();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an arbitrary slash-free worktree id and ref name', () => {
  describe("When the name is spelled under that worktree's prefix", () => {
    it('Then bareStoreRefName returns the name', () => {
      // Arrange
      const sut = bareStoreRefName;

      // Act + Assert
      fc.assert(
        fc.property(WORKTREE_ID, arbRefName(), (id, name) => {
          expect(sut(`${linkedWorktreeRefPrefix(id)}${name}`)).toBe(name);
        }),
        { numRuns: 200 },
      );
    });
  });
});
