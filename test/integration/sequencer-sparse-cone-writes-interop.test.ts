/**
 * Cross-tool interop — sparse patterns govern every merge-driven work-tree write.
 * Each row seeds two identical repositories, runs one operation in canonical git
 * and in tsgit, and compares the index tags, the work tree and the outcome.
 *
 * @proves
 *   surface:        repo.checkout, repo.reset, repo.merge.run, pull, repo.stash.apply, repo.stash.pop, repo.cherryPick.run, repo.revert.run, repo.rebase.run
 *   bucket:         cross-tool-interop
 *   unique:         sparse patterns govern every merge-driven work-tree write, case-folded under core.ignorecase, as canonical git applies them
 *   interopSurface: sequencer, stash, checkout, merge
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { pull } from '../../src/application/commands/pull.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import { backendTransport } from './http-backend-transport.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  COMMIT_ENV,
  commitOn,
  listing,
  regular,
  symlink,
  type TreeEntry,
} from './occupant-displacement-fixtures.js';
import { trackedContexts } from './repository-lifecycle.js';

const CONE_FILE = '/*\n!/*/\n/b/\n';
const NON_CONE_FILE = '/top\n/b/\n';
const ORIGIN_URL = 'https://example.com/origin.git';
const ROW_TIMEOUT = 60_000;
const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;
const LEFT_HEADER = 'The following paths are not up to date and were left despite sparse patterns:';

const createTrackedNodeContext = trackedContexts(createNodeContext);

interface Seed {
  readonly main: ReadonlyArray<TreeEntry>;
  readonly other: ReadonlyArray<TreeEntry>;
}

const CASE_SEED: Seed = {
  main: [regular('B/f', 'f1\n'), regular('x/y', 'y1\n'), regular('top', 't\n')],
  other: [regular('B/f', 'f2\n'), regular('x/y', 'y2\n'), regular('top', 't\n')],
};

const seedTwin = (dir: string, ignoreCase: string, seed: Seed): void => {
  runGit(['-C', dir, 'config', 'core.ignorecase', ignoreCase]);
  const main = commitOn(dir, seed.main);
  const other = commitOn(dir, seed.other, main);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/other', other]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const enableSparse = (dir: string, { cone }: { readonly cone: boolean }): void => {
  runGit(['-C', dir, 'config', 'core.sparseCheckout', 'true']);
  runGit(['-C', dir, 'config', 'core.sparseCheckoutCone', String(cone)]);
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'sparse-checkout'), cone ? CONE_FILE : NON_CONE_FILE);
  runGit(['-C', dir, 'read-tree', '-mu', 'HEAD']);
};

// git clears the skip-worktree bit of a present file when it reads the index unless told to
// expect files outside the patterns, which would hide an `S` entry whose file is on disk.
const tagged = (dir: string): string =>
  runGit(['-C', dir, '-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t', '-s']);

type Outcome = { readonly kind: 'ok' } | { readonly kind: 'error'; readonly code: string };

const outcomeOf = async (run: () => Promise<unknown>): Promise<Outcome> => {
  try {
    await run();
    return { kind: 'ok' };
  } catch (error) {
    if (error instanceof TsgitError) return { kind: 'error', code: error.data.code };
    throw error;
  }
};

const leftWarning = (stderr: string): ReadonlyArray<string> =>
  stderr.split('\n').filter((line) => line.includes(LEFT_HEADER));
const leftWarnings = (warnings: ReadonlyArray<string>): ReadonlyArray<string> =>
  warnings.filter((warning) => warning.startsWith(LEFT_HEADER));

const skippedPaths = (dir: string): ReadonlyArray<string> =>
  tagged(dir)
    .split('\n')
    .filter((line) => line.startsWith('S '))
    .map((line) => line.split('\t')[1] ?? '');

const gitExitOf = (dir: string, args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args], { env: COMMIT_ENV });

interface TsgitRun {
  readonly outcome: Outcome;
  readonly warnings: ReadonlyArray<string>;
}

