import { describe, expect, it } from 'vitest';
import { posixPolicy, windowsPolicy } from '../../../src/adapters/node/path-policy.js';
import { longestStrictAncestor } from '../../../src/repository/ceiling-stop.js';

// cwd `/T/normal/deep/deeper`; the repo root is `/T/normal` — the shape
// canonical git's GIT_CEILING_DIRECTORIES semantics were pinned against
// (git 2.55.0).
const CWD = '/T/normal/deep/deeper';
const REPO_ROOT = '/T/normal';

describe('longestStrictAncestor', () => {
  describe('Given no ceilings at all', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it returns undefined', () => {
        // Arrange / Act
        const result = longestStrictAncestor(undefined, CWD, posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given an empty ceilings array', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it returns undefined', () => {
        // Arrange / Act
        const result = longestStrictAncestor([], CWD, posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a ceiling above the repo root', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it returns that ceiling — a strict ancestor of cwd', () => {
        // Arrange / Act
        const result = longestStrictAncestor(['/T'], CWD, posixPolicy);

        // Assert
        expect(result).toBe('/T');
      });
    });
  });

  describe('Given a ceiling equal to the repo root itself', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it returns that ceiling — the repo root is never examined', () => {
        // Arrange / Act
        const result = longestStrictAncestor([REPO_ROOT], CWD, posixPolicy);

        // Assert
        expect(result).toBe(REPO_ROOT);
      });
    });
  });

  describe('Given a ceiling at an intermediate ancestor between the repo root and cwd', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it returns that intermediate directory', () => {
        // Arrange / Act
        const result = longestStrictAncestor(['/T/normal/deep'], CWD, posixPolicy);

        // Assert
        expect(result).toBe('/T/normal/deep');
      });
    });
  });

  describe('Given a ceiling equal to cwd itself', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it returns undefined — equality is a no-op, never a strict ancestor', () => {
        // Arrange / Act
        const result = longestStrictAncestor([CWD], CWD, posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a ceiling with a trailing separator equal to the repo root', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it normalizes the same as without the trailing slash', () => {
        // Arrange / Act
        const result = longestStrictAncestor([`${REPO_ROOT}/`], CWD, posixPolicy);

        // Assert
        expect(result).toBe(REPO_ROOT);
      });
    });
  });

  describe('Given a ceiling below cwd', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it is ignored — irrelevant entries do not stop the walk', () => {
        // Arrange / Act
        const result = longestStrictAncestor([`${CWD}/further-down`], CWD, posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a ceiling unrelated to cwd entirely (neither ancestor nor descendant)', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it is ignored', () => {
        // Arrange / Act
        const result = longestStrictAncestor(['/elsewhere'], CWD, posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given multiple entries where one is a strict ancestor and one is not', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then only the strict ancestor counts', () => {
        // Arrange / Act
        const result = longestStrictAncestor(['/elsewhere', '/T'], CWD, posixPolicy);

        // Assert
        expect(result).toBe('/T');
      });
    });
  });

  describe('Given multiple strict-ancestor entries at different depths', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the longest (deepest) one wins', () => {
        // Arrange / Act
        const result = longestStrictAncestor(['/T', '/T/normal/deep'], CWD, posixPolicy);

        // Assert
        expect(result).toBe('/T/normal/deep');
      });
    });
  });

  describe('Given cwd equals the repo root AND the ceiling also equals the repo root', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then it is still a no-op — the strict-ancestor rule, not a repo-root special case', () => {
        // Arrange / Act
        const result = longestStrictAncestor([REPO_ROOT], REPO_ROOT, posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
  describe('Given a case-insensitive policy and a ceiling whose casing differs from the cwd', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the ceiling still matches — a raw string compare would fail open and unbound the walk', () => {
        // Arrange
        const sut = longestStrictAncestor;

        // Act
        const result = sut(['c:\\users\\bob'], 'C:\\Users\\Bob\\proj', windowsPolicy);

        // Assert
        expect(result).toBe('c:\\users\\bob');
      });
    });
  });
  describe('Given the filesystem root itself as a ceiling entry', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the root matches without doubling its trailing separator', () => {
        // Arrange
        const sut = longestStrictAncestor;

        // Act
        const result = sut(['/'], '/repo/deep', posixPolicy);

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given two strict ancestors supplied deepest-first', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the deeper entry is retained over the shallower one seen later', () => {
        // Arrange — the existing multi-entry rows are shallowest-first; this
        // order exercises the keep-the-current-longest arm.
        const sut = longestStrictAncestor;

        // Act
        const result = sut(['/a/b/c', '/a'], '/a/b/c/d/e', posixPolicy);

        // Assert
        expect(result).toBe('/a/b/c');
      });
    });
  });
});
