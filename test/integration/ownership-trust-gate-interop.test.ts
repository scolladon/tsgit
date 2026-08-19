/**
 * Cross-tool interop — the ownership-trust gate. Three groups: the
 * `bareRepositories: 'explicit'` predicate is co-refutable end-to-end against
 * canonical git on every platform with no forcing (group A, the anchor); the
 * dubious-ownership bytes and value grammar are pinned wherever
 * `GIT_TEST_ASSUME_DIFFERENT_OWNER` still forces git's own hatch (group B);
 * the uid read itself is pinned only where a real alien-owned fixture is
 * creatable, i.e. as root (group C, expected to skip locally and on most CI).
 *
 * @proves
 *   surface:        openRepository
 *   bucket:         cross-tool-interop
 *   unique:         the ownership-trust gate co-refuses with canonical git, byte-for-byte, on every route it can measure
 *   interopSurface: trust
 */
import { chownSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import {
  chown,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity, FilePath } from '../../src/domain/objects/index.js';
import { isAllowlisted } from '../../src/domain/repository/allowlist.js';
import { dubiousOwnership } from '../../src/domain/repository/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
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

const ADO_ENV: NodeJS.ProcessEnv = { ...runGitEnv(), GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };

/** A fresh, realpath-resolved tmpdir root for one scenario group. */
const mkRoot = async (slug: string): Promise<string> =>
  realpath(await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-trust-${slug}-`)));

/** Build a normal (non-bare) repo with one commit at `dir`. */
const buildNormalRepo = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  disableAutoMaintenance(dir);
};

const commit = (dir: string, message: string): void => {
  git(dir, 'add', '.');
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

/** Recursive directory copy — byte-identical, used to build the same-bytes/different-name pairs. */
const cpDir = (from: string, to: string): Promise<void> => cp(from, to, { recursive: true });

/** Runs `thunk`, returning the rejection — fails the test if it resolves. */
const catchThrow = async (thunk: () => Promise<unknown>): Promise<unknown> => {
  try {
    await thunk();
  } catch (err) {
    return err;
  }
  expect.unreachable('expected the thunk to throw');
};

/** Narrows a synthesised `TsgitError` down to its `DUBIOUS_OWNERSHIP` payload. */
const asDubiousOwnershipData = (
  err: TsgitError,
): { readonly path: string; readonly foreignPath?: string } => {
  if (err.data.code !== 'DUBIOUS_OWNERSHIP') {
    throw new Error(`expected DUBIOUS_OWNERSHIP, got ${err.data.code}`);
  }
  return err.data;
};

/** git's `safe.directory` fatal, reconstructed from tsgit's `path` alone — never `foreignPath`. */
const reconstructDubiousOwnershipFatal = (repoPath: string): string =>
  `fatal: detected dubious ownership in repository at '${repoPath}'\n` +
  'To add an exception for this directory, call:\n' +
  '\n' +
  `\tgit config --global --add safe.directory ${repoPath}\n`;

/** git's `safe.bareRepository` fatal, reconstructed from tsgit's `gitDir`. */
const reconstructImplicitBareFatal = (gitDir: string): string =>
  `fatal: cannot use bare repository '${gitDir}' (safe.bareRepository is 'explicit')\n`;

/**
 * `git -c safe.bareRepository=explicit rev-parse --is-bare-repository` — the
 * clean co-refusal probe. `status` conflates the bareRepository refusal with
 * the unrelated "must be run in a work tree" refusal that several ALLOW rows
 * also hit (they are bare or worktree-less for reasons independent of this
 * predicate); `rev-parse --is-bare-repository` needs no work tree, so its
 * exit code isolates the ONE predicate this group pins.
 */
const bareRepositoryRefusesUnderGit = (dir: string): boolean =>
  tryRunGitWithExit(
    ['-C', dir, '-c', 'safe.bareRepository=explicit', 'rev-parse', '--is-bare-repository'],
    { env: runGitEnv() },
  ).exitCode === 128;

// ---------------------------------------------------------------------------
// Module-scope predicates (evaluated once, before any describe).
// ---------------------------------------------------------------------------

/**
 * git's own dubious-ownership hatch, still present and effective — guards a
 * future git dropping `GIT_TEST_ASSUME_DIFFERENT_OWNER`.
 */
const probeGitAssumeDifferentOwner = (): boolean => {
  if (!GIT_AVAILABLE) return false;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-ado-probe-'));
  try {
    runGit(['init', '-q', '-b', 'main', dir]);
    const g = tryRunGitWithExit(['-C', dir, 'log'], { env: ADO_ENV });
    return g.exitCode === 128 && g.stderr.startsWith('fatal: detected dubious ownership');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const GIT_ASSUME_DIFFERENT_OWNER = probeGitAssumeDifferentOwner();

interface AlienOwnerProbeResult {
  readonly available: boolean;
  readonly reason: string;
}

/** Any uid guaranteed not to equal `callerUid`. */
const alienUidFor = (callerUid: number): number => (callerUid === 65_534 ? 65_533 : 65_534);

/**
 * `mkdtemp → chown → stat → rm -rf`. The re-stat is not defensive padding:
 * without it, a filesystem that silently ignores `chown` would report the
 * probe as available while group C ran against a fixture the caller still
 * owns — a vacuous green for the wrong reason. The verdict comes from what
 * `stat` reports, never from the absence of a `chown` rejection.
 */
const probeAlienOwnerAvailable = (): AlienOwnerProbeResult => {
  if (process.getuid === undefined) {
    return { available: false, reason: 'process.getuid unavailable' };
  }
  const callerUid = process.getuid();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-alien-owner-probe-'));
  try {
    try {
      chownSync(dir, alienUidFor(callerUid), -1);
    } catch {
      return { available: false, reason: 'EPERM from chown' };
    }
    if (statSync(dir).uid === callerUid) {
      return { available: false, reason: 'chown was a no-op' };
    }
    return { available: true, reason: '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const ALIEN_OWNER_PROBE = probeAlienOwnerAvailable();
const ALIEN_OWNER_AVAILABLE = ALIEN_OWNER_PROBE.available;

if (!ALIEN_OWNER_AVAILABLE) {
  console.warn(
    '[ownership-trust-gate-interop] group C SKIPPED — no alien-owned fixture is creatable here\n' +
      `  (reason: ${ALIEN_OWNER_PROBE.reason}).\n` +
      '  NOT covered by this run: that the node adapter compares a real stat.uid to a real\n' +
      '  process uid. Its semantics ARE covered by the unit truth table in\n' +
      '  test/unit/repository/resolve-layout-trust.test.ts.',
  );
}

// ---------------------------------------------------------------------------
// Group A — the anchor: bareRepositories, both sides, always on.
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)(
  'the bareRepositories predicate against canonical git (group A, the anchor)',
  () => {
    let root: string;
    let source: string;
    let bare: string;
    let nb3: string;
    let wrap: string;
    let wrapGit: string;
    let wrapGitOther: string;
    let normal: string;
    let configBare: string;

    beforeAll(async () => {
      root = await mkRoot('bare-repositories');
      source = path.join(root, 'source');
      buildNormalRepo(source);
      await writeFile(path.join(source, 'a.txt'), 'one\n');
      commit(source, 'c1');

      // bare.git — a clone --bare under a non-.git name, plus a planted local
      // key for the empty-config-scope mechanism below.
      bare = path.join(root, 'bare.git');
      runGit(['clone', '-q', '--bare', source, bare]);
      disableAutoMaintenance(bare);
      git(bare, 'config', 'user.name', 'PlantedLocalValue');

      // nb3.git — the same bytes, with core.bare forced false. Bareness plays
      // no part in the predicate: this still refuses.
      nb3 = path.join(root, 'nb3.git');
      await cpDir(bare, nb3);
      git(nb3, 'config', 'core.bare', 'false');

      // wrap/.git and wrap/.git-other — byte-identical copies of one gitdir
      // differing only in name. The whole point of this group.
      wrap = path.join(root, 'wrap');
      wrapGit = path.join(wrap, '.git');
      runGit(['clone', '-q', '--bare', source, wrapGit]);
      disableAutoMaintenance(wrapGit);
      wrapGitOther = path.join(wrap, '.git-other');
      await cpDir(wrapGit, wrapGitOther);

      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'x\n');
      commit(normal, 'c1');

      // config-bare — bare via core.bare, discovered through a .git entry
      // (route DISCOVERED, not BARE_DIR): the predicate never applies here.
      // Commit BEFORE flipping core.bare — afterwards the repo behaves as
      // worktree-less, exactly like the fixture this row is measured against.
      configBare = path.join(root, 'config-bare');
      buildNormalRepo(configBare);
      await writeFile(path.join(configBare, 'a.txt'), 'x\n');
      commit(configBare, 'c1');
      git(configBare, 'config', 'core.bare', 'true');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('The predicate, co-refused with real git', () => {
      it.each<[string, () => string, boolean]>([
        ['bare.git', () => bare, true],
        ['bare.git/refs (inside the bare gitdir)', () => path.join(bare, 'refs'), true],
        ['nb3.git (the same bytes, core.bare forced false)', () => nb3, true],
        [
          'wrap/.git-other (byte-identical to wrap/.git, differently named)',
          () => wrapGitOther,
          true,
        ],
        ['wrap/.git (byte-identical to wrap/.git-other, named .git)', () => wrapGit, false],
        [
          "normal/.git (a normal repo's own gitdir, named .git)",
          () => path.join(normal, '.git'),
          false,
        ],
        [
          'config-bare (bare via core.bare, discovered through a .git entry)',
          () => configBare,
          false,
        ],
      ])('Then %s: git and repo.log() agree', async (_label, dirOf, expectRefuse) => {
        // Arrange — openRepository never throws for this gate: the verdict
        // lands on `repo.layout` and the refusal fires at the first command,
        // via the acceptance tier (assertAcceptedRepository).
        const dir = dirOf();
        const gitRefuses = bareRepositoryRefusesUnderGit(dir);
        const repo = await openRepository({ cwd: dir, bareRepositories: 'explicit' });

        // Act
        let caught: unknown;
        try {
          await repo.log();
        } catch (err) {
          caught = err;
        }

        // Assert
        try {
          expect(gitRefuses).toBe(expectRefuse);
          if (expectRefuse) {
            const data = (caught as { data?: { code?: string } })?.data;
            expect(data?.code).toBe('IMPLICIT_BARE_REPOSITORY');
          } else {
            expect(caught).toBeUndefined();
          }
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('Given the byte-identical wrap pair, When core.bare is flipped on each', () => {
      it('Then neither verdict changes', async () => {
        // Arrange — the row that kills a bareness-conditioned mutant: fresh
        // copies so this test never disturbs the shared fixtures above.
        const flipDir = path.join(root, 'wrap-flip');
        const flipGit = path.join(flipDir, '.git');
        const flipGitOther = path.join(flipDir, '.git-other');
        runGit(['clone', '-q', '--bare', source, flipGit]);
        disableAutoMaintenance(flipGit);
        await cpDir(flipGit, flipGitOther);
        git(flipGit, 'config', 'core.bare', 'true');
        git(flipGitOther, 'config', 'core.bare', 'false');

        // Act
        const gitDotGitRefuses = bareRepositoryRefusesUnderGit(flipGit);
        const gitOtherRefuses = bareRepositoryRefusesUnderGit(flipGitOther);
        const dotGitRepo = await openRepository({ cwd: flipGit, bareRepositories: 'explicit' });
        const otherRepo = await openRepository({ cwd: flipGitOther, bareRepositories: 'explicit' });
        const otherCaught = await catchThrow(() => otherRepo.log());

        // Assert
        try {
          expect(gitDotGitRefuses).toBe(false);
          expect(gitOtherRefuses).toBe(true);
          await expect(dotGitRepo.log()).resolves.toBeDefined();
          const data = (otherCaught as { data?: { code?: string } })?.data;
          expect(data?.code).toBe('IMPLICIT_BARE_REPOSITORY');
        } finally {
          await dotGitRepo.dispose();
          await otherRepo.dispose();
        }
      });
    });

    describe('Given the one-line fatal, When it is reconstructed from tsgit structured fields', () => {
      it('Then it matches git byte-for-byte, with an empty stdout', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-C', bare, '-c', 'safe.bareRepository=explicit', 'status'], {
          env: runGitEnv(),
        });

        // Act
        const repo = await openRepository({ cwd: bare, bareRepositories: 'explicit' });
        const caught = await catchThrow(() => repo.log());
        await repo.dispose();

        // Assert
        const data = (caught as { data?: { code?: string; gitDir?: string } })?.data;
        expect(data?.code).toBe('IMPLICIT_BARE_REPOSITORY');
        expect(g.exitCode).toBe(128);
        expect(g.stdout).toBe('');
        expect(g.stderr).toBe(reconstructImplicitBareFatal(data?.gitDir ?? ''));
      });
    });

    describe('Given the empty-config-scope mechanism shared with the ownership refusal', () => {
      let repo: Repository;
      let configPath: string;

      beforeAll(async () => {
        repo = await openRepository({ cwd: bare, bareRepositories: 'explicit' });
        configPath = path.join(bare, 'config');
      });

      afterAll(async () => {
        await repo?.dispose();
      });

      describe('When git config user.name and repo.config.get both run', () => {
        it('Then both report it absent', async () => {
          // Arrange
          const g = tryRunGitWithExit(
            ['-C', bare, '-c', 'safe.bareRepository=explicit', 'config', 'user.name'],
            { env: runGitEnv() },
          );

          // Act
          const result = await repo.config.get({ key: 'user.name' });

          // Assert
          expect(g.exitCode).toBe(1);
          expect(g.stdout).toBe('');
          expect(result.value).toBeUndefined();
        });
      });

      describe('When git config --list and repo.config.list() both run', () => {
        it('Then both omit the repository scope', async () => {
          // Arrange
          const g = tryRunGitWithExit(
            ['-C', bare, '-c', 'safe.bareRepository=explicit', 'config', '--list'],
            { env: runGitEnv() },
          );

          // Act
          const result = await repo.config.list();

          // Assert
          expect(g.exitCode).toBe(0);
          expect(g.stdout).not.toContain('PlantedLocalValue');
          expect(result.entries).toEqual([]);
        });
      });

      describe('When a write runs on both sides', () => {
        it('Then it refuses on both sides and leaves the value byte-unchanged', async () => {
          // Arrange
          const before = await readFile(configPath, 'utf8');
          const g = tryRunGitWithExit(
            ['-C', bare, '-c', 'safe.bareRepository=explicit', 'config', 'user.name', 'Changed'],
            { env: runGitEnv() },
          );

          // Act
          const caught = await catchThrow(() =>
            repo.config.set({ key: 'user.name', value: 'Changed', scope: 'local' }),
          );

          // Assert
          const after = await readFile(configPath, 'utf8');
          expect(g.exitCode).toBe(128);
          expect(after).toBe(before);
          const data = (caught as { data?: { code?: string } })?.data;
          expect(data?.code).toBe('IMPLICIT_BARE_REPOSITORY');
        });
      });

      describe('When remote runs on both sides', () => {
        it('Then it refuses on both sides', async () => {
          // Arrange
          const g = tryRunGitWithExit(
            ['-C', bare, '-c', 'safe.bareRepository=explicit', 'remote', '-v'],
            { env: runGitEnv() },
          );

          // Act
          const caught = await catchThrow(() => repo.remote.list());

          // Assert
          expect(g.exitCode).toBe(128);
          const data = (caught as { data?: { code?: string } })?.data;
          expect(data?.code).toBe('IMPLICIT_BARE_REPOSITORY');
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Group B — git's own bytes, always on wherever the hatch exists.
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_ASSUME_DIFFERENT_OWNER)(
  "git's own dubious-ownership bytes under GIT_TEST_ASSUME_DIFFERENT_OWNER (group B) — GIT_ASSUME_DIFFERENT_OWNER",
  () => {
    let root: string;
    let rawRoot: string;
    let source: string;
    let normal: string;
    let deepSub: string;
    let bare: string;
    let gitfileWork: string;
    let gitfileAdmin: string;
    let linkedWt: string;
    let elsewhere: string;
    let linkToNormal: string;

    beforeAll(async () => {
      rawRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-trust-git-bytes-'));
      root = await realpath(rawRoot);

      source = path.join(root, 'source');
      buildNormalRepo(source);
      await writeFile(path.join(source, 'a.txt'), 'one\n');
      commit(source, 'c1');

      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'x\n');
      commit(normal, 'c1');
      deepSub = path.join(normal, 'sub', 'deep');
      await mkdir(deepSub, { recursive: true });

      bare = path.join(root, 'bare.git');
      runGit(['clone', '-q', '--bare', source, bare]);
      disableAutoMaintenance(bare);

      gitfileWork = path.join(root, 'gitfile-work');
      buildNormalRepo(gitfileWork);
      await writeFile(path.join(gitfileWork, 'a.txt'), 'x\n');
      commit(gitfileWork, 'c1');
      const gitfileAdminDir = path.join(root, 'gitfile-admin');
      await mkdir(gitfileAdminDir, { recursive: true });
      gitfileAdmin = path.join(gitfileAdminDir, 'admin.git');
      await rename(path.join(gitfileWork, '.git'), gitfileAdmin);
      await writeFile(path.join(gitfileWork, '.git'), `gitdir: ${gitfileAdmin}\n`);

      linkedWt = path.join(root, 'linked-wt');
      git(normal, 'worktree', 'add', '-q', '-b', 'topic', linkedWt, 'main');

      elsewhere = path.join(root, 'elsewhere');
      await mkdir(elsewhere, { recursive: true });

      linkToNormal = path.join(root, 'link-to-normal');
      await symlink(normal, linkToNormal);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('Given a synthesised DUBIOUS_OWNERSHIP', () => {
      describe('When the four-line refusal is reconstructed', () => {
        it('Then it matches git byte-for-byte, reading path alone', async () => {
          // Arrange
          const g = tryRunGitWithExit(['-C', normal, 'status'], { env: ADO_ENV });
          const synthesised = asDubiousOwnershipData(dubiousOwnership(normal as FilePath));

          // Act
          const reconstructed = reconstructDubiousOwnershipFatal(synthesised.path);

          // Assert
          expect(g.exitCode).toBe(128);
          expect(g.stdout).toBe('');
          expect(g.stderr).toBe(reconstructed);
        });
      });

      describe('When the payload carries a foreignPath', () => {
        it('Then it does not move the reconstructed bytes', () => {
          // Arrange
          const withoutForeign = asDubiousOwnershipData(dubiousOwnership(normal as FilePath));
          const withForeign = asDubiousOwnershipData(
            dubiousOwnership(normal as FilePath, '/some/other/path' as FilePath),
          );

          // Act
          const reconstructedWithout = reconstructDubiousOwnershipFatal(withoutForeign.path);
          const reconstructedWith = reconstructDubiousOwnershipFatal(withForeign.path);

          // Assert
          expect(reconstructedWith).toBe(reconstructedWithout);
          expect(withForeign.foreignPath).toBe('/some/other/path');
        });
      });
    });

    describe('Given the named-path table, When each route is opened', () => {
      it.each<[string, () => string]>([
        ['a normal repo names the work tree', () => normal],
        ['a deep subdirectory names the repository root, not itself', () => deepSub],
        ['cwd at the gitdir names the gitdir', () => path.join(normal, '.git')],
        ['the bare gitdir names itself', () => bare],
        ['inside the bare gitdir names the enclosing bare repo', () => path.join(bare, 'refs')],
        ['a .git-file work tree names the work tree, not the pointed-at gitdir', () => gitfileWork],
        ['a linked worktree names the worktree dir, not the common dir', () => linkedWt],
      ])('Then %s', async (_label, cwdOf) => {
        // Arrange — the path tsgit's own layout resolution names, learned
        // from a TRUSTED open (path resolution needs no ownership at all).
        const cwd = cwdOf();
        const trusted = await openRepository({ cwd });
        const tsgitPath = trusted.layout.workDir ?? trusted.layout.gitDir;
        await trusted.dispose();

        // Act
        const g = tryRunGitWithExit(['-C', cwd, 'log', '--oneline'], { env: ADO_ENV });

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toBe(reconstructDubiousOwnershipFatal(tsgitPath));
      });
    });

    describe('Given an explicit --git-dir invocation, When ADO forces the ownership hatch', () => {
      it('Then neither tool refuses', async () => {
        // Arrange
        const gitDir = path.join(normal, '.git');
        const g = tryRunGitWithExit(['--git-dir', gitDir, 'log', '--oneline'], { env: ADO_ENV });

        // Act
        const repo = await openRepository({ cwd: elsewhere, gitDir });

        // Assert
        try {
          expect(g.exitCode).toBe(0);
          expect(repo.layout.untrusted).toBeUndefined();
          await expect(repo.log()).resolves.toBeDefined();
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('Given the safe.directory value grammar, When each row is checked against git', () => {
      it.each<[string, () => string, boolean]>([
        ['the exact repository path', () => normal, true],
        ['the repository path with a trailing slash', () => `${normal}/`, true],
        ['the gitdir, not the work tree', () => `${normal}/.git`, false],
        ['the parent directory (no implicit descent)', () => root, false],
        ['the wildcard *', () => '*', true],
        ['a /* suffix at the parent, strictly below', () => `${root}/*`, true],
        [
          'a /* suffix at the repository path itself (never the prefix)',
          () => `${normal}/*`,
          false,
        ],
        ['a non-fnmatch partial-name glob', () => `${path.join(root, 'nor')}*`, false],
        ['the whole path upper-cased (case-sensitive)', () => normal.toUpperCase(), false],
      ])('Then %s: the matcher agrees with git', async (_label, getValue, expectAllow) => {
        // Arrange
        const value = getValue();
        const g = tryRunGitWithExit(['-c', `safe.directory=${value}`, '-C', normal, 'status'], {
          env: ADO_ENV,
        });

        // Act
        const gitAllows = g.exitCode === 0;
        const matcherAllows = isAllowlisted(normal, [value]);

        // Assert
        expect(gitAllows).toBe(expectAllow);
        expect(matcherAllows).toBe(expectAllow);
      });
    });

    describe('Given the safe.directory physical forms, When each is checked against git and node realpath', () => {
      // These forms are not lexically equal to `normal`, so `isAllowlisted` —
      // a pure string matcher — would wrongly refuse every one of them. git
      // ALLOWS them because it resolves the value physically before
      // comparing; the node adapter realpaths every `trustedDirectories`
      // entry through the identical `node:fs/promises` `realpath` used here
      // before it ever reaches the matcher. Pinning that both sides converge
      // on the same canonical path is what "the shim's realpathing" means.
      it.each<[string, () => string]>([
        ['a double-slash form', () => `${root}//normal`],
        ['a dot-component form', () => `${normal}/.`],
        ['an existing ".." hop', () => `${elsewhere}/../normal`],
        ['a symlinked value', () => linkToNormal],
        // On a host where os.tmpdir() is itself a symlink (macOS: /tmp ->
        // /private/tmp), this exercises the same physical-resolution path as
        // the symlinked-value row above under a different, measured shape;
        // on a host where it is not, it degrades to the exact-match row.
        ['the unresolved os.tmpdir() form', () => path.join(rawRoot, 'normal')],
      ])(
        'Then %s resolves physically: git allows it, and node realpath agrees',
        async (_label, getValue) => {
          // Arrange
          const value = getValue();
          const g = tryRunGitWithExit(['-c', `safe.directory=${value}`, '-C', normal, 'status'], {
            env: ADO_ENV,
          });

          // Act
          const nodeResolved = await realpath(value);

          // Assert
          expect(g.exitCode).toBe(0);
          expect(nodeResolved).toBe(normal);
        },
      );
    });

    describe('Given a bare, alien-owned repo, When safe.directory=* is also set', () => {
      it('Then it still refuses with the bareRepository fatal — the implicit-bare refusal precedes the ownership one', () => {
        // Arrange & Act
        const g = tryRunGitWithExit(
          ['-c', 'safe.bareRepository=explicit', '-c', 'safe.directory=*', '-C', bare, 'status'],
          { env: ADO_ENV },
        );

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('cannot use bare repository');
        expect(g.stderr).not.toContain('dubious ownership');
      });
    });

    describe('Given safe.directory written into the repository-local config, When git reads it', () => {
      it('Then the repository still does not admit itself', () => {
        // Arrange
        git(normal, 'config', 'safe.directory', normal);

        try {
          // Act
          const g = tryRunGitWithExit(['-C', normal, 'status'], { env: ADO_ENV });

          // Assert
          expect(g.exitCode).toBe(128);
          expect(g.stderr).toContain('dubious ownership');
        } finally {
          git(normal, 'config', '--unset', 'safe.directory');
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Group C — the uid read itself, gated on a real alien-owned fixture.
// ---------------------------------------------------------------------------

describe.skipIf(!ALIEN_OWNER_AVAILABLE)(
  'the uid read against a real alien owner (group C, expected to skip without root) — ALIEN_OWNER_AVAILABLE',
  () => {
    let root: string;
    let repoDir: string;
    let alienUid: number;
    let callerUid: number;

    beforeAll(async () => {
      root = await mkRoot('alien-owner');
      repoDir = path.join(root, 'alien');
      buildNormalRepo(repoDir);
      await writeFile(path.join(repoDir, 'a.txt'), 'x\n');
      commit(repoDir, 'c1');

      const uid = process.getuid?.();
      if (uid === undefined) throw new Error('unreachable: ALIEN_OWNER_AVAILABLE requires getuid');
      callerUid = uid;
      alienUid = alienUidFor(callerUid);
      // Both checked-set members a normal repo carries: the work tree
      // (repositoryPath) and the gitdir.
      await chown(repoDir, alienUid, -1);
      await chown(path.join(repoDir, '.git'), alienUid, -1);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root === undefined) return;
      await chown(repoDir, callerUid, -1).catch(() => undefined);
      await chown(path.join(repoDir, '.git'), callerUid, -1).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    describe('Given a real alien-owned repository, When unmodified git and unmodified openRepository(...).log() run', () => {
      it('Then both refuse, naming the same path', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-C', repoDir, 'log'], { env: runGitEnv() });
        const repo = await openRepository({ cwd: repoDir });

        // Act
        const caught = await catchThrow(() => repo.log());
        await repo.dispose();

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('dubious ownership');
        expect(g.stderr).toContain(repoDir);
        const data = (caught as { data?: { code?: string; path?: string } })?.data;
        expect(data?.code).toBe('DUBIOUS_OWNERSHIP');
        expect(data?.path).toBe(repoDir);
      });
    });

    describe('Given a real alien-owned repository, When trustedDirectories admits the alien path', () => {
      it('Then both git and tsgit admit it', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-c', `safe.directory=${repoDir}`, '-C', repoDir, 'log'], {
          env: runGitEnv(),
        });

        // Act
        const repo = await openRepository({ cwd: repoDir, trustedDirectories: [repoDir] });

        // Assert
        try {
          expect(g.exitCode).toBe(0);
          await expect(repo.log()).resolves.toBeDefined();
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('Given a real alien-owned repository, When init runs on it', () => {
      it('Then both git init and repo.init() succeed', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-C', repoDir, 'init', '-q'], { env: runGitEnv() });

        // Act
        const repo = await openRepository({ cwd: repoDir });

        // Assert
        try {
          expect(g.exitCode).toBe(0);
          await expect(repo.init()).resolves.toBeDefined();
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('Given the gitdir alone is alien-owned, the work tree stays caller-owned (the superset row)', () => {
      describe('When repo.log() runs', () => {
        it("Then tsgit refuses naming the work tree, foreignPath naming the gitdir — git's verdict here is not asserted", async () => {
          // Arrange — the ownership predicate checks the whole checked-set
          // superset by design; over-refusal on a shape git may not refuse is
          // an accepted, deliberate divergence, not something this row
          // co-asserts against git.
          const supersetDir = path.join(root, 'superset');
          buildNormalRepo(supersetDir);
          await writeFile(path.join(supersetDir, 'a.txt'), 'x\n');
          commit(supersetDir, 'c1');
          await chown(path.join(supersetDir, '.git'), alienUid, -1);
          const repo = await openRepository({ cwd: supersetDir });

          // Act
          const caught = await catchThrow(() => repo.log());
          await repo.dispose();

          // Assert
          const data = (caught as { data?: { code?: string; path?: string; foreignPath?: string } })
            ?.data;
          expect(data?.code).toBe('DUBIOUS_OWNERSHIP');
          expect(data?.path).toBe(supersetDir);
          expect(data?.foreignPath).toBe(path.join(supersetDir, '.git'));
        });
      });
    });
  },
);
