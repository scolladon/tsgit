import { describe, expect, it } from 'vitest';
import {
  resolvePushRemote,
  defaultRemoteName as sut,
} from '../../../../../src/application/commands/internal/default-remote.js';
import type { ParsedConfig } from '../../../../../src/application/primitives/config-read.js';

describe('Given a parsed config, an explicit remote, and a branch', () => {
  describe('When defaultRemoteName resolves the fallback chain', () => {
    it('Then an explicit remote wins over tracking, sole-remote, and the default', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote' }]]),
        remote: new Map([['solermt', {}]]),
      };

      // Act
      const result = sut(config, 'explicitRemote', 'main');

      // Assert
      expect(result).toBe('explicitRemote');
    });

    it('Then the tracking remote wins when there is no explicit remote', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote' }]]),
        remote: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      };

      // Act
      const result = sut(config, undefined, 'main');

      // Assert
      expect(result).toBe('trackingRemote');
    });

    it('Then the sole configured remote wins when there is no explicit or tracking remote', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', {}]]),
        remote: new Map([['upstreamonly', {}]]),
      };

      // Act
      const result = sut(config, undefined, 'main');

      // Assert
      expect(result).toBe('upstreamonly');
    });

    it('Then more than one configured remote falls through to DEFAULT_REMOTE', () => {
      // Arrange
      const config: ParsedConfig = {
        remote: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      };

      // Act
      const result = sut(config, undefined, undefined);

      // Assert
      expect(result).toBe('origin');
    });

    it('Then an undefined branch short-circuits the tracking lookup yet still applies the sole-remote fallback', () => {
      // Arrange — config.branch is populated (a different branch), proving the
      // resolution does not attempt `config.branch.get(undefined)`.
      const config: ParsedConfig = {
        branch: new Map([['other', { remote: 'otherTrackingRemote' }]]),
        remote: new Map([['upstreamonly', {}]]),
      };

      // Act
      const result = sut(config, undefined, undefined);

      // Assert
      expect(result).toBe('upstreamonly');
    });

    it('Then an empty/absent config.remote falls through to DEFAULT_REMOTE', () => {
      // Arrange
      const config: ParsedConfig = {};

      // Act
      const result = sut(config, undefined, undefined);

      // Assert
      expect(result).toBe('origin');
    });
  });
});

describe('Given a parsed config, an explicit remote, and the current branch', () => {
  describe('When resolvePushRemote resolves the push-remote fallback chain', () => {
    it('Then an explicit remote wins over pushRemote, remotePushDefault, branch.remote, and sole', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
        remotePushDefault: 'pushDefaultCfg',
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, 'explicitRemote', 'main');

      // Assert
      expect(result).toBe('explicitRemote');
    });

    it('Then branch.<current>.pushRemote wins when there is no explicit remote', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
        remotePushDefault: 'pushDefaultCfg',
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, 'main');

      // Assert
      expect(result).toBe('pushRemoteCfg');
    });

    it('Then remote.pushDefault wins over branch.<current>.remote when there is no explicit remote or pushRemote', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote' }]]),
        remotePushDefault: 'pushDefaultCfg',
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, 'main');

      // Assert
      expect(result).toBe('pushDefaultCfg');
    });

    it('Then branch.<current>.remote wins over the sole-remote fallback when there is no explicit remote, pushRemote, or remotePushDefault', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote' }]]),
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, 'main');

      // Assert
      expect(result).toBe('trackingRemote');
    });

    it('Then the sole configured remote wins when there is no explicit remote, pushRemote, remotePushDefault, or branch.remote', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', {}]]),
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, 'main');

      // Assert
      expect(result).toBe('soleRemote');
    });

    it('Then more than one configured remote falls through to DEFAULT_REMOTE', () => {
      // Arrange
      const config: ParsedConfig = {
        remote: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, 'main');

      // Assert
      expect(result).toBe('origin');
    });

    it('Then an empty/absent config.remote falls through to DEFAULT_REMOTE', () => {
      // Arrange
      const config: ParsedConfig = {};

      // Act
      const result = resolvePushRemote(config, undefined, 'main');

      // Assert
      expect(result).toBe('origin');
    });
  });

  describe('When resolvePushRemote resolves with a detached HEAD (branch is undefined)', () => {
    it('Then an explicit remote still wins', () => {
      // Arrange
      const config: ParsedConfig = {
        remotePushDefault: 'pushDefaultCfg',
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, 'explicitRemote', undefined);

      // Assert
      expect(result).toBe('explicitRemote');
    });

    it('Then remote.pushDefault wins over the sole-remote fallback, and branch.<name>.pushRemote/remote configured under a different key are never consulted', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
        remotePushDefault: 'pushDefaultCfg',
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, undefined);

      // Assert
      expect(result).toBe('pushDefaultCfg');
    });

    it('Then the sole configured remote wins when there is no explicit remote or remotePushDefault', () => {
      // Arrange
      const config: ParsedConfig = {
        branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
        remote: new Map([['soleRemote', {}]]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, undefined);

      // Assert
      expect(result).toBe('soleRemote');
    });

    it('Then more than one configured remote falls through to DEFAULT_REMOTE', () => {
      // Arrange
      const config: ParsedConfig = {
        remote: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      };

      // Act
      const result = resolvePushRemote(config, undefined, undefined);

      // Assert
      expect(result).toBe('origin');
    });
  });
});
