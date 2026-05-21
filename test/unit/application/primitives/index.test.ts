import { describe, expect, it } from 'vitest';
import * as primitives from '../../../../src/application/primitives/index.js';

describe('primitives barrel', () => {
  it('Given the barrel, When imported, Then all primitives are exposed as functions', () => {
    const names = [
      'appendReflog',
      'applyChangeset',
      'buildIndexFromTree',
      'buildPack',
      'computeChangeset',
      'createCommit',
      'deleteReflog',
      'diffTrees',
      'enumeratePushObjects',
      'enumerateRefs',
      'fetchPack',
      'getRepoRoot',
      'listReflogs',
      'materializeTree',
      'mergeBase',
      'readBlob',
      'readConfig',
      'readIndex',
      'readObject',
      'readReflog',
      'readShallow',
      'readTree',
      'recordRefUpdate',
      'reflogExists',
      'resolveRef',
      'resolveReflogIdentity',
      'synthesizeTreeFromIndex',
      'updateRef',
      'updateShallow',
      'walkCommits',
      'walkTree',
      'walkWorkingTree',
      'writeObject',
      'writeReflog',
      'writeSymbolicRef',
      'writeTree',
    ];
    for (const name of names) {
      expect(typeof (primitives as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('Given the barrel, When inspecting keys, Then only expected public surface is exposed', () => {
    const expected = new Set([
      'appendReflog',
      'applyChangeset',
      'buildIndexFromTree',
      'buildPack',
      'computeChangeset',
      'createCommit',
      'deleteReflog',
      'diffTrees',
      'enumeratePushObjects',
      'enumerateRefs',
      'fetchPack',
      'getRepoRoot',
      'listReflogs',
      'materializeTree',
      'mergeBase',
      'readBlob',
      'readConfig',
      'readIndex',
      'readObject',
      'readReflog',
      'readShallow',
      'readTree',
      'recordRefUpdate',
      'reflogExists',
      'resolveRef',
      'resolveReflogIdentity',
      'synthesizeTreeFromIndex',
      'updateRef',
      'updateShallow',
      'walkCommits',
      'walkTree',
      'walkWorkingTree',
      'writeObject',
      'writeReflog',
      'writeSymbolicRef',
      'writeTree',
    ]);
    const actual = new Set(Object.keys(primitives));
    expect(actual).toEqual(expected);
  });
});
