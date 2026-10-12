/**
 * `root` and `tagged` findings: git prints them from `fsck_obj`, which a full
 * fsck runs on every object it checks — reachable or not — and which stops
 * short of them when the object's own content check raised an error.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath, objectsDir } from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ENCODER = new TextEncoder();
const IDENT = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const ABSENT = '1'.repeat(40) as ObjectId;

const repoWithMain = async (): Promise<{ ctx: Context; treeId: ObjectId }> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const treeId = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/refs/heads/main`,
    `${await commitOn(ctx, treeId, 'main')}\n`,
  );
  return { ctx, treeId };
};

const commitOn = (ctx: Context, tree: ObjectId, message: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author: IDENT, committer: IDENT, message, extraHeaders: [] },
  });

const tagOf = (ctx: Context, object: ObjectId): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: { object, objectType: 'commit', tagName: 'v', message: 'm', extraHeaders: [] },
  });

/** A root commit whose author line lacks the space before its email — an error. */
const plantBadRootCommit = async (ctx: Context, tree: ObjectId): Promise<ObjectId> => {
  const body = ENCODER.encode(
    `tree ${tree}\nauthor Ada<ada@example.com> 1700000000 +0000\ncommitter Ada <ada@example.com> 1700000000 +0000\n\nm\n`,
  );
  const raw = new Uint8Array([...ENCODER.encode(`commit ${body.length}\0`), ...body]);
  const id = (await ctx.hash.hashHex(raw)) as ObjectId;
  await ctx.fs.mkdir(objectsDir(ctx.layout.gitDir, id.slice(0, 2)));
  await ctx.fs.writeExclusive(
    looseObjectPath(ctx.layout.gitDir, id),
    await ctx.compressor.deflate(raw),
  );
  return id;
};

const rootIds = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings.flatMap((f) => (f.type === 'root' ? [f.id] : []));

describe('Given an unreachable root commit', () => {
  describe('When a full fsck runs', () => {
    it('Then it reports the commit as a root', async () => {
      // Arrange
      const { ctx, treeId } = await repoWithMain();
      const orphan = await commitOn(ctx, treeId, 'orphan');
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(rootIds(result.findings)).toContain(orphan);
    });
  });
});

describe('Given an unreachable tag naming an absent commit', () => {
  describe('When a full fsck runs', () => {
    it('Then it reports the tagged target', async () => {
      // Arrange
      const { ctx } = await repoWithMain();
      const tag = await tagOf(ctx, ABSENT);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toContainEqual({
        type: 'tagged',
        id: ABSENT,
        objectType: 'commit',
        tagName: 'v',
        tag,
      });
    });
  });
});

describe('Given a reachable root commit whose content check fails', () => {
  describe('When a full fsck runs', () => {
    it('Then it does not report the commit as a root', async () => {
      // Arrange
      const { ctx, treeId } = await repoWithMain();
      const bad = await plantBadRootCommit(ctx, treeId);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${bad}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(rootIds(result.findings)).not.toContain(bad);
    });
  });
});
