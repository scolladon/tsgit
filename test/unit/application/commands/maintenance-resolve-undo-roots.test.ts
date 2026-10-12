import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  readGcSettings,
  runGcTask,
} from '../../../../src/application/commands/internal/gc-pipeline.js';
import { assertOperationalRepository } from '../../../../src/application/commands/internal/repo-state.js';
import { maintenance } from '../../../../src/application/commands/maintenance.js';
import { worktreeAdd } from '../../../../src/application/commands/worktree.js';
import { deriveWorktreeContext } from '../../../../src/application/primitives/internal/worktree-context.js';
import {
  commonGitDir,
  looseObjectPath,
} from '../../../../src/application/primitives/path-layout.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';

/** The gc task as `maintenance` runs it, its refusal surfaced rather than reported as a failed task. */
const gcTask = async (ctx: Context): Promise<unknown> => {
  await assertOperationalRepository(ctx);
  return runGcTask(ctx, { auto: undefined, settings: await readGcSettings(ctx) });
};

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const REGULAR = '100644';
const SYMLINK = '120000';
const ABSENT = '0123456789012345678901234567890123456789' as ObjectId;
const enc = new TextEncoder();

const seed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'seed', author: AUTHOR });
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[gc]\n  pruneExpire = now\n');
  return ctx;
};

const looseBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc.encode(content) });

const STAGE_COUNT = 3;
const UNUSED_STAGE = '0';

/** The three stage modes a `REUC` record always carries, unused ones as `0`. */
const modesOf = (stages: ReadonlyArray<readonly [string, ObjectId]>): ReadonlyArray<string> => [
  ...stages.map(([mode]) => mode),
  ...Array.from({ length: STAGE_COUNT - stages.length }, () => UNUSED_STAGE),
];

/** Rewrites `indexCtx`'s index with a `REUC` record for `a.txt` naming `stages`. */
const recordResolveUndo = async (
  indexCtx: Context,
  stages: ReadonlyArray<readonly [string, ObjectId]>,
): Promise<void> => {
  const index = await readIndex(indexCtx);
  const data = Uint8Array.from([
    ...enc.encode(`a.txt\0${modesOf(stages).join('\0')}\0`),
    ...stages.flatMap(([, id]) => [...hexToBytes(id)]),
  ]);
  const withReuc = { ...index, extensions: [{ signature: 'REUC', data }] };
  await indexCtx.fs.write(
    `${indexCtx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync(withReuc, indexCtx),
  );
};

const isKept = async (ctx: Context, id: ObjectId): Promise<boolean> =>
  readObject(ctx, id).then(
    () => true,
    () => false,
  );

describe('Given blobs only the index resolve-undo records name', () => {
  describe('When gc prunes everything unreachable', () => {
    it('Then every regular-file stage survives', async () => {
      // Arrange
      const ctx = await seed();
      const ids = [
        await looseBlob(ctx, 'base'),
        await looseBlob(ctx, 'ours'),
        await looseBlob(ctx, 'theirs'),
      ];
      await recordResolveUndo(
        ctx,
        ids.map((id) => [REGULAR, id] as const),
      );
      const sut = maintenance;

      // Act
      await sut(ctx, { tasks: ['gc'] });

      // Assert
      expect(await Promise.all(ids.map((id) => isKept(ctx, id)))).toEqual([true, true, true]);
    });
  });
});

describe('Given a blob only a resolve-undo symlink stage names', () => {
  describe('When gc prunes everything unreachable', () => {
    it('Then it is pruned, as git roots regular-file stages only', async () => {
      // Arrange
      const ctx = await seed();
      const id = await looseBlob(ctx, 'link-target');
      await recordResolveUndo(ctx, [[SYMLINK, id]]);
      const sut = maintenance;

      // Act
      await sut(ctx, { tasks: ['gc'] });

      // Assert
      expect(await ctx.fs.exists(looseObjectPath(commonGitDir(ctx), id))).toBe(false);
      expect(await isKept(ctx, id)).toBe(false);
    });
  });
});

describe("Given a blob only a linked worktree's resolve-undo names", () => {
  describe('When gc prunes everything unreachable from the main worktree', () => {
    it('Then it survives', async () => {
      // Arrange
      const ctx = await seed();
      const { id: worktreeId, path } = await worktreeAdd(ctx, { path: 'wt', detach: true });
      const id = await looseBlob(ctx, 'linked-only');
      await recordResolveUndo(deriveWorktreeContext(ctx, worktreeId, path), [[REGULAR, id]]);
      const sut = maintenance;

      // Act
      await sut(ctx, { tasks: ['gc'] });

      // Assert
      expect(await isKept(ctx, id)).toBe(true);
    });
  });
});

describe('Given a resolve-undo stage naming an absent blob', () => {
  describe('When gc runs', () => {
    it('Then it refuses, as git fails to read the object', async () => {
      // Arrange
      const ctx = await seed();
      await recordResolveUndo(ctx, [[REGULAR, ABSENT]]);
      const sut = gcTask;

      // Act
      let caught: unknown;
      try {
        await sut(ctx);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data).toMatchObject({ code: 'OBJECT_NOT_FOUND' });
    });
  });
});
