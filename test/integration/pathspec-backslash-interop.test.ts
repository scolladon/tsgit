/**
 * Cross-tool interop — a backslash in a pathspec is an escape for the next
 * byte under git's `wildmatch`, so on a POSIX host `add` stages the same
 * paths as `git`; under Windows path syntax tsgit keeps refusing it.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         a backslash pathspec escapes the next byte as git's wildmatch does
 *   interopSurface: add
 */
import { mkdtemp, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGit } from './interop-helpers.js';

const splitNames = (nul: string): string[] => nul.split('\0').filter((name) => name !== '');

const namesOf = (repo: string): string[] =>
  splitNames(runGit(['-C', repo, 'ls-files', '-z'])).sort();

const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given a pathspec holding a backslash on a POSIX host',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-backslash-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twin = async (side: string, files: ReadonlyArray<string>): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      for (const name of files) await writeFile(path.join(repo, name), `${name}\n`);
      return repo;
    };

    describe.each([
      { files: ['a*b', 'aXb'], spec: 'a\\*b', staged: ['a*b'] },
      { files: ['a?b', 'axb'], spec: 'a\\?b', staged: ['a?b'] },
      { files: ['ab', 'b'], spec: 'a\\b', staged: ['ab'] },
    ])('When git and tsgit add the untracked files with the pathspec $spec', (row) => {
      it('Then both stage the same paths', async () => {
        // Arrange
        const gitRepo = await twin('git', row.files);
        const tsgitRepo = await twin('tsgit', row.files);
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', row.spec]);
        await sut(createNodeContext({ workDir: tsgitRepo }), [row.spec]);

        // Assert
        expect(namesOf(gitRepo)).toEqual(row.staged);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });
  },
);

describe.skipIf(process.platform !== 'win32')(
  'Given a pathspec holding a backslash on a Windows host',
  () => {
    describe('When tsgit adds it', () => {
      it('Then it is refused as outside the repository', async () => {
        // Arrange
        const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-backslash-win-')));
        runGit(['init', '-q', '-b', 'main', dir]);
        const sut = add;
        let caught: unknown;

        // Act
        try {
          await sut(createNodeContext({ workDir: dir }), ['a\\b']);
        } catch (err) {
          caught = err;
        }
        await removeTree(dir, { recursive: true, force: true });

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'PATHSPEC_OUTSIDE_REPO',
          path: 'a\\b',
        });
      });
    });
  },
);
