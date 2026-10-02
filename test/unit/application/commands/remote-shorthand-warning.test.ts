/**
 * A remote whose name begins with `/`: git never registers it, and warns once
 * per entry of it each time a command builds its remote table — `remote`,
 * `fetch`, `push`, `pull` (its own read, then fetch's), and an unforced
 * `branch -d` (its upstream check) — while commands that never read the table
 * (`branch -D`, `status` without tracking) stay silent.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchCreate, branchDelete } from '../../../../src/application/commands/branch.js';
import { fetch } from '../../../../src/application/commands/fetch.js';
import { pull } from '../../../../src/application/commands/pull.js';
import { push } from '../../../../src/application/commands/push.js';
import { remoteList, remoteSetUrl } from '../../../../src/application/commands/remote.js';
import { status } from '../../../../src/application/commands/status.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const WARNING = "readRemoteConfig: config remote shorthand cannot begin with '/'";
const PROMISOR_WARNING = "readPromisorRemoteNames: promisor remote name cannot begin with '/'";
const SLASH_REMOTE_CONFIG =
  '[remote "/x"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/x/*\n' +
  '[remote "y"]\n\turl = https://example.invalid/y.git\n\tfetch = +refs/heads/*:refs/remotes/y/*\n';
const ONE_TABLE_READ = [
  [WARNING, { remote: '/x', key: 'url' }],
  [WARNING, { remote: '/x', key: 'fetch' }],
];

/** A repository on `main` with a `side` branch, a `/`-named remote, and the remote warnings it logs. */
const repoWithSlashRemote = async (): Promise<{ ctx: Context; warnings: unknown[][] }> => {
  const warnings: unknown[][] = [];
  const base = createMemoryContext();
  const ctx: Context = { ...base, logger: { warn: (...args) => warnings.push(args) } };
  const { commitIds } = await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE }] });
  const tip = commitIds[0] as string;
  await seedRepo(ctx, { refs: { 'refs/heads/main': tip, 'refs/heads/side': tip } });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, SLASH_REMOTE_CONFIG);
  return { ctx, warnings };
};

const remoteWarnings = (warnings: ReadonlyArray<unknown[]>): unknown[][] =>
  warnings.filter(([message]) => message === WARNING);

describe('Given a repository configuring a /-named remote', () => {
  describe.each([
    { verb: 'remote list', run: (ctx: Context) => remoteList(ctx), reads: 1 },
    {
      verb: 'remote set-url',
      run: (ctx: Context) => remoteSetUrl(ctx, { name: 'y', url: 'https://example.invalid/z' }),
      reads: 1,
    },
    { verb: 'fetch', run: (ctx: Context) => fetch(ctx, { remote: 'y' }), reads: 1 },
    {
      verb: 'push',
      run: (ctx: Context) => push(ctx, { remote: 'y', refspecs: ['main'] }),
      reads: 1,
    },
    { verb: 'pull', run: (ctx: Context) => pull(ctx, { remote: 'y', ref: 'main' }), reads: 2 },
    { verb: 'branch -d', run: (ctx: Context) => branchDelete(ctx, { name: 'side' }), reads: 1 },
    { verb: 'branch z', run: (ctx: Context) => branchCreate(ctx, { name: 'z' }), reads: 1 },
    {
      verb: 'branch z main',
      run: (ctx: Context) => branchCreate(ctx, { name: 'z', startPoint: 'main' }),
      reads: 1,
    },
    {
      verb: 'branch z main~0',
      run: (ctx: Context) => branchCreate(ctx, { name: 'z', startPoint: 'main~0' }),
      reads: 0,
    },
    {
      verb: 'branch -D',
      run: (ctx: Context) => branchDelete(ctx, { name: 'side', force: true }),
      reads: 0,
    },
    { verb: 'status', run: (ctx: Context) => status(ctx), reads: 0 },
  ])('When $verb runs', ({ run, reads }) => {
    it(`Then it warns once per entry of that remote for each of its ${reads} remote-table reads`, async () => {
      // Arrange
      const { ctx, warnings } = await repoWithSlashRemote();
      const sut = run;

      // Act
      await Promise.allSettled([sut(ctx)]);

      // Assert
      expect(remoteWarnings(warnings)).toEqual(
        Array.from({ length: reads }, () => ONE_TABLE_READ).flat(),
      );
    });
  });
});

