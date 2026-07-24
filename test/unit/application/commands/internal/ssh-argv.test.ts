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
  describe('Given a path', () => {
    describe('When quoted', () => {
      it.each([
        {
          input: '/path/to/repo.git',
          expected: "'/path/to/repo.git'",
          label: 'a plain path with no special characters is wrapped in single quotes',
        },
        {
          input: '/pa th.git',
          expected: "'/pa th.git'",
          label: 'a path containing a space preserves the space verbatim inside the quotes',
        },
        {
          input: "o'brien/repo.git",
          expected: "'o'\\''brien/repo.git'",
          label:
            'a path containing an embedded single quote escapes it as close-quote, escaped-quote, reopen-quote',
        },
        { input: '', expected: "''", label: 'an empty string becomes an empty quoted token' },
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut(input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('buildSshArgs', () => {
  describe('Given an ssh url and a service/baseArgs combination', () => {
    describe('When building argv', () => {
      it.each([
        {
          parsed: sshUrl({ user: 'git', host: 'example.com' }),
          service: 'git-upload-pack',
          baseArgs: [],
          expected: ['git@example.com', "git-upload-pack '/path/to/repo.git'"],
          label: 'no explicit port emits no -p flag',
        },
        {
          parsed: sshUrl({ user: 'git', host: 'example.com', port: 2222 }),
          service: 'git-upload-pack',
          baseArgs: [],
          expected: ['-p', '2222', 'git@example.com', "git-upload-pack '/path/to/repo.git'"],
          label: 'an explicit non-default port emits a -p flag with the port',
        },
        {
          parsed: sshUrl({ user: 'git', host: 'example.com', port: 22 }),
          service: 'git-upload-pack',
          baseArgs: [],
          expected: ['-p', '22', 'git@example.com', "git-upload-pack '/path/to/repo.git'"],
          label:
            'the explicit default port 22 still emits the -p flag (explicit port is never dropped)',
        },
        {
          parsed: sshUrl({ host: 'example.com' }),
          service: 'git-upload-pack',
          baseArgs: [],
          expected: ['example.com', "git-upload-pack '/path/to/repo.git'"],
          label: 'no user makes the host token the bare host',
        },
        {
          parsed: sshUrl({ user: 'git', host: 'example.com' }),
          service: 'git-receive-pack',
          baseArgs: [],
          expected: ['git@example.com', "git-receive-pack '/path/to/repo.git'"],
          label: 'a push (git-receive-pack) service names the remote command git-receive-pack',
        },
        {
          parsed: sshUrl({ user: 'git', host: 'example.com', port: 2222 }),
          service: 'git-upload-pack',
          baseArgs: ['-v'],
          expected: ['-v', '-p', '2222', 'git@example.com', "git-upload-pack '/path/to/repo.git'"],
          label:
            'non-empty baseArgs from ssh-command resolution are placed before the port flag and host token',
        },
        {
          parsed: sshUrl({ user: 'git', host: 'example.com', path: '~/repo.git' }),
          service: 'git-upload-pack',
          baseArgs: [],
          expected: ['git@example.com', "git-upload-pack '~/repo.git'"],
          label: 'a tilde-collapsed remote path is sq-quoted verbatim',
        },
      ] as const)('Then $label', ({ parsed, service, baseArgs, expected }) => {
        // Arrange
        const sut = buildSshArgs;

        // Act
        const result = sut({ service, parsed, baseArgs });

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
