/**
 * Cross-tool interop — `merge` revision forms. Each tool merges the same
 * revision spelling into a copy of one git-built repository; the recorded
 * message and parent count must agree.
 *
 * @proves
 *   surface:        merge
 *   bucket:         cross-tool-interop
 *   unique:         merge names tag oids, ancestor spellings and @{-1} as git does, and merges into a detached HEAD
 *   interopSurface: merge
 */
import { spawnSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const DATE = '1700000000 +0000';
const ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: DATE,
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: DATE,
};

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const gitIn = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: ENV });

describe.skipIf(!GIT_AVAILABLE)('merge revision forms interop', () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('merge-forms');
    repo = undefined;
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const commitFile = async (file: string): Promise<void> => {
    await writeFile(path.join(pair.peer, file), `${file}\n`);
    gitIn(pair.peer, 'add', file);
    gitIn(pair.peer, 'commit', '-q', '-m', file);
  };

  /** base; side: g, h + annotated v1; main: m — then side was visited and left. */
  const seed = async (): Promise<string> => {
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    for (const [key, value] of [
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['user.name', 'Ada'],
      ['user.email', 'ada@example.com'],
    ]) {
      gitIn(pair.peer, 'config', key ?? '', value ?? '');
    }
    await commitFile('f');
    gitIn(pair.peer, 'checkout', '-q', '-b', 'side');
    await commitFile('g');
    await commitFile('h');
    gitIn(pair.peer, 'tag', '-a', 'v1', '-m', 'v1');
    gitIn(pair.peer, 'checkout', '-q', 'main');
    await commitFile('m');
    gitIn(pair.peer, 'checkout', '-q', 'side');
    gitIn(pair.peer, 'checkout', '-q', 'main');
    return gitIn(pair.peer, 'rev-parse', 'v1').trim();
  };

  const tipOf = (dir: string): string => gitIn(dir, 'log', '-1', '--format=%P%n%B');

  describe.each([
    ['the full annotated-tag oid', (tag: string) => tag],
    ['an abbreviated annotated-tag oid', (tag: string) => tag.slice(0, 7)],
    ['<branch>~1', () => 'side~1'],
    ['<branch>^', () => 'side^'],
    ['<branch>~0', () => 'side~0'],
    ['@{-1}', () => '@{-1}'],
    ['-', () => '-'],
  ])('Given %s', (_label, argOf) => {
    describe('When both tools merge it', () => {
      it('Then both record the same parents and message', async () => {
        // Arrange
        const tag = await seed();
        await cp(pair.peer, pair.ours, { recursive: true });
        repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        gitIn(pair.peer, 'merge', '-q', '--no-edit', argOf(tag));
        await sut({ rev: argOf(tag), author: AUTHOR });

        // Assert
        const result = tipOf(pair.ours);
        expect(result).toBe(tipOf(pair.peer));
      });
    });
  });

  describe.each([
    ['renamed away from its own name', ['tag', '-d', 'v1']],
    ['whose own name is a lightweight tag of its commit', ['tag', '-f', 'v1', 'side']],
    ['still under its own name', ['tag', '-l']],
  ])('Given an annotated tag also reachable as other, %s', (_label, retag) => {
    describe('When both tools merge it into a branch it fast-forwards', () => {
      it('Then both land HEAD on the same commit', async () => {
        // Arrange
        await seed();
        gitIn(pair.peer, 'update-ref', 'refs/tags/other', 'v1');
        gitIn(pair.peer, ...retag);
        gitIn(pair.peer, 'checkout', '-q', '-b', 'behind', 'main~1');
        await cp(pair.peer, pair.ours, { recursive: true });
        repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        gitIn(pair.peer, 'merge', '-q', '--no-edit', 'other');
        await sut({ rev: 'other', author: AUTHOR, committer: AUTHOR });

        // Assert
        const result = tipOf(pair.ours);
        expect(result).toBe(tipOf(pair.peer));
        expect(gitIn(pair.ours, 'rev-parse', 'HEAD')).toBe(gitIn(pair.peer, 'rev-parse', 'HEAD'));
      });
    });
  });

  describe('Given a renamed annotated tag that conflicts with HEAD', () => {
    describe('When both tools merge it and stop', () => {
      it('Then both record the no-ff merge mode', async () => {
        // Arrange
        await seed();
        gitIn(pair.peer, 'update-ref', 'refs/tags/other', 'v1');
        gitIn(pair.peer, 'tag', '-d', 'v1');
        await writeFile(path.join(pair.peer, 'g'), 'main g\n');
        gitIn(pair.peer, 'add', 'g');
        gitIn(pair.peer, 'commit', '-q', '-m', 'main g');
        await cp(pair.peer, pair.ours, { recursive: true });
        repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;
        const mode = (dir: string): Promise<string> =>
          readFile(path.join(dir, '.git', 'MERGE_MODE'), 'utf8');

        // Act
        const git = spawnSync('git', ['-C', pair.peer, 'merge', '-q', '--no-edit', 'other'], {
          env: ENV,
        });
        const merged = await sut({ rev: 'other', author: AUTHOR, committer: AUTHOR });

        // Assert
        expect(git.status).toBe(1);
        expect(merged.kind).toBe('conflict');
        const result = await mode(pair.ours);
        expect(result).toBe(await mode(pair.peer));
      });
    });
  });

  /** HEAD's value, and the note its newest reflog entry carries. */
  const headState = async (dir: string): Promise<string> => {
    const gitDir = path.join(dir, '.git');
    const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8');
    const log = (await readFile(path.join(gitDir, 'logs', 'HEAD'), 'utf8')).trimEnd().split('\n');
    return `${head}${log.at(-1)?.split('\t')[1]}`;
  };

  describe.each([
    ['one branch', ['side']],
    ['two branches', ['side', 'other']],
  ])('Given a detached HEAD and %s', (_label, revs) => {
    describe('When both tools merge them', () => {
      it('Then HEAD stays detached at the same commit with the same reflog note', async () => {
        // Arrange
        await seed();
        gitIn(pair.peer, 'branch', 'other', 'main~1');
        gitIn(pair.peer, 'checkout', '-q', 'other');
        await commitFile('o');
        gitIn(pair.peer, 'checkout', '-q', '--detach', 'main');
        await cp(pair.peer, pair.ours, { recursive: true });
        repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        gitIn(pair.peer, 'merge', '-q', '--no-edit', ...revs);
        await sut({ rev: revs, author: AUTHOR, committer: AUTHOR });

        // Assert
        const result = await headState(pair.ours);
        expect(result).toBe(await headState(pair.peer));
        expect(tipOf(pair.ours)).toBe(tipOf(pair.peer));
      });
    });
  });
});
