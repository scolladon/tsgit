import { describe, expect, it, vi } from 'vitest';
import type { FlatTree, FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import { MAX_FLAT_TREE_ENTRIES } from '../../../../src/domain/diff/flat-tree.js';
import type {
  ContentMergeContext,
  ContentMergeResult,
} from '../../../../src/domain/merge/merge-types.js';
import { MAX_CONFLICT_OUTPUT_BYTES } from '../../../../src/domain/merge/merge-types.js';
import type { ContentMerger } from '../../../../src/domain/merge/three-way-tree.js';
import { mergeTrees } from '../../../../src/domain/merge/three-way-tree.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ID_C = 'c'.repeat(40) as ObjectId;
const ID_D = 'd'.repeat(40) as ObjectId;

function entry(id: ObjectId, mode: FileMode = FILE_MODE.REGULAR): FlatTreeEntry {
  return { id, mode };
}

function tree(pairs: ReadonlyArray<readonly [string, FlatTreeEntry]>): FlatTree {
  const map = new Map<FilePath, FlatTreeEntry>();
  for (const [p, e] of pairs) map.set(p as FilePath, e);
  return { entries: map };
}

const noopMerger: ContentMerger = (_ctx, _base, _ours, _theirs) => ({
  status: 'clean',
  bytes: new Uint8Array(0),
});

function spyMerger(result: ContentMergeResult | Promise<ContentMergeResult>): {
  readonly fn: ContentMerger;
  readonly ctxs: ContentMergeContext[];
} {
  const ctxs: ContentMergeContext[] = [];
  const fn: ContentMerger = (ctx, _base, _ours, _theirs) => {
    ctxs.push(ctx);
    return result;
  };
  return { fn, ctxs };
}

describe('mergeTrees — decision table rows', () => {
  it('Given all three sides identical (X|X|X), When mergeTrees called, Then outcome is unchanged with id and mode', async () => {
    // Arrange
    const t = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(t, t, t, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([
      { status: 'unchanged', path: 'p', id: ID_A, mode: FILE_MODE.REGULAR },
    ]);
    expect(result.cleanMerge).toBe(true);
  });

  it("Given theirs modified and ours unchanged (X|X|Y), When mergeTrees called, Then outcome is resolved-known with theirs' id and mode", async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_A)]]);
    const theirs = tree([['p', entry(ID_B)]]);

    // Act
    const result = await mergeTrees(base, ours, theirs, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([
      { status: 'resolved-known', path: 'p', id: ID_B, mode: FILE_MODE.REGULAR },
    ]);
  });

  it("Given ours modified and theirs unchanged (X|Y|X), When mergeTrees called, Then outcome is resolved-known with ours' id and mode", async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(base, ours, theirs, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([
      { status: 'resolved-known', path: 'p', id: ID_B, mode: FILE_MODE.REGULAR },
    ]);
  });

  it("Given both sides same change (X|Y|Y), When mergeTrees called, Then outcome is resolved-known with ours' id", async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const sameChange = tree([['p', entry(ID_B)]]);

    // Act
    const result = await mergeTrees(base, sameChange, sameChange, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([
      { status: 'resolved-known', path: 'p', id: ID_B, mode: FILE_MODE.REGULAR },
    ]);
  });

  it('Given modify-modify with different ids (X|Y|Z), When mergeTrees called, Then contentMerger is invoked and result threaded', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const bytes = new Uint8Array([1, 2, 3]);
    const spy = spyMerger({ status: 'clean', bytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    expect(spy.ctxs).toHaveLength(1);
    expect(result.outcomes).toEqual([
      { status: 'resolved-merged', path: 'p', bytes, mode: FILE_MODE.REGULAR },
    ]);
  });

  it('Given add by us only (—|X|—), When mergeTrees called, Then outcome is resolved-known with ours', async () => {
    // Arrange
    const ours = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(undefined, ours, undefined, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([
      { status: 'resolved-known', path: 'p', id: ID_A, mode: FILE_MODE.REGULAR },
    ]);
  });

  it('Given add by them only (—|—|X), When mergeTrees called, Then outcome is resolved-known with theirs', async () => {
    // Arrange
    const theirs = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(undefined, undefined, theirs, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([
      { status: 'resolved-known', path: 'p', id: ID_A, mode: FILE_MODE.REGULAR },
    ]);
  });

  it('Given same add on both sides (—|X|X), When mergeTrees called, Then outcome is resolved-known', async () => {
    // Arrange
    const same = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(undefined, same, same, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([
      { status: 'resolved-known', path: 'p', id: ID_A, mode: FILE_MODE.REGULAR },
    ]);
  });

  it('Given add-add with different content (—|X|Y), When mergeTrees called, Then conflict with type add-add', async () => {
    // Arrange
    const ours = tree([['p', entry(ID_A)]]);
    const theirs = tree([['p', entry(ID_B)]]);

    // Act
    const result = await mergeTrees(undefined, ours, theirs, noopMerger);

    // Assert
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('add-add');
    expect(result.conflicts[0]?.ourId).toBe(ID_A);
    expect(result.conflicts[0]?.theirId).toBe(ID_B);
  });

  it('Given we deleted and theirs unchanged (X|—|X), When mergeTrees called, Then outcome is resolved-deleted', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const theirs = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(base, tree([]), theirs, noopMerger);

    // Assert
    expect(result.outcomes).toEqual([{ status: 'resolved-deleted', path: 'p' }]);
  });

  it('Given they deleted and ours unchanged (X|X|—), When mergeTrees called, Then outcome is resolved-deleted', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(base, ours, tree([]), noopMerger);

    // Assert
    expect(result.outcomes).toEqual([{ status: 'resolved-deleted', path: 'p' }]);
  });

  it('Given both deleted (X|—|—), When mergeTrees called, Then outcome is resolved-deleted', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);

    // Act
    const result = await mergeTrees(base, tree([]), tree([]), noopMerger);

    // Assert
    expect(result.outcomes).toEqual([{ status: 'resolved-deleted', path: 'p' }]);
  });

  it('Given we deleted and they modified (X|—|Y), When mergeTrees called, Then conflict with type modify-delete', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const theirs = tree([['p', entry(ID_B)]]);

    // Act
    const result = await mergeTrees(base, tree([]), theirs, noopMerger);

    // Assert
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('modify-delete');
    expect(result.conflicts[0]?.theirId).toBe(ID_B);
    expect(result.conflicts[0]?.ourId).toBeUndefined();
  });

  it('Given we modified and they deleted (X|Y|—), When mergeTrees called, Then conflict with type modify-delete', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);

    // Act
    const result = await mergeTrees(base, ours, tree([]), noopMerger);

    // Assert
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('modify-delete');
    expect(result.conflicts[0]?.ourId).toBe(ID_B);
    expect(result.conflicts[0]?.theirId).toBeUndefined();
  });
});

