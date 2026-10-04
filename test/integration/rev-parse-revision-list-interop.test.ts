/**
 * Cross-tool interop — `revParse`'s revision list against `git rev-parse`'s
 * stdout. One repository is built once with canonical git: two branches off
 * one root, two criss-cross merges of them, an annotated tag of the root and
 * a blob sharing a commit's abbreviated id, and untracked files `f` and `sub/g`.
 * Each row rebuilds git's stdout from the entries — or, on a refusal, from the
 * lines its error carries as printed — and compares it, whether either
 * refused, and the `error:` lines.
 *
 * @proves
 *   surface:        revParse
 *   bucket:         cross-tool-interop
 *   unique:         ranges, symmetric ranges, ^@ / ^! / ^-n parent shorthands and ^-excluded names list git's revisions in git's order
 *   interopSurface: revParse
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type RevParseEntry, revParse } from '../../src/application/commands/rev-parse.js';
import type { TsgitError } from '../../src/domain/error.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  revParseStdout,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;
const ERROR_PREFIX = 'error: ';
const PREFIX_LENGTH = 4;

type Printed = ReadonlyArray<RevParseEntry>;

const identityAt = (offset: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${EPOCH + offset} +0000`,
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: `${EPOCH + offset} +0000`,
});

interface Outcome {
  readonly stdout: string;
  readonly refused: boolean;
  readonly errors: ReadonlyArray<string>;
}

const gitOutcome = (cwd: string, argument: string): Outcome => {
  const result = tryRunGitWithExit(['-C', cwd, 'rev-parse', argument], { env: runGitEnv() });
  const errors = result.stderr
    .split('\n')
    .filter((line) => line.startsWith(ERROR_PREFIX))
    .map((line) => line.slice(ERROR_PREFIX.length));
  return { stdout: result.stdout.replace(/\n$/, ''), refused: result.exitCode !== 0, errors };
};

const tsgitOutcome = async (repo: string, cwd: string, argument: string): Promise<Outcome> => {
  const errors: string[] = [];
  const ctx = {
    ...createNodeContext({ workDir: repo }),
    cwd,
    logger: { error: (message: string) => errors.push(message) },
  };
  try {
    return { stdout: revParseStdout(await revParse(ctx, argument)), refused: false, errors };
  } catch (error) {
    const printed = (error as TsgitError).data as { readonly printed?: Printed };
    return { stdout: revParseStdout(printed.printed ?? []), refused: true, errors };
  }
};

const commitAt = (repo: string, message: string, offset: number): void => {
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', message], { env: identityAt(offset) });
};

const mergeAt = (repo: string, branch: string, message: string, offset: number): void => {
  runGit(['-C', repo, 'merge', '-q', '--no-ff', '-m', message, branch], {
    env: identityAt(offset),
  });
};

/** A blob content whose id starts with `prefix`, written into `repo`. */
const writeBlobSharing = (repo: string, prefix: string): void => {
  for (let attempt = 0; ; attempt += 1) {
    const content = `x${attempt}\n`;
    const header = `blob ${content.length}\0`;
    const id = createHash('sha1').update(header).update(content).digest('hex');
    if (id.startsWith(prefix)) {
      runGit(['-C', repo, 'hash-object', '-w', '--stdin'], { input: content });
      return;
    }
  }
};

/**
 * c1 ← c2 (main) and c1 ← s1 (side, newer); x1 merges side into main, x2
 * main into side; `t` an annotated tag of c1; a blob sharing c2's prefix.
 */
const buildRepository = (repo: string): string => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  commitAt(repo, 'c1', 1);
  runGit(['-C', repo, 'tag', '-a', '-m', 't', 't'], { env: identityAt(1) });
  commitAt(repo, 'c2', 2);
  git(repo, 'checkout', '-q', '-b', 'side', 'HEAD~');
  commitAt(repo, 's1', 3);
  git(repo, 'checkout', '-q', '-b', 'x2');
  mergeAt(repo, 'main', 'x2', 11);
  git(repo, 'checkout', '-q', '-b', 'x1', 'main');
  mergeAt(repo, 'side', 'x1', 10);
  git(repo, 'checkout', '-q', 'main');
  const prefix = git(repo, 'rev-parse', 'main').trim().slice(0, PREFIX_LENGTH);
  writeBlobSharing(repo, prefix);
  writeFileSync(path.join(repo, 'f'), '');
  mkdirSync(path.join(repo, 'sub'));
  writeFileSync(path.join(repo, 'sub', 'g'), '');
  writeFileSync(path.join(repo, 'main^{tree}...side'), '');
  return prefix;
};

