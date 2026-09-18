/**
 * Cross-tool interop — which `remote.<name>.fetch` and `remote.<name>.push`
 * values survive git's own remote-table build. Every row configures one spec in
 * a real repository, asks canonical git to build the table (`git ls-remote`
 * against that remote, whose failure is the table's own `invalid refspec`
 * death), and compares the verdict against tsgit's `remoteShow` over a private
 * twin of the same shape.
 *
 * @proves
 *   surface:        remote.show
 *   bucket:         cross-tool-interop
 *   unique:         the refspec grammar accepts and refuses exactly what git's
 *                    remote table does, on both the fetch and the push key
 *   interopSurface: remote
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { remoteShow } from '../../src/application/commands/remote.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;

interface Row {
  readonly key: 'fetch' | 'push';
  readonly spec: string;
  readonly label: string;
}

/** Every shape the grammar decides differently, on both keys. */
const ROWS: ReadonlyArray<Row> = [
  { key: 'fetch', spec: 'refs/heads/*:refs/remotes/origin/*', label: 'wildcards on both sides' },
  { key: 'fetch', spec: 'refs/heads/a:refs/b', label: 'exact names on both sides' },
  { key: 'fetch', spec: 'a:b', label: 'one-level names on both sides' },
  { key: 'fetch', spec: '+a:b', label: 'a forced spec' },
  { key: 'fetch', spec: 'refs/heads/a', label: 'no destination at all' },
  { key: 'fetch', spec: 'refs/heads/a:', label: 'an empty destination' },
  { key: 'fetch', spec: ':refs/heads/b', label: 'an empty source' },
  { key: 'fetch', spec: '^refs/heads/a', label: 'a negative spec' },
  { key: 'fetch', spec: '^refs/heads/a:refs/x', label: 'a negative spec with a destination' },
  { key: 'fetch', spec: 'refs/**:refs/remotes/origin/*', label: 'two wildcards on the source' },
  {
    key: 'fetch',
    spec: 'refs/heads/*:refs/remotes/origin/**',
    label: 'two wildcards on the destination',
  },
  { key: 'fetch', spec: 'refs/heads/*:refs/remotes/../x/*', label: 'a destination stepping up' },
  { key: 'fetch', spec: 'refs/heads/..bad:refs/remotes/x/y', label: 'a source stepping up' },
  { key: 'fetch', spec: 'refs/heads/a:refs/heads/b:c', label: 'a second colon' },
  { key: 'fetch', spec: 'refs/heads/*', label: 'a wildcard source with no destination' },
  { key: 'fetch', spec: 'HEAD~1:refs/x', label: 'a source no ref name could be' },
  { key: 'fetch', spec: 'a b:refs/x', label: 'a source holding a space' },
  { key: 'fetch', spec: 'refs/heads/a:b c', label: 'a destination holding a space' },
  { key: 'fetch', spec: '*:*', label: 'a bare wildcard on both sides' },
  { key: 'push', spec: 'refs/heads/..bad:refs/x', label: 'a source stepping up' },
  { key: 'push', spec: 'refs/heads/a:refs/../b', label: 'a destination stepping up' },
  { key: 'push', spec: 'refs/heads/a:refs/x', label: 'exact names on both sides' },
  { key: 'push', spec: 'HEAD~1:refs/x', label: 'a source no ref name could be' },
  { key: 'push', spec: 'refs/heads/*:refs/x', label: 'a wildcard source against an exact one' },
  { key: 'push', spec: 'refs/x:refs/heads/*', label: 'an exact source against a wildcard one' },
  { key: 'push', spec: '*:*', label: 'a bare wildcard on both sides' },
  { key: 'push', spec: 'refs/heads/*:refs/heads/*', label: 'wildcards on both sides' },
  { key: 'push', spec: ':refs/heads/b', label: 'an empty source' },
  { key: 'push', spec: 'refs/heads/a:', label: 'an empty destination' },
  { key: 'push', spec: '^refs/heads/a', label: 'a negative spec' },
  { key: 'push', spec: 'a b:refs/x', label: 'a source holding a space' },
  { key: 'push', spec: 'refs/heads/a:b c', label: 'a destination holding a space' },
  { key: 'push', spec: 'refs/heads/a', label: 'no destination at all' },
  { key: 'push', spec: 'refs/heads/*', label: 'a wildcard source with no destination' },
  { key: 'push', spec: 'a:b:c', label: 'a second colon, which the last-colon split keeps left' },
];

describe.skipIf(!GIT_AVAILABLE)('remote refspec grammar interop', () => {
  const caseRoots: string[] = [];

  const caseRepo = async (row: Row, index: number): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-refspec-${row.key}-${index}-`));
    caseRoots.push(dir);
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
    git(dir, 'config', 'remote.origin.url', '.');
    git(dir, 'config', '--add', `remote.origin.${row.key}`, row.spec);
    return dir;
  };

  /** Whether canonical git built its remote table — the point `parse_refspec`
   *  dies, so a refused spec shows up as the `invalid refspec` fatal. */
  const gitAcceptsSpec = (dir: string): boolean => {
    const result = tryRunGitWithExit(['-C', dir, 'ls-remote', 'origin']);
    if (result.stderr.includes('invalid refspec')) return false;
    return result.exitCode === 0;
  };

  const tsgitAcceptsSpec = async (dir: string): Promise<boolean> => {
    const repo = await openRepository({ cwd: dir });
    try {
      await remoteShow(repo.ctx, { name: 'origin' });
      return true;
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      if ((error as TsgitError).data.code !== 'REFSPEC_INVALID') throw error;
      return false;
    } finally {
      await repo.dispose();
    }
  };

  afterAll(async () => {
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  describe.each(ROWS.map((row, index) => ({ ...row, index })))(
    'Given remote.origin.$key configured with $label — "$spec"',
    (row) => {
      describe('When git builds its remote table and tsgit reads the remote', () => {
        it(
          'Then both reach the same verdict on the spec',
          async () => {
            // Arrange
            const dir = await caseRepo(row, row.index);

            // Act
            const acceptedByGit = gitAcceptsSpec(dir);
            const acceptedByTsgit = await tsgitAcceptsSpec(dir);

            // Assert
            expect(acceptedByTsgit).toBe(acceptedByGit);
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