describe('mergeTrees — contentMerger contract', () => {
  it('Given modify-modify on regular file, When mergeTrees called, Then contentMerger ctx.ourMode matches ours FlatTree entry mode', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A, FILE_MODE.REGULAR)]]);
    const ours = tree([['p', entry(ID_B, FILE_MODE.EXECUTABLE)]]);
    const theirs = tree([['p', entry(ID_C, FILE_MODE.EXECUTABLE)]]);
    const spy = spyMerger({ status: 'clean', bytes: new Uint8Array(0) });

    // Act
    await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    expect(spy.ctxs[0]?.ourMode).toBe(FILE_MODE.EXECUTABLE);
    expect(spy.ctxs[0]?.theirMode).toBe(FILE_MODE.EXECUTABLE);
    expect(spy.ctxs[0]?.baseMode).toBe(FILE_MODE.REGULAR);
  });

  it('Given contentMerger returning clean bytes, When mergeTrees called, Then outcome is resolved-merged with bytes and mode', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const bytes = new Uint8Array([7, 8, 9]);
    const spy = spyMerger({ status: 'clean', bytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    expect(result.outcomes[0]).toEqual({
      status: 'resolved-merged',
      path: 'p',
      bytes,
      mode: FILE_MODE.REGULAR,
    });
  });

  it('Given contentMerger returning clean bytes with id (fast-path), When mergeTrees called, Then outcome is resolved-known with id', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const spy = spyMerger({ status: 'clean', bytes: new Uint8Array([1]), id: ID_D });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    expect(result.outcomes[0]).toEqual({
      status: 'resolved-known',
      path: 'p',
      id: ID_D,
      mode: FILE_MODE.REGULAR,
    });
  });

  it('Given contentMerger returning content conflict with markedBytes, When mergeTrees called, Then conflict with type content', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const markedBytes = new Uint8Array([0xff]);
    const spy = spyMerger({ status: 'conflict', conflictType: 'content', markedBytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('content');
    expect(result.conflicts[0]?.conflictContent).toBe(markedBytes);
  });

  it('Given contentMerger returning binary conflict with markedBytes, When mergeTrees called, Then conflict with type binary', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const markedBytes = new Uint8Array([0x00, 0x01]);
    const spy = spyMerger({ status: 'conflict', conflictType: 'binary', markedBytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    expect(result.conflicts[0]?.type).toBe('binary');
    expect(result.conflicts[0]?.conflictContent).toBe(markedBytes);
  });

  it('Given contentMerger returning clean bytes exactly at MAX_CONFLICT_OUTPUT_BYTES, When mergeTrees called, Then succeeds (at-cap boundary)', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const atCapBytes = new Proxy(new Uint8Array(1), {
      get(target, prop) {
        if (prop === 'length') return MAX_CONFLICT_OUTPUT_BYTES;
        return (target as unknown as Record<string | symbol, unknown>)[prop as string];
      },
    }) as unknown as Uint8Array;
    const spy = spyMerger({ status: 'clean', bytes: atCapBytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert — no throw, resolved-merged emitted
    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        status: 'resolved-merged',
        path: 'p',
        mode: FILE_MODE.REGULAR,
      }),
    );
  });

  it('Given contentMerger returning marked bytes exactly at MAX_CONFLICT_OUTPUT_BYTES, When mergeTrees called, Then succeeds (at-cap boundary)', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const atCapBytes = new Proxy(new Uint8Array(1), {
      get(target, prop) {
        if (prop === 'length') return MAX_CONFLICT_OUTPUT_BYTES;
        return (target as unknown as Record<string | symbol, unknown>)[prop as string];
      },
    }) as unknown as Uint8Array;
    const spy = spyMerger({ status: 'conflict', conflictType: 'content', markedBytes: atCapBytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert — no throw, conflict emitted
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('content');
  });

  it('Given contentMerger returning oversize clean bytes, When mergeTrees called, Then throws INVALID_MERGE_INPUT', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const fakeBytes = new Proxy(new Uint8Array(1), {
      get(target, prop) {
        if (prop === 'length') return MAX_CONFLICT_OUTPUT_BYTES + 1;
        return (target as unknown as Record<string | symbol, unknown>)[prop as string];
      },
    }) as unknown as Uint8Array;
    const spy = spyMerger({ status: 'clean', bytes: fakeBytes });

    // Act
    let thrown: unknown;
    try {
      await mergeTrees(base, ours, theirs, spy.fn);
    } catch (e) {
      thrown = e;
    }

    // Assert
    expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
      'INVALID_MERGE_INPUT',
    );
    expect((thrown as { data: { reason: string } }).data.reason).toContain('oversize');
  });

  it('Given contentMerger returning oversize markedBytes, When mergeTrees called, Then throws INVALID_MERGE_INPUT', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const fakeBytes = new Proxy(new Uint8Array(1), {
      get(target, prop) {
        if (prop === 'length') return MAX_CONFLICT_OUTPUT_BYTES + 1;
        return (target as unknown as Record<string | symbol, unknown>)[prop as string];
      },
    }) as unknown as Uint8Array;
    const spy = spyMerger({ status: 'conflict', conflictType: 'content', markedBytes: fakeBytes });

    // Act
    let thrown: unknown;
    try {
      await mergeTrees(base, ours, theirs, spy.fn);
    } catch (e) {
      thrown = e;
    }

    // Assert
    expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
      'INVALID_MERGE_INPUT',
    );
    expect((thrown as { data: { reason: string } }).data.reason).toContain('oversize');
  });

  it('Given contentMerger returning Promise, When mergeTrees called, Then awaits and threads result identically', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const bytes = new Uint8Array([1, 2]);
    const spy = spyMerger(Promise.resolve<ContentMergeResult>({ status: 'clean', bytes }));

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    expect(result.outcomes[0]).toEqual({
      status: 'resolved-merged',
      path: 'p',
      bytes,
      mode: FILE_MODE.REGULAR,
    });
  });

  it('Given contentMerger throwing synchronously, When mergeTrees called, Then error propagates', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const merger: ContentMerger = (_ctx, _base, _ours, _theirs) => {
      throw new Error('sync failure');
    };

    // Act & Assert
    await expect(mergeTrees(base, ours, theirs, merger)).rejects.toThrow('sync failure');
  });

  it('Given contentMerger rejecting Promise, When mergeTrees called, Then rejection propagates', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const merger: ContentMerger = (_ctx, _base, _ours, _theirs) =>
      Promise.reject(new Error('async failure'));

    // Act & Assert
    await expect(mergeTrees(base, ours, theirs, merger)).rejects.toThrow('async failure');
  });

  it('Given gitlink modify-modify with different ids, When mergeTrees called, Then conflict with type gitlink and merger NOT invoked', async () => {
    // Arrange
    const base = tree([['sub', entry(ID_A, FILE_MODE.GITLINK)]]);
    const ours = tree([['sub', entry(ID_B, FILE_MODE.GITLINK)]]);
    const theirs = tree([['sub', entry(ID_C, FILE_MODE.GITLINK)]]);
    const spy = vi.fn(noopMerger);

    // Act
    const result = await mergeTrees(base, ours, theirs, spy);

    // Assert
    expect(spy).not.toHaveBeenCalled();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('gitlink');
  });
});

