import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  bareStoreRefName,
  isPerWorktreeRef,
  linkedWorktreeRefPrefix,
  parseWorktreeRef,
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

const isUnderEitherPrefix = (name: string): boolean =>
  name.startsWith('worktrees/') || name.startsWith('main-worktree/');

describe('Given an arbitrary per-worktree name', () => {
  describe('When it is spelled under main-worktree/', () => {
    it('Then it parses as main with that bare name', () => {
      // Arrange
      const sut = parseWorktreeRef;

      // Act + Assert
      fc.assert(
        fc.property(arbPerWorktreeName, (name) => {
          expect(sut(`main-worktree/${name}` as RefName)).toEqual({ kind: 'main', bare: name });
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given a slash-free worktree id and a per-worktree name', () => {
  describe("When the name is spelled under that worktree's prefix", () => {
    it('Then it parses as other with that id and bare name', () => {
      // Arrange
      const sut = parseWorktreeRef;

      // Act + Assert
      fc.assert(
        fc.property(WORKTREE_ID, arbPerWorktreeName, (id, name) => {
          expect(sut(`${linkedWorktreeRefPrefix(id)}${name}` as RefName)).toEqual({
            kind: 'other',
            id,
            bare: name,
          });
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given a slash-free worktree id', () => {
  describe('When it is spelled under worktrees/ with nothing after it', () => {
    it('Then it parses as other with that id and an empty bare name', () => {
      // Arrange
      const sut = parseWorktreeRef;

      // Act + Assert
      fc.assert(
        fc.property(WORKTREE_ID, (id) => {
          expect(sut(`worktrees/${id}` as RefName)).toEqual({ kind: 'other', id, bare: '' });
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an arbitrary shared name', () => {
  describe('When it is spelled under either prefix', () => {
    it('Then it parses as shared with the full name', () => {
      // Arrange
      const sut = parseWorktreeRef;
      const arbPrefix = fc.oneof(
        fc.constant('main-worktree/'),
        WORKTREE_ID.map(linkedWorktreeRefPrefix),
      );

      // Act + Assert
      fc.assert(
        fc.property(arbPrefix, arbSharedName, (prefix, name) => {
          const full = `${prefix}${name}` as RefName;
          expect(sut(full)).toEqual({ kind: 'shared', bare: full });
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a name under neither prefix', () => {
  describe('When it is parsed', () => {
    it('Then it is current exactly when isPerWorktreeRef accepts it', () => {
      // Arrange
      const sut = parseWorktreeRef;
      const arbUnprefixed = fc
        .oneof(arbRefName(), arbPerWorktreeName)
        .filter((name) => !isUnderEitherPrefix(name));

      // Act + Assert
      fc.assert(
        fc.property(arbUnprefixed, (name) => {
          const kind = isPerWorktreeRef(name) ? 'current' : 'shared';
          expect(sut(name)).toEqual({ kind, bare: name });
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
