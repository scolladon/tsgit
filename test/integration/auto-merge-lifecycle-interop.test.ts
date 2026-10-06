/**
 * Cross-tool interop — `AUTO_MERGE` across a merge's whole life. git's ort
 * records its result tree in `AUTO_MERGE` on every merge that updates the
 * working tree (clean or conflicted), refuses to proceed when the existing
 * `AUTO_MERGE` is broken, and drops it when a commit concludes the stop, before
 * each rebase todo line, with an emptied rebase pick and on an up-to-date
 * rebase. Every row replays the same history in two repositories, drives one
 * tool through the scenario in each, and compares what `AUTO_MERGE` holds.
 *
 * @proves
 *   surface:        merge, cherryPick, revert, rebase, stash, reset
 *   bucket:         cross-tool-interop
 *   unique:         AUTO_MERGE is written, refused, dropped and stored through the ref backend as git does
 *   interopSurface: merge
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const commitFile = (dir: string, file: string, content: string, message: string): void => {
  writeFileSync(path.join(dir, file), `${content}\n`);
  dated(dir, 'add', file);
  dated(dir, 'commit', '-q', '-m', message);
};

/**
 * base → side changes f then adds h; clean adds n; main changes f then adds m2.
 * `side~1` conflicts with main on f; `side` and `clean` apply cleanly.
 */
const setUp = (dir: string, format: 'files' | 'reftable'): void => {
  runGit(['init', '-q', '-b', 'main', `--ref-format=${format}`, dir], { env: DATED_ENV });
  dated(dir, 'config', 'user.name', 'A');
  dated(dir, 'config', 'user.email', 'a@x');
  commitFile(dir, 'f', 'base', 'base');
  dated(dir, 'checkout', '-q', '-b', 'side');
  commitFile(dir, 'f', 'side', 'side');
  commitFile(dir, 'h', 'h', 'h');
  dated(dir, 'checkout', '-q', '-b', 'clean', 'main');
  commitFile(dir, 'n', 'n', 'n');
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'f', 'main', 'main');
  commitFile(dir, 'm2', 'm2', 'm2');
};

const resolveF = (dir: string): void => {
  writeFileSync(path.join(dir, 'f'), 'resolved\n');
  dated(dir, 'add', 'f');
};

type GitStep = ReadonlyArray<string> | 'resolve';
type TsStep = ((repo: Repository) => Promise<unknown>) | 'resolve';

interface Row {
  readonly label: string;
  readonly prepare?: ReadonlyArray<ReadonlyArray<string>>;
  readonly git: ReadonlyArray<GitStep>;
  readonly ts: ReadonlyArray<TsStep>;
}

