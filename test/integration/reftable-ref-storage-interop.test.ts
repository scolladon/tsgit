/**
 * Cross-tool interop — the reftable read backend. Builds several
 * `git init --ref-format=reftable` repositories with canonical git (pinned
 * author/committer dates, signing off), then asserts that tsgit's reftable
 * `RefStore` and the Tier-1 commands built atop it — `branch.list`,
 * `tag.list`, `resolveRef` — read the exact same ref set, symref chains,
 * peeled tag values, HEAD target, tombstones, reflog history and section
 * layout that canonical git itself reports. This is what closes the
 * write-surface audit gap the reftable backend left open until now.
 *
 * @proves
 *   surface:        reftable
 *   bucket:         cross-tool-interop
 *   unique:         reftable stack reads and writes agree with canonical git
 *   interopSurface: reftable
 */
import { chmodSync, cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchList, branchRename } from '../../src/application/commands/branch.js';
import { tagList } from '../../src/application/commands/tag.js';
import { loadReftableStack } from '../../src/application/primitives/load-reftable-stack.js';
import { reftableDir } from '../../src/application/primitives/path-layout.js';
import { readObject } from '../../src/application/primitives/read-object.js';
import { getRefStore } from '../../src/application/primitives/ref-store.js';
import { resolveRef } from '../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import {
  buildReftableRefSection,
  compactionMetric,
  DEFAULT_GEOMETRIC_FACTOR,
  iterateReftableLogs,
  iterateReftableRefs,
  loadReftable,
  type ReftableCheck,
  serializeReftable,
} from '../../src/domain/refs/index.js';
import type { ReftableWriteOptions } from '../../src/domain/refs/reftable/reftable-writer.js';
import { DEFAULT_RESTART_INTERVAL } from '../../src/domain/refs/reftable/reftable-writer.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  topReflogSubject,
  tryRunGitWithExit,
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
  git(dir, 'checkout', '-q', '--orphan', 'tz-log');
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
  const dir = path.join(rootDir, 'worktreeMain');
  const wtDir = path.join(rootDir, 'worktreeLinked');
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

/**
 * A structurally-broken or absent `.git/reftable/` stack — the seven
 * damaged copies of {@link buildHealthyFiveRefRepo} that pin the corrupt-
 * stack tiering divergence described below. `outcome` is tsgit's own
 * classification: `'refuse'` structural faults (a `ReftableCheck` on a
 * table `tables.list` names) versus `'degrade'` absences (a legitimately
 * empty stack). Every row was independently re-measured against this
 * exact pinned git build before being encoded here.
 */
interface CorruptFixture {
  readonly label: string;
  readonly dir: string;
  readonly ctx: Context;
  readonly outcome: 'refuse' | 'degrade';
  readonly check?: ReftableCheck;
}

const reftableSubdir = (repoDir: string): string => `${repoDir}/.git/reftable`;
const tablesListPath = (repoDir: string): string => `${reftableSubdir(repoDir)}/tables.list`;

/** The one table `tables.list` names, after `pack-refs --all` compacted the
 *  fixture down to a single file — every byte-level damager targets this
 *  one well-understood path. */
const soleTablePath = (repoDir: string): string => {
  const listing = readFileSync(tablesListPath(repoDir), 'utf8');
  const name = listing.split('\n').find((line) => line.length > 0);
  if (name === undefined) throw new Error(`tables.list names no table under ${repoDir}`);
  return `${reftableSubdir(repoDir)}/${name}`;
};

type Damager = (repoDir: string) => void;

const corruptMagic: Damager = (repoDir) => {
  const tablePath = soleTablePath(repoDir);
  const bytes = readFileSync(tablePath);
  bytes.set([0x58, 0x58, 0x58, 0x58], 0); // 'XXXX'
  writeFileSync(tablePath, bytes);
};

/**
 * Truncated to 50 bytes — below v1's own 24-byte header plus 68-byte
 * footer (92 bytes). The design doc's own recipe truncates to 400 bytes,
 * but re-measured against THIS fixture's actual table (494 bytes: five
 * refs plus one annotated tag), 400 bytes lands ABOVE that 92-byte floor —
 * `parseReftable` reads a header fine and then reads a "footer" from
 * whatever mid-file bytes now sit at the truncated end, which is a
 * `footer-crc` mismatch, not `truncated`. Truncating well below the floor
 * instead reliably exercises the DISTINCT `truncated` check this row means
 * to cover; git's own for-each-ref/fsck behaviour is identical at either
 * length (re-measured both ways).
 */
const truncateTableBelowItsOwnHeaderAndFooter: Damager = (repoDir) => {
  const tablePath = soleTablePath(repoDir);
  const bytes = readFileSync(tablePath);
  writeFileSync(tablePath, bytes.subarray(0, 50));
};

const corruptFooterCrc: Damager = (repoDir) => {
  const tablePath = soleTablePath(repoDir);
  const bytes = readFileSync(tablePath);
  // Flipping the STORED CRC's own last byte, not a byte it covers, keeps
  // every other footer field valid and isolates the fault to the checksum
  // comparison alone.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lastIndex = bytes.length - 1;
  view.setUint8(lastIndex, view.getUint8(lastIndex) ^ 0xff);
  writeFileSync(tablePath, bytes);
};

const corruptHeaderVersion: Damager = (repoDir) => {
  const tablePath = soleTablePath(repoDir);
  const bytes = readFileSync(tablePath);
  bytes.set([9], 4);
  writeFileSync(tablePath, bytes);
};

const tablesListNamesAMissingFile: Damager = (repoDir) => {
  rmSync(soleTablePath(repoDir));
};

const tablesListRemoved: Damager = (repoDir) => {
  rmSync(tablesListPath(repoDir));
};

