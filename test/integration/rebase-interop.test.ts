/**
 * Cross-tool rebase interop. Pins tsgit's `repo.rebase` against real `git rebase`
 * (the merge backend):
 *   - clean rebase: resulting tree + preserved author + single-parent parity;
 *   - bidirectional resume — a tsgit-started rebase finished by `git rebase
 *     --continue`, and a git-started rebase finished by `repo.rebase.continue` —
 *     the proof of a byte-faithful, cross-tool-resumable `.git/rebase-merge/`;
 *   - abort reflog parity (HEAD `rebase (abort): returning to …`; branch untouched);
 *   - drop-set parity (both tools drop the same cherry-pick-equivalent commit).
 *
 * Commit OIDs embed the committer timestamp, so equivalence is asserted via the
 * host-independent tree readback (`git write-tree`) plus the preserved author
 * line, not raw oids. The source author date is pinned on both sides.
 *
 * @writes
 *   surface: rebase
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 *
 * @proves
 *   surface:        rebase, rebase.continue, rebase.abort
 *   bucket:         cross-tool-interop
 *   unique:         a rebase either tool starts is resumable by the other, and both drop the same already-upstream commit
 *   interopSurface: rebaseMerge, reflog
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  topReflogSubject,
  tryRunGit,
  tryRunGitWithExit,
  writeTreeOf,
} from './interop-helpers.js';
import { outcomeOfGitStderr } from './occupant-displacement-fixtures.js';

const FIXED_DATE = '1700000000 +0000';

const configGit = (dir: string): void => {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
};

const writeWork = (dir: string, rel: string, content: string): void => {
  writeFileSync(path.join(dir, rel), content);
};

const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message, '--author', 'Ada <ada@example.com>'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

const headAuthor = (dir: string): string =>
  git(dir, 'cat-file', 'commit', 'HEAD')
    .split('\n')
    .find((l) => l.startsWith('author ')) ?? '';

const headParents = (dir: string): number =>
  git(dir, 'cat-file', 'commit', 'HEAD')
    .split('\n')
    .filter((l) => l.startsWith('parent ')).length;

const headHasBlob = (dir: string, rel: string): boolean =>
  git(dir, 'cat-file', '-t', git(dir, 'rev-parse', `HEAD:${rel}`).trim()).trim() === 'blob';

const commitCount = (dir: string): number => Number(git(dir, 'rev-list', '--count', 'HEAD').trim());

describe.skipIf(!GIT_AVAILABLE)('rebase interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('rebase');
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a topic diverged from an advanced main, When the topic is rebased onto main', () => {
    it('Then a clean rebase matches git: resulting tree, preserved author, single parent', async () => {
      // Arrange — identical history in both repos
      buildClean(pair.peer);
      buildClean(pair.ours);
      git(pair.peer, 'rebase', 'main');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      const result = await repo.rebase.run({ upstream: 'main' });
      await repo.dispose();

      // Assert
      expect(result.kind).toBe('rebased');
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
      expect(headAuthor(pair.ours)).toBe(headAuthor(pair.peer));
      expect(headParents(pair.ours)).toBe(1);
      expect(headParents(pair.peer)).toBe(1);
    });
  });

  describe('Given a tsgit-started rebase that conflicts, When the conflict is resolved and handed to git rebase --continue', () => {
    it('Then git rebase --continue finishes it (tsgit rebase-merge state is git-readable)', async () => {
      // Arrange — tsgit hits the conflict and persists `.git/rebase-merge/`
      const dir = pair.ours;
      buildConflict(dir);
      const repo = await openRepository({ cwd: dir });
      const stop = await repo.rebase.run({ upstream: 'main' });
      expect(stop.kind).toBe('conflict');
      await repo.dispose();

      // Resolve, then hand the rebase off to real git
      await writeFile(path.join(dir, 'f.txt'), 'l1\nRESOLVED\n');
      git(dir, 'add', 'f.txt');

      // Act
      runGit(['-C', dir, '-c', 'core.editor=true', 'rebase', '--continue']);

      // Assert — git committed the resolution; a.txt (the clean pick) survived
      expect(headHasBlob(dir, 'a.txt')).toBe(true);
      expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('topic');
    });
  });

  describe('Given a git-started rebase that conflicts, When the conflict is resolved and handed to repo.rebase.continue', () => {
    it('Then repo.rebase.continue finishes it (tsgit reads git rebase-merge state)', async () => {
      // Arrange — git starts the rebase and stops on the conflict
      const dir = pair.ours;
      buildConflict(dir);
      tryRunGit(['-C', dir, '-c', 'core.editor=true', 'rebase', 'main']);

      // Resolve, then hand the git-written rebase-merge off to tsgit
      await writeFile(path.join(dir, 'f.txt'), 'l1\nRESOLVED\n');
      git(dir, 'add', 'f.txt');
      const repo = await openRepository({ cwd: dir });

      // Act
      const done = await repo.rebase.continue();
      await repo.dispose();

      // Assert
      expect(done.kind).toBe('rebased');
      expect(headHasBlob(dir, 'a.txt')).toBe(true);
    });
  });

  describe('Given a rebase stopped on a conflict, When the resolution is committed by hand and the rebase continued', () => {
    it('Then tsgit keeps the hand-made commit like git, adding none of its own', async () => {
      // Arrange
      buildConflict(pair.peer);
      buildConflict(pair.ours);
      tryRunGit(['-C', pair.peer, '-c', 'core.editor=true', 'rebase', 'main']);
      writeWork(pair.peer, 'f.txt', 'l1\nRESOLVED\n');
      git(pair.peer, 'add', 'f.txt');
      gitCommit(pair.peer, 'manual');
      runGit(['-C', pair.peer, '-c', 'core.editor=true', 'rebase', '--continue']);
      const repo = await openRepository({ cwd: pair.ours });
      await repo.rebase.run({ upstream: 'main' });
      writeWork(pair.ours, 'f.txt', 'l1\nRESOLVED\n');
      git(pair.ours, 'add', 'f.txt');
      await repo.commit({ message: 'manual' });

      // Act
      const result = await repo.rebase.continue();
      await repo.dispose();

      // Assert
      expect(result).toEqual({ kind: 'rebased', commits: [] });
      const subjects = (dir: string): string => git(dir, 'log', '--format=%s', 'main..topic');
      expect(subjects(pair.ours)).toBe(subjects(pair.peer));
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
      expect(git(pair.ours, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/topic');
    });
  });

  describe('Given a rebase aborted mid-conflict, When both tools abort', () => {
    it('Then tsgit and git write the same faithful abort reflog, branch untouched', async () => {
      // Arrange — identical conflict in both; run each to the stop.
      buildConflict(pair.peer);
      buildConflict(pair.ours);
      const branchTop = topReflogSubject(pair.peer, 'refs/heads/topic');
      tryRunGit(['-C', pair.peer, '-c', 'core.editor=true', 'rebase', 'main']);
      const repo = await openRepository({ cwd: pair.ours });
      const stop = await repo.rebase.run({ upstream: 'main' });
      expect(stop.kind).toBe('conflict');

      // Act — abort on both tools
      runGit(['-C', pair.peer, 'rebase', '--abort']);
      await repo.rebase.abort();
      await repo.dispose();

      // Assert — HEAD records `rebase (abort): returning to refs/heads/topic`;
      // the branch never moved during the detached replay, so its reflog is unchanged.
      const peerHead = topReflogSubject(pair.peer, 'HEAD');
      expect(peerHead).toBe('rebase (abort): returning to refs/heads/topic');
      expect(topReflogSubject(pair.ours, 'HEAD')).toBe(peerHead);
      expect(topReflogSubject(pair.peer, 'refs/heads/topic')).toBe(branchTop);
      expect(topReflogSubject(pair.ours, 'refs/heads/topic')).toBe(branchTop);
    });
  });

  describe('Given a topic commit already present upstream, When the topic is rebased onto main', () => {
    it('Then tsgit and git drop the identical cherry-pick-equivalent commit', async () => {
      // Arrange — identical history where `dup` is patch-equivalent to a main commit
      buildCherryEquivalent(pair.peer);
      buildCherryEquivalent(pair.ours);
      git(pair.peer, 'rebase', 'main');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      const result = await repo.rebase.run({ upstream: 'main' });
      await repo.dispose();

      // Assert — both drop `dup`, leaving the same commit count and tree
      expect(result.kind).toBe('rebased');
      expect(commitCount(pair.ours)).toBe(commitCount(pair.peer));
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
    });
  });

  describe('Given a merge on main of a side branch forked at the base, When main is rebased onto the base', () => {
    it('Then tsgit, like git, replays the non-linear history rather than calling it up to date', async () => {
      // Arrange — identical history in both repos
      buildMergedSide(pair.peer);
      buildMergedSide(pair.ours);
      git(pair.peer, 'rebase', 'base');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      const result = await repo.rebase.run({ upstream: 'base' });
      await repo.dispose();

      // Assert
      expect(result.kind).toBe('rebased');
      expect(commitCount(pair.ours)).toBe(commitCount(pair.peer));
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
      expect(headParents(pair.ours)).toBe(headParents(pair.peer));
    });
  });

  describe('Given two unrelated histories (no common ancestor), When the feature branch is rebased onto main', () => {
    it('Then tsgit matches git: same resulting tree, commit count, single-parent tip', async () => {
      // Arrange — identical orphan-branch history in both repos
      buildUnrelated(pair.peer);
      buildUnrelated(pair.ours);
      git(pair.peer, 'rebase', 'main');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      const result = await repo.rebase.run({ upstream: 'main' });
      await repo.dispose();

      // Assert — the whole feature branch replays onto main, identically to git
      expect(result.kind).toBe('rebased');
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
      expect(commitCount(pair.ours)).toBe(commitCount(pair.peer));
      expect(headParents(pair.ours)).toBe(1);
      expect(headParents(pair.peer)).toBe(1);
    });
  });

  describe('Given rebase sides spelt as revisions', () => {
    const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
        return undefined;
      } catch (error) {
        return (error as TsgitError).data;
      }
    };

    describe.each([
      [['HEAD~1'], { upstream: 'HEAD~1' }],
      [['--onto', 'main~1...main', 'HEAD~1'], { upstream: 'HEAD~1', onto: 'main~1...main' }],
      [['@{u}'], { upstream: '@{u}' }],
    ])('When git rebase %j and tsgit rebase it', (args, input) => {
      it('Then both land on the same base with the same reflog', async () => {
        // Arrange
        buildRevisionSides(pair.peer);
        buildRevisionSides(pair.ours);
        tryRunGit(['-C', pair.peer, 'rebase', ...args]);
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.rebase.run(input);
        await repo.dispose();

        // Assert
        expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
        expect(git(pair.ours, 'rev-parse', 'HEAD~1')).toBe(git(pair.peer, 'rev-parse', 'HEAD~1'));
        expect(topReflogSubject(pair.ours, 'HEAD')).toBe(topReflogSubject(pair.peer, 'HEAD'));
      });
    });

    describe.each([
      [['absent'], { upstream: 'absent' }, "invalid upstream 'absent'", 'invalid-upstream'],
      [
        ['HEAD^{tree}'],
        { upstream: 'HEAD^{tree}' },
        "invalid upstream 'HEAD^{tree}'",
        'invalid-upstream',
      ],
      [
        ['--onto', 'absent', 'HEAD~1'],
        { upstream: 'HEAD~1', onto: 'absent' },
        "Does not point to a valid commit 'absent'",
        'invalid-onto',
      ],
      [
        ['--onto', 'absent...main', 'HEAD~1'],
        { upstream: 'HEAD~1', onto: 'absent...main' },
        "'absent...main': need exactly one merge base",
        'onto-merge-base-not-unique',
      ],
    ])('When git rebase %j and tsgit rebase it', (args, input, message, reason) => {
      it('Then both refuse it', async () => {
        // Arrange
        buildRevisionSides(pair.peer);
        buildRevisionSides(pair.ours);
        const refused = tryRunGitWithExit(['-C', pair.peer, 'rebase', ...args]);
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        const result = await refusalOf(() => repo.rebase.run(input));
        await repo.dispose();

        // Assert
        expect(refused.stderr).toContain(`fatal: ${message}`);
        expect(result).toMatchObject({ code: 'REBASE_REVISION_INVALID', reason });
      });
    });
  });
});

// ── git-CLI scenario builders ───────────────────────────────────────────────

/** base; topic adds t1, t2; main advances with m1. HEAD left on topic. */
function buildClean(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'base.txt', 'base\n');
  git(dir, 'add', 'base.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'topic');
  writeWork(dir, 't1.txt', 't1\n');
  git(dir, 'add', 't1.txt');
  gitCommit(dir, 't1 subject');
  writeWork(dir, 't2.txt', 't2\n');
  git(dir, 'add', 't2.txt');
  gitCommit(dir, 't2 subject');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'm1.txt', 'm1\n');
  git(dir, 'add', 'm1.txt');
  gitCommit(dir, 'm1');
  git(dir, 'checkout', '-q', 'topic');
}

