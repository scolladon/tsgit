import * as nodePosix from 'node:path/posix';
import { describe, expect, it } from 'vitest';
import { portablePosixPolicy } from '../../../src/repository/portable-posix-policy.js';

// `portablePosixPolicy` is a dependency-free stand-in for the Node-backed
// `posixPolicy` (`adapters/node/path-policy.ts`), used by the browser shim
// so the single-file CDN bundle never references `node:path` (rollup treats
// every `node:*` specifier as external, which would leave a surviving
// import statement — see `index.browser.ts`). It only claims to be correct
// for the absolute-path subset `findLayout`/`layoutFromGitfile` actually
// feed it, so each case here cross-checks against real `node:path/posix`
// for that subset rather than asserting arbitrary path.posix parity.

describe('portablePosixPolicy', () => {
  describe('Given the sep and caseInsensitive fields', () => {
    describe('When read', () => {
      it('Then sep is "/" and caseInsensitive is false', () => {
        // Arrange & Act
        const result = {
          sep: portablePosixPolicy.sep,
          caseInsensitive: portablePosixPolicy.caseInsensitive,
        };

        // Assert
        expect(result).toStrictEqual({ sep: '/', caseInsensitive: false });
      });
    });
  });

  describe('Given an absolute path', () => {
    describe('When isAbsolute runs', () => {
      it('Then it returns true', () => {
        // Arrange & Act
        const result = portablePosixPolicy.isAbsolute('/repo/wt');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a relative path', () => {
    describe('When isAbsolute runs', () => {
      it('Then it returns false', () => {
        // Arrange & Act
        const result = portablePosixPolicy.isAbsolute('repo/wt');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an already-normalized absolute path', () => {
    describe('When resolve runs', () => {
      it('Then it matches node:path/posix.resolve', () => {
        // Arrange
        const path = '/repo/.git/worktrees/wt';

        // Act
        const result = portablePosixPolicy.resolve(path);

        // Assert
        expect(result).toBe(nodePosix.resolve(path));
      });
    });
  });

  describe('Given an absolute path with a "../.." segment', () => {
    describe('When resolve runs', () => {
      it('Then it collapses the segment like node:path/posix.resolve', () => {
        // Arrange
        const path = '/repo/.git/worktrees/wt/../..';

        // Act
        const result = portablePosixPolicy.resolve(path);

        // Assert
        expect(result).toBe(nodePosix.resolve(path));
        expect(result).toBe('/repo/.git');
      });
    });
  });

  describe('Given an absolute base dir and a relative pointer segment', () => {
    describe('When join runs', () => {
      it('Then it matches node:path/posix.join', () => {
        // Arrange
        const base = '/repo/main/.git/worktrees/wt';
        const relative = '../..';

        // Act
        const result = portablePosixPolicy.join(base, relative);

        // Assert
        expect(result).toBe(nodePosix.join(base, relative));
      });
    });
  });

  describe('Given a nested absolute path', () => {
    describe('When dirname runs', () => {
      it('Then it matches node:path/posix.dirname', () => {
        // Arrange
        const path = '/repo/.git/worktrees/wt';

        // Act
        const result = portablePosixPolicy.dirname(path);

        // Assert
        expect(result).toBe(nodePosix.dirname(path));
      });
    });
  });

  describe('Given the filesystem root', () => {
    describe('When dirname runs', () => {
      it('Then it returns "/" like node:path/posix.dirname (walk-up termination)', () => {
        // Arrange & Act
        const result = portablePosixPolicy.dirname('/');

        // Assert
        expect(result).toBe(nodePosix.dirname('/'));
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a top-level absolute path', () => {
    describe('When dirname runs', () => {
      it('Then it returns "/" like node:path/posix.dirname', () => {
        // Arrange & Act
        const result = portablePosixPolicy.dirname('/repo');

        // Assert
        expect(result).toBe(nodePosix.dirname('/repo'));
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a nested absolute path', () => {
    describe('When basename runs', () => {
      it('Then it matches node:path/posix.basename', () => {
        // Arrange
        const path = '/repo/.git/worktrees/wt';

        // Act
        const result = portablePosixPolicy.basename(path);

        // Assert
        expect(result).toBe(nodePosix.basename(path));
      });
    });
  });

  describe('Given the filesystem root', () => {
    describe('When basename runs', () => {
      it('Then it matches node:path/posix.basename (empty string)', () => {
        // Arrange & Act
        const result = portablePosixPolicy.basename('/');

        // Assert
        expect(result).toBe(nodePosix.basename('/'));
        expect(result).toBe('');
      });
    });
  });

  describe('Given any path', () => {
    describe('When rootOf runs', () => {
      it('Then it always returns "/"', () => {
        // Arrange & Act
        const result = portablePosixPolicy.rootOf('/repo/wt');

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a path', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then it returns the path unchanged (POSIX is case-sensitive)', () => {
        // Arrange
        const path = '/Repo/WT';

        // Act
        const result = portablePosixPolicy.normalizeForCompare(path);

        // Assert
        expect(result).toBe(path);
      });
    });
  });
});
