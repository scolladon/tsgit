import { describe, expect, it } from 'vitest';
import type { RemoteUrl } from '../../../../../src/application/commands/internal/remote-url.js';
import {
  buildSshArgs,
  sqQuote,
} from '../../../../../src/application/commands/internal/ssh-argv.js';

type SshRemoteUrl = Extract<RemoteUrl, { kind: 'ssh' }>;

const sshUrl = (overrides: Partial<SshRemoteUrl> & { readonly host: string }): SshRemoteUrl => ({
  kind: 'ssh',
  path: '/path/to/repo.git',
  ...overrides,
});

describe('sqQuote', () => {
  describe('Given a plain path with no special characters', () => {
    describe('When quoted', () => {
      it('Then it is wrapped in single quotes', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut('/path/to/repo.git');

        // Assert
        expect(result).toBe("'/path/to/repo.git'");
      });
    });
  });

  describe('Given a path containing a space', () => {
    describe('When quoted', () => {
      it('Then the space is preserved verbatim inside the quotes', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut('/pa th.git');

        // Assert
        expect(result).toBe("'/pa th.git'");
      });
    });
  });

  describe('Given a path containing an embedded single quote', () => {
    describe('When quoted', () => {
      it('Then the quote is escaped as close-quote, escaped-quote, reopen-quote', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut("o'brien/repo.git");

        // Assert
        expect(result).toBe("'o'\\''brien/repo.git'");
      });
    });
  });

  describe('Given an empty string', () => {
    describe('When quoted', () => {
      it('Then it becomes an empty quoted token', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut('');

        // Assert
        expect(result).toBe("''");
      });
    });
  });
});

describe('buildSshArgs', () => {
  describe('Given an ssh url with no explicit port', () => {
    describe('When building argv for git-upload-pack', () => {
      it('Then no -p flag is emitted', () => {
        // Arrange
        const sut = buildSshArgs;
        const parsed = sshUrl({ user: 'git', host: 'example.com' });

        // Act
        const result = sut({ service: 'git-upload-pack', parsed, baseArgs: [] });

        // Assert
        expect(result).toEqual(['git@example.com', "git-upload-pack '/path/to/repo.git'"]);
      });
    });
  });

  describe('Given an ssh url with an explicit non-default port', () => {
    describe('When building argv', () => {
      it('Then a -p flag with the port is emitted', () => {
        // Arrange
        const sut = buildSshArgs;
        const parsed = sshUrl({ user: 'git', host: 'example.com', port: 2222 });

        // Act
        const result = sut({ service: 'git-upload-pack', parsed, baseArgs: [] });

        // Assert
        expect(result).toEqual([
          '-p',
          '2222',
          'git@example.com',
          "git-upload-pack '/path/to/repo.git'",
        ]);
      });
    });
  });

  describe('Given an ssh url with the explicit default port 22', () => {
    describe('When building argv', () => {
      it('Then the -p flag is still emitted (explicit port is never dropped)', () => {
        // Arrange
        const sut = buildSshArgs;
        const parsed = sshUrl({ user: 'git', host: 'example.com', port: 22 });

        // Act
        const result = sut({ service: 'git-upload-pack', parsed, baseArgs: [] });

        // Assert
        expect(result).toEqual([
          '-p',
          '22',
          'git@example.com',
          "git-upload-pack '/path/to/repo.git'",
        ]);
      });
    });
  });

  describe('Given an ssh url with no user', () => {
    describe('When building argv', () => {
      it('Then the host token is the bare host', () => {
        // Arrange
        const sut = buildSshArgs;
        const parsed = sshUrl({ host: 'example.com' });

        // Act
        const result = sut({ service: 'git-upload-pack', parsed, baseArgs: [] });

        // Assert
        expect(result).toEqual(['example.com', "git-upload-pack '/path/to/repo.git'"]);
      });
    });
  });

  describe('Given a push (git-receive-pack) service', () => {
    describe('When building argv', () => {
      it('Then the remote command token names git-receive-pack', () => {
        // Arrange
        const sut = buildSshArgs;
        const parsed = sshUrl({ user: 'git', host: 'example.com' });

        // Act
        const result = sut({ service: 'git-receive-pack', parsed, baseArgs: [] });

        // Assert
        expect(result).toEqual(['git@example.com', "git-receive-pack '/path/to/repo.git'"]);
      });
    });
  });

  describe('Given non-empty baseArgs from ssh-command resolution', () => {
    describe('When building argv', () => {
      it('Then baseArgs are placed before the port flag and host token', () => {
        // Arrange
        const sut = buildSshArgs;
        const parsed = sshUrl({ user: 'git', host: 'example.com', port: 2222 });

        // Act
        const result = sut({ service: 'git-upload-pack', parsed, baseArgs: ['-v'] });

        // Assert
        expect(result).toEqual([
          '-v',
          '-p',
          '2222',
          'git@example.com',
          "git-upload-pack '/path/to/repo.git'",
        ]);
      });
    });
  });

  describe('Given a tilde-collapsed remote path', () => {
    describe('When building argv', () => {
      it('Then the remote command sq-quotes the tilde path verbatim', () => {
        // Arrange
        const sut = buildSshArgs;
        const parsed = sshUrl({ user: 'git', host: 'example.com', path: '~/repo.git' });

        // Act
        const result = sut({ service: 'git-upload-pack', parsed, baseArgs: [] });

        // Assert
        expect(result).toEqual(['git@example.com', "git-upload-pack '~/repo.git'"]);
      });
    });
  });
});
