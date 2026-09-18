/**
 * Cross-tool interop — what the loose-ref iterator does with a SYMLINKED
 * DIRECTORY under `refs/`. git's iterator takes the followed type of a link
 * entry, so a link to a directory is descended and the names under it are
 * enumerated as though they lived in the refs tree; a link that closes a cycle
 * is walked until the kernel's own symlink-chain limit stops it. Both rows
 * compare tsgit's enumeration against `git for-each-ref` over the same tree.
 *
 * @proves
 *   surface:        listRefs
 *   bucket:         cross-tool-interop
 *   unique:         a symlinked directory under refs/ is descended and bounded
 *                    exactly as git's own loose iterator descends and bounds it
 *   interopSurface: listRefs
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { getRefStore } from '../../src/application/primitives/ref-store.js';
import type { RefName } from '../../src/domain/objects/index.js';
import { disableAutoMaintenance, GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;

describe.skipIf(!GIT_AVAILABLE)('loose ref iterator — symlinked directory interop', () => {
  const caseRoots: string[] = [];

  const caseRepo = async (slug: string): Promise<string> => {
    // Realpath'd: on darwin the temp root sits behind a `/var` symlink, and a
    // symlink-chain walk measured through it spends one of the kernel's own
    // chain budget before it starts — so the two tools must be handed the same
    // resolved root for their walks to be measured against each other.
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), `tsgit-ref-linked-dir-${slug}-`)),
    );
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
    return dir;
  };

  /** Every name `git for-each-ref` enumerates, in its own order. */
  const gitRefNames = (dir: string): ReadonlyArray<string> =>
    git(dir, 'for-each-ref', '--format=%(refname)')
      .split('\n')
      .filter((line) => line !== '');

  /** Every name tsgit's own iterator enumerates, less `HEAD` — which
   *  `for-each-ref` leaves out of its listing and the walk below is not about. */
  const tsgitRefNames = async (dir: string): Promise<ReadonlyArray<RefName>> => {
    const refs = await getRefStore(createNodeContext({ workDir: dir })).listRefs();
    return refs.map((ref) => ref.name).filter((name) => name !== 'HEAD');
  };

  afterAll(async () => {
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  describe('Given a symlink under refs/heads pointing at a directory outside the repository', () => {
    describe('When git and tsgit both enumerate refs', () => {
      it(
        'Then both descend it and compose the same name for the file inside',
        async () => {
          // Arrange
          const dir = await caseRepo('outside');
          const foreign = path.join(dir, '..', 'foreign');
          await mkdir(foreign, { recursive: true });
          await writeFile(path.join(foreign, 'entry'), 'not a ref at all\n');
          await symlink(foreign, path.join(dir, '.git', 'refs', 'heads', 'x'));

          // Act
          const byGit = gitRefNames(dir);
          const byTsgit = await tsgitRefNames(dir);

          // Assert — git drops the broken name from its OUTPUT but reached it;
          // tsgit's listRefs reports the same set of resolvable names.
          expect(byGit).toEqual(['refs/heads/main']);
          expect(byTsgit).toEqual(['refs/heads/main']);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a symlink under refs/heads that closes a cycle back onto refs/heads', () => {
    describe('When git and tsgit both enumerate refs', () => {
      it(
        'Then both walk the same bounded number of levels and report the same names',
        async () => {
          // Arrange
          const dir = await caseRepo('cycle');
          await symlink('../heads', path.join(dir, '.git', 'refs', 'heads', 'loop'));

          // Act
          const byGit = gitRefNames(dir);
          const byTsgit = await tsgitRefNames(dir);

          // Assert — the kernel's own symlink-chain limit is what stops both,
          // so the two enumerations hold exactly the same names.
          expect(byTsgit.length).toBeGreaterThan(1);
          expect([...byTsgit].sort()).toEqual([...byGit].sort());
        },
        ROW_TIMEOUT,
      );
    });
  });
});
