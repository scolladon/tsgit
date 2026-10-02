/**
 * git's object table under a full fsck: the first lookup of an object fixes
 * its type — a ref tip's parse at snapshot, then every object in the order
 * `fsck_source` reads it — and a later lookup asking for another type fails,
 * leaving the asking parse or walk with no object.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import {
  aboutId,
  blobOf,
  commitOf,
  ENCODER,
  emptyRepo,
  findingsOfType,
  plantRawCommitAfter,
  pointRef,
  readBefore,
  repoWithMain,
  searchFor,
  tagOf,
  treeOf,
} from './fsck-typing-fixtures.js';

describe('fsck object table', () => {
  describe('Given main at a commit whose tree is a blob', () => {
    describe('When a full fsck runs', () => {
      it('Then the blob read after the commit typed it is a type conflict, unparsed and missing as a tree', async () => {
        // Arrange
        const ctx = await emptyRepo();
        const blob = await writeObject(ctx, blobOf('blob\n'));
        await pointRef(ctx, 'refs/heads/main', await writeObject(ctx, commitOf(blob, [], 'm')));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(aboutId(result.findings, blob)).toEqual([
          { type: 'type-conflict', id: blob, objectType: 'tree', expectedType: 'blob' },
          { type: 'unparseable-object', id: blob },
          { type: 'missing', id: blob, objectType: 'tree' },
        ]);
        expect(result.exitCode).toBe(3);
      });
    });
  });

  describe('Given main at a commit whose tree is a blob', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then no copy is parsed, so nothing is unparseable', async () => {
        // Arrange
        const ctx = await emptyRepo();
        const blob = await writeObject(ctx, blobOf('blob\n'));
        await pointRef(ctx, 'refs/heads/main', await writeObject(ctx, commitOf(blob, [], 'm')));
        const sut = fsck;

        // Act
        const result = await sut(ctx, { connectivityOnly: true });

        // Assert
        expect(findingsOfType(result.findings, 'unparseable-object')).toEqual([]);
      });
    });
  });

  describe('Given a tag ref declaring a commit over a blob', () => {
    describe('When a full fsck runs', () => {
      it('Then the blob is typed a commit by the tag, unparsed and missing as a commit', async () => {
        // Arrange
        const ctx = await emptyRepo();
        const blob = await writeObject(ctx, blobOf('blob\n'));
        const tag = await writeObject(ctx, tagOf(blob, 'commit', 'm'));
        await pointRef(ctx, 'refs/tags/v', tag);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(aboutId(result.findings, blob)).toEqual([
          { type: 'type-conflict', id: blob, objectType: 'commit', expectedType: 'blob' },
          { type: 'unparseable-object', id: blob },
          { type: 'missing', id: blob, objectType: 'commit' },
          { type: 'tagged', id: blob, objectType: 'commit', tagName: 'v', tag },
        ]);
        expect(result.exitCode).toBe(3);
      });
    });
  });

  describe('Given an unreferenced commit whose parent is a tree read before it', () => {
    describe('When a full fsck runs', () => {
      it('Then the commit is a bad parent pointer, never checked, and the tree dangles', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const tree = await writeObject(ctx, treeOf(FILE_MODE.REGULAR, 'leaf', blob));
        const commit = await writeObject(
          ctx,
          await searchFor(
            (n) => commitOf(tree, [tree], `m${n}`),
            (id) => readBefore(tree, id),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(findingsOfType(result.findings, 'type-conflict')).toEqual([
          { type: 'type-conflict', id: tree, objectType: 'tree', expectedType: 'commit' },
        ]);
        expect(findingsOfType(result.findings, 'bad-pointer')).toEqual([
          { type: 'bad-pointer', id: commit, link: 'parent', target: tree },
        ]);
        expect(aboutId(result.findings, commit)).toEqual([
          { type: 'bad-pointer', id: commit, link: 'parent', target: tree },
          { type: 'unparseable-object', id: commit },
        ]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: tree, objectType: 'tree' },
        ]);
        expect(result.exitCode).toBe(1);
      });
    });
  });

  describe('Given an unreferenced commit with a malformed author whose parent is a tree read before it', () => {
    describe('When a full fsck runs', () => {
      it('Then the commit is never checked, so its author raises nothing', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const tree = await writeObject(
          ctx,
          treeOf(FILE_MODE.REGULAR, 'leaf', await writeObject(ctx, blobOf('leaf\n'))),
        );
        const commit = await plantRawCommitAfter(
          ctx,
          tree,
          `tree ${tree}\nparent ${tree}\nauthor Ada<ada@example.com> 1700000000 +0000\ncommitter Ada <ada@example.com> 1700000000 +0000\n`,
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(aboutId(result.findings, commit)).toEqual([
          { type: 'bad-pointer', id: commit, link: 'parent', target: tree },
          { type: 'unparseable-object', id: commit },
        ]);
      });
    });
  });

  describe('Given an unreferenced root commit whose tree is a blob read before it', () => {
    describe('When a full fsck runs', () => {
      it('Then the commit is a bad tree pointer, never a root, and the blob dangles', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const commit = await writeObject(
          ctx,
          await searchFor(
            (n) => commitOf(blob, [], `m${n}`),
            (id) => readBefore(blob, id),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(aboutId(result.findings, commit)).toEqual([
          { type: 'bad-pointer', id: commit, link: 'tree', target: blob },
          { type: 'unparseable-object', id: commit },
        ]);
        expect(aboutId(result.findings, blob)).toEqual([
          { type: 'type-conflict', id: blob, objectType: 'blob', expectedType: 'tree' },
          { type: 'unreachable', id: blob, objectType: 'blob' },
          { type: 'dangling', id: blob, objectType: 'blob' },
        ]);
        expect(result.exitCode).toBe(1);
      });
    });
  });

  describe('Given an unreferenced tag declaring a tree over a blob read before it', () => {
    describe('When a full fsck runs', () => {
      it('Then the tag is a bad tag pointer, never tagging, and the blob dangles', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const tag = await writeObject(
          ctx,
          await searchFor(
            (n) => tagOf(blob, 'tree', `m${n}`),
            (id) => readBefore(blob, id),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(aboutId(result.findings, tag)).toEqual([
          { type: 'bad-pointer', id: tag, link: 'tag', target: blob },
          { type: 'unparseable-object', id: tag },
        ]);
        expect(findingsOfType(result.findings, 'tagged')).toEqual([]);
        expect(aboutId(result.findings, blob)).toEqual([
          { type: 'type-conflict', id: blob, objectType: 'blob', expectedType: 'tree' },
          { type: 'unreachable', id: blob, objectType: 'blob' },
          { type: 'dangling', id: blob, objectType: 'blob' },
        ]);
        expect(result.exitCode).toBe(1);
      });
    });
  });

  describe('Given main over a tree whose directory entry names a blob read before it', () => {
    describe('When a full fsck runs', () => {
      it('Then the tree has broken links, its walk cannot resolve the entry, and the blob dangles', async () => {
        // Arrange
        const ctx = await emptyRepo();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const tree = await writeObject(
          ctx,
          await searchFor(
            (n) => treeOf(FILE_MODE.DIRECTORY, `d${n}`, blob),
            (id) => readBefore(blob, id),
          ),
        );
        await pointRef(ctx, 'refs/heads/main', await writeObject(ctx, commitOf(tree, [], 'm')));
        const conflict = {
          type: 'type-conflict',
          id: blob,
          objectType: 'blob',
          expectedType: 'tree',
        } as const;
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(findingsOfType(result.findings, 'type-conflict')).toEqual([conflict, conflict]);
        expect(findingsOfType(result.findings, 'broken-links')).toEqual([
          { type: 'broken-links', id: tree, objectType: 'tree' },
        ]);
        expect(findingsOfType(result.findings, 'unresolved-link')).toEqual([
          { type: 'unresolved-link', fromId: tree, fromType: 'tree', toType: 'tree' },
        ]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: blob, objectType: 'blob' },
        ]);
        expect(result.exitCode).toBe(3);
      });
    });
  });

  describe('Given main over a tree whose directory and file entries both name a blob read before it', () => {
    describe('When a full fsck runs', () => {
      it('Then only the directory entry is unresolved and the file entry reaches the blob', async () => {
        // Arrange
        const ctx = await emptyRepo();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const tree = await writeObject(
          ctx,
          await searchFor(
            (n) => ({
              type: 'tree',
              id: '' as ObjectId,
              entries: [
                treeEntry(FILE_MODE.DIRECTORY, `d${n}`, blob),
                treeEntry(FILE_MODE.REGULAR, `f${n}`, blob),
              ],
            }),
            (id) => readBefore(blob, id),
          ),
        );
        await pointRef(ctx, 'refs/heads/main', await writeObject(ctx, commitOf(tree, [], 'm')));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(findingsOfType(result.findings, 'unresolved-link')).toEqual([
          { type: 'unresolved-link', fromId: tree, fromType: 'tree', toType: 'tree' },
        ]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([]);
        expect(findingsOfType(result.findings, 'missing')).toEqual([]);
      });
    });
  });

  describe('Given an unreferenced tree whose directory and file entries both name a blob read before it', () => {
    describe('When a full fsck runs', () => {
      it('Then the file entry still marks the blob used, so only the tree dangles', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const tree = await writeObject(
          ctx,
          await searchFor(
            (n) => ({
              type: 'tree',
              id: '' as ObjectId,
              entries: [
                treeEntry(FILE_MODE.DIRECTORY, `d${n}`, blob),
                treeEntry(FILE_MODE.REGULAR, `f${n}`, blob),
              ],
            }),
            (id) => readBefore(blob, id),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: tree, objectType: 'tree' },
        ]);
      });
    });
  });

  describe('Given main over a tree whose file entry names a tree read after it', () => {
    describe('When a full fsck runs', () => {
      it('Then the entry tree is typed a blob, unparsed and missing as a blob', async () => {
        // Arrange
        const ctx = await emptyRepo();
        const leaf = await writeObject(ctx, blobOf('leaf\n'));
        const inner = await writeObject(ctx, treeOf(FILE_MODE.REGULAR, 'leaf', leaf));
        const outer = await writeObject(
          ctx,
          await searchFor(
            (n) => treeOf(FILE_MODE.REGULAR, `f${n}`, inner),
            (id) => readBefore(id, inner),
          ),
        );
        await pointRef(ctx, 'refs/heads/main', await writeObject(ctx, commitOf(outer, [], 'm')));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(aboutId(result.findings, inner)).toEqual([
          { type: 'type-conflict', id: inner, objectType: 'blob', expectedType: 'tree' },
          { type: 'unparseable-object', id: inner },
          { type: 'missing', id: inner, objectType: 'blob' },
        ]);
        expect(findingsOfType(result.findings, 'broken-links')).toEqual([]);
        expect(result.exitCode).toBe(3);
      });
    });
  });

  describe('Given main over a tree whose loose copy holds a blob and whose alternate copy is valid', () => {
    describe('When a full fsck runs', () => {
      it('Then the tree is never typed from the mismatched copy, so nothing is unparseable', async () => {
        // Arrange
        const scratch = createMemoryContext();
        const leaf = await writeObject(scratch, blobOf('leaf\n'));
        const tree = await writeObject(scratch, treeOf(FILE_MODE.REGULAR, 'leaf', leaf));
        const commit = await writeObject(scratch, commitOf(tree, [], 'm'));
        const other = await writeObject(scratch, blobOf('other\n'));
        const looseBytes = (id: ObjectId) =>
          scratch.fs.read(looseObjectPath(scratch.layout.gitDir, id));
        const ctx = createMemoryContext({
          files: {
            '/repo/.git/objects/info/alternates': ENCODER.encode('/repo/donor/objects\n'),
            [`/repo/donor/objects/${tree.slice(0, 2)}/${tree.slice(2)}`]: await looseBytes(tree),
            [looseObjectPath('/repo/.git', tree)]: await looseBytes(other),
            [looseObjectPath('/repo/.git', leaf)]: await looseBytes(leaf),
            [looseObjectPath('/repo/.git', commit)]: await looseBytes(commit),
            '/repo/.git/HEAD': ENCODER.encode('ref: refs/heads/main\n'),
            '/repo/.git/refs/heads/main': ENCODER.encode(`${commit}\n`),
          },
        });
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(findingsOfType(result.findings, 'unparseable-object')).toEqual([]);
        expect(findingsOfType(result.findings, 'missing')).toEqual([]);
      });
    });
  });
});
