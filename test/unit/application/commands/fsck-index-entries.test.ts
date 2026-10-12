/**
 * git's `fsck_index` roots every index entry that is not a gitlink, whatever
 * its stage: a conflicted path's stage 1–3 blobs are reachable, and a
 * submodule's commit oid is never looked up in this repository.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  type IndexEntryFlags,
  STAGE0_FLAGS,
} from '../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, type FileMode, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';

const enc = new TextEncoder();
const CONFLICT_STAGES = [
  { content: 'one', stage: 1 },
  { content: 'two', stage: 2 },
  { content: 'three', stage: 3 },
] as const;
const ABSENT_COMMIT = '1111111111111111111111111111111111111111' as ObjectId;

interface Staged {
  readonly id: ObjectId;
  readonly stage: IndexEntryFlags['stage'];
  readonly mode: FileMode;
  readonly path: string;
}

const initCtx = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

const writeBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc.encode(content) });

const writeIndex = async (ctx: Context, staged: ReadonlyArray<Staged>): Promise<void> => {
  const entries = staged.map(({ id, stage, mode, path }) => ({
    ctimeSeconds: 0,
    ctimeNanoseconds: 0,
    mtimeSeconds: 0,
    mtimeNanoseconds: 0,
    dev: 0,
    ino: 0,
    mode,
    uid: 0,
    gid: 0,
    fileSize: 0,
    id,
    flags: { ...STAGE0_FLAGS, stage },
    path: path as FilePath,
  }));
  const index = { version: 2 as const, entries, extensions: [], trailerSha: new Uint8Array(0) };
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, await serializeIndexFixtureAsync(index, ctx));
};

describe('Given an index holding a conflicted path at stages 1, 2 and 3', () => {
  describe('When fsck runs', () => {
    it('Then every stage blob is reachable — none is dangling', async () => {
      // Arrange
      const ctx = await initCtx();
      const staged = await Promise.all(
        CONFLICT_STAGES.map(async ({ content, stage }) => ({
          id: await writeBlob(ctx, content),
          stage,
          mode: FILE_MODE.REGULAR,
          path: 'f',
        })),
      );
      await writeIndex(ctx, staged);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((finding) => finding.type === 'dangling')).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given an index holding a gitlink to a commit this repository lacks', () => {
  describe('When fsck runs', () => {
    it('Then the gitlink is never looked up — nothing is missing', async () => {
      // Arrange
      const ctx = await initCtx();
      const file = await writeBlob(ctx, 'file');
      await writeIndex(ctx, [
        { id: file, stage: 0, mode: FILE_MODE.REGULAR, path: 'f' },
        { id: ABSENT_COMMIT, stage: 0, mode: FILE_MODE.GITLINK, path: 'sub' },
      ]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert — no ref names an object, so git notes it has no default reference.
      expect(result.findings).toEqual([{ type: 'no-default-references' }]);
      expect(result.exitCode).toBe(0);
    });
  });
});
