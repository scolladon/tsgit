/**
 * Cross-tool interop — `merge.conflictStyle`. With `diff3` git writes every
 * conflict with a `|||||||` base section and refines nothing; `zdiff3` also
 * moves the lines both sides share at a conflict's edges out of it. Every row
 * replays one history in two repositories, sets the style, stops one tool on a
 * conflict in each, and compares the conflicted file byte for byte.
 *
 * @proves
 *   surface:        merge, cherryPick, revert, rebase, stash
 *   bucket:         cross-tool-interop
 *   unique:         merge.conflictStyle diff3 and zdiff3 conflict bytes match git on every merge path
 *   interopSurface: merge
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openRepository, type Repository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;
const DATED_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
  GIT_EDITOR: 'true',
};

let root: string;

const dated = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: DATED_ENV });

const commitF = (dir: string, content: string, message: string): void => {
  writeFileSync(path.join(dir, 'f'), content);
  dated(dir, 'add', 'f');
  dated(dir, 'commit', '-q', '-m', message);
};

/** base → side rewrites lines 1 and 3 of f one way, main another; `extra` adds a file; a stash holds side's f. */
const setUp = (dir: string, style: string): void => {
  runGit(['init', '-q', '-b', 'main', dir], { env: DATED_ENV });
  dated(dir, 'config', 'merge.conflictStyle', style);
  commitF(dir, 'x\na\n}\nc\nd\ne\n', 'base');
  dated(dir, 'checkout', '-q', '-b', 'extra');
  writeFileSync(path.join(dir, 'g'), 'g\n');
  dated(dir, 'add', 'g');
  dated(dir, 'commit', '-q', '-m', 'extra');
  dated(dir, 'checkout', '-q', '-b', 'side', 'main');
  commitF(dir, 'x\ns\nA2\n}\nC2\nd\ne\n', 'side');
  writeFileSync(path.join(dir, 'f'), 'x\ns\nA2\n}\nC2\nd\ne\n');
  dated(dir, 'checkout', '-q', 'main');
  commitF(dir, 'x\ns\nA1\n}\nC1\nd\ne\n', 'main');
  dated(dir, 'checkout', '-q', 'main~1');
  writeFileSync(path.join(dir, 'f'), 'x\ns\nA2\n}\nC2\nd\ne\n');
  dated(dir, 'stash', '-q');
  dated(dir, 'checkout', '-q', 'main');
};

const ROWS = [
  {
    label: 'a merge',
    git: [['merge', 'side']],
    ts: (r: Repository) => r.merge.run({ rev: 'side' }),
  },
  {
    label: 'a cherry-pick',
    git: [['cherry-pick', 'side']],
    ts: (r: Repository) => r.cherryPick.run({ commits: ['side'] }),
  },
  {
    label: 'a revert',
    git: [['revert', '--no-edit', 'side']],
    ts: (r: Repository) => r.revert.run({ commits: ['side'] }),
  },
  {
    label: 'a rebase',
    git: [
      ['checkout', '-q', 'side'],
      ['rebase', 'main'],
    ],
    ts: async (r: Repository) => {
      await r.checkout({ rev: 'side' });
      return r.rebase.run({ upstream: 'main' });
    },
  },
  { label: 'a stash apply', git: [['stash', 'apply']], ts: (r: Repository) => r.stash.apply({}) },
];

const twin = (label: string, style: string) => {
  const slug = `${style}-${label}`.replaceAll(/\W+/g, '-');
  const theirs = path.join(root, `${slug}-git`);
  const ours = path.join(root, `${slug}-ts`);
  for (const dir of [theirs, ours]) setUp(dir, style);
  return { theirs, ours };
};

const openFrozen = async (dir: string): Promise<Repository> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  return openRepository({ cwd: dir });
};

const fileOf = (dir: string): string => readFileSync(path.join(dir, 'f'), 'utf8');

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-conflict-style-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!GIT_AVAILABLE)('merge.conflictStyle interop', () => {
  describe.each(['diff3', 'zdiff3'])('Given merge.conflictStyle = %s', (style) => {
    describe.each(ROWS)('When both tools stop $label on the conflict', ({ label, git, ts }) => {
      it(
        'Then the conflicted file is byte-identical',
        async () => {
          // Arrange
          const { theirs, ours } = twin(label, style);
          const repo = await openFrozen(ours);

          // Act
          for (const step of git) tryRunGitWithExit(['-C', theirs, ...step], { env: DATED_ENV });
          await ts(repo).catch(() => undefined);

          // Assert
          expect(fileOf(theirs)).toContain('|||||||');
          expect(fileOf(ours)).toBe(fileOf(theirs));
        },
        ROW_TIMEOUT,
      );
    });

    describe('When both tools stop an octopus merge on the conflict', () => {
      it(
        'Then the conflicted file matches but for the temporary-file labels git gives each side',
        async () => {
          // Arrange
          const { theirs, ours } = twin('octopus', style);
          const repo = await openFrozen(ours);
          const unlabelled = (dir: string): string =>
            fileOf(dir).replaceAll(/^([<|>]{7}) .*$/gm, '$1');

          // Act
          tryRunGitWithExit(['-C', theirs, 'merge', '--no-edit', 'extra', 'side'], {
            env: DATED_ENV,
          });
          await repo.merge.run({ rev: ['extra', 'side'] }).catch(() => undefined);

          // Assert
          expect(unlabelled(ours)).toContain('|||||||');
          expect(unlabelled(ours)).toBe(unlabelled(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
