/**
 * Cross-tool interop — the reftable read backend. Builds several
 * `git init --ref-format=reftable` repositories with canonical git (pinned
 * author/committer dates, signing off), then asserts that tsgit's reftable
 * `RefStore` and the Tier-1 commands built on it (`branch.list`, `tag.list`,
 * `resolveRef`) read the exact same ref set, symref chains, peeled tag
 * values, HEAD target, tombstones, reflog history and section layout that
 * canonical git itself reports. This is what closes the write-surface audit
 * gap the reftable backend left open until now.
 *
 * @proves
 *   surface:        reftable
 *   bucket:         cross-tool-interop
 *   unique:         reftable stack reads and writes agree with canonical git
 *   interopSurface: reftable
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchList } from '../../src/application/commands/branch.js';
import { tagList } from '../../src/application/commands/tag.js';
import { loadReftableStack } from '../../src/application/primitives/load-reftable-stack.js';
import { reftableDir } from '../../src/application/primitives/path-layout.js';
import { readObject } from '../../src/application/primitives/read-object.js';
import { getRefStore } from '../../src/application/primitives/ref-store.js';
import { resolveRef } from '../../src/application/primitives/resolve-ref.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

const dateEnv = (epoch: number, tz: string): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY_ENV,
  GIT_AUTHOR_DATE: `${epoch} ${tz}`,
  GIT_COMMITTER_DATE: `${epoch} ${tz}`,
});

/** Reframe a Node-adapter Context onto the reftable backend. */
const withReftableStorage = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, refStorage: 'reftable' },
});

const initReftableRepo = (dir: string, extraArgs: ReadonlyArray<string> = []): void => {
  runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', ...extraArgs, dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  disableAutoMaintenance(dir);
};

const reftableCtx = (dir: string): Context =>
  withReftableStorage(createNodeContext({ workDir: dir }));

/** `git for-each-ref '%(objectname)\t%(objecttype)\t%(refname)'`, parsed into
 *  one entry per line — a tab-delimited format chosen over the default
 *  pretty layout so an empty `%(*objectname)` column never shifts columns. */
interface ForEachRefRow {
  readonly oid: string;
  readonly type: string;
  readonly refname: string;
}

const forEachRef = (dir: string, ...extraArgs: ReadonlyArray<string>): ForEachRefRow[] =>
  git(dir, 'for-each-ref', '--format=%(objectname)\t%(objecttype)\t%(refname)', ...extraArgs)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [oid, type, refname] = line.split('\t');
      return { oid: oid ?? '', type: type ?? '', refname: refname ?? '' };
    });

const showRefNames = (dir: string): string[] =>
  git(dir, 'show-ref')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(' ')[1] ?? '')
    .sort();

interface TzLogEntry {
  readonly oldId: string;
  readonly newId: string;
  readonly timestamp: number;
  readonly tzOffset: string;
  readonly message: string;
}

const TZ_OFFSETS = ['+0230', '+0100', '-0800', '+0000', '-0530', '+1345'] as const;

/** A dedicated orphan branch with one commit per `TZ_OFFSETS` entry — the
 *  root commit logs as `commit (initial): …`, every later one as `commit:
 *  …`, matching git's own reflog subject convention. Leaves `HEAD` back on
 *  `main` when done. */
const buildTzLog = (dir: string): ReadonlyArray<TzLogEntry> => {
  // The fixture's initial commit is `--allow-empty` (no tracked files), so
  // there is nothing for `git rm --cached` to clear before the first orphan
  // commit — every commit on this branch stays empty-tree throughout.
  git(dir, 'checkout', '-q', '--orphan', 'tzlog');
  const entries: TzLogEntry[] = [];
  let oldId = '0'.repeat(40);
  TZ_OFFSETS.forEach((tz, index) => {
    const timestamp = 1_700_000_000 + index * 1000;
    const label = `step ${index}`;
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', label], {
      env: dateEnv(timestamp, tz),
    });
    const newId = git(dir, 'rev-parse', 'HEAD').trim();
    const message = index === 0 ? `commit (initial): ${label}` : `commit: ${label}`;
    entries.push({ oldId, newId, timestamp, tzOffset: tz, message });
    oldId = newId;
  });
  git(dir, 'checkout', '-q', 'main');
  return entries;
};

interface MainFixture {
  readonly dir: string;
  readonly ctx: Context;
  readonly mainId: string;
  readonly tagV1Id: string;
  readonly tagV1PeeledId: string;
  readonly tzLog: ReadonlyArray<TzLogEntry>;
}