/** topic: t1 adds a.txt (clean), t2 edits f.txt; main edits f.txt conflictingly. */
function buildConflict(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'f.txt', 'l1\nl2\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'topic');
  writeWork(dir, 'a.txt', 'a\n');
  git(dir, 'add', 'a.txt');
  gitCommit(dir, 't1 clean');
  writeWork(dir, 'f.txt', 'l1\nTOPIC\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 't2 conflict');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'f.txt', 'l1\nMAIN\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'm1 conflict');
  git(dir, 'checkout', '-q', 'topic');
}

/** topic: `dup` edits f a->b then t2 adds t.txt; main applies the same a->b then b->c. */
function buildCherryEquivalent(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'f.txt', 'a\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'topic');
  writeWork(dir, 'f.txt', 'b\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'dup');
  writeWork(dir, 't.txt', 't\n');
  git(dir, 'add', 't.txt');
  gitCommit(dir, 't2');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'f.txt', 'b\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'dup on main');
  writeWork(dir, 'f.txt', 'c\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'm2 diverge');
  git(dir, 'checkout', '-q', 'topic');
}

/** main: base, m1; an ORPHAN feature: f0, f1 — no merge-base with main. HEAD on feature. */
function buildUnrelated(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'base.txt', 'base\n');
  git(dir, 'add', 'base.txt');
  gitCommit(dir, 'base');
  writeWork(dir, 'm1.txt', 'm1\n');
  git(dir, 'add', 'm1.txt');
  gitCommit(dir, 'm1');
  git(dir, 'checkout', '-q', '--orphan', 'feature');
  git(dir, 'rm', '-rf', '.');
  writeWork(dir, 'f0.txt', 'f0\n');
  git(dir, 'add', 'f0.txt');
  gitCommit(dir, 'feature root');
  writeWork(dir, 'f1.txt', 'f1\n');
  git(dir, 'add', 'f1.txt');
  gitCommit(dir, 'feature one');
}

/** base (branch `base`); side adds s.txt; main adds m1.txt, then merges side. HEAD on main. */
function buildMergedSide(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'base.txt', 'base\n');
  git(dir, 'add', 'base.txt');
  gitCommit(dir, 'base');
  git(dir, 'branch', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeWork(dir, 's.txt', 's\n');
  git(dir, 'add', 's.txt');
  gitCommit(dir, 'side');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'm1.txt', 'm1\n');
  git(dir, 'add', 'm1.txt');
  gitCommit(dir, 'm1');
  runGit(['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
}

// ── interactive (`rebase -i`) ───────────────────────────────────────────────

/** base; c1, c2, c3 each adding an independent file. HEAD on main. */
function buildInteractiveLinear(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'base.txt', 'base\n');
  git(dir, 'add', 'base.txt');
  gitCommit(dir, 'base');
  for (const n of ['1', '2', '3']) {
    writeWork(dir, `${n}.txt`, `${n}\n`);
    git(dir, 'add', `${n}.txt`);
    gitCommit(dir, `c${n} subject`);
  }
}

/** Run git's interactive rebase with a scripted todo edit (and optional message editor). */
const gitRebaseInteractive = (dir: string, perlTodo: string, editor = 'true'): void => {
  runGit(['-C', dir, 'rebase', '-i', 'HEAD~3'], {
    env: { ...runGitEnv(), GIT_SEQUENCE_EDITOR: `perl -i -pe '${perlTodo}'`, GIT_EDITOR: editor },
  });
};

const oidAt = (dir: string, rev: string): string => git(dir, 'rev-parse', rev).trim();

/** The stop's `stopped-sha` and `REBASE_HEAD`, as written. */
const stopMarkers = (dir: string): string =>
  readFileSync(path.join(dir, '.git', 'rebase-merge', 'stopped-sha'), 'utf8') +
  readFileSync(path.join(dir, '.git', 'REBASE_HEAD'), 'utf8');

describe.skipIf(!GIT_AVAILABLE)('rebase interactive interop', () => {
  let pair: PeerPair;
  beforeEach(async () => {
    pair = await makePeerPair('rebase-i');
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a linear history rebased interactively', () => {
    const REBASE_TODO_MATRIX: ReadonlyArray<{
      label: string;
      action: 'drop' | 'squash' | 'fixup';
      target: 'c2' | 'c3';
    }> = [
      { label: 'dropping a commit', action: 'drop', target: 'c2' },
      { label: 'squashing a commit', action: 'squash', target: 'c3' },
      { label: 'fixing up a commit', action: 'fixup', target: 'c3' },
    ];

    describe('When the interactive todo drops, squashes, or fixes up a commit', () => {
      it.each(REBASE_TODO_MATRIX)(
        'Then $label matches git: resulting tree + commit count',
        async ({ action, target }) => {
          // Arrange — identical history; git applies the scripted todo action
          buildInteractiveLinear(pair.peer);
          buildInteractiveLinear(pair.ours);
          gitRebaseInteractive(pair.peer, `s/^pick (.*${target} subject)/${action} $1/`);
          const base = oidAt(pair.ours, 'HEAD~3');
          const [c1, c2, c3] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => oidAt(pair.ours, r));
          const repo = await openRepository({ cwd: pair.ours });
          const todo =
            target === 'c2'
              ? [
                  { action: 'pick' as const, oid: c1 as string },
                  { action, oid: c2 as string },
                  { action: 'pick' as const, oid: c3 as string },
                ]
              : [
                  { action: 'pick' as const, oid: c1 as string },
                  { action: 'pick' as const, oid: c2 as string },
                  { action, oid: c3 as string },
                ];

          // Act
          const result = await repo.rebase.run({ upstream: base, interactive: todo });
          await repo.dispose();

          // Assert
          expect(result.kind).toBe('rebased');
          expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
          expect(commitCount(pair.ours)).toBe(commitCount(pair.peer));
        },
      );
    });

    describe.each([
      ['reword', 'X', 'HEAD~1'],
      ['fixup', 'Y', 'HEAD'],
    ] as const)(
      'When the todo %ss %s over a commit carrying extra headers',
      (action, target, carrier) => {
        it('Then the amended commit keeps the same extra headers as git', async () => {
          // Arrange
          buildHeadered(pair.peer);
          buildHeadered(pair.ours);
          runGit(['-C', pair.peer, 'rebase', '-i', 'HEAD~2'], {
            env: {
              ...runGitEnv(),
              GIT_SEQUENCE_EDITOR: `perl -i -pe 's/^pick (.*${target} subject)/${action} $1/'`,
              GIT_EDITOR: "perl -i -pe 's/X subject/reworded/'",
            },
          });
          const x = oidAt(pair.ours, 'HEAD~1');
          const y = oidAt(pair.ours, 'HEAD');
          const repo = await openRepository({ cwd: pair.ours });
          const first =
            action === 'reword'
              ? { action, oid: x, message: 'reworded' }
              : { action: 'pick' as const, oid: x };
          const second =
            action === 'fixup' ? { action, oid: y } : { action: 'pick' as const, oid: y };

          // Act
          await repo.rebase.run({
            upstream: oidAt(pair.ours, 'HEAD~2'),
            interactive: [first, second],
          });
          await repo.dispose();

          // Assert
          expect(extraHeaderLines(pair.ours, carrier)).toBe(extraHeaderLines(pair.peer, carrier));
          expect(extraHeaderLines(pair.peer, carrier)).toContain('x-custom hello');
        });
      },
    );

    describe('When the todo drops c1 and stops to edit c2', () => {
      it('Then both name the picked commit in stopped-sha and REBASE_HEAD', async () => {
        // Arrange
        buildInteractiveLinear(pair.peer);
        buildInteractiveLinear(pair.ours);
        gitRebaseInteractive(
          pair.peer,
          's/^pick (.*c1 subject)/drop $1/; s/^pick (.*c2 subject)/edit $1/',
        );
        const base = oidAt(pair.ours, 'HEAD~3');
        const [c1, c2, c3] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => oidAt(pair.ours, r));
        // Commit on git's second, so a run straddling a second boundary still compares oids.
        const committedAt = Number(git(pair.peer, 'log', '-1', '--format=%ct', 'HEAD').trim());
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(committedAt * 1000);
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.rebase.run;

        // Act
        await sut({
          upstream: base,
          interactive: [
            { action: 'drop', oid: c1 as string },
            { action: 'edit', oid: c2 as string },
            { action: 'pick', oid: c3 as string },
          ],
        });
        await repo.dispose();
        vi.useRealTimers();

        // Assert
        const result = stopMarkers(pair.ours);
        expect(result).toBe(stopMarkers(pair.peer));
        expect(oidAt(pair.ours, 'HEAD')).toBe(oidAt(pair.peer, 'HEAD'));
      });
    });

    describe('When the rebase stops to edit c1 and is then skipped', () => {
      it('Then both keep c1 and replay the rest on top of it', async () => {
        // Arrange
        buildInteractiveLinear(pair.peer);
        buildInteractiveLinear(pair.ours);
        gitRebaseInteractive(pair.peer, 's/^pick (.*c1 subject)/edit $1/');
        git(pair.peer, 'rebase', '--skip');
        const base = oidAt(pair.ours, 'HEAD~3');
        const [c1, c2, c3] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => oidAt(pair.ours, r));
        const repo = await openRepository({ cwd: pair.ours });
        await repo.rebase.run({
          upstream: base,
          interactive: [
            { action: 'edit', oid: c1 as string },
            { action: 'pick', oid: c2 as string },
            { action: 'pick', oid: c3 as string },
          ],
        });
        const sut = repo.rebase.skip;

        // Act
        const result = await sut();
        await repo.dispose();

        // Assert
        expect(result.kind).toBe('rebased');
        expect(oidAt(pair.ours, 'main')).toBe(oidAt(pair.peer, 'main'));
        expect(commitCount(pair.ours)).toBe(commitCount(pair.peer));
      });
    });

    describe('When the edit stop has a tracked file changed but not staged', () => {
      it('Then both refuse to continue and keep the stop', async () => {
        // Arrange
        buildInteractiveLinear(pair.peer);
        buildInteractiveLinear(pair.ours);
        gitRebaseInteractive(pair.peer, 's/^pick (.*c1 subject)/edit $1/');
        const base = oidAt(pair.ours, 'HEAD~3');
        const [c1, c2, c3] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => oidAt(pair.ours, r));
        const repo = await openRepository({ cwd: pair.ours });
        await repo.rebase.run({
          upstream: base,
          interactive: [
            { action: 'edit', oid: c1 as string },
            { action: 'pick', oid: c2 as string },
            { action: 'pick', oid: c3 as string },
          ],
        });
        writeWork(pair.peer, '1.txt', 'changed\n');
        writeWork(pair.ours, '1.txt', 'changed\n');
        const sut = repo.rebase.continue;

        // Act
        const gitRun = tryRunGitWithExit(['-C', pair.peer, 'rebase', '--continue']);
        const result = await sut().catch((error: unknown) => error);
        await repo.dispose();

        // Assert
        expect(gitRun.exitCode).toBe(1);
        expect((result as TsgitError).data).toMatchObject({
          code: 'WORKING_TREE_DIRTY',
          localChanges: ['1.txt'],
        });
        expect(oidAt(pair.ours, 'HEAD')).toBe(oidAt(pair.peer, 'HEAD'));
        expect(stopMarkers(pair.ours)).toBe(stopMarkers(pair.peer));
      });
    });

    describe('When the interactive todo is an all-pick no-op', () => {
      it('Then an all-pick edit is a byte-identical no-op (HEAD oid unchanged)', async () => {
        // Arrange — both repos identical; git rebases -i with no edits
        buildInteractiveLinear(pair.peer);
        buildInteractiveLinear(pair.ours);
        const before = oidAt(pair.ours, 'HEAD');
        gitRebaseInteractive(pair.peer, 's/^x//'); // no-op edit
        const base = oidAt(pair.ours, 'HEAD~3');
        const [c1, c2, c3] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => oidAt(pair.ours, r));
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.rebase.run({
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 as string },
            { action: 'pick', oid: c2 as string },
            { action: 'pick', oid: c3 as string },
          ],
        });
        await repo.dispose();

        // Assert — HEAD unchanged on tsgit, and equal to git's (identical history)
        expect(oidAt(pair.ours, 'HEAD')).toBe(before);
        expect(oidAt(pair.ours, 'HEAD')).toBe(oidAt(pair.peer, 'HEAD'));
      });
    });
  });

  describe('Given an `edit` stop', () => {
    describe('When a tsgit-started rebase stops at `edit` and git finishes it', () => {
      it('Then a tsgit edit stop is finished by git rebase --continue', async () => {
        // Arrange — tsgit stops at `edit c2`
        const dir = pair.ours;
        buildInteractiveLinear(dir);
        const base = oidAt(dir, 'HEAD~3');
        const [c1, c2, c3] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => oidAt(dir, r));
        const repo = await openRepository({ cwd: dir });
        const stop = await repo.rebase.run({
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 as string },
            { action: 'edit', oid: c2 as string },
            { action: 'pick', oid: c3 as string },
          ],
        });
        expect(stop.kind).toBe('stopped');
        await repo.dispose();

        // Act — hand the edit stop to real git
        runGit(['-C', dir, '-c', 'core.editor=true', 'rebase', '--continue']);

        // Assert — git finished onto main with all three files
        expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
        expect(commitCount(dir)).toBe(4); // base + c1 + c2 + c3
      });
    });

    describe('When a git-started rebase stops at `edit` and tsgit finishes it', () => {
      it('Then a git edit stop is finished by repo.rebase.continue', async () => {
        // Arrange — git stops at `edit c2`
        const dir = pair.ours;
        buildInteractiveLinear(dir);
        tryRunGit(['-C', dir, 'rebase', '-i', 'HEAD~3'], {
          env: {
            ...runGitEnv(),
            GIT_SEQUENCE_EDITOR: "perl -i -pe 's/^pick (.*c2 subject)/edit $1/'",
            GIT_EDITOR: 'true',
          },
        });
        const repo = await openRepository({ cwd: dir });

        // Act — tsgit reads git's `amend` state and finishes
        const done = await repo.rebase.continue();
        await repo.dispose();

        // Assert
        expect(done.kind).toBe('rebased');
        expect(commitCount(dir)).toBe(4);
      });
    });
  });

  describe('Given a topic whose conflicting commit is followed by a commit main already has', () => {
    /** base f; main U sets f and adds g; topic W sets f, E adds g as main does, Y adds h. HEAD on topic. */
    const buildEmptiedTopic = (dir: string): void => {
      runGit(['init', '-q', '-b', 'main', dir]);
      configGit(dir);
      writeWork(dir, 'f.txt', 'base\n');
      git(dir, 'add', 'f.txt');
      gitCommit(dir, 'base');
      git(dir, 'checkout', '-q', '-b', 'topic');
      for (const [rel, body, title] of [
        ['f.txt', 'TOPIC\n', 'W'],
        ['g.txt', 'g\n', 'E'],
        ['h.txt', 'h\n', 'Y'],
      ] as const) {
        writeWork(dir, rel, body);
        git(dir, 'add', rel);
        gitCommit(dir, title);
      }
      git(dir, 'checkout', '-q', 'main');
      writeWork(dir, 'f.txt', 'MAIN\n');
      writeWork(dir, 'g.txt', 'g\n');
      git(dir, 'add', 'f.txt', 'g.txt');
      gitCommit(dir, 'U');
      git(dir, 'checkout', '-q', 'topic');
    };
    const listing = (dir: string): ReadonlyArray<string> =>
      readdirSync(path.join(dir, '.git', 'rebase-merge')).sort();
    const POLICY = 'drop_redundant_commits';
    const resolveF = (dir: string): void => {
      writeWork(dir, 'f.txt', 'RESOLVED\n');
      git(dir, 'add', 'f.txt');
    };
    const gitContinue = (dir: string) =>
      tryRunGitWithExit(['-C', dir, '-c', 'core.editor=true', 'rebase', '--continue'], {
        env: runGitEnv(),
      });
    const startGit = (dir: string, interactive: boolean, editW = false): void => {
      tryRunGit(['-C', dir, 'rebase', ...(interactive ? ['-i'] : []), 'main'], {
        env: {
          ...runGitEnv(),
          GIT_SEQUENCE_EDITOR: editW ? "perl -i -pe 's/^pick (.* W)$/edit $1/'" : 'true',
          GIT_EDITOR: 'true',
        },
      });
    };
    const startTsgit = async (dir: string, interactive: boolean, editW = false): Promise<void> => {
      const [w, e, y] = ['topic~2', 'topic~1', 'topic'].map((r) => oidAt(dir, r));
      const repo = await openRepository({ cwd: dir });
      await repo.rebase.run({
        upstream: 'main',
        ...(interactive
          ? {
              interactive: [
                { action: editW ? 'edit' : 'pick', oid: w as string },
                { action: 'pick', oid: e as string },
                { action: 'pick', oid: y as string },
              ] as const,
            }
          : {}),
      });
      await repo.dispose();
    };
    const subjectsOf = (dir: string): string => git(dir, 'log', '--format=%s', 'HEAD').trim();

    describe('When a flat rebase stops on the conflict', () => {
      it('Then tsgit writes the files git does, the policy file included and no rewritten-list', async () => {
        // Arrange
        buildEmptiedTopic(pair.peer);
        buildEmptiedTopic(pair.ours);
        startGit(pair.peer, false);

        // Act
        await startTsgit(pair.ours, false);

        // Assert
        expect(listing(pair.peer)).toContain(POLICY);
        expect(listing(pair.peer)).not.toContain('rewritten-list');
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
      });

      it('Then git continuing the tsgit stop drops the emptied commit, as it does its own', async () => {
        // Arrange
        buildEmptiedTopic(pair.peer);
        buildEmptiedTopic(pair.ours);
        startGit(pair.peer, false);
        await startTsgit(pair.ours, false);
        resolveF(pair.peer);
        resolveF(pair.ours);

        // Act
        const ours = gitContinue(pair.ours);
        const peer = gitContinue(pair.peer);

        // Assert
        expect([ours.exitCode, subjectsOf(pair.ours)]).toEqual([0, 'Y\nW\nU\nbase']);
        expect([peer.exitCode, subjectsOf(pair.peer)]).toEqual([0, 'Y\nW\nU\nbase']);
      });
    });

    describe('When an interactive rebase stops on the conflict', () => {
      it('Then tsgit writes the files git does, with neither policy file nor rewritten-list', async () => {
        // Arrange
        buildEmptiedTopic(pair.peer);
        buildEmptiedTopic(pair.ours);
        startGit(pair.peer, true);

        // Act
        await startTsgit(pair.ours, true);

        // Assert
        expect(listing(pair.peer)).not.toContain(POLICY);
        expect(listing(pair.peer)).not.toContain('rewritten-list');
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
      });

      it('Then git continuing the tsgit stop stops on the emptied commit, as it does its own', async () => {
        // Arrange
        buildEmptiedTopic(pair.peer);
        buildEmptiedTopic(pair.ours);
        startGit(pair.peer, true);
        await startTsgit(pair.ours, true);
        resolveF(pair.peer);
        resolveF(pair.ours);

        // Act
        const ours = gitContinue(pair.ours);
        const peer = gitContinue(pair.peer);

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours.exitCode).toBe(1);
        expect(
          readFileSync(path.join(pair.ours, '.git', 'rebase-merge', 'stopped-sha'), 'utf8'),
        ).toBe(readFileSync(path.join(pair.peer, '.git', 'rebase-merge', 'stopped-sha'), 'utf8'));
      });

      it('Then git reads the policy file back: with it the emptied commit is dropped', async () => {
        // Arrange
        buildEmptiedTopic(pair.ours);
        await startTsgit(pair.ours, true);
        resolveF(pair.ours);
        writeFileSync(path.join(pair.ours, '.git', 'rebase-merge', POLICY), '');

        // Act
        const result = gitContinue(pair.ours);

        // Assert
        expect([result.exitCode, subjectsOf(pair.ours)]).toEqual([0, 'Y\nW\nU\nbase']);
      });
    });

    describe('When an interactive rebase stops at `edit` on the first commit and is continued', () => {
      it('Then the stop has no policy file and the continue stops on the emptied commit, as git', async () => {
        // Arrange
        buildEmptiedTopic(pair.peer);
        buildEmptiedTopic(pair.ours);
        startGit(pair.peer, true, true);
        await startTsgit(pair.ours, true, true);
        for (const dir of [pair.peer, pair.ours]) {
          resolveF(dir);
          runGit(['-C', dir, 'commit', '-q', '-a', '--amend', '--no-edit']);
        }

        // Act
        const ours = gitContinue(pair.ours);
        const peer = gitContinue(pair.peer);

        // Assert
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        expect([ours.exitCode, peer.exitCode]).toEqual([1, 1]);
      });
    });
  });

  describe('Given a topic whose second commit conflicts with main', () => {
    /** base f; topic c1 adds a, c2 sets f, c3 adds c; main sets f. HEAD on topic. */
    const buildConflictingTopic = (dir: string): void => {
      runGit(['init', '-q', '-b', 'main', dir]);
      configGit(dir);
      writeWork(dir, 'f.txt', 'base\n');
      git(dir, 'add', 'f.txt');
      gitCommit(dir, 'base');
      git(dir, 'checkout', '-q', '-b', 'topic');
      for (const [rel, body, title] of [
        ['a.txt', 'a\n', 'c1'],
        ['f.txt', 'TOPIC\n', 'c2'],
        ['c.txt', 'c\n', 'c3'],
      ] as const) {
        writeWork(dir, rel, body);
        git(dir, 'add', rel);
        gitCommit(dir, title);
      }
      git(dir, 'checkout', '-q', 'main');
      writeWork(dir, 'f.txt', 'MAIN\n');
      git(dir, 'add', 'f.txt');
      gitCommit(dir, 'main');
      git(dir, 'checkout', '-q', 'topic');
    };
    const MARKERS = ['amend', 'current-fixups', 'rewritten-pending', 'message-squash'];
    const markersOf = (dir: string): ReadonlyArray<string> =>
      MARKERS.filter((name) => existsSync(path.join(dir, '.git', 'rebase-merge', name)));
    const gitRebaseOntoMain = (dir: string, perlTodo: string): void => {
      tryRunGit(['-C', dir, 'rebase', '-i', 'main'], {
        env: {
          ...runGitEnv(),
          GIT_SEQUENCE_EDITOR: `perl -i -pe '${perlTodo}'`,
          GIT_EDITOR: 'true',
        },
      });
    };
    const runTodo = async (dir: string, verbs: readonly [string, string]): Promise<void> => {
      const [c1, c2, c3] = ['topic~2', 'topic~1', 'topic'].map((r) => oidAt(dir, r) as string);
      const repo = await openRepository({ cwd: dir });
      await repo.rebase.run({
        upstream: 'main',
        interactive: [
          { action: verbs[0] as 'edit', oid: c1 as string },
          { action: verbs[1] as 'pick', oid: c2 as string },
          { action: 'pick', oid: c3 as string },
        ],
      });
      await repo.dispose();
    };
    const resolveF = (dir: string): void => {
      writeWork(dir, 'f.txt', 'RESOLVED\n');
      git(dir, 'add', 'f.txt');
    };
    const subjects = (dir: string): string => git(dir, 'log', '--format=%s', 'HEAD');

    describe('When `edit c1, pick c2` stops on c2 and is continued', () => {
      it('Then the stop carries no stale amend and c2 stays its own commit, as git', async () => {
        // Arrange
        buildConflictingTopic(pair.peer);
        buildConflictingTopic(pair.ours);
        gitRebaseOntoMain(pair.peer, 's/^pick (.* c1)$/edit $1/');
        tryRunGit(['-C', pair.peer, '-c', 'core.editor=true', 'rebase', '--continue']);
        await runTodo(pair.ours, ['edit', 'pick']);
        const repo = await openRepository({ cwd: pair.ours });
        await repo.rebase.continue();
        const sut = repo.rebase;

        // Act
        const ourMarkers = markersOf(pair.ours);
        resolveF(pair.ours);
        resolveF(pair.peer);
        const result = await sut.continue();
        await repo.dispose();

        // Assert
        expect(ourMarkers).toEqual(markersOf(pair.peer));
        runGit(['-C', pair.peer, '-c', 'core.editor=true', 'rebase', '--continue']);
        expect(result.kind).toBe('rebased');
        expect(subjects(pair.ours)).toBe(subjects(pair.peer));
      });
    });

    describe('When `pick c1, squash c2` stops on the squash', () => {
      it('Then the stop writes the same markers as git, amend included', async () => {
        // Arrange
        buildConflictingTopic(pair.peer);
        buildConflictingTopic(pair.ours);
        gitRebaseOntoMain(pair.peer, 's/^pick (.* c2)$/squash $1/');
        const sut = runTodo;

        // Act
        await sut(pair.ours, ['pick', 'squash']);

        // Assert
        expect(markersOf(pair.ours)).toEqual(markersOf(pair.peer));
        const amendOf = (dir: string) =>
          readFileSync(path.join(dir, '.git', 'rebase-merge', 'amend'), 'utf8');
        expect(amendOf(pair.ours)).toBe(`${oidAt(pair.ours, 'HEAD')}\n`);
        expect(amendOf(pair.peer)).toBe(`${oidAt(pair.peer, 'HEAD')}\n`);
      });
    });
  });

  describe.each(['fixup', 'squash'])(
    'Given a %s that conflicts, amended into its group by hand',
    (verb) => {
      /** base f=L; topic t1 adds a, t2 sets f, t3 adds c; main sets f too. Stops on t2. */
      const stopOnGroup = (dir: string): void => {
        runGit(['init', '-q', '-b', 'main', dir]);
        configGit(dir);
        writeWork(dir, 'f.txt', 'L\n');
        git(dir, 'add', 'f.txt');
        gitCommit(dir, 'base');
        git(dir, 'checkout', '-q', '-b', 'topic');
        for (const [rel, body, title] of [
          ['a.txt', 'a\n', 't1 subject'],
          ['f.txt', 'TOPIC\n', 't2 subject'],
          ['c.txt', 'c\n', 't3 subject'],
        ] as const) {
          writeWork(dir, rel, body);
          git(dir, 'add', rel);
          gitCommit(dir, title);
        }
        git(dir, 'checkout', '-q', 'main');
        writeWork(dir, 'f.txt', 'MAIN\n');
        git(dir, 'add', 'f.txt');
        gitCommit(dir, 'm1');
        git(dir, 'checkout', '-q', 'topic');
        tryRunGit(['-C', dir, 'rebase', '-i', 'main'], {
          env: {
            ...runGitEnv(),
            GIT_SEQUENCE_EDITOR: `perl -i -pe 's/^pick (.*t2 subject)/${verb} $1/'`,
            GIT_EDITOR: 'true',
          },
        });
        writeWork(dir, 'f.txt', 'RESOLVED\n');
        git(dir, 'add', 'f.txt');
        git(dir, 'reset', '-q', '--soft', 'HEAD~1');
        gitCommit(dir, 't1 by hand');
      };

      describe('When git and tsgit each continue it', () => {
        it('Then both keep the hand-made commit and replay the rest alike', async () => {
          // Arrange
          stopOnGroup(pair.peer);
          stopOnGroup(pair.ours);
          runGit(['-C', pair.peer, '-c', 'core.editor=true', 'rebase', '--continue']);
          const repo = await openRepository({ cwd: pair.ours });
          const sut = repo.rebase;

          // Act
          const result = await sut.continue();
          await repo.dispose();

          // Assert
          expect(result.kind).toBe('rebased');
          expect(oidAt(pair.ours, 'HEAD~1')).toBe(oidAt(pair.peer, 'HEAD~1'));
          expect(oidAt(pair.ours, 'HEAD^{tree}')).toBe(oidAt(pair.peer, 'HEAD^{tree}'));
          const headMessage = (dir: string) => git(dir, 'log', '-1', '--format=%B', 'HEAD');
          expect(headMessage(pair.ours)).toBe(headMessage(pair.peer));
        });
      });
    },
  );

  describe('Given a fixup group whose members two untracked occupants refuse in turn', () => {
    const HOOK_OUT = 'post-rewrite.out';
    const MEMBERS = ['b', 'c', 'd'] as const;

    /** base(keep); u: U; main: A (with a body), then b, c, d each adding its file, then E deleting c and d. */
    const buildGroup = (dir: string): void => {
      runGit(['init', '-q', '-b', 'main', dir]);
      configGit(dir);
      writeWork(dir, 'keep', 'keep\n');
      git(dir, 'add', 'keep');
      gitCommit(dir, 'base');
      git(dir, 'checkout', '-q', '-b', 'u');
      writeWork(dir, 'uu', 'u\n');
      git(dir, 'add', 'uu');
      gitCommit(dir, 'U');
      git(dir, 'checkout', '-q', 'main');
      for (const name of ['a', ...MEMBERS]) {
        writeWork(dir, name, `${name}\n`);
        git(dir, 'add', name);
        gitCommit(dir, `${name} subject\n\n${name} body`);
      }
      git(dir, 'rm', '-q', 'c', 'd');
      gitCommit(dir, 'E');
      const hook = path.join(dir, '.git', 'hooks', 'post-rewrite');
      writeFileSync(
        hook,
        `#!/bin/sh\n[ "$1" = rebase ] && cat >> "$(git rev-parse --git-dir)/${HOOK_OUT}"\n`,
        {
          mode: 0o755,
        },
      );
      for (const name of ['c', 'd']) writeWork(dir, name, 'occupant\n');
    };

    const gitRebaseIFixups = (dir: string) => {
      const edit = MEMBERS.map((name) => `s/^pick (\\S+ # ${name} subject)$/fixup $1/`).join(';');
      return tryRunGitWithExit(['-C', dir, '-c', 'core.editor=true', 'rebase', '-i', 'u'], {
        env: {
          ...runGitEnv(),
          GIT_AUTHOR_DATE: FIXED_DATE,
          GIT_COMMITTER_DATE: FIXED_DATE,
          GIT_SEQUENCE_EDITOR: `perl -i -pe '${edit}'`,
          GIT_EDITOR: 'true',
        },
      });
    };

    const gitRebaseStep = (dir: string, step: '--continue' | '--skip') =>
      tryRunGitWithExit(['-C', dir, '-c', 'core.editor=true', 'rebase', step], {
        env: {
          ...runGitEnv(),
          GIT_AUTHOR_DATE: FIXED_DATE,
          GIT_COMMITTER_DATE: FIXED_DATE,
          GIT_EDITOR: 'true',
        },
      });

    const tsgitStep = async (
      dir: string,
      step: (repo: Awaited<ReturnType<typeof openRepository>>) => Promise<unknown>,
    ): Promise<void> => {
      const repo = await openRepository({ cwd: dir });
      try {
        await step(repo);
      } catch (err) {
        if ((err as TsgitError).data?.code !== 'WORKING_TREE_DIRTY') throw err;
      } finally {
        await repo.dispose();
      }
    };

    /** The post-rewrite mapping with each created commit named by the order it first appears in. */
    const rewriteGroups = (dir: string): ReadonlyArray<string> => {
      const lines = readFileSync(path.join(dir, '.git', HOOK_OUT), 'utf8')
        .trim()
        .split('\n');
      const created = [...new Set(lines.map((line) => line.split(' ')[1]))];
      return lines.map((line) => {
        const [source, target] = line.split(' ');
        return `${source} -> ${created.indexOf(target as string)}`;
      });
    };

    const startBoth = async (): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) buildGroup(dir);
      gitRebaseIFixups(pair.peer);
      await tsgitStep(pair.ours, (repo) =>
        repo.rebase.run({
          upstream: 'u',
          interactive: ['a', ...MEMBERS, 'E'].map((_name, i) => ({
            action: i >= 1 && i <= 3 ? ('fixup' as const) : ('pick' as const),
            oid: oidAt(pair.ours, `main~${4 - i}`),
          })),
        }),
      );
      for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'c'));
      gitRebaseStep(pair.peer, '--continue');
      await tsgitStep(pair.ours, (repo) => repo.rebase.continue());
      for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'd'));
    };

    it('Then the reopened group leaves the message-fixup bytes git leaves', async () => {
      // Arrange / Act
      await startBoth();

      // Assert
      const stateFile = (dir: string): string =>
        readFileSync(path.join(dir, '.git', 'rebase-merge', 'message-fixup'), 'utf8');
      expect(stateFile(pair.ours)).toBe(stateFile(pair.peer));
    });

    it('Then continuing maps every member to the final group commit, as git does', async () => {
      // Arrange
      await startBoth();

      // Act
      const peer = gitRebaseStep(pair.peer, '--continue');
      await tsgitStep(pair.ours, (repo) => repo.rebase.continue());

      // Assert
      expect(peer.exitCode).toBe(0);
      expect(rewriteGroups(pair.ours)).toEqual(rewriteGroups(pair.peer));
      expect(oidAt(pair.ours, 'main^{tree}')).toBe(oidAt(pair.peer, 'main^{tree}'));
    });

    it('Then skipping maps every member to the kept group commit, as git does', async () => {
      // Arrange
      await startBoth();

      // Act
      const peer = gitRebaseStep(pair.peer, '--skip');
      await tsgitStep(pair.ours, (repo) => repo.rebase.skip());

      // Assert
      expect(peer.exitCode).toBe(0);
      expect(rewriteGroups(pair.ours)).toEqual(rewriteGroups(pair.peer));
      expect(oidAt(pair.ours, 'main^{tree}')).toBe(oidAt(pair.peer, 'main^{tree}'));
    });
  });

  describe('Given a flat rebase line refused by an untracked occupant', () => {
    const REBASE_FILES = [
      'done',
      'git-rebase-todo',
      'end',
      'msgnum',
      'author-script',
      'rewritten-list',
    ] as const;
    const XAVIER_ENV = { GIT_AUTHOR_DATE: '1700000500 +0000' };
    const commitAs = (dir: string, title: string, env: NodeJS.ProcessEnv = {}): void => {
      runGit(['-C', dir, 'commit', '-q', '-m', title, '--author', 'Xavier <xavier@y>'], {
        env: {
          ...runGitEnv(),
          GIT_AUTHOR_DATE: FIXED_DATE,
          GIT_COMMITTER_DATE: FIXED_DATE,
          ...env,
        },
      });
    };

    /** base(keep); u: U; main: W, X (adds n, by Xavier), Z (deletes n). `conflict` makes W and U both set keep. */
    const buildOccupied = (dir: string, conflict: boolean): void => {
      runGit(['init', '-q', '-b', 'main', dir]);
      configGit(dir);
      writeWork(dir, 'keep', 'keep\n');
      git(dir, 'add', 'keep');
      gitCommit(dir, 'base');
      git(dir, 'checkout', '-q', '-b', 'u');
      writeWork(dir, conflict ? 'keep' : 'uu', 'u\n');
      git(dir, 'add', '.');
      gitCommit(dir, 'U');
      git(dir, 'checkout', '-q', 'main');
      writeWork(dir, conflict ? 'keep' : 'w', 'w\n');
      git(dir, 'add', '.');
      gitCommit(dir, 'W');
      writeWork(dir, 'n', 'n\n');
      git(dir, 'add', 'n');
      commitAs(dir, 'X', XAVIER_ENV);
      git(dir, 'rm', '-q', 'n');
      gitCommit(dir, 'Z');
    };

    const plantOccupant = (dir: string): void => writeWork(dir, 'n', 'occ\n');

    const snapshot = (dir: string): ReadonlyArray<unknown> => {
      const head = oidAt(dir, 'HEAD');
      const state = path.join(dir, '.git', 'rebase-merge');
      const read = (file: string): string | undefined =>
        existsSync(file) ? readFileSync(file, 'utf8').replaceAll(head, '<HEAD>') : undefined;
      return [
        head === oidAt(dir, 'main') ? 'main' : 'moved',
        existsSync(state) ? readdirSync(state).sort() : undefined,
        ...REBASE_FILES.map((name) => read(path.join(state, name))),
        read(path.join(dir, '.git', 'REBASE_HEAD')),
        readFileSync(path.join(dir, 'n'), 'utf8'),
        git(dir, 'ls-files', '--stage'),
      ];
    };

    const gitRebase = (dir: string, ...args: ReadonlyArray<string>) =>
      tryRunGitWithExit(['-C', dir, '-c', 'core.editor=true', 'rebase', ...args], {
        env: {
          ...runGitEnv(),
          GIT_AUTHOR_DATE: FIXED_DATE,
          GIT_COMMITTER_DATE: FIXED_DATE,
        },
      });

    const tsgitRebase = async (
      dir: string,
      step: (repo: Awaited<ReturnType<typeof openRepository>>) => Promise<unknown>,
    ): Promise<unknown> => {
      const repo = await openRepository({ cwd: dir });
      try {
        await step(repo);
        return 'ok';
      } catch (err) {
        return (err as TsgitError).data;
      } finally {
        await repo.dispose();
      }
    };

    const REFUSED = { code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['n'] };

    describe('When the refused line is the second pick of a start', () => {
      it('Then tsgit leaves the state git leaves', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          buildOccupied(dir, false);
          plantOccupant(dir);
        }

        // Act
        const peer = gitRebase(pair.peer, 'u');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.run({ upstream: 'u' }));

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual(REFUSED);
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
      });

      it('Then the retry with the occupant kept leaves the state git leaves', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          buildOccupied(dir, false);
          plantOccupant(dir);
        }
        gitRebase(pair.peer, 'u');
        await tsgitRebase(pair.ours, (repo) => repo.rebase.run({ upstream: 'u' }));

        // Act
        const peer = gitRebase(pair.peer, '--continue');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual(REFUSED);
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
      });

      it('Then continuing once the occupant is gone finishes on the same history', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          buildOccupied(dir, false);
          plantOccupant(dir);
        }
        gitRebase(pair.peer, 'u');
        await tsgitRebase(pair.ours, (repo) => repo.rebase.run({ upstream: 'u' }));
        for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'n'));

        // Act
        const peer = gitRebase(pair.peer, '--continue');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

        // Assert
        expect(peer.exitCode).toBe(0);
        expect(ours).toBe('ok');
        const subjects = (dir: string): string => git(dir, 'log', '--format=%s', 'main').trim();
        expect(subjects(pair.ours)).toBe(subjects(pair.peer));
        expect(oidAt(pair.ours, 'main^{tree}')).toBe(oidAt(pair.peer, 'main^{tree}'));
      });

      it('Then skipping once the occupant is gone finishes on the same history', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          buildOccupied(dir, false);
          plantOccupant(dir);
        }
        gitRebase(pair.peer, 'u');
        await tsgitRebase(pair.ours, (repo) => repo.rebase.run({ upstream: 'u' }));
        for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'n'));

        // Act
        const peer = gitRebase(pair.peer, '--skip');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.skip());

        // Assert
        expect(peer.exitCode).toBe(0);
        expect(ours).toBe('ok');
        expect(oidAt(pair.ours, 'main^{tree}')).toBe(oidAt(pair.peer, 'main^{tree}'));
      });
    });

    describe('When the refused line follows a resolved conflict', () => {
      it('Then tsgit leaves the state git leaves and none of the conflict stop', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) buildOccupied(dir, true);
        gitRebase(pair.peer, 'u');
        await tsgitRebase(pair.ours, (repo) => repo.rebase.run({ upstream: 'u' }));
        for (const dir of [pair.peer, pair.ours]) {
          writeWork(dir, 'keep', 'resolved\n');
          git(dir, 'add', 'keep');
          plantOccupant(dir);
        }

        // Act
        const peer = gitRebase(pair.peer, '--continue');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual(REFUSED);
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
      });

      it('Then skipping once the occupant is gone finishes on the same history', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) buildOccupied(dir, true);
        gitRebase(pair.peer, 'u');
        await tsgitRebase(pair.ours, (repo) => repo.rebase.run({ upstream: 'u' }));
        for (const dir of [pair.peer, pair.ours]) {
          writeWork(dir, 'keep', 'resolved\n');
          git(dir, 'add', 'keep');
          plantOccupant(dir);
        }
        gitRebase(pair.peer, '--continue');
        await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());
        for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'n'));

        // Act
        const peer = gitRebase(pair.peer, '--skip');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.skip());

        // Assert
        expect(peer.exitCode).toBe(0);
        expect(ours).toBe('ok');
        const subjects = (dir: string): string => git(dir, 'log', '--format=%s', 'main').trim();
        expect(subjects(pair.ours)).toBe(subjects(pair.peer));
        expect(oidAt(pair.ours, 'main^{tree}')).toBe(oidAt(pair.peer, 'main^{tree}'));
      });
    });

    describe('When a fast-forward pick is the refused line', () => {
      it('Then HEAD stays and the dropped pick is recorded as git records it', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          buildOccupied(dir, false);
          plantOccupant(dir);
        }
        const [base, w] = ['main~3', 'main~2'].map((rev) => oidAt(pair.ours, rev)) as [
          string,
          string,
        ];

        // Act
        const peer = gitRebase(pair.peer, '--onto', w, base);
        const ours = await tsgitRebase(pair.ours, (repo) =>
          repo.rebase.run({ upstream: base, onto: w }),
        );

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual(REFUSED);
        expect(oidAt(pair.ours, 'HEAD')).toBe(w);
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
      });
    });

    describe('When the refused line is interactive', () => {
      type Verb = 'pick' | 'edit' | 'reword' | 'squash' | 'fixup';
      const TITLES = ['W', 'X', 'Z'] as const;

      const gitRebaseI = (dir: string, upstream: string, verbs: ReadonlyArray<Verb>) => {
        const edit = TITLES.map((title, i) => `s/^pick (\\S+ # ${title})$/${verbs[i]} $1/`).join(
          ';',
        );
        return tryRunGitWithExit(['-C', dir, '-c', 'core.editor=true', 'rebase', '-i', upstream], {
          env: {
            ...runGitEnv(),
            GIT_AUTHOR_DATE: FIXED_DATE,
            GIT_COMMITTER_DATE: FIXED_DATE,
            GIT_SEQUENCE_EDITOR: `perl -i -pe '${edit}'`,
            GIT_EDITOR: 'true',
          },
        });
      };

      const tsgitRebaseI = (dir: string, upstream: string, verbs: ReadonlyArray<Verb>) =>
        tsgitRebase(dir, (repo) =>
          repo.rebase.run({
            upstream,
            interactive: verbs.map((action, i) => {
              const oid = oidAt(dir, `main~${2 - i}`);
              return action === 'reword' ? { action, oid, message: 'X' } : { action, oid };
            }),
          }),
        );

      /** Both tools stopped on `edit W`, the occupant planted, `--continue` refused. */
      const refusedAfterEditStop = async (): Promise<void> => {
        for (const dir of [pair.peer, pair.ours]) buildOccupied(dir, false);
        gitRebaseI(pair.peer, 'u', ['edit', 'pick', 'pick']);
        await tsgitRebaseI(pair.ours, 'u', ['edit', 'pick', 'pick']);
        for (const dir of [pair.peer, pair.ours]) plantOccupant(dir);
        gitRebase(pair.peer, '--continue');
        await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());
      };

      it.each(['pick', 'edit', 'reword', 'squash', 'fixup'] as const)(
        'Then a refused %s line at the start leaves the state git leaves',
        async (verb) => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            buildOccupied(dir, false);
            plantOccupant(dir);
          }
          const verbs = ['pick', verb, 'pick'] as const;

          // Act
          const peer = gitRebaseI(pair.peer, 'u', verbs);
          const ours = await tsgitRebaseI(pair.ours, 'u', verbs);

          // Assert
          expect(peer.exitCode).toBe(1);
          expect(ours).toEqual(REFUSED);
          expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
        },
      );

      it.each(['squash', 'fixup'] as const)(
        'Then %s refused again by the kept occupant leaves the state git leaves',
        async (verb) => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            buildOccupied(dir, false);
            plantOccupant(dir);
          }
          const verbs = ['pick', verb, 'pick'] as const;
          gitRebaseI(pair.peer, 'u', verbs);
          await tsgitRebaseI(pair.ours, 'u', verbs);

          // Act
          const peer = gitRebase(pair.peer, '--continue');
          const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

          // Assert
          expect(peer.exitCode).toBe(1);
          expect(ours).toEqual(REFUSED);
          expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
        },
      );

      it.each(['squash', 'fixup'] as const)(
        'Then a refused %s member reopens its group once the occupant is gone',
        async (verb) => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            buildOccupied(dir, false);
            plantOccupant(dir);
          }
          const verbs = ['pick', verb, 'pick'] as const;
          gitRebaseI(pair.peer, 'u', verbs);
          await tsgitRebaseI(pair.ours, 'u', verbs);
          for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'n'));

          // Act
          const peer = gitRebase(pair.peer, '--continue');
          const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

          // Assert
          expect(peer.exitCode).toBe(0);
          expect(ours).toBe('ok');
          const history = (dir: string): string => git(dir, 'log', '--format=%an|%B', 'main');
          expect(history(pair.ours)).toBe(history(pair.peer));
          expect(oidAt(pair.ours, 'main^{tree}')).toBe(oidAt(pair.peer, 'main^{tree}'));
        },
      );

      it('Then an edit stop continued into the occupant leaves the state git leaves', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) buildOccupied(dir, false);
        gitRebaseI(pair.peer, 'u', ['edit', 'pick', 'pick']);
        await tsgitRebaseI(pair.ours, 'u', ['edit', 'pick', 'pick']);
        for (const dir of [pair.peer, pair.ours]) plantOccupant(dir);

        // Act
        const peer = gitRebase(pair.peer, '--continue');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual(REFUSED);
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
      });

      it.each(['--continue', '--skip'] as const)(
        'Then %s with the occupant kept leaves the state git leaves',
        async (flag) => {
          // Arrange
          await refusedAfterEditStop();

          // Act
          const peer = gitRebase(pair.peer, flag);
          const ours = await tsgitRebase(pair.ours, (repo) =>
            flag === '--skip' ? repo.rebase.skip() : repo.rebase.continue(),
          );

          // Assert
          expect(peer.exitCode).toBe(1);
          expect(ours).toEqual(REFUSED);
          expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
        },
      );

      it.each(['--continue', '--skip'] as const)(
        'Then %s once the occupant is gone finishes on the same history',
        async (flag) => {
          // Arrange
          await refusedAfterEditStop();
          for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'n'));

          // Act
          const peer = gitRebase(pair.peer, flag);
          const ours = await tsgitRebase(pair.ours, (repo) =>
            flag === '--skip' ? repo.rebase.skip() : repo.rebase.continue(),
          );

          // Assert
          expect(peer.exitCode).toBe(0);
          expect(ours).toBe('ok');
          const subjects = (dir: string): string => git(dir, 'log', '--format=%s', 'main').trim();
          expect(subjects(pair.ours)).toBe(subjects(pair.peer));
          expect(oidAt(pair.ours, 'main^{tree}')).toBe(oidAt(pair.peer, 'main^{tree}'));
        },
      );

      it('Then a staged change still refuses the retry and end is re-counted', async () => {
        // Arrange
        await refusedAfterEditStop();
        for (const dir of [pair.peer, pair.ours]) {
          rmSync(path.join(dir, 'n'));
          writeWork(dir, 'z', 'z\n');
          git(dir, 'add', 'z');
        }

        // Act
        const peer = gitRebase(pair.peer, '--continue');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: ['z'], untracked: [] });
        const end = (dir: string): string =>
          readFileSync(path.join(dir, '.git', 'rebase-merge', 'end'), 'utf8');
        expect(end(pair.ours)).toBe(end(pair.peer));
      });

      it('Then a fast-forwarded edit followed by an occupied pick leaves the state git leaves', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) buildOccupied(dir, false);
        const base = oidAt(pair.ours, 'main~3');
        gitRebaseI(pair.peer, base, ['edit', 'pick', 'pick']);
        await tsgitRebaseI(pair.ours, base, ['edit', 'pick', 'pick']);
        for (const dir of [pair.peer, pair.ours]) plantOccupant(dir);

        // Act
        const peer = gitRebase(pair.peer, '--continue');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual(REFUSED);
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
      });

      describe.each([
        {
          title: 'a directory would replace a removed tracked file',
          gitClass: /would lose untracked files/,
          prepare: (dir: string): void => {
            git(dir, 'rm', '-q', 'keep');
            mkdirSync(path.join(dir, 'keep'));
            writeWork(dir, 'keep/u', 'u\n');
          },
        },
        {
          title: 'an untracked file stands where an unstaged tracked file was',
          gitClass: /untracked working tree files would be overwritten/,
          prepare: (dir: string): void => {
            git(dir, 'rm', '-q', '--cached', 'keep');
            writeWork(dir, 'keep', 'occ\n');
          },
        },
      ])('the skip of a rescheduled pick meets $title', ({ gitClass, prepare }) => {
        it('Then it refuses as git does and keeps the state', async () => {
          // Arrange
          await refusedAfterEditStop();
          for (const dir of [pair.peer, pair.ours]) {
            rmSync(path.join(dir, 'n'));
            prepare(dir);
          }
          const stateOf = (dir: string): ReadonlyArray<unknown> => [
            readdirSync(path.join(dir, '.git', 'rebase-merge')).sort(),
            readFileSync(path.join(dir, '.git', 'rebase-merge', 'done'), 'utf8'),
            git(dir, 'ls-files', '--stage'),
          ];

          // Act
          const peer = gitRebase(pair.peer, '--skip');
          const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.skip());

          // Assert
          expect(peer.exitCode).toBe(128);
          expect(peer.stderr).toMatch(gitClass);
          expect(outcomeOfGitStderr(peer.stderr)).toEqual({
            refused: true,
            localChanges: [],
            untracked: ['keep'],
          });
          expect(ours).toEqual({
            code: 'WORKING_TREE_DIRTY',
            localChanges: [],
            untracked: ['keep'],
          });
          expect(stateOf(pair.ours)).toEqual(stateOf(pair.peer));
        });
      });

      it('Then a refusal at a later line after a successful retry leaves the state git leaves', async () => {
        // Arrange
        const buildLater = (dir: string): void => {
          runGit(['init', '-q', '-b', 'main', dir]);
          configGit(dir);
          for (const [file, title] of [
            ['keep', 'base'],
            ['uu', 'U'],
          ] as const) {
            if (title === 'U') git(dir, 'checkout', '-q', '-b', 'u');
            writeWork(dir, file, `${file}\n`);
            git(dir, 'add', file);
            gitCommit(dir, title);
          }
          git(dir, 'checkout', '-q', 'main');
          for (const [file, title] of [
            ['w', 'W'],
            ['x', 'X'],
            ['n', 'Z'],
          ] as const) {
            writeWork(dir, file, `${file}\n`);
            git(dir, 'add', file);
            gitCommit(dir, title);
          }
        };
        for (const dir of [pair.peer, pair.ours]) buildLater(dir);
        gitRebaseI(pair.peer, 'u', ['edit', 'pick', 'pick']);
        await tsgitRebaseI(pair.ours, 'u', ['edit', 'pick', 'pick']);
        for (const dir of [pair.peer, pair.ours]) plantOccupant(dir);

        // Act
        const peer = gitRebase(pair.peer, '--continue');
        const ours = await tsgitRebase(pair.ours, (repo) => repo.rebase.continue());

        // Assert
        expect(peer.exitCode).toBe(1);
        expect(ours).toEqual(REFUSED);
        // tsgit's committer date differs from git's pinned one, so rewritten commits differ in oid.
        const unnamed = (dir: string): string =>
          JSON.stringify(snapshot(dir)).replace(/([0-9a-f]{40}) [0-9a-f]{40}/g, '$1 <rewritten>');
        expect(unnamed(pair.ours)).toEqual(unnamed(pair.peer));
        for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'n'));
        expect(gitRebase(pair.peer, '--continue').exitCode).toBe(0);
        expect(await tsgitRebase(pair.ours, (repo) => repo.rebase.continue())).toBe('ok');
        const subjects = (dir: string): string => git(dir, 'log', '--format=%s', 'main').trim();
        expect(subjects(pair.ours)).toBe(subjects(pair.peer));
      });
    });
  });
});