const runTsgit = async (
  dir: string,
  operation: (repo: Repository) => Promise<unknown>,
): Promise<TsgitRun> => {
  const warnings: string[] = [];
  const repo = await openRepository({
    cwd: dir,
    logger: { warn: (message: string) => warnings.push(message) },
  });
  try {
    return { outcome: await outcomeOf(() => operation(repo)), warnings };
  } finally {
    await repo.dispose();
  }
};

interface CaseRow {
  readonly id: string;
  readonly gitArgs: ReadonlyArray<string>;
  readonly operation: (repo: Repository) => Promise<unknown>;
}

const CASE_ROWS: ReadonlyArray<CaseRow> = [
  {
    id: 'case-checkout',
    gitArgs: ['checkout', '-q', 'other'],
    operation: (repo) => repo.checkout({ rev: 'other' }),
  },
  {
    id: 'case-reset',
    gitArgs: ['reset', '-q', '--hard', 'other'],
    operation: (repo) => repo.reset({ mode: 'hard', rev: 'other' }),
  },
  {
    id: 'case-merge',
    gitArgs: ['merge', '-q', 'other'],
    operation: (repo) => repo.merge.run({ rev: 'other', message: 'm', author: AUTHOR }),
  },
];

const BASE_SEED: Seed = {
  main: [
    regular('a/f', 'f1\n'),
    regular('a/g', 'g1\n'),
    regular('b/f', 'f1\n'),
    regular('top', 't\n'),
  ],
  other: [
    regular('a/f', 'f2\n'),
    regular('a/g', 'g1\n'),
    regular('b/f', 'f2\n'),
    regular('top', 't\n'),
  ],
};

interface MoverRow {
  readonly id: string;
  readonly edit: (dir: string) => void;
  readonly expectedListing: ReadonlyArray<string>;
  readonly expectedWarning: string | undefined;
}

const REAPPLY_HINT =
  '\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.';

const MOVER_ROWS: ReadonlyArray<MoverRow> = [
  {
    id: 'dirty-mover-kept',
    edit: (dir) => writeFileSync(join(dir, 'a', 'g'), 'dirty\n'),
    expectedListing: ['a/', 'a/g=dirty\n', 'b/', 'b/f=f2\n', 'top=t\n'],
    expectedWarning: `${LEFT_HEADER}\n\ta/g\n${REAPPLY_HINT}`,
  },
  {
    id: 'clean-mover-removed',
    edit: () => undefined,
    expectedListing: ['b/', 'b/f=f2\n', 'top=t\n'],
    expectedWarning: undefined,
  },
];

interface StashRow {
  readonly id: string;
  readonly stashed: (dir: string) => void;
  readonly afterSparse: (dir: string) => void;
  readonly gitExit: number;
  readonly outcome: Outcome;
  readonly expectedListing: ReadonlyArray<string>;
  readonly tagsOf?: (dir: string) => string;
}

const stashEdits = (dir: string): void => {
  writeFileSync(join(dir, 'a', 'f'), 'f2\n');
  writeFileSync(join(dir, 'b', 'f'), 'f2\n');
};

const STASH_ROWS: ReadonlyArray<StashRow> = [
  {
    id: 'stash-skipped-change',
    stashed: stashEdits,
    afterSparse: () => undefined,
    gitExit: 0,
    outcome: { kind: 'ok' },
    expectedListing: ['a/', 'a/f=f2\n', 'b/', 'b/f=f2\n', 'top=t\n'],
  },
  {
    id: 'stash-skipped-addition',
    stashed: (dir) => {
      writeFileSync(join(dir, 'a', 'n'), 'n1\n');
      runGit(['-C', dir, 'add', 'a/n']);
      writeFileSync(join(dir, 'b', 'f'), 'f2\n');
    },
    afterSparse: () => undefined,
    gitExit: 0,
    outcome: { kind: 'ok' },
    expectedListing: ['a/', 'a/n=n1\n', 'b/', 'b/f=f2\n', 'top=t\n'],
  },
  {
    id: 'stash-skipped-untracked-blocker',
    stashed: stashEdits,
    afterSparse: (dir) => {
      mkdirSync(join(dir, 'a'), { recursive: true });
      writeFileSync(join(dir, 'a', 'f'), 'junk\n');
    },
    gitExit: 128,
    outcome: { kind: 'error', code: 'STASH_APPLY_WOULD_OVERWRITE' },
    expectedListing: ['a/', 'a/f=junk\n', 'b/', 'b/f=f1\n', 'top=t\n'],
    // git clears the bit of a present file on every index read and writes that back even
    // when the apply refuses; tsgit keeps the bit, so only the read-side view is compared.
    tagsOf: (dir) => runGit(['-C', dir, 'ls-files', '-t', '-s']),
  },
];

