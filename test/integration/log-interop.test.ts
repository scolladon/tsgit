/**
 * Cross-tool interop — converged `log`. Builds a diamond (merge of two branches,
 * strictly-increasing dates) plus an annotated tag via canonical `git`, then
 * opens the SAME repo through `openRepository` and proves `repo.log` projects
 * over the read model byte-for-byte against real `git`:
 *
 *   1. default order  — `repo.log()` oids === `git log --format=%H` (all parents,
 *      newest committer-date first — distinct from a first-parent walk);
 *   2. first-parent    — `repo.log({ order: 'first-parent' })` oids ===
 *      `git log --first-parent --format=%H`;
 *   3. annotated tag   — `repo.log({ rev: <tag> })` peels the tag to its commit,
 *      matching `git log --format=%H <tag>`;
 *   4. excluding range — `repo.log({ excluding: ['HEAD~2'] })` oids ===
 *      `git rev-list HEAD~2..HEAD` (a linear boundary where `until` ≡ git's `^`).
 *
 * Dates are strictly distinct and causally ordered, the regime where the lazy
 * `walkCommitsByDate` is byte-for-byte `--date-order` (ADR-261). A second
 * history puts every commit at ONE date, with and without a commit-graph, so
 * the order rests on git's queue tie-break alone (first enqueued pops first).
 *
 * @proves
 *   surface:        log, walkCommits
 *   bucket:         cross-tool-interop
 *   unique:         converged log order / first-parent / tag-peel / exclude vs git, walkCommits topo-order vs rev-list --topo-order
 *   interopSurface: log
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogOptions } from '../../src/application/commands/log.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { buildEqualDateHistory } from './equal-date-history-fixture.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

interface Scenario {
  readonly dir: string;
  readonly tag: string;
  readonly dispose: () => Promise<void>;
}

const oidLines = (out: string): ReadonlyArray<string> =>
  out.split('\n').filter((line) => line.length > 0);

/**
 * base ← b (main) and base ← c (side), merge(b, c); annotated tag `v1` over b.
 * Also adds a second orphan root (root2) and merges it with --allow-unrelated-histories
 * so --max-parents=0 returns >1 root (non-trivial).
 */
const buildScenario = async (): Promise<Scenario> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-log-interop-')));
  runGit(['init', '-q', '-b', 'main', dir]);

  const commit = async (epoch: number, file: string, message: string): Promise<void> => {
    await writeFile(path.join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(epoch) });
  };

  await commit(1700000001, 'base.txt', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  await commit(1700000002, 'b.txt', 'b on main');
  const b = git(dir, 'rev-parse', 'HEAD').trim();
  runGit(['-C', dir, 'tag', '-a', 'v1', '-m', 'tag b', b], { env: dateEnv(1700000002) });
  runGit(['-C', dir, 'checkout', '-q', '-b', 'side', base]);
  await commit(1700000003, 'c.txt', 'c on side');
  git(dir, 'checkout', '-q', 'main');
  runGit(['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
    env: dateEnv(1700000004),
  });

  // Second orphan root — makes --max-parents=0 return >1 root (non-trivial fixture)
  runGit(['-C', dir, 'checkout', '-q', '--orphan', 'root2']);
  runGit(['-C', dir, 'rm', '-q', '-rf', '.']);
  await commit(1700000005, 'root2.txt', 'root2');
  git(dir, 'checkout', '-q', 'main');
  runGit(
    [
      '-C',
      dir,
      'merge',
      '-q',
      '--no-ff',
      '--allow-unrelated-histories',
      '-m',
      'merge root2',
      'root2',
    ],
    {
      env: dateEnv(1700000006),
    },
  );

  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, tag: 'v1', dispose };
};

const MISSING_PARENT_EPOCH = 1_700_000_000;

interface MissingFirstParent {
  readonly dir: string;
  readonly merge: string;
  readonly firstParent: string;
  readonly dispose: () => Promise<void>;
}