const reftableDirectoryRemoved: Damager = (repoDir) => {
  rmSync(reftableSubdir(repoDir), { recursive: true, force: true });
};

/** The design's healthy five-ref control repository — `main`, `dev`,
 *  `feature`, a symbolic ref, and one annotated tag — compacted to a
 *  single reftable so each damage variant below corrupts one
 *  well-understood file. */
const buildHealthyFiveRefRepo = (dir: string): void => {
  initReftableRepo(dir);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
    env: dateEnv(1_700_000_000, '+0000'),
  });
  git(dir, 'branch', 'dev');
  git(dir, 'branch', 'feature');
  git(dir, 'symbolic-ref', 'refs/heads/symbolic', 'refs/heads/main');
  runGit(['-C', dir, 'tag', '-a', 'v1', '-m', 'release v1'], {
    env: dateEnv(1_700_000_100, '+0000'),
  });
  git(dir, 'pack-refs', '--all');
};

interface CorruptRow {
  readonly label: string;
  readonly damage: Damager;
  readonly outcome: 'refuse' | 'degrade';
  readonly check?: ReftableCheck;
}

/** Every row's `outcome`/`check` and its `for-each-ref`/`fsck` counterpart
 *  (asserted in the row-11 describe block below) were each independently
 *  re-measured against this exact pinned git build, not copied from the
 *  design doc unread. */
const CORRUPT_ROWS: ReadonlyArray<CorruptRow> = [
  { label: 'bad magic', damage: corruptMagic, outcome: 'refuse', check: 'magic' },
  {
    label: 'truncated below its own header and footer',
    damage: truncateTableBelowItsOwnHeaderAndFooter,
    outcome: 'refuse',
    check: 'truncated',
  },
  {
    label: 'footer CRC corrupted',
    damage: corruptFooterCrc,
    outcome: 'refuse',
    check: 'footer-crc',
  },
  {
    label: 'header version 9',
    damage: corruptHeaderVersion,
    outcome: 'refuse',
    check: 'version',
  },
  {
    label: 'tables.list names a missing file',
    damage: tablesListNamesAMissingFile,
    outcome: 'refuse',
    check: 'tables-list',
  },
  { label: 'tables.list removed', damage: tablesListRemoved, outcome: 'degrade' },
  { label: '.git/reftable/ removed', damage: reftableDirectoryRemoved, outcome: 'degrade' },
];

const buildCorruptFixtures = (rootDir: string, baseDir: string): readonly CorruptFixture[] =>
  CORRUPT_ROWS.map((row, index) => {
    const dir = path.join(rootDir, `corrupt-${index}`);
    cpSync(baseDir, dir, { recursive: true });
    row.damage(dir);
    return {
      label: row.label,
      dir,
      ctx: reftableCtx(dir),
      outcome: row.outcome,
      ...(row.check !== undefined ? { check: row.check } : {}),
    };
  });

