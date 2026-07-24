import { describe, expect, it } from 'vitest';
import { resolveSignRequest as sut } from '../../../../../src/application/commands/internal/sign-request.js';
import type { ParsedConfig } from '../../../../../src/application/primitives/config-read.js';
import type { AuthorIdentity } from '../../../../../src/domain/objects/index.js';

const identity: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1234567890,
  timezoneOffset: '+0000',
};

const identLine = 'A U Thor <author@example.com>';

describe('resolveSignRequest', () => {
  describe('Given a config with no gpg.format', () => {
    describe('When the sign request resolves', () => {
      it('Then the format defaults to openpgp', () => {
        // Arrange
        const config: ParsedConfig = {};

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect(result.format).toBe('openpgp');
      });
    });
  });

  describe('Given format ssh with neither an override key nor user.signingKey', () => {
    describe('When the sign request resolves', () => {
      it('Then the format is ssh and the selector is the empty string', () => {
        // Arrange
        const config: ParsedConfig = { gpg: { format: 'ssh' } };

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect(result.format).toBe('ssh');
        expect(result.selector).toBe('');
      });
    });
  });

  describe('Given a gpg.format and a combination of override key / user.signingKey', () => {
    describe('When the sign request resolves', () => {
      it.each([
        {
          config: { gpg: { format: 'ssh' } } as ParsedConfig,
          override: '/keys/id_ed25519.pub',
          expectedSelector: '/keys/id_ed25519.pub',
          label: 'format ssh with an override signKey uses it, not the identity',
        },
        {
          config: {
            gpg: { format: 'ssh' },
            user: { signingKey: '/keys/config.pub' },
          } as ParsedConfig,
          override: undefined,
          expectedSelector: '/keys/config.pub',
          label:
            'format ssh with user.signingKey and no override uses it with no identity fallback',
        },
        {
          config: { gpg: { format: 'openpgp' } } as ParsedConfig,
          override: undefined,
          expectedSelector: identLine,
          label:
            'format openpgp with neither an override key nor user.signingKey falls back to the "name <email>" identity string',
        },
        {
          config: {
            gpg: { format: 'openpgp' },
            user: { signingKey: 'DEADBEEF' },
          } as ParsedConfig,
          override: undefined,
          expectedSelector: 'DEADBEEF',
          label:
            'format openpgp with user.signingKey and no override takes precedence over the identity fallback',
        },
        {
          config: {
            gpg: { format: 'openpgp' },
            user: { signingKey: 'DEADBEEF' },
          } as ParsedConfig,
          override: 'OVERRIDE1',
          expectedSelector: 'OVERRIDE1',
          label:
            'format openpgp with both an override signKey and user.signingKey has the override win over both',
        },
      ])('Then $label', ({ config, override, expectedSelector }) => {
        // Arrange + Act
        const result = sut(config, identity, override);

        // Assert
        expect(result.selector).toBe(expectedSelector);
      });
    });
  });

  describe('Given format openpgp with gpg.program configured', () => {
    describe('When the sign request resolves', () => {
      it('Then the request carries gpg.program', () => {
        // Arrange
        const config: ParsedConfig = { gpg: { format: 'openpgp', program: '/usr/bin/gpg2' } };

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect(result.program).toBe('/usr/bin/gpg2');
      });
    });
  });

  describe('Given format ssh with gpg.ssh.program configured', () => {
    describe('When the sign request resolves', () => {
      it('Then the request carries gpg.ssh.program', () => {
        // Arrange
        const config: ParsedConfig = {
          gpg: { format: 'ssh', program: '/usr/bin/gpg2', ssh: { program: '/usr/bin/ssh-keygen' } },
        };

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect(result.program).toBe('/usr/bin/ssh-keygen');
      });
    });
  });

  describe('Given a config with no program configured for the chosen format', () => {
    describe('When the sign request resolves', () => {
      it('Then program is omitted from the request entirely', () => {
        // Arrange
        const config: ParsedConfig = { gpg: { format: 'openpgp' } };

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect('program' in result).toBe(false);
      });
    });
  });
});
