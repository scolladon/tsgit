/**
 * Cross-tool interop — `packRefs`, the Tier-1 `pack-refs --all` composition.
 * Files rows: canonical git and tsgit build the identical ref set
 * independently (pinned author/committer dates keep the commit SHA equal),
 * each backend runs its own "pack everything" — `git pack-refs --all` on
 * the peer, `packRefs(ctx)` on ours — and the resulting `packed-refs` bytes
 * and pruned-loose-file state are compared. Reftable row: `packRefs` runs
 * against a canonical-git-BUILT reftable stack; git's own `show-ref` /
 * `reflog` / `fsck` are the read oracle, proving the compaction and orphan
 * sweep left every observable ref fact unchanged.
 *
 * @proves
 *   surface:        packRefs
 *   bucket:         cross-tool-interop
 *   unique:         packRefs packs every ref exactly as git pack-refs --all does, on both backends
 *   interopSurface: packRefs
 */
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchCreate } from '../../src/application/commands/branch.js';
import { commit } from '../../src/application/commands/commit.js';
import { packRefs } from '../../src/application/commands/pack-refs.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { loadReftableStack } from '../../src/application/primitives/load-reftable-stack.js';
import { reftableDir } from '../../src/application/primitives/path-layout.js';
import { getRefStore } from '../../src/application/primitives/ref-store.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../src/domain/objects/index.js';
import {
  compactionMetric,
  DEFAULT_GEOMETRIC_FACTOR,
  suggestCompactionSegment,
} from '../../src/domain/refs/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const commitEnv: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

const pathExists = async (p: string): Promise<boolean> =>
  access(p)
    .then(() => true)
    .catch(() => false);

const looseHeadsEntries = async (ctx: Context): Promise<number> => {
  const dir = `${ctx.layout.gitDir}/refs/heads`;
  if (!(await ctx.fs.exists(dir))) return 0;
  return (await ctx.fs.readdir(dir)).length;
};

