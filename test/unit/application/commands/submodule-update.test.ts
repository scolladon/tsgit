import { describe, expect, it } from 'vitest';
import { clone } from '../../../../src/application/commands/clone.js';
import { submoduleUpdate } from '../../../../src/application/commands/submodule.js';
import { readConfig } from '../../../../src/application/primitives/config-read.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { deriveSubmoduleCloneContext } from '../../../../src/application/primitives/internal/submodule-context.js';
import { materializeWorktreeFromHead } from '../../../../src/application/primitives/materialize-worktree-from-head.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateConfigOperations } from '../../../../src/application/primitives/update-config.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { HttpTransport } from '../../../../src/ports/http-transport.js';
import { buildSeededContext } from '../primitives/fixtures.js';
import { buildDivergentRemote, buildSubmoduleRemote } from './submodule-network-fixture.js';

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

  describe('When a decoy gitlink at a different path precedes the target', () => {
    it('Then the pin comes from the matching gitlink, not just any gitlink', async () => {
      // Arrange — an unrelated gitlink (bogus oid) sorts before "lib" in the index
      const { ctx, pinned } = await seedSuper({ register: true });
      const lock = await acquireIndexLock(ctx);
      await lock.commit([
        entry('README', pinned, FILE_MODE.REGULAR),
        entry('a-decoy', BOGUS_OID, FILE_MODE.GITLINK),
        entry('lib', pinned, FILE_MODE.GITLINK),
      ]);

      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });

      // Assert — "lib" reconciled to ITS pin, not the decoy's bogus oid
      expect(result.entries[0]?.id).toBe(pinned);
    });
  });

  describe('When --init runs with a second, unselected submodule declared', () => {
    it('Then only the selected submodule is registered', async () => {
      // Arrange — declare a second submodule that the paths filter excludes
      const { ctx } = await seedSuper({ register: false });
      await ctx.fs.appendUtf8(
        `${ctx.layout.workDir}/.gitmodules`,
        '[submodule "other"]\n\tpath = other\n\turl = ../other\n',
      );

      // Act
      await submoduleUpdate(ctx, { paths: ['lib'], init: true });

      // Assert — init was scoped to "lib"; "other" stays absent from config
      const config = await readConfig(ctx);
      expect(config.submodule?.get('lib')?.url).toBe(SUB_URL);
      expect(config.submodule?.get('other')?.url).toBeUndefined();
    });
  });

  describe('When --init reaches a pinned row whose .gitmodules has no url', () => {
    it('Then the empty-string url fallback yields an empty clone url that advertises no refs', async () => {
      // Arrange — pin present in the index, but .gitmodules declares no url, so
      // both config and row url are undefined and the `?? ''` fallback is used.
      const { ctx } = await seedSuper({ register: false });
      await ctx.fs.writeUtf8(
        `${ctx.layout.workDir}/.gitmodules`,
        '[submodule "lib"]\n\tpath = lib\n',
      );

      // Act — the empty url is passed to clone, whose discovery finds no refs
      let caught: unknown;
      try {
        await submoduleUpdate(ctx, { paths: ['lib'], init: true });
      } catch (err) {
        caught = err;
      }

      // Assert — the empty fallback (not a stray non-empty literal) reached clone
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('REMOTE_ADVERTISES_NO_REFS');
    });
  });
});

