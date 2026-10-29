/**
 * Findings git prints only from `fsck_obj` — `root` and `tagged` — never
 * appear under `connectivityOnly`, which never calls it.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** main at a root commit over the empty tree, and an annotated tag `v1` naming it. */
const taggedRootCommit = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const commit = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'c\n',
      extraHeaders: [],
    },
  });
  const tag = await writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: commit,
      objectType: 'commit',
      tagName: 'v1',
      tagger: AUTHOR,
      message: 't\n',
      extraHeaders: [],
    },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commit}\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${tag}\n`);
  return ctx;
};

const ROOT_OR_TAGGED = new Set(['root', 'tagged']);

describe('Given a tagged root commit', () => {
  describe('When fsck runs in full', () => {
    it('Then it reports the root and the tagged commit', async () => {
      // Arrange
      const ctx = await taggedRootCommit();
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(
        result.findings.map((finding) => finding.type).filter((type) => ROOT_OR_TAGGED.has(type)),
      ).toEqual(['root', 'tagged']);
    });
  });

  describe('When fsck runs connectivity-only', () => {
    it('Then it reports neither, as git never runs fsck_obj there', async () => {
      // Arrange
      const ctx = await taggedRootCommit();
      const sut = fsck;

      // Act
      const result = await sut(ctx, { connectivityOnly: true });

      // Assert
      expect(result.findings.filter((finding) => ROOT_OR_TAGGED.has(finding.type))).toEqual([]);
    });
  });
});

const unreferencedEmptyLooseBlob = async (): Promise<{ ctx: Context; id: ObjectId }> => {
  const ctx = createMemoryContext();
  const id = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode('orphan\n'),
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, id), new Uint8Array(0));
  return { ctx, id };
};

describe('Given an unreferenced empty loose object', () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then it refuses the loose object as corrupt, as git 2.56 does', async () => {
      // Arrange
      const { ctx, id } = await unreferencedEmptyLooseBlob();
      const sut = fsck;

      // Act
      const outcome = await sut(ctx, { connectivityOnly: true }).then(
        () => undefined,
        (err: unknown) => err,
      );

      // Assert
      expect(outcome).toBeInstanceOf(TsgitError);
      expect((outcome as TsgitError).data).toEqual({ code: 'LOOSE_OBJECT_CORRUPT', id });
    });
  });

  describe('When fsck runs in default mode', () => {
    it('Then it still reports the object and exits 1', async () => {
      // Arrange
      const { ctx, id } = await unreferencedEmptyLooseBlob();
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((finding) => 'id' in finding && finding.id === id)).toBe(true);
    });
  });
});
