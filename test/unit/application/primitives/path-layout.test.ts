import { describe, expect, it } from 'vitest';
import {
  indexPath,
  lockSuffix,
  looseObjectPath,
  looseRefPath,
  objectsDir,
  packedRefsPath,
  packsDir,
} from '../../../../src/application/primitives/path-layout.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';

describe('path-layout', () => {
  it('Given gitDir and an ObjectId, When looseObjectPath, Then returns /gitDir/objects/xx/yyyy...', () => {
    const id = ('ab' + 'cd'.repeat(19)) as ObjectId;
    const sut = looseObjectPath('/g', id);
    expect(sut).toBe('/g/objects/ab/' + 'cd'.repeat(19));
  });

  it('Given gitDir and a RefName, When looseRefPath, Then returns /gitDir/<name>', () => {
    const sut = looseRefPath('/g', 'refs/heads/main' as RefName);
    expect(sut).toBe('/g/refs/heads/main');
  });

  it('Given gitDir, When packedRefsPath, Then returns /gitDir/packed-refs', () => {
    expect(packedRefsPath('/g')).toBe('/g/packed-refs');
  });

  it('Given gitDir, When indexPath, Then returns /gitDir/index', () => {
    expect(indexPath('/g')).toBe('/g/index');
  });

  it('Given gitDir and prefix, When objectsDir, Then returns /gitDir/objects/<prefix>', () => {
    expect(objectsDir('/g', 'ab')).toBe('/g/objects/ab');
  });

  it('Given gitDir, When packsDir, Then returns /gitDir/objects/pack', () => {
    expect(packsDir('/g')).toBe('/g/objects/pack');
  });

  it('Given lockSuffix, When read, Then equals .lock', () => {
    expect(lockSuffix).toBe('.lock');
  });
});