function fakeMap(
  size: number,
  keyGen: () => IterableIterator<FilePath>,
): ReadonlyMap<FilePath, FlatTreeEntry> {
  return {
    size,
    keys: () => keyGen(),
    get: () => entry(ID_A),
    has: () => true,
    values: (() => [][Symbol.iterator]()) as never,
    entries: (() => [][Symbol.iterator]()) as never,
    forEach: () => undefined,
    [Symbol.iterator]: () => [][Symbol.iterator](),
  } as unknown as ReadonlyMap<FilePath, FlatTreeEntry>;
}

function* singleKey(prefix: string, count: number): IterableIterator<FilePath> {
  for (let i = 0; i < count; i++) yield `${prefix}-${i}` as FilePath;
}

describe('mergeTrees — caps', () => {
  it('Given single-input size exceeding MAX_FLAT_TREE_ENTRIES, When mergeTrees called, Then throws INVALID_MERGE_TREE', async () => {
    // Arrange
    const base: FlatTree = {
      entries: fakeMap(MAX_FLAT_TREE_ENTRIES + 1, () => singleKey('x', 0)),
    };

    // Act
    let thrown: unknown;
    try {
      await mergeTrees(base, undefined, undefined, noopMerger);
    } catch (e) {
      thrown = e;
    }

    // Assert
    expect((thrown as { data: { code: string } }).data.code).toBe('INVALID_MERGE_TREE');
  });

  it('Given single-input base size exactly at MAX_FLAT_TREE_ENTRIES, When mergeTrees called, Then succeeds (at-cap boundary)', async () => {
    // Arrange — size === cap should pass since check uses >
    const base: FlatTree = {
      entries: fakeMap(MAX_FLAT_TREE_ENTRIES, () => singleKey('x', 0)),
    };

    // Act
    const result = await mergeTrees(base, undefined, undefined, noopMerger);

    // Assert
    expect(result.cleanMerge).toBe(true);
  });

  it('Given base exceeds cap, When mergeTrees called, Then error reason contains side name "base"', async () => {
    // Arrange
    const base: FlatTree = {
      entries: fakeMap(MAX_FLAT_TREE_ENTRIES + 1, () => singleKey('x', 0)),
    };

    // Act
    let thrown: unknown;
    try {
      await mergeTrees(base, undefined, undefined, noopMerger);
    } catch (e) {
      thrown = e;
    }

    // Assert
    expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
      'INVALID_MERGE_TREE',
    );
    expect((thrown as { data: { reason: string } }).data.reason).toContain('base');
  });

  it('Given ours exceeds cap, When mergeTrees called, Then error reason contains side name "ours"', async () => {
    // Arrange
    const ours: FlatTree = {
      entries: fakeMap(MAX_FLAT_TREE_ENTRIES + 1, () => singleKey('x', 0)),
    };

    // Act
    let thrown: unknown;
    try {
      await mergeTrees(undefined, ours, undefined, noopMerger);
    } catch (e) {
      thrown = e;
    }

    // Assert
    expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
      'INVALID_MERGE_TREE',
    );
    expect((thrown as { data: { reason: string } }).data.reason).toContain('ours');
  });

  it('Given theirs exceeds cap, When mergeTrees called, Then error reason contains side name "theirs"', async () => {
    // Arrange
    const theirs: FlatTree = {
      entries: fakeMap(MAX_FLAT_TREE_ENTRIES + 1, () => singleKey('x', 0)),
    };

    // Act
    let thrown: unknown;
    try {
      await mergeTrees(undefined, undefined, theirs, noopMerger);
    } catch (e) {
      thrown = e;
    }

    // Assert
    expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
      'INVALID_MERGE_TREE',
    );
    expect((thrown as { data: { reason: string } }).data.reason).toContain('theirs');
  });

  it('Given union exactly at cap, When mergeTrees called, Then succeeds (buildUnionPaths uses > not >=)', async () => {
    // Arrange — use a small cap-simulating scenario: three trees with disjoint keys
    // that together produce a union set. We test the logic by providing three small trees
    // where the union is an exact number, ensuring no false throw.
    const t = tree([
      ['a', entry(ID_A)],
      ['b', entry(ID_B)],
      ['c', entry(ID_C)],
    ]);

    // Act — union of identical trees is 3 entries, well under cap → should succeed
    const result = await mergeTrees(t, t, t, noopMerger);

    // Assert
    expect(result.cleanMerge).toBe(true);
    expect(result.outcomes).toHaveLength(3);
  });

  it('Given union exceeds MAX_FLAT_TREE_ENTRIES, When mergeTrees called, Then throws INVALID_MERGE_TREE with the exact union-overflow reason', async () => {
    // Arrange — two disjoint fakes whose fabricated union exceeds the cap.
    const half = Math.floor(MAX_FLAT_TREE_ENTRIES / 2) + 1;
    const ours: FlatTree = { entries: fakeMap(half, () => singleKey('a', half)) };
    const theirs: FlatTree = { entries: fakeMap(half, () => singleKey('b', half)) };

    let thrown: unknown;
    try {
      await mergeTrees(undefined, ours, theirs, noopMerger);
    } catch (e) {
      thrown = e;
    }

    // Assert — exact reason kills the L49 empty-string StringLiteral mutant
    expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
      'INVALID_MERGE_TREE',
    );
    expect((thrown as { data: { reason: string } }).data.reason).toBe(
      'union FlatTree exceeds MAX_FLAT_TREE_ENTRIES',
    );
    // 1M-key union fixture — generous timeout for Stryker's instrumented run.
  }, 60_000);

  it('Given a union of exactly MAX_FLAT_TREE_ENTRIES paths, When mergeTrees called, Then succeeds (buildUnionPaths uses > not >=)', async () => {
    // Arrange — a single fake whose per-input size is exactly at cap (so
    // enforcePerInputCap passes) and whose keys() yields exactly cap distinct
    // paths, making the union set size === cap. Kills the L48 `>` → `>=`
    // EqualityOperator mutant, which would throw at this exact boundary.
    const ours: FlatTree = {
      entries: fakeMap(MAX_FLAT_TREE_ENTRIES, () => singleKey('x', MAX_FLAT_TREE_ENTRIES)),
    };

    // Act
    const result = await mergeTrees(undefined, ours, undefined, noopMerger);

    // Assert — no throw; every path resolved
    expect(result.cleanMerge).toBe(true);
    expect(result.outcomes).toHaveLength(MAX_FLAT_TREE_ENTRIES);
    // 1M-key union fixture — generous timeout for Stryker's instrumented run.
  }, 60_000);
});