const LIFECYCLE: ReadonlyArray<Row> = [
  {
    label: 'a clean cherry-pick',
    git: [['cherry-pick', 'clean']],
    ts: [(repo) => repo.cherryPick.run({ commits: ['clean'] })],
  },
  {
    label: 'a clean revert',
    git: [['revert', '--no-edit', 'HEAD']],
    ts: [(repo) => repo.revert.run({ commits: ['HEAD'] })],
  },
  {
    label: 'a clean merge stopped before its commit',
    git: [['merge', '--no-commit', 'clean']],
    ts: [(repo) => repo.merge.run({ rev: 'clean', commit: false })],
  },
  {
    label: 'a conflicted cherry-pick continued',
    git: [['cherry-pick', 'side~1'], 'resolve', ['cherry-pick', '--continue']],
    ts: [
      (repo) => repo.cherryPick.run({ commits: ['side~1'] }),
      'resolve',
      (repo) => repo.cherryPick.continue({}),
    ],
  },
  {
    label: 'a conflicted pick continued into a clean one',
    git: [['cherry-pick', 'side~1', 'side'], 'resolve', ['cherry-pick', '--continue']],
    ts: [
      (repo) => repo.cherryPick.run({ commits: ['side~1', 'side'] }),
      'resolve',
      (repo) => repo.cherryPick.continue({}),
    ],
  },
  {
    label: 'a conflicted revert continued',
    git: [['revert', '--no-edit', 'HEAD~1'], 'resolve', ['revert', '--continue']],
    ts: [
      (repo) => repo.revert.run({ commits: ['HEAD~1'] }),
      'resolve',
      (repo) => repo.revert.continue(),
    ],
  },
  {
    label: 'a clean rebase',
    prepare: [['checkout', '-q', 'clean']],
    git: [['rebase', 'main']],
    ts: [(repo) => repo.rebase.run({ upstream: 'main' })],
  },
  {
    label: 'a rebase stopped on its last pick and continued',
    prepare: [['checkout', '-q', '-b', 'one', 'side~1']],
    git: [['rebase', 'main'], 'resolve', ['rebase', '--continue']],
    ts: [
      (repo) => repo.rebase.run({ upstream: 'main' }),
      'resolve',
      (repo) => repo.rebase.continue(),
    ],
  },
  {
    label: 'a rebase stop continued into a clean pick',
    prepare: [['checkout', '-q', 'side']],
    git: [['rebase', 'main'], 'resolve', ['rebase', '--continue']],
    ts: [
      (repo) => repo.rebase.run({ upstream: 'main' }),
      'resolve',
      (repo) => repo.rebase.continue(),
    ],
  },
  {
    label: 'a rebase stop skipped into a clean pick',
    prepare: [['checkout', '-q', 'side']],
    git: [
      ['rebase', 'main'],
      ['rebase', '--skip'],
    ],
    ts: [(repo) => repo.rebase.run({ upstream: 'main' }), (repo) => repo.rebase.skip()],
  },
  {
    label: 'an up-to-date rebase over a stale AUTO_MERGE',
    prepare: [
      ['update-ref', 'AUTO_MERGE', 'HEAD^{tree}'],
      ['branch', 'up', 'HEAD~1'],
    ],
    git: [['rebase', 'up']],
    ts: [(repo) => repo.rebase.run({ upstream: 'up' })],
  },
  {
    label: 'a rebase whose last pick upstream already made',
    prepare: [
      ['checkout', '-q', '-b', 'dup', 'main'],
      ['cherry-pick', '-n', 'clean'],
      ['commit', '-q', '-a', '-m', 'dup'],
      ['checkout', '-q', 'clean'],
    ],
    git: [['rebase', 'dup']],
    ts: [(repo) => repo.rebase.run({ upstream: 'dup' })],
  },
  {
    label: 'a clean stash apply',
    prepare: [['checkout', '-q', 'clean']],
    git: [['stash', 'apply']],
    ts: [(repo) => repo.stash.apply({})],
  },
];

const autoMerge = (dir: string): string => {
  const result = tryRunGitWithExit(['-C', dir, 'rev-parse', '-q', '--verify', 'AUTO_MERGE'], {
    env: DATED_ENV,
  });
  return result.exitCode === 0 ? result.stdout.trim() : 'absent';
};

const runGitSteps = (dir: string, steps: ReadonlyArray<GitStep>): void => {
  for (const step of steps) {
    if (step === 'resolve') resolveF(dir);
    else tryRunGitWithExit(['-C', dir, ...step], { env: DATED_ENV });
  }
};

const runTsSteps = async (
  dir: string,
  repo: Repository,
  steps: ReadonlyArray<TsStep>,
): Promise<unknown> => {
  let caught: unknown;
  for (const step of steps) {
    if (step === 'resolve') resolveF(dir);
    else
      caught = await step(repo).then(
        () => undefined,
        (error: unknown) => error,
      );
  }
  return caught;
};

/** Both repositories, set up the same way, with the row's preparation applied. */
const twin = (label: string, row: Pick<Row, 'prepare'>, format: 'files' | 'reftable') => {
  const slug = label.replaceAll(/\W+/g, '-');
  const theirs = path.join(root, `${slug}-git`);
  const ours = path.join(root, `${slug}-ts`);
  for (const dir of [theirs, ours]) {
    setUp(dir, format);
    for (const step of row.prepare ?? []) dated(dir, ...step);
  }
  return { theirs, ours };
};

/** A stash entry on `clean` so `stash apply` has something to replay. */
const stashOn = (dir: string): void => {
  writeFileSync(path.join(dir, 'n'), 'stashed\n');
  dated(dir, 'stash', '-q');
  commitFile(dir, 'o', 'o', 'o');
};