describe.skipIf(!GIT_AVAILABLE)('integration — revParse revision list parity with git', () => {
  let repo = '';
  let prefix = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-list-interop-'));
    prefix = buildRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given two branches, criss-cross merges, a tag and a blob sharing a prefix', () => {
    describe.each([
      'main',
      '^side',
      '^^side',
      'side..main',
      '..side',
      'side..',
      'side...main',
      '...main',
      'main...',
      '...',
      'x1...x2',
      'x1..x2',
      't..main',
      't...main',
      'main^{tree}..main',
      'main^{tree}...main',
      'nope..main',
      'main..nope',
      'side..main..x',
      '<prefix>..side',
      'side..<prefix>',
      '<prefix>...side',
      'x1^@',
      'x1^!',
      'x1^-',
      'x1^-1',
      'x1^-2',
      'x1^-3',
      'x1^-0',
      'x1^-+2',
      'x1^- 2',
      'x1^-02',
      'x1^-2x',
      'x1^--1',
      'x1~1^-',
      't^!',
      't^@',
      't^-',
      'main^{tree}^@',
      'main^{tree}^!',
      'x1^!x',
      'x1^!^!',
      'x1^@^!',
      'x1^@^@',
      'nope^!',
      '^x1^!',
      'side..main^!',
      '^!',
      '<prefix>^!',
      '<prefix>^@',
      'f',
      'nope',
      '',
      'f*',
      ':(top)nothing',
      ':/',
      ':!f',
      ':^g',
      ':/zzz',
      'main^{tree}...side',
      '^f',
      '@',
      '^@',
      '@~1',
      '@^',
      '@^{tree}',
      '@^!',
      '@..side',
      'side..@',
      '@@',
      'main@',
      '@@{0}',
      '<prefix>~0',
      '<prefix>^0',
      '<prefix>^{commit}',
      '<prefix>^{/c2}',
      '<prefix>^{tree}',
      '<prefix>:',
      '<prefix>~0^{tree}',
    ])('When git rev-parse and revParse read %s', (row) => {
      it("Then both print git's revisions in git's order and the same errors", async () => {
        // Arrange
        const argument = row.replace('<prefix>', prefix);
        const peer = gitOutcome(repo, argument);

        // Act
        const result = await tsgitOutcome(repo, repo, argument);

        // Assert
        expect(result).toEqual(peer);
      });
    });

    describe.each(['g', 'f', ':!g', ':!f', ':/f', ':/sub/g', '', '../f'])(
      'When git rev-parse and revParse read %s from sub',
      (argument) => {
        it('Then both print the same lines and refuse alike', async () => {
          // Arrange
          const cwd = path.join(repo, 'sub');
          const peer = gitOutcome(cwd, argument);

          // Act
          const result = await tsgitOutcome(repo, cwd, argument);

          // Assert
          expect(result).toEqual(peer);
        });
      },
    );

    describe.each(['<prefix>', '<prefix>^{}', '<prefix>^{blob}', '<prefix>^{object}'])(
      'When git rev-parse and revParse read %s, the prefix read with no commit-ish hint',
      (row) => {
        it('Then both refuse the ambiguous abbreviated id', async () => {
          // Arrange
          const argument = row.replace('<prefix>', prefix);
          const peer = tryRunGitWithExit(['-C', repo, 'rev-parse', argument], {
            env: runGitEnv(),
          });
          const sut = revParse;

          // Act
          const result = await sut(createNodeContext({ workDir: repo }), argument).catch(
            (error: TsgitError) => error.data,
          );

          // Assert
          expect(peer.exitCode).toBe(128);
          expect(peer.stderr).toContain(`error: short object ID ${prefix} is ambiguous`);
          expect(result).toMatchObject({ code: 'AMBIGUOUS_OID_PREFIX', prefix });
        });
      },
    );
  });
});
