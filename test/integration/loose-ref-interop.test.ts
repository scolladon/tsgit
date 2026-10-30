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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { resolveRef } from '../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

/** Pinned author/committer date so two independently-initialised repos that
 *  each commit `--allow-empty` compute the SAME oid — required now that
 *  `updateRef` verifies its target actually exists in the store it writes
 *  to, not merely that the caller believes it exists. */
const PINNED_DATES: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

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
        // Arrange — peer canonical-git repo with one commit; `ours` seeds the
        // identical commit (pinned dates make the oid match), so the object
        // `updateRef` now verifies actually exists in tsgit's own store.
        runGit(['init', '-q', '-b', 'main', peer]);
        runGit(['-C', peer, 'config', 'user.name', 'Ada']);
        runGit(['-C', peer, 'config', 'user.email', 'ada@example.com']);
        runGit(['-C', peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env: PINNED_DATES,
        });
        const sha = runGit(['-C', peer, 'rev-parse', 'HEAD']).trim();
        runGit(['-C', peer, 'update-ref', 'refs/heads/test-ref', sha]);
        // tsgit side: init the directory layout via canonical git, seed the
        // same commit, then write the ref via tsgit's primitive.
        runGit(['init', '-q', '-b', 'main', ours]);
        runGit(['-C', ours, 'config', 'user.name', 'Ada']);
        runGit(['-C', ours, 'config', 'user.email', 'ada@example.com']);
        runGit(['-C', ours, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env: PINNED_DATES,
        });
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
        let sha = '';
        const logsHeadBefore = new Map<string, Buffer>();
        for (const dir of [peer, ours]) {
          runGit(['init', '-q', '-b', 'main', dir]);
          runGit(['-C', dir, 'config', 'user.name', 'Ada']);
          runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
          runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
            env: PINNED_DATES,
          });
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

type BodyBuilder = (sha: string) => string;

const BODY_ROWS: ReadonlyArray<readonly [string, BodyBuilder]> = [
  ['UP', (sha) => `${sha.toUpperCase()}\n`],
  ['MIX', (sha) => `${sha.slice(0, 20).toUpperCase()}${sha.slice(20)}\n`],
  ['upper oid then garbage', (sha) => `${sha.toUpperCase()} garbage\n`],
  ['GARB', (sha) => `${sha}garbage\n`],
  ['SPG', (sha) => `${sha} garbage\n`],
  ['oid tab garbage', (sha) => `${sha}\tgarbage\n`],
  ['SP2', (sha) => `${sha}  \n`],
  ['SPN', (sha) => `${sha} \n`],
  ['CRLF', (sha) => `${sha}\r\n`],
  ['NN', (sha) => `${sha}\n\n`],
  ['TWO', (sha) => `${sha}\n${sha}\n`],
  ['H39', (sha) => `${sha.slice(0, 39)}\n`],
  ['H41', (sha) => `${sha}0\n`],
  ['W64', (sha) => `${sha}${sha.slice(0, 24)}\n`],
  ['VT', (sha) => `${sha}\v\n`],
  ['oid without newline', (sha) => sha],
  ['upper oid without newline', (sha) => sha.toUpperCase()],
  ['oid garbage without newline', (sha) => `${sha} garbage`],
  ['EMPTY', () => ''],
  ['symref without newline', () => 'ref: refs/heads/main'],
  ['symref trailing space', () => 'ref: refs/heads/main \n'],
  ['symref CRLF', () => 'ref: refs/heads/main\r\n'],
  ['symref double newline', () => 'ref: refs/heads/main\n\n'],
  ['symref trailing space without newline', () => 'ref: refs/heads/main '],
  ['symref referent garbage', () => 'ref: refs/heads/main garbage\n'],
  ['R1', () => 'ref:refs/heads/main\n'],
  ['R2', () => 'ref:  refs/heads/main\n'],
  ['R3', () => 'ref:\trefs/heads/main\n'],
  ['R4', () => 'ref: refs/heads/main \n'],
  ['R5', () => 'ref: refs/heads/main\r\n'],
  ['R6', () => 'ref: refs/heads/main\nextra\n'],
  ['V1', () => 'ref:\vrefs/heads/main\n'],
  ['V3', () => 'ref: refs/heads/main\v\n'],
];

const HEAD_ROWS: ReadonlyArray<readonly [string, BodyBuilder]> = [
  ['HEAD oid then garbage', (sha) => `${sha} garbage\n`],
  ['HEAD referent then 5000 spaces', () => `ref: refs/heads/main${' '.repeat(5000)}\n`],
  ['HEAD symref without newline', () => 'ref: refs/heads/main'],
];

const verifyWithGit = (dir: string, name: string): string | undefined => {
  const result = tryRunGitWithExit(['-C', dir, 'rev-parse', '--verify', '-q', name], {
    env: runGitEnv(),
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
};

const verifyWithTsgit = async (dir: string, name: string): Promise<string | undefined> => {
  const sut = createNodeContext({ workDir: dir });
  try {
    return await resolveRef(sut, name as RefName, { peel: false });
  } catch {
    return undefined;
  }
};

describe.skipIf(!GIT_AVAILABLE)('loose-ref body grammar interop', () => {
  let root: string;
  let sha: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-loose-body-'));
    runGit(['init', '-q', '-b', 'main', root]);
    runGit(['-C', root, 'config', 'user.name', 'Ada']);
    runGit(['-C', root, 'config', 'user.email', 'ada@example.com']);
    runGit(['-C', root, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env: PINNED_DATES });
    sha = runGit(['-C', root, 'rev-parse', 'HEAD']).trim();
    await mkdir(path.join(root, '.git/refs/heads'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe.each(BODY_ROWS)('Given the loose body row %s', (_row, body) => {
    describe.each(['a', 'z'])('When resolving refs/heads/%s', (leaf) => {
      it('Then tsgit resolves it exactly as git does', async () => {
        // Arrange
        const name = `refs/heads/${leaf}`;
        await writeFile(path.join(root, '.git', name), body(sha));
        const expected = verifyWithGit(root, name);

        // Act
        const result = await verifyWithTsgit(root, name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each(HEAD_ROWS)('Given the HEAD body row %s', (_row, body) => {
    describe('When resolving HEAD', () => {
      it('Then tsgit resolves it exactly as git does', async () => {
        // Arrange
        await writeFile(path.join(root, '.git/HEAD'), body(sha));
        const expected = verifyWithGit(root, 'HEAD');

        // Act
        const result = await verifyWithTsgit(root, 'HEAD');

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
