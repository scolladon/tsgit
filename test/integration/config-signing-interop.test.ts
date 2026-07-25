/**
 * Cross-tool interop — signing config keys. Canonical `git config` writes
 * `user.signingKey`, `commit.gpgsign`, `tag.gpgsign`, `push.gpgsign`, and
 * `gpg.*`; tsgit's `readConfig` must surface the identical parsed value.
 *
 * @proves
 *   surface:        config
 *   bucket:         cross-tool-interop
 *   unique:         signing config keys (user.signingKey, commit/tag/push.gpgsign, gpg.*) readback matches git config writes
 *   interopSurface: config
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readConfig } from '../../src/application/primitives/config-read.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('config signing interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('config-signing');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given git config sets a signing-related key', () => {
    describe('When readConfig runs', () => {
      const SIGNING_KEY_ROWS: ReadonlyArray<{
        readonly label: string;
        readonly gitArgs: readonly [string, string];
        readonly pick: (result: Awaited<ReturnType<typeof readConfig>>) => unknown;
        readonly expected: unknown;
      }> = [
        {
          label: 'user.signingKey matches the git-written value',
          gitArgs: ['user.signingKey', 'ABCD1234EF'],
          pick: (result) => result.user?.signingKey,
          expected: 'ABCD1234EF',
        },
        {
          label: 'commit.gpgSign matches the git-written value',
          gitArgs: ['commit.gpgsign', 'true'],
          pick: (result) => result.commit?.gpgSign,
          expected: true,
        },
        {
          label: 'tag.gpgSign matches the git-written value',
          gitArgs: ['tag.gpgsign', 'true'],
          pick: (result) => result.tag?.gpgSign,
          expected: true,
        },
        {
          label: 'push.gpgSign matches the git-written value',
          gitArgs: ['push.gpgsign', 'if-asked'],
          pick: (result) => result.push?.gpgSign,
          expected: 'if-asked',
        },
        {
          label: 'gpg.format matches the git-written value',
          gitArgs: ['gpg.format', 'ssh'],
          pick: (result) => result.gpg?.format,
          expected: 'ssh',
        },
        {
          label: 'gpg.program matches the git-written value',
          gitArgs: ['gpg.program', '/usr/bin/gpg2'],
          pick: (result) => result.gpg?.program,
          expected: '/usr/bin/gpg2',
        },
        {
          label: 'gpg.ssh.program matches the git-written value',
          gitArgs: ['gpg.ssh.program', '/usr/bin/ssh-keygen'],
          pick: (result) => result.gpg?.ssh?.program,
          expected: '/usr/bin/ssh-keygen',
        },
      ];

      it.each(SIGNING_KEY_ROWS)('Then $label', async ({ gitArgs, pick, expected }) => {
        // Arrange
        runGit(['-C', pair.ours, 'config', ...gitArgs]);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(pick(result)).toBe(expected);
      });
    });
  });
});
