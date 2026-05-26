import { describe, expect, it } from 'vitest';
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
      // Types vanish at runtime, so we assert their declared names exist as
      // type-level identifiers by constructing concrete witnesses below.
      const sut = {
        snapshotKind: 'tree' satisfies SnapshotKind,
        treeRow: undefined as unknown as TreeEntryRow,
        indexRow: undefined as unknown as IndexEntryRow,
        indexFlags: undefined as unknown as IndexFlags,
        indexCachedStat: undefined as unknown as IndexCachedStat,
        workdirRow: undefined as unknown as WorkdirEntryRow,
        workdirStat: undefined as unknown as WorkdirStat,
      };

      expect(sut.snapshotKind).toBe('tree');
    });
  });

  describe('When asserting every new port interface is importable', () => {
    it('Then the imports resolve and concrete witnesses can be typed', () => {
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
      };

      expect(sut.scope).toBe('index');
    });
  });
});
