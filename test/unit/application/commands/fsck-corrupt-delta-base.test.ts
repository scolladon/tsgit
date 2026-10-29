/**
 * A delta base whose body is damaged: git's `check_object` cannot read it for
 * the delta children that lean on it, so its walk calls the base missing. A
 * damaged entry no child leans on stays pack-held, and a base another copy
 * serves is not missing.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { refreshPackRegistry } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { FILE_MODE, type ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { type EntrySpec, writeSyntheticPack } from '../primitives/pack-fixture.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const PACK_HEADER = 12;
const enc = new TextEncoder();
const baseBytes = enc.encode(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
const childBytes = (tag: string) =>
  enc.encode(`${tag}\n`.concat(new TextDecoder().decode(baseBytes)));

const ofsChild = (tag: string): EntrySpec => ({
  kind: 'ofs-delta',
  baseIndex: 0,
  targetContent: childBytes(tag),
});

/** A commit over a tree naming every packed blob, `main` pointing at it. */
const referenceBlobs = async (ctx: Context, blobs: ReadonlyArray<string>): Promise<void> => {
  const tree = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: blobs.map((id, i) => treeEntry(FILE_MODE.REGULAR, `f${i}`, id as ObjectId)),
  });
  const commit = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author: AUTHOR, committer: AUTHOR, message: 'c1', extraHeaders: [] },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commit}\n`);
};

const corruptBaseBody = async (ctx: Context): Promise<void> => {
  const path = `${ctx.layout.gitDir}/objects/pack/pack-fam.pack`;
  const bytes = await ctx.fs.read(path);
  bytes[PACK_HEADER + 3] = bytes[PACK_HEADER + 3]! ^ 0xff;
  await ctx.fs.write(path, bytes);
  refreshPackRegistry(ctx);
};

const familyWithCorruptBase = async (
  ctx: Context,
): Promise<{ ctx: Context; ids: ReadonlyArray<string> }> => {
  const entries: EntrySpec[] = [
    { kind: 'base', type: 'blob', content: baseBytes },
    ofsChild('one'),
    ofsChild('two'),
  ];
  const ids = await writeSyntheticPack(ctx, 'fam', entries);
  await referenceBlobs(ctx, ids);
  await corruptBaseBody(ctx);
  return { ctx, ids };
};

describe('Given a corrupt delta base with two delta children, all reachable', () => {
  describe('When fsck runs', () => {
    it('Then only the base is missing and the exit code is 3', async () => {
      // Arrange
      const { ctx, ids } = await familyWithCorruptBase(createMemoryContext());
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((f) => f.type === 'missing')).toEqual([
        { type: 'missing', id: ids[0], objectType: 'blob' },
      ]);
      expect(result.exitCode).toBe(3);
    });
  });
});

describe('Given the same corrupt delta base with a loose copy beside it', () => {
  describe('When fsck runs', () => {
    it('Then nothing is missing, as another copy holds the object', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: baseBytes });
      await familyWithCorruptBase(ctx);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((f) => f.type === 'missing')).toEqual([]);
      expect(result.exitCode).toBe(1);
    });
  });
});

describe('Given a lone non-delta blob with a corrupt body, referenced by a commit', () => {
  describe('When fsck runs', () => {
    it('Then it is not missing and the exit code is 1', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const ids = await writeSyntheticPack(ctx, 'fam', [
        { kind: 'base', type: 'blob', content: baseBytes },
      ]);
      await referenceBlobs(ctx, ids);
      await corruptBaseBody(ctx);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((f) => f.type === 'missing')).toEqual([]);
      expect(result.exitCode).toBe(1);
    });
  });
});
