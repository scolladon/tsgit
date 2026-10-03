/**
 * Cross-tool interop — `revParse`'s suffix grammar against `git rev-parse`.
 * One repository is built once with canonical git: three commits, a chain of
 * annotated tags each naming the previous one, and a tag naming an absent
 * object. Each row resolves the same argument through both and compares the
 * object id, or that neither resolves, and the `error:` lines each printed.
 *
 * @proves
 *   surface:        revParse
 *   bucket:         cross-tool-interop
 *   unique:         the ~, ^{}, ^{object} and ^{/regex} suffixes and unbounded tag peeling read like git's get_oid
 *   interopSurface: revParse
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;
const TAG_CHAIN_LENGTH = 6;
const ABSENT_OID = '1'.repeat(40);

const identityAt = (offset: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${EPOCH + offset} +0000`,
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: `${EPOCH + offset} +0000`,
});

const ERROR_PREFIX = 'error: ';

interface Outcome {
  readonly id: string | undefined;
  readonly errors: ReadonlyArray<string>;
}

const gitOutcome = (repo: string, argument: string): Outcome => {
  const result = tryRunGitWithExit(['-C', repo, 'rev-parse', argument], {
    env: runGitEnv(),
  });
  const errors = result.stderr
    .split('\n')
    .filter((line) => line.startsWith(ERROR_PREFIX))
    .map((line) => line.slice(ERROR_PREFIX.length));
  return { id: result.exitCode === 0 ? result.stdout.trim() : undefined, errors };
};

const tsgitOutcome = async (repo: string, argument: string): Promise<Outcome> => {
  const errors: string[] = [];
  const ctx = {
    ...createNodeContext({ workDir: repo }),
    logger: { error: (message: string) => errors.push(message) },
  };
  try {
    return { id: await revParse(ctx, argument), errors };
  } catch {
    return { id: undefined, errors };
  }
};

const buildRepository = (repo: string): void => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  ['first fix', 'second', 'third feature'].forEach((message, offset) => {
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', message], {
      env: identityAt(offset),
    });
  });
  for (let level = 1; level <= TAG_CHAIN_LENGTH; level += 1) {
    const target = level === 1 ? 'HEAD' : `t${level - 1}`;
    runGit(['-C', repo, 'tag', '-a', '-m', `t${level}`, `t${level}`, target], {
      env: identityAt(100),
    });
  }
  const dangling = `object ${ABSENT_OID}\ntype commit\ntag bad\ntagger A <a@x> ${EPOCH} +0000\n\nbad\n`;
  const badTag = runGit(['-C', repo, 'hash-object', '-t', 'tag', '-w', '--stdin', '--literally'], {
    input: dangling,
  }).trim();
  git(repo, 'update-ref', 'refs/tags/bad', badTag);
};

describe.skipIf(!GIT_AVAILABLE)('integration — revParse suffix grammar parity with git', () => {
  let repo = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-grammar-interop-'));
    buildRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given commits, a six-deep tag chain and a tag naming an absent object', () => {
    describe.each([
      'HEAD~',
      'HEAD~~',
      'HEAD~^',
      'HEAD^{}',
      't1^{}',
      't6^{}',
      't6^{}~1',
      'HEAD^{object}',
      't6^{object}',
      'bad^{}',
      'bad^{object}',
      'bad^{commit}',
    ])('When git rev-parse and revParse read %s', (argument) => {
      it('Then both resolve the same object and print the same errors', async () => {
        // Arrange
        const peer = gitOutcome(repo, argument);

        // Act
        const result = await tsgitOutcome(repo, argument);

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });
});