describe('Given a bare superproject', () => {
  describe('When update runs', () => {
    it('Then it refuses with BARE_REPOSITORY naming the operation', async () => {
      // Arrange — a bare repo (core.bare=true) with a HEAD
      const base = await buildSeededContext();
      await base.fs.writeUtf8(`${base.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      await base.fs.writeUtf8(`${base.layout.gitDir}/config`, '[core]\n\tbare = true\n');

      // Act
      let caught: unknown;
      try {
        await submoduleUpdate(base, { paths: ['lib'] });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toMatchObject({
        code: 'BARE_REPOSITORY',
        operation: 'submodule update',
      });
    });
  });
});

/**
 * Seed a superproject whose submodule `lib` pins the divergent `m2`, while the
 * module clones onto `main` (m1) — so a rebase/merge reconciliation is real.
 */
const seedDivergent = async (update: string): Promise<{ ctx: Context; m2: ObjectId }> => {
  const base = await buildSeededContext();
  const remote = await buildDivergentRemote(base);
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
  await base.fs.writeUtf8(
    `${base.layout.workDir}/.gitmodules`,
    `[submodule "lib"]\n\tpath = lib\n\turl = ${SUB_URL}\n\tupdate = ${update}\n`,
  );
  const lock = await acquireIndexLock(base);
  await lock.commit([
    entry('README', blob, FILE_MODE.REGULAR),
    entry('lib', remote.m2, FILE_MODE.GITLINK),
  ]);
  await updateConfigOperations(base, [
    { kind: 'set', section: 'submodule', subsection: 'lib', key: 'url', value: SUB_URL },
  ]);
  const ctx = withTransport(base, remote.transport);
  // Pre-clone the module on branch `main` and give it a local `[user]` (a real
  // user has a global identity; tsgit's readConfig is local-only). The reconcile
  // update then sees the module already cloned and rebases/merges onto the pin.
  const child = deriveSubmoduleCloneContext(ctx, 'lib', 'lib' as FilePath);
  await clone(child, { url: SUB_URL });
  await child.fs.appendUtf8(
    `${child.layout.gitDir}/config`,
    `[user]\n\tname = ${IDENTITY.name}\n\temail = ${IDENTITY.email}\n`,
  );
  await materializeWorktreeFromHead(child);
  return { ctx, m2: remote.m2 };
};

describe('Given a submodule whose branch diverges from the pinned commit', () => {
  describe('When update --rebase reconciles it', () => {
    it('Then it replays the branch onto the pin (linear), keeping both sides', async () => {
      // Arrange
      const { ctx } = await seedDivergent('rebase');
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });
      // Assert
      expect(result.entries[0]).toMatchObject({ mode: 'rebase', changed: true });
      const reflog = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/lib/logs/HEAD`);
      expect(reflog).toContain('rebase');
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/lib/a.txt`)).toBe('a only\n');
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/lib/m.txt`)).toBe('m only\n');
    });
  });

  describe('When update --merge reconciles it', () => {
    it('Then it creates a merge commit (two parents) on the branch', async () => {
      // Arrange
      const { ctx, m2 } = await seedDivergent('merge');
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });
      // Assert
      expect(result.entries[0]).toMatchObject({ mode: 'merge', changed: true });
      const reflog = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/lib/logs/HEAD`);
      expect(reflog).toContain('merge');
      const child = deriveSubmoduleCloneContext(ctx, 'lib', 'lib' as FilePath);
      const head = await readObject(child, await resolveRef(child, 'HEAD' as RefName));
      if (head.type !== 'commit') throw new Error('expected a commit at HEAD');
      expect(head.data.parents).toHaveLength(2);
      expect(head.data.parents).toContain(m2);
    });
  });

  describe('When opts.mode overrides a configured update mode', () => {
    it('Then --checkout overrides update=none and detaches at the pin', async () => {
      // Arrange
      const { ctx, m2 } = await seedDivergent('none');
      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'], mode: 'checkout' });
      // Assert
      expect(result.entries[0]).toMatchObject({ mode: 'checkout', changed: true });
      expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/lib/HEAD`)).toBe(`${m2}\n`);
    });
  });
});

describe('Given a freshly cloned submodule already sitting at the pinned commit', () => {
  describe('When update --merge finds nothing to reconcile', () => {
    it('Then the merge moves nothing and reports changed false', async () => {
      // Arrange — the clone lands HEAD on the pin, so merging the pin is a
      // no-op and HEAD does not move.
      const { ctx } = await seedSuper({ register: true, update: 'merge' });

      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });

      // Assert — the reconciliation observed no HEAD movement.
      expect(result.entries[0]).toMatchObject({
        mode: 'merge',
        changed: false,
        cloned: true,
      });
    });
  });
});

/**
 * Seed a superproject pinning submodule `lib` (`.gitmodules` on disk, gitlink in
 * the index, HEAD on `main`) whose `.git/config` is the verbatim `configText` —
 * so a present-but-valueless `submodule.lib.url` can be expressed (git's CLI /
 * `updateConfigOperations` cannot emit a valueless entry, file-write is
 * mandatory). The pin is the remote's `main` commit so a checkout-mode update has
 * a real source.
 */
