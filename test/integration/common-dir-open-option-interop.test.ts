/**
 * Cross-tool interop — the caller-supplied `commonDir` open option. Builds
 * each on-disk split (a real linked worktree, a plain repo paired with a
 * second valid gitdir standing in for its common dir, and the refusal/format/
 * bareness edge shapes) with canonical git, then proves `openRepository`'s
 * `commonDir` argument resolves and writes exactly where git's own
 * `GIT_COMMON_DIR` — and, for ref placement, the on-disk `commondir` file —
 * put them: the argument follows the file's uniform split, refs included,
 * never git's own env-only report-here/write-there inconsistency.
 *
 * @proves
 *   surface:        openRepository
 *   bucket:         cross-tool-interop
 *   unique:         caller-supplied common dir resolves and writes where canonical git's split places it
 *   interopSurface: layout
 */
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readShallow } from '../../src/application/primitives/shallow-file.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../src/domain/objects/index.js';
import { isPerWorktreeRef } from '../../src/domain/refs/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

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

const commit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

/** A fresh, realpath-resolved tmpdir root for one scenario group. */
const mkRoot = async (slug: string): Promise<string> =>
  realpath(await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-cdo-${slug}-`)));

/** `git rev-parse --path-format=absolute --git-dir --git-common-dir`, split into a pair. */
const gitDirPair = (cwd: string): readonly [string, string] => {
  const [gitDir, commonDir] = git(
    cwd,
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  )
    .trim()
    .split('\n');
  if (gitDir === undefined || commonDir === undefined) {
    throw new Error(`unexpected rev-parse output for ${cwd}`);
  }
  return [gitDir, commonDir];
};

describe.skipIf(!GIT_AVAILABLE)('commonDir open option interop', () => {
  // ───────────────────────────────────────────────────────────────────────
  // Scenarios A, C, J — a real linked worktree, opened with an EXPLICIT
  // commonDir naming (A, J) or diverging from (C) the on-disk commondir file.
  // ───────────────────────────────────────────────────────────────────────
  describe('Given a git-built linked worktree, opened with an explicit commonDir (scenarios A, C, J)', () => {
    let root: string;
    let main: string;
    let wt: string;
    let adminDir: string;
    let alt: string;

    beforeAll(async () => {
      root = await mkRoot('acj');
      main = path.join(root, 'main');
      runGit(['init', '-q', '-b', 'main', main]);
      await writeFile(path.join(main, 'a.txt'), 'one\n');
      git(main, 'add', 'a.txt');
      commit(main, 'c1');
      wt = path.join(root, 'wt');
      runGit(['-C', main, 'worktree', 'add', '-q', '-b', 'feature', wt]);
      adminDir = path.join(main, '.git', 'worktrees', 'wt');
      alt = path.join(root, 'alt');
      await cp(path.join(main, '.git'), alt, { recursive: true });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When opened at the worktree with commonDir naming the real common dir (scenario A)', () => {
      it('Then layout.gitDir/commonDir match git rev-parse --git-dir --git-common-dir, and reads agree', async () => {
        // Arrange
        const [expectedGitDir, expectedCommonDir] = gitDirPair(wt);
        const repo = await openRepository({ cwd: wt, commonDir: path.join(main, '.git') });

        try {
          // Act
          const result = repo.ctx.layout;
          const revParsed = await repo.revParse('HEAD');
          const log = await repo.log();
          const status = await repo.status();

          // Assert
          expect(result.gitDir).toBe(expectedGitDir);
          expect(result.commonDir).toBe(expectedCommonDir);
          expect(revParsed).toBe(git(wt, 'rev-parse', 'HEAD').trim());
          expect(log.map((entry) => entry.id)).toEqual(
            git(wt, 'log', '--format=%H').trim().split('\n'),
          );
          expect(status.clean).toBe(true);
          expect(git(wt, 'status', '--porcelain').trim()).toBe('');
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When branch.create/tag.create/commit/packRefs run through a commonDir diverging from the real commondir file (scenario C)', () => {
      it('Then new refs, reflogs and packed-refs land under the override, the real common dir is left untouched, and per-worktree state stays in the admin dir', async () => {
        // Arrange
        const featureBefore = git(main, 'rev-parse', 'feature').trim();
        const repo = await openRepository({
          cwd: wt,
          gitDir: adminDir,
          workDir: wt,
          commonDir: alt,
        });

        try {
          // Act
          await repo.branch.create({ name: 'extra-branch' });
          await repo.tag.create({ name: 'extra-tag' });
          await writeFile(path.join(wt, 'b.txt'), 'two\n');
          await repo.add(['b.txt']);
          const committed = await repo.commit({ message: 'c2', author: AUTHOR });
          await repo.packRefs();

          // Assert — the override carries the new refs, reflogs and packed-refs
          const peerShowRef = runGit(['--git-dir', alt, 'show-ref']);
          expect(peerShowRef).toContain(`refs/heads/extra-branch`);
          expect(peerShowRef).toContain(`refs/tags/extra-tag`);
          expect(peerShowRef).toContain(`${committed.id} refs/heads/feature`);
          expect(existsSync(path.join(alt, 'logs', 'refs', 'heads', 'feature'))).toBe(true);

          // Assert — nothing NEW appears under the real common dir (main/.git):
          // extra-branch/extra-tag never existed there at all, and feature's
          // pre-existing loose ref (created by `worktree add`) is left stale.
          expect(existsSync(path.join(main, '.git', 'refs', 'heads', 'extra-branch'))).toBe(false);
          expect(existsSync(path.join(main, '.git', 'refs', 'tags', 'extra-tag'))).toBe(false);
          expect(existsSync(path.join(main, '.git', 'packed-refs'))).toBe(false);
          expect(runGit(['--git-dir', path.join(main, '.git'), 'rev-parse', 'feature'])).toBe(
            `${featureBefore}\n`,
          );

          // Assert — per-worktree state (HEAD, index, its own reflog) stays
          // under the admin dir, not the override.
          expect(existsSync(path.join(adminDir, 'HEAD'))).toBe(true);
          expect(existsSync(path.join(adminDir, 'index'))).toBe(true);
          expect(existsSync(path.join(adminDir, 'logs', 'HEAD'))).toBe(true);

          // Assert — the peer proves the SAME split shape independently, via
          // a real linked worktree with no override at all: a branch created
          // from the worktree lands in the real common dir (main/.git).
          // `GIT_COMMON_DIR=… git` is deliberately not used as the peer here:
          // measured, git's env override leaves refs in the gitdir instead,
          // which would make this assertion fail against correct git.
          git(wt, 'branch', 'peer-branch');
          expect(existsSync(path.join(main, '.git', 'refs', 'heads', 'peer-branch'))).toBe(true);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When tsgit commits through the explicit commonDir naming the value the commondir file already implies (scenario J)', () => {
      it('Then git, run with no override at all, reads the identical oid', async () => {
        // Arrange
        const repo = await openRepository({
          cwd: wt,
          gitDir: adminDir,
          workDir: wt,
          commonDir: path.join(main, '.git'),
        });

        try {
          // Act
          await writeFile(path.join(wt, 'j.txt'), 'round-trip\n');
          await repo.add(['j.txt']);
          const committed = await repo.commit({ message: 'j', author: AUTHOR });

          // Assert
          expect(git(wt, 'rev-parse', 'feature').trim()).toBe(committed.id);
          expect(git(wt, 'cat-file', '-t', committed.id).trim()).toBe('commit');
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenarios B, D, E, I — a plain repo paired with a second, valid gitdir
  // standing in for its common dir.
  // ───────────────────────────────────────────────────────────────────────
  describe('Given a plain repo opened with commonDir naming a second, valid gitdir (scenarios B, D, E, I)', () => {
    let root: string;
    let plainDir: string;
    let altDir: string;
    let plainGitDir: string;
    let c1: string;
    let c2: string;

    beforeAll(async () => {
      root = await mkRoot('shared-state');
      plainDir = path.join(root, 'plain');
      runGit(['init', '-q', '-b', 'main', plainDir]);
      await writeFile(path.join(plainDir, 'a.txt'), 'one\n');
      git(plainDir, 'add', 'a.txt');
      commit(plainDir, 'c1');
      c1 = git(plainDir, 'rev-parse', 'HEAD').trim();
      await writeFile(path.join(plainDir, 'a.txt'), 'two\n');
      git(plainDir, 'add', 'a.txt');
      commit(plainDir, 'c2');
      c2 = git(plainDir, 'rev-parse', 'HEAD').trim();
      plainGitDir = path.join(plainDir, '.git');
      altDir = path.join(root, 'alt');
      await cp(plainGitDir, altDir, { recursive: true });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When tsgit writes a loose object through the override (scenario B)', () => {
      it('Then the object lands under the override, not the gitdir, and git reads it back', async () => {
        // Arrange
        const content = new TextEncoder().encode('scenario-b-blob\n');
        const repo = await openRepository({ cwd: plainDir, commonDir: altDir });

        try {
          // Act
          const blobId = await repo.primitives.writeObject({
            type: 'blob',
            id: '' as ObjectId,
            content,
          });

          // Assert
          const rel = path.join('objects', blobId.slice(0, 2), blobId.slice(2));
          expect(existsSync(path.join(altDir, rel))).toBe(true);
          expect(existsSync(path.join(plainGitDir, rel))).toBe(false);
          const peerRead = runGit(['--git-dir', altDir, 'cat-file', '-p', blobId]);
          expect(peerRead).toBe('scenario-b-blob\n');
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When config.set runs through the override (scenario D)', () => {
      it('Then tsgit writes the override config, and git reports the key with the override as its origin', async () => {
        // Arrange
        const repo = await openRepository({ cwd: plainDir, commonDir: altDir });

        try {
          // Act
          await repo.config.set({ key: 'probe.override', value: 'landed', scope: 'local' });

          // Assert
          const configText = await readFile(path.join(altDir, 'config'), 'utf8');
          expect(configText).toContain('override = landed');
          const peerList = tryRunGitWithExit(
            ['-C', plainDir, 'config', '--list', '--show-origin', '--local'],
            { env: { ...runGitEnv(), GIT_COMMON_DIR: altDir } },
          );
          expect(peerList.exitCode).toBe(0);
          expect(peerList.stdout).toContain(`file:${altDir}/config\tprobe.override=landed`);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When shallow, info/exclude, info/attributes and hooks are read/written through the override, with decoys planted in the gitdir (scenario E)', () => {
      it('Then the shallow cut-point is honoured from the override, not the gitdir decoy', async () => {
        // Arrange — the override marks c2 shallow (masking c1); the gitdir
        // decoy names c1 (a harmless, well-formed, but different entry —
        // marking the already-parentless root commit is a structural no-op).
        const dir = path.join(root, 'e-shallow');
        await mkdir(dir, { recursive: true });
        const localPlain = path.join(dir, 'plain');
        await cp(plainDir, localPlain, { recursive: true });
        const localAlt = path.join(dir, 'alt');
        await cp(altDir, localAlt, { recursive: true });
        await writeFile(path.join(localAlt, 'shallow'), `${c2}\n`);
        await writeFile(path.join(localPlain, '.git', 'shallow'), `${c1}\n`);

        // Act
        const peerLog = tryRunGitWithExit(['-C', localPlain, 'log', '--format=%H'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: localAlt },
        });
        const repo = await openRepository({ cwd: localPlain, commonDir: localAlt });
        try {
          const shallowSet = await readShallow(repo.ctx);
          const log = await repo.log();

          // Assert
          expect(peerLog.exitCode).toBe(0);
          expect(peerLog.stdout.trim()).toBe(c2);
          expect(shallowSet.has(c2 as ObjectId)).toBe(true);
          expect(log.map((entry) => entry.id)).toEqual([c2]);
        } finally {
          await repo.dispose();
        }
      });

      it('Then an untracked file matching only the override info/exclude is excluded, not the gitdir decoy pattern', async () => {
        // Arrange
        const dir = path.join(root, 'e-exclude');
        await mkdir(dir, { recursive: true });
        const localPlain = path.join(dir, 'plain');
        await cp(plainDir, localPlain, { recursive: true });
        const localAlt = path.join(dir, 'alt');
        await cp(altDir, localAlt, { recursive: true });
        await writeFile(path.join(localAlt, 'info', 'exclude'), 'ignored.txt\n');
        await writeFile(path.join(localPlain, '.git', 'info', 'exclude'), 'other.txt\n');
        await writeFile(path.join(localPlain, 'ignored.txt'), 'x\n');

        // Act
        const peerStatus = tryRunGitWithExit(['-C', localPlain, 'status', '--porcelain'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: localAlt },
        });
        const repo = await openRepository({ cwd: localPlain, commonDir: localAlt });
        try {
          const status = await repo.status();

          // Assert
          expect(peerStatus.exitCode).toBe(0);
          expect(peerStatus.stdout).not.toContain('ignored.txt');
          expect(status.untracked).not.toContain('ignored.txt');
        } finally {
          await repo.dispose();
        }
      });

      it('Then a filter attribute resolved only from the override clean-converts staged content, not the gitdir decoy filter', async () => {
        // Arrange — override: uppercase filter; gitdir decoy: lowercase filter.
        const dir = path.join(root, 'e-attrs');
        await mkdir(dir, { recursive: true });
        const localPlain = path.join(dir, 'plain');
        await cp(plainDir, localPlain, { recursive: true });
        const localAlt = path.join(dir, 'alt');
        await cp(altDir, localAlt, { recursive: true });
        await writeFile(path.join(localAlt, 'info', 'attributes'), 'f.txt filter=upper\n');
        const altConfig = await readFile(path.join(localAlt, 'config'), 'utf8');
        await writeFile(
          path.join(localAlt, 'config'),
          `${altConfig}[filter "upper"]\n\tclean = tr a-z A-Z\n`,
        );
        await writeFile(
          path.join(localPlain, '.git', 'info', 'attributes'),
          'f.txt filter=lower\n',
        );
        const gitDirConfig = await readFile(path.join(localPlain, '.git', 'config'), 'utf8');
        await writeFile(
          path.join(localPlain, '.git', 'config'),
          `${gitDirConfig}[filter "lower"]\n\tclean = tr A-Z a-z\n`,
        );
        await writeFile(path.join(localPlain, 'f.txt'), 'hello\n');

        // Act — peer proof against the SAME on-disk fixture, via a separate
        // reset so tsgit's own `add` below observes an untouched worktree.
        const peerAdd = tryRunGitWithExit(['-C', localPlain, 'add', 'f.txt'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: localAlt },
        });
        const peerShow = tryRunGitWithExit(['-C', localPlain, 'show', ':f.txt'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: localAlt },
        });
        tryRunGitWithExit(['-C', localPlain, 'reset', '--mixed', 'HEAD'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: localAlt },
        });
        await writeFile(path.join(localPlain, 'f.txt'), 'hello\n');

        const repo = await openRepository({ cwd: localPlain, commonDir: localAlt });
        try {
          await repo.add(['f.txt']);
          const staged = tryRunGitWithExit(['show', ':f.txt'], {
            env: {
              ...runGitEnv(),
              GIT_DIR: path.join(localPlain, '.git'),
              GIT_COMMON_DIR: localAlt,
            },
          });

          // Assert
          expect(peerAdd.exitCode).toBe(0);
          expect(peerShow.stdout).toBe('HELLO\n');
          expect(staged.stdout).toBe('HELLO\n');
        } finally {
          await repo.dispose();
        }
      });

      it('Then a pre-commit hook resolved only from the override runs, not the gitdir decoy', async () => {
        // Arrange
        const dir = path.join(root, 'e-hooks');
        await mkdir(dir, { recursive: true });
        const localPlain = path.join(dir, 'plain');
        await cp(plainDir, localPlain, { recursive: true });
        const localAlt = path.join(dir, 'alt');
        await cp(altDir, localAlt, { recursive: true });
        const altMarker = path.join(dir, 'alt-marker');
        const gitDirMarker = path.join(dir, 'gitdir-marker');
        await writeFile(
          path.join(localAlt, 'hooks', 'pre-commit'),
          `#!/bin/sh\ntouch '${altMarker}'\nexit 0\n`,
        );
        await chmod(path.join(localAlt, 'hooks', 'pre-commit'), 0o755);
        await writeFile(
          path.join(localPlain, '.git', 'hooks', 'pre-commit'),
          `#!/bin/sh\ntouch '${gitDirMarker}'\nexit 0\n`,
        );
        await chmod(path.join(localPlain, '.git', 'hooks', 'pre-commit'), 0o755);

        // Act — tsgit
        const repo = await openRepository({ cwd: localPlain, commonDir: localAlt });
        try {
          await repo.primitives.runHook('pre-commit');
        } finally {
          await repo.dispose();
        }

        // Act — the peer, with its own separate marker (real git commit).
        const peerMarker = path.join(dir, 'peer-marker');
        await writeFile(
          path.join(localAlt, 'hooks', 'pre-commit'),
          `#!/bin/sh\ntouch '${peerMarker}'\nexit 0\n`,
        );
        await chmod(path.join(localAlt, 'hooks', 'pre-commit'), 0o755);
        const peerCommit = tryRunGitWithExit(
          ['-C', localPlain, 'commit', '-q', '--allow-empty', '-m', 'peer'],
          { env: { ...runGitEnv(), GIT_COMMON_DIR: localAlt, ...COMMIT_ENV } },
        );

        // Assert
        expect(existsSync(altMarker)).toBe(true);
        expect(existsSync(gitDirMarker)).toBe(false);
        expect(peerCommit.exitCode).toBe(0);
        expect(existsSync(peerMarker)).toBe(true);
      });
    });

    describe('When git rev-parse --git-path is walked over the per-worktree/common split under the override (scenario I)', () => {
      interface Row {
        readonly gitPath: string;
        readonly side: 'common' | 'perWorktree';
        readonly refName?: string;
      }

      const rows: ReadonlyArray<Row> = [
        { gitPath: 'objects', side: 'common' },
        { gitPath: 'objects/pack', side: 'common' },
        { gitPath: 'refs', side: 'common' },
        { gitPath: 'refs/heads', side: 'common' },
        { gitPath: 'refs/heads/main', side: 'common', refName: 'refs/heads/main' },
        { gitPath: 'packed-refs', side: 'common' },
        { gitPath: 'config', side: 'common' },
        { gitPath: 'shallow', side: 'common' },
        { gitPath: 'hooks', side: 'common' },
        { gitPath: 'hooks/pre-commit', side: 'common' },
        { gitPath: 'info', side: 'common' },
        { gitPath: 'info/exclude', side: 'common' },
        { gitPath: 'info/attributes', side: 'common' },
        { gitPath: 'logs', side: 'common' },
        { gitPath: 'logs/refs/heads/main', side: 'common' },
        { gitPath: 'branches', side: 'common' },
        { gitPath: 'remotes', side: 'common' },
        { gitPath: 'worktrees', side: 'common' },
        // Counter-intuitive: the rest of info/ is common, this is not.
        { gitPath: 'info/sparse-checkout', side: 'perWorktree' },
        // Counter-intuitive: the rest of logs/ is common, this is not.
        { gitPath: 'logs/HEAD', side: 'perWorktree' },
        { gitPath: 'HEAD', side: 'perWorktree', refName: 'HEAD' },
        { gitPath: 'index', side: 'perWorktree' },
        { gitPath: 'ORIG_HEAD', side: 'perWorktree', refName: 'ORIG_HEAD' },
        { gitPath: 'MERGE_HEAD', side: 'perWorktree', refName: 'MERGE_HEAD' },
        { gitPath: 'FETCH_HEAD', side: 'perWorktree', refName: 'FETCH_HEAD' },
        { gitPath: 'CHERRY_PICK_HEAD', side: 'perWorktree', refName: 'CHERRY_PICK_HEAD' },
        { gitPath: 'REVERT_HEAD', side: 'perWorktree', refName: 'REVERT_HEAD' },
        {
          gitPath: 'refs/bisect/foo',
          side: 'perWorktree',
          refName: 'refs/bisect/foo',
        },
        {
          gitPath: 'refs/worktree/foo',
          side: 'perWorktree',
          refName: 'refs/worktree/foo',
        },
        {
          gitPath: 'refs/rewritten/foo',
          side: 'perWorktree',
          refName: 'refs/rewritten/foo',
        },
        { gitPath: 'config.worktree', side: 'perWorktree' },
        { gitPath: 'gitdir', side: 'perWorktree' },
        { gitPath: 'commondir', side: 'perWorktree' },
      ];

      it.each(rows)(
        'Then git-path $gitPath resolves to the $side directory, and ref rows agree with isPerWorktreeRef',
        ({ gitPath, side, refName }) => {
          // Arrange
          const expectedBase = side === 'common' ? altDir : plainGitDir;

          // Act
          const result = tryRunGitWithExit(
            ['-C', plainDir, 'rev-parse', '--path-format=absolute', '--git-path', gitPath],
            { env: { ...runGitEnv(), GIT_COMMON_DIR: altDir } },
          );

          // Assert
          expect(result.exitCode).toBe(0);
          expect(result.stdout.trim().startsWith(expectedBase)).toBe(true);
          if (refName !== undefined) {
            expect(isPerWorktreeRef(refName as RefName)).toBe(side === 'perWorktree');
          }
        },
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenarios F, G, H — the repository-format acceptance gate, bareness
  // suppression, and the refusal shapes for an unusable override.
  // ───────────────────────────────────────────────────────────────────────
  describe('Given the repository-format acceptance gate, bareness and refusal shapes under the override (scenarios F, G, H)', () => {
    let root: string;
    let baseDir: string;
    let sha256BaseDir: string;
    let bareBaseDir: string;

    beforeAll(async () => {
      root = await mkRoot('fgh');
      baseDir = path.join(root, 'base');
      runGit(['init', '-q', '-b', 'main', baseDir]);
      await writeFile(path.join(baseDir, 'a.txt'), 'x\n');
      git(baseDir, 'add', 'a.txt');
      commit(baseDir, 'c1');

      sha256BaseDir = path.join(root, 'sha256-base');
      runGit(['init', '-q', '-b', 'main', '--object-format=sha256', sha256BaseDir]);
      await writeFile(path.join(sha256BaseDir, 'b.txt'), 'y\n');
      git(sha256BaseDir, 'add', 'b.txt');
      commit(sha256BaseDir, 'c1');

      bareBaseDir = path.join(root, 'bare-base.git');
      runGit(['init', '-q', '-b', 'main', '--bare', bareBaseDir]);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    /** Copies `baseDir` (workdir + `.git`) under a fresh row directory. */
    const copyPlainRow = async (slug: string): Promise<string> => {
      const dir = path.join(root, `row-${slug}`);
      await cp(baseDir, dir, { recursive: true });
      return dir;
    };

    describe('When repositoryformatversion = 99 is planted in the override config (scenario F)', () => {
      it('Then both refuse, naming the parsed version 99', async () => {
        // Arrange
        const dir = await copyPlainRow('f1');
        const alt = path.join(root, 'f1-alt');
        await cp(path.join(dir, '.git'), alt, { recursive: true });
        const altConfig = await readFile(path.join(alt, 'config'), 'utf8');
        await writeFile(
          path.join(alt, 'config'),
          `${altConfig}[core]\n\trepositoryformatversion = 99\n`,
        );

        // Act
        const peer = tryRunGitWithExit(['-C', dir, 'status', '--porcelain'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: alt },
        });
        const repo = await openRepository({ cwd: dir, commonDir: alt });

        try {
          // Assert — git
          expect(peer.exitCode).toBe(128);
          expect(peer.stderr).toContain('fatal: Expected git repo version <= 1, found 99');
          // Assert — tsgit
          expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When the same key is planted only in the gitdir config, with a clean override (scenario F)', () => {
      it('Then neither refuses — the gitdir config never participates under the override', async () => {
        // Arrange
        const dir = await copyPlainRow('f2');
        const alt = path.join(root, 'f2-alt');
        await cp(path.join(dir, '.git'), alt, { recursive: true });
        const gitDirConfigPath = path.join(dir, '.git', 'config');
        const original = await readFile(gitDirConfigPath, 'utf8');
        await writeFile(gitDirConfigPath, `${original}[core]\n\trepositoryformatversion = 99\n`);

        // Act
        const peer = tryRunGitWithExit(['-C', dir, 'status', '--porcelain'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: alt },
        });
        const repo = await openRepository({ cwd: dir, commonDir: alt });

        try {
          // Assert
          expect(peer.exitCode).toBe(0);
          expect(repo.ctx.layout.formatRefusal).toBeUndefined();
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When a sha256 override sits over a sha1 gitdir (scenario F)', () => {
      it('Then both resolve sha256 — the mismatched pair being unreadable is out of scope', async () => {
        // Arrange
        const dir = await copyPlainRow('f3');
        const alt = path.join(root, 'f3-alt');
        await cp(path.join(sha256BaseDir, '.git'), alt, { recursive: true });

        // Act
        const peer = tryRunGitWithExit(['-C', dir, 'rev-parse', '--show-object-format'], {
          env: { ...runGitEnv(), GIT_COMMON_DIR: alt },
        });
        const repo = await openRepository({ cwd: dir, commonDir: alt });

        try {
          // Assert
          expect(peer.exitCode).toBe(0);
          expect(peer.stdout.trim()).toBe('sha256');
          expect(repo.ctx.layout.objectFormat).toBe('sha256');
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When core.bare = true meets a supplied commonDir on the discovery route (scenario G)', () => {
      it('Then both report not-bare / inside-work-tree, top level the discovered origin', async () => {
        // Arrange
        const dir = await copyPlainRow('g-disc');
        git(dir, 'config', 'core.bare', 'true');
        const alt = path.join(root, 'g-disc-alt');
        await cp(path.join(dir, '.git'), alt, { recursive: true });

        // Act
        const peer = tryRunGitWithExit(
          [
            '-C',
            dir,
            'rev-parse',
            '--is-bare-repository',
            '--is-inside-work-tree',
            '--show-toplevel',
          ],
          { env: { ...runGitEnv(), GIT_COMMON_DIR: alt } },
        );
        const repo = await openRepository({ cwd: dir, commonDir: alt });

        try {
          // Assert
          expect(peer.exitCode).toBe(0);
          expect(peer.stdout.trim().split('\n')).toEqual(['false', 'true', dir]);
          expect(repo.layout.bare).toBe(false);
          expect(repo.layout.workDir).toBe(dir);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When core.bare = true meets a supplied commonDir on the explicit gitDir route (scenario G)', () => {
      it('Then both report not-bare / inside-work-tree, top level the caller cwd', async () => {
        // Arrange
        const dir = await copyPlainRow('g-explicit');
        git(dir, 'config', 'core.bare', 'true');
        const alt = path.join(root, 'g-explicit-alt');
        await cp(path.join(dir, '.git'), alt, { recursive: true });
        const elsewhere = path.join(root, 'g-explicit-elsewhere');
        await mkdir(elsewhere, { recursive: true });

        // Act
        const peer = tryRunGitWithExit(
          [
            '-C',
            elsewhere,
            'rev-parse',
            '--is-bare-repository',
            '--is-inside-work-tree',
            '--show-toplevel',
          ],
          {
            env: {
              ...runGitEnv(),
              GIT_DIR: path.join(dir, '.git'),
              GIT_COMMON_DIR: alt,
            },
          },
        );
        const repo = await openRepository({
          cwd: elsewhere,
          gitDir: path.join(dir, '.git'),
          commonDir: alt,
        });

        try {
          // Assert
          expect(peer.exitCode).toBe(0);
          expect(peer.stdout.trim().split('\n')).toEqual(['false', 'true', elsewhere]);
          expect(repo.layout.bare).toBe(false);
          expect(repo.layout.workDir).toBe(elsewhere);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When core.bare = true meets a supplied commonDir on the cwd-is-gitdir route (scenario G)', () => {
      it('Then both stay bare, with no work tree', async () => {
        // Arrange
        const dir = path.join(root, 'g-bare');
        await cp(bareBaseDir, dir, { recursive: true });
        const alt = path.join(root, 'g-bare-alt');
        await cp(dir, alt, { recursive: true });

        // Act
        const peer = tryRunGitWithExit(
          ['-C', dir, 'rev-parse', '--is-bare-repository', '--is-inside-work-tree'],
          { env: { ...runGitEnv(), GIT_COMMON_DIR: alt } },
        );
        const repo = await openRepository({ cwd: dir, commonDir: alt });

        try {
          // Assert
          expect(peer.exitCode).toBe(0);
          expect(peer.stdout.trim().split('\n')).toEqual(['true', 'false']);
          expect(repo.layout.bare).toBe(true);
          expect(repo.layout.workDir).toBeUndefined();
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When the supplied commonDir is unusable (scenario H)', () => {
      /** Builds `shape`'s unusable commonDir under `dir`, named uniquely by `suffix`. */
      const makeBadCommon = async (dir: string, shape: string, suffix: string): Promise<string> => {
        const bad = path.join(dir, `bad-${suffix}`);
        if (shape === 'file') {
          await writeFile(bad, 'not a directory\n');
        } else if (shape === 'objects-only') {
          await mkdir(path.join(bad, 'objects'), { recursive: true });
        } else if (shape === 'refs-only') {
          await mkdir(path.join(bad, 'refs'), { recursive: true });
        }
        // 'nonexistent': never created.
        return bad;
      };

      it.each(['nonexistent', 'file', 'objects-only', 'refs-only'] as const)(
        'Then git co-refuses on both routes (exit 128), and tsgit defers on the explicit route while surfacing NOT_A_REPOSITORY on the discovery route: %s',
        async (label) => {
          // Arrange — explicit route: a real, self-sufficient gitDir paired
          // with the unusable override.
          const dir = await copyPlainRow(`h-${label}`);
          const gitDir = path.join(dir, '.git');
          const badExplicit = await makeBadCommon(root, label, `explicit-${label}`);

          // Act — explicit route peer + tsgit
          const explicitPeer = tryRunGitWithExit(['rev-parse', 'HEAD'], {
            env: { ...runGitEnv(), GIT_DIR: gitDir, GIT_COMMON_DIR: badExplicit },
          });
          const explicitRepo = await openRepository({
            cwd: dir,
            gitDir,
            commonDir: badExplicit,
          });
          let explicitCaught: unknown;
          try {
            await explicitRepo.revParse('HEAD');
          } catch (err) {
            explicitCaught = err;
          } finally {
            await explicitRepo.dispose();
          }

          // Assert — explicit route
          expect(explicitPeer.exitCode).toBe(128);
          expect(explicitPeer.stderr).toContain(`not a git repository: '${gitDir}'`);
          expect(explicitCaught).toBeDefined();
          const explicitData = (explicitCaught as { data: { code: string } }).data;
          if (label === 'file') {
            expect(explicitData.code).toBe('NOT_A_DIRECTORY');
          } else {
            expect(explicitData.code).toBe('OBJECT_NOT_FOUND');
          }

          // Arrange — discovery route: cwd has no .git of its own anywhere,
          // so the override's shape never even needs consulting to fail.
          const emptyDir = path.join(root, `h-empty-${label}`);
          await mkdir(emptyDir, { recursive: true });
          const badDiscovery = await makeBadCommon(root, label, `disc-${label}`);

          // Act — discovery route peer + tsgit
          const discoveryPeer = tryRunGitWithExit(['-C', emptyDir, 'rev-parse', 'HEAD'], {
            env: { ...runGitEnv(), GIT_COMMON_DIR: badDiscovery },
          });
          const discoveryRepo = await openRepository({
            cwd: emptyDir,
            commonDir: badDiscovery,
          });
          let discoveryCaught: unknown;
          try {
            await discoveryRepo.revParse('HEAD');
          } catch (err) {
            discoveryCaught = err;
          } finally {
            await discoveryRepo.dispose();
          }

          // Assert — discovery route
          expect(discoveryPeer.exitCode).toBe(128);
          expect(discoveryPeer.stderr).toContain(
            'not a git repository (or any of the parent directories): .git',
          );
          const discoveryData = (discoveryCaught as { data: { code: string; path: string } }).data;
          expect(discoveryData.code).toBe('NOT_A_REPOSITORY');
          expect(discoveryData.path).toBe(emptyDir);
        },
      );
    });
  });
});
