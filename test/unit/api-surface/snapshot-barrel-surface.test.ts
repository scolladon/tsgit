import { describe, expect, it } from 'vitest';

import type { SnapshotKind } from '../../../src/domain/snapshot/index.js';
import type {
  IndexEntry,
  IndexSnapshot,
  Snapshot,
  SnapshotEntry,
  SnapshotFactory,
  SnapshotOptions,
  StashSnapshot,
  TreeEntry,
  TreeSnapshot,
  WorkdirEntry,
  WorkdirSnapshot,
  WorkdirSnapshotOptions,
} from '../../../src/index.js';
import * as barrel from '../../../src/index.js';

/**
 * Pins the public `src/index.ts` barrel's snapshot surface. The resolver-stack
 * wiring (`create*Snapshot` / `createSnapshotFactory`) is an internal
 * composition detail — consumers read snapshots through `repo.snapshot.*` and
 * never hand-wire deps — so it must NOT be advertised on the barrel. The
 * snapshot type vocabulary and the `join` / `requireSnapshot` composition
 * helpers stay reachable.
 */
describe('Given the public package barrel', () => {
  describe('When inspecting its snapshot exports', () => {
    it('Then the resolver-stack wiring factories are absent', () => {
      // Arrange — widen to an index signature so probing an intentionally-removed
      // name resolves to `undefined` instead of being a compile error.
      const sut = barrel as Record<string, unknown>;

      // Act
      const wiring = [
        sut.createIndexSnapshot,
        sut.createTreeSnapshot,
        sut.createWorkdirSnapshot,
        sut.createStashSnapshot,
        sut.createSnapshotFactory,
      ];

      // Assert
      expect(wiring).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
    });
  });

  describe('When inspecting its snapshot composition helpers', () => {
    it('Then join, innerJoin, and requireSnapshot remain callable', () => {
      // Arrange
      const sut = barrel;

      // Act
      const kinds = [typeof sut.join, typeof sut.innerJoin, typeof sut.requireSnapshot];

      // Assert
      expect(kinds).toStrictEqual(['function', 'function', 'function']);
    });
  });

  describe('When naming its snapshot type vocabulary', () => {
    it('Then every public snapshot type still resolves through the barrel', () => {
      // Arrange — types vanish at runtime; type-position witnesses prove the
      // names still resolve through `src/index.js` at compile time.
      const sut = {
        factory: undefined as unknown as SnapshotFactory,
        stash: undefined as unknown as StashSnapshot,
        workdirOptions: undefined as unknown as WorkdirSnapshotOptions,
        snapshot: undefined as unknown as Snapshot<SnapshotEntry>,
        snapshotOptions: undefined as unknown as SnapshotOptions,
        tree: undefined as unknown as TreeSnapshot,
        index: undefined as unknown as IndexSnapshot,
        workdir: undefined as unknown as WorkdirSnapshot,
        treeEntry: undefined as unknown as TreeEntry,
        indexEntry: undefined as unknown as IndexEntry,
        workdirEntry: undefined as unknown as WorkdirEntry,
        kind: 'tree' satisfies SnapshotKind,
      };

      // Act
      const observed = sut.kind;

      // Assert
      expect(observed).toBe('tree');
    });
  });
});
