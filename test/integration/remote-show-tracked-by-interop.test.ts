/**
 * Cross-tool interop — which local branches `remote show` reports as merging
 * from a remote, and with which values. Every row configures `branch.<b>.*`
 * keys in one real repository, reads canonical git's "configured for 'git
 * pull'" block from `git remote show -n`, and compares it against the pairs
 * rebuilt from tsgit's structured `trackedBy`.
 *
 * @proves
 *   surface:        remote.show
 *   bucket:         cross-tool-interop
 *   unique:         trackedBy lists every branch.<b>.merge value, split on spaces,
 *                    and omits a branch that names the remote but merges nothing
 *   interopSurface: remote
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { remoteShow } from '../../src/application/commands/remote.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const HEADS = 'refs/heads/';

interface TrackedPair {
  readonly branch: string;
  readonly merges: ReadonlyArray<string>;
}

interface Row {
  readonly label: string;
  readonly config: ReadonlyArray<ReadonlyArray<string>>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'a branch whose merge key holds two values',
    config: [
      ['branch.b.remote', 'origin'],
      ['branch.b.merge', 'refs/heads/one'],
      ['--add', 'branch.b.merge', 'refs/heads/two'],
    ],
  },
  {
    label: 'a branch whose merge value holds space-separated names',
    config: [
      ['branch.b.remote', 'origin'],
      ['branch.b.merge', 'refs/heads/one refs/heads/two  three'],
    ],
  },
  {
    label: 'a branch naming the remote without any merge value',
    config: [
      ['branch.b.remote', 'origin'],
      ['branch.b.merge', 'refs/heads/one'],
      ['branch.c.remote', 'origin'],
    ],
  },
];

const abbreviate = (name: string): string =>
  name.startsWith(HEADS) ? name.slice(HEADS.length) : name;

/** git's "Local branch(es) configured for 'git pull'" block, one pair per branch. */
const gitPullBlock = (stdout: string): ReadonlyArray<TrackedPair> => {
  const pairs: { branch: string; merges: string[] }[] = [];
  for (const line of stdout.split('\n')) {
    const first = /^ {4}(\S+) +merges with remote (.*)$/.exec(line);
    if (first !== null) pairs.push({ branch: first[1] ?? '', merges: [first[2] ?? ''] });
    const next = /^ +and with remote (.*)$/.exec(line);
    if (next !== null) pairs.at(-1)?.merges.push(next[1] ?? '');
  }
  return pairs;
};

describe.skipIf(!GIT_AVAILABLE)('remote show trackedBy interop', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe.each(ROWS)('Given $label', ({ config }) => {
    describe('When both tools show the remote without querying it', () => {
      it(
        'Then tsgit reports the branches and merge values git lists',
        async () => {
          // Arrange
          const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-remote-show-'));
          dirs.push(root);
          runGit(['init', '-q', '-b', 'main', root]);
          git(root, 'remote', 'add', 'origin', 'https://example.com/x.git');
          for (const args of config) git(root, 'config', ...args);
          const repo = await openRepository({ cwd: root });
          const sut = remoteShow;

          // Act
          const gitPairs = gitPullBlock(git(root, 'remote', 'show', '-n', 'origin'));
          const result = await sut(repo.ctx, { name: 'origin' });

          // Assert
          const ours = result.remote.trackedBy.map((entry) => ({
            branch: abbreviate(entry.branch),
            merges: entry.merge.map(abbreviate),
          }));
          expect(ours).toEqual(gitPairs);
          expect(gitPairs.length).toBeGreaterThan(0);
        },
        ROW_TIMEOUT,
      );
    });
  });
});
