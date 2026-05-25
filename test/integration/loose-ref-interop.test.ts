/**
 * Cross-tool interop — `refs/heads/<name>` loose-ref byte equality.
 * Drives `updateRef` against the Node adapter, then compares the resulting
 * `.git/refs/heads/<name>` file against the one canonical `git update-ref`
 * produces in a peer tmpdir.
 *
 * @proves
 *   surface:        looseRef
 *   bucket:         cross-tool-interop
 *   unique:         loose ref file byte-identical to git update-ref output
 *   interopSurface: looseRef
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';

const hasGit = (): boolean => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
};

const GIT_AVAILABLE = hasGit();

describe.skipIf(!GIT_AVAILABLE)('loose-ref interop', () => {
  let peer: string;
  let ours: string;

  beforeEach(async () => {
    peer = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-loose-ref-peer-'));
    ours = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-loose-ref-ours-'));
  });

  afterEach(async () => {
    await rm(peer, { recursive: true, force: true });
    await rm(ours, { recursive: true, force: true });
  });

  describe('Given a SHA from a canonical commit', () => {
    describe('When tsgit writes refs/heads/<name> and canonical git does the same', () => {
      it('Then the two ref files are byte-identical', async () => {
        // Arrange — peer canonical-git repo with one commit
        execFileSync('git', ['init', '-q', '-b', 'main', peer]);
        execFileSync('git', ['-C', peer, 'config', 'user.name', 'Ada']);
        execFileSync('git', ['-C', peer, 'config', 'user.email', 'ada@example.com']);
        execFileSync('git', ['-C', peer, 'commit', '-q', '--allow-empty', '-m', 'seed']);
        const sha = execFileSync('git', ['-C', peer, 'rev-parse', 'HEAD']).toString().trim();
        execFileSync('git', ['-C', peer, 'update-ref', 'refs/heads/test-ref', sha]);
        // tsgit side: init the directory layout via canonical git, then write
        // the ref via tsgit's primitive.
        execFileSync('git', ['init', '-q', '-b', 'main', ours]);
        const sut = createNodeContext({ workDir: ours });

        // Act
        await updateRef(sut, 'refs/heads/test-ref' as RefName, sha as ObjectId, {
          reflogMessage: 'interop',
        });

        // Assert
        const peerBytes = await readFile(path.join(peer, '.git/refs/heads/test-ref'));
        const oursBytes = await readFile(path.join(ours, '.git/refs/heads/test-ref'));
        expect(oursBytes).toEqual(peerBytes);
      });
    });
  });
});
