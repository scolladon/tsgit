import { describe, expect, it } from 'vitest';
import {
  commonGitDir,
  indexPath,
  lockSuffix,
  logsDir,
  looseObjectPath,
  looseRefPath,
  objectsDir,
  packedRefsPath,
  packsDir,
  reflogPath,
  sparseCheckoutPath,
} from '../../../../src/application/primitives/path-layout.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ctxWithLayout = (gitDir: string, commonDir?: string): Context =>
  ({ layout: { gitDir, ...(commonDir !== undefined ? { commonDir } : {}) } }) as Context;

describe('path-layout', () => {
  describe('Given gitDir and an ObjectId', () => {
    describe('When looseObjectPath', () => {
      it('Then returns /gitDir/objects/xx/yyyy...', () => {
        // Arrange
        const id = ('ab' + 'cd'.repeat(19)) as ObjectId;

        // Act
        const result = looseObjectPath('/g', id);

        // Assert
        expect(result).toBe('/g/objects/ab/' + 'cd'.repeat(19));
      });
    });
  });

  describe('Given gitDir and a RefName', () => {
    describe('When looseRefPath', () => {
      it('Then returns /gitDir/<name>', () => {
        // Arrange & Act
        const result = looseRefPath('/g', 'refs/heads/main' as RefName);

        // Assert
        expect(result).toBe('/g/refs/heads/main');
      });
    });
  });

  describe('Given gitDir', () => {
    describe('When packedRefsPath', () => {
      it('Then returns /gitDir/packed-refs', () => {
        // Arrange & Act
        const result = packedRefsPath('/g');

        // Assert
        expect(result).toBe('/g/packed-refs');
      });
    });
    describe('When indexPath', () => {
      it('Then returns /gitDir/index', () => {
        // Arrange & Act
        const result = indexPath('/g');

        // Assert
        expect(result).toBe('/g/index');
      });
    });
  });

  describe('Given gitDir and prefix', () => {
    describe('When objectsDir', () => {
      it('Then returns /gitDir/objects/<prefix>', () => {
        // Arrange & Act
        const result = objectsDir('/g', 'ab');

        // Assert
        expect(result).toBe('/g/objects/ab');
      });
    });
  });

  describe('Given gitDir', () => {
    describe('When packsDir', () => {
      it('Then returns /gitDir/objects/pack', () => {
        // Arrange & Act
        const result = packsDir('/g');

        // Assert
        expect(result).toBe('/g/objects/pack');
      });
    });
  });

  describe('Given lockSuffix', () => {
    describe('When read', () => {
      it('Then equals .lock', () => {
        // Arrange
        const result = lockSuffix;

        // Assert
        expect(result).toBe('.lock');
      });
    });
  });

  describe('Given gitDir', () => {
    describe('When logsDir', () => {
      it('Then returns /gitDir/logs', () => {
        // Arrange & Act
        const result = logsDir('/g');

        // Assert
        expect(result).toBe('/g/logs');
      });
    });
  });

  describe('Given gitDir and a RefName', () => {
    describe('When reflogPath', () => {
      it('Then returns /gitDir/logs/<name>', () => {
        // Arrange & Act
        const result = reflogPath('/g', 'refs/heads/main' as RefName);

        // Assert
        expect(result).toBe('/g/logs/refs/heads/main');
      });
    });
  });

  describe('Given gitDir and the HEAD ref', () => {
    describe('When reflogPath', () => {
      it('Then returns /gitDir/logs/HEAD', () => {
        // Arrange & Act
        const result = reflogPath('/g', 'HEAD' as RefName);

        // Assert
        expect(result).toBe('/g/logs/HEAD');
      });
    });
  });

  describe('Given gitDir', () => {
    describe('When sparseCheckoutPath', () => {
      it('Then returns /gitDir/info/sparse-checkout', () => {
        // Arrange & Act
        const result = sparseCheckoutPath('/g');

        // Assert
        expect(result).toBe('/g/info/sparse-checkout');
      });
    });
  });

  describe('Given a layout with no commonDir', () => {
    describe('When commonGitDir', () => {
      it('Then falls back to gitDir', () => {
        // Arrange
        const ctx = ctxWithLayout('/g');

        // Act
        const result = commonGitDir(ctx);

        // Assert
        expect(result).toBe('/g');
      });
    });
  });

  describe('Given a layout whose commonDir differs from gitDir', () => {
    describe('When commonGitDir', () => {
      it('Then returns the commonDir', () => {
        // Arrange
        const ctx = ctxWithLayout('/g/worktrees/wt', '/g');

        // Act
        const result = commonGitDir(ctx);

        // Assert
        expect(result).toBe('/g');
      });
    });
  });
});
