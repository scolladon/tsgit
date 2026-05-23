import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { catFile } from '../../../../src/application/commands/cat-file.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';

const writeBlobBytes = async (ctx: Context, content: Uint8Array): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content, id: '' as ObjectId } satisfies Blob);

describe('catFile', () => {
  it('Given a non-repository context, When invoked, Then throws NOT_A_REPOSITORY', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const sut = catFile;

    // Act
    let caught: unknown;
    try {
      await sut(ctx, { ids: [] });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    if (!(caught instanceof TsgitError)) throw caught;
    expect(caught.data.code).toBe('NOT_A_REPOSITORY');
  });

  it('Given a malformed string id, When invoked, Then throws INVALID_OBJECT_ID before any read', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const sut = catFile;

    // Act
    let caught: unknown;
    try {
      await sut(ctx, { ids: ['not-a-hash'] });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    if (!(caught instanceof TsgitError)) throw caught;
    expect(caught.data.code).toBe('INVALID_OBJECT_ID');
  });

  it('Given a mix of ObjectId and hex string inputs, When invoked, Then both are accepted', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const idBranded = await writeBlobBytes(ctx, new Uint8Array([1, 2]));
    const idAsString: string = idBranded;
    const sut = catFile;

    // Act
    const result = await sut(ctx, { ids: [idBranded, idAsString] });

    // Assert
    expect(result.kind).toBe('batch');
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.ok)).toBe(true);
  });

  it('Given an empty ids array, When invoked, Then returns { kind: "batch", entries: [] }', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const sut = catFile;

    // Act
    const result = await sut(ctx, { ids: [] });

    // Assert
    expect(result).toEqual({ kind: 'batch', entries: [] });
  });

  it('Given maxBytes smaller than the stored blob, When invoked, Then propagates OBJECT_TOO_LARGE (option forwarded to the primitive)', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const id = await writeBlobBytes(ctx, new Uint8Array([1, 2, 3, 4]));
    const sut = catFile;

    // Act
    let caught: unknown;
    try {
      await sut(ctx, { ids: [id], maxBytes: 2 });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    if (!(caught instanceof TsgitError)) throw caught;
    expect(caught.data.code).toBe('OBJECT_TOO_LARGE');
  });

  it('Given maxBytes equal to the stored blob length, When invoked, Then returns the entry', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const content = new Uint8Array([7, 8, 9]);
    const id = await writeBlobBytes(ctx, content);
    const sut = catFile;

    // Act
    const result = await sut(ctx, { ids: [id], maxBytes: content.byteLength });

    // Assert
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    if (entry?.ok !== true) throw new Error('expected ok');
    expect(entry.size).toBe(content.byteLength);
  });

  it('Given a mix of stored and missing ids, When invoked, Then per-entry ok shape in input order', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const hit = await writeBlobBytes(ctx, new Uint8Array([3]));
    const miss = 'c'.repeat(40) as ObjectId;
    const sut = catFile;

    // Act
    const result = await sut(ctx, { ids: [hit, miss] });

    // Assert
    expect(result.entries.map((e) => ({ id: e.id, ok: e.ok }))).toEqual([
      { id: hit, ok: true },
      { id: miss, ok: false },
    ]);
  });
});
