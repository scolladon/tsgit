/**
 * Cross-tool interop — which objects `pack-objects --revs` packs once a head
 * moves a directory its excluded upstream holds: git's default
 * `pack.useSparse` marks the excluded side only along the paths both sides
 * hold, so the moved directory is packed; `pack.useSparse=false` marks every
 * object the upstream tree reaches. Each row compares the object set of
 * git's pack with tsgit's walk-tier pack under the same setting.
 *
 * @proves
 *   surface:        packObjects
 *   bucket:         cross-tool-interop
 *   unique:         packObjects marks the excluded side sparsely or densely as pack.useSparse says
 *   interopSurface: packObjects
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const commitAll = (dir: string, message: string): string => {
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', message], {
    env: {
      ...runGitEnv(),
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    },
  });
  return git(dir, 'rev-parse', 'HEAD').trim();
};

const indexedObjects = (dir: string, idx: string): ReadonlyArray<string> =>
  execFileSync('sh', ['-c', `git show-index < '${idx}'`], { cwd: dir, env: runGitEnv() })
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.split(' ')[1] as string)
    .sort();

describe.skipIf(!GIT_AVAILABLE)('integration — pack.useSparse parity with canonical git', () => {
  let dir = '';
  let upstream = '';
  let head = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-sparse-interop-'));
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'A');
    git(dir, 'config', 'user.email', 'a@x');
    disableAutoMaintenance(dir);
    mkdirSync(path.join(dir, 'd', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'd', 'x', 'a'), 'a\n');
    upstream = commitAll(dir, 'upstream');
    git(dir, 'mv', 'd', 'e');
    writeFileSync(path.join(dir, 'e', 'y'), 'y\n');
    head = commitAll(dir, 'head');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe.each([
    { label: 'the default sparse marking', setting: undefined },
    { label: 'pack.useSparse=false', setting: 'false' },
  ])('Given $label', ({ setting }) => {
    describe('When git and tsgit pack the head past its upstream', () => {
      it('Then both pack the same objects', async () => {
        // Arrange
        const repo = path.join(
          await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-sparse-row-')),
          'repo',
        );
        await cp(dir, repo, { recursive: true });
        if (setting !== undefined) git(repo, 'config', 'pack.useSparse', setting);
        const out = path.join(repo, '.git', 'sparse-out');
        mkdirSync(out);
        const gitSha = runGit(['-C', repo, 'pack-objects', '--revs', '-q', path.join(out, 'git')], {
          input: `${head}\n^${upstream}\n`,
        }).trim();
        const ctx = createNodeContext({ workDir: repo });
        const sut = packObjects;

        // Act
        const result = await sut(ctx, {
          wants: [head],
          not: [upstream],
          outputDirectory: out,
          useBitmapIndex: false,
        });

        // Assert
        const expected = indexedObjects(repo, path.join(out, `git-${gitSha}.idx`));
        expect(expected).toHaveLength(setting === undefined ? 6 : 4);
        expect(indexedObjects(repo, path.join(out, `pack-${result.packId}.idx`))).toEqual(expected);
        await rm(path.dirname(repo), { recursive: true, force: true });
      });
    });
  });
});
