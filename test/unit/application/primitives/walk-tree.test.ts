import { describe, expect, it } from 'vitest';
import type { WalkTreeEntry as WTE } from '../../../../src/application/primitives/types.js';
import { walkTree } from '../../../../src/application/primitives/walk-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { Blob, FileMode, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

async function collect(iter: AsyncIterable<WTE>): Promise<WTE[]> {
  const out: WTE[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('walkTree', () => {
  it('Given an empty tree, When walkTree is iterated, Then yields nothing', async () => {
    const ctx = await buildSeededContext();
    const id = await writeTree(ctx, []);
    const out = await collect(walkTree(ctx, id));
    expect(out).toEqual([]);
  });

  it('Given a flat tree with 2 blobs, When walkTree is iterated, Then yields 2 entries in byte-order', async () => {
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const b2 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([2]),
      id: '' as ObjectId,
    } satisfies Blob);
    const entries: TreeEntry[] = [
      { name: 'a', mode: '100644' as FileMode, id: b1 },
      { name: 'b', mode: '100644' as FileMode, id: b2 },
    ];
    const id = await writeTree(ctx, entries);
    const out = await collect(walkTree(ctx, id));
    expect(out.map((e) => e.path)).toEqual(['a', 'b']);
  });

  it('Given recursive=false, When walkTree is iterated over a nested tree, Then only top-level entries are yielded', async () => {
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const subId = await writeTree(ctx, [{ name: 'inner', mode: '100644' as FileMode, id: b1 }]);
    const rootId = await writeTree(ctx, [{ name: 'sub', mode: '040000' as FileMode, id: subId }]);
    const out = await collect(walkTree(ctx, rootId, { recursive: false }));
    expect(out.length).toBe(1);
    expect(out[0]?.path).toBe('sub');
  });

  it('Given maxEntries=2 and a 3-entry tree, When walkTree is iterated, Then throws TREE_ENTRY_LIMIT_EXCEEDED (just-over)', async () => {
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const entries: TreeEntry[] = [
      { name: 'a', mode: '100644' as FileMode, id: b1 },
      { name: 'b', mode: '100644' as FileMode, id: b1 },
      { name: 'c', mode: '100644' as FileMode, id: b1 },
    ];
    const id = await writeTree(ctx, entries);
    try {
      await collect(walkTree(ctx, id, { maxEntries: 2 }));
      expect.unreachable();
    } catch (error) {
      const code = (error as { data: { code: string } }).data.code;
      expect(code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
    }
  });

  it('Given maxEntries=3 and a 3-entry tree (at cap), When walkTree is iterated, Then all entries are yielded', async () => {
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const entries: TreeEntry[] = [
      { name: 'a', mode: '100644' as FileMode, id: b1 },
      { name: 'b', mode: '100644' as FileMode, id: b1 },
      { name: 'c', mode: '100644' as FileMode, id: b1 },
    ];
    const id = await writeTree(ctx, entries);
    const out = await collect(walkTree(ctx, id, { maxEntries: 3 }));
    expect(out.length).toBe(3);
  });

  it('Given a gitlink whose id points to a real tree, When walkTree is iterated, Then the tree is NOT recursed into (gitlink guard fires)', async () => {
    // Kills the `if (isGitlink(mode)) return false` guards: under the mutation
    // the walker would recurse into the subtree and yield its inner entries.
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([7]),
      id: '' as ObjectId,
    } satisfies Blob);
    const subTreeId = await writeTree(ctx, [{ name: 'inner', mode: '100644' as FileMode, id: b1 }]);
    // The gitlink entry points at a real tree id — a mutated isGitlink guard
    // would cause walkTree to recurse and yield 'sub/inner'.
    const rootId = await writeTree(ctx, [
      { name: 'sub', mode: '160000' as FileMode, id: subTreeId },
    ]);
    const out = await collect(walkTree(ctx, rootId));
    expect(out.map((e) => e.path)).toEqual(['sub']);
  });

  it('Given a tree containing a gitlink (mode 160000), When walkTree is iterated, Then gitlink entry is yielded but NOT recursed', async () => {
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const id = await writeTree(ctx, [{ name: 'submodule', mode: '160000' as FileMode, id: b1 }]);
    const out = await collect(walkTree(ctx, id));
    expect(out.length).toBe(1);
    expect(out[0]?.mode).toBe('160000');
  });

  it('Given an aborted signal before walkTree starts, When iterated, Then throws OPERATION_ABORTED', async () => {
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const id = await writeTree(ctx, [{ name: 'a', mode: '100644' as FileMode, id: b1 }]);
    const controller = new AbortController();
    controller.abort();
    const aborted = { ...ctx, signal: controller.signal };
    try {
      await collect(walkTree(aborted, id));
      expect.unreachable();
    } catch (error) {
      const code = (error as { data: { code: string } }).data.code;
      expect(code).toBe('OPERATION_ABORTED');
    }
  });

  it('Given a default walkTree call on a nested tree, When iterated, Then recurses (default recursive=true)', async () => {
    // Kills the `options?.recursive ?? true` BooleanLiteral mutant: flipping
    // the default to `false` would skip the sub-tree.
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const subId = await writeTree(ctx, [{ name: 'inner', mode: '100644' as FileMode, id: b1 }]);
    const rootId = await writeTree(ctx, [{ name: 'sub', mode: '040000' as FileMode, id: subId }]);
    const out = await collect(walkTree(ctx, rootId));
    expect(out.map((e) => e.path)).toEqual(['sub', 'sub/inner']);
  });

  it('Given a caller-supplied Tree object whose sub-entry resolves back to it, When walkTree iterates, Then throws TREE_CYCLE_DETECTED', async () => {
    // Kills the `stack.includes(tree.id)` guard mutant.
    // Cryptographic hashes prevent a legitimate self-referential tree from
    // ever existing on disk. Instead we pass a Tree object directly (walkTree
    // accepts `ObjectId | Tree`), craft one whose entry resolves — via
    // readObject — to a genuine tree whose id matches the impostor's. Then
    // the recursive walkInternal call sees `stack.includes(tree.id)` fire.
    const ctx = await buildSeededContext();
    const realTreeId = await writeTree(ctx, []);
    const syntheticRoot = {
      type: 'tree' as const,
      id: realTreeId, // matches what readObject will return for the entry's id
      entries: [{ name: 'loop', mode: '40000' as FileMode, id: realTreeId }],
    };
    try {
      for await (const _ of walkTree(ctx, syntheticRoot, { recursive: true })) void _;
      expect.unreachable();
    } catch (error) {
      const code = (error as { data: { code: string } }).data.code;
      expect(code).toBe('TREE_CYCLE_DETECTED');
    }
  });

  it('Given maxDepth=1 and a 2-level nested tree, When walkTree is iterated, Then throws TREE_DEPTH_EXCEEDED', async () => {
    // Kills the exceedsMaxTreeDepth guard mutants.
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const leafId = await writeTree(ctx, [{ name: 'leaf', mode: '100644' as FileMode, id: b1 }]);
    const midId = await writeTree(ctx, [{ name: 'mid', mode: '040000' as FileMode, id: leafId }]);
    const rootId = await writeTree(ctx, [{ name: 'root', mode: '040000' as FileMode, id: midId }]);
    try {
      await collect(walkTree(ctx, rootId, { maxDepth: 1 }));
      expect.unreachable();
    } catch (error) {
      const code = (error as { data: { code: string } }).data.code;
      expect(code).toBe('TREE_DEPTH_EXCEEDED');
    }
  });

  it('Given a signal aborted mid-walk (after first yield), When walkTree continues, Then throws OPERATION_ABORTED', async () => {
    // Kills the per-entry signal check inside walkInternal.
    const ctx = await buildSeededContext();
    const b1 = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    const entries: TreeEntry[] = [
      { name: 'a', mode: '100644' as FileMode, id: b1 },
      { name: 'b', mode: '100644' as FileMode, id: b1 },
    ];
    const id = await writeTree(ctx, entries);
    const controller = new AbortController();
    const aborted = { ...ctx, signal: controller.signal };
    try {
      const out: WTE[] = [];
      for await (const e of walkTree(aborted, id)) {
        out.push(e);
        // Abort AFTER the first entry is yielded.
        controller.abort();
      }
      expect.unreachable();
    } catch (error) {
      const code = (error as { data: { code: string } }).data.code;
      expect(code).toBe('OPERATION_ABORTED');
    }
  });

  it('Given a non-tree id (blob), When walkTree is called, Then throws UNEXPECTED_OBJECT_TYPE', async () => {
    const ctx = await buildSeededContext();
    const blobId = await writeObject(ctx, {
      type: 'blob',
      content: new Uint8Array([1]),
      id: '' as ObjectId,
    } satisfies Blob);
    try {
      await collect(walkTree(ctx, blobId));
      expect.unreachable();
    } catch (error) {
      const code = (error as { data: { code: string } }).data.code;
      expect(code).toBe('UNEXPECTED_OBJECT_TYPE');
    }
  });
});