/** merge(p, q) on HEAD, then p's loose object deleted — after an optional graph write. */
const buildMissingFirstParent = async (withCommitGraph: boolean): Promise<MissingFirstParent> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-log-missing-parent-')));
  runGit(['init', '-q', '-b', 'main', dir]);
  const tree = runGit(['-C', dir, 'mktree'], { input: '' }).trim();
  const commit = (message: string, parents: ReadonlyArray<string>): string =>
    runGit(['-C', dir, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
      env: dateEnv(MISSING_PARENT_EPOCH),
    }).trim();
  const firstParent = commit('p', []);
  const merge = commit('m', [firstParent, commit('q', [])]);
  git(dir, 'update-ref', 'refs/heads/main', merge);
  if (withCommitGraph) git(dir, 'commit-graph', 'write', '--reachable');
  await rm(path.join(dir, '.git', 'objects', firstParent.slice(0, 2), firstParent.slice(2)));
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, merge, firstParent, dispose };
};

interface OrderingHistory {
  readonly dir: string;
  readonly dispose: () => Promise<void>;
}

const OFFSET_EPOCH = 1_700_000_000;

/**
 * r ← a1 ← a2, r ← b1 ← b2 (b2 committed before b1), m = merge(a2, b2),
 * a1 ← c1, n = merge(m, c1) on `main`, author dates ordered unlike the
 * committer dates; plus f ← {g (newer), h (older)} merged as `held` — a
 * parent committed after one of its children.
 */
const buildOrderingHistory = async (withCommitGraph: boolean): Promise<OrderingHistory> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-log-ordering-')));
  runGit(['init', '-q', '-b', 'main', dir]);
  const tree = runGit(['-C', dir, 'mktree'], { input: '' }).trim();
  const commit = (
    message: string,
    parents: ReadonlyArray<string>,
    committed: number,
    authored = committed,
  ): string =>
    runGit(['-C', dir, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
      env: {
        ...dateEnv(OFFSET_EPOCH + committed),
        GIT_AUTHOR_DATE: `${OFFSET_EPOCH + authored} +0000`,
      },
    }).trim();
  const r = commit('r', [], 100);
  const a1 = commit('a1', [r], 200, 500);
  const a2 = commit('a2', [a1], 400, 300);
  const b1 = commit('b1', [r], 300, 200);
  const b2 = commit('b2', [b1], 150, 600);
  const m = commit('m', [a2, b2], 500, 100);
  const c1 = commit('c1', [a1], 450);
  git(dir, 'update-ref', 'refs/heads/main', commit('n', [m, c1], 600));
  const f = commit('f', [], 8);
  git(
    dir,
    'update-ref',
    'refs/heads/held',
    commit('e', [commit('g', [f], 9), commit('h', [f], 1)], 10),
  );
  if (withCommitGraph) git(dir, 'commit-graph', 'write', '--reachable');
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, dispose };
};

interface ExclusionHistory {
  readonly dir: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly dispose: () => Promise<void>;
}

/**
 * The ordering history's main line plus m2 = merge(b2, a1); and an
 * independent i ← x whose x is also reached from e3 / e6 through three /
 * six commits dated older than x — git's limited walk gives up on the
 * longer chain before it reaches x.
 */
type CommitFn = (message: string, parents: ReadonlyArray<string>, committed: number) => string;

/**
 * ta and tb share a date; tb ← tp ← tk1 … tk6 ← tg and tb ← ts ← tg, while
 * ta reaches tp through tm ← tn, tp's whole line dated before tg. Which of
 * ta and tb pops first decides whether tp is marked before it is shown.
 */
const buildTiedSeeds = (commit: CommitFn): { readonly ta: string; readonly tb: string } => {
  const tg = commit('tg', [], 98);
  let line = tg;
  for (let step = 6; step >= 1; step -= 1) line = commit(`tk${step}`, [line], 90);
  const tp = commit('tp', [line], 90);
  const ta = commit('ta', [commit('tm', [commit('tn', [tp], 90)], 90)], 100);
  return { ta, tb: commit('tb', [tp, commit('ts', [tg], 99)], 100) };
};

