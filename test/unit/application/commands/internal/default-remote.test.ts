import { describe, expect, it } from 'vitest';
import {
  resolvePushRemote,
  defaultRemoteName as sut,
} from '../../../../../src/application/commands/internal/default-remote.js';
import type { ParsedConfig } from '../../../../../src/application/primitives/config-read.js';

describe('Given a parsed config, an explicit remote, and a branch', () => {
  describe('When defaultRemoteName resolves the fallback chain', () => {
    it.each([
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote' }]]),
          remote: new Map([['solermt', {}]]),
        } as ParsedConfig,
        explicit: 'explicitRemote',
        branch: 'main',
        expected: 'explicitRemote',
        label: 'an explicit remote wins over tracking, sole-remote, and the default',
      },
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote' }]]),
          remote: new Map([
            ['a', {}],
            ['b', {}],
          ]),
        } as ParsedConfig,
        explicit: undefined,
        branch: 'main',
        expected: 'trackingRemote',
        label: 'the tracking remote wins when there is no explicit remote',
      },
      {
        config: {
          branch: new Map([['main', {}]]),
          remote: new Map([['upstreamonly', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        branch: 'main',
        expected: 'upstreamonly',
        label: 'the sole configured remote wins when there is no explicit or tracking remote',
      },
      {
        config: {
          remote: new Map([
            ['a', {}],
            ['b', {}],
          ]),
        } as ParsedConfig,
        explicit: undefined,
        branch: undefined,
        expected: 'origin',
        label: 'more than one configured remote falls through to DEFAULT_REMOTE',
      },
      {
        config: {
          branch: new Map([['other', { remote: 'otherTrackingRemote' }]]),
          remote: new Map([['upstreamonly', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        branch: undefined,
        expected: 'upstreamonly',
        label:
          'an undefined branch short-circuits the tracking lookup yet still applies the sole-remote fallback (config.branch is populated for a different branch, proving no config.branch.get(undefined) attempt)',
      },
      {
        config: {} as ParsedConfig,
        explicit: undefined,
        branch: undefined,
        expected: 'origin',
        label: 'an empty/absent config.remote falls through to DEFAULT_REMOTE',
      },
    ])('Then $label', ({ config, explicit, branch, expected }) => {
      // Arrange + Act
      const result = sut(config, explicit, branch);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('Given a parsed config, an explicit remote, and the current branch', () => {
  describe('When resolvePushRemote resolves the push-remote fallback chain', () => {
    it.each([
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
          remotePushDefault: 'pushDefaultCfg',
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: 'explicitRemote',
        expected: 'explicitRemote',
        label:
          'an explicit remote wins over pushRemote, remotePushDefault, branch.remote, and sole',
      },
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
          remotePushDefault: 'pushDefaultCfg',
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'pushRemoteCfg',
        label: 'branch.<current>.pushRemote wins when there is no explicit remote',
      },
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote' }]]),
          remotePushDefault: 'pushDefaultCfg',
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'pushDefaultCfg',
        label:
          'remote.pushDefault wins over branch.<current>.remote when there is no explicit remote or pushRemote',
      },
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote' }]]),
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'trackingRemote',
        label:
          'branch.<current>.remote wins over the sole-remote fallback when there is no explicit remote, pushRemote, or remotePushDefault',
      },
      {
        config: {
          branch: new Map([['main', {}]]),
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'soleRemote',
        label:
          'the sole configured remote wins when there is no explicit remote, pushRemote, remotePushDefault, or branch.remote',
      },
      {
        config: {
          remote: new Map([
            ['a', {}],
            ['b', {}],
          ]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'origin',
        label: 'more than one configured remote falls through to DEFAULT_REMOTE',
      },
      {
        config: {} as ParsedConfig,
        explicit: undefined,
        expected: 'origin',
        label: 'an empty/absent config.remote falls through to DEFAULT_REMOTE',
      },
    ])('Then $label', ({ config, explicit, expected }) => {
      // Arrange + Act
      const result = resolvePushRemote(config, explicit, 'main');

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('When resolvePushRemote resolves with a detached HEAD (branch is undefined)', () => {
    it.each([
      {
        config: {
          remotePushDefault: 'pushDefaultCfg',
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: 'explicitRemote',
        expected: 'explicitRemote',
        label: 'an explicit remote still wins',
      },
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
          remotePushDefault: 'pushDefaultCfg',
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'pushDefaultCfg',
        label:
          'remote.pushDefault wins over the sole-remote fallback, and branch.<name>.pushRemote/remote configured under a different key are never consulted',
      },
      {
        config: {
          branch: new Map([['main', { remote: 'trackingRemote', pushRemote: 'pushRemoteCfg' }]]),
          remote: new Map([['soleRemote', {}]]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'soleRemote',
        label:
          'the sole configured remote wins when there is no explicit remote or remotePushDefault',
      },
      {
        config: {
          remote: new Map([
            ['a', {}],
            ['b', {}],
          ]),
        } as ParsedConfig,
        explicit: undefined,
        expected: 'origin',
        label: 'more than one configured remote falls through to DEFAULT_REMOTE',
      },
    ])('Then $label', ({ config, explicit, expected }) => {
      // Arrange + Act
      const result = resolvePushRemote(config, explicit, undefined);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
