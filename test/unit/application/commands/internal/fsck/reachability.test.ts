import { describe, expect, it } from 'vitest';
import type { CachedGitObject } from '../../../../../../src/application/commands/internal/fsck/object-cache.js';
import {
  assembleConnectivityFindings,
  buildInEdgeMap,
  buildReachableSet,
  excusePackHeld,
  type GraphEdge,
  type TypeResolution,
  typedBeforeWalk,
  type WalkResult,
} from '../../../../../../src/application/commands/internal/fsck/reachability.js';
import { FILE_MODE } from '../../../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../../src/domain/objects/tree.js';

const oid = (ch: string): ObjectId => ch.repeat(40) as ObjectId;
const A = oid('a');
const B = oid('b');
const C = oid('c');
const T = oid('1');
const R = oid('2');
const Y = oid('4');

const commit = (tree: ObjectId, ...parents: ReadonlyArray<ObjectId>): CachedGitObject => ({
  type: 'commit',
  tree,
  parents,
});
const BLOB: CachedGitObject = { type: 'blob' };
const EMPTY_TREE: CachedGitObject = { type: 'tree', entries: [] };

describe('Given a tree whose lookup of one entry cannot resolve', () => {
  describe('When the in-edge map is built', () => {
    it('Then a sibling entry of the same type still gets its in-edge', () => {
      // Arrange
      const universe = new Set([T, A, B]);
      const cache = new Map<ObjectId, CachedGitObject>([
        [
          T,
          {
            type: 'tree',
            entries: [treeEntry(FILE_MODE.REGULAR, 'a', A), treeEntry(FILE_MODE.REGULAR, 'b', B)],
          },
        ],
        [A, BLOB],
        [B, BLOB],
      ]);
      const unresolved = new Map([
        [
          T,
          [
            {
              type: 'type-conflict' as const,
              id: A,
              objectType: 'tree' as const,
              expectedType: 'blob' as const,
            },
          ],
        ],
      ]);
      const sut = buildInEdgeMap;

      // Act
      const result = sut(universe, cache, unresolved);

      // Assert
      expect([...result]).toEqual([B]);
    });
  });
});

describe('Given a commit naming parents already queued by an earlier discovery', () => {
  describe('When the reachable set is built', () => {
    it('Then each object is walked at its first discovery, not at its last', () => {
      // Arrange
      const universe = new Set([R, C, B, Y, T]);
      const cache = new Map<ObjectId, CachedGitObject>([
        [R, commit(T, Y, B, C)],
        [C, commit(T, Y)],
        [B, commit(T)],
        [Y, commit(T)],
        [T, EMPTY_TREE],
      ]);
      const sut = buildReachableSet;

      // Act
      const result = sut(universe, new Set([R]), cache, 'skip', new Set(), new Set());

      // Assert
      expect([...result.reached]).toEqual([R, C, B, Y, T]);
    });
  });
});

describe('Given an edge to a promisor object absent from the universe', () => {
  describe('When the reachable set is built', () => {
    it('Then the promised object is reached and neither missing nor a broken link', () => {
      // Arrange
      const universe = new Set([R, T]);
      const cache = new Map<ObjectId, CachedGitObject>([
        [R, commit(T, A)],
        [T, EMPTY_TREE],
      ]);
      const sut = buildReachableSet;

      // Act
      const result = sut(universe, new Set([R]), cache, 'skip', new Set(), new Set([A]));

      // Assert
      expect(result.reached.has(A)).toBe(true);
      expect([...result.missingIds]).toEqual([]);
      expect(result.brokenEdges).toEqual([]);
    });
  });
});

describe('Given a promisor object seeded as a root', () => {
  describe('When the reachable set is built', () => {
    it('Then it is reached without following its links', () => {
      // Arrange
      const universe = new Set([A, T]);
      const cache = new Map<ObjectId, CachedGitObject>([
        [A, commit(T)],
        [T, EMPTY_TREE],
      ]);
      const sut = buildReachableSet;

      // Act
      const result = sut(universe, new Set([A]), cache, 'skip', new Set(), new Set([A]));

      // Assert
      expect([...result.reached]).toEqual([A]);
    });
  });
});

