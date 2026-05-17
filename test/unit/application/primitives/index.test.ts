import { describe, expect, it } from 'vitest';
import * as primitives from '../../../../src/application/primitives/index.js';

describe('primitives barrel', () => {
  it('Given the barrel, When imported, Then all primitives are exposed as functions', () => {
    const names = [
      'buildPack',
      'createCommit',
      'diffTrees',
      'fetchPack',
      'getRepoRoot',
      'mergeBase',
      'readBlob',
      'readIndex',
      'readObject',
      'readShallow',
      'readTree',
      'resolveRef',
      'updateRef',
      'updateShallow',
      'walkCommits',
      'walkTree',
      'writeObject',
      'writeSymbolicRef',
      'writeTree',
    ];
    for (const name of names) {
      expect(typeof (primitives as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('Given the barrel, When inspecting keys, Then only expected public surface is exposed', () => {
    const expected = new Set([
      'buildPack',
      'createCommit',
      'diffTrees',
      'fetchPack',
      'getRepoRoot',
      'mergeBase',
      'readBlob',
      'readIndex',
      'readObject',
      'readShallow',
      'readTree',
      'resolveRef',
      'updateRef',
      'updateShallow',
      'walkCommits',
      'walkTree',
      'writeObject',
      'writeSymbolicRef',
      'writeTree',
    ]);
    const actual = new Set(Object.keys(primitives));
    expect(actual).toEqual(expected);
  });
});
