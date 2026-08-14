/**
 * Cross-tool interop — the git-parity containment posture. Pins the eight
 * behaviours the containment redesign claims against canonical git: hostile
 * tree entry names and the `.gitmodules` mode arm are refused at the same
 * index-write stage in both tools; a tracked directory or leaf replaced on
 * disk by a symlink is reported, refused, and materialised identically;
 * checkout's write/delete through a symlinked leading directory matches
 * git's unlink-and-create and skip-silently shapes; the object store and the
 * working-tree root stay reachable through a symlink; and a symlink target
 * that escapes the repository is written verbatim, never validated, in both
 * tools. Every fixture is built with real git plumbing (`hash-object`,
 * `mktree`, `commit-tree`) so the same objects are readable regardless of
 * which tool wrote them; assertions compare on-disk state and structured
 * results, never message bytes.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         git-parity containment posture matches git end to end
 *   interopSurface: checkout, add, status, cat-file
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pushStashRef } from '../../src/application/primitives/stash-ref.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  lsStage,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

// ── shared fixture helpers ──────────────────────────────────────────────

/** A fresh, realpath-resolved tmpdir root for one scenario group. */
const mkRoot = async (slug: string): Promise<string> =>
  realpath(await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-gpc-${slug}-`)));

const initPeerDir = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  runGit(['-C', dir, 'config', 'core.symlinks', 'true']);
  disableAutoMaintenance(dir);
};

interface RepoPair {
  readonly peerDir: string;
  readonly oursDir: string;
  readonly repo: Repository;
}

/** Builds a peer (real git) / ours (tsgit) directory pair, each carrying one
 * seed commit on `main` — a well-formed starting point that sidesteps any
 * unborn-HEAD edge case for the tests built on top of it. */
const buildSeededPair = async (root: string, slug: string): Promise<RepoPair> => {
  const peerDir = path.join(root, `${slug}-peer`);
  const oursDir = path.join(root, `${slug}-ours`);

  initPeerDir(peerDir);
  writeFileSync(path.join(peerDir, 'seed.txt'), 'seed\n');
  runGit(['-C', peerDir, 'add', 'seed.txt']);
  runGit(['-C', peerDir, 'commit', '-q', '-m', 'seed'], { env: COMMIT_ENV });

  await mkdir(oursDir, { recursive: true });
  const repo = await openRepository({ cwd: oursDir });
  await repo.init();
  disableAutoMaintenance(oursDir);
  writeFileSync(path.join(oursDir, 'seed.txt'), 'seed\n');
  await repo.add(['seed.txt']);
  await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });

  return { peerDir, oursDir, repo };
};

const workingTreeEntries = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir)
    .filter((entry) => entry !== '.git')
    .sort();

// ── raw plumbing helpers — git mktree/hash-object accept entry names and
// modes that git's own higher-level commands refuse; the refusal this suite
// pins fires at the index-write stage, not at tree construction (the
// plumbing escape hatch). ─────────────────────────────────────────────────

const writeBlobText = (dir: string, content: string): string =>
  runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();

/** Raw pre-object bytes for a single tree entry: `<mode> <name>\0<20-byte-raw-oid>`. */
const rawTreeEntryBytes = (mode: string, name: string, oidHex: string): Uint8Array => {
  const header = Buffer.from(`${mode} ${name}\0`, 'utf8');
  const oidBytes = Buffer.from(oidHex, 'hex');
  return new Uint8Array(Buffer.concat([header, oidBytes]));
};

/** Writes a single-entry tree whose entry name/mode git's own `mktree` would
 * refuse to construct via its high-level form — `hash-object --literally`
 * bypasses that client-side check, exactly as `git mktree` does. */
const buildFloatingCommit = (
  dir: string,
  entryMode: string,
  entryName: string,
  entryOidHex: string,
  message: string,
): string => {
  const treeOid = runGit(['-C', dir, 'hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], {
    input: rawTreeEntryBytes(entryMode, entryName, entryOidHex),
  }).trim();
  return runGit(['-C', dir, 'commit-tree', treeOid, '-m', message], { env: COMMIT_ENV }).trim();
};

/** Writes a tree from plain `mktree` entry lines — unlike
 * {@link buildFloatingCommit}'s single hostile-leaf case, `.git`/`git~1` are
 * ordinary, ACCEPTED tree-entry names for plain `mktree` (the refusal fires
 * at index-write/checkout, not tree construction), so no `--literally`
 * escape hatch is needed here. */
const writeTree = (dir: string, lines: ReadonlyArray<string>): string =>
  runGit(['-C', dir, 'mktree'], { input: `${lines.join('\n')}\n` }).trim();

/** Builds `.git/hooks/pre-commit` as a stash's untracked-tree root — the
 * shape a crafted/foreign stash could carry to overwrite a hook on apply. */
const buildHostileUntrackedTree = (dir: string): string => {
  const hookBlob = writeBlobText(dir, '#!/bin/sh\necho pwned\n');
  const hooksTree = writeTree(dir, [`100644 blob ${hookBlob}\tpre-commit`]);
  const gitDirTree = writeTree(dir, [`40000 tree ${hooksTree}\thooks`]);
  return writeTree(dir, [`40000 tree ${gitDirTree}\t.git`]);
};

/** Builds a stash W commit trio (index parent `i`, untracked parent `u`,
 * working-tree commit `w`) whose W and I trees are the repo's current HEAD
 * tree (no staged/working changes) and whose U tree is `untrackedTree` —
 * isolating the untracked-tree shape as the only variable under test. */
const buildStashCommitTrio = (dir: string, untrackedTree: string): string => {
  const head = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
  const baseTree = runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}']).trim();
  const u = runGit(['-C', dir, 'commit-tree', untrackedTree, '-m', 'untracked files on main'], {
    env: COMMIT_ENV,
  }).trim();
  const i = runGit(['-C', dir, 'commit-tree', baseTree, '-p', head, '-m', 'index on main'], {
    env: COMMIT_ENV,
  }).trim();
  return runGit(
    ['-C', dir, 'commit-tree', baseTree, '-p', head, '-p', i, '-p', u, '-m', 'WIP on main: base'],
    { env: COMMIT_ENV },
  ).trim();
};

describe.skipIf(!GIT_AVAILABLE)('git-parity containment interop', () => {
  // ── 1. hostile tree entry names ─────────────────────────────────────

  describe('Given a tree entry name that only index-write refuses (not tree construction)', () => {
    const HOSTILE_NAMES: ReadonlyArray<{
      readonly label: string;
      readonly name: string;
      readonly branch: string;
    }> = [
      { label: 'a `..` entry', name: '..', branch: 'case-dotdot' },
      { label: 'a `.git` entry', name: '.git', branch: 'case-dotgit' },
      { label: 'an NTFS `git~1` short-name alias', name: 'git~1', branch: 'case-ntfs' },
      { label: 'an HFS+ ignorable-codepoint `.git` alias', name: '.gi‌t', branch: 'case-hfs' },
    ];

    interface HostileCaseFixture {
      readonly peerDestDir: string;
      readonly oursDir: string;
      readonly oursSeedOid: string;
      readonly oursCode: string | undefined;
      readonly peerExitCode: number;
    }

    let root: string;
    let fixtures: Map<string, HostileCaseFixture>;
    let reposToDispose: Repository[];

    beforeAll(async () => {
      root = await mkRoot('hostile-names');
      const peerSrcDir = path.join(root, 'peer-src');
      initPeerDir(peerSrcDir);

      fixtures = new Map();
      reposToDispose = [];
      // Every case builds its OWN independent peer clone destination and
      // tsgit repo — a refused checkout leaves state untouched (verified
      // below), but a case that later gets extended to an accepting mode
      // must never observe a sibling case's leftovers.
      for (const { name, branch } of HOSTILE_NAMES) {
        const peerBlob = writeBlobText(peerSrcDir, 'hostile');
        const peerCommit = buildFloatingCommit(peerSrcDir, '100644', name, peerBlob, 'hostile');
        runGit(['-C', peerSrcDir, 'update-ref', `refs/heads/${branch}`, peerCommit]);
        const peerDestDir = path.join(root, `${branch}-peer-dest`);
        const peerCloneResult = tryRunGitWithExit([
          'clone',
          '-q',
          '--branch',
          branch,
          peerSrcDir,
          peerDestDir,
        ]);

        const oursDir = path.join(root, `${branch}-ours`);
        await mkdir(oursDir, { recursive: true });
        const repo = await openRepository({ cwd: oursDir });
        await repo.init();
        writeFileSync(path.join(oursDir, 'seed.txt'), 'seed\n');
        await repo.add(['seed.txt']);
        const seedCommit = await repo.commit({
          message: 'seed',
          author: AUTHOR,
          committer: AUTHOR,
        });
        const oursBlob = writeBlobText(oursDir, 'hostile');
        const oursCommit = buildFloatingCommit(oursDir, '100644', name, oursBlob, 'hostile');

        let oursCode: string | undefined;
        try {
          await repo.checkout({ rev: oursCommit as ObjectId });
        } catch (err) {
          oursCode = (err as { readonly data?: { readonly code?: string } }).data?.code;
        }
        reposToDispose.push(repo);

        fixtures.set(name, {
          peerDestDir,
          oursDir,
          oursSeedOid: seedCommit.id,
          oursCode,
          peerExitCode: peerCloneResult.exitCode,
        });
      }
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await Promise.all(reposToDispose.map((repo) => repo.dispose()));
      await rm(root, { recursive: true, force: true });
    });

    describe('When both tools try to materialise a commit whose tree carries it', () => {
      it.each(HOSTILE_NAMES)(
        'Then $label is refused by both and the destination keeps only the seed state',
        ({ name }) => {
          // Arrange
          const fixture = fixtures.get(name);
          if (fixture === undefined) throw new Error('missing fixture for this case');

          // Assert — git's clone reports the working-tree checkout step as
          // failed and leaves the destination holding only `.git`
          expect(fixture.peerExitCode).toBe(128);
          expect(workingTreeEntries(fixture.peerDestDir)).toEqual([]);
          // Assert — tsgit refuses too, and nothing was partially written:
          // the destination keeps only the seed file and HEAD never moved.
          // `..` is caught one stage earlier (tree parse — pre-existing,
          // stricter than git) than the three `.git` aliases (index write —
          // this feature's new check): same outcome, different internal code.
          expect(fixture.oursCode).toBe(
            name === '..' ? 'INVALID_TREE_ENTRY' : 'INVALID_INDEX_ENTRY',
          );
          expect(workingTreeEntries(fixture.oursDir)).toEqual(['seed.txt']);
          expect(git(fixture.oursDir, 'rev-parse', 'HEAD').trim()).toBe(fixture.oursSeedOid);
        },
      );
    });
  });

  // ── 2. .gitmodules mode arm ──────────────────────────────────────────

  describe('Given a `.gitmodules` entry whose mode determines the index-write refusal', () => {
    const MODE_CASES: ReadonlyArray<{
      readonly label: string;
      readonly branch: string;
      readonly mode: string;
      readonly expectAccept: boolean;
    }> = [
      {
        label: 'a regular-file `.gitmodules` (mode 100644)',
        branch: 'case-gm-644',
        mode: '100644',
        expectAccept: true,
      },
      {
        label:
          'a gitlink `.gitmodules` (mode 160000) — its oid is an opaque commit reference; checkout never fetches or validates it',
        branch: 'case-gm-160000',
        mode: '160000',
        expectAccept: true,
      },
      {
        label: 'a symlinked `.gitmodules` (mode 120000, CVE-2018-11235 hardening)',
        branch: 'case-gm-120000',
        mode: '120000',
        expectAccept: false,
      },
    ];

    interface ModeArmFixture {
      readonly peerDestDir: string;
      readonly oursDir: string;
      readonly oursSeedOid: string;
      readonly oursCode: string | undefined;
      readonly peerExitCode: number;
    }

    /** A gitlink entry carries an opaque commit oid, never a blob — every
     * other mode stores `.gitmodules` as a small regular-file blob. */
    const buildModeArmEntryOid = (dir: string, mode: string): string =>
      mode === '160000' ? 'c'.repeat(40) : writeBlobText(dir, '[submodule "x"]\n');

    let root: string;
    let fixtures: Map<string, ModeArmFixture>;
    let reposToDispose: Repository[];

    beforeAll(async () => {
      root = await mkRoot('gitmodules-mode');
      const peerSrcDir = path.join(root, 'peer-src');
      initPeerDir(peerSrcDir);

      fixtures = new Map();
      reposToDispose = [];
      // Every case builds its own independent destinations — a case that
      // materialises `.gitmodules` as a gitlink placeholder directory must
      // never leave state for a sibling case's regular-file entry to collide
      // with (mkdir-over-existing-file is a real, if unrelated, refusal).
      for (const { branch, mode } of MODE_CASES) {
        const peerEntryOid = buildModeArmEntryOid(peerSrcDir, mode);
        const peerCommit = buildFloatingCommit(
          peerSrcDir,
          mode,
          '.gitmodules',
          peerEntryOid,
          branch,
        );
        runGit(['-C', peerSrcDir, 'update-ref', `refs/heads/${branch}`, peerCommit]);
        const peerDestDir = path.join(root, `${branch}-peer-dest`);
        const peerCloneResult = tryRunGitWithExit([
          'clone',
          '-q',
          '--branch',
          branch,
          peerSrcDir,
          peerDestDir,
        ]);

        const oursDir = path.join(root, `${branch}-ours`);
        await mkdir(oursDir, { recursive: true });
        const repo = await openRepository({ cwd: oursDir });
        await repo.init();
        writeFileSync(path.join(oursDir, 'seed.txt'), 'seed\n');
        await repo.add(['seed.txt']);
        const seedCommit = await repo.commit({
          message: 'seed',
          author: AUTHOR,
          committer: AUTHOR,
        });
        const oursEntryOid = buildModeArmEntryOid(oursDir, mode);
        const oursCommit = buildFloatingCommit(oursDir, mode, '.gitmodules', oursEntryOid, branch);

        let oursCode: string | undefined;
        try {
          await repo.checkout({ rev: oursCommit as ObjectId });
        } catch (err) {
          oursCode = (err as { readonly data?: { readonly code?: string } }).data?.code;
        }
        reposToDispose.push(repo);

        fixtures.set(branch, {
          peerDestDir,
          oursDir,
          oursSeedOid: seedCommit.id,
          oursCode,
          peerExitCode: peerCloneResult.exitCode,
        });
      }
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await Promise.all(reposToDispose.map((repo) => repo.dispose()));
      await rm(root, { recursive: true, force: true });
    });

    describe('When both tools try to materialise each mode arm', () => {
      it.each(MODE_CASES)(
        'Then $label matches the pinned accept/reject verdict in both',
        ({ branch, expectAccept }) => {
          // Arrange
          const fixture = fixtures.get(branch);
          if (fixture === undefined) throw new Error('missing fixture for this case');

          if (expectAccept) {
            // Assert — both accept it and the index stages agree
            expect(fixture.peerExitCode).toBe(0);
            expect(fixture.oursCode).toBeUndefined();
            expect(lsStage(fixture.oursDir)).toBe(lsStage(fixture.peerDestDir));
          } else {
            // Assert — both refuse it; the destination keeps only the seed state
            expect(fixture.peerExitCode).toBe(128);
            expect(workingTreeEntries(fixture.peerDestDir)).toEqual([]);
            expect(fixture.oursCode).toBe('INVALID_INDEX_ENTRY');
            expect(workingTreeEntries(fixture.oursDir)).toEqual(['seed.txt']);
            expect(git(fixture.oursDir, 'rev-parse', 'HEAD').trim()).toBe(fixture.oursSeedOid);
          }
        },
      );
    });
  });

  // ── 3. symlinked leading directory over a tracked child ─────────────

  interface SymlinkedDirFixture {
    readonly root: string;
    readonly pair: RepoPair;
    readonly outsideDir: string;
  }

  const buildSymlinkedDirFixture = async (slug: string): Promise<SymlinkedDirFixture> => {
    const root = await mkRoot(slug);
    const pair = await buildSeededPair(root, slug);
    const outsideDir = path.join(root, 'outside');
    mkdirSync(outsideDir, { recursive: true });

    mkdirSync(path.join(pair.peerDir, 'dir'), { recursive: true });
    writeFileSync(path.join(pair.peerDir, 'dir', 'file'), 'inside\n');
    runGit(['-C', pair.peerDir, 'add', 'dir/file']);
    runGit(['-C', pair.peerDir, 'commit', '-q', '-m', 'track dir/file'], { env: COMMIT_ENV });
    rmSync(path.join(pair.peerDir, 'dir'), { recursive: true, force: true });
    symlinkSync(outsideDir, path.join(pair.peerDir, 'dir'));

    mkdirSync(path.join(pair.oursDir, 'dir'), { recursive: true });
    writeFileSync(path.join(pair.oursDir, 'dir', 'file'), 'inside\n');
    await pair.repo.add(['dir/file']);
    await pair.repo.commit({ message: 'track dir/file', author: AUTHOR, committer: AUTHOR });
    rmSync(path.join(pair.oursDir, 'dir'), { recursive: true, force: true });
    symlinkSync(outsideDir, path.join(pair.oursDir, 'dir'));

    return { root, pair, outsideDir };
  };

  describe('Given a tracked directory replaced on disk by a symlink to an external target', () => {
    describe('When status is queried while the leading directory is a symlink', () => {
      let fixture: SymlinkedDirFixture;

      beforeAll(async () => {
        fixture = await buildSymlinkedDirFixture('symlinked-dir-status');
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await fixture.pair.repo.dispose();
        await rm(fixture.root, { recursive: true, force: true });
      });

      it('Then both report the symlink as untracked and the tracked child as deleted', async () => {
        // Arrange & Act
        const peerStatus = git(fixture.pair.peerDir, 'status', '--porcelain');
        const oursStatus = await fixture.pair.repo.status();

        // Assert — git: `?? dir` (no trailing slash — the walk never
        // traverses the symlink) and ` D dir/file`
        expect(peerStatus).toContain('?? dir\n');
        expect(peerStatus).toContain(' D dir/file\n');
        // Assert — tsgit's structured equivalent
        expect(oursStatus.untracked).toContain('dir');
        const deleted = oursStatus.changes.find((change) => change.path === 'dir/file');
        expect(deleted?.unstaged).toBe('deleted');
      });
    });

    describe('When a literal `add` targets the tracked child behind the symlink', () => {
      let fixture: SymlinkedDirFixture;

      beforeAll(async () => {
        fixture = await buildSymlinkedDirFixture('symlinked-dir-add-single');
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await fixture.pair.repo.dispose();
        await rm(fixture.root, { recursive: true, force: true });
      });

      it('Then both refuse the pathspec instead of writing through the symlink', async () => {
        // Arrange — the symlinked-dir fixture is prepared once in beforeAll
        const { pair } = fixture;

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peerDir, 'add', 'dir/file']);
        let oursCode: string | undefined;
        let oursPath: string | undefined;
        try {
          await pair.repo.add(['dir/file']);
        } catch (err) {
          const data = (
            err as { readonly data?: { readonly code?: string; readonly path?: string } }
          ).data;
          oursCode = data?.code;
          oursPath = data?.path;
        }

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain('beyond a symbolic link');
        expect(oursCode).toBe('PATHSPEC_BEYOND_SYMLINK');
        expect(oursPath).toBe('dir/file');
      });
    });

    describe('When a glob `add` targets a pathspec beyond the symlinked leading directory', () => {
      let fixture: SymlinkedDirFixture;

      beforeAll(async () => {
        fixture = await buildSymlinkedDirFixture('symlinked-dir-add-glob');
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await fixture.pair.repo.dispose();
        await rm(fixture.root, { recursive: true, force: true });
      });

      it('Then both refuse the pathspec instead of writing through the symlink', async () => {
        // Arrange — the symlinked-dir fixture is prepared once in beforeAll
        const { pair } = fixture;

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peerDir, 'add', 'dir/*']);
        let oursCode: string | undefined;
        let oursPath: string | undefined;
        try {
          await pair.repo.add(['dir/*']);
        } catch (err) {
          const data = (
            err as { readonly data?: { readonly code?: string; readonly path?: string } }
          ).data;
          oursCode = data?.code;
          oursPath = data?.path;
        }

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain('beyond a symbolic link');
        expect(oursCode).toBe('PATHSPEC_BEYOND_SYMLINK');
        expect(oursPath).toBe('dir/*');
      });
    });

    describe('When `add -A` runs while the leading directory is a symlink', () => {
      let fixture: SymlinkedDirFixture;

      beforeAll(async () => {
        fixture = await buildSymlinkedDirFixture('symlinked-dir-add-all');
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await fixture.pair.repo.dispose();
        await rm(fixture.root, { recursive: true, force: true });
      });

      it('Then both stage the symlink itself as a 120000 entry and leave the outside file untouched', async () => {
        // Arrange
        const markerPath = path.join(fixture.outsideDir, 'marker.txt');
        writeFileSync(markerPath, 'untouched\n');

        // Act
        runGit(['-C', fixture.pair.peerDir, 'add', '-A']);
        await fixture.pair.repo.add([], { all: true });

        // Assert — index stages agree, and the symlink itself carries mode 120000
        expect(lsStage(fixture.pair.oursDir)).toBe(lsStage(fixture.pair.peerDir));
        expect(lsStage(fixture.pair.oursDir)).toMatch(/^120000 \S+ 0\tdir$/m);
        expect(lsStage(fixture.pair.oursDir)).not.toContain('dir/file');
        // Assert — the outside file was never touched
        expect(readFileSync(markerPath, 'utf8')).toBe('untouched\n');
      });
    });
  });

  // ── 4. leaf symlink pointing outside the repository ──────────────────

  describe('Given a tracked leaf symlink pointing outside the repository', () => {
    let root: string;
    let pair: RepoPair;
    let outsideDir: string;
    let secretPath: string;

    beforeAll(async () => {
      root = await mkRoot('leaf-symlink');
      pair = await buildSeededPair(root, 'leaf');
      outsideDir = path.join(root, 'outside');
      mkdirSync(outsideDir, { recursive: true });
      secretPath = path.join(outsideDir, 'secret');
      writeFileSync(secretPath, 'do-not-touch\n');

      symlinkSync(secretPath, path.join(pair.peerDir, 'link'));
      runGit(['-C', pair.peerDir, 'add', 'link']);
      runGit(['-C', pair.peerDir, 'commit', '-q', '-m', 'track link'], { env: COMMIT_ENV });
      runGit(['-C', pair.peerDir, 'checkout', '-q', '-b', 'feat']);
      unlinkSync(path.join(pair.peerDir, 'link'));
      writeFileSync(path.join(pair.peerDir, 'link'), 'regular content\n');
      runGit(['-C', pair.peerDir, 'add', 'link']);
      runGit(['-C', pair.peerDir, 'commit', '-q', '-m', 'replace with regular file'], {
        env: COMMIT_ENV,
      });
      runGit(['-C', pair.peerDir, 'checkout', '-q', 'main']);

      symlinkSync(secretPath, path.join(pair.oursDir, 'link'));
      await pair.repo.add(['link']);
      await pair.repo.commit({ message: 'track link', author: AUTHOR, committer: AUTHOR });
      await pair.repo.branch.create({ name: 'feat' });
      await pair.repo.checkout({ rev: 'feat' });
      unlinkSync(path.join(pair.oursDir, 'link'));
      writeFileSync(path.join(pair.oursDir, 'link'), 'regular content\n');
      await pair.repo.add(['link']);
      await pair.repo.commit({
        message: 'replace with regular file',
        author: AUTHOR,
        committer: AUTHOR,
      });
      await pair.repo.checkout({ rev: 'main' });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await pair.repo.dispose();
      await rm(root, { recursive: true, force: true });
    });

    describe('When the symlink is read back from the index', () => {
      it('Then both store the target path itself as the blob content, never dereferencing it', () => {
        // Arrange & Act
        const peerBlob = git(pair.peerDir, 'cat-file', '-p', 'HEAD:link').trim();
        const oursBlob = git(pair.oursDir, 'cat-file', '-p', 'HEAD:link').trim();

        // Assert
        expect(peerBlob).toBe(secretPath);
        expect(oursBlob).toBe(secretPath);
      });
    });

    // Runs after the read-back check above — the only test in this group
    // that moves both tools off `main`, so it is ordered last on purpose.
    describe('When both tools check out the branch that replaces the symlink with a regular file', () => {
      it('Then the link becomes a regular file on disk and the outside target is byte-identical', async () => {
        // Arrange
        const beforeBytes = readFileSync(secretPath);

        // Act
        runGit(['-C', pair.peerDir, 'checkout', '-q', 'feat']);
        await pair.repo.checkout({ rev: 'feat' });

        // Assert — the link itself is now a regular file with feat's content
        expect(lstatSync(path.join(pair.peerDir, 'link')).isSymbolicLink()).toBe(false);
        expect(lstatSync(path.join(pair.oursDir, 'link')).isSymbolicLink()).toBe(false);
        expect(readFileSync(path.join(pair.oursDir, 'link'), 'utf8')).toBe('regular content\n');
        expect(lsStage(pair.oursDir)).toBe(lsStage(pair.peerDir));
        // Assert — the outside target was only ever a symlink's opaque blob
        // content; checkout unlinked the entry, never the file it pointed at
        expect(readFileSync(secretPath)).toEqual(beforeBytes);
      });
    });
  });

  // ── 5. checkout writes/deletes through a symlinked leading directory ─

  describe('Given a tracked path behind a symlinked leading directory, When checkout writes it back', () => {
    let root: string;
    let pair: RepoPair;
    let outsideDir: string;

    beforeAll(async () => {
      root = await mkRoot('write-through-symlink');
      pair = await buildSeededPair(root, 'wts');
      outsideDir = path.join(root, 'outside');
      mkdirSync(outsideDir, { recursive: true });

      mkdirSync(path.join(pair.peerDir, 'dir'), { recursive: true });
      writeFileSync(path.join(pair.peerDir, 'dir', 'file'), 'tracked\n');
      runGit(['-C', pair.peerDir, 'add', 'dir/file']);
      runGit(['-C', pair.peerDir, 'commit', '-q', '-m', 'track dir/file'], { env: COMMIT_ENV });

      mkdirSync(path.join(pair.oursDir, 'dir'), { recursive: true });
      writeFileSync(path.join(pair.oursDir, 'dir', 'file'), 'tracked\n');
      await pair.repo.add(['dir/file']);
      await pair.repo.commit({ message: 'track dir/file', author: AUTHOR, committer: AUTHOR });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await pair.repo.dispose();
      await rm(root, { recursive: true, force: true });
    });

    it('Then both unlink the symlink, create a real directory, and write the file inside the repo', async () => {
      // Arrange — someone replaced the tracked directory with a symlink
      rmSync(path.join(pair.peerDir, 'dir'), { recursive: true, force: true });
      symlinkSync(outsideDir, path.join(pair.peerDir, 'dir'));
      rmSync(path.join(pair.oursDir, 'dir'), { recursive: true, force: true });
      symlinkSync(outsideDir, path.join(pair.oursDir, 'dir'));

      // Act — force-restore the tracked path from the index
      const peerResult = tryRunGitWithExit(['-C', pair.peerDir, 'checkout', '--', 'dir/file']);
      await pair.repo.checkout({ paths: ['dir/file'] });

      // Assert — both replaced the symlink with a real directory and wrote inside the repo
      expect(peerResult.exitCode).toBe(0);
      expect(lstatSync(path.join(pair.peerDir, 'dir')).isSymbolicLink()).toBe(false);
      expect(lstatSync(path.join(pair.oursDir, 'dir')).isSymbolicLink()).toBe(false);
      expect(readFileSync(path.join(pair.oursDir, 'dir', 'file'), 'utf8')).toBe('tracked\n');
      // Assert — the directory the symlink used to point at is untouched
      expect(readdirSync(outsideDir)).toEqual([]);
    });
  });

  describe('Given a tracked path behind a symlinked leading directory, When checkout deletes it', () => {
    let root: string;
    let pair: RepoPair;
    let outsideDir: string;

    beforeAll(async () => {
      root = await mkRoot('delete-through-symlink');
      pair = await buildSeededPair(root, 'dts');
      outsideDir = path.join(root, 'outside');
      mkdirSync(outsideDir, { recursive: true });

      mkdirSync(path.join(pair.peerDir, 'dir'), { recursive: true });
      writeFileSync(path.join(pair.peerDir, 'dir', 'file'), 'tracked\n');
      runGit(['-C', pair.peerDir, 'add', 'dir/file']);
      runGit(['-C', pair.peerDir, 'commit', '-q', '-m', 'track dir/file'], { env: COMMIT_ENV });
      runGit(['-C', pair.peerDir, 'checkout', '-q', '-b', 'no-dir-file']);
      runGit(['-C', pair.peerDir, 'rm', '-q', '-r', 'dir']);
      runGit(['-C', pair.peerDir, 'commit', '-q', '-m', 'remove dir/file'], { env: COMMIT_ENV });
      runGit(['-C', pair.peerDir, 'checkout', '-q', 'main']);

      mkdirSync(path.join(pair.oursDir, 'dir'), { recursive: true });
      writeFileSync(path.join(pair.oursDir, 'dir', 'file'), 'tracked\n');
      await pair.repo.add(['dir/file']);
      await pair.repo.commit({ message: 'track dir/file', author: AUTHOR, committer: AUTHOR });
      await pair.repo.branch.create({ name: 'no-dir-file' });
      await pair.repo.checkout({ rev: 'no-dir-file' });
      await pair.repo.rm(['dir/file']);
      await pair.repo.commit({ message: 'remove dir/file', author: AUTHOR, committer: AUTHOR });
      await pair.repo.checkout({ rev: 'main' });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await pair.repo.dispose();
      await rm(root, { recursive: true, force: true });
    });

    it('Then both skip the removal, leave the symlink intact, and exit clean', async () => {
      // Arrange — the tracked directory is now a symlink on disk
      rmSync(path.join(pair.peerDir, 'dir'), { recursive: true, force: true });
      symlinkSync(outsideDir, path.join(pair.peerDir, 'dir'));
      rmSync(path.join(pair.oursDir, 'dir'), { recursive: true, force: true });
      symlinkSync(outsideDir, path.join(pair.oursDir, 'dir'));
      const markerPath = path.join(outsideDir, 'marker.txt');
      writeFileSync(markerPath, 'untouched\n');

      // Act — forced switch to the branch that deletes dir/file
      const peerResult = tryRunGitWithExit([
        '-C',
        pair.peerDir,
        'checkout',
        '-f',
        '-q',
        'no-dir-file',
      ]);
      await pair.repo.checkout({ rev: 'no-dir-file', force: true });

      // Assert — the removal was skipped; the symlink is still there, unchanged
      expect(peerResult.exitCode).toBe(0);
      expect(lstatSync(path.join(pair.peerDir, 'dir')).isSymbolicLink()).toBe(true);
      expect(lstatSync(path.join(pair.oursDir, 'dir')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(pair.oursDir, 'dir'))).toBe(outsideDir);
      expect(lsStage(pair.oursDir)).toBe(lsStage(pair.peerDir));
      // Assert — the directory the symlink points at was never touched
      expect(readFileSync(markerPath, 'utf8')).toBe('untouched\n');
    });
  });

  // ── 6. object store reached through a symlink ────────────────────────

  describe('Given the object store is reached through a symlink', () => {
    describe('When `.git/objects` itself is moved out and symlinked back', () => {
      let root: string;
      let pair: RepoPair;

      beforeAll(async () => {
        root = await mkRoot('objects-symlinked');
        pair = await buildSeededPair(root, 'obj');
        writeFileSync(path.join(pair.peerDir, 'f'), 'hi\n');
        runGit(['-C', pair.peerDir, 'add', 'f']);
        runGit(['-C', pair.peerDir, 'commit', '-q', '-m', 'add f'], { env: COMMIT_ENV });
        writeFileSync(path.join(pair.oursDir, 'f'), 'hi\n');
        await pair.repo.add(['f']);
        await pair.repo.commit({ message: 'add f', author: AUTHOR, committer: AUTHOR });

        const peerObjectsOutside = path.join(root, 'peer-objects-outside');
        renameSync(path.join(pair.peerDir, '.git', 'objects'), peerObjectsOutside);
        symlinkSync(peerObjectsOutside, path.join(pair.peerDir, '.git', 'objects'));

        const oursObjectsOutside = path.join(root, 'ours-objects-outside');
        renameSync(path.join(pair.oursDir, '.git', 'objects'), oursObjectsOutside);
        symlinkSync(oursObjectsOutside, path.join(pair.oursDir, '.git', 'objects'));
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await pair.repo.dispose();
        await rm(root, { recursive: true, force: true });
      });

      it('Then both tools still read the blob through the symlinked objects directory', async () => {
        // Arrange
        const blobOid = git(pair.oursDir, 'rev-parse', 'HEAD:f').trim() as ObjectId;
        const peerContent = git(pair.peerDir, 'cat-file', '-p', 'HEAD:f');

        // Act
        const result = await pair.repo.catFile({ ids: [blobOid] });

        // Assert
        expect(peerContent).toBe('hi\n');
        const entry = result.entries[0];
        if (entry === undefined || !entry.ok || entry.object.type !== 'blob') {
          expect.unreachable('expected a readable blob');
        } else {
          expect(Buffer.from(entry.object.content).toString('utf8')).toBe('hi\n');
        }
      });
    });

    describe('When `.git` itself is moved out and symlinked back', () => {
      let root: string;
      let peerDir: string;
      let oursDir: string;

      beforeAll(async () => {
        root = await mkRoot('gitdir-symlinked');
        peerDir = path.join(root, 'peer');
        oursDir = path.join(root, 'ours');
        initPeerDir(peerDir);
        writeFileSync(path.join(peerDir, 'f'), 'hi\n');
        runGit(['-C', peerDir, 'add', 'f']);
        runGit(['-C', peerDir, 'commit', '-q', '-m', 'add f'], { env: COMMIT_ENV });

        await mkdir(oursDir, { recursive: true });
        const setupRepo = await openRepository({ cwd: oursDir });
        await setupRepo.init();
        writeFileSync(path.join(oursDir, 'f'), 'hi\n');
        await setupRepo.add(['f']);
        await setupRepo.commit({ message: 'add f', author: AUTHOR, committer: AUTHOR });
        await setupRepo.dispose();

        const peerGitOutside = path.join(root, 'peer-git-outside');
        renameSync(path.join(peerDir, '.git'), peerGitOutside);
        symlinkSync(peerGitOutside, path.join(peerDir, '.git'));

        const oursGitOutside = path.join(root, 'ours-git-outside');
        renameSync(path.join(oursDir, '.git'), oursGitOutside);
        symlinkSync(oursGitOutside, path.join(oursDir, '.git'));
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(root, { recursive: true, force: true });
      });

      it('Then both tools report the same clean status through the symlinked `.git`', async () => {
        // Arrange
        const peerStatus = git(peerDir, 'status', '--porcelain');
        const repo = await openRepository({ cwd: oursDir });

        try {
          // Act
          const result = await repo.status();

          // Assert
          expect(peerStatus).toBe('');
          expect(result.clean).toBe(true);
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  // ── 7. working-tree root reached through a symlink ───────────────────

  describe('Given the working-tree root is reached through a symlink, When each tool resolves the repository root', () => {
    let root: string;
    let peerRepoDir: string;
    let oursRepoDir: string;
    let peerLinkPath: string;
    let oursLinkPath: string;

    beforeAll(async () => {
      root = await mkRoot('root-through-symlink');
      peerRepoDir = path.join(root, 'peer-real');
      oursRepoDir = path.join(root, 'ours-real');
      initPeerDir(peerRepoDir);
      writeFileSync(path.join(peerRepoDir, 'f'), 'x\n');
      runGit(['-C', peerRepoDir, 'add', 'f']);
      runGit(['-C', peerRepoDir, 'commit', '-q', '-m', 'c1'], { env: COMMIT_ENV });

      await mkdir(oursRepoDir, { recursive: true });
      const setupRepo = await openRepository({ cwd: oursRepoDir });
      await setupRepo.init();
      writeFileSync(path.join(oursRepoDir, 'f'), 'x\n');
      await setupRepo.add(['f']);
      await setupRepo.commit({ message: 'c1', author: AUTHOR, committer: AUTHOR });
      await setupRepo.dispose();

      peerLinkPath = path.join(root, 'peer-link');
      oursLinkPath = path.join(root, 'ours-link');
      symlinkSync(peerRepoDir, peerLinkPath);
      symlinkSync(oursRepoDir, oursLinkPath);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("Then tsgit's resolved working directory matches git's realpath toplevel", async () => {
      // Arrange
      const expectedPeerToplevel = git(peerLinkPath, 'rev-parse', '--show-toplevel').trim();
      const repo = await openRepository({ cwd: oursLinkPath });

      try {
        // Act
        const oursWorkDir = repo.ctx.layout.workDir;

        // Assert — both tools canonicalise the root to the same realpath,
        // never the symlink path itself
        expect(expectedPeerToplevel).toBe(await realpath(peerRepoDir));
        expect(oursWorkDir).toBe(await realpath(oursRepoDir));
      } finally {
        await repo.dispose();
      }
    });
  });

  // ── 8. symlink targets written verbatim ───────────────────────────────

  interface EscapingSymlinkTargets {
    readonly absTarget: string;
    readonly relTarget: string;
    readonly sysTarget: string;
  }

  const escapingSymlinkTargets = (secretPath: string): EscapingSymlinkTargets => ({
    absTarget: secretPath,
    relTarget: '../../../etc/passwd',
    sysTarget: '/etc/passwd',
  });

  const ESCAPING_ENTRY_NAMES = ['abs', 'rel', 'sys'] as const;

  /** Builds a commit with three symlink entries whose targets escape the
   * repository (absolute-and-owned, relative-escaping, and the literal
   * `/etc/passwd` shape) — the plain `mktree` stdin form suffices here since
   * none of the three names are hostile. */
  const buildEscapingSymlinkCommit = (
    dir: string,
    targets: EscapingSymlinkTargets,
    message: string,
    parent?: string,
  ): string => {
    const absBlob = writeBlobText(dir, targets.absTarget);
    const relBlob = writeBlobText(dir, targets.relTarget);
    const sysBlob = writeBlobText(dir, targets.sysTarget);
    const treeOid = runGit(['-C', dir, 'mktree'], {
      input:
        `120000 blob ${absBlob}\tabs\n` +
        `120000 blob ${relBlob}\trel\n` +
        `120000 blob ${sysBlob}\tsys\n`,
    }).trim();
    const args = ['-C', dir, 'commit-tree', treeOid, '-m', message];
    if (parent !== undefined) args.push('-p', parent);
    return runGit(args, { env: COMMIT_ENV }).trim();
  };

  const assertEscapingSymlinksMaterialised = (
    peerDir: string,
    oursDir: string,
    targets: EscapingSymlinkTargets,
  ): void => {
    const byName: Readonly<Record<(typeof ESCAPING_ENTRY_NAMES)[number], string>> = {
      abs: targets.absTarget,
      rel: targets.relTarget,
      sys: targets.sysTarget,
    };
    for (const name of ESCAPING_ENTRY_NAMES) {
      const peerEntryPath = path.join(peerDir, name);
      const oursEntryPath = path.join(oursDir, name);
      expect(lstatSync(peerEntryPath).isSymbolicLink()).toBe(true);
      expect(lstatSync(oursEntryPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(peerEntryPath)).toBe(byName[name]);
      expect(readlinkSync(oursEntryPath)).toBe(byName[name]);
    }
    expect(lsStage(oursDir)).toBe(lsStage(peerDir));
  };

  describe('Given a commit carries symlink entries whose targets escape the repository', () => {
    describe('When each tool materialises it into a fresh working directory', () => {
      let root: string;
      let secretPath: string;
      let peerDestDir: string;
      let oursDir: string;
      let oursCommit: string;

      beforeAll(async () => {
        root = await mkRoot('escaping-symlinks-fresh');
        const outsideDir = path.join(root, 'outside');
        mkdirSync(outsideDir, { recursive: true });
        secretPath = path.join(outsideDir, 'secret');
        writeFileSync(secretPath, 'owned-secret\n');
        const targets = escapingSymlinkTargets(secretPath);

        // A real, non-bare source repo — `git clone` works against it directly.
        const peerSrcDir = path.join(root, 'peer-src');
        initPeerDir(peerSrcDir);
        const peerCommit = buildEscapingSymlinkCommit(peerSrcDir, targets, 'escaping links');
        runGit(['-C', peerSrcDir, 'update-ref', 'refs/heads/main', peerCommit]);
        peerDestDir = path.join(root, 'peer-dest');
        const peerCloneResult = tryRunGitWithExit(['clone', '-q', peerSrcDir, peerDestDir]);
        if (peerCloneResult.exitCode !== 0) {
          throw new Error(`fixture git clone failed: ${peerCloneResult.stderr}`);
        }

        // tsgit has no local-filesystem clone transport (only smart-HTTP and
        // SSH); the object store is seeded directly with real git plumbing —
        // exactly how every other fixture in this suite is built — and the
        // write path under test (checkout materialising the tree onto a
        // fresh working directory) is exercised through tsgit's own
        // `checkout`, the surface this posture actually changed.
        oursDir = path.join(root, 'ours-dest');
        await mkdir(oursDir, { recursive: true });
        const seedRepo = await openRepository({ cwd: oursDir });
        await seedRepo.init();
        await seedRepo.dispose();
        oursCommit = buildEscapingSymlinkCommit(oursDir, targets, 'escaping links');
        runGit(['-C', oursDir, 'update-ref', 'refs/heads/main', oursCommit]);
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(root, { recursive: true, force: true });
      });

      it('Then every entry lands as a symlink in both, readlink matches the blob bytes, and the owned outside file is untouched', async () => {
        // Arrange
        const beforeBytes = readFileSync(secretPath);
        const beforeMtime = statSync(secretPath).mtimeMs;
        const targets = escapingSymlinkTargets(secretPath);
        const repo = await openRepository({ cwd: oursDir });

        try {
          // Act — tsgit must NOT raise PERMISSION_DENIED for any of the
          // three targets; that is the assertion that would have failed
          // before symlink targets were written verbatim
          await repo.checkout({ rev: oursCommit as ObjectId });

          // Assert
          assertEscapingSymlinksMaterialised(peerDestDir, oursDir, targets);
          // Assert — the owned outside file's bytes and mtime are unchanged
          expect(readFileSync(secretPath)).toEqual(beforeBytes);
          expect(statSync(secretPath).mtimeMs).toBe(beforeMtime);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When each tool checks out the same commit into an already-populated worktree', () => {
      let root: string;
      let secretPath: string;
      let peerDir: string;
      let oursDir: string;
      let repo: Repository;
      let peerCommit: string;
      let oursCommit: string;

      beforeAll(async () => {
        root = await mkRoot('escaping-symlinks-existing');
        const outsideDir = path.join(root, 'outside');
        mkdirSync(outsideDir, { recursive: true });
        secretPath = path.join(outsideDir, 'secret');
        writeFileSync(secretPath, 'owned-secret\n');
        const targets = escapingSymlinkTargets(secretPath);

        const pair = await buildSeededPair(root, 'existing');
        peerDir = pair.peerDir;
        oursDir = pair.oursDir;
        repo = pair.repo;

        const peerSeedCommit = git(peerDir, 'rev-parse', 'HEAD').trim();
        peerCommit = buildEscapingSymlinkCommit(peerDir, targets, 'escaping links', peerSeedCommit);

        const oursSeedCommit = git(oursDir, 'rev-parse', 'HEAD').trim();
        oursCommit = buildEscapingSymlinkCommit(oursDir, targets, 'escaping links', oursSeedCommit);
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await repo.dispose();
        await rm(root, { recursive: true, force: true });
      });

      it('Then every entry lands as a symlink in both, readlink matches the blob bytes, and the owned outside file is untouched', async () => {
        // Arrange — both worktrees already hold the seed commit's `seed.txt`
        const beforeBytes = readFileSync(secretPath);
        const beforeMtime = statSync(secretPath).mtimeMs;
        const targets = escapingSymlinkTargets(secretPath);

        // Act
        const peerResult = tryRunGitWithExit(['-C', peerDir, 'checkout', '-q', peerCommit]);
        await repo.checkout({ rev: oursCommit as ObjectId });

        // Assert
        expect(peerResult.exitCode).toBe(0);
        assertEscapingSymlinksMaterialised(peerDir, oursDir, targets);
        expect(readFileSync(secretPath)).toEqual(beforeBytes);
        expect(statSync(secretPath).mtimeMs).toBe(beforeMtime);
      });
    });
  });

  // ── 9. untracked walk skips only exact `.git`, not the widened alias matrix ─

  describe('Given an untracked working-tree directory named `git~1` (NTFS short-name alias for `.git`)', () => {
    describe('When status is queried', () => {
      let root: string;
      let pair: RepoPair;

      beforeAll(async () => {
        root = await mkRoot('walker-narrow-skip');
        pair = await buildSeededPair(root, 'walker');

        mkdirSync(path.join(pair.peerDir, 'git~1'), { recursive: true });
        writeFileSync(path.join(pair.peerDir, 'git~1', 'f'), 'x\n');
        writeFileSync(path.join(pair.peerDir, 'sibling.txt'), 'y\n');

        mkdirSync(path.join(pair.oursDir, 'git~1'), { recursive: true });
        writeFileSync(path.join(pair.oursDir, 'git~1', 'f'), 'x\n');
        writeFileSync(path.join(pair.oursDir, 'sibling.txt'), 'y\n');
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await pair.repo.dispose();
        await rm(root, { recursive: true, force: true });
      });

      it('Then both list the git~1 entry and the unrelated sibling as untracked — the walk collapses only exact `.git`', async () => {
        // Arrange & Act — `-uall` matches tsgit's always-flattened untracked
        // list (individual paths, never a collapsed wholly-untracked
        // directory).
        const peerStatus = git(pair.peerDir, 'status', '--porcelain', '-uall');
        const oursStatus = await pair.repo.status();

        // Assert — git's readdir walk never treats `git~1` as an embedded
        // `.git` marker: both the alias directory's own file and the
        // unrelated sibling are reported.
        expect(peerStatus).toContain('?? git~1/f\n');
        expect(peerStatus).toContain('?? sibling.txt\n');
        expect(oursStatus.untracked).toContain('git~1/f');
        expect(oursStatus.untracked).toContain('sibling.txt');
      });
    });
  });

  // ── 10. stash apply refuses a hostile untracked-tree entry name ──────

  describe('Given a stash whose untracked tree carries a hostile `.git/hooks/pre-commit` path', () => {
    describe('When each tool applies it', () => {
      let root: string;
      let pair: RepoPair;
      let peerW: string;

      beforeAll(async () => {
        root = await mkRoot('stash-hostile-untracked');
        pair = await buildSeededPair(root, 'stash-hostile');

        // Every fixture object is written with real git plumbing — `mktree`
        // accepts `.git` as an ordinary tree-entry name (the refusal fires
        // at apply-time restore, not tree construction), so both the peer's
        // and ours' object stores hold byte-identical hostile trees.
        peerW = buildStashCommitTrio(pair.peerDir, buildHostileUntrackedTree(pair.peerDir));
        const oursW = buildStashCommitTrio(pair.oursDir, buildHostileUntrackedTree(pair.oursDir));
        await pushStashRef(pair.repo.ctx, oursW as ObjectId, 'WIP on main: base');
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await pair.repo.dispose();
        await rm(root, { recursive: true, force: true });
      });

      it('Then both refuse the invalid path and neither writes the hostile hook file', async () => {
        // Arrange — the hostile stash trio is built once in beforeAll
        const peerHook = path.join(pair.peerDir, '.git', 'hooks', 'pre-commit');
        const oursHook = path.join(pair.oursDir, '.git', 'hooks', 'pre-commit');

        // Act — `git stash apply <commit>` accepts any commit shaped like a
        // stash entry directly, no `refs/stash` required.
        const peerResult = tryRunGitWithExit(['-C', pair.peerDir, 'stash', 'apply', peerW]);
        let oursCode: string | undefined;
        try {
          await pair.repo.stash.apply({});
        } catch (err) {
          oursCode = (err as { readonly data?: { readonly code?: string } }).data?.code;
        }

        // Assert — real git refuses the invalid path and restores nothing
        // beyond its own init-time `.sample` hook files
        expect(peerResult.exitCode).not.toBe(0);
        expect(peerResult.stderr).toContain("invalid path '.git/hooks/pre-commit'");
        expect(existsSync(peerHook)).toBe(false);
        // Assert — tsgit refuses too, and never wrote the hostile hook file
        expect(oursCode).toBe('INVALID_INDEX_ENTRY');
        expect(existsSync(oursHook)).toBe(false);
      });
    });
  });

  // ── 11. add refuses a `.git`-alias symlink at the staging boundary ───

  describe('Given a `git~1`-aliased directory holding a symlink and a `.git.`-aliased root symlink', () => {
    describe('When each tool runs `add -A`', () => {
      let root: string;
      let pair: RepoPair;

      beforeAll(async () => {
        root = await mkRoot('add-alias-symlink');
        pair = await buildSeededPair(root, 'add-alias');

        mkdirSync(path.join(pair.peerDir, 'git~1'), { recursive: true });
        symlinkSync('../seed.txt', path.join(pair.peerDir, 'git~1', 'link'));
        symlinkSync('/etc/passwd', path.join(pair.peerDir, '.git.'));

        mkdirSync(path.join(pair.oursDir, 'git~1'), { recursive: true });
        symlinkSync('../seed.txt', path.join(pair.oursDir, 'git~1', 'link'));
        symlinkSync('/etc/passwd', path.join(pair.oursDir, '.git.'));
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await pair.repo.dispose();
        await rm(root, { recursive: true, force: true });
      });

      it('Then both tools refuse the alias symlinks and neither leaves a staged entry', async () => {
        // Arrange — the walk itself lists both entries (status-faithful,
        // matches section 9); the refusal must fire at the staging boundary.
        const stageBefore = lsStage(pair.oursDir);

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peerDir, 'add', '-A']);
        let oursCode: string | undefined;
        try {
          await pair.repo.add([], { all: true });
        } catch (err) {
          oursCode = (err as { readonly data?: { readonly code?: string } }).data?.code;
        }

        // Assert — git refuses the whole batch (all-or-nothing: `seed.txt`
        // was already staged by the seed commit, and no new entry is added).
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toMatch(/invalid path '(git~1\/link|\.git\.)'/);
        expect(lsStage(pair.peerDir)).not.toContain('git~1/link');
        expect(lsStage(pair.peerDir)).not.toContain('.git.');
        // Assert — tsgit refuses too, with nothing staged beyond the seed.
        expect(oursCode).toBe('INVALID_INDEX_ENTRY');
        const stageAfter = lsStage(pair.oursDir);
        expect(stageAfter).toBe(stageBefore);
        expect(stageAfter).not.toContain('git~1/link');
        expect(stageAfter).not.toContain('.git.');
      });
    });
  });
});
