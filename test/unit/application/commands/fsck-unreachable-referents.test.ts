/**
 * `--connectivity-only` marks what unreachable objects link to in the order
 * git lists objects: an object keeps the type its first lookup gave it, so a
 * link read after its target was typed otherwise is a bad pointer, and an
 * object typed by an earlier link is walked as that type.
 */
import { describe, expect, it } from 'vitest';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { refreshPackRegistry } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { writeSyntheticPack } from '../primitives/pack-fixture.js';
import {
  aboutId,
  blobOf,
  commitOf,
  findingsOfType,
  readBefore,
  repoWithMain,
  searchFor,
  tagOf,
  treeOf,
} from './fsck-typing-fixtures.js';

const CONNECTIVITY_ONLY = { connectivityOnly: true } as const;

describe('fsck connectivity-only unreachable referents', () => {
  describe('Given a dangling commit whose tree is a blob read before it', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then the commit is a bad tree pointer and both dangle', async () => {
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
        const result = await sut(ctx, CONNECTIVITY_ONLY);

        // Assert
        expect(findingsOfType(result.findings, 'type-conflict')).toEqual([
          { type: 'type-conflict', id: blob, objectType: 'blob', expectedType: 'tree' },
        ]);
        expect(findingsOfType(result.findings, 'bad-pointer')).toEqual([
          { type: 'bad-pointer', id: commit, link: 'tree', target: blob },
        ]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: blob, objectType: 'blob' },
          { type: 'dangling', id: commit, objectType: 'commit' },
        ]);
        expect(result.exitCode).toBe(0);
      });
    });
  });

  describe('Given a dangling commit whose parent is a blob read before it', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then the commit is a bad parent pointer and the blob dangles', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const tree = await writeObject(ctx, { type: 'tree', id: '' as never, entries: [] });
        const commit = await writeObject(
          ctx,
          await searchFor(
            (n) => commitOf(tree, [blob], `m${n}`),
            (id) => readBefore(blob, id),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx, CONNECTIVITY_ONLY);

        // Assert
        expect(findingsOfType(result.findings, 'bad-pointer')).toEqual([
          { type: 'bad-pointer', id: commit, link: 'parent', target: blob },
        ]);
        expect(aboutId(result.findings, blob)).toEqual([
          { type: 'unreachable', id: blob, objectType: 'blob' },
          { type: 'dangling', id: blob, objectType: 'blob' },
          { type: 'type-conflict', id: blob, objectType: 'blob', expectedType: 'commit' },
        ]);
      });
    });
  });

  describe('Given a dangling tag declaring a tree over a blob read before it', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then the tag is a bad tag pointer and the blob dangles', async () => {
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
        const result = await sut(ctx, CONNECTIVITY_ONLY);

        // Assert
        expect(findingsOfType(result.findings, 'bad-pointer')).toEqual([
          { type: 'bad-pointer', id: tag, link: 'tag', target: blob },
        ]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: blob, objectType: 'blob' },
          { type: 'dangling', id: tag, objectType: 'tag' },
        ]);
      });
    });
  });

  describe('Given a dangling commit whose tree is a blob read after it', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then the blob is walked as a tree it is not, and only the commit dangles', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const commit = await writeObject(
          ctx,
          await searchFor(
            (n) => commitOf(blob, [], `m${n}`),
            (id) => readBefore(id, blob),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx, CONNECTIVITY_ONLY);

        // Assert
        expect(findingsOfType(result.findings, 'unexpected-object-type')).toEqual([
          { type: 'unexpected-object-type', id: blob, expectedType: 'tree' },
        ]);
        expect(findingsOfType(result.findings, 'bad-pointer')).toEqual([]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: commit, objectType: 'commit' },
        ]);
      });
    });
  });

  describe('Given a dangling tree whose directory entry names a blob read before it', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then the entry is a type conflict and the blob dangles beside the tree', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const tree = await writeObject(
          ctx,
          await searchFor(
            (n) => treeOf(FILE_MODE.DIRECTORY, `d${n}`, blob),
            (id) => readBefore(blob, id),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx, CONNECTIVITY_ONLY);

        // Assert
        expect(findingsOfType(result.findings, 'type-conflict')).toEqual([
          { type: 'type-conflict', id: blob, objectType: 'blob', expectedType: 'tree' },
        ]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: blob, objectType: 'blob' },
          { type: 'dangling', id: tree, objectType: 'tree' },
        ]);
      });
    });
  });

  describe('Given a dangling tree whose file and gitlink entries name trees read after it', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then the file entry types its tree a blob, never walked, and its leaf and the gitlink one dangle beside the tree', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const leaf = await writeObject(ctx, blobOf('leaf\n'));
        const inner = await writeObject(ctx, treeOf(FILE_MODE.REGULAR, 'leaf', leaf));
        const linked = await writeObject(
          ctx,
          treeOf(FILE_MODE.REGULAR, 'other', await writeObject(ctx, blobOf('other\n'))),
        );
        const outer = await writeObject(
          ctx,
          await searchFor(
            (n) => ({
              type: 'tree',
              id: '' as ObjectId,
              entries: [
                treeEntry(FILE_MODE.REGULAR, `f${n}`, inner),
                treeEntry(FILE_MODE.GITLINK, `g${n}`, linked),
              ],
            }),
            (id) => readBefore(id, inner) && readBefore(id, linked),
          ),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx, CONNECTIVITY_ONLY);

        // Assert
        expect(findingsOfType(result.findings, 'unexpected-object-type')).toEqual([]);
        expect(findingsOfType(result.findings, 'type-conflict')).toEqual([]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual(
          [
            { type: 'dangling', id: leaf, objectType: 'blob' },
            { type: 'dangling', id: linked, objectType: 'tree' },
            { type: 'dangling', id: outer, objectType: 'tree' },
          ].sort((left, right) => left.id.localeCompare(right.id)),
        );
      });
    });
  });

  describe('Given a packed dangling commit whose tree is a blob read before it', () => {
    describe('When a connectivity-only fsck runs', () => {
      it('Then the commit is a bad tree pointer and both dangle', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const blob = await writeObject(ctx, blobOf('leaf\n'));
        const loose = await writeObject(
          ctx,
          await searchFor(
            (n) => commitOf(blob, [], `m${n}`),
            (id) => readBefore(blob, id),
          ),
        );
        const looseFile = looseObjectPath(ctx.layout.gitDir, loose);
        const raw = await ctx.compressor.inflate(await ctx.fs.read(looseFile));
        const content = raw.slice(raw.indexOf(0) + 1);
        const [commit] = await writeSyntheticPack(ctx, 'dangling', [
          { kind: 'base', type: 'commit', content },
        ]);
        await ctx.fs.rm(looseFile);
        refreshPackRegistry(ctx);
        const sut = fsck;

        // Act
        const result = await sut(ctx, CONNECTIVITY_ONLY);

        // Assert
        expect(findingsOfType(result.findings, 'type-conflict')).toEqual([
          { type: 'type-conflict', id: blob, objectType: 'blob', expectedType: 'tree' },
        ]);
        expect(findingsOfType(result.findings, 'bad-pointer')).toEqual([
          { type: 'bad-pointer', id: commit, link: 'tree', target: blob },
        ]);
        expect(findingsOfType(result.findings, 'dangling')).toEqual([
          { type: 'dangling', id: blob, objectType: 'blob' },
          { type: 'dangling', id: commit, objectType: 'commit' },
        ]);
      });
    });
  });
});
