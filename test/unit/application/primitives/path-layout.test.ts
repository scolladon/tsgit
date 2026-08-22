import { describe, expect, it } from 'vitest';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphPath,
  commonDirOf,
  commonGitDir,
  getSpawnCwd,
  indexPath,
  lockSuffix,
  logsDir,
  looseObjectPath,
  looseRefPath,
  multiPackIndexChainPath,
  multiPackIndexLayerPath,
  multiPackIndexPath,
  objectsDir,
  packedRefsPath,
  packsDir,
  reflogPath,
  reftableDir,
  sparseCheckoutPath,
  tablesListLockPath,
  tablesListPath,
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
    describe('When reftableDir', () => {
      it('Then returns /gitDir/reftable', () => {
        // Arrange & Act
        const result = reftableDir('/g');

        // Assert
        expect(result).toBe('/g/reftable');
      });
    });
    describe('When tablesListPath', () => {
      it('Then returns /gitDir/reftable/tables.list', () => {
        // Arrange & Act
        const result = tablesListPath('/g');

        // Assert
        expect(result).toBe('/g/reftable/tables.list');
      });
    });
    describe('When tablesListLockPath', () => {
      it('Then returns /gitDir/reftable/tables.list.lock', () => {
        // Arrange & Act
        const result = tablesListLockPath('/g');

        // Assert
        expect(result).toBe('/g/reftable/tables.list.lock');
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

  describe('Given a layout with no commonDir', () => {
    describe('When commonDirOf', () => {
      it('Then falls back to gitDir', () => {
        // Arrange
        const layout = ctxWithLayout('/g').layout;

        // Act
        const result = commonDirOf(layout);

        // Assert
        expect(result).toBe('/g');
      });
    });
  });

  describe('Given a layout whose commonDir differs from gitDir', () => {
    describe('When commonDirOf', () => {
      it('Then returns the commonDir', () => {
        // Arrange
        const layout = ctxWithLayout('/g/worktrees/wt', '/g').layout;

        // Act
        const result = commonDirOf(layout);

        // Assert
        expect(result).toBe('/g');
      });
    });
  });

  describe('Given gitDir', () => {
    describe('When commitGraphPath', () => {
      it('Then returns /gitDir/objects/info/commit-graph', () => {
        // Arrange & Act
        const result = commitGraphPath('/g');

        // Assert
        expect(result).toBe('/g/objects/info/commit-graph');
      });
    });

    describe('When commitGraphChainPath', () => {
      it('Then returns /gitDir/objects/info/commit-graphs/commit-graph-chain', () => {
        // Arrange & Act
        const result = commitGraphChainPath('/g');

        // Assert
        expect(result).toBe('/g/objects/info/commit-graphs/commit-graph-chain');
      });
    });
  });

  describe('Given gitDir and a layer hash', () => {
    describe('When commitGraphLayerPath', () => {
      it('Then returns /gitDir/objects/info/commit-graphs/graph-<hash>.graph', () => {
        // Arrange & Act
        const result = commitGraphLayerPath('/g', 'deadbeef');

        // Assert
        expect(result).toBe('/g/objects/info/commit-graphs/graph-deadbeef.graph');
      });
    });
  });

  describe('Given a packs directory', () => {
    describe('When multiPackIndexPath', () => {
      it('Then returns /packsDir/multi-pack-index', () => {
        // Arrange & Act
        const result = multiPackIndexPath('/g/objects/pack');

        // Assert
        expect(result).toBe('/g/objects/pack/multi-pack-index');
      });
    });

    describe('When multiPackIndexChainPath', () => {
      it('Then returns /packsDir/multi-pack-index.d/multi-pack-index-chain', () => {
        // Arrange & Act
        const result = multiPackIndexChainPath('/g/objects/pack');

        // Assert
        expect(result).toBe('/g/objects/pack/multi-pack-index.d/multi-pack-index-chain');
      });
    });
  });

  describe('Given a packs directory and a layer digest', () => {
    describe('When multiPackIndexLayerPath', () => {
      it('Then returns /packsDir/multi-pack-index.d/multi-pack-index-<digest>.midx', () => {
        // Arrange & Act
        const result = multiPackIndexLayerPath('/g/objects/pack', 'deadbeef');

        // Assert
        expect(result).toBe('/g/objects/pack/multi-pack-index.d/multi-pack-index-deadbeef.midx');
      });
    });
  });
});

describe('getSpawnCwd', () => {
  describe('Given a layout with a work tree', () => {
    describe('When getSpawnCwd runs', () => {
      it('Then the work tree is the spawn cwd', () => {
        // Arrange
        const sut = getSpawnCwd;

        // Act
        const result = sut({
          workDir: '/repo',
          gitDir: '/repo/.git',
          bare: false,
          refStorage: 'files',
        });

        // Assert
        expect(result).toBe('/repo');
      });
    });
  });

  describe('Given a bare layout with no work tree', () => {
    describe('When getSpawnCwd runs', () => {
      it('Then the gitDir is the spawn cwd — git runs bare hooks with PWD at the gitdir', () => {
        // Arrange
        const sut = getSpawnCwd;

        // Act
        const result = sut({ gitDir: '/srv/bare.git', bare: true, refStorage: 'files' });

        // Assert
        expect(result).toBe('/srv/bare.git');
      });
    });
  });
});