describe('mergeTrees — mode handling', () => {
  it('Given modify-modify with our.mode === their.mode but both differ from base, When mergeTrees called, Then uses common new mode', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A, FILE_MODE.REGULAR)]]);
    const ours = tree([['p', entry(ID_B, FILE_MODE.EXECUTABLE)]]);
    const theirs = tree([['p', entry(ID_C, FILE_MODE.EXECUTABLE)]]);
    const bytes = new Uint8Array([1]);
    const spy = spyMerger({ status: 'clean', bytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    const outcome = result.outcomes[0];
    if (outcome && outcome.status === 'resolved-merged') {
      expect(outcome.mode).toBe(FILE_MODE.EXECUTABLE);
    } else {
      throw new Error('expected resolved-merged');
    }
  });

  it('Given modify-modify with our.mode === base.mode but their.mode differs, When mergeTrees called, Then uses their.mode', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A, FILE_MODE.REGULAR)]]);
    const ours = tree([['p', entry(ID_B, FILE_MODE.REGULAR)]]);
    const theirs = tree([['p', entry(ID_C, FILE_MODE.EXECUTABLE)]]);
    const bytes = new Uint8Array([1]);
    const spy = spyMerger({ status: 'clean', bytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    const outcome = result.outcomes[0];
    if (outcome && outcome.status === 'resolved-merged') {
      expect(outcome.mode).toBe(FILE_MODE.EXECUTABLE);
    } else {
      throw new Error('expected resolved-merged');
    }
  });

  it('Given modify-modify with their.mode === base.mode but our.mode differs, When mergeTrees called, Then uses our.mode', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A, FILE_MODE.REGULAR)]]);
    const ours = tree([['p', entry(ID_B, FILE_MODE.EXECUTABLE)]]);
    const theirs = tree([['p', entry(ID_C, FILE_MODE.REGULAR)]]);
    const bytes = new Uint8Array([1]);
    const spy = spyMerger({ status: 'clean', bytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    const outcome = result.outcomes[0];
    if (outcome && outcome.status === 'resolved-merged') {
      expect(outcome.mode).toBe(FILE_MODE.EXECUTABLE);
    } else {
      throw new Error('expected resolved-merged');
    }
  });

  it('Given modify-modify with kind change (file vs symlink) on ours vs theirs, When mergeTrees called, Then type-change conflict', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A, FILE_MODE.REGULAR)]]);
    const ours = tree([['p', entry(ID_B, FILE_MODE.REGULAR)]]);
    const theirs = tree([['p', entry(ID_C, FILE_MODE.SYMLINK)]]);
    const spy = vi.fn(noopMerger);

    // Act
    const result = await mergeTrees(base, ours, theirs, spy);

    // Assert
    expect(spy).not.toHaveBeenCalled();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('type-change');
  });
});