const buildExclusionHistory = async (withCommitGraph: boolean): Promise<ExclusionHistory> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-log-exclusion-')));
  runGit(['init', '-q', '-b', 'main', dir]);
  const tree = runGit(['-C', dir, 'mktree'], { input: '' }).trim();
  const commit: CommitFn = (message, parents, committed) =>
    runGit(['-C', dir, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
      env: dateEnv(OFFSET_EPOCH + committed),
    }).trim();
  const r = commit('r', [], 100);
  const a1 = commit('a1', [r], 200);
  const b1 = commit('b1', [r], 300);
  const b2 = commit('b2', [b1], 150);
  const c1 = commit('c1', [a1], 450);
  const m = commit('m', [commit('a2', [a1], 400), b2], 500);
  const x = commit('x', [], 500);
  const olderChain = (length: number): string => {
    let tip = x;
    for (let step = 1; step <= length; step += 1) tip = commit(`e${step}`, [tip], 300 - step);
    return commit('e', [tip], 400);
  };
  const ids = {
    n: commit('n', [m, c1], 600),
    m2: commit('m2', [b2, a1], 350),
    i: commit('i', [x], 1000),
    e3: olderChain(3),
    e6: olderChain(6),
    a1,
    b1,
    c1,
    ...buildTiedSeeds(commit),
  };
  for (const [name, id] of Object.entries(ids)) git(dir, 'update-ref', `refs/heads/${name}`, id);
  if (withCommitGraph) git(dir, 'commit-graph', 'write', '--reachable');
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, ids, dispose };
};

const EXCLUSION_RANGES: ReadonlyArray<{
  readonly tip: string;
  readonly excluded: ReadonlyArray<string>;
}> = [
  { tip: 'n', excluded: ['b1'] },
  { tip: 'n', excluded: ['a1'] },
  { tip: 'n', excluded: ['a1', 'b1'] },
  { tip: 'n', excluded: ['c1'] },
  { tip: 'n', excluded: ['m2'] },
  { tip: 'i', excluded: ['e3'] },
  { tip: 'i', excluded: ['e6'] },
  { tip: 'tb', excluded: ['ta'] },
];

const ORDERING_MATRIX: ReadonlyArray<{
  readonly flags: ReadonlyArray<string>;
  readonly opts: LogOptions;
}> = [
  { flags: ['--topo-order'], opts: { topoOrder: 'graph' } },
  { flags: ['--date-order'], opts: { topoOrder: 'commit-date' } },
  { flags: ['--author-date-order'], opts: { topoOrder: 'author-date' } },
  { flags: ['--reverse'], opts: { reverse: true } },
  { flags: ['--topo-order', '--reverse'], opts: { topoOrder: 'graph', reverse: true } },
  { flags: ['--date-order', '--reverse'], opts: { topoOrder: 'commit-date', reverse: true } },
  {
    flags: ['--author-date-order', '--reverse'],
    opts: { topoOrder: 'author-date', reverse: true },
  },
  {
    flags: ['--date-order', '-n', '4', '--reverse'],
    opts: { topoOrder: 'commit-date', limit: 4, reverse: true },
  },
  {
    flags: ['--first-parent', '--topo-order'],
    opts: { order: 'first-parent', topoOrder: 'graph' },
  },
];

const EXCLUSION_MODES: ReadonlyArray<{
  readonly flags: ReadonlyArray<string>;
  readonly opts: LogOptions;
}> = [
  { flags: [], opts: {} },
  { flags: ['--first-parent'], opts: { order: 'first-parent' } },
  { flags: ['-n', '2'], opts: { limit: 2 } },
  ...ORDERING_MATRIX,
];

const logIds = async (
  dir: string,
  opts?: Parameters<Awaited<ReturnType<typeof openRepository>>['log']>[0],
): Promise<ReadonlyArray<string>> => {
  const repo = await openRepository({ cwd: dir });
  try {
    return (await repo.log(opts)).map((entry) => entry.id);
  } finally {
    await repo.dispose();
  }
};

