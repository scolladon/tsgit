/**
 * Cross-tool interop — `merge` revision forms. Each tool merges the same
 * revision spelling into a copy of one git-built repository; the recorded
 * message and parent count must agree.
 *
 * @proves
 *   surface:        merge
 *   bucket:         cross-tool-interop
 *   unique:         merge names tag oids, ancestor spellings and @{-1} as git does
 *   interopSurface: merge
 */
import { cp, writeFile } from 'node:fs/promises';
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
});
