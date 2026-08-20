import { describe, expect, it } from 'vitest';
import {
  canonicalizeTrustedDirectories,
  type PathResolver,
} from '../../../src/repository/canonicalize-trusted-directories.js';

const WORKING_DIR = '/work';

/**
 * A resolver standing in for the node shim's `canonicalize` on a tree where
 * `/tmp` is a symlink to `/private/tmp` — the everyday macOS shape, and the
 * one that makes the difference between a lexical and a physical comparison
 * observable.
 *
 * It models three properties of the real thing, and the last two are what
 * make the grammar guards load-bearing rather than decorative:
 *
 * - a path it cannot resolve comes back unchanged, the shim's documented
 *   fallback (so does the empty string, which is what a bare `/*` prefix
 *   slices down to);
 * - an ABSOLUTE path still carrying the grammar's star names no directory, so
 *   resolving a `<prefix>/*` entry whole is a silent no-op that would leave
 *   the prefix lexical while the repository path it is compared against is
 *   physical;
 * - a RELATIVE name resolves against the working directory — which is exactly
 *   how a bare `*` becomes `<cwd>/*` and silently turns "trust everything"
 *   into "trust nothing".
 *
 * A resolver that merely rewrote `/tmp` would satisfy every assertion below
 * while the two guards did nothing, so its fidelity here is the test.
 */
const symlinkedTmp: PathResolver = async (path) => {
  if (path === '') return path;
  if (!path.startsWith('/')) return `${WORKING_DIR}/${path}`;
  if (path.includes('*')) return path;
  return path.startsWith('/tmp/') || path === '/tmp' ? path.replace('/tmp', '/private/tmp') : path;
};

describe('canonicalizeTrustedDirectories', () => {
  describe('Given the wildcard entry', () => {
    describe('When the allowlist is canonicalised', () => {
      it("Then '*' is handed through untouched — resolving it would mean trust nothing", async () => {
        // Arrange
        const sut = canonicalizeTrustedDirectories;

        // Act
        const result = await sut(['*'], symlinkedTmp);

        // Assert
        expect(result).toEqual(['*']);
      });
    });
  });

  describe('Given a /* prefix entry under a symlinked root', () => {
    describe('When the allowlist is canonicalised', () => {
      it('Then the PREFIX is resolved and the star re-attached', async () => {
        // Arrange — resolving the whole entry fails silently on the star and
        // leaves the prefix lexical, so the entry would never match the
        // realpath-resolved repository path.
        const sut = canonicalizeTrustedDirectories;

        // Act
        const result = await sut(['/tmp/work/*'], symlinkedTmp);

        // Assert
        expect(result).toEqual(['/private/tmp/work/*']);
      });
    });
  });

  describe('Given a plain absolute entry under a symlinked root', () => {
    describe('When the allowlist is canonicalised', () => {
      it('Then it is resolved physically', async () => {
        // Arrange
        const sut = canonicalizeTrustedDirectories;

        // Act
        const result = await sut(['/tmp/work/repo'], symlinkedTmp);

        // Assert
        expect(result).toEqual(['/private/tmp/work/repo']);
      });
    });
  });

  describe('Given the root prefix entry', () => {
    describe('When the allowlist is canonicalised', () => {
      it('Then the empty prefix survives and the star is re-attached', async () => {
        // Arrange — `'/*'.slice(0, -2)` is the empty string, which no resolver
        // can resolve; the entry must come back intact rather than mangled.
        const sut = canonicalizeTrustedDirectories;

        // Act
        const result = await sut(['/*'], symlinkedTmp);

        // Assert
        expect(result).toEqual(['/*']);
      });
    });
  });

  describe('Given an entry naming a path that does not resolve', () => {
    describe('When the allowlist is canonicalised', () => {
      it('Then it is handed back unchanged rather than dropped', async () => {
        // Arrange
        const sut = canonicalizeTrustedDirectories;

        // Act
        const result = await sut(['/nowhere/at/all'], symlinkedTmp);

        // Assert
        expect(result).toEqual(['/nowhere/at/all']);
      });
    });
  });

  describe('Given no allowlist at all', () => {
    describe('When the allowlist is canonicalised', () => {
      it('Then undefined is preserved, so an omitted option stays omitted', async () => {
        // Arrange
        const sut = canonicalizeTrustedDirectories;

        // Act
        const result = await sut(undefined, symlinkedTmp);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given several entries of mixed shape', () => {
    describe('When the allowlist is canonicalised', () => {
      it('Then each takes its own rule and the order is preserved', async () => {
        // Arrange
        const sut = canonicalizeTrustedDirectories;

        // Act
        const result = await sut(['*', '/tmp/a/*', '/tmp/b'], symlinkedTmp);

        // Assert
        expect(result).toEqual(['*', '/private/tmp/a/*', '/private/tmp/b']);
      });
    });
  });
});