const presentMover = (dir: string): void => {
  runGit(['-C', dir, 'update-index', '--no-skip-worktree', 'a/g']);
  runGit(['-C', dir, 'checkout', '--', 'a/g']);
};

const writeFiles = (dir: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
};

const commitFiles = (dir: string, files: Readonly<Record<string, string>>): void => {
  writeFiles(dir, files);
  runGit(['-C', dir, 'add', '-A']);
  runGit(['-C', dir, 'commit', '-q', '-m', 'step'], { env: COMMIT_ENV });
};

const switchTo = (dir: string, args: ReadonlyArray<string>): void => {
  runGit(['-C', dir, ...args], { env: COMMIT_ENV });
};

const RENAME_SEED: Seed = {
  main: [
    regular('a/f', 'af\n'),
    regular('a/g', 'g1\n'),
    regular('b/f', 'f1\n'),
    regular('top', 't\n'),
  ],
  other: [
    regular('a/f', 'af\n'),
    regular('a/h', 'f1\n'),
    regular('b/g', 'g1\n'),
    regular('top', 't\n'),
  ],
};

const ADD_SEED: Seed = {
  main: BASE_SEED.main,
  other: [...BASE_SEED.main, regular('a/n', 'n1\n'), regular('b/n', 'n1\n')],
};

const DELETE_SEED: Seed = {
  main: BASE_SEED.main,
  other: [regular('a/g', 'g1\n'), regular('b/f', 'f1\n'), regular('top', 't\n')],
};

const SECOND_PICK = [
  regular('a/f', 'f3\n'),
  regular('a/g', 'g1\n'),
  regular('b/f', 'f3\n'),
  regular('top', 't\n'),
];

interface ReplayRow {
  readonly id: string;
  readonly seed: Seed;
  readonly cone: boolean | undefined;
  readonly prepare: (dir: string) => void;
  readonly afterSparse: (dir: string) => void;
  readonly target: (dir: string) => string;
  readonly gitArgs: ReadonlyArray<string>;
  readonly operation: (repo: Repository) => Promise<unknown>;
  readonly skipped: ReadonlyArray<string> | undefined;
}

const nothing = (): void => undefined;
const here = (dir: string): string => dir;

const replayRow = (
  row: Partial<ReplayRow> & Pick<ReplayRow, 'id' | 'gitArgs' | 'operation'>,
): ReplayRow => ({
  seed: BASE_SEED,
  cone: true,
  prepare: nothing,
  afterSparse: nothing,
  target: here,
  skipped: ['a/f', 'a/g'],
  ...row,
});

const pick = (commits: ReadonlyArray<string>) => (repo: Repository) =>
  repo.cherryPick.run({ commits });

const checkoutOther = (dir: string): void => switchTo(dir, ['checkout', '-q', 'other']);

const prepareRebase = (dir: string): void => {
  const main = runGit(['-C', dir, 'rev-parse', 'main']).trim();
  checkoutOther(dir);
  switchTo(dir, ['checkout', '-q', '-b', 'tip', main]);
  commitFiles(dir, { top: 't2\n' });
  switchTo(dir, ['branch', '-f', 'main', 'tip']);
  switchTo(dir, ['checkout', '-q', 'other']);
};

