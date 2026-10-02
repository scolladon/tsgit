/**
 * git's object table under a full fsck: the first lookup of an object fixes
 * its type — a ref tip's parse at snapshot, then every object in the order
 * `fsck_source` reads it — and a later lookup asking for another type fails,
 * leaving the asking parse or walk with no object.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath, objectsDir } from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import type { GitObject, ObjectId, ObjectType } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

const IDENT = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const ENCODER = new TextEncoder();
const SEARCH_LIMIT = 4096;

const blobOf = (text: string): GitObject => ({
  type: 'blob',
  id: '' as ObjectId,
  content: ENCODER.encode(text),
});

const commitOf = (
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): GitObject => ({
  type: 'commit',
  id: '' as ObjectId,
  data: { tree, parents, author: IDENT, committer: IDENT, message, extraHeaders: [] },
});

const tagOf = (object: ObjectId, objectType: ObjectType, message: string): GitObject => ({
  type: 'tag',
  id: '' as ObjectId,
  data: { object, objectType, tagName: 'v', tagger: IDENT, message, extraHeaders: [] },
});

const treeOf = (mode: FileMode, name: string, id: ObjectId): GitObject => ({
  type: 'tree',
  id: '' as ObjectId,
  entries: [treeEntry(mode, name, id)],
});

/** The id `object` would get, without writing it where the audit reads. */
const idOf = (object: GitObject): Promise<ObjectId> => writeObject(createMemoryContext(), object);

/** Whether fsck's loose read meets `first` before `second`: an earlier fanout directory. */
const readBefore = (first: ObjectId, second: ObjectId): boolean =>
  first.slice(0, 2) < second.slice(0, 2);

/** The first object `build(n)` makes whose id satisfies `accept`. */
const searchFor = async (
  build: (n: number) => GitObject,
  accept: (id: ObjectId) => boolean,
): Promise<GitObject> => {
  for (let n = 0; n < SEARCH_LIMIT; n++) {
    const object = build(n);
    if (accept(await idOf(object))) return object;
  }
  throw new Error('no object satisfies the read order');
};

/** A loose commit stored byte for byte, the first whose id `fsck` reads after `after`. */
const plantRawCommitAfter = async (
  ctx: Context,
  after: ObjectId,
  header: string,
): Promise<ObjectId> => {
  for (let n = 0; n < SEARCH_LIMIT; n++) {
    const body = ENCODER.encode(`${header}\nm${n}\n`);
    const raw = new Uint8Array([...ENCODER.encode(`commit ${body.length}\0`), ...body]);
    const id = (await ctx.hash.hashHex(raw)) as ObjectId;
    if (!readBefore(after, id)) continue;
    await ctx.fs.mkdir(objectsDir(ctx.layout.gitDir, id.slice(0, 2)));
    await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, id), await ctx.compressor.deflate(raw));
    return id;
  }
  throw new Error('no commit satisfies the read order');
};

const emptyRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

const pointRef = (ctx: Context, ref: string, id: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref}`, `${id}\n`);

/** A base commit on main, so the objects under test are the only unreferenced ones. */
const repoWithMain = async (): Promise<Context> => {
  const ctx = await emptyRepo();
  const base = await writeObject(ctx, blobOf('base\n'));
  const tree = await writeObject(ctx, treeOf(FILE_MODE.REGULAR, 'base', base));
  await pointRef(ctx, 'refs/heads/main', await writeObject(ctx, commitOf(tree, [], 'base')));
  return ctx;
};

const findingsOfType = <T extends FsckFinding['type']>(
  findings: ReadonlyArray<FsckFinding>,
  type: T,
): ReadonlyArray<Extract<FsckFinding, { type: T }>> =>
  findings.filter((finding): finding is Extract<FsckFinding, { type: T }> => finding.type === type);

const aboutId = (findings: ReadonlyArray<FsckFinding>, id: ObjectId) =>
  findings.filter((finding) => 'id' in finding && finding.id === id);

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