describe('Given a repository whose only remote is /-named', () => {
  describe('When remote list runs', () => {
    it('Then it lists no remote', async () => {
      // Arrange
      const { ctx } = await repoWithSlashRemote();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "/x"]\n\turl = u\n');
      const sut = remoteList;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result).toEqual({ remotes: [] });
    });
  });
});

describe('Given a repository configuring a /-named promisor remote', () => {
  describe('When fetch runs', () => {
    it("Then it warns the remote table's entries, then the promisor name git refuses", async () => {
      // Arrange
      const { ctx, warnings } = await repoWithSlashRemote();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        `${SLASH_REMOTE_CONFIG}[remote "/p"]\n\tpromisor = true\n`,
      );
      const sut = fetch;

      // Act
      await Promise.allSettled([sut(ctx, { remote: 'y' })]);

      // Assert
      expect(warnings).toEqual([
        ...ONE_TABLE_READ,
        [WARNING, { remote: '/p', key: 'promisor' }],
        [PROMISOR_WARNING, { remote: '/p' }],
      ]);
    });
  });
});

describe('Given an unusable refspec between two /-named remotes', () => {
  const CONFIG =
    '[remote "/a"]\n\turl = u\n' +
    '[remote "y"]\n\turl = /n/y\n\tpush = refs/heads/*:refs/x\n\tfetch = bad^\n' +
    '[remote "/b"]\n\turl = v\n';

  describe.each([
    { verb: 'remote list', run: (ctx: Context) => remoteList(ctx) },
    { verb: 'fetch', run: (ctx: Context) => fetch(ctx, { remote: 'y' }) },
    { verb: 'pull', run: (ctx: Context) => pull(ctx, { remote: 'y', ref: 'main' }) },
    { verb: 'branch z', run: (ctx: Context) => branchCreate(ctx, { name: 'z' }) },
    { verb: 'branch -d', run: (ctx: Context) => branchDelete(ctx, { name: 'side' }) },
  ])('When $verb builds the remote table', ({ run }) => {
    it('Then it warns up to the first unusable spec in config order and dies there', async () => {
      // Arrange
      const { ctx, warnings } = await repoWithSlashRemote();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, CONFIG);
      const sut = run;

      // Act
      const [outcome] = await Promise.allSettled([sut(ctx)]);

      // Assert
      expect(remoteWarnings(warnings)).toEqual([[WARNING, { remote: '/a', key: 'url' }]]);
      expect((outcome as PromiseRejectedResult).reason.data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: 'refs/heads/*:refs/x',
        reason: 'not a valid refspec',
      });
    });
  });
});

describe('Given an unusable refspec in the remote table', () => {
  const CONFIG = '[remote "y"]\n\turl = /n/y\n\tfetch = bad^\n';

  describe.each([
    { start: undefined, label: 'the omitted start point HEAD, on a branch', created: true },
    { start: 'side', label: 'a local branch', created: true },
    { start: 'y/main', label: 'a remote-tracking branch', created: false },
    { start: 'v1', label: 'a tag', created: false },
  ])('When branch z starts from $label', ({ start, created }) => {
    it(`Then it dies on the spec, ${created ? 'after' : 'before'} writing the branch, as git does`, async () => {
      // Arrange
      const { ctx } = await repoWithSlashRemote();
      const tip = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
      await seedRepo(ctx, {
        refs: { 'refs/remotes/y/main': tip.trim(), 'refs/tags/v1': tip.trim() },
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, CONFIG);
      const sut = branchCreate;

      // Act
      const [outcome] = await Promise.allSettled([
        sut(ctx, { name: 'z', ...(start !== undefined ? { startPoint: start } : {}) }),
      ]);

      // Assert
      expect((outcome as PromiseRejectedResult).reason.data.code).toBe('REFSPEC_INVALID');
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/z`)).toBe(created);
    });
  });
});
