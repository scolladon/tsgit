/**
 * Cross-tool interop — git's `<branch>@{upstream}` / `@{u}` / `@{push}` marks
 * read by tsgit's revision resolver and the commands taking a revision, over
 * one repository git configured: the same objects, and git's refusal for a
 * mark naming no ref, rebuilt from tsgit's structured reason.
 *
 * @proves
 *   surface:        revParse, log, revList, checkout, reset, branch.create, merge.run
 *   bucket:         cross-tool-interop
 *   unique:         a branch mark resolves through branch.<b>.merge, the push remote and push.default to the ref git names, and refuses as git does
 *   interopSurface: revParse
 */
import { cp } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const IDENTITY: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: ENV }).trim();

/**
 * main: base → tip, side: base → s; origin/main at base and origin/side at
 * tip; main and side track origin, `dot` tracks side locally, `tagged` a tag,
 * `nou` nothing; HEAD went main → side → main.
 */
const build = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 's');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'tip');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'main~1');
  git(dir, 'update-ref', 'refs/remotes/origin/side', 'main');
  for (const branch of ['nou', 'dot', 'tagged']) git(dir, 'branch', branch, 'main~1');
  const config: ReadonlyArray<readonly [string, string]> = [
    ['remote.origin.url', '/nowhere'],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['branch.main.remote', 'origin'],
    ['branch.main.merge', 'refs/heads/main'],
    ['branch.side.remote', 'origin'],
    ['branch.side.merge', 'refs/heads/side'],
    ['branch.dot.remote', '.'],
    ['branch.dot.merge', 'refs/heads/side'],
    ['branch.tagged.remote', 'origin'],
    ['branch.tagged.merge', 'refs/tags/x'],
  ];
  for (const [key, value] of config) git(dir, 'config', key, value);
  git(dir, 'checkout', '-q', 'side');
  git(dir, 'checkout', '-q', 'main');
};

type Failure = { readonly code: string; readonly reason: string } & Readonly<
  Record<string, string>
>;

/** git's die message for each structured reason. */
const gitMessage = (failure: Failure): string =>
  ({
    'detached-head': 'HEAD does not point to a branch',
    'no-such-branch': `no such branch: '${failure.branch}'`,
    'no-upstream': `no upstream configured for branch '${failure.branch}'`,
    'upstream-not-tracked': `upstream branch '${failure.upstream}' not stored as a remote-tracking branch`,
    'push-refspecs-exclude-branch': `push refspecs for '${failure.remote}' do not include '${failure.branch}'`,
    'push-destination-untracked': `push destination '${failure.destination}' on remote '${failure.remote}' has no local tracking branch`,
    'push-default-nothing': "push has no destination (push.default is 'nothing')",
    'simple-push-ambiguous': "cannot resolve 'simple' push to a single destination",
  })[failure.reason] ?? failure.reason;

