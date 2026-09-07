import { describe, expect, it } from 'vitest';
import type { WalkTreeEntry as WTE } from '../../../../src/application/primitives/types.js';
import { walkTree } from '../../../../src/application/primitives/walk-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { DEFAULT_MAX_TREE_DEPTH } from '../../../../src/domain/diff/flat-tree.js';
import {
  concatBytes,
  decodePreservingBom,
  encode,
} from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  Blob,
  FileMode,
  FilePath,
  ObjectId,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { PACK_NAME_HASH_V1, packNameHash } from '../../../../src/domain/storage/pack-name-hash.js';
import { buildSeededContext, buildTreeChain, seedMaxTreeDepth } from './fixtures.js';

async function collect(iter: AsyncIterable<WTE>): Promise<WTE[]> {
  const out: WTE[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('walkTree', () => {
  describe('Given an empty tree', () => {
    describe('When walkTree is iterated', () => {
      it('Then yields nothing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeTree(ctx, []);
        // Act
        const out = await collect(walkTree(ctx, id));
        // Assert
        expect(out).toEqual([]);
      });
    });
  });

  describe('Given a flat tree with 2 blobs', () => {
    describe('When walkTree is iterated', () => {
      it('Then yields 2 entries in byte-order', async () => {
        // Arrange
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
          treeEntry('100644' as FileMode, 'a', b1),
          treeEntry('100644' as FileMode, 'b', b2),
        ];
        const id = await writeTree(ctx, entries);
        // Act
        const out = await collect(walkTree(ctx, id));
        // Assert
        expect(out.map((e) => e.path)).toEqual(['a', 'b']);
      });
    });
  });

  describe('Given recursive=false', () => {
    describe('When walkTree is iterated over a nested tree', () => {
      it('Then only top-level entries are yielded', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const subId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'inner', b1)]);
        const rootId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'sub', subId)]);
        // Act
        const out = await collect(walkTree(ctx, rootId, { recursive: false }));
        // Assert
        expect(out.length).toBe(1);
        expect(out[0]?.path).toBe('sub');
      });
    });
  });

  describe('Given maxEntries=2 and a 3-entry tree', () => {
    describe('When walkTree is iterated', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED (just-over)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const entries: TreeEntry[] = [
          treeEntry('100644' as FileMode, 'a', b1),
          treeEntry('100644' as FileMode, 'b', b1),
          treeEntry('100644' as FileMode, 'c', b1),
        ];
        const id = await writeTree(ctx, entries);
        // Act + Assert
        try {
          await collect(walkTree(ctx, id, { maxEntries: 2 }));
          expect.unreachable();
        } catch (error) {
          const code = (error as { data: { code: string } }).data.code;
          expect(code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
        }
      });
    });
  });

  describe('Given maxEntries=3 and a 3-entry tree (at cap)', () => {
    describe('When walkTree is iterated', () => {
      it('Then all entries are yielded', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const entries: TreeEntry[] = [
          treeEntry('100644' as FileMode, 'a', b1),
          treeEntry('100644' as FileMode, 'b', b1),
          treeEntry('100644' as FileMode, 'c', b1),
        ];
        const id = await writeTree(ctx, entries);
        // Act
        const out = await collect(walkTree(ctx, id, { maxEntries: 3 }));
        // Assert
        expect(out.length).toBe(3);
      });
    });
  });

  describe('Given a gitlink whose id points to a real tree', () => {
    describe('When walkTree is iterated', () => {
      it('Then the tree is NOT recursed into (gitlink guard fires)', async () => {
        // Arrange
        // Kills the `if (isGitlink(mode)) return false` guards: under the mutation
        // the walker would recurse into the subtree and yield its inner entries.
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([7]),
          id: '' as ObjectId,
        } satisfies Blob);
        const subTreeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'inner', b1)]);
        // The gitlink entry points at a real tree id — a mutated isGitlink guard
        // would cause walkTree to recurse and yield 'sub/inner'.
        const rootId = await writeTree(ctx, [treeEntry('160000' as FileMode, 'sub', subTreeId)]);
        // Act
        const out = await collect(walkTree(ctx, rootId));
        // Assert
        expect(out.map((e) => e.path)).toEqual(['sub']);
      });
    });
  });

  describe('Given a tree containing a gitlink (mode 160000)', () => {
    describe('When walkTree is iterated', () => {
      it('Then gitlink entry is yielded but NOT recursed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const id = await writeTree(ctx, [treeEntry('160000' as FileMode, 'submodule', b1)]);
        // Act
        const out = await collect(walkTree(ctx, id));
        // Assert
        expect(out.length).toBe(1);
        expect(out[0]?.mode).toBe('160000');
      });
    });
  });

  describe('Given an aborted signal before walkTree starts', () => {
    describe('When iterated', () => {
      it('Then throws OPERATION_ABORTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const id = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a', b1)]);
        const controller = new AbortController();
        controller.abort();
        const aborted = { ...ctx, signal: controller.signal };
        // Act + Assert
        try {
          await collect(walkTree(aborted, id));
          expect.unreachable();
        } catch (error) {
          const code = (error as { data: { code: string } }).data.code;
          expect(code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });

  describe('Given a default walkTree call on a nested tree', () => {
    describe('When iterated', () => {
      it('Then recurses (default recursive=true)', async () => {
        // Arrange
        // Kills the `options?.recursive ?? true` BooleanLiteral mutant: flipping
        // the default to `false` would skip the sub-tree.
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const subId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'inner', b1)]);
        const rootId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'sub', subId)]);
        // Act
        const out = await collect(walkTree(ctx, rootId));
        // Assert
        expect(out.map((e) => e.path)).toEqual(['sub', 'sub/inner']);
      });
    });
  });

  describe('Given a caller-supplied Tree object whose sub-entry resolves back to it', () => {
    describe('When walkTree iterates', () => {
      it('Then throws TREE_CYCLE_DETECTED', async () => {
        // Arrange
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
          entries: [treeEntry('40000' as FileMode, 'loop', realTreeId)],
        };

        // Act + Assert
        try {
          for await (const _ of walkTree(ctx, syntheticRoot, { recursive: true })) void _;
          expect.unreachable();
        } catch (error) {
          const code = (error as { data: { code: string } }).data.code;
          expect(code).toBe('TREE_CYCLE_DETECTED');
        }
      });
    });
  });

  describe('Given maxDepth=1 and a 2-level nested tree', () => {
    describe('When walkTree is iterated', () => {
      it('Then throws TREE_DEPTH_EXCEEDED', async () => {
        // Arrange
        // Kills the exceedsMaxTreeDepth guard mutants.
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const leafId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'leaf', b1)]);
        const midId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'mid', leafId)]);
        const rootId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'root', midId)]);
        // Act + Assert
        try {
          await collect(walkTree(ctx, rootId, { maxDepth: 1 }));
          expect.unreachable();
        } catch (error) {
          const code = (error as { data: { code: string } }).data.code;
          expect(code).toBe('TREE_DEPTH_EXCEEDED');
        }
      });
    });
  });

  describe('Given a signal aborted mid-walk (after first yield)', () => {
    describe('When walkTree continues', () => {
      it('Then throws OPERATION_ABORTED', async () => {
        // Arrange
        // Kills the per-entry signal check inside walkInternal.
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const entries: TreeEntry[] = [
          treeEntry('100644' as FileMode, 'a', b1),
          treeEntry('100644' as FileMode, 'b', b1),
        ];
        const id = await writeTree(ctx, entries);
        const controller = new AbortController();
        const aborted = { ...ctx, signal: controller.signal };
        // Act + Assert
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
    });
  });

  describe('Given a non-tree id (blob)', () => {
    describe('When walkTree is called', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        // Act + Assert
        try {
          await collect(walkTree(ctx, blobId));
          expect.unreachable();
        } catch (error) {
          const code = (error as { data: { code: string } }).data.code;
          expect(code).toBe('UNEXPECTED_OBJECT_TYPE');
        }
      });
    });
  });

  describe('Given no pathHasher option is supplied', () => {
    describe('When walkTree is iterated', () => {
      it('Then the yielded entry carries exactly path, id and mode — no nameHash key', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const id = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a', b1)]);
        // Act
        const out = await collect(walkTree(ctx, id));
        // Assert
        expect(out[0]).toStrictEqual({ path: 'a', id: b1, mode: '100644' });
      });
    });
  });

  describe('Given a root-level entry', () => {
    describe('When walkTree is iterated with a pathHasher', () => {
      it('Then nameHash folds the bare name, not a leading slash', async () => {
        // Arrange — git's own rule: `if (base->len) strbuf_addch(base, '/')`.
        // A root-level entry hashes 'a', never '/a'.
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const id = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a', b1)]);
        // Act
        const out = await collect(walkTree(ctx, id, { pathHasher: PACK_NAME_HASH_V1 }));
        // Assert
        const withLeadingSlash = packNameHash(concatBytes([encode('/'), encode('a')]));
        expect(out[0]?.nameHash).toBe(packNameHash(encode('a')));
        expect(out[0]?.nameHash).not.toBe(withLeadingSlash);
      });
    });
  });

  describe('Given a tree nested three levels deep', () => {
    describe('When walkTree is iterated with a pathHasher', () => {
      it("Then each entry's nameHash equals packNameHash of its own joined path", async () => {
        // Arrange — deep/er/churn.txt reuses Part 1's own pinned vector row
        // (0x9a8be7c7) as a cross-layer oracle: the walker's per-frame fold
        // must agree with the module it delegates to, not just with itself.
        const ctx = await buildSeededContext();
        const leaf = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const erId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'churn.txt', leaf)]);
        const deepId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'er', erId)]);
        const rootId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'deep', deepId)]);
        // Act
        const out = await collect(walkTree(ctx, rootId, { pathHasher: PACK_NAME_HASH_V1 }));
        // Assert
        const byPath = new Map(out.map((e) => [e.path, e.nameHash]));
        expect(byPath.get('deep' as FilePath)).toBe(packNameHash(encode('deep')));
        expect(byPath.get('deep/er' as FilePath)).toBe(packNameHash(encode('deep/er')));
        expect(byPath.get('deep/er/churn.txt' as FilePath)).toBe(0x9a8be7c7);
        expect(byPath.get('deep/er/churn.txt' as FilePath)).toBe(
          packNameHash(encode('deep/er/churn.txt')),
        );
      });
    });
  });

  describe('Given a tree entry whose name is invalid UTF-8', () => {
    describe('When walkTree is iterated with a pathHasher', () => {
      it('Then nameHash folds the raw name bytes, not the decoded U+FFFD view', async () => {
        // Arrange — 0xFF is not a valid standalone UTF-8 sequence; TreeEntry.name
        // decodes it to U+FFFD (ef bf bd), which hashes to a different value.
        // nameBytes is authoritative and must be what the fold consumes.
        const ctx = await buildSeededContext();
        const leaf = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const id = await writeTree(ctx, [
          treeEntry('100644' as FileMode, Uint8Array.of(0xff), leaf),
        ]);
        // Act
        const out = await collect(walkTree(ctx, id, { pathHasher: PACK_NAME_HASH_V1 }));
        // Assert
        expect(out[0]?.nameHash).toBe(packNameHash(Uint8Array.of(0xff)));
        expect(out[0]?.nameHash).toBe(0xff000000);
        expect(out[0]?.nameHash).not.toBe(packNameHash(encode('�')));
      });
    });
  });

  describe('Given the same blob reachable under two different directory paths', () => {
    describe('When walkTree is iterated with a pathHasher', () => {
      it('Then each occurrence carries its own path-specific nameHash', async () => {
        // Arrange — first-seen dedup is the caller's job (Part 6), not the
        // walker's: it yields per entry, so the same object under two
        // paths is yielded twice, each with its own hash.
        const ctx = await buildSeededContext();
        const shared = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const dir1Id = await writeTree(ctx, [treeEntry('100644' as FileMode, 'file.txt', shared)]);
        const dir2Id = await writeTree(ctx, [treeEntry('100644' as FileMode, 'file.txt', shared)]);
        const rootId = await writeTree(ctx, [
          treeEntry('040000' as FileMode, 'dir1', dir1Id),
          treeEntry('040000' as FileMode, 'dir2', dir2Id),
        ]);
        // Act
        const out = await collect(walkTree(ctx, rootId, { pathHasher: PACK_NAME_HASH_V1 }));
        // Assert
        const blobEntries = out.filter((e) => e.id === shared);
        expect(blobEntries).toHaveLength(2);
        expect(blobEntries[0]?.path).toBe('dir1/file.txt');
        expect(blobEntries[1]?.path).toBe('dir2/file.txt');
        expect(blobEntries[0]?.nameHash).toBe(packNameHash(encode('dir1/file.txt')));
        expect(blobEntries[1]?.nameHash).toBe(packNameHash(encode('dir2/file.txt')));
        expect(blobEntries[0]?.nameHash).not.toBe(blobEntries[1]?.nameHash);
      });
    });
  });

  describe('Given the pathBytes option is not supplied', () => {
    describe('When walkTree is iterated', () => {
      it('Then the yielded entry carries exactly path, id and mode — no pathBytes key', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const id = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a', b1)]);
        // Act
        const out = await collect(walkTree(ctx, id));
        // Assert
        expect(out[0]).toStrictEqual({ path: 'a', id: b1, mode: '100644' });
      });
    });

    describe('When walkTree is iterated with a pathHasher', () => {
      it('Then the fold alone adds nameHash but no pathBytes key', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const id = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a', b1)]);
        // Act
        const out = await collect(walkTree(ctx, id, { pathHasher: PACK_NAME_HASH_V1 }));
        // Assert
        expect(out[0]).toStrictEqual({
          path: 'a',
          id: b1,
          mode: '100644',
          nameHash: packNameHash(encode('a')),
        });
      });
    });
  });

  describe('Given a root-level entry', () => {
    describe('When walkTree is iterated with pathBytes enabled', () => {
      it('Then pathBytes equals nameBytes and is not the same object', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const entry = treeEntry('100644' as FileMode, 'a', b1);
        const id = await writeTree(ctx, [entry]);
        // Act
        const out = await collect(walkTree(ctx, id, { pathBytes: true }));
        // Assert
        expect(out[0]?.pathBytes).toEqual(entry.nameBytes);
        expect(out[0]?.pathBytes).not.toBe(entry.nameBytes);
      });
    });
  });

  describe('Given a tree nested two levels deep', () => {
    describe('When walkTree is iterated with pathBytes enabled', () => {
      it('Then pathBytes joins ancestor name bytes with 0x2f, no trailing separator, and decodes to path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leaf = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const subId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'inner', leaf)]);
        const rootId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'sub', subId)]);
        // Act
        const out = await collect(walkTree(ctx, rootId, { pathBytes: true }));
        const leafEntry = out.find((e) => e.path === 'sub/inner');
        // Assert
        expect(leafEntry?.pathBytes).toEqual(
          concatBytes([encode('sub'), Uint8Array.of(0x2f), encode('inner')]),
        );
        expect(decodePreservingBom(leafEntry!.pathBytes!)).toBe('sub/inner');
      });
    });
  });

  describe('Given two sibling entries whose raw names both decode to the Unicode replacement character', () => {
    describe('When walkTree is iterated with pathBytes enabled', () => {
      it('Then path is equal for both entries but pathBytes differs', async () => {
        // Arrange — 0xFF is not a valid standalone UTF-8 sequence and
        // decodes to U+FFFD; EF BF BD is the exact 3-byte UTF-8 encoding
        // of U+FFFD. Both names display identically through `path`, but
        // only pathBytes — the gap this part closes — tells them apart.
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
        const id = await writeTree(ctx, [
          treeEntry('100644' as FileMode, Uint8Array.of(0xff), b1),
          treeEntry('100644' as FileMode, Uint8Array.of(0xef, 0xbf, 0xbd), b2),
        ]);
        // Act
        const out = await collect(walkTree(ctx, id, { pathBytes: true }));
        // Assert
        expect(out).toHaveLength(2);
        expect(out[0]?.path).toBe(out[1]?.path);
        expect(out[0]?.pathBytes).not.toEqual(out[1]?.pathBytes);
      });
    });
  });

  describe('Given recursive: false', () => {
    describe('When walkTree is iterated over a nested tree with pathBytes enabled', () => {
      it('Then only the root-level entry is yielded, its pathBytes equal to its own nameBytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leaf = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const subId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'inner', leaf)]);
        const entry = treeEntry('040000' as FileMode, 'sub', subId);
        const rootId = await writeTree(ctx, [entry]);
        // Act
        const out = await collect(walkTree(ctx, rootId, { recursive: false, pathBytes: true }));
        // Assert
        expect(out).toHaveLength(1);
        expect(out[0]?.pathBytes).toEqual(entry.nameBytes);
      });
    });
  });

  describe('Given maxDepth=1 and a 2-level nested tree with pathBytes enabled', () => {
    describe('When walkTree is iterated', () => {
      it('Then throws TREE_DEPTH_EXCEEDED and no entry past the refusal is yielded', async () => {
        // Arrange — mirrors the existing maxDepth guard fixture; pathBytes
        // is built in nextFrameEntry, so if the depth guard fired after
        // instead of before, this would build bytes for an entry that
        // must never exist.
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const leafId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'leaf', b1)]);
        const midId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'mid', leafId)]);
        const rootId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'root', midId)]);
        const yielded: WTE[] = [];
        // Act + Assert
        try {
          for await (const e of walkTree(ctx, rootId, { maxDepth: 1, pathBytes: true })) {
            yielded.push(e);
          }
          expect.unreachable();
        } catch (error) {
          const data = (error as { data: { code: string; depth: number } }).data;
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(2);
          expect(yielded.map((e) => e.path)).toEqual(['root', 'root/mid']);
        }
      });
    });
  });

  describe('Given both pathHasher and pathBytes are supplied over a nested tree', () => {
    describe('When walkTree is iterated', () => {
      it("Then every entry's nameHash equals packNameHash of its own pathBytes", async () => {
        // Arrange — the cheapest cross-check of the two mechanisms against
        // each other; catches a fold that silently drifted from the byte
        // path.
        const ctx = await buildSeededContext();
        const leaf = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const erId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'churn.txt', leaf)]);
        const deepId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'er', erId)]);
        const rootId = await writeTree(ctx, [treeEntry('040000' as FileMode, 'deep', deepId)]);
        // Act
        const out = await collect(
          walkTree(ctx, rootId, { pathHasher: PACK_NAME_HASH_V1, pathBytes: true }),
        );
        // Assert
        expect(out.length).toBeGreaterThan(0);
        for (const entry of out) {
          expect(entry.nameHash).toBe(packNameHash(entry.pathBytes!));
        }
      });
    });
  });

  describe('Given a yielded pathBytes entry is mutated in place immediately after being received', () => {
    describe('When the walk continues past it', () => {
      it("Then a later sibling's and a child's pathBytes are unaffected", async () => {
        // Arrange — 'a' is mutated the instant it is received; its own
        // inner entry and its sibling 'b' are built afterward and must
        // not observe the mutation, proving the walker never hands out
        // the same array it keeps for itself.
        const ctx = await buildSeededContext();
        const leaf = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const innerId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'inner', leaf)]);
        const rootId = await writeTree(ctx, [
          treeEntry('040000' as FileMode, 'a', innerId),
          treeEntry('100644' as FileMode, 'b', leaf),
        ]);
        const out: WTE[] = [];
        let mutated = false;
        // Act
        for await (const entry of walkTree(ctx, rootId, { pathBytes: true })) {
          out.push(entry);
          if (!mutated) {
            entry.pathBytes?.fill(0);
            mutated = true;
          }
        }
        // Assert
        const child = out.find((e) => e.path === 'a/inner');
        const sibling = out.find((e) => e.path === 'b');
        expect(child?.pathBytes).toEqual(
          concatBytes([encode('a'), Uint8Array.of(0x2f), encode('inner')]),
        );
        expect(sibling?.pathBytes).toEqual(encode('b'));
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The structural bound at the DEFAULT cap — this is the assertion that
// distinguishes an explicit stack from recursion: before the rewrite,
// walkInternal's own recursion overflows the JS/generator call stack well
// before reaching DEFAULT_MAX_TREE_DEPTH (2048), even though the guard
// itself admits the path.
// ---------------------------------------------------------------------------

describe('Given config unset (default cap) and a tree chain at exactly the default depth', () => {
  describe('When walkTree is iterated', () => {
    it('Then it completes and yields the leaf entry', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const rootId = await buildTreeChain(ctx, DEFAULT_MAX_TREE_DEPTH);
      // Act
      const out = await collect(walkTree(ctx, rootId));
      // Assert
      expect(out).toHaveLength(DEFAULT_MAX_TREE_DEPTH + 1);
      expect(out[out.length - 1]?.mode).toBe(FILE_MODE.REGULAR);
    });
  });
});

describe('Given config unset (default cap) and a tree chain one level past the default depth', () => {
  describe('When walkTree is iterated', () => {
    it('Then throws TREE_DEPTH_EXCEEDED with depth = default cap + 1', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const rootId = await buildTreeChain(ctx, DEFAULT_MAX_TREE_DEPTH + 1);
      // Act + Assert
      try {
        await collect(walkTree(ctx, rootId));
        expect.unreachable();
      } catch (error) {
        const data = (error as { data: { code: string; depth: number } }).data;
        expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data.depth).toBe(DEFAULT_MAX_TREE_DEPTH + 1);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// core.maxTreeDepth configured to a small cap — the guard is reachable at
// any distance past the cap, and the cap value is READ from config, not a
// hardcoded default.
// ---------------------------------------------------------------------------

describe('Given core.maxTreeDepth configured to a negative value', () => {
  describe('When a flat tree is walked', () => {
    it('Then throws TREE_DEPTH_EXCEEDED at depth 0 — the root itself is refused', async () => {
      // Arrange — a negative cap is a valid cap, not "unlimited" and not
      // clamped to zero: `depth > cap` is already true for the root at depth
      // 0, so nothing is walkable. Matches real git, where
      // `-c core.maxTreeDepth=-1 ls-tree -r` refuses a flat tree that
      // `core.maxTreeDepth=0` accepts. Pins the resolver's raw value against
      // any clamp-to-zero.
      const ctx = await buildSeededContext();
      await seedMaxTreeDepth(ctx, '-1');
      const rootId = await buildTreeChain(ctx, 0);

      // Act + Assert
      try {
        await collect(walkTree(ctx, rootId));
        expect.unreachable();
      } catch (error) {
        const data = (error as { data: { code: string; depth: number } }).data;
        expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data.depth).toBe(0);
      }
    });
  });
});

describe('Given core.maxTreeDepth configured to zero', () => {
  describe('When a flat tree is walked', () => {
    it('Then completes — zero permits exactly the top level', async () => {
      // Arrange — the companion to the negative case: cap 0 accepts depth 0,
      // so the two together prove the cap is read as a number, not a switch.
      const ctx = await buildSeededContext();
      await seedMaxTreeDepth(ctx, '0');
      const rootId = await buildTreeChain(ctx, 0);

      // Act
      const out = await collect(walkTree(ctx, rootId));

      // Assert
      expect(out).toHaveLength(1);
    });
  });
});

describe('Given core.maxTreeDepth configured to a small cap', () => {
  const SMALL_CAP = 4;

  describe('When a tree chain is driven exactly at the configured cap', () => {
    it('Then completes and yields the leaf entry (boundary)', async () => {
      // Arrange — the guard is `depth > maxDepth`, so a frame entered at
      // exactly `maxDepth` must NOT raise TREE_DEPTH_EXCEEDED. Pins `>`
      // against `>=` (which would reject this) and against `<` (which
      // would reject every shallower chain too).
      const ctx = await buildSeededContext();
      await seedMaxTreeDepth(ctx, String(SMALL_CAP));
      const rootId = await buildTreeChain(ctx, SMALL_CAP);
      // Act
      const out = await collect(walkTree(ctx, rootId));
      // Assert
      expect(out).toHaveLength(SMALL_CAP + 1);
      expect(out[out.length - 1]?.mode).toBe(FILE_MODE.REGULAR);
    });
  });

  describe('When a tree chain is driven one level past the configured cap', () => {
    it('Then throws TREE_DEPTH_EXCEEDED with depth = cap + 1', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      await seedMaxTreeDepth(ctx, String(SMALL_CAP));
      const rootId = await buildTreeChain(ctx, SMALL_CAP + 1);
      // Act + Assert
      try {
        await collect(walkTree(ctx, rootId));
        expect.unreachable();
      } catch (error) {
        const data = (error as { data: { code: string; depth: number } }).data;
        expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data.depth).toBe(SMALL_CAP + 1);
      }
    });
  });

  describe('When a tree chain is driven far beyond the configured cap (20x)', () => {
    it('Then still throws TREE_DEPTH_EXCEEDED with depth = cap + 1, never a deeper value or a RangeError', async () => {
      // Arrange — proves the guard is reachable (not dead code behind a
      // stack overflow or a runaway loop) at any input size, however far
      // past the cap, and that it reports the boundary depth, not the
      // structural depth of the fixture.
      const ctx = await buildSeededContext();
      await seedMaxTreeDepth(ctx, String(SMALL_CAP));
      const rootId = await buildTreeChain(ctx, SMALL_CAP * 20);
      // Act + Assert
      try {
        await collect(walkTree(ctx, rootId));
        expect.unreachable();
      } catch (error) {
        const data = (error as { data: { code: string; depth: number } }).data;
        expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data.depth).toBe(SMALL_CAP + 1);
      }
    });
  });
});

describe('Given the same depth-5 tree chain tested at two different core.maxTreeDepth values', () => {
  describe('When core.maxTreeDepth = 5', () => {
    it('Then completes', async () => {
      // Arrange — a site that ignored config and kept a hardcoded cap would
      // pass the small-cap pair above against that hardcoded value and fail
      // only here.
      const ctx = await buildSeededContext();
      await seedMaxTreeDepth(ctx, '5');
      const rootId = await buildTreeChain(ctx, 5);
      // Act
      const out = await collect(walkTree(ctx, rootId));
      // Assert
      expect(out).toHaveLength(6);
    });
  });

  describe('When core.maxTreeDepth = 4', () => {
    it('Then throws TREE_DEPTH_EXCEEDED with depth = 5', async () => {
      // Arrange — the SAME chain shape, only the configured cap changes.
      const ctx = await buildSeededContext();
      await seedMaxTreeDepth(ctx, '4');
      const rootId = await buildTreeChain(ctx, 5);
      // Act + Assert
      try {
        await collect(walkTree(ctx, rootId));
        expect.unreachable();
      } catch (error) {
        const data = (error as { data: { code: string; depth: number } }).data;
        expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data.depth).toBe(5);
      }
    });
  });
});