const prepareRebaseMerges = (dir: string): void => {
  switchTo(dir, ['checkout', '-q', '-b', 'side', 'main']);
  commitFiles(dir, { 'a/f': 'f2\n' });
  switchTo(dir, ['checkout', '-q', '-b', 'topic', 'main']);
  commitFiles(dir, { 'b/f': 'f2\n' });
  switchTo(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  switchTo(dir, ['checkout', '-q', 'main']);
  commitFiles(dir, { top: 't2\n' });
  switchTo(dir, ['checkout', '-q', 'topic']);
};

const prepareWorktree = (dir: string): void => {
  switchTo(dir, ['worktree', 'add', '-q', `${dir}-wt`, '-b', 'wt', 'main']);
  switchTo(`${dir}-wt`, ['sparse-checkout', 'set', 'b']);
};

const REPLAY_ROWS: ReadonlyArray<ReplayRow> = [
  replayRow({
    id: 'pick-outside-cone',
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'revert-outside-cone',
    prepare: checkoutOther,
    gitArgs: ['revert', '--no-edit', 'HEAD'],
    operation: (repo) => repo.revert.run({ commits: ['HEAD'] }),
  }),
  replayRow({
    id: 'pick-non-cone',
    cone: false,
    skipped: ['a/f', 'a/g'],
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'pick-rename-leaving-cone',
    seed: RENAME_SEED,
    skipped: ['a/f', 'a/h'],
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'pick-addition-outside-cone',
    seed: ADD_SEED,
    skipped: ['a/f', 'a/g', 'a/n'],
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'pick-deletion-outside-cone',
    seed: DELETE_SEED,
    skipped: ['a/g'],
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'rebase-outside-cone',
    prepare: prepareRebase,
    gitArgs: ['rebase', '-q', 'main'],
    operation: (repo) => repo.rebase.run({ upstream: 'main' }),
  }),
  replayRow({
    id: 'rebase-merges-outside-cone',
    prepare: prepareRebaseMerges,
    gitArgs: ['rebase', '-q', '--rebase-merges', 'main'],
    operation: (repo) => repo.rebase.run({ upstream: 'main', rebaseMerges: true }),
  }),
  replayRow({
    id: 'pick-in-linked-worktree',
    cone: undefined,
    prepare: prepareWorktree,
    target: (dir) => `${dir}-wt`,
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'pick-range-outside-cone',
    prepare: (dir) => {
      const other = runGit(['-C', dir, 'rev-parse', 'other']).trim();
      const second = commitOn(dir, SECOND_PICK, other);
      runGit(['-C', dir, 'update-ref', 'refs/heads/second', second]);
      runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
    },
    gitArgs: ['cherry-pick', 'other', 'second'],
    operation: pick(['other', 'second']),
  }),
  replayRow({
    id: 'stash-apply-present-clean-mover',
    prepare: (dir) => {
      writeFileSync(join(dir, 'a', 'f'), 'f2\n');
      switchTo(dir, ['stash', 'push', '-q']);
    },
    afterSparse: presentMover,
    skipped: ['a/g'],
    gitArgs: ['stash', 'apply', '-q'],
    operation: (repo) => repo.stash.apply(),
  }),
  replayRow({
    id: 'stash-pop-index-outside-cone',
    prepare: (dir) => {
      writeFileSync(join(dir, 'a', 'f'), 'f2\n');
      switchTo(dir, ['add', 'a/f']);
      writeFileSync(join(dir, 'a', 'f'), 'f3\n');
      writeFileSync(join(dir, 'b', 'f'), 'f2\n');
      switchTo(dir, ['stash', 'push', '-q']);
    },
    gitArgs: ['stash', 'pop', '--index', '-q'],
    operation: (repo) => repo.stash.pop({ restoreIndex: true }),
  }),
  replayRow({
    id: 'pick-present-clean-mover',
    afterSparse: presentMover,
    skipped: ['a/f', 'a/g'],
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'pick-present-dirty-mover',
    afterSparse: (dir) => {
      presentMover(dir);
      writeFileSync(join(dir, 'a', 'g'), 'dirty\n');
    },
    skipped: ['a/f'],
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'merge-clean-present-clean-mover',
    afterSparse: presentMover,
    skipped: ['a/f', 'a/g'],
    gitArgs: ['merge', '-q', 'other'],
    operation: (repo) => repo.merge.run({ rev: 'other', message: 'm', author: AUTHOR }),
  }),
  replayRow({
    id: 'case-pick',
    seed: CASE_SEED,
    skipped: undefined,
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  replayRow({
    id: 'case-pick-non-cone',
    seed: CASE_SEED,
    cone: false,
    skipped: undefined,
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
];

const mergeOther = (repo: Repository) =>
  repo.merge.run({ rev: 'other', message: 'm', author: AUTHOR });

const FIVE_LINES = '1\n2\n3\n4\n5\n';
const OURS_EDITS_FIRST = '1x\n2\n3\n4\n5\n';
const THEIRS_EDITS_LAST = '1\n2\n3\n4\n5x\n';

const TAKE_THEIRS_SEED: Seed = {
  main: [regular('a/f', 'f1\n'), regular('b/f', 'f1\n'), regular('top', 't\n')],
  other: [regular('a/f', 'f2\n'), regular('b/f', 'f2\n'), regular('top', 't\n')],
};

const LINE_MERGE_SEED: Seed = {
  main: [regular('a/f', FIVE_LINES), regular('b/f', 'f1\n'), regular('top', 't\n')],
  other: [regular('a/f', THEIRS_EDITS_LAST), regular('b/f', 'f2\n'), regular('top', 't\n')],
};

const SYMLINK_SEED: Seed = {
  main: [regular('a/f', 'f1\n'), regular('b/f', 'f1\n'), regular('top', 't\n')],
  other: [symlink('a/f', 'elsewhere'), regular('b/f', 'f2\n'), regular('top', 't\n')],
};

const advancedMain = (dir: string, entries: ReadonlyArray<TreeEntry>): string => {
  const main = runGit(['-C', dir, 'rev-parse', 'main']).trim();
  const advanced = commitOn(dir, entries, main);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', advanced]);
  return advanced;
};

const advanceAndReset = (entries: ReadonlyArray<TreeEntry>) => (dir: string) => {
  advancedMain(dir, entries);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const advanceBesideOther = (entries: ReadonlyArray<TreeEntry>) => (dir: string) => {
  checkoutOther(dir);
  advancedMain(dir, entries);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'HEAD']);
};

const stashThenAdvance = (entries: ReadonlyArray<TreeEntry>) => (dir: string) => {
  writeFileSync(join(dir, 'a', 'f'), THEIRS_EDITS_LAST);
  writeFileSync(join(dir, 'b', 'f'), 'f2\n');
  switchTo(dir, ['stash', 'push', '-q']);
  advanceAndReset(entries)(dir);
};

const BOTH_CONFLICT = [regular('a/f', 'm\n'), regular('b/f', 'm\n'), regular('top', 't\n')];
const IN_CONE_CONFLICT = [regular('a/f', 'f1\n'), regular('b/f', 'm\n'), regular('top', 't\n')];
const LINE_MERGED = [
  regular('a/f', OURS_EDITS_FIRST),
  regular('b/f', 'm\n'),
  regular('top', 't\n'),
];
const CONE_CONFLICT = [
  regular('a/f', 'f1\n'),
  regular('a/g', 'g1\n'),
  regular('b/f', 'm\n'),
  regular('top', 't\n'),
];
const SYMLINK_VS_EDIT = [regular('a/f', 'm\n'), regular('b/f', 'f1\n'), regular('top', 't\n')];

interface ConflictRow {
  readonly id: string;
  readonly seed: Seed;
  readonly prepare: (dir: string) => void;
  readonly afterSparse: (dir: string) => void;
  readonly gitArgs: ReadonlyArray<string>;
  readonly operation: (repo: Repository) => Promise<unknown>;
  readonly skipOnWindows: boolean;
}

const conflictRow = (
  row: Partial<ConflictRow> & Pick<ConflictRow, 'id' | 'prepare' | 'gitArgs' | 'operation'>,
): ConflictRow => ({ seed: BASE_SEED, afterSparse: nothing, skipOnWindows: false, ...row });

const CONFLICT_ROWS: ReadonlyArray<ConflictRow> = [
  conflictRow({
    id: 'pick-conflict-take-theirs-outside-cone',
    seed: TAKE_THEIRS_SEED,
    prepare: advanceAndReset(IN_CONE_CONFLICT),
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  conflictRow({
    id: 'pick-conflict-line-merged-outside-cone',
    seed: LINE_MERGE_SEED,
    prepare: advanceAndReset(LINE_MERGED),
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  conflictRow({
    id: 'rebase-conflict-line-merged-outside-cone',
    seed: LINE_MERGE_SEED,
    prepare: advanceBesideOther(LINE_MERGED),
    gitArgs: ['rebase', '-q', 'main'],
    operation: (repo) => repo.rebase.run({ upstream: 'main' }),
  }),
  conflictRow({
    id: 'stash-apply-conflict-line-merged-outside-cone',
    seed: LINE_MERGE_SEED,
    prepare: stashThenAdvance(LINE_MERGED),
    gitArgs: ['stash', 'apply', '-q'],
    operation: (repo) => repo.stash.apply(),
  }),
  conflictRow({
    id: 'pick-conflict-on-outside-path',
    seed: TAKE_THEIRS_SEED,
    prepare: advanceAndReset(BOTH_CONFLICT),
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  conflictRow({
    id: 'pick-conflict-distinct-types-outside-cone',
    seed: SYMLINK_SEED,
    prepare: advanceAndReset(SYMLINK_VS_EDIT),
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
    skipOnWindows: true,
  }),
  conflictRow({
    id: 'pick-conflict-retires-clean-mover',
    prepare: advanceAndReset(CONE_CONFLICT),
    afterSparse: presentMover,
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  conflictRow({
    id: 'pick-conflict-keeps-dirty-mover',
    prepare: advanceAndReset(CONE_CONFLICT),
    afterSparse: (dir) => {
      presentMover(dir);
      writeFileSync(join(dir, 'a', 'g'), 'dirty\n');
    },
    gitArgs: ['cherry-pick', 'other'],
    operation: pick(['other']),
  }),
  conflictRow({
    id: 'merge-conflict-line-merged-outside-cone',
    seed: LINE_MERGE_SEED,
    prepare: advanceAndReset(LINE_MERGED),
    gitArgs: ['merge', '-q', 'other'],
    operation: mergeOther,
  }),
  conflictRow({
    id: 'merge-conflict-take-theirs-outside-cone',
    seed: TAKE_THEIRS_SEED,
    prepare: advanceAndReset(IN_CONE_CONFLICT),
    gitArgs: ['merge', '-q', 'other'],
    operation: mergeOther,
  }),
  conflictRow({
    id: 'merge-conflict-retires-clean-mover',
    prepare: advanceAndReset(CONE_CONFLICT),
    afterSparse: presentMover,
    gitArgs: ['merge', '-q', 'other'],
    operation: mergeOther,
  }),
  conflictRow({
    id: 'merge-conflict-keeps-dirty-mover',
    prepare: advanceAndReset(CONE_CONFLICT),
    afterSparse: (dir) => {
      presentMover(dir);
      writeFileSync(join(dir, 'a', 'g'), 'dirty\n');
    },
    gitArgs: ['merge', '-q', 'other'],
    operation: mergeOther,
  }),
  conflictRow({
    id: 'octopus-conflict-retires-clean-mover',
    prepare: (dir) => {
      const base = runGit(['-C', dir, 'rev-parse', 'main']).trim();
      const first = commitOn(
        dir,
        [...BASE_SEED.main.filter((e) => e.path !== 'top'), regular('top', 't2\n')],
        base,
      );
      const last = commitOn(
        dir,
        BASE_SEED.main.filter((e) => e.path !== 'b/f'),
        base,
      );
      runGit(['-C', dir, 'update-ref', 'refs/heads/first', first]);
      runGit(['-C', dir, 'update-ref', 'refs/heads/last', last]);
      advanceAndReset(CONE_CONFLICT)(dir);
    },
    afterSparse: presentMover,
    gitArgs: ['merge', '-q', 'first', 'last'],
    operation: (repo) => repo.merge.run({ rev: ['first', 'last'], message: 'm', author: AUTHOR }),
  }),
];

const expectedCaseListing = (ignoreCase: string): ReadonlyArray<string> =>
  ignoreCase === 'true' ? ['B/', 'B/f=f2\n', 'top=t\n'] : ['top=t\n'];

describe.skipIf(!GIT_AVAILABLE)('sequencer sparse cone writes interop', () => {
  let pair: PeerPair;
  const extraDirs: string[] = [];

  beforeEach(async () => {
    pair = await makePeerPair('sequencer-sparse');
    initBothRepos(pair.peer, pair.ours);
    for (const dir of [pair.peer, pair.ours]) {
      runGit(['-C', dir, 'config', 'user.name', 'Ada']);
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
    }
  });

  afterEach(async () => {
    await pair.dispose();
    for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe.each(['false', 'true'] as const)(
    'Given core.ignorecase=%s in both twins',
    (ignoreCase) => {
      describe('When a cone-mode operation brings in a differently cased cone directory', () => {
        it.skipIf(!GIT_AVAILABLE).each(CASE_ROWS)(
          'Then $id leaves the same index tags and work tree as git',
          async ({ gitArgs, operation }) => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, CASE_SEED);
              enableSparse(dir, { cone: true });
            }

            // Act
            const git = gitExitOf(pair.peer, gitArgs);
            const run = await runTsgit(pair.ours, operation);

            // Assert
            expect(git.exitCode).toBe(0);
            expect(run.outcome).toEqual({ kind: 'ok' });
            expect(tagged(pair.ours)).toBe(tagged(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(listing(pair.ours)).toEqual(expectedCaseListing(ignoreCase));
            expect(leftWarnings(run.warnings)).toEqual(leftWarning(git.stderr));
          },
        );
      });

      describe('When checkout switches over an out-of-pattern file that is present', () => {
        it.skipIf(!GIT_AVAILABLE).each(MOVER_ROWS)(
          'Then $id leaves the same index tags, work tree and warning as git',
          async ({ edit, expectedListing, expectedWarning }) => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, BASE_SEED);
              enableSparse(dir, { cone: true });
              presentMover(dir);
              edit(dir);
            }

            // Act
            const git = gitExitOf(pair.peer, ['checkout', '-q', 'other']);
            const run = await runTsgit(pair.ours, (repo) => repo.checkout({ rev: 'other' }));

            // Assert
            expect(git.exitCode).toBe(0);
            expect(run.outcome).toEqual({ kind: 'ok' });
            expect(tagged(pair.ours)).toBe(tagged(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(listing(pair.ours)).toEqual(expectedListing);
            expect(leftWarnings(run.warnings)).toEqual(
              expectedWarning === undefined ? [] : [expectedWarning],
            );
            expect(git.stderr).toContain(
              expectedWarning === undefined ? '' : `warning: ${expectedWarning}\n`,
            );
          },
        );
      });

      describe('When stash apply brings back a change to an out-of-pattern path', () => {
        it.skipIf(!GIT_AVAILABLE).each(STASH_ROWS)(
          'Then $id leaves the same index tags, work tree and outcome as git',
          async ({ stashed, afterSparse, gitExit, outcome, expectedListing, tagsOf = tagged }) => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, BASE_SEED);
              stashed(dir);
              runGit(['-C', dir, 'stash', 'push', '-q'], { env: COMMIT_ENV });
              enableSparse(dir, { cone: true });
              afterSparse(dir);
            }

            // Act
            const git = gitExitOf(pair.peer, ['stash', 'apply', '-q']);
            const run = await runTsgit(pair.ours, (repo) => repo.stash.apply());

            // Assert
            expect(git.exitCode).toBe(gitExit);
            expect(run.outcome).toEqual(outcome);
            expect(tagsOf(pair.ours)).toBe(tagsOf(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(listing(pair.ours)).toEqual(expectedListing);
          },
        );
      });

      describe('When a sequencer or stash replay brings changes outside the cone', () => {
        it.skipIf(!GIT_AVAILABLE).each(REPLAY_ROWS)(
          'Then $id leaves the same index tags, work tree and warning as git',
          async ({ seed, cone, prepare, afterSparse, target, gitArgs, operation, skipped }) => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, seed);
              prepare(dir);
              if (cone !== undefined) enableSparse(dir, { cone });
              afterSparse(dir);
              extraDirs.push(`${dir}-wt`);
            }

            // Act
            const git = gitExitOf(target(pair.peer), gitArgs);
            const run = await runTsgit(target(pair.ours), operation);

            // Assert
            expect(git.exitCode).toBe(0);
            expect(run.outcome).toEqual({ kind: 'ok' });
            expect(tagged(target(pair.ours))).toBe(tagged(target(pair.peer)));
            expect(listing(target(pair.ours))).toEqual(listing(target(pair.peer)));
            if (skipped !== undefined) expect(skippedPaths(target(pair.peer))).toEqual(skipped);
            const warned = leftWarnings(run.warnings);
            expect(warned).toHaveLength(leftWarning(git.stderr).length);
            for (const warning of warned) expect(git.stderr).toContain(`warning: ${warning}\n`);
          },
          ROW_TIMEOUT,
        );
      });

      describe('When a replay stops on a conflict with changes outside the cone', () => {
        const conflictRow = async ({
          seed,
          prepare,
          afterSparse,
          gitArgs,
          operation,
        }: ConflictRow) => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            seedTwin(dir, ignoreCase, seed);
            prepare(dir);
            enableSparse(dir, { cone: true });
            afterSparse(dir);
          }

          // Act
          const git = gitExitOf(pair.peer, gitArgs);
          const run = await runTsgit(pair.ours, operation);

          // Assert
          expect(git.exitCode).toBe(1);
          expect(tagged(pair.ours)).toBe(tagged(pair.peer));
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          const warned = leftWarnings(run.warnings);
          expect(warned).toHaveLength(leftWarning(git.stderr).length);
          for (const warning of warned) expect(git.stderr).toContain(`warning: ${warning}\n`);
        };

        it.skipIf(!GIT_AVAILABLE).each(CONFLICT_ROWS.filter((row) => !row.skipOnWindows))(
          'Then $id leaves the same index tags and work tree as git',
          conflictRow,
          ROW_TIMEOUT,
        );

        it
          .skipIf(!GIT_AVAILABLE || process.platform === 'win32')
          .each(CONFLICT_ROWS.filter((row) => row.skipOnWindows))(
          'Then $id leaves the same index tags and work tree as git',
          conflictRow,
          ROW_TIMEOUT,
        );
      });

      describe('When pull fast-forwards onto a differently cased cone directory', () => {
        it(
          'Then case-pull leaves the same index tags and work tree as git',
          async () => {
            // Arrange
            const originRoot = mkdtempSync(
              join(os.tmpdir(), 'tsgit-interop-sequencer-sparse-origin-'),
            );
            extraDirs.push(originRoot);
            const originPath = join(originRoot, 'origin.git');
            runGit(['init', '-q', '--bare', '-b', 'main', originPath]);
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, CASE_SEED);
              enableSparse(dir, { cone: true });
            }
            runGit(['-C', pair.peer, 'push', '-q', originPath, 'refs/heads/other:refs/heads/main']);
            runGit(['-C', pair.peer, 'remote', 'add', 'origin', originPath]);
            runGit(['-C', pair.ours, 'remote', 'add', 'origin', ORIGIN_URL]);
            const warnings: string[] = [];
            const ctx = {
              ...createTrackedNodeContext({ workDir: pair.ours }),
              transport: backendTransport(originRoot),
              logger: { warn: (message: string) => warnings.push(message) },
            };

            // Act
            const git = gitExitOf(pair.peer, ['pull', '-q', 'origin', 'main']);
            const outcome = await outcomeOf(() => pull(ctx, { remote: 'origin', ref: 'main' }));

            // Assert
            expect(git.exitCode).toBe(0);
            expect(outcome).toEqual({ kind: 'ok' });
            expect(tagged(pair.ours)).toBe(tagged(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(listing(pair.ours)).toEqual(expectedCaseListing(ignoreCase));
            expect(leftWarnings(warnings)).toEqual(leftWarning(git.stderr));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