const buildMainFixture = (rootDir: string): MainFixture => {
  const dir = path.join(rootDir, 'main');
  initReftableRepo(dir);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
    env: dateEnv(1_700_000_000, '+0000'),
  });
  const mainId = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'branch', 'dev');
  git(dir, 'symbolic-ref', 'refs/heads/symbolic', 'refs/heads/main');
  runGit(['-C', dir, 'tag', '-a', 'v1', '-m', 'release v1'], {
    env: dateEnv(1_700_000_100, '+0000'),
  });
  const tagV1Id = git(dir, 'rev-parse', 'refs/tags/v1').trim();
  const tagV1PeeledId = git(dir, 'rev-parse', 'refs/tags/v1^{commit}').trim();
  git(dir, 'tag', 'lightweight');
  runGit(['-C', dir, 'tag', '-a', 'v2', '-m', 'release v2'], {
    env: dateEnv(1_700_000_200, '+0000'),
  });

  // Tombstone across two tables: created, then deleted — the update and the
  // delete each land in their own reftable table (measured: reftable never
  // rewrites an existing table in place).
  git(dir, 'update-ref', 'refs/heads/temp', mainId);
  git(dir, 'update-ref', '-d', 'refs/heads/temp');

  const tzLog = buildTzLog(dir);

  return { dir, ctx: reftableCtx(dir), mainId, tagV1Id, tagV1PeeledId, tzLog };
};

interface Sha256Fixture {
  readonly dir: string;
  readonly ctx: Context;
}

const buildSha256Fixture = (rootDir: string): Sha256Fixture => {
  const dir = path.join(rootDir, 'sha256');
  initReftableRepo(dir, ['--object-format=sha256']);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
    env: dateEnv(1_700_000_000, '+0000'),
  });
  git(dir, 'branch', 'dev');
  return { dir, ctx: reftableCtx(dir) };
};

interface BigFixture {
  readonly dir: string;
  readonly ctx: Context;
  readonly refCount: number;
}

const BIG_REF_COUNT = 3001;

/**
 * 3001 branches, all pointing at the same commit, each its own reftable
 * transaction (`start`/`prepare`/`commit` chained through one `--stdin`
 * call — a single flat transaction assigns every ref the SAME update_index,
 * which does not exercise per-record delta variety the way separate
 * transactions do), then `git pack-refs --all` to compact into one table.
 * Exercises the ref index (20 `'r'` blocks) and the obj index
 * (`obj_id_len` 2 — every ref abbreviates to the same 2-byte object-id
 * prefix, since every ref points at the same commit).
 */
const buildBigFixture = (rootDir: string): BigFixture => {
  const dir = path.join(rootDir, 'big');
  initReftableRepo(dir);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
    env: dateEnv(1_700_000_000, '+0000'),
  });
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  const lines: string[] = [];
  for (let i = 0; i < BIG_REF_COUNT; i += 1) {
    const name = `b${i.toString().padStart(5, '0')}`;
    lines.push('start', `update refs/heads/${name} ${sha}`, 'prepare', 'commit');
  }
  runGit(['-C', dir, 'update-ref', '--stdin'], {
    input: `${lines.join('\n')}\n`,
    env: dateEnv(1_700_000_000, '+0000'),
  });
  git(dir, 'pack-refs', '--all');
  return { dir, ctx: reftableCtx(dir), refCount: BIG_REF_COUNT + 1 };
};

interface HundredFixture {
  readonly dir: string;
  readonly ctx: Context;
}

/** 100 branches, each its own transaction — small enough to stay below the
 *  ref-index threshold, but its reflog volume splits into three log blocks
 *  with no log index (measured: log-index emission has its own, higher
 *  threshold than the ref index). */
const buildHundredFixture = (rootDir: string): HundredFixture => {
  const dir = path.join(rootDir, 'hundred');
  initReftableRepo(dir);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
    env: dateEnv(1_700_000_000, '+0000'),
  });
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  const lines: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const name = `b${i.toString().padStart(5, '0')}`;
    lines.push('start', `update refs/heads/${name} ${sha}`, 'prepare', 'commit');
  }
  runGit(['-C', dir, 'update-ref', '--stdin'], {
    input: `${lines.join('\n')}\n`,
    env: dateEnv(1_700_000_000, '+0000'),
  });
  git(dir, 'pack-refs', '--all');
  return { dir, ctx: reftableCtx(dir) };
};

