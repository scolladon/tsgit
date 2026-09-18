/**
 * Cross-tool interop — how deep a symbolic-ref chain a WRITE walks. git caps
 * the READ walk (`refs_resolve_ref_unsafe` stops after five reads, so a
 * five-hop chain reads as dangling) but caps the write walk at nothing: its
 * ref transaction splits at every symbolic hop it meets and keeps going, so
 * an update through a fifty-hop chain still lands on the chain's own end. The
 * two rows pin both halves against tsgit.
 *
 * @proves
 *   surface:        updateRef
 *   bucket:         cross-tool-interop
 *   unique:         a write dereferences a symref chain of any depth while a
 *                    read of the same chain stops at git's own five-read cap
 *   interopSurface: updateRef
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { resolveRefOrMissing } from '../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;

/** Well past git's five-read cap on the reading walk. */
const DEEP_HOPS = 50;
/** git's reading walk takes five reads, so this chain reads as dangling. */
const OVER_READ_CAP_HOPS = 5;

const TIP = 'refs/heads/tip' as RefName;

describe.skipIf(!GIT_AVAILABLE)('symref write-depth interop', () => {
  const caseRoots: string[] = [];

  /** A repository with two commits, `tip` on the first, and one symref chain
   *  of `hops` links ending on `tip`. Returns the chain's head. */
  const caseRepo = async (
    slug: string,
    hops: number,
  ): Promise<{ readonly dir: string; readonly head: RefName; readonly second: ObjectId }> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-symref-depth-${slug}-`));
    caseRoots.push(dir);
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
    const first = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    const second = git(dir, 'rev-parse', 'HEAD').trim() as ObjectId;
    git(dir, 'update-ref', TIP, first);
    git(dir, 'symbolic-ref', 'refs/heads/link1', TIP);
    for (let hop = 2; hop <= hops; hop += 1) {
      git(dir, 'symbolic-ref', `refs/heads/link${hop}`, `refs/heads/link${hop - 1}`);
    }
    return { dir, head: `refs/heads/link${hops}` as RefName, second };
  };

  afterAll(async () => {
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  describe(`Given a symref chain of ${DEEP_HOPS} hops, far past the reading walk's own cap`, () => {
    describe('When git update-ref and tsgit updateRef both write through its head', () => {
      it(
        "Then both land on the chain's end — the write walk is capped at nothing",
        async () => {
          // Arrange
          const peer = await caseRepo('deep-peer', DEEP_HOPS);
          const ours = await caseRepo('deep', DEEP_HOPS);
          const sut = updateRef;

          // Act
          git(peer.dir, 'update-ref', peer.head, peer.second);
          await sut(createNodeContext({ workDir: ours.dir }), ours.head, ours.second, {
            reflogMessage: 'deep write',
          });

          // Assert
          expect(git(peer.dir, 'rev-parse', TIP).trim()).toBe(peer.second);
          expect(git(ours.dir, 'rev-parse', TIP).trim()).toBe(ours.second);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe(`Given a symref chain of ${OVER_READ_CAP_HOPS} hops, one past the reading walk's cap`, () => {
    describe('When git rev-parse and tsgit resolveRefOrMissing both read its head', () => {
      it(
        'Then neither resolves it — the reading walk stops where git stops',
        async () => {
          // Arrange
          const { dir, head } = await caseRepo('read-cap', OVER_READ_CAP_HOPS);
          const sut = resolveRefOrMissing;

          // Act
          const byGit = tryRunGitWithExit(['-C', dir, 'rev-parse', '--verify', '--quiet', head]);
          let caught: unknown;
          try {
            await sut(createNodeContext({ workDir: dir }), head);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(byGit.exitCode).not.toBe(0);
          expect(byGit.stdout.trim()).toBe('');
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_CHAIN_TOO_DEEP',
            depth: OVER_READ_CAP_HOPS,
            chain: Array.from(
              { length: OVER_READ_CAP_HOPS },
              (_, hop) => `refs/heads/link${OVER_READ_CAP_HOPS - hop}`,
            ),
          });
        },
        ROW_TIMEOUT,
      );
    });
  });
});
