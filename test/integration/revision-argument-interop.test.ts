/**
 * Cross-tool interop — the revision forms git's `handle_revision_arg` reads
 * per argument (`A..B`, `A...B`, `^X`, `X^@`, `X^!`, `X^-<n>`), given to
 * `revList` as a want and to `packObjects` as a `--revs` stdin line. One
 * repository is built once with canonical git: a root, a side commit, a main
 * commit, their merge on main, and an annotated tag of the root. Each row
 * compares the commits `git rev-list` prints, in its order, and the objects
 * `git pack-objects --revs` packs.
 *
 * @proves
 *   surface:        revList
 *   bucket:         cross-tool-interop
 *   unique:         a want spelt as a range, a negation or a parent shorthand expands to git's interesting and uninteresting tips
 *   interopSurface: revList
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { revList } from '../../src/application/commands/rev-list.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;

const identityAt = (offset: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${EPOCH + offset} +0000`,
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: `${EPOCH + offset} +0000`,
});

const buildRepository = (repo: string): void => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'root'], { env: identityAt(1) });
  runGit(['-C', repo, 'tag', '-a', '-m', 't', 't'], { env: identityAt(1) });
  git(repo, 'checkout', '-q', '-b', 'side');
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'side'], { env: identityAt(2) });
  git(repo, 'checkout', '-q', 'main');
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'main'], { env: identityAt(3) });
  runGit(['-C', repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'side'], { env: identityAt(4) });
};

const packedIds = async (directory: string): Promise<ReadonlyArray<string>> => {
  const index = (await readdir(directory)).find((name) => name.endsWith('.idx'));
  if (index === undefined) return [];
  const listing = runGit(['show-index'], {
    input: new Uint8Array(await readFile(path.join(directory, index))),
  });
  return listing
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(' ')[1] as string)
    .sort();
};

describe.skipIf(!GIT_AVAILABLE)('integration — revision argument forms against git', () => {
  let repo = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-revision-argument-interop-'));
    buildRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given a merge of a side branch over a tagged root', () => {
    describe.each([
      'side..main',
      'main..side',
      '..main',
      'main..',
      'side...main',
      't..main',
      'main^@',
      'main^!',
      'main^-',
      'main^-1',
      'main^-2',
      'main^- 1',
      'main^-\t2',
      '^side',
    ])('When git rev-list and revList read %j', (argument) => {
      it("Then both list git's commits in git's order", async () => {
        // Arrange
        const peer = git(repo, 'rev-list', argument).trim().split('\n').filter(Boolean);
        const sut = revList;

        // Act
        const result = await sut(createNodeContext({ workDir: repo }), { wants: [argument] });

        // Assert
        expect(result.entries.map((entry) => entry.id)).toEqual(peer);
      });
    });

    describe.each([
      'side..main',
      'main..side',
      '..',
      '..main',
      'main..',
      'side...main',
      'main^@',
      'main^!',
      'main^-2',
      'main^- 2',
      '^side',
    ])('When git pack-objects --revs and packObjects read the line %j', (line) => {
      it('Then both pack the same objects', async () => {
        // Arrange
        const out = await mkdtemp(path.join(repo, '.git', 'packs-'));
        await mkdir(path.join(out, 'git'));
        runGit(['-C', repo, 'pack-objects', '-q', '--revs', path.join(out, 'git', 'p')], {
          input: `${line}\n`,
        });
        const sut = packObjects;

        // Act
        await sut(createNodeContext({ workDir: repo }), {
          wants: [line],
          outputDirectory: path.join(out, 'tsgit'),
        });

        // Assert
        expect(await packedIds(path.join(out, 'tsgit'))).toEqual(
          await packedIds(path.join(out, 'git')),
        );
        await rm(out, { recursive: true, force: true });
      });
    });
  });
});