describe('Given a connectivity-only walk popping a root whose copy hashes to another id', () => {
  describe('When the reachable set is built', () => {
    it('Then the root is reported unknown-typed and its links are not followed', () => {
      // Arrange
      const universe = new Set([A, T]);
      const cache = new Map<ObjectId, CachedGitObject>([
        [A, commit(T)],
        [T, EMPTY_TREE],
      ]);
      const typing = {
        typedBeforeWalk: new Map(),
        unparseable: new Set([A]),
        graphCommits: new Map(),
      };
      const sut = buildReachableSet;

      // Act
      const result = sut(universe, new Set([A]), cache, 'classify', new Set(), new Set(), typing);

      // Assert
      expect(result.typeFindings).toEqual([{ type: 'unknown-object-type', id: A }]);
      expect([...result.reached]).toEqual([A]);
    });
  });
});

describe('Given ref tips and index blobs typing the same object differently', () => {
  describe('When the pre-walk typing is built', () => {
    it('Then the first type an object gets wins', () => {
      // Arrange
      const cache = new Map<ObjectId, CachedGitObject>([[R, commit(T)]]);
      const sut = typedBeforeWalk;

      // Act
      const result = sut(cache, { refTips: [R], indexBlobs: [T], parsedIndexIds: [] });

      // Assert
      expect(result.get(T)).toBe('tree');
    });
  });

  describe('When a parsed ref tip is typed by no link', () => {
    it('Then it is typed as itself', () => {
      // Arrange
      const cache = new Map<ObjectId, CachedGitObject>([[R, commit(T)]]);
      const sut = typedBeforeWalk;

      // Act
      const result = sut(cache, { refTips: [R], indexBlobs: [], parsedIndexIds: [] });

      // Assert
      expect(result.get(R)).toBe('commit');
    });
  });
});

const edgeTo = (toId: ObjectId): GraphEdge => ({
  fromId: R,
  fromType: 'commit',
  toId,
  toType: 'commit',
});

const walkOf = (overrides: Partial<WalkResult>): WalkResult => ({
  reached: new Set(),
  missingIds: new Set(),
  brokenEdges: [],
  unreadableEdges: [],
  typeFindings: [],
  typed: undefined,
  ...overrides,
});

describe('Given missing ids of which a pack holds only some', () => {
  describe('When the pack-held ones are excused', () => {
    it('Then only they leave the missing ids and the broken edges', async () => {
      // Arrange
      const walk = walkOf({
        missingIds: new Set([A, B]),
        brokenEdges: [edgeTo(A), edgeTo(B)],
      });
      const sut = excusePackHeld;

      // Act
      const result = await sut(walk, async (id) => id === A);

      // Assert
      expect([...result.missingIds]).toEqual([B]);
      expect(result.brokenEdges).toEqual([edgeTo(B)]);
    });
  });

  describe('When the pack holds none of them', () => {
    it('Then the very same walk comes back', async () => {
      // Arrange
      const walk = walkOf({ missingIds: new Set([A]), brokenEdges: [edgeTo(A)] });
      const sut = excusePackHeld;

      // Act
      const result = await sut(walk, async () => false);

      // Assert
      expect(result).toBe(walk);
    });
  });
});

describe('Given a classification holding a root commit', () => {
  const classification = {
    missingIds: new Set<ObjectId>(),
    brokenEdges: [],
    unreadableEdges: [],
    unreachable: [],
    dangling: [],
    rootCommits: [R],
    tagRefs: [],
  };
  const resolution = (unreadable: TypeResolution['unreadable']): TypeResolution => ({
    objectCache: new Map(),
    recovered: new Map(),
    unreadable,
    indexBlobs: new Set(),
  });

  describe('When the findings are assembled outside connectivity-only', () => {
    it('Then the root is reported', () => {
      // Arrange
      const sut = assembleConnectivityFindings;

      // Act
      const result = sut(classification, resolution('skip'));

      // Assert
      expect(result).toEqual([{ type: 'root', id: R }]);
    });
  });

  describe('When the findings are assembled under connectivity-only', () => {
    it('Then no root is reported, as git prints it from fsck_obj alone', () => {
      // Arrange
      const sut = assembleConnectivityFindings;

      // Act
      const result = sut(classification, resolution('classify'));

      // Assert
      expect(result).toEqual([]);
    });
  });
});