const seedSuperWithConfigText = async (configText: string): Promise<Context> => {
  const base = await buildSeededContext();
  const remote = await buildSubmoduleRemote(base, {
    branches: [{ name: 'main', file: 'lib.txt', content: 'lib v1\n' }],
    head: 'main',
  });
  const pinned = remote.commits.get('main') as ObjectId;
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
  await base.fs.writeUtf8(
    `${base.layout.workDir}/.gitmodules`,
    `[submodule "lib"]\n\tpath = lib\n\turl = ${SUB_URL}\n`,
  );
  const lock = await acquireIndexLock(base);
  await lock.commit([
    entry('README', blob, FILE_MODE.REGULAR),
    entry('lib', pinned, FILE_MODE.GITLINK),
  ]);
  await base.fs.writeUtf8(`${base.layout.gitDir}/config`, configText);
  return withTransport(base, remote.transport);
};

/**
 * Controls line numbers: the valueless `url` lands at line 4.
 * Line 1: [core]
 * Line 2: \trepositoryformatversion = 0
 * Line 3: [submodule "lib"]
 * Line 4: \turl           <- valueless
 */
const VALUELESS_URL_CONFIG = '[core]\n\trepositoryformatversion = 0\n[submodule "lib"]\n\turl\n';
const VALUELESS_URL_LINE = 4;

/** Same shape but a valued url — the guard must no-op. */
const VALUED_URL_CONFIG = `[core]\n\trepositoryformatversion = 0\n[submodule "lib"]\n\turl = ${SUB_URL}\n`;

/** `[submodule "lib"]` present but no url line — the absent case. */
const ABSENT_URL_CONFIG = '[core]\n\trepositoryformatversion = 0\n[submodule "lib"]\n';

describe('Given a superproject whose submodule.lib.url is present-but-valueless', () => {
  describe('When submoduleUpdate reaches the url-undefined branch', () => {
    it('Then it refuses with CONFIG_MISSING_VALUE naming submodule.lib.url at its line', async () => {
      // Arrange
      const ctx = await seedSuperWithConfigText(VALUELESS_URL_CONFIG);

      // Act
      let caught: unknown;
      try {
        await submoduleUpdate(ctx, { paths: ['lib'] });
      } catch (err) {
        caught = err;
      }

      // Assert — each field individually (mutation-resistant)
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        code: string;
        key: string;
        line: number;
        source: string;
      };
      expect(data.code).toBe('CONFIG_MISSING_VALUE');
      expect(data.key).toBe('submodule.lib.url');
      expect(data.line).toBe(VALUELESS_URL_LINE);
      expect(data.source).toMatch(/\/config$/);
    });
  });
});

describe('Given a superproject whose submodule.lib.url is valued', () => {
  describe('When submoduleUpdate runs', () => {
    it('Then the url guard no-ops and the pin is checked out', async () => {
      // Arrange
      const ctx = await seedSuperWithConfigText(VALUED_URL_CONFIG);

      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });

      // Assert — no CONFIG_MISSING_VALUE; the valued url resolved to a clone
      expect(result.entries[0]).toMatchObject({ cloned: true, changed: true, mode: 'checkout' });
    });
  });
});

