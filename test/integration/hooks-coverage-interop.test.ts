/**
 * Cross-tool interop — lifecycle hook coverage (24.8). Each hook is authored as
 * a real POSIX recorder script and installed into both a canonical-git repo and
 * a tsgit repo built from the same git history; the same operation runs under
 * `git` (peer) and tsgit (ours, via the Node shim's NodeHookRunner), and the
 * recorded firing / args / stdin are compared. Pins the observable git
 * behaviour the prime directive binds: which hook fires, with what arguments and
 * stdin, and the blocking vs informational exit-code contract.
 *
 * @proves
 *   surface:        hooks
 *   bucket:         cross-tool-interop
 *   unique:         post-commit family / post-merge / post-checkout / pre-rebase / post-rewrite fire byte-faithfully vs canonical git
 *   interopSurface: hooks
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { commit } from '../../src/application/commands/commit.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { rebaseRun } from '../../src/application/commands/rebase.js';
import { resolveRef } from '../../src/application/primitives/resolve-ref.js';
import type { AuthorIdentity, RefName } from '../../src/domain/objects/index.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** Env pinning git's author + committer name/email/date — deterministic oids. */
const pinnedEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
});

/** Commit the working tree of `repo` via git with a fully pinned identity. */
const commitPinned = (repo: string, message: string): void => {
  runGit(['-C', repo, 'add', '-A']);
  runGit(['-C', repo, 'commit', '-q', '-m', message], {
    env: pinnedEnv(),
  });
};

const writeIn = (repo: string, file: string, content: string): Promise<void> =>
  writeFile(path.join(repo, file), content);

/**
 * Install an executable recorder hook capturing `$@` (to `<git-dir>/hook-args`)
 * and stdin (to `<git-dir>/hook-stdin`). The git dir is located via
 * `git rev-parse --git-dir` so the hook works identically whether invoked by
 * canonical git (which does not export `GIT_DIR`) or tsgit's runner (which does).
 */
const installRecorder = async (gitDir: string, name: string): Promise<void> =>
  installHook(
    gitDir,
    name,
    `#!/bin/sh\nd=$(git rev-parse --git-dir)\nprintf '%s' "$*" > "$d/hook-args"\ncat > "$d/hook-stdin"\nexit 0\n`,
  );

const installHook = async (gitDir: string, name: string, body: string): Promise<void> => {
  const hookPath = path.join(gitDir, 'hooks', name);
  await writeFile(hookPath, body);
  await chmod(hookPath, 0o755);
};

const readArgs = async (gitDir: string): Promise<string | undefined> =>
  tryRead(path.join(gitDir, 'hook-args'));
const readStdin = async (gitDir: string): Promise<string | undefined> =>
  tryRead(path.join(gitDir, 'hook-stdin'));

const tryRead = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

const gitDirOf = (repo: string): string => path.join(repo, '.git');