describe.skipIf(!GIT_AVAILABLE)('reftable-ref-storage interop', () => {
  let rootDir: string;
  let main: MainFixture;
  let sha256: Sha256Fixture;
  let big: BigFixture;
  let hundred: HundredFixture;
  let worktree: WorktreeFixture;
  let corruptControl: { readonly dir: string; readonly ctx: Context };
  let corrupt: readonly CorruptFixture[];

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-reftable-'));
    main = buildMainFixture(rootDir);
    sha256 = buildSha256Fixture(rootDir);
    big = buildBigFixture(rootDir);
    hundred = buildHundredFixture(rootDir);
    worktree = buildWorktreeFixture(rootDir);

    const corruptBaseDir = path.join(rootDir, 'corrupt-base');
    buildHealthyFiveRefRepo(corruptBaseDir);
    const controlDir = path.join(rootDir, 'corrupt-control');
    cpSync(corruptBaseDir, controlDir, { recursive: true });
    corruptControl = { dir: controlDir, ctx: reftableCtx(controlDir) };
    corrupt = buildCorruptFixtures(rootDir, corruptBaseDir);
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
    describe('When readReflog reads refs/heads/tz-log', () => {
      it('Then entries, order, oids, identity and message match git reflog show --date=raw', async () => {
        // Arrange
        const sut = getRefStore(main.ctx);
        const expectedSubjects = git(main.dir, 'reflog', 'show', '--date=raw', 'tz-log')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => line.slice(line.indexOf(': ') + 2))
          .reverse();

        // Act
        const entries = await sut.readReflog('refs/heads/tz-log' as RefName);

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

  // --- The write path: rows 12-17 and 21-23 ---------------------------------

  /** Snapshot of every file directly under `dir` (non-recursive — every
   *  reftable stack directory this suite builds is flat), keyed by name. */
  const snapshotDir = (dir: string): ReadonlyMap<string, Buffer> =>
    new Map(readdirSync(dir).map((name) => [name, readFileSync(`${dir}/${name}`)]));

  /** The one table `tables.list` names — works for any stack, compacted or
   *  not, as long as it names at least one table. */
  const soleTableIn = (reftableDirPath: string): string => {
    const listing = readFileSync(`${reftableDirPath}/tables.list`, 'utf8');
    const name = listing.split('\n').find((line) => line.length > 0);
    if (name === undefined) throw new Error(`tables.list names no table under ${reftableDirPath}`);
    return `${reftableDirPath}/${name}`;
  };

  describe('Given a git-made reftable repository with one commit', () => {
    describe('When tsgit creates a new ref through applyRefUpdates', () => {
      it('Then git show-ref sees it, and git fsck / git refs verify report clean', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-create');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const mainId = git(dir, 'rev-parse', 'HEAD').trim();
        const ctx = reftableCtx(dir);

        // Act
        await getRefStore(ctx).applyRefUpdates([
          { kind: 'set', name: 'refs/heads/created' as RefName, id: mainId as ObjectId },
        ]);

        // Assert
        expect(showRefNames(dir)).toContain('refs/heads/created');
        expect(tryRunGitWithExit(['-C', dir, 'fsck'], { env: runGitEnv() }).exitCode).toBe(0);
        expect(
          tryRunGitWithExit(['-C', dir, 'refs', 'verify'], { env: runGitEnv() }).exitCode,
        ).toBe(0);
      });
    });
  });

  describe('Given a git-made ref with three prior updates (three reflog entries)', () => {
    describe('When tsgit deletes it', () => {
      it('Then it is gone from git show-ref and its reflog is gone from git reflog', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-delete');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        git(dir, 'branch', 'doomed');
        for (let step = 0; step < 2; step += 1) {
          runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', `step ${step}`], {
            env: dateEnv(1_700_000_100 + step * 100, '+0000'),
          });
          git(dir, 'update-ref', 'refs/heads/doomed', 'HEAD');
        }
        const ctx = reftableCtx(dir);

        // Act
        await getRefStore(ctx).applyRefUpdates([
          { kind: 'delete', name: 'refs/heads/doomed' as RefName },
        ]);

        // Assert
        expect(showRefNames(dir)).not.toContain('refs/heads/doomed');
        const reflog = tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'refs/heads/doomed'], {
          env: runGitEnv(),
        });
        expect(reflog.exitCode).not.toBe(0);
      });
    });
  });

  describe('Given a git-made reftable repository with a target branch', () => {
    describe('When tsgit writes a symbolic ref through applyRefUpdates', () => {
      it('Then it matches git symbolic-ref', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-symbolic');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        git(dir, 'branch', 'target');
        const ctx = reftableCtx(dir);

        // Act
        await getRefStore(ctx).applyRefUpdates([
          {
            kind: 'setSymbolic',
            name: 'refs/heads/alias' as RefName,
            target: 'refs/heads/target' as RefName,
          },
        ]);

        // Assert
        expect(git(dir, 'symbolic-ref', 'refs/heads/alias').trim()).toBe('refs/heads/target');
      });
    });
  });

  describe('Given tsgit commits on the branch HEAD points at', () => {
    describe('When the coupled update is applied as one transaction', () => {
      it('Then git reflog HEAD and git reflog <branch> both gain an entry at the same update index', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-coupled');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const oldId = git(dir, 'rev-parse', 'HEAD').trim();
        const treeId = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
        const newId = git(dir, 'commit-tree', treeId, '-p', oldId, '-m', 'c2').trim();
        const ctx = reftableCtx(dir);
        const message = 'commit: c2';

        // Act
        await getRefStore(ctx).applyRefUpdates([
          {
            kind: 'set',
            name: 'refs/heads/main' as RefName,
            id: newId as ObjectId,
            reflog: { oldId: oldId as ObjectId, newId: newId as ObjectId, message },
          },
          {
            kind: 'reflogOnly',
            name: 'HEAD' as RefName,
            reflog: { oldId: oldId as ObjectId, newId: newId as ObjectId, message },
          },
        ]);

        // Assert
        expect(topReflogSubject(dir, 'refs/heads/main')).toBe(message);
        expect(topReflogSubject(dir, 'HEAD')).toBe(message);
        const stack = await loadReftableStack(ctx, reftableDir(ctx.layout.gitDir));
        const newest = stack.tables[stack.tables.length - 1]!;
        const logs = [...iterateReftableLogs(newest)];
        const mainLog = logs.find((r) => r.name === ('refs/heads/main' as RefName));
        const headLog = logs.find((r) => r.name === ('HEAD' as RefName));
        expect(mainLog?.updateIndex).toBeDefined();
        expect(mainLog?.updateIndex).toBe(headLog?.updateIndex);
      });
    });
  });

  describe('Given a --object-format=sha256 git-made reftable repository', () => {
    describe('When tsgit writes a new ref', () => {
      it('Then the newest table stays v2 and git show-ref sees the new ref', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-sha256');
        initReftableRepo(dir, ['--object-format=sha256']);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const mainId = git(dir, 'rev-parse', 'HEAD').trim();
        // `createNodeContext` defaults to sha1 unless told otherwise — a
        // real caller reaches this Context through `openRepository`, which
        // auto-detects `extensions.objectFormat`; this interop suite builds
        // Contexts directly, so the write path needs the algorithm named
        // explicitly, matching the fixture's own `--object-format=sha256`.
        const ctx = withReftableStorage(createNodeContext({ workDir: dir, algorithm: 'sha256' }));

        // Act
        await getRefStore(ctx).applyRefUpdates([
          { kind: 'set', name: 'refs/heads/created' as RefName, id: mainId as ObjectId },
        ]);

        // Assert
        expect(showRefNames(dir)).toContain('refs/heads/created');
        const stack = await loadReftableStack(ctx, reftableDir(ctx.layout.gitDir));
        const newest = stack.tables[stack.tables.length - 1]!;
        expect(newest.header.version).toBe(2);
        expect(newest.header.hashId).toBe('s256');
      });
    });
  });

  describe('Given a git-made reftable repository compacted to one table', () => {
    describe('When buildReftableRefSection replays its logical content', () => {
      it('Then the ref section is byte-identical up to log_position, and the log section is records-equal beyond it', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-byte-pin');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        git(dir, 'branch', 'dev');
        const ctx = reftableCtx(dir);
        const stack = await loadReftableStack(ctx, reftableDir(ctx.layout.gitDir));
        // Precondition, not an assumption: git's own auto-compaction folds
        // this small fixture down to one table, giving one unambiguous
        // ground-truth file to replay — re-checked here rather than assumed.
        expect(stack.tables).toHaveLength(1);
        const table = stack.tables[0]!;
        const refs = [...iterateReftableRefs(table)];
        const logs = [...iterateReftableLogs(table)];
        expect(table.footer.logPosition).toBeGreaterThan(0);

        // Act
        const options: ReftableWriteOptions = {
          hashId: table.header.hashId,
          blockSize: table.header.blockSize,
          restartInterval: DEFAULT_RESTART_INTERVAL,
          indexObjects: true,
          minUpdateIndex: table.header.minUpdateIndex,
          maxUpdateIndex: table.header.maxUpdateIndex,
        };
        const rebuiltRefSection = buildReftableRefSection(refs, options);
        const rebuiltFullTable = await serializeReftable(
          refs,
          logs,
          options,
          ctx.compressor.deflate,
        );
        const reparsed = await loadReftable(rebuiltFullTable, ctx.compressor.streamInflate);

        // Assert — byte-identical up to log_position (the pure, sync half of
        // the writer); records-equal beyond it (the log section cannot be
        // byte-pinned — DEFLATE has no canonical output).
        const gitRefSectionBytes = table._bytes.subarray(0, table.footer.logPosition);
        expect(rebuiltRefSection).toEqual(gitRefSectionBytes);
        expect([...iterateReftableLogs(reparsed)]).toEqual(logs);
      });
    });
  });

  interface GitReflogRow {
    readonly oid: string;
    readonly timestamp: number;
    readonly tzOffset: string;
    readonly message: string;
  }

  const REFLOG_SELECTOR = /@\{(\d+) ([+-]\d{4})\}$/;

  /** `git log -g --date=raw --format='%H<TAB>%gd<TAB>%gs' <ref>`, parsed
   *  oldest -> newest (git itself lists newest -> oldest, matching
   *  `git reflog show`) — the FULL oid, never the abbreviated one
   *  `git reflog show` prints, so an oid comparison needs no truncation. */
  const reflogRows = (dir: string, ref: string): GitReflogRow[] =>
    git(dir, 'log', '-g', '--date=raw', '--format=%H\t%gd\t%gs', ref)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [oid, selector, ...rest] = line.split('\t');
        const match = REFLOG_SELECTOR.exec(selector ?? '');
        if (match === null) throw new Error(`unparsed reflog selector: ${selector}`);
        const [, timestamp, tzOffset] = match;
        return {
          oid: oid ?? '',
          timestamp: Number(timestamp),
          tzOffset: tzOffset ?? '',
          message: rest.join('\t'),
        };
      })
      .reverse();

  describe('Given a git-made reftable branch with a three-timezone reflog history, checked out as HEAD', () => {
    describe('When tsgit renames it through branchRename', () => {
      it('Then the two branches never coexist, the moved history — including its identity, timestamp and timezone — reads back through git unchanged, the rename entry is prepended in git-faithful shape, HEAD follows, and git fsck / git refs verify accept the tsgit-written stack', async () => {
        // Arrange — three commits, three distinct timezone offsets, so a
        // shared encoding bug in the write path (constant-offset, swapped
        // sign, truncated timestamp) cannot hide behind a single value.
        const dir = path.join(rootDir, 'write-rename');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        runGit(['-C', dir, 'branch', 'topic'], { env: dateEnv(1_700_000_100, '+0530') });
        runGit(['-C', dir, 'checkout', '-q', 'topic']);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c2'], {
          env: dateEnv(1_700_000_200, '-0700'),
        });
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c3'], {
          env: dateEnv(1_700_000_300, '+0000'),
        });
        const expectedMovedLog = reflogRows(dir, 'topic');
        expect(expectedMovedLog).toHaveLength(3);
        const tip = git(dir, 'rev-parse', 'topic').trim();
        const ctx = reftableCtx(dir);

        // Act
        await branchRename(ctx, { from: 'topic', to: 'renamed' });

        // Assert — the two branches never coexist, from both tools' view.
        expect(showRefNames(dir)).toEqual(['refs/heads/main', 'refs/heads/renamed']);
        expect(
          forEachRef(dir)
            .map((row) => row.refname)
            .sort(),
        ).toEqual(['refs/heads/main', 'refs/heads/renamed']);
        const tsgitBranchNames = (await branchList(ctx)).branches.map((b) => b.name);
        expect(tsgitBranchNames).not.toContain('refs/heads/topic');
        expect(tsgitBranchNames).toContain('refs/heads/renamed');

        // Assert — the moved history is byte-identical in oid, identity
        // (timestamp + timezone) and message, read back by git ITSELF —
        // closing the gap a tsgit-only encode/decode round trip cannot: a
        // shared encoding bug would cancel out there but not here.
        const renamedLog = reflogRows(dir, 'renamed');
        expect(renamedLog).toHaveLength(4);
        renamedLog.slice(0, 3).forEach((row, index) => {
          const expected = expectedMovedLog[index]!;
          expect(row.oid).toBe(expected.oid);
          expect(row.timestamp).toBe(expected.timestamp);
          expect(row.tzOffset).toBe(expected.tzOffset);
          expect(row.message).toBe(expected.message);
        });

        // Assert — the rename entry is prepended (newest-first display),
        // git's own capitalised wording (measured against git 2.55.0, both
        // the files and reftable backends), oldId/newId both the tip.
        const renameRow = renamedLog[3]!;
        expect(renameRow.oid).toBe(tip);
        expect(renameRow.message).toBe('Branch: renamed refs/heads/topic to refs/heads/renamed');

        // Assert — HEAD followed the rename, and the old name is gone
        // entirely — not merely emptied, `git reflog show` refuses it.
        expect(git(dir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/renamed');
        expect(showRefNames(dir)).not.toContain('refs/heads/topic');
        expect(
          tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'topic'], { env: runGitEnv() }).exitCode,
        ).not.toBe(0);

        // Assert — git itself accepts the tsgit-written stack.
        expect(tryRunGitWithExit(['-C', dir, 'fsck'], { env: runGitEnv() }).exitCode).toBe(0);
        expect(
          tryRunGitWithExit(['-C', dir, 'refs', 'verify'], { env: runGitEnv() }).exitCode,
        ).toBe(0);
      });
    });
  });

  /** `tables.list`'s own names, in order — read via node's `fs` directly
   *  rather than through tsgit, so it observes exactly what is on disk
   *  regardless of which tool last wrote it. */
  const tableNamesOf = (reftableDirPath: string): string[] =>
    readFileSync(`${reftableDirPath}/tables.list`, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);

  /** The stack's own compaction invariant, over the CURRENT on-disk state:
   *  never the exact table count (deflate-size-dependent — see the
   *  compaction module's own doc comment for why), only that the stack
   *  satisfies git's own compaction rule. Restates that rule directly
   *  (adjacent pair check) rather than calling `suggestCompactionSegment` —
   *  the exact function `planCompaction` uses to decide what to merge — so
   *  this is independent of that SEGMENT-SELECTION decision, not a
   *  tautology a bug in it would pass right along to. It still calls
   *  `compactionMetric`/`DEFAULT_GEOMETRIC_FACTOR` from the same production
   *  module, since re-deriving the metric here would itself be a tautology
   *  against a metric bug; `compactionMetric`'s own correctness is pinned
   *  separately, by `reftable-compaction.test.ts`. */
  const isStackGeometric = async (ctx: Context, reftableDirPath: string): Promise<boolean> => {
    const stack = await loadReftableStack(ctx, reftableDirPath);
    const sizes = stack.tables.map((table) =>
      compactionMetric(table._bytes.length, table.header.version),
    );
    for (let i = 1; i < sizes.length; i += 1) {
      if (sizes[i - 1]! < sizes[i]! * DEFAULT_GEOMETRIC_FACTOR) return false;
    }
    return true;
  };

  describe('Given a fresh git-made reftable repository with one commit', () => {
    describe('When tsgit writes 60 refs one at a time', () => {
      it('Then git show-ref matches tsgit after every single write, and the stack stays geometric throughout', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-sixty');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const mainId = git(dir, 'rev-parse', 'HEAD').trim();
        const ctx = reftableCtx(dir);
        const stackDir = reftableDir(ctx.layout.gitDir);
        const store = getRefStore(ctx);

        // Act + Assert — 60 refs, written one at a time, replaying the
        // same transition count the compaction policy's own measured
        // table was validated against.
        for (let i = 0; i < 60; i += 1) {
          const name = `refs/heads/w${String(i).padStart(3, '0')}` as RefName;
          await store.applyRefUpdates([{ kind: 'set', name, id: mainId as ObjectId }]);

          const tsgitNames = (await store.listRefs())
            .map((entry) => entry.name)
            .filter((entryName) => entryName !== 'HEAD')
            .sort();
          expect(tsgitNames).toEqual(showRefNames(dir));
          expect(await isStackGeometric(ctx, stackDir)).toBe(true);
        }
      });
    });
  });

  describe('Given a git-built multi-table stack containing a tombstone', () => {
    describe('When tsgit writes one more ref, triggering its own auto-compaction', () => {
      it('Then git show-ref, git reflog and git fsck all agree with the pre-state, and the tombstone is elided only when the merge segment started at table 0', async () => {
        // Arrange — `reftable.geometricFactor=1` keeps GIT from folding its
        // own writes together, so the stack tsgit inherits below is
        // genuinely multi-table; tsgit is unaffected, since its own
        // compaction always uses its hardcoded default factor of 2.
        const dir = path.join(rootDir, 'write-compact-round-trip');
        initReftableRepo(dir);
        git(dir, 'config', 'reftable.geometricFactor', '1');
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const mainId = git(dir, 'rev-parse', 'HEAD').trim();
        for (let i = 0; i < 8; i += 1) {
          git(dir, 'update-ref', `refs/heads/g${i}`, mainId);
        }
        git(dir, 'update-ref', 'refs/heads/tomb20', mainId);
        git(dir, 'update-ref', '-d', 'refs/heads/tomb20');
        git(dir, 'config', '--unset', 'reftable.geometricFactor');

        const ctx = reftableCtx(dir);
        const stackDir = reftableDir(ctx.layout.gitDir);
        const preNames = tableNamesOf(stackDir);
        const oldestName = preNames[0]!;
        const oldestBytesBefore = readFileSync(`${stackDir}/${oldestName}`);
        const preRefs = showRefNames(dir);
        const preReflogG0 = tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'refs/heads/g0'], {
          env: runGitEnv(),
        }).stdout;

        // Act
        await getRefStore(ctx).applyRefUpdates([
          { kind: 'set', name: 'refs/heads/newest20' as RefName, id: mainId as ObjectId },
        ]);

        // Assert — cross-tool agreement, both directions
        expect(showRefNames(dir)).toEqual([...preRefs, 'refs/heads/newest20'].sort());
        expect(showRefNames(dir)).not.toContain('refs/heads/tomb20');
        expect((await getRefStore(ctx).listRefs()).map((entry) => entry.name)).not.toContain(
          'refs/heads/tomb20',
        );
        expect(tryRunGitWithExit(['-C', dir, 'fsck'], { env: runGitEnv() }).exitCode).toBe(0);
        expect(
          tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'refs/heads/g0'], { env: runGitEnv() })
            .stdout,
        ).toBe(preReflogG0);

        // Assert — the tombstone rule, observed rather than assumed: never
        // asserting which tables merged (deflate-size-dependent), only
        // that the rule held for whichever segment tsgit actually chose.
        const postNames = tableNamesOf(stackDir);
        if (postNames.includes(oldestName)) {
          // The merge segment did not reach table 0 — the oldest table is
          // untouched, byte for byte.
          expect(readFileSync(`${stackDir}/${oldestName}`)).toEqual(oldestBytesBefore);
        } else {
          // The whole stack merged from table 0 — the tombstone is gone
          // outright, not merely hidden by the merge join.
          const stack = await loadReftableStack(ctx, stackDir);
          const tombRef = 'refs/heads/tomb20' as RefName;
          for (const table of stack.tables) {
            expect([...iterateReftableRefs(table)].some((r) => r.name === tombRef)).toBe(false);
            expect([...iterateReftableLogs(table)].some((l) => l.name === tombRef)).toBe(false);
          }
        }
      });
    });
  });

  describe('Given a stack written by git and tsgit alternately', () => {
    describe('When a git update-ref and a tsgit write interleave repeatedly', () => {
      it('Then all refs are present, the stack stays geometric, and no orphan files remain', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-interleaved');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const mainId = git(dir, 'rev-parse', 'HEAD').trim();
        const ctx = reftableCtx(dir);
        const stackDir = reftableDir(ctx.layout.gitDir);
        const store = getRefStore(ctx);
        const expectedNames = new Set<string>(['refs/heads/main']);

        // Act — 20 rounds, alternating writer
        for (let round = 0; round < 20; round += 1) {
          if (round % 2 === 0) {
            const name = `refs/heads/git${round}`;
            git(dir, 'update-ref', name, mainId);
            expectedNames.add(name);
          } else {
            const name = `refs/heads/tsgit${round}` as RefName;
            await store.applyRefUpdates([{ kind: 'set', name, id: mainId as ObjectId }]);
            expectedNames.add(name);
          }
        }

        // Assert — every ref present on both sides
        const sortedExpected = [...expectedNames].sort();
        expect(showRefNames(dir)).toEqual(sortedExpected);
        const tsgitNames = (await store.listRefs())
          .map((entry) => entry.name)
          .filter((entryName) => entryName !== 'HEAD')
          .sort();
        expect(tsgitNames).toEqual(sortedExpected);

        // Assert — geometric (round 19 is tsgit's; its own compaction ran
        // last), and no orphan files: every `.ref` on disk is named in
        // `tables.list`, and no stray lock/temp file survives.
        expect(await isStackGeometric(ctx, stackDir)).toBe(true);
        const listedNames = new Set(tableNamesOf(stackDir));
        const onDisk = readdirSync(stackDir);
        const refFiles = onDisk.filter((name) => name.endsWith('.ref'));
        expect(refFiles.every((name) => listedNames.has(name))).toBe(true);
        expect(onDisk.some((name) => name.endsWith('.lock') || name.endsWith('.temp'))).toBe(false);
      });
    });
  });

  describe('Given a git-made reftable repository with tables.list.lock planted', () => {
    describe('When both tools attempt a write', () => {
      it('Then tsgit raises REFTABLE_LOCKED naming the path, git refuses to lock references, the stack stays byte-unchanged, and reads still succeed on both sides', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-locked');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const mainId = git(dir, 'rev-parse', 'HEAD').trim();
        const ctx = reftableCtx(dir);
        const stackDir = reftableDir(ctx.layout.gitDir);
        writeFileSync(`${stackDir}/tables.list.lock`, '');
        const before = snapshotDir(stackDir);

        // Act — tsgit. Captured OUTSIDE the try: an `expect.unreachable()`/
        // `expect.fail()` thrown inside it would be swallowed by this same
        // `catch` and resurface as a confusing downstream TypeError instead
        // of the intended message.
        let caughtTsgit: unknown;
        try {
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: 'refs/heads/locked' as RefName, id: mainId as ObjectId },
          ]);
        } catch (err) {
          caughtTsgit = err;
        }
        if (caughtTsgit === undefined) expect.unreachable('expected REFTABLE_LOCKED');

        // Assert — tsgit
        const lockedData = (caughtTsgit as TsgitError).data;
        if (lockedData.code !== 'REFTABLE_LOCKED')
          expect.fail(`expected REFTABLE_LOCKED, got ${lockedData.code}`);
        expect(lockedData.reason).toContain('tables.list.lock');

        // Act + Assert — git
        const gitResult = tryRunGitWithExit(
          ['-C', dir, 'update-ref', 'refs/heads/locked', mainId],
          { env: runGitEnv() },
        );
        expect(gitResult.exitCode).not.toBe(0);
        expect(gitResult.stderr).toContain('cannot lock references');

        // Assert — byte-unchanged (neither tool's failed attempt wrote
        // anything), reads still succeed on both sides
        expect(snapshotDir(stackDir)).toEqual(before);
        expect(showRefNames(dir)).toEqual(['refs/heads/main']);
        expect((await getRefStore(ctx).listRefs()).map((e) => e.name)).toContain('refs/heads/main');
        rmSync(`${stackDir}/tables.list.lock`);
      });
    });
  });

  describe('Given crash residue planted at each step of the write protocol', () => {
    let baseDir: string;

    beforeAll(() => {
      baseDir = path.join(rootDir, 'write-crash-base');
      initReftableRepo(baseDir);
      runGit(['-C', baseDir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
        env: dateEnv(1_700_000_000, '+0000'),
      });
    });

    const residueRows: ReadonlyArray<{
      readonly label: string;
      readonly plant: (dir: string) => void;
    }> = [
      {
        label: 'crash-1-to-5-empty-lock',
        plant: (dir) => writeFileSync(`${reftableDir(`${dir}/.git`)}/tables.list.lock`, ''),
      },
      {
        label: 'crash-6-orphan-temp',
        plant: (dir) =>
          writeFileSync(
            `${reftableDir(`${dir}/.git`)}/0x000000000099-0x000000000099-deadbeef.temp`,
            new Uint8Array(4),
          ),
      },
      {
        label: 'crash-7-orphan-ref',
        plant: (dir) =>
          writeFileSync(
            `${reftableDir(`${dir}/.git`)}/0x000000000099-0x000000000099-deadbeef.ref`,
            new Uint8Array(4),
          ),
      },
    ];

    describe.each(residueRows)('When the residue is $label', (row) => {
      it('Then git and tsgit both read the same (pre-residue) state', async () => {
        // Arrange
        const dir = path.join(rootDir, `write-${row.label}`);
        cpSync(baseDir, dir, { recursive: true });
        row.plant(dir);
        const ctx = reftableCtx(dir);

        // Act
        const gitNames = showRefNames(dir);
        const tsgitEntries = await getRefStore(ctx).listRefs();

        // Assert
        expect(gitNames).toEqual(['refs/heads/main']);
        expect(
          tsgitEntries
            .map((e) => e.name)
            .filter((n) => n !== 'HEAD')
            .sort(),
        ).toEqual(gitNames);
      });
    });
  });

  describe('Given a files-backend repository with a chmod-000 HEAD', () => {
    describe('When updateRef writes the branch HEAD points at', () => {
      it('Then it throws and .git/refs and .git/logs stay byte-identical to before', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-regression-files');
        runGit(['init', '-q', '-b', 'main', dir]);
        git(dir, 'config', 'user.name', 'Ada');
        git(dir, 'config', 'user.email', 'ada@example.com');
        disableAutoMaintenance(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        const oldId = git(dir, 'rev-parse', 'HEAD').trim();
        const treeId = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
        const newId = git(dir, 'commit-tree', treeId, '-p', oldId, '-m', 'c2').trim();
        const ctx = createNodeContext({ workDir: dir });
        const refsBefore = readFileSync(`${dir}/.git/refs/heads/main`, 'utf8');
        const logsBefore = readFileSync(`${dir}/.git/logs/refs/heads/main`, 'utf8');
        const headPath = `${dir}/.git/HEAD`;
        chmodSync(headPath, 0o000);

        // Act + Assert — measured (git 2.55.0's own file-mode semantics
        // play no part here; this is Node's EACCES surfacing through
        // `mapErrno`): an unreadable HEAD rejects with PERMISSION_DENIED
        // naming HEAD's own path, never merely "some rejection".
        let caught: unknown;
        try {
          await updateRef(ctx, 'refs/heads/main' as RefName, newId as ObjectId, {
            reflogMessage: 'commit: c2',
          });
        } catch (err) {
          caught = err;
        } finally {
          chmodSync(headPath, 0o644);
        }
        if (caught === undefined) expect.unreachable();
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('PERMISSION_DENIED');
        if (data.code === 'PERMISSION_DENIED') {
          expect(data.path).toBe(headPath);
        }

        // Assert — nothing committed despite the thrown coupling-read failure
        expect(readFileSync(`${dir}/.git/refs/heads/main`, 'utf8')).toBe(refsBefore);
        expect(readFileSync(`${dir}/.git/logs/refs/heads/main`, 'utf8')).toBe(logsBefore);
      });
    });
  });

  describe('Given a reftable-backend linked worktree whose own stack is corrupted', () => {
    describe('When updateRef writes the shared branch HEAD points at, from the worktree', () => {
      it('Then it throws and both reftable stacks stay byte-identical to before', async () => {
        // Arrange
        const dir = path.join(rootDir, 'write-regression-reftable');
        const wtDir = path.join(rootDir, 'write-regression-reftable-wt');
        initReftableRepo(dir);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1'], {
          env: dateEnv(1_700_000_000, '+0000'),
        });
        runGit(['-C', dir, 'worktree', 'add', '-q', '-b', 'feature', wtDir]);
        const oldId = git(wtDir, 'rev-parse', 'HEAD').trim();
        const treeId = git(wtDir, 'rev-parse', 'HEAD^{tree}').trim();
        const newId = git(wtDir, 'commit-tree', treeId, '-p', oldId, '-m', 'c2').trim();

        const mainCtx = reftableCtx(dir);
        const adminDir = `${mainCtx.layout.gitDir}/worktrees/${path.basename(wtDir)}`;
        const worktreeCtx: Context = {
          ...mainCtx,
          layout: { ...mainCtx.layout, gitDir: adminDir, commonDir: mainCtx.layout.gitDir },
        };
        const commonStackDir = reftableDir(mainCtx.layout.gitDir);
        const worktreeStackDir = reftableDir(adminDir);
        const commonBefore = snapshotDir(commonStackDir);
        const worktreeBefore = snapshotDir(worktreeStackDir);

        const tablePath = soleTableIn(worktreeStackDir);
        const corrupted = Buffer.from(readFileSync(tablePath));
        corrupted.set([0x58, 0x58, 0x58, 0x58], 0); // 'XXXX' — invalid magic
        writeFileSync(tablePath, corrupted);

        // Act — measured: the corrupted magic surfaces as INVALID_REFTABLE
        // check 'magic', never merely "some rejection".
        let caught: unknown;
        try {
          await updateRef(worktreeCtx, 'refs/heads/main' as RefName, newId as ObjectId, {
            reflogMessage: 'commit: c2',
          });
        } catch (err) {
          caught = err;
        }
        if (caught === undefined) expect.unreachable();
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_REFTABLE');
        if (data.code === 'INVALID_REFTABLE') {
          expect(data.check).toBe('magic');
        }

        // Assert — the common stack (where refs/heads/main lives) never saw
        // a write attempt at all; the worktree's own stack carries only the
        // corruption this test itself planted, nothing updateRef added.
        expect(snapshotDir(commonStackDir)).toEqual(commonBefore);
        const worktreeAfter = snapshotDir(worktreeStackDir);
        const tableName = path.basename(tablePath);
        expect(worktreeAfter.get(tableName)).toEqual(corrupted);
        const expectedWorktreeAfter = new Map(worktreeBefore);
        expectedWorktreeAfter.set(tableName, corrupted);
        expect(worktreeAfter).toEqual(expectedWorktreeAfter);
      });
    });
  });

  describe('Given the healthy five-ref repository, copied but left undamaged', () => {
    describe('When tsgit reads its ref set', () => {
      it('Then all five refs are present — the damaged fixtures below are known-sound copies', async () => {
        // Arrange
        const sut = getRefStore(corruptControl.ctx);

        // Act
        const entries = await sut.listRefs();
        const names = entries.map((entry) => entry.name).filter((name) => name !== 'HEAD');

        // Assert
        expect(names.slice().sort()).toEqual(showRefNames(corruptControl.dir));
        expect(names).toHaveLength(5);
      });
    });
  });

  /**
   * A documented divergence, not an oversight (see `internal/reftable-source.ts`).
   * Canonical git does not `fatal` on a structurally broken reftable stack —
   * `for-each-ref` reports rc 0 with no rows on every one of these seven
   * fixtures, healthy-looking and silent. The files backend is loud on the
   * SAME class of damage (a garbage line in `packed-refs` is `fatal:`, rc
   * 128) — reftable is uniquely silent. And git's own `fsck` dies on a
   * signal on every STRUCTURAL fault (`error: refs died of signal 11`, exit
   * 8) — a genuine git bug, not a behaviour tsgit can copy. tsgit instead
   * refuses with a structured `INVALID_REFTABLE` error wherever git
   * crashes, and degrades to an empty ref space only where git's own
   * degrade is coherent (an absent `tables.list` or `.git/reftable/`).
   *
   * Every assertion below is intentionally LOOSER than "tsgit matches git"
   * for the five `refuse` rows: git has no defined behaviour to match there
   * (a crash isn't a contract), so only the two independently-measured git
   * signals — `for-each-ref`'s silence and `fsck`'s exit code/signal text —
   * are pinned, beside tsgit's OWN structured refusal or degrade. A later
   * reader must not "tighten" this into equality with git's stdout.
   *
   * tsgit never crashes and never hangs on any of the seven: reaching
   * either the `catch` block (a well-formed `TsgitError`) or the resolved
   * empty stack, rather than an unhandled rejection or a test-timeout, IS
   * that proof — it is the property the whole tier split exists to
   * guarantee.
   */
  describe('Given a structurally broken or absent reftable stack', () => {
    // `describe.each` collects its tree synchronously at module-load time,
    // before `beforeAll` has built `corrupt` — so each row here is looked
    // up LAZILY, inside each `it` body, from the static `CORRUPT_ROWS` label
    // rather than closed over the (not-yet-populated) fixture array.
    const fixtureFor = (label: string): CorruptFixture => {
      const found = corrupt.find((candidate) => candidate.label === label);
      if (found === undefined) throw new Error(`no corrupt fixture built for ${label}`);
      return found;
    };

    describe.each(CORRUPT_ROWS)('When the damage is $label', (row) => {
      it('Then git for-each-ref reports rc 0 with no rows', () => {
        // Arrange
        const fixture = fixtureFor(row.label);
        const result = tryRunGitWithExit(['-C', fixture.dir, 'for-each-ref'], {
          env: runGitEnv(),
        });

        // Assert — same fault class is loud (fatal, rc 128) on the files
        // backend's packed-refs; reftable is silently empty instead.
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('');
      });

      it('Then git fsck matches its independently measured exit', () => {
        // Arrange
        const fixture = fixtureFor(row.label);
        const result = tryRunGitWithExit(['-C', fixture.dir, 'fsck'], { env: runGitEnv() });

        // Assert — git's own crash is not a contract: pinning its EXACT
        // exit code/signal here would turn this row red the day a git
        // release fixes the bug, for a reason unrelated to tsgit. Only
        // non-zero is pinned; git's signal is deliberately asserted beside
        // tsgit's own structured refusal below (that PAIRING must survive),
        // measured at git 2.55.0 as exitCode 8, stderr containing
        // 'refs died of signal 11'.
        if (fixture.outcome === 'refuse') {
          expect(result.exitCode).not.toBe(0);
        } else {
          expect(result.exitCode).toBe(0);
        }
      });

      it('Then tsgit classifies the fault per the tiering', async () => {
        // Arrange
        const fixture = fixtureFor(row.label);
        const dir = reftableDir(fixture.ctx.layout.gitDir);
        const sut = loadReftableStack;

        // Act + Assert
        if (fixture.outcome === 'refuse') {
          // Captured OUTSIDE the try: an `expect.unreachable()` thrown
          // inside it would be swallowed by this same `catch` and resurface
          // as a confusing downstream TypeError instead of the intended
          // message.
          let caught: unknown;
          try {
            await sut(fixture.ctx, dir);
          } catch (err) {
            caught = err;
          }
          if (caught === undefined) expect.unreachable();
          expect((caught as TsgitError).data.code).toBe('INVALID_REFTABLE');
          expect((caught as TsgitError).data).toMatchObject({
            check: fixture.check,
            reason: expect.any(String),
          });
          return;
        }
        const stack = await sut(fixture.ctx, dir);
        expect(stack.tables).toEqual([]);
        expect([...stack.names()]).toEqual([]);
      });
    });
  });
});
