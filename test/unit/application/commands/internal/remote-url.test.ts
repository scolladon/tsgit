import { describe, expect, it } from 'vitest';

import {
  anonymizeRemoteUrl,
  formatRemoteUrl,
  parseRemoteUrl,
  type RemoteUrl,
} from '../../../../../src/application/commands/internal/remote-url.js';
import { TsgitError } from '../../../../../src/domain/index.js';

const expectInvalidUrl = (raw: string): TsgitError => {
  let caught: unknown;
  try {
    parseRemoteUrl(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe('INVALID_URL');
  return caught as TsgitError;
};

describe('internal/remote-url', () => {
  describe('http(s) pass-through', () => {
    describe('Given an https URL', () => {
      describe('When parseRemoteUrl', () => {
        it('Then returns kind http carrying the raw url verbatim', () => {
          // Arrange
          const raw = 'https://example.com/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({ kind: 'http', url: raw });
        });
      });
    });

    describe('Given an http URL', () => {
      describe('When parseRemoteUrl', () => {
        it('Then returns kind http carrying the raw url verbatim', () => {
          // Arrange
          const raw = 'http://example.com/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({ kind: 'http', url: raw });
        });
      });
    });
  });

  describe('ssh:// host/port/path extraction (design matrix B)', () => {
    describe('Given ssh://git@example.com/path/to/repo.git', () => {
      describe('When parseRemoteUrl', () => {
        it('Then extracts user, host, and path with no port', () => {
          // Arrange
          const raw = 'ssh://git@example.com/path/to/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: '/path/to/repo.git',
          });
        });
      });
    });

    describe('Given ssh://git@example.com:2222/path/to/repo.git', () => {
      describe('When parseRemoteUrl', () => {
        it('Then extracts the explicit non-default port', () => {
          // Arrange
          const raw = 'ssh://git@example.com:2222/path/to/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            port: 2222,
            path: '/path/to/repo.git',
          });
        });
      });
    });

    describe('Given ssh://git@example.com:22/repo.git (explicit default port)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then keeps port 22 rather than dropping it', () => {
          // Arrange
          const raw = 'ssh://git@example.com:22/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            port: 22,
            path: '/repo.git',
          });
        });
      });
    });

    describe('Given ssh://example.com/repo.git (no user)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then omits the user field', () => {
          // Arrange
          const raw = 'ssh://example.com/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({ kind: 'ssh', host: 'example.com', path: '/repo.git' });
        });
      });
    });

    describe('Given ssh://git@example.com/~/repo.git (home-relative tilde)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then collapses the leading slash before the tilde', () => {
          // Arrange
          const raw = 'ssh://git@example.com/~/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: '~/repo.git',
          });
        });
      });
    });

    describe('Given ssh://git@example.com/~user/repo.git (named-user tilde)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then collapses the leading slash before the tilde', () => {
          // Arrange
          const raw = 'ssh://git@example.com/~user/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: '~user/repo.git',
          });
        });
      });
    });

    describe('Given a malformed ssh:// URL (out-of-range port)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('ssh://example.com:999999/repo.git');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason).toContain('valid URL');
          }
        });
      });
    });
  });

  describe('scp-like host/path extraction (design matrix B)', () => {
    describe('Given git@example.com:path/to/repo.git (relative)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then keeps the path relative with no leading slash', () => {
          // Arrange
          const raw = 'git@example.com:path/to/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: 'path/to/repo.git',
          });
        });
      });
    });

    describe('Given git@example.com:/abs/path/repo.git (absolute)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then keeps the leading slash verbatim', () => {
          // Arrange
          const raw = 'git@example.com:/abs/path/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: '/abs/path/repo.git',
          });
        });
      });
    });

    describe('Given git@example.com:~user/repo.git (tilde-user)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then keeps the tilde verbatim (scp form never collapses)', () => {
          // Arrange
          const raw = 'git@example.com:~user/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: '~user/repo.git',
          });
        });
      });
    });

    describe('Given example.com:repo.git (no user)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then omits the user field', () => {
          // Arrange
          const raw = 'example.com:repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({ kind: 'ssh', host: 'example.com', path: 'repo.git' });
        });
      });
    });
  });

  describe('scp-vs-ssh disambiguation', () => {
    describe('Given an unrecognised scheme with a colon before its first slash (ftp://)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL rather than misreading it as scp-like', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('ftp://example.com/repo.git');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason).toContain('unrecognised');
          }
        });
      });
    });

    describe('Given a string with no colon at all', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL', () => {
          // Arrange + Act + Assert
          expectInvalidUrl('just-a-path/repo.git');
        });
      });
    });

    describe('Given a string whose first slash appears before its first colon', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL rather than misreading it as scp-like', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('path/to:something');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason).toContain('unrecognised');
          }
        });
      });
    });
  });

  describe('Dash-guard (SSH argument-injection refusal, design matrix E)', () => {
    describe('Given ssh://-oProxyCommand=evil/repo.git (host-dash, ssh form)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL naming the sanitized hostname', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('ssh://-oProxyCommand=evil/repo.git');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason).toContain("strange hostname '-oProxyCommand=evil' blocked");
          }
        });
      });
    });

    describe('Given git@example.com:-leadingdash/repo.git (path-dash, scp form)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL naming the sanitized pathname', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('git@example.com:-leadingdash/repo.git');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason).toContain("strange pathname '-leadingdash/repo.git' blocked");
          }
        });
      });
    });

    describe('Given -evil.example.com:repo.git (host-dash, scp form, no user)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL naming the sanitized hostname', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('-evil.example.com:repo.git');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason).toContain("strange hostname '-evil.example.com' blocked");
          }
        });
      });
    });

    describe('Given ssh://git@example.com/-dash.git (ssh path starts with /, not -)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then is allowed', () => {
          // Arrange
          const raw = 'ssh://git@example.com/-dash.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: '/-dash.git',
          });
        });
      });
    });

    describe('Given ssh://git@-evil.example.com/repo.git (host token starts with the user, not -)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then is allowed', () => {
          // Arrange
          const raw = 'ssh://git@-evil.example.com/repo.git';

          // Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({
            kind: 'ssh',
            user: 'git',
            host: '-evil.example.com',
            path: '/repo.git',
          });
        });
      });
    });
  });

  describe('Control-character rejection', () => {
    describe('Given a URL containing a lone LF (0x0a)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL naming a control character', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('ssh://example.com/repo.git\n');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('control');
          }
        });
      });
    });

    describe('Given a URL containing a lone CR (0x0d)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL naming a control character', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('ssh://example.com/repo.git\r');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('control');
          }
        });
      });
    });

    describe('Given a URL containing a NUL byte (0x00)', () => {
      describe('When parseRemoteUrl', () => {
        it('Then throws INVALID_URL naming a control character', () => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl('ssh://example.com/repo.git\0');
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('control');
          }
        });
      });
    });
  });

  describe('formatRemoteUrl (inverse used by the round-trip property)', () => {
    describe('Given an http RemoteUrl', () => {
      describe('When formatRemoteUrl', () => {
        it('Then returns the stored url verbatim', () => {
          // Arrange
          const parsed: RemoteUrl = { kind: 'http', url: 'https://example.com/repo.git' };

          // Act
          const result = formatRemoteUrl(parsed);

          // Assert
          expect(result).toBe('https://example.com/repo.git');
        });
      });
    });

    describe('Given an ssh RemoteUrl with a port', () => {
      describe('When formatRemoteUrl', () => {
        it('Then reconstructs the canonical ssh:// form', () => {
          // Arrange
          const parsed: RemoteUrl = {
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            port: 2222,
            path: '/repo.git',
          };

          // Act
          const result = formatRemoteUrl(parsed);

          // Assert
          expect(result).toBe('ssh://git@example.com:2222/repo.git');
        });
      });
    });

    describe('Given an ssh RemoteUrl with a tilde path and a port', () => {
      describe('When formatRemoteUrl', () => {
        it('Then re-adds the leading slash before the tilde', () => {
          // Arrange
          const parsed: RemoteUrl = {
            kind: 'ssh',
            host: 'example.com',
            port: 22,
            path: '~/repo.git',
          };

          // Act
          const result = formatRemoteUrl(parsed);

          // Assert
          expect(result).toBe('ssh://example.com:22/~/repo.git');
        });
      });
    });

    describe('Given an ssh RemoteUrl without a port', () => {
      describe('When formatRemoteUrl', () => {
        it('Then reconstructs the scp form', () => {
          // Arrange
          const parsed: RemoteUrl = {
            kind: 'ssh',
            user: 'git',
            host: 'example.com',
            path: 'path/to/repo.git',
          };

          // Act
          const result = formatRemoteUrl(parsed);

          // Assert
          expect(result).toBe('git@example.com:path/to/repo.git');
        });
      });
    });
  });

  describe('Given an ssh URL with a bracketed IPv6 host', () => {
    describe('When parsing ssh://[::1]/repo.git', () => {
      it('Then the host is the bare IPv6 address, as ssh expects it', () => {
        // Arrange
        const sut = parseRemoteUrl;

        // Act
        const result = sut('ssh://[::1]/repo.git');

        // Assert
        expect(result).toEqual({ kind: 'ssh', host: '::1', path: '/repo.git' });
      });
    });

    describe('When parsing ssh://git@[2001:db8::1]:2222/repo.git', () => {
      it('Then user, bare host, and port are all extracted', () => {
        // Arrange
        const sut = parseRemoteUrl;

        // Act
        const result = sut('ssh://git@[2001:db8::1]:2222/repo.git');

        // Assert
        expect(result).toEqual({
          kind: 'ssh',
          user: 'git',
          host: '2001:db8::1',
          port: 2222,
          path: '/repo.git',
        });
      });
    });

    describe('When formatting a port-less IPv6 RemoteUrl', () => {
      it('Then it re-brackets the host in the ssh URL form (scp form cannot carry a colon host)', () => {
        // Arrange
        const parsed: RemoteUrl = { kind: 'ssh', host: '::1', path: '/repo.git' };

        // Act
        const result = formatRemoteUrl(parsed);

        // Assert
        expect(result).toBe('ssh://[::1]/repo.git');
      });
    });

    describe('When round-tripping an IPv6 URL with user and port', () => {
      it('Then parse(format(parse(x))) is identical to parse(x)', () => {
        // Arrange
        const sut = parseRemoteUrl;
        const first = sut('ssh://git@[2001:db8::1]:2222/repo.git');

        // Act
        const result = sut(formatRemoteUrl(first));

        // Assert
        expect(result).toEqual(first);
      });
    });
  });

  describe('Given anonymizeRemoteUrl for a reflog message', () => {
    describe('When the https URL carries user and password', () => {
      it('Then the userinfo is stripped, keeping the scheme and host', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('https://user:secret@example.com/x.git');

        // Assert
        expect(result).toBe('https://example.com/x.git');
      });
    });

    describe('When the ssh URL carries a user', () => {
      it('Then the user is stripped from the authority', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('ssh://git@example.com:2222/x.git');

        // Assert
        expect(result).toBe('ssh://example.com:2222/x.git');
      });
    });

    describe('When the remote is scp-like with a user', () => {
      it('Then the user@ prefix is stripped, leaving host:path', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('git@example.com:path/to/repo.git');

        // Assert
        expect(result).toBe('example.com:path/to/repo.git');
      });
    });

    describe('When the URL has no userinfo', () => {
      it('Then it is returned unchanged', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('https://example.com/x.git');

        // Assert
        expect(result).toBe('https://example.com/x.git');
      });
    });

    describe('When the @ sits in the path, not the authority', () => {
      it('Then the URL is left untouched (git keeps a path @ literal)', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('https://example.com/a@b.git');

        // Assert
        expect(result).toBe('https://example.com/a@b.git');
      });
    });

    describe('When a scp-like remote has an @ only in the path', () => {
      it('Then the URL is left untouched (no colon after the @, so it is path data)', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('example.com:pa/th@x.git');

        // Assert
        expect(result).toBe('example.com:pa/th@x.git');
      });
    });

    describe('When a scp-like path carries an @ before its first slash', () => {
      it('Then the URL is left untouched, matching real git byte-for-byte', () => {
        // Arrange — pinned against real git: `clone localhost:foo@bar/baz.git`
        // records the URL literally (transport_anonymize_url literal-copy).
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('localhost:foo@bar/baz.git');

        // Assert
        expect(result).toBe('localhost:foo@bar/baz.git');
      });
    });

    describe('When a slash-free scp remote carries a user', () => {
      it('Then the user@ prefix is stripped (the colon after @ marks it as userinfo)', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('git@example.com:repo.git');

        // Assert
        expect(result).toBe('example.com:repo.git');
      });
    });

    describe('When the https userinfo is password-only', () => {
      it('Then the whole userinfo is stripped', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('https://:secret@example.com/x.git');

        // Assert
        expect(result).toBe('https://example.com/x.git');
      });
    });

    describe('When an ssh URL has a user and an IPv6 host', () => {
      it('Then only the user is stripped, brackets and port kept', () => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut('ssh://user@[::1]:22/x.git');

        // Assert
        expect(result).toBe('ssh://[::1]:22/x.git');
      });
    });
  });
});
