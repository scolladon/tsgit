/**
 * Cross-tool interop — a path restore from the index on an unborn branch
 * succeeds as git's `checkout -- <paths>` does: the file is restored, the
 * command exits 0 and post-checkout receives the null oid as both HEADs.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         a path restore on an unborn branch succeeds with null-oid hook args as git does
 *   interopSurface: checkout
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { checkout } from '../../src/application/commands/checkout.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const HOOK_BODY = `#!/bin/sh\nd=$(git rev-parse --git-dir)\nprintf '%s' "$*" > "$d/hook-args"\nexit 0\n`;

const stageThenModify = async (repo: string): Promise<void> => {
  const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
  await writeFile(hookPath, HOOK_BODY);
  await chmod(hookPath, 0o755);
  await writeFile(path.join(repo, 'f'), 'a');
  runGit(['-C', repo, 'add', 'f']);
  await writeFile(path.join(repo, 'f'), 'b');
};

const hookArgsOf = (repo: string): Promise<string> =>
  readFile(path.join(repo, '.git', 'hook-args'), 'utf8');

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'checkout path restore on an unborn branch',
  () => {
    let pair: PeerPair;

    beforeEach(async () => {
      pair = await makePeerPair('checkout-unborn');
      initBothRepos(pair.peer, pair.ours);
      await stageThenModify(pair.peer);
      await stageThenModify(pair.ours);
    });

    afterEach(async () => {
      await pair.dispose();
    });

    describe('Given a staged file modified in the work tree on an unborn branch', () => {
      describe('When the path is restored from the index', () => {
        it('Then git and tsgit restore it and post-checkout receives the same arguments', async () => {
          // Arrange
          const sut = checkout;

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'checkout', '--', 'f']);
          await sut(createNodeContext({ workDir: pair.ours }), { paths: ['f'] });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(await readFile(path.join(pair.ours, 'f'), 'utf8')).toBe(
            await readFile(path.join(pair.peer, 'f'), 'utf8'),
          );
          expect(await hookArgsOf(pair.ours)).toBe(await hookArgsOf(pair.peer));
        });
      });
    });
  },
);