describe.skipIf(!GIT_AVAILABLE)('hook coverage interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('hooks');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  /** Both repos: base on `main`, `feature` one commit ahead, HEAD back on main. */
  const buildBranches = async (): Promise<void> => {
    for (const repo of [pair.peer, pair.ours]) {
      await writeIn(repo, 'base.txt', 'base\n');
      commitPinned(repo, 'base');
      git(repo, 'branch', 'feature');
      git(repo, 'checkout', '-q', 'feature');
      await writeIn(repo, 'feat.txt', 'feat\n');
      commitPinned(repo, 'feat');
      git(repo, 'checkout', '-q', 'main');
    }
  };

  describe('Given a post-checkout recorder hook', () => {
    describe('When switching to feature under git and tsgit', () => {
      it('Then both record identical <old> <new> 1', async () => {
        // Arrange
        await buildBranches();
        await installRecorder(gitDirOf(pair.peer), 'post-checkout');
        await installRecorder(gitDirOf(pair.ours), 'post-checkout');

        // Act
        git(pair.peer, 'checkout', '-q', 'feature');
        await checkout(createNodeContext({ workDir: pair.ours }), { rev: 'feature' });

        // Assert — identical history ⇒ identical HEAD oids ⇒ byte-equal record.
        const oursArgs = await readArgs(gitDirOf(pair.ours));
        expect(oursArgs).toBe(await readArgs(gitDirOf(pair.peer)));
        expect(oursArgs?.endsWith(' 1')).toBe(true);
      });
    });
  });

  describe('Given a post-checkout recorder hook', () => {
    describe('When restoring a path under git and tsgit', () => {
      it('Then both record flag 0 with prev == new HEAD', async () => {
        // Arrange — commit, then dirty the file so the restore actually runs.
        for (const repo of [pair.peer, pair.ours]) {
          await writeIn(repo, 'a.txt', 'a\n');
          commitPinned(repo, 'a');
        }
        await installRecorder(gitDirOf(pair.peer), 'post-checkout');
        await installRecorder(gitDirOf(pair.ours), 'post-checkout');
        await writeIn(pair.peer, 'a.txt', 'dirty\n');
        await writeIn(pair.ours, 'a.txt', 'dirty\n');

        // Act
        git(pair.peer, 'checkout', '--', 'a.txt');
        await checkout(createNodeContext({ workDir: pair.ours }), { paths: ['a.txt'] });

        // Assert
        const oursArgs = await readArgs(gitDirOf(pair.ours));
        const parts = oursArgs?.split(' ') ?? [];
        expect(parts).toHaveLength(3);
        expect(parts[2]).toBe('0');
        expect(parts[0]).toBe(parts[1]); // file checkout does not move HEAD
        expect(oursArgs).toBe(await readArgs(gitDirOf(pair.peer)));
      });
    });
  });

  describe('Given a post-merge recorder hook', () => {
    describe('When fast-forwarding feature into main under git and tsgit', () => {
      it('Then both record the squash flag 0', async () => {
        // Arrange
        await buildBranches();
        await installRecorder(gitDirOf(pair.peer), 'post-merge');
        await installRecorder(gitDirOf(pair.ours), 'post-merge');

        // Act
        git(pair.peer, 'merge', '--ff-only', 'feature');
        await mergeRun(createNodeContext({ workDir: pair.ours }), { rev: 'feature' });

        // Assert
        expect(await readArgs(gitDirOf(pair.ours))).toBe('0');
        expect(await readArgs(gitDirOf(pair.peer))).toBe('0');
      });
    });
  });

  describe('Given a post-merge recorder hook and an up-to-date merge', () => {
    describe('When merging an ancestor under git and tsgit', () => {
      it('Then neither fires post-merge', async () => {
        // Arrange — single commit on main; merging HEAD is a no-op.
        for (const repo of [pair.peer, pair.ours]) {
          await writeIn(repo, 'base.txt', 'base\n');
          commitPinned(repo, 'base');
        }
        await installRecorder(gitDirOf(pair.peer), 'post-merge');
        await installRecorder(gitDirOf(pair.ours), 'post-merge');

        // Act
        git(pair.peer, 'merge', 'HEAD');
        const ctx = createNodeContext({ workDir: pair.ours });
        await mergeRun(ctx, { rev: await resolveRef(ctx, 'HEAD' as RefName) });

        // Assert
        expect(await readArgs(gitDirOf(pair.peer))).toBeUndefined();
        expect(await readArgs(gitDirOf(pair.ours))).toBeUndefined();
      });
    });
  });

  /** Both repos: feature (base + f) diverged from an advanced main (base + m). */
  const buildDivergent = async (): Promise<void> => {
    for (const repo of [pair.peer, pair.ours]) {
      await writeIn(repo, 'base.txt', 'base\n');
      commitPinned(repo, 'base');
      git(repo, 'branch', 'feature');
      git(repo, 'checkout', '-q', 'feature');
      await writeIn(repo, 'f1.txt', 'f1\n');
      commitPinned(repo, 'f1');
      await writeIn(repo, 'f2.txt', 'f2\n');
      commitPinned(repo, 'f2');
      git(repo, 'checkout', '-q', 'main');
      await writeIn(repo, 'm1.txt', 'm1\n');
      commitPinned(repo, 'm1');
      git(repo, 'checkout', '-q', 'feature');
    }
  };

  describe('Given a failing pre-rebase hook', () => {
    describe('When rebasing under git and tsgit', () => {
      it('Then both abort and leave the branch tip unmoved', async () => {
        // Arrange
        await buildDivergent();
        await installHook(gitDirOf(pair.peer), 'pre-rebase', '#!/bin/sh\nexit 1\n');
        await installHook(gitDirOf(pair.ours), 'pre-rebase', '#!/bin/sh\nexit 1\n');
        const featureBefore = git(pair.peer, 'rev-parse', 'feature').trim();

        // Act
        const peerRebase = tryRunGit(['-C', pair.peer, 'rebase', 'main']);
        let oursThrew = false;
        try {
          await rebaseRun(createNodeContext({ workDir: pair.ours }), { upstream: 'main' });
        } catch {
          oursThrew = true;
        }

        // Assert — both refuse, both leave feature where it was.
        expect(peerRebase.ok).toBe(false);
        expect(oursThrew).toBe(true);
        expect(git(pair.peer, 'rev-parse', 'feature').trim()).toBe(featureBefore);
        expect(git(pair.ours, 'rev-parse', 'feature').trim()).toBe(featureBefore);
      });
    });
  });

  describe('Given a post-rewrite recorder hook', () => {
    describe('When rebasing feature onto an advanced main under git and tsgit', () => {
      it('Then both feed <old> <new> lines whose source column matches', async () => {
        // Arrange
        await buildDivergent();
        await installRecorder(gitDirOf(pair.peer), 'post-rewrite');
        await installRecorder(gitDirOf(pair.ours), 'post-rewrite');

        // Act — merge backend so git fires post-rewrite with the rewritten-list.
        runGit(['-C', pair.peer, '-c', 'rebase.backend=merge', 'rebase', 'main'], {
          env: pinnedEnv(),
        });
        await rebaseRun(createNodeContext({ workDir: pair.ours }), { upstream: 'main' });

        // Assert — same source (old) column in order; every line is <oid> <oid>.
        const oursStdin = (await readStdin(gitDirOf(pair.ours))) ?? '';
        const peerStdin = (await readStdin(gitDirOf(pair.peer))) ?? '';
        const oldColumn = (s: string): ReadonlyArray<string> =>
          s
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => line.split(' ')[0] ?? '');
        expect(oursStdin.length).toBeGreaterThan(0);
        expect(oldColumn(oursStdin)).toEqual(oldColumn(peerStdin));
        for (const line of oursStdin.split('\n').filter((l) => l.length > 0)) {
          expect(line).toMatch(/^[0-9a-f]{40} [0-9a-f]{40}$/);
        }
      });
    });
  });

  describe('Given a prepare-commit-msg hook that rewrites the message', () => {
    describe('When committing under git and tsgit', () => {
      it('Then both commits carry the rewritten message', async () => {
        // Arrange
        const body = '#!/bin/sh\nprintf "from prepare\\n" > "$1"\nexit 0\n';
        await installHook(gitDirOf(pair.peer), 'prepare-commit-msg', body);
        await installHook(gitDirOf(pair.ours), 'prepare-commit-msg', body);
        await writeIn(pair.peer, 'a.txt', 'a\n');
        await writeIn(pair.ours, 'a.txt', 'a\n');
        git(pair.peer, 'add', '-A');
        git(pair.ours, 'add', '-A');

        // Act
        runGit(['-C', pair.peer, 'commit', '-q', '-m', 'original'], {
          env: pinnedEnv(),
        });
        await commit(createNodeContext({ workDir: pair.ours }), {
          message: 'original',
          author: AUTHOR,
        });

        // Assert
        expect(git(pair.ours, 'log', '-1', '--format=%B').trim()).toBe('from prepare');
        expect(git(pair.peer, 'log', '-1', '--format=%B').trim()).toBe('from prepare');
      });
    });
  });
});
