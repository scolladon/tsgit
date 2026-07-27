/**
 * Cross-tool interop — git treats the empty tree as a virtual, always-present
 * object: `diff <empty-tree> HEAD` succeeds against a repo that never wrote
 * the empty tree object to disk, reporting every HEAD path as an add.
 *
 * @proves
 *   surface:        diff
 *   bucket:         cross-tool-interop
 *   unique:         empty-tree-as-virtual-object — diff against the empty tree resolves without ever writing 4b825dc6… to disk
 *   interopSurface: diff
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_TREE_OID } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGitAsync, runGitEnv } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700010000 +0000',
  GIT_COMMITTER_DATE: '1700010000 +0000',
} as const;

const ZERO_OID = '0'.repeat(40);

let dir = '';
let repo: Awaited<ReturnType<typeof openRepository>>;

describe.skipIf(!GIT_AVAILABLE)('empty tree diff interop', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-empty-tree-diff-')));
    await runGitAsync(['init', '-q', '-b', 'main', dir]);
    await runGitAsync(['-C', dir, 'config', 'user.name', 'Ada']);
    await runGitAsync(['-C', dir, 'config', 'user.email', 'ada@example.com']);
    await writeFile(path.join(dir, 'greeting.txt'), 'hello\n');
    await writeFile(path.join(dir, 'notes.txt'), 'notes\n');
    await runGitAsync(['-C', dir, 'add', 'greeting.txt', 'notes.txt']);
    await runGitAsync(['-C', dir, 'commit', '-q', '-m', 'add files'], {
      env: { ...runGitEnv(), ...IDENTITY },
    });
    repo = await openRepository({ cwd: dir });
  });

  afterAll(async () => {
    await repo.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  describe('Given a repo that never wrote the empty tree object', () => {
    describe('When git hashes an empty file as a tree', () => {
      it('Then the result equals the pinned empty-tree constant', async () => {
        // Arrange
        // Act
        const result = (
          await runGitAsync(['-C', dir, 'hash-object', '-t', 'tree', '/dev/null'])
        ).trim();

        // Assert
        expect(result).toBe(EMPTY_TREE_OID);
      });
    });

    describe('When tsgit diffs the empty tree against HEAD', () => {
      it('Then every HEAD path is reported as an add, matching git diff <empty-tree> HEAD', async () => {
        // Arrange
        const peerRaw = await runGitAsync([
          '-C',
          dir,
          'diff-tree',
          '-r',
          '--no-commit-id',
          '--abbrev=40',
          '--no-ext-diff',
          EMPTY_TREE_OID,
          'HEAD',
        ]);
        const peerLines = peerRaw.split('\n').filter((l) => l.length > 0);

        // Act
        const result = await repo.diff({ from: EMPTY_TREE_OID, to: 'HEAD' });

        // Assert
        expect(result.changes.length).toBeGreaterThan(0);
        const rawLines = result.changes.map((c) => {
          if (c.type !== 'add') throw new Error(`expected an add change, got ${c.type}`);
          return `:000000 ${c.newMode} ${ZERO_OID} ${c.newId} A\t${c.newPath}`;
        });
        expect(rawLines).toEqual(peerLines);
      });
    });
  });
});
