/**
 * Cross-tool interop — `merge`'s default message. One history is built with
 * canonical git, copied, then merged by `git merge --no-edit` in one copy and
 * `repo.merge.run` (no message) in the other under a pinned identity and date:
 * the merge commit SHAs must agree, and a conflicted merge's MERGE_MSG bytes too.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         merge records git's fmt_merge_msg default message byte for byte
 *   interopSurface: merge
 */
import { existsSync } from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
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

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_AUTHOR_DATE: `${IDENTITY.timestamp} ${IDENTITY.timezoneOffset}`,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  GIT_COMMITTER_DATE: `${IDENTITY.timestamp} ${IDENTITY.timezoneOffset}`,
};

const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: COMMIT_ENV }).trim();

/** base; feature adds b and is tagged `lt`, `at` (annotated) and `refs/custom/at`; main adds c. */
const buildHistory = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'on-feature');
  git(dir, 'tag', 'lt');
  git(dir, 'tag', '-a', '-m', 'tag body line', 'at');
  git(dir, 'update-ref', 'refs/custom/at', 'at');
  git(dir, 'update-ref', 'refs/remotes/origin/feature', 'feature');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'on-main');
};

describe.skipIf(!GIT_AVAILABLE)('merge interop — default message', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('merge-message');
    buildHistory(pair.peer);
    await cp(pair.peer, pair.ours, { recursive: true });
  });

  afterEach(async () => {
    await pair.dispose();
  });

  /** HEAD after each tool merges `rev` into `branch` with no message. */
  const mergeBoth = async (rev: string, branch: string): Promise<readonly [string, string]> => {
    for (const dir of [pair.peer, pair.ours]) git(dir, 'checkout', '-q', '-B', branch, 'main');
    git(pair.peer, 'merge', '-q', '--no-edit', rev);
    const repo = await openRepository({ cwd: pair.ours });
    try {
      await repo.merge.run({ rev, author: IDENTITY, committer: IDENTITY });
    } finally {
      await repo.dispose();
    }
    return [git(pair.ours, 'rev-parse', 'HEAD'), git(pair.peer, 'rev-parse', 'HEAD')];
  };

  describe.each([
    ['a local branch into main', 'feature', 'main'],
    ['a local branch into another branch', 'feature', 'topic'],
    ['a branch by its full ref', 'refs/heads/feature', 'main'],
    ['a lightweight tag', 'lt', 'main'],
    ['an annotated tag', 'at', 'main'],
    ['an annotated tag through an unlabelled ref', 'refs/custom/at', 'main'],
    ['a remote-tracking branch', 'origin/feature', 'main'],
  ])('Given %s', (_label, rev, branch) => {
    describe('When both tools merge it without a message', () => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        const [result, expected] = await sut(rev, branch);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a branch diverged from main', () => {
    describe('When both tools merge it', () => {
      it("Then HEAD's and main's reflogs record git's strategy note", async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        await sut('feature', 'main');

        // Assert
        const subjects = (dir: string) =>
          ['HEAD', 'main'].map((ref) => git(dir, 'reflog', '-1', '--format=%gs', ref));
        expect(subjects(pair.ours)).toEqual(subjects(pair.peer));
      });
    });
  });

  describe('Given the feature commit named by its full and abbreviated id', () => {
    describe.each([
      ['full', 40],
      ['abbreviated', 7],
    ])('When both tools merge its %s id without a message', (_label, width) => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        const rev = git(pair.peer, 'rev-parse', 'feature').slice(0, width);
        const sut = mergeBoth;

        // Act
        const [result, expected] = await sut(rev, 'main');

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given merge.suppressDest set to a glob matching the destination', () => {
    describe('When both tools merge into it without a message', () => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) git(dir, 'config', 'merge.suppressDest', 'top*');
        const sut = mergeBoth;

        // Act
        const [result, expected] = await sut('feature', 'topic');

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  /** HEAD after each tool merges `rev` into main, git with `args`, tsgit with `input`. */
  const mergeBothWith = async (
    rev: string,
    args: ReadonlyArray<string>,
    input: { readonly message?: string; readonly log?: boolean | number },
  ): Promise<readonly [string, string]> => {
    git(pair.peer, 'merge', '-q', '--no-edit', ...args, rev);
    const repo = await openRepository({ cwd: pair.ours });
    try {
      await repo.merge.run({ rev, ...input, author: IDENTITY, committer: IDENTITY });
    } finally {
      await repo.dispose();
    }
    return [git(pair.ours, 'rev-parse', 'HEAD'), git(pair.peer, 'rev-parse', 'HEAD')];
  };

  describe.each([
    ['merge.log = true', [['merge.log', 'true']], 'feature', [], {}],
    ['merge.summary = 1', [['merge.summary', '1']], 'feature', [], {}],
    ['log: 1 over two commits', [], 'feature', ['--log=1'], { log: 1 }],
    ['log: false over merge.log', [['merge.log', 'true']], 'feature', ['--no-log'], { log: false }],
    [
      'a message and log: true',
      [],
      'feature',
      ['-m', 'custom', '--log'],
      { message: 'custom', log: true },
    ],
    [
      'merge.branchdesc and a description',
      [
        ['merge.branchdesc', 'true'],
        ['branch.feature.description', 'line1\nline2'],
      ],
      'feature',
      ['--log'],
      { log: true },
    ],
    ['an annotated tag and log: true', [], 'at', ['--log'], { log: true }],
    ['an ancestor spelling and log: true', [], 'feature~1', ['--log'], { log: true }],
  ] as const)('Given %s', (_label, config, rev, args, input) => {
    describe('When both tools merge with a shortlog', () => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          for (const [key, value] of config) git(dir, 'config', key, value);
          git(dir, 'checkout', '-q', 'feature');
          git(dir, 'commit', '-q', '--allow-empty', '-m', 'second on feature');
          git(dir, 'checkout', '-q', 'main');
        }
        const sut = mergeBothWith;

        // Act
        const [result, expected] = await sut(rev, args, input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each([
    ['diverged from', 'main'],
    ['fast-forwardable to', 'main~1'],
  ])('Given HEAD %s a branch with two commits', (_label, start) => {
    describe('When both tools squash-merge it and then commit', () => {
      it('Then SQUASH_MSG, the index, HEAD and the concluding commit are identical', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          git(dir, 'checkout', '-q', 'feature');
          git(dir, 'commit', '-q', '--allow-empty', '-m', 'second on feature', '-m', 'body');
          git(dir, 'checkout', '-q', '-B', 'topic', start);
        }
        tryRunGit(['-C', pair.peer, 'merge', '-q', '--squash', 'feature'], { env: COMMIT_ENV });
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        await sut({ rev: 'feature', squash: true, author: IDENTITY, committer: IDENTITY });
        const snapshot = async (dir: string) => [
          await readFile(path.join(dir, '.git', 'SQUASH_MSG'), 'utf8'),
          git(dir, 'write-tree'),
          git(dir, 'rev-parse', 'HEAD'),
        ];
        const [result, expected] = [await snapshot(pair.ours), await snapshot(pair.peer)];
        git(pair.peer, 'commit', '-q', '--allow-empty', '-m', 'squashed');
        await repo.commit({
          message: 'squashed',
          allowEmpty: true,
          author: IDENTITY,
          committer: IDENTITY,
        });
        await repo.dispose();

        // Assert
        expect(result).toEqual(expected);
        expect(git(pair.ours, 'rev-parse', 'HEAD')).toBe(git(pair.peer, 'rev-parse', 'HEAD'));
      });
    });
  });

  describe.each([
    ['feat**', 'feat/x'],
    ['feat*', 'feat/x'],
    ['ma[i]n2', 'main2'],
    ['ma[!x]n2', 'main2'],
    ['ma[[:alpha:]]n2', 'main2'],
    ['ma\\in2', 'main2'],
    ['a[/]b', 'a/b'],
    ['a/**/c', 'a/c'],
    ['**/c', 'x/y/c'],
  ])('Given merge.suppressDest %j and the destination %j', (pattern, branch) => {
    describe('When both tools merge into it without a message', () => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) git(dir, 'config', 'merge.suppressDest', pattern);
        const sut = mergeBoth;

        // Act
        const [result, expected] = await sut('feature', branch);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given signed and unsigned annotated tags verified by a stub gpg program', () => {
    const STUB_VERIFIER = '#!/bin/sh\necho "gpg: stub verifier report" >&2\nexit 1\n';
    /** Verifies nothing, and signs every payload with one fixed armor. */
    const STUB_SIGNER = [
      '#!/bin/sh',
      'for a in "$@"; do [ "$a" = --verify ] && { echo "gpg: stub verifier report" >&2; exit 1; }; done',
      'cat >/dev/null',
      'echo "[GNUPG:] SIG_CREATED D 1 8 00 1700000000 STUB" >&2',
      "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'",
      '',
    ].join('\n');
    const TAGGER = 'tagger T <t@x> 1700000000 +0000\n';

    const signedTag = (dir: string, name: string, target: string, tagger: string): void => {
      const object = git(dir, 'rev-parse', target);
      const raw = `object ${object}\ntype commit\ntag ${name}\n${tagger}\n${name} body\n-----BEGIN PGP SIGNATURE-----\n\nAAAA${name}\n-----END PGP SIGNATURE-----\n`;
      const args = ['-C', dir, 'hash-object', '-t', 'tag', '-w', '--literally', '--stdin'];
      git(dir, 'update-ref', `refs/tags/${name}`, runGit(args, { input: raw }).trim());
    };

    /** s1..s3 off main's parent; t1 signed on s1, t2 plain annotated on s2, t3 signed without a tagger on s3. */
    const tagBoth = async (): Promise<void> => {
      const verifier = path.join(pair.peer, '.git', 'stub-gpg');
      await writeFile(verifier, STUB_VERIFIER, { mode: 0o755 });
      for (const dir of [pair.peer, pair.ours]) {
        for (const branch of ['s1', 's2', 's3']) {
          git(dir, 'checkout', '-q', '-b', branch, 'main~1');
          git(dir, 'commit', '-q', '--allow-empty', '-m', `on-${branch}`);
        }
        git(dir, 'checkout', '-q', 'main');
        git(dir, 'config', 'gpg.program', verifier);
        signedTag(dir, 't1', 's1', TAGGER);
        git(dir, 'tag', '-a', '-m', 'plain annotated', 't2', 's2');
        signedTag(dir, 't3', 's3', '');
        signedTag(dir, 'th', 'main', TAGGER);
      }
    };

    describe.each([
      [['t1']],
      [['t1', 't2']],
      [['t2', 't1']],
      [['t3']],
      [['t1', 't2', 't3']],
      [['t1', 's1']],
      [['s1', 't1']],
      [['th', 's1']],
    ])('When both tools merge %j without a message', (revs) => {
      it('Then the merge commits, mergetag headers included, are identical', async () => {
        // Arrange
        await tagBoth();
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        git(pair.peer, 'merge', '-q', '--no-edit', ...revs);
        await sut({ rev: revs, author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(git(pair.ours, 'rev-parse', 'HEAD')).toBe(git(pair.peer, 'rev-parse', 'HEAD'));
      });
    });

    describe('When both tools sign the merge of a signed tag', () => {
      it('Then the signature follows the mergetag and the merge commits are identical', async () => {
        // Arrange
        await tagBoth();
        const signer = path.join(pair.peer, '.git', 'stub-signer');
        await writeFile(signer, STUB_SIGNER, { mode: 0o755 });
        for (const dir of [pair.peer, pair.ours]) git(dir, 'config', 'gpg.program', signer);
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        git(pair.peer, 'merge', '-q', '-S', '--no-edit', 't1');
        await sut({ rev: 't1', sign: true, author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(git(pair.ours, 'rev-parse', 'HEAD')).toBe(git(pair.peer, 'rev-parse', 'HEAD'));
      });
    });
  });

  describe('Given squash with --no-ff', () => {
    describe('When both tools merge', () => {
      it('Then both refuse before writing ORIG_HEAD', async () => {
        // Arrange
        const theirs = tryRunGit(['-C', pair.peer, 'merge', '--squash', '--no-ff', 'feature'], {
          env: COMMIT_ENV,
        });
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        const result = await sut({ rev: 'feature', squash: true, fastForward: 'never' }).catch(
          (e: unknown) => (e as { data: unknown }).data,
        );
        await repo.dispose();

        // Assert
        expect(theirs.stderr).toContain(
          "options '--squash' and '--no-ff.' cannot be used together",
        );
        expect(result).toEqual({ code: 'INCOMPATIBLE_OPTIONS', options: ['--squash', '--no-ff'] });
        expect(existsSync(path.join(pair.ours, '.git', 'ORIG_HEAD'))).toBe(
          existsSync(path.join(pair.peer, '.git', 'ORIG_HEAD')),
        );
      });
    });
  });

  describe('Given both sides change the same file', () => {
    describe('When both tools merge without a message and conflict', () => {
      it('Then MERGE_MSG is byte-identical', async () => {
        // Arrange
        const commitFile = async (dir: string, branch: string, content: string) => {
          git(dir, 'checkout', '-q', branch);
          await writeFile(path.join(dir, 'z.txt'), content);
          git(dir, 'add', 'z.txt');
          git(dir, 'commit', '-q', '-m', `z on ${branch}`);
        };
        for (const dir of [pair.peer, pair.ours]) {
          await commitFile(dir, 'feature', 'theirs\n');
          await commitFile(dir, 'main', 'ours\n');
        }
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        tryRunGit(['-C', pair.peer, 'merge', '-q', '--no-edit', 'feature'], { env: COMMIT_ENV });
        await sut({ rev: 'feature', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        const read = (dir: string) => readFile(path.join(dir, '.git', 'MERGE_MSG'), 'utf8');
        expect(await read(pair.ours)).toBe(await read(pair.peer));
      });
    });
  });
});