describe.skipIf(!GIT_AVAILABLE)('branch mark interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('branch-mark');
    build(pair.peer);
    await cp(pair.peer, pair.ours, { recursive: true });
  });
  afterEach(async () => {
    await pair.dispose();
  });

  const configure = (config: ReadonlyArray<readonly [string, string]>): void => {
    for (const dir of [pair.peer, pair.ours]) {
      for (const [key, value] of config) git(dir, 'config', key, value);
    }
  };

  describe.each([
    ['@{u}', []],
    ['@{UpStream}', []],
    ['main@{u}', []],
    ['HEAD@{upstream}', []],
    ['side@{upstream}', []],
    ['dot@{u}', []],
    ['@{u}~0', []],
    ['main@{u}@{0}', []],
    ['@{-1}@{u}', []],
    ['@{push}', []],
    ['side@{push}', []],
    ['main@{push}', [['push.default', 'current']]],
    [
      'main@{push}',
      [
        ['push.default', 'upstream'],
        ['remote.pushDefault', 'fork'],
      ],
    ],
    [
      'main@{push}',
      [
        ['push.default', 'current'],
        ['remote.pushDefault', 'fork'],
        ['remote.fork.fetch', '+refs/heads/*:refs/remotes/fork/*'],
        ['branch.main.pushRemote', 'origin'],
      ],
    ],
    ['main@{push}', [['remote.origin.push', 'refs/heads/main:refs/heads/side']]],
  ] as const)('Given %j under %j', (expression, config) => {
    describe('When both tools resolve it', () => {
      it('Then tsgit names the object git does', async () => {
        // Arrange
        configure(config);
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.revParse;

        // Act
        const result = await sut(expression);
        await repo.dispose();

        // Assert
        const id = git(pair.peer, 'rev-parse', expression);
        expect(result).toEqual([{ kind: 'object', id, negated: false }]);
      });
    });
  });

  describe.each([
    ['nou@{u}', [], false],
    ['missing@{u}', [], false],
    ['tagged@{u}', [], false],
    ['nou@{push}', [], false],
    ['@{u}', [], true],
    ['@{push}', [], true],
    ['main@{push}', [['push.default', 'nothing']], false],
    ['side@{push}', [['remote.origin.push', 'refs/heads/main:refs/heads/x']], false],
    [
      'main@{push}',
      [
        ['push.default', 'current'],
        ['remote.pushDefault', 'fork'],
      ],
      false,
    ],
    [
      'nou@{push}',
      [
        ['branch.nou.remote', 'origin'],
        ['branch.nou.merge', 'refs/heads/main'],
      ],
      false,
    ],
  ] as const)('Given %j under %j (detached: %s)', (expression, config, detached) => {
    describe('When both tools resolve it', () => {
      it('Then tsgit refuses for the reason git dies with', async () => {
        // Arrange
        configure(config);
        if (detached)
          for (const dir of [pair.peer, pair.ours]) git(dir, 'checkout', '-q', '--detach');
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.revParse;

        // Act
        const result = await sut(expression).catch(
          (error: unknown) => (error as { data: Failure }).data,
        );
        await repo.dispose();

        // Assert
        const theirs = tryRunGit(['-C', pair.peer, 'rev-parse', expression], { env: ENV });
        expect(theirs.stderr).toContain(`fatal: ${gitMessage(result as Failure)}`);
        expect((result as Failure).code).toBe('BRANCH_MARK_UNRESOLVED');
      });
    });
  });

  describe('Given main ahead of its upstream', () => {
    describe('When both tools walk HEAD excluding @{u}', () => {
      it('Then log and revList list the commits git does', async () => {
        // Arrange
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        const logged = await repo.log({ rev: 'HEAD', excluding: ['@{u}'] });
        const listed = await repo.revList({ wants: ['HEAD'], not: ['@{u}'] });
        await repo.dispose();

        // Assert
        const expected = git(pair.peer, 'rev-list', '@{u}..HEAD').split('\n');
        expect(logged.map((entry) => entry.id)).toEqual(expected);
        expect(listed.entries.map((entry) => entry.id)).toEqual(expected);
      });
    });

    describe.each([
      ['checkout', ['checkout', '-q', '@{u}']],
      ['reset --hard', ['reset', '-q', '--hard', '@{u}']],
      ['branch', ['branch', 'x', '@{u}']],
      ['merge', ['merge', '-q', '--no-edit', '--no-ff', '@{u}']],
    ] as const)('When both tools %s @{u}', (command, args) => {
      it('Then HEAD, the refs and the config are identical', async () => {
        // Arrange
        const upstream = command === 'merge' ? 'side' : 'main~1';
        for (const dir of [pair.peer, pair.ours]) {
          git(dir, 'update-ref', 'refs/remotes/origin/main', upstream);
        }
        git(pair.peer, ...args);
        const repo = await openRepository({ cwd: pair.ours });
        const runs: Record<string, () => Promise<unknown>> = {
          checkout: () => repo.checkout({ rev: '@{u}' }),
          'reset --hard': () => repo.reset({ rev: '@{u}', mode: 'hard' }),
          branch: () => repo.branch.create({ name: 'x', startPoint: '@{u}' }),
          merge: () =>
            repo.merge.run({
              rev: '@{u}',
              fastForward: 'never',
              author: IDENTITY,
              committer: IDENTITY,
            }),
        };
        const sut = runs[command]!;

        // Act
        await sut();
        await repo.dispose();

        // Assert
        const state = (dir: string) => [
          git(dir, 'rev-parse', 'HEAD'),
          git(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
          git(dir, 'config', '--get-regexp', '^branch\\.'),
        ];
        expect(state(pair.ours)).toEqual(state(pair.peer));
      });
    });
  });
});
