import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { committishFilter } from '../../../../../src/application/commands/internal/disambiguate-committish.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { writeRawObjectBytes } from '../../primitives/fixtures.js';

const encoder = new TextEncoder();
const ABSENT_OID = '1'.repeat(40) as ObjectId;
const CORRUPT_OID = `ab${'0'.repeat(38)}` as ObjectId;

const tagOf = (ctx: Context, target: ObjectId, type: string): Promise<ObjectId> =>
  writeRawObjectBytes(
    ctx,
    'tag',
    encoder.encode(`object ${target}\ntype ${type}\ntag t\ntagger A <a@a> 1 +0000\n\nt\n`),
  );

/** One object of each kind git's committish hint tells apart. */
const objectsRepo = async (): Promise<{
  readonly ctx: Context;
  readonly ids: Readonly<Record<string, ObjectId>>;
}> => {
  const ctx = createMemoryContext();
  const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
  const blob = await writeRawObjectBytes(ctx, 'blob', encoder.encode('b\n'));
  const commit = await writeRawObjectBytes(
    ctx,
    'commit',
    encoder.encode(`tree ${tree}\nauthor A <a@a> 1 +0000\ncommitter A <a@a> 1 +0000\n\nc\n`),
  );
  const tagOfCommit = await tagOf(ctx, commit, 'commit');
  const tagOfTagOfCommit = await tagOf(ctx, tagOfCommit, 'tag');
  const tagOfTree = await tagOf(ctx, tree, 'tree');
  const tagOfAbsent = await tagOf(ctx, ABSENT_OID, 'commit');
  const tagOfCorrupt = await tagOf(ctx, CORRUPT_OID, 'commit');
  const corruptPath = `${ctx.layout.gitDir}/objects/ab/${CORRUPT_OID.slice(2)}`;
  await ctx.fs.writeUtf8(corruptPath, 'garbage');
  return {
    ctx,
    ids: {
      tree,
      blob,
      commit,
      tagOfCommit,
      tagOfTagOfCommit,
      tagOfTree,
      tagOfAbsent,
      tagOfCorrupt,
    },
  };
};

describe('Given objects of every kind', () => {
  describe.each([
    { name: 'commit', expected: true },
    { name: 'tagOfCommit', expected: true },
    { name: 'tagOfTagOfCommit', expected: true },
    { name: 'tree', expected: false },
    { name: 'blob', expected: false },
    { name: 'tagOfTree', expected: false },
    { name: 'tagOfAbsent', expected: false },
  ])('When the committish filter reads $name', ({ name, expected }) => {
    it(`Then it answers ${expected}`, async () => {
      // Arrange
      const { ctx, ids } = await objectsRepo();
      const sut = committishFilter;

      // Act
      const result = await sut(ctx)(ids[name] as ObjectId);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('When the committish filter reads a tag whose target cannot be read', () => {
    it('Then it surfaces the read failure', async () => {
      // Arrange
      const { ctx, ids } = await objectsRepo();
      const sut = committishFilter;

      // Act
      const result = await sut(ctx)(ids.tagOfCorrupt as ObjectId).catch(
        (error: TsgitError) => error.data.code,
      );

      // Assert
      expect(result).toBe('DECOMPRESS_FAILED');
    });
  });
});