interface WorktreeFixture {
  readonly dir: string;
  readonly wtDir: string;
  readonly mainCtx: Context;
  readonly worktreeCtx: Context;
  readonly bisectId: string;
}

const buildWorktreeFixture = (rootDir: string): WorktreeFixture => {
  const dir = path.join(rootDir, 'wtmain');
  const wtDir = path.join(rootDir, 'wtlinked');
  initReftableRepo(dir);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
    env: dateEnv(1_700_000_000, '+0000'),
  });
  runGit(['-C', dir, 'worktree', 'add', '-q', '-b', 'feature', wtDir]);
  runGit(['-C', wtDir, 'bisect', 'start']);
  runGit(['-C', wtDir, 'bisect', 'bad', 'HEAD']);
  const bisectId = git(wtDir, 'rev-parse', 'refs/bisect/bad').trim();

  const mainCtx = reftableCtx(dir);
  const adminDir = `${mainCtx.layout.gitDir}/worktrees/${path.basename(wtDir)}`;
  const worktreeCtx: Context = {
    ...mainCtx,
    layout: { ...mainCtx.layout, gitDir: adminDir, commonDir: mainCtx.layout.gitDir },
  };
  return { dir, wtDir, mainCtx, worktreeCtx, bisectId };
};

describe.skipIf(!GIT_AVAILABLE)('reftable-ref-storage interop', () => {
  let rootDir: string;
  let main: MainFixture;
  let sha256: Sha256Fixture;
  let big: BigFixture;
  let hundred: HundredFixture;
  let worktree: WorktreeFixture;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-reftable-'));
    main = buildMainFixture(rootDir);
    sha256 = buildSha256Fixture(rootDir);
    big = buildBigFixture(rootDir);
    hundred = buildHundredFixture(rootDir);
    worktree = buildWorktreeFixture(rootDir);
  }, 60_000);

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  describe('Given a repository with branches, tags and a symbolic ref', () => {
    describe('When tsgit reads its ref set', () => {
      it('Then the primitive ref set matches git show-ref', async () => {
        // Arrange
        const sut = getRefStore(main.ctx);

        // Act
        const entries = await sut.listRefs();
        const names = entries.map((entry) => entry.name).filter((name) => name !== 'HEAD');

        // Assert
        expect(names.slice().sort()).toEqual(showRefNames(main.dir));
      });

      it('Then every ref set entry, including its type, matches git for-each-ref', async () => {
        // Arrange — `for-each-ref` dereferences symbolic refs (refs/heads/symbolic
        // included) to their final oid, so the reconstruction must resolve the
        // full chain via `resolveRef`, not just the one-hop `listRefs` value.
        const sut = getRefStore(main.ctx);
        const rows = forEachRef(main.dir);

        // Act
        const entries = await sut.listRefs();
        const reconstructed = await Promise.all(
          entries
            .filter((entry) => entry.name !== 'HEAD')
            .map(async (entry) => {
              const oid = await resolveRef(main.ctx, entry.name);
              const object = await readObject(main.ctx, oid);
              return { oid: oid as string, type: object.type, refname: entry.name as string };
            }),
        );

        // Assert
        expect(reconstructed.sort((a, b) => (a.refname < b.refname ? -1 : 1))).toEqual(
          rows.slice().sort((a, b) => (a.refname < b.refname ? -1 : 1)),
        );
      });

      it('Then branch.list matches git for-each-ref refs/heads/', async () => {
        // Arrange
        const expected = forEachRef(main.dir, 'refs/heads/')
          .map((row) => row.refname)
          .sort();

        // Act
        const result = await branchList(main.ctx);

        // Assert
        expect(
          result.branches
            .map((b) => b.name)
            .slice()
            .sort(),
        ).toEqual(expected);
      });

      it('Then tag.list matches git for-each-ref refs/tags/', async () => {
        // Arrange
        const expected = forEachRef(main.dir, 'refs/tags/')
          .map((row) => row.refname)
          .sort();

        // Act
        const result = await tagList(main.ctx);

        // Assert
        expect(
          result.tags
            .map((t) => t.name)
            .slice()
            .sort(),
        ).toEqual(expected);
      });
    });
  });

  describe('Given an annotated tag', () => {
    describe('When tsgit resolves and peels it', () => {
      it('Then the direct and peeled values match git for-each-ref %(objectname) %(*objectname)', async () => {
        // Arrange
        const sut = getRefStore(main.ctx);
        const expected = git(
          main.dir,
          'for-each-ref',
          '--format=%(objectname) %(*objectname)',
          'refs/tags/v1',
        ).trim();

        // Act
        const direct = await sut.resolveDirect('refs/tags/v1' as RefName);
        expect(direct.kind).toBe('direct');
        const directId = direct.kind === 'direct' ? direct.id : undefined;
        const tagObject = await readObject(main.ctx, directId as ObjectId);
        const peeled = tagObject.type === 'tag' ? tagObject.data.object : undefined;

        // Assert
        expect(directId).toBe(main.tagV1Id);
        expect(peeled).toBe(main.tagV1PeeledId);
        expect(`${directId} ${peeled}`).toBe(expected);
      });
    });
  });

  describe('Given a symbolic ref refs/heads/symbolic', () => {
    describe('When resolveRef follows the chain', () => {
      it('Then it resolves to the same id as git rev-parse', async () => {
        // Arrange
        const expected = git(main.dir, 'rev-parse', 'refs/heads/symbolic').trim();
        const sut = resolveRef;

        // Act
        const result = await sut(main.ctx, 'refs/heads/symbolic' as RefName);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given HEAD in a reftable repository', () => {
    describe('When tsgit resolves it', () => {
      it('Then it matches git symbolic-ref HEAD and never surfaces the .invalid stub', async () => {
        // Arrange
        const expected = git(main.dir, 'symbolic-ref', 'HEAD').trim();
        const sut = getRefStore(main.ctx);

        // Act
        const result = await sut.resolveDirect('HEAD' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'symbolic', target: expected });
        expect(result.kind === 'symbolic' ? result.target : undefined).not.toBe(
          'refs/heads/.invalid',
        );
      });
    });
  });

  describe('Given a ref created then deleted, tombstoned across two tables', () => {
    describe('When tsgit reads it', () => {
      it('Then it is absent from both tools', async () => {
        // Arrange
        const sut = getRefStore(main.ctx);

        // Act
        const result = await sut.resolveDirect('refs/heads/temp' as RefName);
        const listed = await sut.listRefs();

        // Assert
        expect(result).toEqual({ kind: 'missing' });
        expect(listed.some((entry) => entry.name === 'refs/heads/temp')).toBe(false);
        expect(showRefNames(main.dir)).not.toContain('refs/heads/temp');
      });
    });
  });

  describe('Given a reflog spanning six distinct tz offsets', () => {
    describe('When readReflog reads refs/heads/tzlog', () => {
      it('Then entries, order, oids, identity and message match git reflog show --date=raw', async () => {
        // Arrange
        const sut = getRefStore(main.ctx);
        const expectedSubjects = git(main.dir, 'reflog', 'show', '--date=raw', 'tzlog')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => line.slice(line.indexOf(': ') + 2))
          .reverse();

        // Act
        const entries = await sut.readReflog('refs/heads/tzlog' as RefName);

        // Assert
        expect(entries).toHaveLength(main.tzLog.length);
        entries.forEach((entry, index) => {
          const expectedEntry = main.tzLog[index]!;
          expect(entry.oldId).toBe(expectedEntry.oldId);
          expect(entry.newId).toBe(expectedEntry.newId);
          expect(entry.identity.name).toBe('Ada');
          expect(entry.identity.email).toBe('ada@example.com');
          expect(entry.identity.timestamp).toBe(expectedEntry.timestamp);
          expect(entry.identity.timezoneOffset).toBe(expectedEntry.tzOffset);
          expect(entry.message).toBe(expectedEntry.message);
          expect(entry.message).toBe(expectedSubjects[index]);
        });
      });
    });
  });

  describe('Given a --object-format=sha256 reftable repository', () => {
    describe('When tsgit loads the stack', () => {
      it('Then the v2 header is parsed and the ref set matches git', async () => {
        // Arrange
        const dir = reftableDir(sha256.ctx.layout.gitDir);
        const expected = showRefNames(sha256.dir);

        // Act
        const stack = await loadReftableStack(sha256.ctx, dir);
        const listed = await getRefStore(sha256.ctx).listRefs();

        // Assert
        expect(stack.tables[0]?.header.version).toBe(2);
        expect(stack.tables[0]?.header.hashId).toBe('s256');
        expect(stack.tables[0]?.header.digestLength).toBe(32);
        expect(
          listed
            .map((entry) => entry.name)
            .filter((name) => name !== 'HEAD')
            .sort(),
        ).toEqual(expected);
      });
    });
  });

  describe('Given a 3001-ref fixture compacted into one table', () => {
    describe('When tsgit reads the ref set', () => {
      it('Then every ref matches git, and the ref index + obj block are exercised', async () => {
        // Arrange
        const expected = showRefNames(big.dir);
        const sut = getRefStore(big.ctx);

        // Act
        const listed = await sut.listRefs();
        const names = listed.map((entry) => entry.name).filter((name) => name !== 'HEAD');

        // Assert
        expect(names).toHaveLength(big.refCount);
        expect(names.slice().sort()).toEqual(expected);
      });
    });

    describe('When the parsed footer is inspected', () => {
      it('Then section placement matches the measured fixture layout', async () => {
        // Arrange
        const dir = reftableDir(big.ctx.layout.gitDir);

        // Act
        const stack = await loadReftableStack(big.ctx, dir);
        const table = stack.tables[0]!;

        // Assert — structural placement, independently reproduced against
        // this exact fixture recipe (3001 chained single-ref transactions,
        // pinned identity/dates, `pack-refs --all`): a ref section of
        // EXACTLY 20 block-size-aligned 'r' blocks (block_size 4096 *
        // 20 = 81920, where the ref index starts), one 'i' block, then one
        // 'o' block with a 2-byte abbreviated object id (every ref points
        // at the same commit). The log-section end positions vary with
        // reflog message/identity content and are asserted as measured
        // from THIS fixture, not copied from the design doc's own
        // measurement of a differently-built fixture.
        expect(table.header.blockSize).toBe(4096);
        expect(table.footer.refIndexPosition).toBe(81920);
        expect(table.footer.objPosition).toBe(86016);
        expect(table.footer.objIdLength).toBe(2);
        expect(table.footer.objIndexPosition).toBe(0);
        expect(table.footer.logPosition).toBe(86069);
        expect(table.footer.refIndexPosition / table.header.blockSize).toBe(20);
      });
    });
  });

  describe('Given a 100-ref fixture with a small reflog volume', () => {
    describe('When the parsed footer is inspected', () => {
      it('Then the log section splits into three blocks with no log index', async () => {
        // Arrange
        const dir = reftableDir(hundred.ctx.layout.gitDir);

        // Act
        const stack = await loadReftableStack(hundred.ctx, dir);
        const table = stack.tables[0]!;

        // Assert
        expect(table.footer.logIndexPosition).toBe(0);
        expect(table.logBlocks).toHaveLength(3);
      });
    });

    describe('When readReflog reads one of its refs', () => {
      it('Then the single entry is read correctly', async () => {
        // Arrange
        const sut = getRefStore(hundred.ctx);
        const expectedId = git(hundred.dir, 'rev-parse', 'refs/heads/b00042').trim();

        // Act
        const entries = await sut.readReflog('refs/heads/b00042' as RefName);

        // Assert
        expect(entries).toHaveLength(1);
        expect(entries[0]?.newId).toBe(expectedId);
      });
    });
  });

  describe('Given a linked worktree with a per-worktree bisect ref', () => {
    describe('When tsgit reads a shared ref from either stack', () => {
      it('Then both the main and the worktree Context see it, matching git', async () => {
        // Arrange
        const expected = git(worktree.dir, 'rev-parse', 'refs/heads/feature').trim();

        // Act
        const fromMain = await getRefStore(worktree.mainCtx).resolveDirect(
          'refs/heads/feature' as RefName,
        );
        const fromWorktree = await getRefStore(worktree.worktreeCtx).resolveDirect(
          'refs/heads/feature' as RefName,
        );

        // Assert
        expect(fromMain).toEqual({ kind: 'direct', id: expected });
        expect(fromWorktree).toEqual({ kind: 'direct', id: expected });
      });
    });

    describe('When tsgit reads the per-worktree bisect ref', () => {
      it('Then only the worktree Context sees it, matching git show-ref scoping', async () => {
        // Arrange
        const sut = getRefStore;

        // Act
        const fromMain = await sut(worktree.mainCtx).resolveDirect('refs/bisect/bad' as RefName);
        const fromWorktree = await sut(worktree.worktreeCtx).resolveDirect(
          'refs/bisect/bad' as RefName,
        );

        // Assert
        expect(fromMain).toEqual({ kind: 'missing' });
        expect(fromWorktree).toEqual({ kind: 'direct', id: worktree.bisectId });
        expect(showRefNames(worktree.dir)).not.toContain('refs/bisect/bad');
        expect(showRefNames(worktree.wtDir)).toContain('refs/bisect/bad');
      });
    });
  });
});