describe.skipIf(!GIT_AVAILABLE)('packRefs interop — files backend', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('pack-refs');
    initBothRepos(pair.peer, pair.ours);
    disableAutoMaintenance(pair.peer);
    disableAutoMaintenance(pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a repo with a main commit and a feature branch, built identically on both sides', () => {
    describe('When git pack-refs --all runs on the peer and packRefs runs on ours', () => {
      it('Then the packed-refs bytes match and every packed loose file is pruned on both sides', async () => {
        // Arrange — identical commit SHA on both sides via pinned identity/dates.
        runGit(['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env: commitEnv,
        });
        runGit(['-C', pair.peer, 'branch', 'feature']);
        const ours = createNodeContext({ workDir: pair.ours });
        await commit(ours, { message: 'seed', author: AUTHOR });
        await branchCreate(ours, { name: 'feature' });

        // Act
        runGit(['-C', pair.peer, 'pack-refs', '--all']);
        const result = await packRefs(ours);

        // Assert
        expect(result).toEqual({
          packedRefCount: 2,
          prunedLooseRefCount: 2,
          removedOrphanCount: 0,
        });
        const peerPacked = await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8');
        const oursPacked = await readFile(path.join(pair.ours, '.git/packed-refs'), 'utf8');
        expect(oursPacked).toBe(peerPacked);
        expect(await looseHeadsEntries(ours)).toBe(0);
      });
    });
  });

  describe('Given a repository already packed once on both sides', () => {
    describe('When git pack-refs --all and packRefs each run a second time', () => {
      it('Then both sides are idempotent — identical bytes before and after', async () => {
        // Arrange
        runGit(['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env: commitEnv,
        });
        const ours = createNodeContext({ workDir: pair.ours });
        await commit(ours, { message: 'seed', author: AUTHOR });
        runGit(['-C', pair.peer, 'pack-refs', '--all']);
        await packRefs(ours);
        const peerBefore = await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8');
        const oursBefore = await readFile(path.join(pair.ours, '.git/packed-refs'), 'utf8');

        // Act
        runGit(['-C', pair.peer, 'pack-refs', '--all']);
        const result = await packRefs(ours);

        // Assert
        const peerAfter = await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8');
        const oursAfter = await readFile(path.join(pair.ours, '.git/packed-refs'), 'utf8');
        expect(peerAfter).toBe(peerBefore);
        expect(oursAfter).toBe(oursBefore);
        expect(result.prunedLooseRefCount).toBe(0);
      });
    });
  });

  describe('Given an empty repository on both sides (no commits, no refs)', () => {
    describe('When git pack-refs --all runs on the peer and packRefs runs on ours', () => {
      it('Then git writes a header-only packed-refs while tsgit writes nothing — equivalent-under-readback', async () => {
        // Arrange
        const ours = createNodeContext({ workDir: pair.ours });

        // Act
        runGit(['-C', pair.peer, 'pack-refs', '--all']);
        const result = await packRefs(ours);

        // Assert — a measured, deliberate divergence: git always writes the
        // header even for zero refs; tsgit leaves an absent file absent,
        // since both read back to the identical empty ref set.
        expect(result).toEqual({
          packedRefCount: 0,
          prunedLooseRefCount: 0,
          removedOrphanCount: 0,
        });
        const peerPacked = await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8');
        expect(peerPacked).toBe('# pack-refs with: peeled fully-peeled sorted \n');
        expect(await pathExists(path.join(pair.ours, '.git/packed-refs'))).toBe(false);
      });
    });
  });

  describe('Given a repo with one commit, built identically on both sides', () => {
    describe('When git pack-refs --all runs on the peer and packRefs runs on ours', () => {
      it('Then HEAD stays symbolic and loose on both sides, never packed', async () => {
        // Arrange
        runGit(['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env: commitEnv,
        });
        const ours = createNodeContext({ workDir: pair.ours });
        await commit(ours, { message: 'seed', author: AUTHOR });

        // Act
        runGit(['-C', pair.peer, 'pack-refs', '--all']);
        await packRefs(ours);

        // Assert
        const peerHead = await readFile(path.join(pair.peer, '.git/HEAD'), 'utf8');
        const oursHead = await readFile(path.join(pair.ours, '.git/HEAD'), 'utf8');
        expect(oursHead).toBe(peerHead);
        expect(oursHead).toBe('ref: refs/heads/main\n');
        const peerPacked = await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8');
        expect(peerPacked).not.toContain('HEAD');
      });
    });
  });

  describe('Given an annotated tag pointing at the seeded commit, built identically on both sides', () => {
    describe('When git pack-refs --all runs on the peer and packRefs runs on ours', () => {
      it('Then the packed-refs bytes match, including the peeled ^ line — proving peelToNonTag against real git', async () => {
        // Arrange — `tagCreate` resolves its tagger identity via
        // `resolveCurrentIdentity` (real wall-clock `Date.now()`, no
        // override), so it can never reproduce a pinned SHA. `writeObject`
        // bypasses it, given the SAME tagger identity `commitEnv` pins for
        // git's own `GIT_COMMITTER_*` — the two annotated tag objects are
        // then byte-identical by construction, not merely by luck.
        runGit(['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env: commitEnv,
        });
        const commitId = git(pair.peer, 'rev-parse', 'HEAD').trim();
        runGit(['-C', pair.peer, 'tag', '-a', 'v1', '-m', 'release'], { env: commitEnv });
        const peerTagId = git(pair.peer, 'rev-parse', 'refs/tags/v1').trim();

        const ours = createNodeContext({ workDir: pair.ours });
        await commit(ours, { message: 'seed', author: AUTHOR });
        const oursTagId = await writeObject(ours, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commitId as ObjectId,
            objectType: 'commit',
            tagName: 'v1',
            tagger: AUTHOR,
            message: 'release\n',
            extraHeaders: [],
          },
        });
        expect(oursTagId).toBe(peerTagId);
        await ours.fs.writeUtf8(`${ours.layout.gitDir}/refs/tags/v1`, `${oursTagId}\n`);

        // Act
        runGit(['-C', pair.peer, 'pack-refs', '--all']);
        const result = await packRefs(ours);

        // Assert
        expect(result.packedRefCount).toBeGreaterThan(0);
        const peerPacked = await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8');
        const oursPacked = await readFile(path.join(pair.ours, '.git/packed-refs'), 'utf8');
        expect(oursPacked).toBe(peerPacked);
        expect(peerPacked).toContain(`^${commitId}`);
      });
    });
  });

  describe('Given a ref and a ref under its name split across loose and packed storage on both sides', () => {
    /** Seeds the commit, packs `packedName` through a placeholder line git
     *  writes itself, then plants `looseName` as a loose file. */
    const seedSplit = async (dir: string, packedName: string, looseName: string): Promise<void> => {
      runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env: commitEnv });
      runGit(['-C', dir, 'update-ref', 'refs/remotes/placeholder', 'HEAD']);
      git(dir, 'pack-refs', '--include', 'refs/remotes/placeholder');
      const packedPath = path.join(dir, '.git', 'packed-refs');
      const packed = await readFile(packedPath, 'utf8');
      await writeFile(packedPath, packed.replace('refs/remotes/placeholder\n', `${packedName}\n`));
      const loosePath = path.join(dir, '.git', looseName);
      await mkdir(path.dirname(loosePath), { recursive: true });
      await writeFile(loosePath, `${git(dir, 'rev-parse', 'HEAD').trim()}\n`);
    };
    const forEachRefNames = (dir: string): readonly string[] =>
      git(dir, 'for-each-ref', '--format=%(refname)')
        .split('\n')
        .filter((line) => line.length > 0);

    describe('When both tools list, resolve and pack the refs', () => {
      it.each([
        {
          label: 'a packed refs/remotes/q/z under a loose file refs/remotes/q',
          packedName: 'refs/remotes/q/z',
          looseName: 'refs/remotes/q',
          gitResolves: false,
        },
        {
          label: 'a packed refs/remotes/d over a loose refs/remotes/d/x',
          packedName: 'refs/remotes/d',
          looseName: 'refs/remotes/d/x',
          gitResolves: true,
        },
      ])(
        'Then listings and packed-refs match git, and the packed name resolves only where git resolves it — $label',
        async ({ packedName, looseName, gitResolves }) => {
          // Arrange
          await seedSplit(pair.peer, packedName, looseName);
          await seedSplit(pair.ours, packedName, looseName);
          const ours = createNodeContext({ workDir: pair.ours });
          const sut = packRefs;

          // Act
          const listed = (await getRefStore(ours).listRefNames()).filter((name) => name !== 'HEAD');
          const gitRevParse = tryRunGitWithExit(
            ['-C', pair.peer, 'rev-parse', '--verify', packedName],
            {
              env: runGitEnv(),
            },
          );
          let resolved: unknown;
          try {
            resolved = await revParse(ours, packedName);
          } catch (err) {
            resolved = (err as TsgitError).data.code;
          }
          runGit(['-C', pair.peer, 'pack-refs', '--all']);
          const result = await sut(ours);

          // Assert
          expect(listed).toEqual(forEachRefNames(pair.peer));
          expect(gitRevParse.exitCode === 0).toBe(gitResolves);
          expect(resolved).toBe(gitResolves ? gitRevParse.stdout.trim() : 'OBJECT_NOT_FOUND');
          expect(result.packedRefCount).toBe(3);
          expect(await readFile(path.join(pair.ours, '.git/packed-refs'), 'utf8')).toBe(
            await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8'),
          );
          expect(await pathExists(path.join(pair.ours, '.git', looseName))).toBe(false);
          expect(await pathExists(path.join(pair.peer, '.git', looseName))).toBe(false);
        },
      );
    });
  });
});

