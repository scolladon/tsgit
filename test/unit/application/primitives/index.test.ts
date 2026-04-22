import { describe, expect, it } from 'vitest';
import * as primitives from '../../../../src/application/primitives/index.js';

describe('primitives barrel', () => {
  it('Given the barrel, When imported, Then all 12 primitives are exposed as functions', () => {
    const names = [
      'createCommit',
      'diffTrees',
      'readBlob',
      'readIndex',
      'readObject',
      'readTree',
      'resolveRef',
      'updateRef',
      'walkCommits',
      'walkTree',
      'writeObject',
      'writeTree',
    ];
    for (const name of names) {
      expect(typeof (primitives as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('Given the barrel, When inspecting keys, Then only expected public surface is exposed', () => {
    const expected = new Set([
      'createCommit',
      'diffTrees',
      'readBlob',
      'readIndex',
      'readObject',
      'readTree',
      'resolveRef',
      'updateRef',
      'walkCommits',
      'walkTree',
      'writeObject',
      'writeTree',
    ]);
    const actual = new Set(Object.keys(primitives));
    expect(actual).toEqual(expected);
  });
});
