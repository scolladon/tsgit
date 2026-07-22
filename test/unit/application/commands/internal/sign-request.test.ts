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

  describe('Given format ssh with an override signKey', () => {
    describe('When the sign request resolves', () => {
      it('Then the selector is the override key, not the identity', () => {
        // Arrange
        const config: ParsedConfig = { gpg: { format: 'ssh' } };

        // Act
        const result = sut(config, identity, '/keys/id_ed25519.pub');

        // Assert
        expect(result.selector).toBe('/keys/id_ed25519.pub');
      });
    });
  });

  describe('Given format ssh with user.signingKey and no override', () => {
    describe('When the sign request resolves', () => {
      it('Then the selector is user.signingKey with no identity fallback', () => {
        // Arrange
        const config: ParsedConfig = {
          gpg: { format: 'ssh' },
          user: { signingKey: '/keys/config.pub' },
        };

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect(result.selector).toBe('/keys/config.pub');
      });
    });
  });

  describe('Given format openpgp with neither an override key nor user.signingKey', () => {
    describe('When the sign request resolves', () => {
      it('Then the selector falls back to the "name <email>" identity string', () => {
        // Arrange
        const config: ParsedConfig = { gpg: { format: 'openpgp' } };

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect(result.selector).toBe(identLine);
      });
    });
  });

  describe('Given format openpgp with user.signingKey and no override', () => {
    describe('When the sign request resolves', () => {
      it('Then the selector is user.signingKey, taking precedence over the identity fallback', () => {
        // Arrange
        const config: ParsedConfig = {
          gpg: { format: 'openpgp' },
          user: { signingKey: 'DEADBEEF' },
        };

        // Act
        const result = sut(config, identity, undefined);

        // Assert
        expect(result.selector).toBe('DEADBEEF');
      });
    });
  });

  describe('Given format openpgp with both an override signKey and user.signingKey', () => {
    describe('When the sign request resolves', () => {
      it('Then the override signKey wins over user.signingKey and the identity', () => {
        // Arrange
        const config: ParsedConfig = {
          gpg: { format: 'openpgp' },
          user: { signingKey: 'DEADBEEF' },
        };

        // Act
        const result = sut(config, identity, 'OVERRIDE1');

        // Assert
        expect(result.selector).toBe('OVERRIDE1');
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
