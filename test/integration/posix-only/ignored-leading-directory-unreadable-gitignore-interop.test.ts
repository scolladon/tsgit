/**
 * POSIX-only interop — a .gitignore inside an excluded directory that cannot be read (mode 000).
 * git never opens it, so `git check-ignore -v` still reports the excluding rule; `isIgnored`
 * must report the same without failing.
 *
 * @proves
 *   surface:        isIgnored, repo.checkout
 *   bucket:         platform-only
 *   unique:         an unreadable .gitignore inside an excluded directory is never opened: the excluding rule is reported and a checkout overwrites beneath it as git does
 */
import { chmodSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../../src/adapters/node/node-adapter.js';
import { isIgnored } from '../../../src/application/primitives/is-ignored.js';
import type { FilePath } from '../../../src/domain/objects/object-id.js';
import { openRepository } from '../../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from '../interop-helpers.js';
import { listing } from '../occupant-displacement-fixtures.js';

const IS_ROOT = process.getuid?.() === 0;
const UNREADABLE = 0o000;
const READABLE = 0o644;
const GITIGNORE_FIELDS = 4;
const QUERY = 'ab/c';

const gitVerbose = (repo: string): string => {
  const { stdout, stderr, exitCode } = tryRunGitWithExit(
    ['-C', repo, 'check-ignore', '-v', '-z', '--stdin', '--no-index'],
    { input: `${QUERY}\0` },
  );
  if (exitCode !== 0) throw new Error(`git check-ignore failed (${exitCode}): ${stderr}`);
  const fields = stdout.split('\0').filter((field) => field !== '');
  if (fields.length < GITIGNORE_FIELDS) throw new Error(`unexpected git output: ${stdout}`);
  const [source, line, pattern] = fields as [string, string, string];
  return `${source}:${line}:${pattern}`;
};

describe.skipIf(!GIT_AVAILABLE || IS_ROOT)(
  'integration — an unreadable .gitignore inside an excluded directory',
  () => {
    let root: string;
    let unreadable: string;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-ignore-unreadable-')));
    });

    afterEach(async () => {
      await chmod(unreadable, READABLE);
      await rm(root, { recursive: true, force: true });
    });

    describe.each(['false', 'true'])('Given core.ignorecase is %s', (ignoreCase) => {
      describe('When isIgnored is asked about a path beneath the excluded directory', () => {
        it('Then it reports the excluding rule as git check-ignore does', async () => {
          // Arrange
          const repo = path.join(root, 'repo');
          runGit(['init', '-q', '-b', 'main', repo]);
          git(repo, 'config', 'core.ignorecase', ignoreCase);
          await writeFile(path.join(repo, '.gitignore'), 'ab/\n');
          await mkdir(path.join(repo, 'ab'));
          await writeFile(path.join(repo, QUERY), '');
          unreadable = path.join(repo, 'ab', '.gitignore');
          await writeFile(unreadable, '!c\n');
          chmodSync(unreadable, UNREADABLE);
          const sut = isIgnored;

          // Act
          const [result] = await sut(createNodeContext({ workDir: repo }), [
            { path: QUERY as FilePath },
          ]);

          // Assert
          const source = result?.source;
          expect(result?.ignored).toBe(true);
          expect(`.gitignore:${source?.line}:${source?.pattern}`).toBe(gitVerbose(repo));
        });
      });

      describe('When checkout overwrites an untracked file beneath the excluded directory', () => {
        it('Then it ends as git ends without opening the unreadable file', async () => {
          // Arrange
          const buildTwin = async (name: string): Promise<string> => {
            const repo = path.join(root, name);
            runGit(['init', '-q', '-b', 'main', repo]);
            git(repo, 'config', 'core.ignorecase', ignoreCase);
            git(repo, 'config', 'user.name', 'p');
            git(repo, 'config', 'user.email', 'p@p');
            git(repo, 'config', 'commit.gpgsign', 'false');
            await writeFile(path.join(repo, '.gitignore'), 'ab/\n');
            git(repo, 'add', '.gitignore');
            git(repo, 'commit', '-q', '-m', 'base');
            git(repo, 'checkout', '-q', '-b', 'other');
            await mkdir(path.join(repo, 'ab'));
            await writeFile(path.join(repo, QUERY), 'theirs\n');
            git(repo, 'add', '-f', QUERY);
            git(repo, 'commit', '-q', '-m', 'other');
            git(repo, 'checkout', '-q', 'main');
            await mkdir(path.join(repo, 'ab'), { recursive: true });
            await writeFile(path.join(repo, QUERY), 'mine\n');
            const nested = path.join(repo, 'ab', '.gitignore');
            await writeFile(nested, '!c\n');
            chmodSync(nested, UNREADABLE);
            return repo;
          };
          const peer = await buildTwin('peer');
          const ours = await buildTwin('ours');
          unreadable = path.join(ours, 'ab', '.gitignore');
          const gitResult = tryRunGitWithExit(['-C', peer, 'checkout', 'other']);
          const repository = await openRepository({ cwd: ours });
          let error: unknown;

          // Act
          try {
            await repository.checkout({ rev: 'other' });
          } catch (err) {
            error = err;
          } finally {
            await repository.dispose();
          }

          // Assert
          for (const dir of [peer, ours]) chmodSync(path.join(dir, 'ab', '.gitignore'), READABLE);
          const branchOf = (dir: string): string =>
            git(dir, 'symbolic-ref', '--short', 'HEAD').trim();
          expect(gitResult.exitCode).toBe(0);
          expect(error).toBeUndefined();
          expect(branchOf(ours)).toBe(branchOf(peer));
          expect(listing(ours)).toEqual(listing(peer));
        });
      });
    });
  },
);
