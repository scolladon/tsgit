import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { catFileBatch } from '../../../../src/application/primitives/cat-file-batch.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { CatFileBatchEntry } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import {
  FILE_MODE,
  payloadByteLength,
  serializeCommitContent,
  serializeTagContent,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext, writeLooseWithDeclaredSize, writeRawObjectBytes } from './fixtures.js';
import { writeSyntheticPackIn } from './pack-fixture.js';

const IDENTITY = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const writeBlobBytes = async (ctx: Context, content: Uint8Array): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content, id: '' as ObjectId } satisfies Blob);

const collect = async (iter: AsyncIterable<CatFileBatchEntry>): Promise<CatFileBatchEntry[]> => {
  const out: CatFileBatchEntry[] = [];
  for await (const e of iter) out.push(e);
  return out;
};

describe('catFileBatch', () => {
  describe('Given an empty iterable', () => {
    describe('When iterated', () => {
      it('Then yields no entries', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = catFileBatch(ctx, []);

        // Act
        const entries = await collect(sut);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a stored blob id', () => {
    describe('When iterated', () => {
      it('Then yields one ok entry with type/size/object', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('hello world');
        const id = await writeBlobBytes(ctx, content);
        const sut = catFileBatch(ctx, [id]);

        // Act
        const [entry, ...rest] = await collect(sut);

        // Assert
        expect(rest).toEqual([]);
        expect(entry?.ok).toBe(true);
        if (entry?.ok !== true) throw new Error('expected ok');
        expect(entry.id).toBe(id);
        expect(entry.type).toBe('blob');
        expect(entry.size).toBe(content.byteLength);
        expect(entry.object.type).toBe('blob');
      });
    });
  });

  describe('Given a sync iterable of ids', () => {
    describe('When iterated', () => {
      it('Then yields entries in order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const a = await writeBlobBytes(ctx, new Uint8Array([1, 2, 3]));
        const b = await writeBlobBytes(ctx, new Uint8Array([4, 5]));
        const sut = catFileBatch(ctx, [a, b]);

        // Act
        const entries = await collect(sut);

        // Assert
        expect(entries.map((e) => e.id)).toEqual([a, b]);
      });
    });
  });

  describe('Given an async iterable of ids', () => {
    describe('When iterated', () => {
      it('Then yields entries equivalently', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const a = await writeBlobBytes(ctx, new Uint8Array([1]));
        const asyncIds = (async function* () {
          yield a;
        })();
        const sut = catFileBatch(ctx, asyncIds);

        // Act
        const entries = await collect(sut);

        // Assert
        expect(entries.map((e) => e.id)).toEqual([a]);
      });
    });
  });

  describe('Given a stored tree, commit, or tag id', () => {
    describe('When iterated', () => {
      it.each([
        {
          label: 'tree',
          build: async (ctx: Context): Promise<{ id: ObjectId; expected: number }> => {
            const blobId = await writeBlobBytes(ctx, new Uint8Array([0xa]));
            const treeEntries: ReadonlyArray<TreeEntry> = [
              treeEntry(FILE_MODE.REGULAR, 'a.txt', blobId),
            ];
            const treeId = await writeTree(ctx, treeEntries);
            const tree = await readObject(ctx, treeId);
            return { id: treeId, expected: payloadByteLength(tree, ctx.hashConfig) };
          },
        },
        {
          label: 'commit',
          build: async (ctx: Context): Promise<{ id: ObjectId; expected: number }> => {
            const blobId = await writeBlobBytes(ctx, new Uint8Array([1]));
            const treeId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', blobId)]);
            const commitId = await writeObject(ctx, {
              type: 'commit',
              id: '' as ObjectId,
              data: {
                tree: treeId,
                parents: [],
                author: IDENTITY,
                committer: IDENTITY,
                message: 'initial',
                extraHeaders: [],
              },
            });
            const commit = await readObject(ctx, commitId);
            if (commit.type !== 'commit') throw new Error('expected commit');
            return { id: commitId, expected: serializeCommitContent(commit).byteLength };
          },
        },
        {
          label: 'tag',
          build: async (ctx: Context): Promise<{ id: ObjectId; expected: number }> => {
            const blobId = await writeBlobBytes(ctx, new Uint8Array([1]));
            const tagId = await writeObject(ctx, {
              type: 'tag',
              id: '' as ObjectId,
              data: {
                object: blobId,
                objectType: 'blob',
                tagName: 'v0',
                tagger: IDENTITY,
                message: 'release',
                extraHeaders: [],
              },
            });
            const tag = await readObject(ctx, tagId);
            if (tag.type !== 'tag') throw new Error('expected tag');
            return { id: tagId, expected: serializeTagContent(tag).byteLength };
          },
        },
      ])('Then size equals serialized $label body length', async ({ label, build }) => {
        // Arrange
        const ctx = await buildSeededContext();
        const { id, expected } = await build(ctx);
        const sut = catFileBatch(ctx, [id]);

        // Act
        const [entry] = await collect(sut);

        // Assert
        if (entry?.ok !== true) throw new Error('expected ok');
        expect(entry.type).toBe(label);
        expect(entry.size).toBe(expected);
      });
    });
  });

  describe('Given a loose blob whose header size claim disagrees with its body length', () => {
    describe('When iterated', () => {
      it('Then yields an ok entry whose size is the stored claim and whose object content is the real body', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('hello world!'); // 12 bytes
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content);
        const sut = catFileBatch(ctx, [id]);

        // Act
        const [entry] = await collect(sut);

        // Assert
        if (entry?.ok !== true) throw new Error('expected ok');
        expect(entry.type).toBe('blob');
        expect(entry.size).toBe(5);
        expect(entry.object.type).toBe('blob');
        if (entry.object.type === 'blob') {
          expect(entry.object.content).toEqual(content);
        }
      });
    });
  });

  describe('Given a missing id', () => {
    describe('When iterated', () => {
      it('Then yields { ok: false, reason: "missing" }', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missing = 'f'.repeat(40) as ObjectId;
        const sut = catFileBatch(ctx, [missing]);

        // Act
        const [entry] = await collect(sut);

        // Assert
        expect(entry).toEqual({ ok: false, id: missing, reason: 'missing' });
      });
    });
  });

  describe('Given mixed hits and misses', () => {
    describe('When iterated', () => {
      it('Then yields per input id in input order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const hit = await writeBlobBytes(ctx, new Uint8Array([1]));
        const miss = 'e'.repeat(40) as ObjectId;
        const sut = catFileBatch(ctx, [miss, hit, miss]);

        // Act
        const entries = await collect(sut);

        // Assert
        expect(entries.map((e) => ({ id: e.id, ok: e.ok }))).toEqual([
          { id: miss, ok: false },
          { id: hit, ok: true },
          { id: miss, ok: false },
        ]);
      });
    });
  });

  describe('Given a non-OBJECT_NOT_FOUND TsgitError thrown by the read', () => {
    describe('When iterated', () => {
      it('Then propagates the error', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const stored = await writeBlobBytes(ctx, new Uint8Array([1]));
        // Wrap fs.read to throw an unrelated TsgitError on a single object path.
        const path = `${ctx.layout.gitDir}/objects/${stored.slice(0, 2)}/${stored.slice(2)}`;
        const originalRead = ctx.fs.read.bind(ctx.fs);
        const probe: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (p: string) => {
              if (p === path) {
                throw new TsgitError({
                  code: 'DECOMPRESS_FAILED',
                  reason: 'simulated corruption',
                });
              }
              return originalRead(p);
            },
          },
        } as Context;
        const sut = catFileBatch(probe, [stored]);

        // Act
        let caught: unknown;
        try {
          await collect(sut);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) throw caught;
        expect(caught.data.code).toBe('DECOMPRESS_FAILED');
      });
    });
  });

  describe('Given a non-TsgitError thrown by the read', () => {
    describe('When iterated', () => {
      it('Then propagates the error', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const stored = await writeBlobBytes(ctx, new Uint8Array([1]));
        const probe: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async () => {
              throw new RangeError('boom');
            },
          },
        } as Context;
        const sut = catFileBatch(probe, [stored]);

        // Act / Assert
        await expect(collect(sut)).rejects.toBeInstanceOf(RangeError);
      });
    });
  });

  describe('Given a foreign-shaped OBJECT_NOT_FOUND thrown by the read', () => {
    describe('When iterated', () => {
      it('Then yields a missing entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const stored = await writeBlobBytes(ctx, new Uint8Array([1]));
        const path = `${ctx.layout.gitDir}/objects/${stored.slice(0, 2)}/${stored.slice(2)}`;
        const originalRead = ctx.fs.read.bind(ctx.fs);
        const probe: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (p: string) => {
              if (p === path) {
                throw Object.assign(new Error('foreign graph'), {
                  data: { code: 'OBJECT_NOT_FOUND', id: stored },
                });
              }
              return originalRead(p);
            },
          },
        } as Context;
        const sut = catFileBatch(probe, [stored]);

        // Act
        const entries = await collect(sut);

        // Assert
        expect(entries).toEqual([{ ok: false, id: stored, reason: 'missing' }]);
      });
    });
  });

  describe('Given maxBytes smaller than the stored blob', () => {
    describe('When iterated', () => {
      it('Then propagates OBJECT_TOO_LARGE (cap forwarded to readObject)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlobBytes(ctx, new Uint8Array([1, 2, 3, 4]));
        const sut = catFileBatch(ctx, [id], { maxBytes: 2 });

        // Act
        let caught: unknown;
        try {
          await collect(sut);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) throw caught;
        expect(caught.data.code).toBe('OBJECT_TOO_LARGE');
      });
    });
  });

  describe('Given maxBytes equal to the stored blob byte length', () => {
    describe('When iterated', () => {
      it('Then yields the entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new Uint8Array([10, 20, 30]);
        const id = await writeBlobBytes(ctx, content);
        const sut = catFileBatch(ctx, [id], { maxBytes: content.byteLength });

        // Act
        const [entry] = await collect(sut);

        // Assert
        if (entry?.ok !== true) throw new Error('expected ok');
        expect(entry.size).toBe(content.byteLength);
      });
    });
  });

  describe('Given a signal already aborted', () => {
    describe('When iterated', () => {
      it('Then throws OPERATION_ABORTED before any entry is yielded', async () => {
        // Arrange
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const id = await writeBlobBytes(ctx, new Uint8Array([1]));
        controller.abort();
        const sut = catFileBatch(ctx, [id]);

        // Act
        const entries: CatFileBatchEntry[] = [];
        let caught: unknown;
        try {
          for await (const entry of sut) entries.push(entry);
        } catch (err) {
          caught = err;
        }

        // Assert — the abort fires before the first read; no entry was yielded.
        expect(entries).toHaveLength(0);
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) throw caught;
        expect(caught.data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given a signal aborted after the only yield', () => {
    describe('When iteration continues past it', () => {
      it('Then the post-yield guard throws OPERATION_ABORTED', async () => {
        // Arrange — a single-id batch so the post-yield `throwIfAborted` is
        // the only check between the last yield and the iterator finishing.
        // Removing it would let the loop complete normally; this test
        // independently proves the post-yield guard is load-bearing.
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const id = await writeBlobBytes(ctx, new Uint8Array([7]));
        const sut = catFileBatch(ctx, [id]);
        const iterator = sut[Symbol.asyncIterator]();
        const first = await iterator.next();
        controller.abort();

        // Act
        let caught: unknown;
        try {
          await iterator.next();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(first.done).toBe(false);
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) throw caught;
        expect(caught.data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given a signal aborted after the first yield', () => {
    describe('When iteration continues', () => {
      it('Then the next pull throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const a = await writeBlobBytes(ctx, new Uint8Array([1]));
        const b = await writeBlobBytes(ctx, new Uint8Array([2]));
        const sut = catFileBatch(ctx, [a, b]);
        const iterator = sut[Symbol.asyncIterator]();
        const first = await iterator.next();
        controller.abort();

        // Act
        let caught: unknown;
        try {
          await iterator.next();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(first.done).toBe(false);
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) throw caught;
        expect(caught.data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});

const PRIMARY_OBJECTS = '/repo/.git/objects';
const ALT_OBJECTS = '/repo/alt/objects';
const THRESHOLD = 100;
const ENC = new TextEncoder();
const FLIPPED_SIGNATURE_MIDX = Uint8Array.from([
  0x00,
  0x49,
  0x44,
  0x58,
  1,
  1,
  1,
  0,
  ...new Array(8).fill(0),
]);

const contextWithCorruptAlternate = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: {
      [`${PRIMARY_OBJECTS}/info/alternates`]: ENC.encode(`${ALT_OBJECTS}\n`),
      '/repo/.git/config': ENC.encode(`[core]\n\tbigFileThreshold = ${THRESHOLD}\n`),
    },
  });
  await ctx.fs.mkdir(ALT_OBJECTS);
  await ctx.fs.write(`${ALT_OBJECTS}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);
  return ctx;
};

const packedBlob = async (ctx: Context, content: Uint8Array): Promise<ObjectId> => {
  const [id] = await writeSyntheticPackIn(ctx, PRIMARY_OBJECTS, 'p', [
    { kind: 'base', type: 'blob', content },
  ]);
  return id as ObjectId;
};

const packedBlobIn = async (ctx: Context, content: Uint8Array): Promise<ObjectId> => {
  const [id] = await writeSyntheticPackIn(ctx, `${ctx.layout.gitDir}/objects`, 'p', [
    { kind: 'base', type: 'blob', content },
  ]);
  return id as ObjectId;
};

const firstEntry = async (sut: AsyncIterable<CatFileBatchEntry>): Promise<CatFileBatchEntry> => {
  for await (const entry of sut) return entry;
  throw new Error('no entry');
};

const rejectionData = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('catFileBatch in git stream order', () => {
  describe('Given a small packed blob and an corrupt alternate', () => {
    describe('When iterated', () => {
      it('Then the alternate is reached', async () => {
        // Arrange
        const ctx = await contextWithCorruptAlternate();
        const id = await packedBlob(ctx, ENC.encode('small'));
        const sut = catFileBatch(ctx, [id]);

        // Act
        const result = await rejectionData(firstEntry(sut));

        // Assert
        expect(result).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
      });
    });
  });

  describe('Given a packed blob above bigFileThreshold and an corrupt alternate', () => {
    describe('When iterated', () => {
      it('Then the blob is served without reaching the alternate', async () => {
        // Arrange
        const ctx = await contextWithCorruptAlternate();
        const content = new Uint8Array(THRESHOLD + 1).fill(7);
        const id = await packedBlob(ctx, content);
        const sut = catFileBatch(ctx, [id]);

        // Act
        const result = await firstEntry(sut);

        // Assert
        expect(result.ok && result.object.type === 'blob' && result.object.content).toEqual(
          content,
        );
        expect(result.ok && result.size).toBe(content.byteLength);
      });
    });
  });

  describe('Given a packed commit and an corrupt alternate', () => {
    describe('When iterated', () => {
      it('Then the commit is served without reaching the alternate', async () => {
        // Arrange
        const ctx = await contextWithCorruptAlternate();
        const [id] = await writeSyntheticPackIn(ctx, PRIMARY_OBJECTS, 'p', [
          {
            kind: 'base',
            type: 'commit',
            content: ENC.encode(
              'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nm\n',
            ),
          },
        ]);
        const sut = catFileBatch(ctx, [id as ObjectId]);

        // Act
        const result = await firstEntry(sut);

        // Assert
        expect(result.ok && result.type).toBe('commit');
      });
    });
  });

  describe('Given an id stored nowhere', () => {
    describe('When iterated', () => {
      it('Then the entry is a missing one', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = '1'.repeat(40) as ObjectId;
        const sut = catFileBatch(ctx, [id]);

        // Act
        const result = await firstEntry(sut);

        // Assert
        expect(result).toEqual({ ok: false, id, reason: 'missing' });
      });
    });
  });

  describe('Given a packed blob larger than maxBytes and an corrupt alternate', () => {
    describe('When iterated', () => {
      it('Then it refuses with the declared size before opening anything', async () => {
        // Arrange
        const ctx = await contextWithCorruptAlternate();
        const content = ENC.encode('twelve bytes');
        const id = await packedBlob(ctx, content);
        const sut = catFileBatch(ctx, [id], { maxBytes: 5 });

        // Act
        const result = await rejectionData(firstEntry(sut));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_TOO_LARGE', id, actualSize: 12, limit: 5 });
      });
    });
  });

  describe('Given a packed blob exactly maxBytes', () => {
    describe('When iterated', () => {
      it('Then it is served', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = ENC.encode('twelve bytes');
        const id = await packedBlobIn(ctx, content);
        const sut = catFileBatch(ctx, [id], { maxBytes: 12 });

        // Act
        const result = await firstEntry(sut);

        // Assert
        expect(result.ok && result.size).toBe(12);
      });
    });
  });
});