const topoOrderIds = async (
  dir: string,
  from: ReadonlyArray<string>,
  until: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string>> => {
  const repo = await openRepository({ cwd: dir });
  try {
    const ids: string[] = [];
    const walk = repo.primitives.walkCommits({
      from: from as ReadonlyArray<ObjectId>,
      until: until as ReadonlyArray<ObjectId>,
      order: 'topo-order',
    });
    for await (const commit of walk) ids.push(commit.id);
    return ids;
  } finally {
    await repo.dispose();
  }
};

interface LogOidSequenceScenario {
  readonly label: string;
  // The consuming command varies per row (log vs rev-list, distinct flags);
  // same journey (tsgit oid sequence === real-git oid sequence), same oracle.
  readonly gitArgs: (scenario: Scenario) => ReadonlyArray<string>;
  readonly opts: (scenario: Scenario) => LogOptions;
}

const LOG_OID_SEQUENCE_MATRIX: ReadonlyArray<LogOidSequenceScenario> = [
  {
    label: 'the oid sequence equals git log (all parents, date order)',
    gitArgs: () => ['log', '--format=%H'],
    opts: () => ({}),
  },
  {
    label: "the oid sequence equals git log --first-parent (order: 'first-parent')",
    gitArgs: () => ['log', '--first-parent', '--format=%H'],
    opts: () => ({ order: 'first-parent' }),
  },
  {
    label: 'it peels the tag and matches git log <tag>',
    gitArgs: (scenario) => ['log', '--format=%H', scenario.tag],
    opts: (scenario) => ({ rev: scenario.tag }),
  },
  {
    // HEAD~3 is `b on main`; excluding it leaves the top 3 commits.
    label: 'it matches git rev-list HEAD~3..HEAD (excluding a grammar selector)',
    gitArgs: () => ['rev-list', 'HEAD~3..HEAD'],
    opts: () => ({ excluding: ['HEAD~3'] }),
  },
  {
    // `c on side` is dated exactly at the boundary second; git keeps it.
    label: 'it matches git log --before at a commit date (boundary kept)',
    gitArgs: () => ['log', '--format=%H', '--before=@1700000003'],
    opts: () => ({ before: new Date(1700000003 * 1000) }),
  },
  {
    // scenario has two roots (base and root2); non-trivial set
    label: 'the oid sequence equals git rev-list --max-parents=0',
    gitArgs: () => ['rev-list', '--max-parents=0', 'HEAD'],
    opts: () => ({ maxParents: 0 }),
  },
  {
    // merges only
    label: 'the oid sequence equals git rev-list --min-parents=2',
    gitArgs: () => ['rev-list', '--min-parents=2', 'HEAD'],
    opts: () => ({ minParents: 2 }),
  },
  {
    // non-merges only
    label: 'the oid sequence equals git rev-list --max-parents=1',
    gitArgs: () => ['rev-list', '--max-parents=1', 'HEAD'],
    opts: () => ({ maxParents: 1 }),
  },
  {
    // non-roots only
    label: 'the oid sequence equals git rev-list --min-parents=1',
    gitArgs: () => ['rev-list', '--min-parents=1', 'HEAD'],
    opts: () => ({ minParents: 1 }),
  },
  {
    // filter applied before limit: newest non-merge commit — proves filter
    // precedes limit; result is a non-merge, not a merge
    label: 'the first result equals git rev-list --max-parents=1 -n 1 (filter-then-limit)',
    gitArgs: () => ['rev-list', '--max-parents=1', '-n', '1', 'HEAD'],
    opts: () => ({ maxParents: 1, limit: 1 }),
  },
  {
    // first-parent walk; merge commits still count >=2 parents even though
    // only first parent is followed during traversal
    label:
      "the oid sequence equals git rev-list --first-parent --min-parents=2 (order: 'first-parent')",
    gitArgs: () => ['rev-list', '--first-parent', '--min-parents=2', 'HEAD'],
    opts: () => ({ order: 'first-parent', minParents: 2 }),
  },
];

describe.skipIf(!GIT_AVAILABLE)('log interop', () => {
  describe('Given a diamond with a merge and an annotated tag', () => {
    describe('When log or rev-list runs with each oid-sequence variant', () => {
      it.each(LOG_OID_SEQUENCE_MATRIX)('Then $label', async ({ gitArgs, opts }) => {
        // Arrange
        const scenario = await buildScenario();
        try {
          const peer = oidLines(git(scenario.dir, ...gitArgs(scenario)));

          // Act
          const ours = await logIds(scenario.dir, opts(scenario));

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await scenario.dispose();
        }
      });
    });
  });

  describe('Given nested octopus merges whose commits all share one committer date', () => {
    describe.each([
      { graph: 'without a commit-graph', withCommitGraph: false },
      { graph: 'with a commit-graph', withCommitGraph: true },
    ])('When log runs $graph', ({ withCommitGraph }) => {
      it('Then the oid sequence equals git log', async () => {
        // Arrange
        const history = await buildEqualDateHistory({ withCommitGraph });
        try {
          const peer = oidLines(git(history.dir, 'log', '--format=%H'));

          // Act
          const ours = await logIds(history.dir);

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await history.dispose();
        }
      });
    });
  });
  describe('Given a merge whose first parent object is missing and no commit-graph', () => {
    describe('When the first first-parent entry is asked for', () => {
      it('Then both tools refuse on the parent before showing the merge', async () => {
        // Arrange
        const fixture = await buildMissingFirstParent(false);
        try {
          const peer = tryRunGitWithExit(
            ['-C', fixture.dir, 'log', '-1', '--first-parent', '--format=%H'],
            { env: runGitEnv() },
          );

          // Act
          const ours = logIds(fixture.dir, { order: 'first-parent', limit: 1 });

          // Assert
          expect(peer.exitCode).toBe(128);
          expect(peer.stderr).toContain(`Could not read ${fixture.firstParent}`);
          await expect(ours).rejects.toMatchObject({
            data: { code: 'OBJECT_NOT_FOUND', id: fixture.firstParent },
          });
        } finally {
          await fixture.dispose();
        }
      });
    });
  });

  describe('Given a merge whose first parent object is missing but sits in the commit-graph', () => {
    describe('When the first first-parent entry is asked for', () => {
      it('Then both tools show the merge, its parent parsed from the graph', async () => {
        // Arrange
        const fixture = await buildMissingFirstParent(true);
        try {
          const peer = oidLines(git(fixture.dir, 'log', '-1', '--first-parent', '--format=%H'));

          // Act
          const ours = await logIds(fixture.dir, { order: 'first-parent', limit: 1 });

          // Assert
          expect(ours).toEqual(peer);
          expect(ours).toEqual([fixture.merge]);
        } finally {
          await fixture.dispose();
        }
      });
    });
  });
  describe('Given a merge whose first parent object is missing but sits in the commit-graph', () => {
    describe('When every entry is asked for, each carrying its message', () => {
      it('Then both tools refuse on the parent whose body a message needs', async () => {
        // Arrange
        const fixture = await buildMissingFirstParent(true);
        try {
          const peer = tryRunGitWithExit(['-C', fixture.dir, 'log', '--format=%s'], {
            env: runGitEnv(),
          });

          // Act
          const ours = logIds(fixture.dir);

          // Assert
          expect(peer.exitCode).toBe(128);
          expect(peer.stderr).toContain(`cannot read commit object ${fixture.firstParent}`);
          await expect(ours).rejects.toMatchObject({
            data: { code: 'OBJECT_NOT_FOUND', id: fixture.firstParent },
          });
        } finally {
          await fixture.dispose();
        }
      });
    });
  });

  describe.each([
    { graph: 'without a commit-graph', withCommitGraph: false },
    { graph: 'with a commit-graph', withCommitGraph: true },
  ])('Given a skewed history with diverging author dates $graph', ({ withCommitGraph }) => {
    describe.each(['main', 'held'])('When log runs from %s with each ordering option', (rev) => {
      it.each(ORDERING_MATRIX)(
        'Then $flags orders the commits as git does',
        async ({ flags, opts }) => {
          // Arrange
          const history = await buildOrderingHistory(withCommitGraph);
          try {
            const peer = oidLines(git(history.dir, 'log', '--format=%H', ...flags, rev));

            // Act
            const ours = await logIds(history.dir, { ...opts, rev });

            // Assert
            expect(ours).toEqual(peer);
          } finally {
            await history.dispose();
          }
        },
      );
    });
  });

  describe.each([
    { graph: 'without a commit-graph', withCommitGraph: false },
    { graph: 'with a commit-graph', withCommitGraph: true },
  ])('Given a skewed history with diverging author dates $graph', ({ withCommitGraph }) => {
    describe.each([['main'], ['held'], ['held', 'main']])(
      'When walkCommits walks %s in topo-order',
      (...revs) => {
        it('Then the oid sequence equals git rev-list --topo-order', async () => {
          // Arrange
          const history = await buildOrderingHistory(withCommitGraph);
          try {
            const tips = revs.map((rev) => git(history.dir, 'rev-parse', rev).trim());
            const peer = oidLines(git(history.dir, 'rev-list', '--topo-order', ...tips));

            // Act
            const ours = await topoOrderIds(history.dir, tips);

            // Assert
            expect(ours).toEqual(peer);
          } finally {
            await history.dispose();
          }
        });
      },
    );
  });

  describe('Given nested octopus merges whose commits all share one committer date', () => {
    describe.each(ORDERING_MATRIX)('When log runs with $flags', ({ flags, opts }) => {
      it('Then the oid sequence equals git log', async () => {
        // Arrange
        const history = await buildEqualDateHistory({ withCommitGraph: false });
        try {
          const peer = oidLines(git(history.dir, 'log', '--format=%H', ...flags));

          // Act
          const ours = await logIds(history.dir, opts);

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await history.dispose();
        }
      });
    });
  });

  describe.each([
    { graph: 'without a commit-graph', withCommitGraph: false },
    { graph: 'with a commit-graph', withCommitGraph: true },
  ])(
    'Given histories where excluded commits share ancestors with the tip $graph',
    ({ withCommitGraph }) => {
      let history: ExclusionHistory;
      beforeAll(async () => {
        history = await buildExclusionHistory(withCommitGraph);
      });
      afterAll(async () => {
        await history.dispose();
      });

      describe.each(EXCLUSION_RANGES)(
        'When walkCommits walks $tip excluding $excluded in topo-order',
        ({ tip, excluded }) => {
          it('Then it yields what git rev-list --topo-order lists', async () => {
            // Arrange
            const until = excluded.map((name) => history.ids[name] as string);
            const from = [history.ids[tip] as string];
            const negations = until.map((id) => `^${id}`);
            const peer = oidLines(
              git(history.dir, 'rev-list', '--topo-order', ...from, ...negations),
            );

            // Act
            const ours = await topoOrderIds(history.dir, from, until);

            // Assert
            expect(ours).toEqual(peer);
          });
        },
      );

      describe.each(EXCLUSION_RANGES)(
        'When log walks $tip excluding $excluded',
        ({ tip, excluded }) => {
          it.each(EXCLUSION_MODES)(
            'Then $flags shows the commits git shows',
            async ({ flags, opts }) => {
              // Arrange
              const negations = excluded.map((name) => `^${history.ids[name]}`);
              const peer = oidLines(
                git(
                  history.dir,
                  'log',
                  '--format=%H',
                  ...flags,
                  history.ids[tip] as string,
                  ...negations,
                ),
              );

              // Act
              const ours = await logIds(history.dir, {
                ...opts,
                rev: history.ids[tip] as string,
                excluding: excluded.map((name) => history.ids[name] as string),
              });

              // Assert
              expect(ours).toEqual(peer);
            },
          );
        },
      );
    },
  );
});