/** main: a-b-c-d; `side` at b; `feat` off `side` adds f and tracks main. HEAD left on feat. */
function buildRevisionSides(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  for (const name of ['a', 'b', 'c', 'd']) commitFileNamed(dir, name);
  git(dir, 'branch', 'side', 'HEAD~2');
  git(dir, 'checkout', '-q', '-b', 'feat', 'side');
  commitFileNamed(dir, 'f');
  git(dir, 'config', 'branch.feat.remote', '.');
  git(dir, 'config', 'branch.feat.merge', 'refs/heads/main');
}

function commitFileNamed(dir: string, name: string): void {
  writeWork(dir, name, `${name}\n`);
  git(dir, 'add', name);
  gitCommit(dir, name);
}

/** base; X on base carries a mergetag and a custom header; Y on X. HEAD left on main. */
function buildHeadered(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  commitFileNamed(dir, 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  const tree = git(dir, 'write-tree').trim();
  const identity = 'Ada <ada@example.com> 1700000000 +0000';
  const raw = `tree ${tree}\nparent ${base}\nauthor ${identity}\ncommitter ${identity}\nmergetag object ${base}\n type commit\n tag t\n tagger T <t@x> 1700000000 +0000\n \n t\nx-custom hello\n\nX subject\n`;
  const x = runGit(['-C', dir, 'hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], {
    input: raw,
  }).trim();
  git(dir, 'update-ref', 'refs/heads/main', x);
  writeWork(dir, 'y.txt', 'y\n');
  git(dir, 'add', 'y.txt');
  gitCommit(dir, 'Y subject');
}

/** A commit's headers past `committer`, as written. */
function extraHeaderLines(dir: string, rev: string): string {
  const raw = git(dir, 'cat-file', 'commit', rev);
  return raw
    .slice(0, raw.indexOf('\n\n'))
    .split('\n')
    .filter((line) => !/^(tree|parent|author|committer) /.test(line))
    .join('\n');
}
