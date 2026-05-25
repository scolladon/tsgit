/**
 * Cross-tool interop — symbolic-ref byte equality. Compares `HEAD` written
 * by tsgit's `writeSymbolicRef` against the file `git symbolic-ref` writes.
 *
 * @proves
 *   surface:        symbolicRef
 *   bucket:         cross-tool-interop
 *   unique:         symbolic ref file byte-identical to git symbolic-ref output
 *   interopSurface: symbolicRef
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { writeSymbolicRef } from '../../src/application/primitives/write-symbolic-ref.js';
import type { RefName } from '../../src/domain/objects/index.js';

const hasGit = (): boolean => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
};

const GIT_AVAILABLE = hasGit();

describe.skipIf(!GIT_AVAILABLE)('symbolic-ref interop', () => {
  let peer: string;
  let ours: string;

  beforeEach(async () => {
    peer = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-symref-peer-'));
    ours = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-symref-ours-'));
  });

  afterEach(async () => {
    await rm(peer, { recursive: true, force: true });
    await rm(ours, { recursive: true, force: true });
  });

  describe('Given HEAD pointing at refs/heads/main', () => {
    describe('When tsgit and canonical git both write HEAD', () => {
      it('Then the two HEAD files are byte-identical', async () => {
        // Arrange
        execFileSync('git', ['init', '-q', '-b', 'main', peer]);
        execFileSync('git', ['init', '-q', '-b', 'main', ours]);
        // Force-rewrite HEAD in peer via canonical git (the file already
        // points at main from init, but the canonical writer round-trips it).
        execFileSync('git', ['-C', peer, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
        const sut = createNodeContext({ workDir: ours });

        // Act
        await writeSymbolicRef(sut, 'HEAD' as RefName, 'refs/heads/main' as RefName);

        // Assert
        const peerBytes = await readFile(path.join(peer, '.git/HEAD'));
        const oursBytes = await readFile(path.join(ours, '.git/HEAD'));
        expect(oursBytes).toEqual(peerBytes);
      });
    });
  });
});
