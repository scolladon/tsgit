import { describe, expect, it } from 'vitest';
import { submoduleUpdate } from '../../../../src/application/commands/submodule.js';
import { readConfig } from '../../../../src/application/primitives/config-read.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { updateConfigOperations } from '../../../../src/application/primitives/update-config.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { HttpTransport } from '../../../../src/ports/http-transport.js';
import { buildSeededContext } from '../primitives/fixtures.js';
import { buildSubmoduleRemote } from './submodule-network-fixture.js';

const ENCODER = new TextEncoder();
const SUB_URL = 'https://remote.example/sub.git';
const BOGUS_OID = 'f'.repeat(40) as ObjectId;
const IDENTITY = {
  name: 'Super',
  email: 'super@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const withTransport = (ctx: Context, transport: HttpTransport): Context => ({ ...ctx, transport });

const entry = (
  path: string,
  id: ObjectId,
  mode: typeof FILE_MODE.REGULAR | typeof FILE_MODE.GITLINK,
): IndexEntry => ({
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
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

interface SeededSuper {
  readonly ctx: Context;
  readonly pinned: ObjectId;
}

/**
 * Seed a checked-out superproject pinning submodule `lib`: `.gitmodules` on disk,
 * the gitlink in the index, optionally registered config / an `update` mode. The
 * pin defaults to the remote's `main` commit (override for the missing-oid case).
 */
const seedSuper = async (
  opts: {
    readonly register?: boolean;
    readonly update?: string;
    readonly pinnedOverride?: ObjectId;
  } = {},
): Promise<SeededSuper> => {
  const base = await buildSeededContext();
  const remote = await buildSubmoduleRemote(base, {
    branches: [{ name: 'main', file: 'lib.txt', content: 'lib v1\n' }],
    head: 'main',
  });
  const pinned = opts.pinnedOverride ?? (remote.commits.get('main') as ObjectId);
  const blob = (await writeObject(base, {
    type: 'blob',
    id: '' as ObjectId,
    content: ENCODER.encode('root\n'),
  })) as ObjectId;
  const tree = await writeTree(base, [
    { name: 'README' as FilePath, id: blob, mode: FILE_MODE.REGULAR },
  ]);
  const commit = (await writeObject(base, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: 'init',
      extraHeaders: [],
    },
  })) as ObjectId;
  await base.fs.writeUtf8(`${base.layout.gitDir}/refs/heads/main`, `${commit}\n`);
  await base.fs.writeUtf8(`${base.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const updateLine = opts.update !== undefined ? `\tupdate = ${opts.update}\n` : '';
  await base.fs.writeUtf8(
    `${base.layout.workDir}/.gitmodules`,
    `[submodule "lib"]\n\tpath = lib\n\turl = ${SUB_URL}\n${updateLine}`,
  );
  const lock = await acquireIndexLock(base);
  await lock.commit([
    entry('README', blob, FILE_MODE.REGULAR),
    entry('lib', pinned, FILE_MODE.GITLINK),
  ]);
  if (opts.register === true) {
    await updateConfigOperations(base, [
      { kind: 'set', section: 'submodule', subsection: 'lib', key: 'url', value: SUB_URL },
    ]);
  }
  return { ctx: withTransport(base, remote.transport), pinned };
};

describe('Given a superproject pinning a registered submodule', () => {
  describe('When update clones the missing module and checks out the pin', () => {
    it('Then it detaches the module HEAD at the pinned oid and materialises the tree', async () => {
      // Arrange
      const { ctx, pinned } = await seedSuper({ register: true });
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });
      // Assert
      expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/lib/HEAD`)).toBe(`${pinned}\n`);
      expect(result.entries[0]).toMatchObject({ cloned: true, changed: true, mode: 'checkout' });
      expect(result.entries[0]?.id).toBe(pinned);
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/lib/lib.txt`)).toBe('lib v1\n');
    });

    it('Then a second update is an idempotent no-op', async () => {
      // Arrange
      const { ctx } = await seedSuper({ register: true });
      await submoduleUpdate(ctx, { paths: ['lib'] });
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });
      // Assert
      expect(result.entries[0]).toMatchObject({ cloned: false, changed: false });
    });
  });

  describe('When the submodule is not registered', () => {
    it('Then update without init skips it (not initialised)', async () => {
      // Arrange
      const { ctx } = await seedSuper({ register: false });
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });
      // Assert
      expect(result.entries).toHaveLength(0);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules`)).toBe(false);
    });

    it('Then update --init registers then clones it', async () => {
      // Arrange
      const { ctx, pinned } = await seedSuper({ register: false });
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'], init: true });
      // Assert
      const config = await readConfig(ctx);
      expect(config.submodule?.get('lib')?.url).toBe(SUB_URL);
      expect(result.entries[0]).toMatchObject({ cloned: true, changed: true });
      expect(result.entries[0]?.id).toBe(pinned);
    });
  });

  describe('When update=none is configured', () => {
    it('Then the submodule is skipped without cloning', async () => {
      // Arrange
      const { ctx } = await seedSuper({ register: true, update: 'none' });
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });
      // Assert
      expect(result.entries[0]).toMatchObject({ mode: 'none', changed: false, cloned: false });
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules`)).toBe(false);
    });
  });

  describe('When a path is not a submodule', () => {
    it('Then update refuses with PATHSPEC_NO_MATCH', async () => {
      // Arrange
      const { ctx } = await seedSuper({ register: true });
      // Act
      let caught: unknown;
      try {
        await submoduleUpdate(ctx, { paths: ['nope'] });
      } catch (err) {
        caught = err;
      }
      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PATHSPEC_NO_MATCH');
    });
  });

  describe('When the pinned oid is absent from the cloned objects', () => {
    it('Then update refuses with OBJECT_NOT_FOUND naming the oid', async () => {
      // Arrange
      const { ctx } = await seedSuper({ register: true, pinnedOverride: BOGUS_OID });
      // Act
      let caught: unknown;
      try {
        await submoduleUpdate(ctx, { paths: ['lib'] });
      } catch (err) {
        caught = err;
      }
      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      expect((caught as TsgitError).data).toMatchObject({ id: BOGUS_OID });
    });
  });
});
