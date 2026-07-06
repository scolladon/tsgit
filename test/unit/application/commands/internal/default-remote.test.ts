import { describe, expect, it } from 'vitest';
import { defaultRemoteName as sut } from '../../../../../src/application/commands/internal/default-remote.js';
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
