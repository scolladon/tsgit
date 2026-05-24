import { describe, expect, it } from 'vitest';
import * as primitives from '../../../../src/application/primitives/index.js';

describe('primitives barrel', () => {
  describe('Given the barrel', () => {
    describe('When imported', () => {
      it('Then all primitives are exposed as functions', () => {
        // Arrange
        const names = [
          'appendReflog',
          'applyChangeset',
          'buildIndexFromTree',
          'buildPack',
          'catFileBatch',
          'computeChangeset',
          'createCommit',
          'deleteReflog',
          'diffTrees',
          'enumeratePushObjects',
          'enumerateRefs',
          'fetchPack',
          'getRepoRoot',
          'invalidateConfigCache',
          'isWorkingTreeDirty',
          'listReflogs',
          'loadSparseMatcher',
          'materializeTree',
          'mergeBase',
          'readBlob',
          'readConfig',
          'readIndex',
          'readObject',
          'readReflog',
          'readShallow',
          'readSparsePatternText',
          'readTree',
          'recordRefUpdate',
          'reflogExists',
          'resolveRef',
          'resolveReflogIdentity',
          'runHook',
          'setConfigEntry',
          'setCoreConfigEntry',
          'sparseCheckoutPath',
          'synthesizeTreeFromIndex',
          'updateConfigEntries',
          'updateCoreConfig',
          'updateRef',
          'updateShallow',
          'walkCommits',
          'walkSubmodules',
          'walkTree',
          'walkWorkingTree',
          'writeObject',
          'writeReflog',
          'writeSparsePatternText',
          'writeSymbolicRef',
          'writeTree',
        ];
        for (const name of names) {
          // Assert
          expect(typeof (primitives as Record<string, unknown>)[name]).toBe('function');
        }
      });
    });
    describe('When inspecting keys', () => {
      it('Then only expected public surface is exposed', () => {
        // Arrange
        const expected = new Set([
          'appendReflog',
          'applyChangeset',
          'buildIndexFromTree',
          'buildPack',
          'catFileBatch',
          'computeChangeset',
          'createCommit',
          'deleteReflog',
          'diffTrees',
          'enumeratePushObjects',
          'enumerateRefs',
          'fetchPack',
          'getRepoRoot',
          'invalidateConfigCache',
          'isWorkingTreeDirty',
          'listReflogs',
          'loadSparseMatcher',
          'materializeTree',
          'MAX_SPARSE_PATTERN_FILE_BYTES',
          'mergeBase',
          'readBlob',
          'readConfig',
          'readIndex',
          'readObject',
          'readReflog',
          'readShallow',
          'readSparsePatternText',
          'readTree',
          'recordRefUpdate',
          'reflogExists',
          'resolveRef',
          'resolveReflogIdentity',
          'runHook',
          'setConfigEntry',
          'setCoreConfigEntry',
          'sparseCheckoutPath',
          'synthesizeTreeFromIndex',
          'updateConfigEntries',
          'updateCoreConfig',
          'updateRef',
          'updateShallow',
          'walkCommits',
          'walkSubmodules',
          'walkTree',
          'walkWorkingTree',
          'writeObject',
          'writeReflog',
          'writeSparsePatternText',
          'writeSymbolicRef',
          'writeTree',
        ]);
        const actual = new Set(Object.keys(primitives));
        // Assert
        expect(actual).toEqual(expected);
      });
    });
  });
});