describe('Given a superproject with [submodule "lib"] but no url (absent)', () => {
  describe('When submoduleUpdate runs without init', () => {
    it('Then the guard no-ops and the unregistered submodule is skipped', async () => {
      // Arrange
      const ctx = await seedSuperWithConfigText(ABSENT_URL_CONFIG);

      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'] });

      // Assert — absent url skips the row, no death
      expect(result.entries).toHaveLength(0);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules`)).toBe(false);
    });
  });
});

/**
 * Seed a superproject pinning submodule `lib` (gitlink at the remote's `main`
 * commit) with an independently-controlled `.gitmodules` update mode and config
 * update mode. The pin matches the remote tip, so a `checkout`-mode update clones
 * and detaches (`changed: true`), while a `none`-mode update skips
 * (`changed: false, cloned: false`) — the observable difference that proves which
 * mode won the precedence chain. `gitmodulesMode`/`configMode` of `undefined`
 * omit the respective `update` line.
 */
const seedSuperWithModes = async (opts: {
  readonly gitmodulesMode?: string;
  readonly configMode?: string;
}): Promise<Context> => {
  const base = await buildSeededContext();
  const remote = await buildSubmoduleRemote(base, {
    branches: [{ name: 'main', file: 'lib.txt', content: 'lib v1\n' }],
    head: 'main',
  });
  const pinned = remote.commits.get('main') as ObjectId;
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
  const gmUpdate = opts.gitmodulesMode !== undefined ? `\tupdate = ${opts.gitmodulesMode}\n` : '';
  await base.fs.writeUtf8(
    `${base.layout.workDir}/.gitmodules`,
    `[submodule "lib"]\n\tpath = lib\n\turl = ${SUB_URL}\n${gmUpdate}`,
  );
  const lock = await acquireIndexLock(base);
  await lock.commit([
    entry('README', blob, FILE_MODE.REGULAR),
    entry('lib', pinned, FILE_MODE.GITLINK),
  ]);
  const cfgUpdate = opts.configMode !== undefined ? `\tupdate = ${opts.configMode}\n` : '';
  await base.fs.writeUtf8(
    `${base.layout.gitDir}/config`,
    `[submodule "lib"]\n\turl = ${SUB_URL}\n${cfgUpdate}`,
  );
  return withTransport(base, remote.transport);
};

describe('Given a superproject whose submodule update mode is sourced from config', () => {
  describe('When submoduleUpdate resolves the mode-precedence chain (CLI > config > .gitmodules > default)', () => {
    it.each([
      {
        label: 'config update=checkout overrides .gitmodules update=none',
        seedOpts: { gitmodulesMode: 'none', configMode: 'checkout' },
        actOpts: { paths: ['lib'] },
        expected: { mode: 'checkout', changed: true, cloned: true },
        checkNoModules: false,
      },
      {
        label: 'config update=none overrides .gitmodules update=checkout',
        seedOpts: { gitmodulesMode: 'checkout', configMode: 'none' },
        actOpts: { paths: ['lib'] },
        expected: { mode: 'none', changed: false, cloned: false },
        checkNoModules: true,
      },
      {
        label: 'opts.mode (CLI) overrides config update=none',
        seedOpts: { configMode: 'none' },
        actOpts: { paths: ['lib'], mode: 'checkout' },
        expected: { mode: 'checkout', changed: true, cloned: true },
        checkNoModules: false,
      },
      {
        label: 'only config sets the update mode (.gitmodules unset)',
        seedOpts: { configMode: 'none' },
        actOpts: { paths: ['lib'] },
        expected: { mode: 'none', changed: false, cloned: false },
        checkNoModules: false,
      },
      {
        label: 'only .gitmodules sets the update mode (config unset)',
        seedOpts: { gitmodulesMode: 'none' },
        actOpts: { paths: ['lib'] },
        expected: { mode: 'none', changed: false, cloned: false },
        checkNoModules: false,
      },
      {
        label: 'neither config nor .gitmodules sets the update mode (checkout default)',
        seedOpts: {},
        actOpts: { paths: ['lib'] },
        expected: { mode: 'checkout', changed: true, cloned: true },
        checkNoModules: false,
      },
    ] as const)('Then $label', async ({ seedOpts, actOpts, expected, checkNoModules }) => {
      // Arrange
      const ctx = await seedSuperWithModes(seedOpts);

      // Act
      const result = await submoduleUpdate(ctx, actOpts);

      // Assert
      expect(result.entries[0]).toMatchObject(expected);
      if (checkNoModules) {
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules`)).toBe(false);
      }
    });
  });

  describe('When the config update mode is an unrecognised value', () => {
    it('Then it refuses with INVALID_OPTION naming submodule.lib.update', async () => {
      // Arrange
      const ctx = await seedSuperWithModes({ configMode: 'bogus' });

      // Act
      let caught: unknown;
      try {
        await submoduleUpdate(ctx, { paths: ['lib'] });
      } catch (err) {
        caught = err;
      }

      // Assert — each field individually (mutation-resistant)
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        code: string;
        option: string;
        reason: string;
      };
      expect(data.code).toBe('INVALID_OPTION');
      expect(data.option).toBe('submodule.lib.update');
      expect(data.reason).toContain("invalid value 'bogus'");
    });
  });

  describe('When opts.mode shadows an unrecognised config update mode', () => {
    it('Then the CLI mode wins and the config value is never validated', async () => {
      // Arrange
      const ctx = await seedSuperWithModes({ configMode: 'bogus' });

      // Act
      const result = await submoduleUpdate(ctx, { paths: ['lib'], mode: 'checkout' });

      // Assert — git does not validate a config value a CLI mode shadows
      expect(result.entries[0]).toMatchObject({ mode: 'checkout', changed: true });
    });
  });
});

