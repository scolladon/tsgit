/**
 * A `/`-named remote under submodule verbs: git reads the superproject's
 * remote table only when a relative `.gitmodules` url needs a base, and at
 * most once per command — `update --init` registers every row in one process.
 */
import { describe, expect, it } from 'vitest';
import {
  submoduleInit,
  submoduleSync,
  submoduleUpdate,
} from '../../../../src/application/commands/submodule.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';

const WARNING = "readRemoteConfig: config remote shorthand cannot begin with '/'";
const SLASH_REMOTE = '[remote "/x"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/x/*\n';
const ORIGIN = '[remote "origin"]\n\turl = https://h.x/g/super.git\n';
const ONE_TABLE_READ = [
  [WARNING, { remote: '/x', key: 'url' }],
  [WARNING, { remote: '/x', key: 'fetch' }],
];
const PIN = '1111111111111111111111111111111111111111' as ObjectId;

const gitmodulesRow = (name: string, url: string): string =>
  `[submodule "${name}"]\n\tpath = ${name}\n\turl = ${url}\n\tupdate = none\n`;

const gitlink = (path: string): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.GITLINK,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: PIN,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

/** A superproject pinning `a` and `b` under the given urls, with a `/`-named remote. */
const seed = async (
  urls: { readonly a: string; readonly b: string },
  extraConfig = '',
): Promise<{ ctx: Context; warnings: unknown[][] }> => {
  __resetConfigCacheForTests();
  const warnings: unknown[][] = [];
  const base = await buildSeededContext();
  const ctx: Context = { ...base, logger: { warn: (...args) => warnings.push(args) } };
  const { workDir, gitDir } = ctx.layout;
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${gitDir}/config`, `${ORIGIN}${SLASH_REMOTE}${extraConfig}`);
  await ctx.fs.writeUtf8(
    `${workDir}/.gitmodules`,
    `${gitmodulesRow('a', urls.a)}${gitmodulesRow('b', urls.b)}`,
  );
  const lock = await acquireIndexLock(ctx);
  await lock.commit([gitlink('a'), gitlink('b')]);
  return { ctx, warnings };
};

const remoteWarnings = (warnings: ReadonlyArray<unknown[]>): unknown[][] =>
  warnings.filter(([message]) => message === WARNING);

const REGISTERED = '[submodule "a"]\n\turl = https://h.x/g/a\n[submodule "b"]\n\turl = /abs/b\n';

describe('Given a superproject configuring a /-named remote', () => {
  describe.each([
    {
      verb: 'init, two relative urls',
      urls: { a: '../a', b: './b' },
      run: submoduleInit,
      reads: 1,
    },
    {
      verb: 'init, absolute urls',
      urls: { a: '/abs/a', b: '/abs/b' },
      run: submoduleInit,
      reads: 0,
    },
    {
      verb: 'init, relative url already registered',
      urls: { a: '../a', b: '/abs/b' },
      config: REGISTERED,
      run: submoduleInit,
      reads: 0,
    },
    {
      verb: 'sync, relative url registered',
      urls: { a: '../a', b: '/abs/b' },
      config: REGISTERED,
      run: submoduleSync,
      reads: 1,
    },
    {
      verb: 'sync, absolute urls registered',
      urls: { a: '/abs/a', b: '/abs/b' },
      config: REGISTERED,
      run: submoduleSync,
      reads: 0,
    },
    {
      verb: 'update --init, two relative urls',
      urls: { a: '../a', b: './b' },
      run: (ctx: Context) => submoduleUpdate(ctx, { init: true }),
      reads: 1,
    },
  ])('When $verb runs', ({ urls, config, run, reads }) => {
    it(`Then it warns once per entry of that remote for each of its ${reads} remote-table reads`, async () => {
      // Arrange
      const { ctx, warnings } = await seed(urls, config);
      const sut = run;

      // Act
      await sut(ctx);

      // Assert
      expect(remoteWarnings(warnings)).toEqual(
        Array.from({ length: reads }, () => ONE_TABLE_READ).flat(),
      );
    });
  });
});
