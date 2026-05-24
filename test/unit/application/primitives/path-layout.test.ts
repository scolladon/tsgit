import { describe, expect, it } from 'vitest';
import {
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

describe('path-layout', () => {
  it('Given gitDir and an ObjectId, When looseObjectPath, Then returns /gitDir/objects/xx/yyyy...', () => {
    // Arrange
    const id = ('ab' + 'cd'.repeat(19)) as ObjectId;
    const sut = looseObjectPath('/g', id);
    // Assert
    expect(sut).toBe('/g/objects/ab/' + 'cd'.repeat(19));
  });

  it('Given gitDir and a RefName, When looseRefPath, Then returns /gitDir/<name>', () => {
    // Arrange
    const sut = looseRefPath('/g', 'refs/heads/main' as RefName);
    // Assert
    expect(sut).toBe('/g/refs/heads/main');
  });

  it('Given gitDir, When packedRefsPath, Then returns /gitDir/packed-refs', () => {
    // Arrange
    const sut = packedRefsPath('/g');

    // Assert
    expect(sut).toBe('/g/packed-refs');
  });

  it('Given gitDir, When indexPath, Then returns /gitDir/index', () => {
    // Arrange
    const sut = indexPath('/g');

    // Assert
    expect(sut).toBe('/g/index');
  });

  it('Given gitDir and prefix, When objectsDir, Then returns /gitDir/objects/<prefix>', () => {
    // Arrange
    const sut = objectsDir('/g', 'ab');

    // Assert
    expect(sut).toBe('/g/objects/ab');
  });

  it('Given gitDir, When packsDir, Then returns /gitDir/objects/pack', () => {
    // Arrange
    const sut = packsDir('/g');

    // Assert
    expect(sut).toBe('/g/objects/pack');
  });

  it('Given lockSuffix, When read, Then equals .lock', () => {
    // Arrange + Assert
    expect(lockSuffix).toBe('.lock');
  });

  it('Given gitDir, When logsDir, Then returns /gitDir/logs', () => {
    // Arrange
    const sut = logsDir('/g');

    // Assert
    expect(sut).toBe('/g/logs');
  });

  it('Given gitDir and a RefName, When reflogPath, Then returns /gitDir/logs/<name>', () => {
    // Arrange
    const sut = reflogPath('/g', 'refs/heads/main' as RefName);
    // Assert
    expect(sut).toBe('/g/logs/refs/heads/main');
  });

  it('Given gitDir and the HEAD ref, When reflogPath, Then returns /gitDir/logs/HEAD', () => {
    // Arrange
    const sut = reflogPath('/g', 'HEAD' as RefName);
    // Assert
    expect(sut).toBe('/g/logs/HEAD');
  });

  it('Given gitDir, When sparseCheckoutPath, Then returns /gitDir/info/sparse-checkout', () => {
    // Arrange
    const sut = sparseCheckoutPath('/g');

    // Assert
    expect(sut).toBe('/g/info/sparse-checkout');
  });
});
