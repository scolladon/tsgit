import { describe, expect, it } from 'vitest';
import { submoduleAdd } from '../../../../src/application/commands/submodule.js';
import { readConfig } from '../../../../src/application/primitives/config-read.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
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
const IDENTITY = {
  name: 'Super',
  email: 'super@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const withTransport = (ctx: Context, transport: HttpTransport): Context => ({ ...ctx, transport });

const indexEntry = (path: string, id: ObjectId): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

/** Seed a superproject (one committed README) and attach the submodule remote. */
const seedSuper = async (
  opts: { readonly head?: string } = {},
): Promise<{ ctx: Context; remote: Awaited<ReturnType<typeof buildSubmoduleRemote>> }> => {
  const base = await buildSeededContext();
  const remote = await buildSubmoduleRemote(base, {
    branches: [
      { name: 'main', file: 'lib.txt', content: 'lib v1\n' },
      { name: 'dev', file: 'lib.txt', content: 'lib dev\n' },
    ],
    head: opts.head ?? 'main',
  });
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
  const lock = await acquireIndexLock(base);
  await lock.commit([indexEntry('README', blob)]);
  return { ctx: withTransport(base, remote.transport), remote };
};

describe('Given a superproject and a submodule remote', () => {
  describe('When add clones a new submodule (default branch)', () => {
    it('Then it writes .gitmodules with path then raw url', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act
      await submoduleAdd(ctx, { url: SUB_URL, path: 'libs/sub' });
      // Assert
      const gitmodules = await ctx.fs.readUtf8(`${ctx.layout.workDir}/.gitmodules`);
      expect(gitmodules).toBe(`[submodule "libs/sub"]\n\tpath = libs/sub\n\turl = ${SUB_URL}\n`);
    });

    it('Then it registers the resolved url then active in .git/config', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act
      await submoduleAdd(ctx, { url: SUB_URL, path: 'libs/sub' });
      // Assert
      const config = await readConfig(ctx);
      expect(config.submodule?.get('libs/sub')?.url).toBe(SUB_URL);
      const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(raw).toContain('[submodule "libs/sub"]');
      const section = raw.slice(raw.indexOf('[submodule "libs/sub"]'));
      expect(section.indexOf('url =')).toBeLessThan(section.indexOf('active ='));
    });

    it('Then it stages the gitlink and the .gitmodules blob in the super index', async () => {
      // Arrange
      const { ctx, remote } = await seedSuper();
      // Act
      const result = await submoduleAdd(ctx, { url: SUB_URL, path: 'libs/sub' });
      // Assert
      const index = await readIndex(ctx);
      const gitlink = index.entries.find((e) => e.path === 'libs/sub');
      expect(gitlink?.mode).toBe(FILE_MODE.GITLINK);
      expect(gitlink?.id).toBe(remote.commits.get('main'));
      expect(result.id).toBe(remote.commits.get('main'));
      expect(index.entries.some((e) => e.path === '.gitmodules')).toBe(true);
    });

    it('Then it writes the absorbed module layout (core.worktree + gitfile + HEAD)', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act
      await submoduleAdd(ctx, { url: SUB_URL, path: 'libs/sub' });
      // Assert
      const moduleConfig = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/libs/sub/config`);
      expect(moduleConfig).toContain('worktree = ../../../../libs/sub');
      const gitfile = await ctx.fs.readUtf8(`${ctx.layout.workDir}/libs/sub/.git`);
      expect(gitfile).toBe('gitdir: ../../.git/modules/libs/sub\n');
      const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/libs/sub/HEAD`);
      expect(head).toBe('ref: refs/heads/main\n');
    });

    it('Then it materialises the submodule working tree on the remote-head branch', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act
      const result = await submoduleAdd(ctx, { url: SUB_URL, path: 'libs/sub' });
      // Assert
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/libs/sub/lib.txt`)).toBe('lib v1\n');
      expect(result.branch).toBe('main');
      expect(result.name).toBe('libs/sub');
      expect(result.url).toBe(SUB_URL);
    });
  });

  describe('When add is given an unsafe name', () => {
    it('Then it refuses without cloning', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act + Assert
      await expect(
        submoduleAdd(ctx, { url: SUB_URL, path: 'libs/sub', name: '../escape' }),
      ).rejects.toThrow(TsgitError);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules`)).toBe(false);
    });
  });

  describe('When add is given an unsafe path', () => {
    it('Then it refuses', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act + Assert
      await expect(submoduleAdd(ctx, { url: SUB_URL, path: '../escape' })).rejects.toThrow(
        TsgitError,
      );
    });
  });

  describe('When add is given an empty url', () => {
    it('Then it refuses', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act + Assert
      await expect(submoduleAdd(ctx, { url: '', path: 'libs/sub' })).rejects.toThrow(TsgitError);
    });
  });

  describe('When add is given an empty path', () => {
    it('Then it refuses', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act + Assert
      await expect(submoduleAdd(ctx, { url: SUB_URL, path: '' })).rejects.toThrow(TsgitError);
    });
  });

  describe('When the path is already tracked in the index', () => {
    it('Then it refuses with SUBMODULE_PATH_EXISTS before cloning', async () => {
      // Arrange
      const { ctx } = await seedSuper();
      // Act
      let caught: unknown;
      try {
        await submoduleAdd(ctx, { url: SUB_URL, path: 'README' });
      } catch (err) {
        caught = err;
      }
      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('SUBMODULE_PATH_EXISTS');
      expect((caught as TsgitError).data).toMatchObject({ path: 'README' });
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules`)).toBe(false);
    });
  });
});