const withReftableStorage = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, refStorage: 'reftable' },
});

const initReftableRepo = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', dir]);
  git(dir, 'config', 'user.name', AUTHOR.name);
  git(dir, 'config', 'user.email', AUTHOR.email);
  disableAutoMaintenance(dir);
};

const showRefLines = (dir: string): string =>
  git(dir, 'show-ref')
    .split('\n')
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');

const tablesListNames = async (stackDir: string): Promise<readonly string[]> =>
  (await readFile(`${stackDir}/tables.list`, 'utf8'))
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);

describe.skipIf(!GIT_AVAILABLE)('packRefs interop — reftable backend', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-pack-refs-reftable-'));
    initReftableRepo(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('Given a git-built reftable stack with a planted orphan table', () => {
    describe('When packRefs runs against it', () => {
      it('Then show-ref, reflog and fsck all agree with the pre-state, suggestCompactionSegment is empty, and the orphan is gone while every listed table survives', async () => {
        // Arrange — a small git-built history, spanning several tables.
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env: commitEnv });
        runGit(['-C', dir, 'branch', 'feature']);
        runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'second'], { env: commitEnv });
        const preShowRef = showRefLines(dir);
        const preReflog = git(dir, 'reflog', 'show', 'main');
        const preFsck = git(dir, 'fsck');

        const stackDir = `${dir}/.git/reftable`;
        const preNames = await tablesListNames(stackDir);
        const orphanPath = `${stackDir}/0x000000000099-0x000000000099-deadbeef.ref`;
        await cp(`${stackDir}/${preNames[preNames.length - 1]}`, orphanPath);

        const ctx = withReftableStorage(createNodeContext({ workDir: dir }));

        // Act
        const result = await packRefs(ctx);

        // Assert — git's own read tools see the identical logical state.
        expect(showRefLines(dir)).toBe(preShowRef);
        expect(git(dir, 'reflog', 'show', 'main')).toBe(preReflog);
        expect(git(dir, 'fsck')).toBe(preFsck);

        // The whole stack is now geometric — nothing left to auto-compact.
        const stack = await loadReftableStack(ctx, reftableDir(dir));
        const sizes = stack.tables.map((table) =>
          compactionMetric(table._bytes.length, table.header.version),
        );
        expect(suggestCompactionSegment(sizes, DEFAULT_GEOMETRIC_FACTOR)).toEqual({
          start: 0,
          end: 0,
        });

        // The orphan is gone; every table the post-compaction list names survives.
        expect(result.removedOrphanCount).toBeGreaterThanOrEqual(1);
        expect(await pathExists(orphanPath)).toBe(false);
        const postNames = await tablesListNames(stackDir);
        for (const name of postNames) {
          expect(await pathExists(`${stackDir}/${name}`)).toBe(true);
        }
      });
    });
  });
});
