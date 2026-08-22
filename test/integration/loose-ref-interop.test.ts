/**
 * Cross-tool interop — `refs/heads/<name>` loose-ref byte equality.
 * Drives `updateRef` against the Node adapter, then compares the resulting
 * `.git/refs/heads/<name>` file against the one canonical `git update-ref`
 * produces in a peer tmpdir.
 *
 * @proves
 *   surface:        looseRef
 *   bucket:         cross-tool-interop
 *   unique:         loose ref file byte-identical to git update-ref output; a
 *                    malformed HEAD is tolerated (uncoupled) by both tools, so
 *                    the unrelated write succeeds and logs/HEAD is unchanged
 *   interopSurface: looseRef
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

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
        runGit(['init', '-q', '-b', 'main', peer]);
        runGit(['-C', peer, 'config', 'user.name', 'Ada']);
        runGit(['-C', peer, 'config', 'user.email', 'ada@example.com']);
        runGit(['-C', peer, 'commit', '-q', '--allow-empty', '-m', 'seed']);
        const sha = runGit(['-C', peer, 'rev-parse', 'HEAD']).trim();
        runGit(['-C', peer, 'update-ref', 'refs/heads/test-ref', sha]);
        // tsgit side: init the directory layout via canonical git, then write
        // the ref via tsgit's primitive.
        runGit(['init', '-q', '-b', 'main', ours]);
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

  describe('Given HEAD content is malformed', () => {
    describe('When updating an unrelated ref, on both canonical git and tsgit', () => {
      it('Then the write succeeds and logs/HEAD is left byte-unchanged', async () => {
        // Arrange — seed both repos identically, capture the commit sha and
        // the coupled logs/HEAD bytes a normal commit produces, THEN corrupt
        // HEAD — mirroring an already-working repo whose HEAD gets damaged.
        // A pinned author/committer date makes both repositories produce the
        // identical commit oid. Without it the two seed commits differ whenever
        // they straddle a second boundary, and the sha captured from the second
        // repository is then absent from the first — git refuses to write a ref
        // pointing at an object it does not have.
        const pinnedDates: NodeJS.ProcessEnv = {
          ...runGitEnv(),
          GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
        };
        let sha = '';
        const logsHeadBefore = new Map<string, Buffer>();
        for (const dir of [peer, ours]) {
          runGit(['init', '-q', '-b', 'main', dir]);
          runGit(['-C', dir, 'config', 'user.name', 'Ada']);
          runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
          runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env: pinnedDates });
          sha = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
          logsHeadBefore.set(dir, await readFile(path.join(dir, '.git/logs/HEAD')));
          await writeFile(path.join(dir, '.git/HEAD'), 'ref: refs/heads/.invalid\n');
        }

        // Act
        runGit(['-C', peer, 'update-ref', 'refs/heads/bar', sha]);
        const sut = createNodeContext({ workDir: ours });
        await updateRef(sut, 'refs/heads/bar' as RefName, sha as ObjectId, {
          reflogMessage: 'interop',
        });

        // Assert — both tools wrote the same ref bytes and left logs/HEAD alone
        const peerRefBytes = await readFile(path.join(peer, '.git/refs/heads/bar'));
        const oursRefBytes = await readFile(path.join(ours, '.git/refs/heads/bar'));
        expect(oursRefBytes).toEqual(peerRefBytes);
        expect(await readFile(path.join(peer, '.git/logs/HEAD'))).toEqual(logsHeadBefore.get(peer));
        expect(await readFile(path.join(ours, '.git/logs/HEAD'))).toEqual(logsHeadBefore.get(ours));
      });
    });
  });
});