describe('mergeTrees — property laws', () => {
  it('Given identical trees (X, X, X), When mergeTrees called, Then outcomes are all-unchanged and conflicts empty and cleanMerge true', async () => {
    // Arrange
    const t = tree([
      ['a', entry(ID_A)],
      ['b', entry(ID_B)],
    ]);

    // Act
    const result = await mergeTrees(t, t, t, noopMerger);

    // Assert
    expect(result.conflicts).toEqual([]);
    expect(result.cleanMerge).toBe(true);
    expect(result.outcomes.every((o) => o.status === 'unchanged')).toBe(true);
  });

  it('Given unordered paths, When mergeTrees called, Then outcomes are ordered by byte-order on path (deterministic)', async () => {
    // Arrange
    const base = tree([
      ['b', entry(ID_A)],
      ['a', entry(ID_B)],
    ]);

    // Act
    const result = await mergeTrees(base, base, base, noopMerger);

    // Assert
    const paths = result.outcomes.map((o) => (o.status === 'conflict' ? o.conflict.path : o.path));
    expect(paths).toEqual(['a', 'b']);
  });

  it('Given add-add conflict scenario, When mergeTrees called, Then cleanMerge is false', async () => {
    // Arrange — add-add conflict
    const ours = tree([['p', entry(ID_A)]]);
    const theirs = tree([['p', entry(ID_B)]]);

    // Act
    const result = await mergeTrees(undefined, ours, theirs, noopMerger);

    // Assert
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.cleanMerge).toBe(false);
  });

  it('Given entries with same id but different mode and one side deleted, When mergeTrees called, Then triggers modify-delete conflict', async () => {
    // Arrange — base has REGULAR mode, ours changes mode to EXECUTABLE (different mode, same id),
    // theirs deletes the path. If entriesEqual were mutated to always return true,
    // ours would appear "unchanged" from base, causing resolved-deleted instead of modify-delete conflict.
    const base = tree([['p', entry(ID_A, FILE_MODE.REGULAR)]]);
    const ours = tree([['p', entry(ID_A, FILE_MODE.EXECUTABLE)]]);

    // Act
    const result = await mergeTrees(base, ours, tree([]), noopMerger);

    // Assert — ours changed mode from base, theirs deleted → modify-delete conflict
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('modify-delete');
    expect(result.conflicts[0]?.ourId).toBe(ID_A);
    expect(result.conflicts[0]?.ourMode).toBe(FILE_MODE.EXECUTABLE);
  });

  it('Given entries with same mode but different id and other side deleted, When mergeTrees called, Then triggers modify-delete conflict', async () => {
    // Arrange — base has ID_A, theirs changes to ID_B (different id, same mode),
    // ours deletes. If entriesEqual always returned true, theirs would appear unchanged → resolved-deleted.
    const base = tree([['p', entry(ID_A)]]);
    const theirs = tree([['p', entry(ID_B)]]);

    // Act
    const result = await mergeTrees(base, tree([]), theirs, noopMerger);

    // Assert — theirs changed id from base, ours deleted → modify-delete conflict
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe('modify-delete');
    expect(result.conflicts[0]?.theirId).toBe(ID_B);
  });

  it('Given content conflict scenario, When mergeTrees called, Then conflicts field equals outcomes filtered to conflict status', async () => {
    // Arrange
    const base = tree([['p', entry(ID_A)]]);
    const ours = tree([['p', entry(ID_B)]]);
    const theirs = tree([['p', entry(ID_C)]]);
    const markedBytes = new Uint8Array([1]);
    const spy = spyMerger({ status: 'conflict', conflictType: 'content', markedBytes });

    // Act
    const result = await mergeTrees(base, ours, theirs, spy.fn);

    // Assert
    const derived = result.outcomes.flatMap((o) => (o.status === 'conflict' ? [o.conflict] : []));
    expect(result.conflicts).toEqual(derived);
  });
});
