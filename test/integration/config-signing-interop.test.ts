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

  describe('Given git config sets user.signingKey', () => {
    describe('When readConfig runs', () => {
      it('Then user.signingKey matches the git-written value', async () => {
        // Arrange
        runGit(['-C', pair.ours, 'config', 'user.signingKey', 'ABCD1234EF']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.user?.signingKey).toBe('ABCD1234EF');
      });
    });
  });

  describe('Given git config sets commit.gpgsign true', () => {
    describe('When readConfig runs', () => {
      it('Then commit.gpgSign matches the git-written value', async () => {
        // Arrange
        runGit(['-C', pair.ours, 'config', 'commit.gpgsign', 'true']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.commit?.gpgSign).toBe(true);
      });
    });
  });

  describe('Given git config sets tag.gpgsign true', () => {
    describe('When readConfig runs', () => {
      it('Then tag.gpgSign matches the git-written value', async () => {
        // Arrange
        runGit(['-C', pair.ours, 'config', 'tag.gpgsign', 'true']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.tag?.gpgSign).toBe(true);
      });
    });
  });

  describe('Given git config sets push.gpgsign if-asked', () => {
    describe('When readConfig runs', () => {
      it('Then push.gpgSign matches the git-written value', async () => {
        // Arrange
        runGit(['-C', pair.ours, 'config', 'push.gpgsign', 'if-asked']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.push?.gpgSign).toBe('if-asked');
      });
    });
  });

  describe('Given git config sets gpg.format ssh', () => {
    describe('When readConfig runs', () => {
      it('Then gpg.format matches the git-written value', async () => {
        // Arrange
        runGit(['-C', pair.ours, 'config', 'gpg.format', 'ssh']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.gpg?.format).toBe('ssh');
      });
    });
  });

  describe('Given git config sets gpg.program', () => {
    describe('When readConfig runs', () => {
      it('Then gpg.program matches the git-written value', async () => {
        // Arrange
        runGit(['-C', pair.ours, 'config', 'gpg.program', '/usr/bin/gpg2']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.gpg?.program).toBe('/usr/bin/gpg2');
      });
    });
  });

  describe('Given git config sets gpg.ssh.program', () => {
    describe('When readConfig runs', () => {
      it('Then gpg.ssh.program matches the git-written value', async () => {
        // Arrange
        runGit(['-C', pair.ours, 'config', 'gpg.ssh.program', '/usr/bin/ssh-keygen']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.gpg?.ssh?.program).toBe('/usr/bin/ssh-keygen');
      });
    });
  });
});
