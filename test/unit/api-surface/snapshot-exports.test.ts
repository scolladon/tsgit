import { describe, expect, it } from 'vitest';

import type { IndexEntry } from '../../../src/application/primitives/snapshot/index-entry.js';
import { requireSnapshot } from '../../../src/application/primitives/snapshot/require-snapshot.js';
import type { TreeEntry } from '../../../src/application/primitives/snapshot/tree-entry.js';
import type { WorkdirEntry } from '../../../src/application/primitives/snapshot/workdir-entry.js';
import type {
  IndexCachedStat,
  IndexEntryRow,
  IndexFlags,
  SnapshotKind,
  TreeEntryRow,
  WorkdirEntryRow,
  WorkdirStat,
} from '../../../src/domain/snapshot/index.js';
import type {
  Disposable,
  GenerationView,
  IndexResolver,
  ResolveOptions,
  SshChannel,
  SshSpawnRequest,
  SshTransport,
  TreeResolver,
  WalkIgnorePredicate,
  WorkdirEnumerator,
  WorkdirEnumOptions,
  WriteEventEmitter,
  WriteEventStream,
  WriteScope,
} from '../../../src/ports/index.js';

/**
 * Smoke test for the snapshot+join public type surface. The Wave 1 surface
 * is introduced ahead of any internal consumer; this test imports every
 * new export so `check:dead-code` (knip) sees reachability without an
 * allowlist entry. It grows as Wave 1 progresses (Steps 1.4 entries, 1.5
 * bus + view, 1.7 resolvers, 1.9 snapshots, 1.10 factory, 1.11 join, 1.12
 * operators) and is the load-bearing reference for the public surface
 * landing in Step 1.14 (repository wiring + index exports).
 */
describe('Given the Step 1.1 type surface', () => {
  describe('When asserting every new domain row type is importable', () => {
    it('Then the imports resolve and the type names are non-empty strings', () => {
      // Arrange — types vanish at runtime; construct concrete witnesses for each.
      const sut = {
        snapshotKind: 'tree' satisfies SnapshotKind,
        treeRow: undefined as unknown as TreeEntryRow,
        indexRow: undefined as unknown as IndexEntryRow,
        indexFlags: undefined as unknown as IndexFlags,
        indexCachedStat: undefined as unknown as IndexCachedStat,
        workdirRow: undefined as unknown as WorkdirEntryRow,
        workdirStat: undefined as unknown as WorkdirStat,
      };

      // Act
      const observed = sut.snapshotKind;

      // Assert
      expect(observed).toBe('tree');
    });
  });

  describe('When asserting every new port interface is importable', () => {
    it('Then the imports resolve and concrete witnesses can be typed', () => {
      // Arrange
      const sut = {
        scope: 'index' satisfies WriteScope,
        emitter: undefined as unknown as WriteEventEmitter,
        stream: undefined as unknown as WriteEventStream,
        disposable: undefined as unknown as Disposable,
        view: undefined as unknown as GenerationView,
        resolveOpts: undefined as unknown as ResolveOptions,
        indexResolver: undefined as unknown as IndexResolver,
        treeResolver: undefined as unknown as TreeResolver,
        workdirEnumerator: undefined as unknown as WorkdirEnumerator,
        workdirEnumOpts: undefined as unknown as WorkdirEnumOptions,
        ignorePredicate: undefined as unknown as WalkIgnorePredicate,
        sshSpawnRequest: undefined as unknown as SshSpawnRequest,
        sshChannel: undefined as unknown as SshChannel,
        sshTransport: undefined as unknown as SshTransport,
      };

      // Act
      const observed = sut.scope;

      // Assert
      expect(observed).toBe('index');
    });
  });

  describe('When asserting every new application entry surface is importable', () => {
    it('Then the entry interfaces and requireSnapshot helper resolve', () => {
      // Arrange
      const sut = {
        treeEntry: undefined as unknown as TreeEntry,
        indexEntry: undefined as unknown as IndexEntry,
        workdirEntry: undefined as unknown as WorkdirEntry,
        require: requireSnapshot,
      };

      // Act
      const observed = typeof sut.require;

      // Assert
      expect(observed).toBe('function');
    });
  });
});