/**
 * Controls line numbers for the valueless `submodule.lib.update` case.
 * Line 1: [core]
 * Line 2: \trepositoryformatversion = 0
 * Line 3: [submodule "lib"]
 * Line 4: \turl = <SUB_URL>
 * Line 5: \tupdate          <- valueless
 */
const VALUELESS_UPDATE_CONFIG = `[core]\n\trepositoryformatversion = 0\n[submodule "lib"]\n\turl = ${SUB_URL}\n\tupdate\n`;
const VALUELESS_UPDATE_LINE = 5;

describe('Given a superproject whose submodule.lib.update is present-but-valueless', () => {
  describe('When submoduleUpdate resolves the update mode', () => {
    it('Then it refuses with CONFIG_MISSING_VALUE naming submodule.lib.update at its line', async () => {
      // Arrange
      const ctx = await seedSuperWithConfigText(VALUELESS_UPDATE_CONFIG);

      // Act
      let caught: unknown;
      try {
        await submoduleUpdate(ctx, { paths: ['lib'] });
      } catch (err) {
        caught = err;
      }

      // Assert — each field individually (mutation-resistant)
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        code: string;
        key: string;
        line: number;
        source: string;
      };
      expect(data.code).toBe('CONFIG_MISSING_VALUE');
      expect(data.key).toBe('submodule.lib.update');
      expect(data.line).toBe(VALUELESS_UPDATE_LINE);
      expect(data.source).toMatch(/\/config$/);
    });
  });
});

/**
 * Co-occurrence fixtures pinning git's UPDATE-PRIORITY ordering: `git submodule
 * update` reads `submodule.<n>.update` BEFORE `url` and reports it with strict
 * priority regardless of file-line order — even when `url` is valueless on an
 * earlier line. It reports `url` only when `update` is valued/absent.
 *
 * url@L4 valueless, update@L5 valueless → reports update (NOT the earlier url).
 */
const URL_THEN_UPDATE_VALUELESS_CONFIG =
  '[core]\n\trepositoryformatversion = 0\n[submodule "lib"]\n\turl\n\tupdate\n';
/** update@L4 valueless, url@L5 valueless → reports update. */
const UPDATE_THEN_URL_VALUELESS_CONFIG =
  '[core]\n\trepositoryformatversion = 0\n[submodule "lib"]\n\tupdate\n\turl\n';
/** url@L4 valueless, update absent → reports url (the url path still works). */
const URL_VALUELESS_UPDATE_ABSENT_CONFIG =
  '[core]\n\trepositoryformatversion = 0\n[submodule "lib"]\n\turl\n';

describe('Given a superproject whose submodule.lib has co-occurring valueless keys', () => {
  describe('When submoduleUpdate resolves the valueless-key priority', () => {
    it.each([
      {
        label:
          'url valueless on an earlier line than a valueless update reports update, not the earlier-line url',
        config: URL_THEN_UPDATE_VALUELESS_CONFIG,
        key: 'submodule.lib.update',
      },
      {
        label: 'update valueless on an earlier line than a valueless url reports update',
        config: UPDATE_THEN_URL_VALUELESS_CONFIG,
        key: 'submodule.lib.update',
      },
      {
        label: 'url valueless and update absent reports url (the url path still refuses)',
        config: URL_VALUELESS_UPDATE_ABSENT_CONFIG,
        key: 'submodule.lib.url',
      },
    ])('Then it reports $key ($label)', async ({ config, key }) => {
      // Arrange
      const ctx = await seedSuperWithConfigText(config);

      // Act
      let caught: unknown;
      try {
        await submoduleUpdate(ctx, { paths: ['lib'] });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as { code: string; key: string };
      expect(data.code).toBe('CONFIG_MISSING_VALUE');
      expect(data.key).toBe(key);
    });
  });
});
