import { describe, expect, it } from 'vitest';
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
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

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
  describe('basics', () => {
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
  });

  describe('size per object type', () => {
    describe('Given a stored tree id', () => {
      describe('When iterated', () => {
        it('Then size equals serialized tree body length', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const blobId = await writeBlobBytes(ctx, new Uint8Array([0xa]));
          const treeEntries: ReadonlyArray<TreeEntry> = [
            { mode: FILE_MODE.REGULAR, name: 'a.txt', id: blobId },
          ];
          const treeId = await writeTree(ctx, treeEntries);
          const tree = await readObject(ctx, treeId);
          const expected = payloadByteLength(tree, ctx.hashConfig);
          const sut = catFileBatch(ctx, [treeId]);

          // Act
          const [entry] = await collect(sut);

          // Assert
          if (entry?.ok !== true) throw new Error('expected ok');
          expect(entry.type).toBe('tree');
          expect(entry.size).toBe(expected);
        });
      });
    });

    describe('Given a stored commit id', () => {
      describe('When iterated', () => {
        it('Then size equals serialized commit body length', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const blobId = await writeBlobBytes(ctx, new Uint8Array([1]));
          const treeId = await writeTree(ctx, [{ mode: FILE_MODE.REGULAR, name: 'f', id: blobId }]);
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
          const expected = serializeCommitContent(commit).byteLength;
          const sut = catFileBatch(ctx, [commitId]);

          // Act
          const [entry] = await collect(sut);

          // Assert
          if (entry?.ok !== true) throw new Error('expected ok');
          expect(entry.type).toBe('commit');
          expect(entry.size).toBe(expected);
        });
      });
    });

    describe('Given a stored tag id', () => {
      describe('When iterated', () => {
        it('Then size equals serialized tag body length', async () => {
          // Arrange
          const ctx = await buildSeededContext();
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
          const expected = serializeTagContent(tag).byteLength;
          const sut = catFileBatch(ctx, [tagId]);

          // Act
          const [entry] = await collect(sut);

          // Assert
          if (entry?.ok !== true) throw new Error('expected ok');
          expect(entry.type).toBe('tag');
          expect(entry.size).toBe(expected);
        });
      });
    });
  });

  describe('missing ids', () => {
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
  });

  describe('error propagation', () => {
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

          // Act / Assert
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
  });

  describe('options', () => {
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
  });

  describe('cancellation', () => {
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
});