const openFrozen = async (dir: string): Promise<Repository> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  return openRepository({ cwd: dir });
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-auto-merge-life-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!GIT_AVAILABLE)('AUTO_MERGE lifecycle interop', () => {
  describe.each(LIFECYCLE)('Given $label', (row) => {
    describe('When both tools run it', () => {
      it(
        'Then AUTO_MERGE ends up the same: absent, or the same tree',
        async () => {
          // Arrange
          const { theirs, ours } = twin(row.label, row, 'files');
          if (row.label === 'a clean stash apply') for (const dir of [theirs, ours]) stashOn(dir);
          const repo = await openFrozen(ours);

          // Act
          runGitSteps(theirs, row.git);
          await runTsSteps(ours, repo, row.ts);

          // Assert
          expect(autoMerge(ours)).toBe(autoMerge(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe.each([
    {
      label: 'a conflicted merge',
      git: ['merge', 'side~1'],
      ts: (repo: Repository) => repo.merge.run({ rev: 'side~1' }),
      marker: 'MERGE_HEAD',
    },
    {
      label: 'a clean cherry-pick',
      git: ['cherry-pick', 'clean'],
      ts: (repo: Repository) => repo.cherryPick.run({ commits: ['clean'] }),
      marker: 'CHERRY_PICK_HEAD',
    },
  ])('Given an AUTO_MERGE that holds no object id and $label', ({ label, git, ts, marker }) => {
    describe('When both tools run it', () => {
      it(
        'Then both refuse, keep the broken AUTO_MERGE and record no stop',
        async () => {
          // Arrange
          const { theirs, ours } = twin(`broken ${label}`, {}, 'files');
          for (const dir of [theirs, ours]) {
            writeFileSync(path.join(dir, '.git', 'AUTO_MERGE'), 'garbage\n');
          }
          const repo = await openFrozen(ours);

          // Act
          const gitResult = tryRunGitWithExit(['-C', theirs, ...git], { env: DATED_ENV });
          const result = await ts(repo).then(
            () => undefined,
            (error: unknown) => error,
          );

          // Assert
          expect(gitResult.stderr).toContain("cannot lock ref 'AUTO_MERGE'");
          expect(gitResult.exitCode).not.toBe(0);
          expect((result as { data?: unknown }).data).toEqual({
            code: 'INVALID_REF',
            reason: 'AUTO_MERGE is broken',
          });
          for (const dir of [theirs, ours]) {
            expect(readFileSync(path.join(dir, '.git', 'AUTO_MERGE'), 'utf8')).toBe('garbage\n');
            expect(existsSync(path.join(dir, '.git', marker))).toBe(false);
          }
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given an AUTO_MERGE that holds no object id and a clean cherry-pick', () => {
    describe('When both tools fail on it', () => {
      it(
        'Then the picked change is in the working tree but not the index, in both',
        async () => {
          // Arrange
          const { theirs, ours } = twin('broken pick status', {}, 'files');
          for (const dir of [theirs, ours]) {
            writeFileSync(path.join(dir, '.git', 'AUTO_MERGE'), 'garbage\n');
          }
          const repo = await openFrozen(ours);

          // Act
          tryRunGitWithExit(['-C', theirs, 'cherry-pick', 'clean'], { env: DATED_ENV });
          await repo.cherryPick.run({ commits: ['clean'] }).catch(() => undefined);

          // Assert
          const status = (dir: string) => dated(dir, 'status', '--porcelain');
          expect(status(ours)).toBe(status(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a reftable repository and a conflicted merge', () => {
    describe('When both tools stop on the conflict', () => {
      it(
        'Then AUTO_MERGE lives in the reftable stack, naming the same tree',
        async () => {
          // Arrange
          const { theirs, ours } = twin('reftable merge', {}, 'reftable');
          const repo = await openFrozen(ours);

          // Act
          tryRunGitWithExit(['-C', theirs, 'merge', 'side~1'], { env: DATED_ENV });
          await repo.merge.run({ rev: 'side~1' });

          // Assert
          expect(existsSync(path.join(ours, '.git', 'AUTO_MERGE'))).toBe(false);
          expect(autoMerge(ours)).not.toBe('absent');
          expect(autoMerge(ours)).toBe(autoMerge(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
