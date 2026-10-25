/**
 * Cross-tool interop — a merge where one side deletes a gitlink and the other moves it
 * records a modify/delete conflict without reading the gitlink's object (a submodule commit
 * is not in this object store). Both tools merge twin copies; the index stages, the status
 * lines, the merge state and the work-tree listing are compared.
 *
 * @proves
 *   surface:        repo.merge
 *   bucket:         cross-tool-interop
 *   unique:         gitlink modify/delete merge conflict runs against git
 *   interopSurface: merge
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const FIXED_DATE = '1700000000 +0000';
const BASE_LINK = '1'.repeat(40);
const MOVED_LINK = '2'.repeat(40);
const GITLINK_MODE = '160000';

const commit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

const setLink = (dir: string, id: string): void => {
  git(dir, 'update-index', '--add', '--cacheinfo', `${GITLINK_MODE},${id},sub`);
};

/** `base` tracks `f` and the gitlink; `main` deletes or moves it, `theirs` does the opposite. */
const buildFixture = async (dir: string, mainDeletes: boolean): Promise<void> => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'f'), 'f\n');
  git(dir, 'add', 'f');
  setLink(dir, BASE_LINK);
  commit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'theirs');
  if (mainDeletes) setLink(dir, MOVED_LINK);
  else git(dir, 'rm', '-q', '--cached', 'sub');
  commit(dir, 'theirs');
  git(dir, 'checkout', '-q', 'main');
  if (mainDeletes) git(dir, 'rm', '-q', '--cached', 'sub');
  else setLink(dir, MOVED_LINK);
  commit(dir, 'main');
};

const observed = (dir: string): Record<string, unknown> => ({
  stages: git(dir, 'ls-files', '--stage'),
  status: git(dir, 'status', '--porcelain'),
  mergeHead: readFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'utf8'),
  mergeMsg: readFileSync(path.join(dir, '.git', 'MERGE_MSG'), 'utf8'),
  listing: readdirSync(dir).filter((name) => name !== '.git'),
  subIsDirectory:
    existsSync(path.join(dir, 'sub')) && statSync(path.join(dir, 'sub')).isDirectory(),
});

const ROWS = [
  { title: 'main deleting the gitlink and theirs moving it', mainDeletes: true, status: 'DU sub' },
  { title: 'main moving the gitlink and theirs deleting it', mainDeletes: false, status: 'UD sub' },
] as const;

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Feature: gitlink modify/delete merge compared with git',
  () => {
    let root: string;

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-merge-gitlink-md-'));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    describe.each(ROWS)('Given $title', (row) => {
      describe('When both tools merge theirs', () => {
        it(
          'Then the conflict state and the work tree match git, with no object read',
          async () => {
            // Arrange
            const gitTwin = path.join(root, `git-${row.status.slice(0, 2)}`);
            const tsgitTwin = path.join(root, `tsgit-${row.status.slice(0, 2)}`);
            await mkdir(gitTwin);
            await buildFixture(gitTwin, row.mainDeletes);
            await cp(gitTwin, tsgitTwin, { recursive: true });

            // Act
            const gitExit = tryRunGitWithExit([
              '-C',
              gitTwin,
              'merge',
              '-q',
              '--no-edit',
              'theirs',
            ]);
            const result = await mergeRun(createNodeContext({ workDir: tsgitTwin }), {
              rev: 'theirs',
            });

            // Assert
            expect(gitExit.exitCode).toBe(1);
            expect(result).toMatchObject({
              kind: 'conflict',
              conflicts: [{ path: 'sub', type: 'modify-delete' }],
            });
            expect(git(gitTwin, 'status', '--porcelain')).toBe(`${row.status}\n`);
            expect(observed(tsgitTwin)).toEqual(observed(gitTwin));
          },
          ROW_TIMEOUT,
        );
      });
    });
  },
);
