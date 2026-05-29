/**
 * Cross-tool interop — commit message normalization. Drives the `commit`
 * porcelain through the real `openRepository` facade and commits the same
 * staged tree + identity via canonical `git commit -m`, then asserts the
 * commit-object SHAs match. This is the faithfulness proof that the porcelain
 * applies git's `stripspace` (whitespace cleanup) to the message rather than a
 * lossy `String.trim()`.
 *
 * @proves
 *   surface:        commit
 *   bucket:         cross-tool-interop
 *   unique:         commit porcelain SHA matches canonical git across message shapes
 *   interopSurface: commit
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

// Message shapes that diverge under `String.trim()` but must match git once
// `stripspace` is applied: trailing whitespace, an internal blank-line run, a
// bare message with no trailing newline, and an already-normalized message.
const MESSAGE_SHAPES: ReadonlyArray<{ readonly label: string; readonly message: string }> = [
  { label: 'trailing whitespace', message: 'msg with trailing ws   ' },
  { label: 'internal blank-line run', message: 'subject\n\n\nbody' },
  { label: 'no trailing newline', message: 'no trailing newline' },
  { label: 'already normalized', message: 'a\n\nb\n' },
];

interface CommitComparison {
  readonly oursId: string;
  readonly peerId: string;
  readonly oursObject: string;
  readonly peerObject: string;
}

const commitBothWays = async (message: string): Promise<CommitComparison> => {
  const peer = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-commit-message-peer-')));
  const ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-commit-message-ours-')));
  const repo = await openRepository({ cwd: ours });
  try {
    // Arrange — identical staged tree on both sides.
    await writeFile(path.join(peer, 'a.txt'), 'hello\n');
    await writeFile(path.join(ours, 'a.txt'), 'hello\n');
    runGit(['init', '-q', '-b', 'main', peer]);
    runGit(['-C', peer, 'add', 'a.txt']);
    await repo.init();
    await repo.add(['a.txt']);

    // Act — peer via canonical git (signing off, whitespace cleanup pinned),
    // ours via the porcelain.
    runGit(
      [
        '-C',
        peer,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'commit.cleanup=whitespace',
        'commit',
        '-q',
        '-m',
        message,
      ],
      { env: COMMIT_ENV },
    );
    const peerId = runGit(['-C', peer, 'rev-parse', 'HEAD']).trim();
    const oursResult = await repo.commit({ message, author: AUTHOR, committer: AUTHOR });

    return {
      oursId: oursResult.id,
      peerId,
      oursObject: runGit(['-C', ours, 'cat-file', '-p', oursResult.id]),
      peerObject: runGit(['-C', peer, 'cat-file', '-p', peerId]),
    };
  } finally {
    await repo.dispose();
    await rm(peer, { recursive: true, force: true });
    await rm(ours, { recursive: true, force: true });
  }
};

describe.skipIf(!GIT_AVAILABLE)('commit message interop', () => {
  let tmpProbe: string;

  beforeEach(async () => {
    // Touch a tmpdir so a failure to allocate surfaces here, not mid-assert.
    tmpProbe = await mkdtemp(path.join(os.tmpdir(), 'tsgit-commit-message-probe-'));
  });

  afterEach(async () => {
    await rm(tmpProbe, { recursive: true, force: true });
  });

  for (const { label, message } of MESSAGE_SHAPES) {
    describe(`Given a message with ${label}, When the commit porcelain and canonical git commit it`, () => {
      it('Then the commit-object SHAs match', async () => {
        // Arrange + Act
        const sut = await commitBothWays(message);

        // Assert
        expect(sut.oursId).toBe(sut.peerId);
        expect(sut.oursObject).toBe(sut.peerObject);
      });
    });
  }
});
