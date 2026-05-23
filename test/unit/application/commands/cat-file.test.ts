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
