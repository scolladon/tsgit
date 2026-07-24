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
    describe('Given an http(s) URL', () => {
      describe('When parseRemoteUrl', () => {
        it.each([
          { raw: 'https://example.com/repo.git', label: 'an https URL' },
          { raw: 'http://example.com/repo.git', label: 'an http URL' },
        ])('Then $label returns kind http carrying the raw url verbatim', ({ raw }) => {
          // Arrange + Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual({ kind: 'http', url: raw });
        });
      });
    });
  });

  describe('ssh:// host/port/path extraction (design matrix B)', () => {
    describe('Given an ssh:// URL', () => {
      describe('When parseRemoteUrl', () => {
        it.each([
          {
            raw: 'ssh://git@example.com/path/to/repo.git',
            expected: { kind: 'ssh', user: 'git', host: 'example.com', path: '/path/to/repo.git' },
            label: 'extracts user, host, and path with no port',
          },
          {
            raw: 'ssh://git@example.com:2222/path/to/repo.git',
            expected: {
              kind: 'ssh',
              user: 'git',
              host: 'example.com',
              port: 2222,
              path: '/path/to/repo.git',
            },
            label: 'extracts the explicit non-default port',
          },
          {
            raw: 'ssh://git@example.com:22/repo.git',
            expected: {
              kind: 'ssh',
              user: 'git',
              host: 'example.com',
              port: 22,
              path: '/repo.git',
            },
            label: 'keeps the explicit default port 22 rather than dropping it',
          },
          {
            raw: 'ssh://example.com/repo.git',
            expected: { kind: 'ssh', host: 'example.com', path: '/repo.git' },
            label: 'omits the user field (no user in the URL)',
          },
          {
            raw: 'ssh://git@example.com/~/repo.git',
            expected: { kind: 'ssh', user: 'git', host: 'example.com', path: '~/repo.git' },
            label: 'collapses the leading slash before a home-relative tilde',
          },
          {
            raw: 'ssh://git@example.com/~user/repo.git',
            expected: { kind: 'ssh', user: 'git', host: 'example.com', path: '~user/repo.git' },
            label: 'collapses the leading slash before a named-user tilde',
          },
        ])('Then $label', ({ raw, expected }) => {
          // Arrange + Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual(expected);
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
    describe('Given an scp-like URL', () => {
      describe('When parseRemoteUrl', () => {
        it.each([
          {
            raw: 'git@example.com:path/to/repo.git',
            expected: { kind: 'ssh', user: 'git', host: 'example.com', path: 'path/to/repo.git' },
            label: 'a relative path keeps it relative with no leading slash',
          },
          {
            raw: 'git@example.com:/abs/path/repo.git',
            expected: {
              kind: 'ssh',
              user: 'git',
              host: 'example.com',
              path: '/abs/path/repo.git',
            },
            label: 'an absolute path keeps the leading slash verbatim',
          },
          {
            raw: 'git@example.com:~user/repo.git',
            expected: { kind: 'ssh', user: 'git', host: 'example.com', path: '~user/repo.git' },
            label: 'a tilde-user path keeps the tilde verbatim (scp form never collapses)',
          },
          {
            raw: 'example.com:repo.git',
            expected: { kind: 'ssh', host: 'example.com', path: 'repo.git' },
            label: 'no user omits the user field',
          },
        ])('Then $label', ({ raw, expected }) => {
          // Arrange + Act
          const result = parseRemoteUrl(raw);

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });
  });

  describe('scp-vs-ssh disambiguation', () => {
    describe('Given a URL misreadable as scp-like', () => {
      describe('When parseRemoteUrl', () => {
        it.each([
          {
            raw: 'ftp://example.com/repo.git',
            label: 'an unrecognised scheme with a colon before its first slash (ftp://)',
          },
          {
            raw: 'path/to:something',
            label: 'a string whose first slash appears before its first colon',
          },
        ])('Then $label throws INVALID_URL rather than misreading it as scp-like', ({ raw }) => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl(raw);
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
  });

  describe('Dash-guard (SSH argument-injection refusal, design matrix E)', () => {
    describe('Given a URL rejected by the dash-guard', () => {
      describe('When parseRemoteUrl', () => {
        it.each([
          {
            raw: 'ssh://-oProxyCommand=evil/repo.git',
            reasonContains: "strange hostname '-oProxyCommand=evil' blocked",
            label:
              'a host-dash in ssh form (ssh://-oProxyCommand=evil/repo.git) names the sanitized hostname',
          },
          {
            raw: 'git@example.com:-leadingdash/repo.git',
            reasonContains: "strange pathname '-leadingdash/repo.git' blocked",
            label:
              'a path-dash in scp form (git@example.com:-leadingdash/repo.git) names the sanitized pathname',
          },
          {
            raw: '-evil.example.com:repo.git',
            reasonContains: "strange hostname '-evil.example.com' blocked",
            label:
              'a host-dash in scp form with no user (-evil.example.com:repo.git) names the sanitized hostname',
          },
        ])('Then $label', ({ raw, reasonContains }) => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl(raw);
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason).toContain(reasonContains);
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
    describe('Given a URL containing a control character', () => {
      describe('When parseRemoteUrl', () => {
        it.each([
          { raw: 'ssh://example.com/repo.git\n', label: 'a lone LF (0x0a)' },
          { raw: 'ssh://example.com/repo.git\r', label: 'a lone CR (0x0d)' },
          { raw: 'ssh://example.com/repo.git\0', label: 'a NUL byte (0x00)' },
        ])('Then $label throws INVALID_URL naming a control character', ({ raw }) => {
          // Arrange + Act + Assert
          const err = expectInvalidUrl(raw);
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('control');
          }
        });
      });
    });
  });

  describe('formatRemoteUrl (inverse used by the round-trip property)', () => {
    describe('Given a RemoteUrl', () => {
      describe('When formatRemoteUrl', () => {
        it.each([
          {
            parsed: { kind: 'http', url: 'https://example.com/repo.git' } as RemoteUrl,
            expected: 'https://example.com/repo.git',
            label: 'an http RemoteUrl returns the stored url verbatim',
          },
          {
            parsed: {
              kind: 'ssh',
              user: 'git',
              host: 'example.com',
              port: 2222,
              path: '/repo.git',
            } as RemoteUrl,
            expected: 'ssh://git@example.com:2222/repo.git',
            label: 'an ssh RemoteUrl with a port reconstructs the canonical ssh:// form',
          },
          {
            parsed: {
              kind: 'ssh',
              host: 'example.com',
              port: 22,
              path: '~/repo.git',
            } as RemoteUrl,
            expected: 'ssh://example.com:22/~/repo.git',
            label:
              'an ssh RemoteUrl with a tilde path and a port re-adds the leading slash before the tilde',
          },
          {
            parsed: {
              kind: 'ssh',
              user: 'git',
              host: 'example.com',
              path: 'path/to/repo.git',
            } as RemoteUrl,
            expected: 'git@example.com:path/to/repo.git',
            label: 'an ssh RemoteUrl without a port reconstructs the scp form',
          },
        ])('Then $label', ({ parsed, expected }) => {
          // Arrange + Act
          const result = formatRemoteUrl(parsed);

          // Assert
          expect(result).toBe(expected);
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

  // secretlint-disable @secretlint/secretlint-rule-basicauth
  describe('Given anonymizeRemoteUrl for a reflog message', () => {
    describe('When anonymizeRemoteUrl runs', () => {
      it.each([
        {
          raw: 'https://user:secret@example.com/x.git',
          expected: 'https://example.com/x.git',
          label:
            'an https URL carrying user and password has the userinfo stripped, keeping the scheme and host',
        },
        {
          raw: 'ssh://git@example.com:2222/x.git',
          expected: 'ssh://example.com:2222/x.git',
          label: 'an ssh URL carrying a user has the user stripped from the authority',
        },
        {
          raw: 'git@example.com:path/to/repo.git',
          expected: 'example.com:path/to/repo.git',
          label: 'a scp-like remote with a user has the user@ prefix stripped, leaving host:path',
        },
        {
          raw: 'https://example.com/x.git',
          expected: 'https://example.com/x.git',
          label: 'a URL with no userinfo is returned unchanged',
        },
        {
          raw: 'https://example.com/a@b.git',
          expected: 'https://example.com/a@b.git',
          label:
            'an @ that sits in the path, not the authority, is left untouched (git keeps a path @ literal)',
        },
        {
          raw: 'example.com:pa/th@x.git',
          expected: 'example.com:pa/th@x.git',
          label:
            'a scp-like remote with an @ only in the path is left untouched (no colon after the @, so it is path data)',
        },
        {
          raw: 'localhost:foo@bar/baz.git',
          expected: 'localhost:foo@bar/baz.git',
          // pinned against real git: `clone localhost:foo@bar/baz.git`
          // records the URL literally (transport_anonymize_url literal-copy).
          label:
            'a scp-like path carrying an @ before its first slash is left untouched, matching real git byte-for-byte',
        },
        {
          raw: 'git@example.com:repo.git',
          expected: 'example.com:repo.git',
          label:
            'a slash-free scp remote carrying a user has the user@ prefix stripped (the colon after @ marks it as userinfo)',
        },
        {
          raw: 'https://:secret@example.com/x.git',
          expected: 'https://example.com/x.git',
          label: 'an https userinfo that is password-only has the whole userinfo stripped',
        },
        {
          raw: 'ssh://user@[::1]:22/x.git',
          expected: 'ssh://[::1]:22/x.git',
          label:
            'an ssh URL with a user and an IPv6 host has only the user stripped, brackets and port kept',
        },
        {
          raw: 'example.com:@x.git',
          expected: 'example.com:@x.git',
          label:
            'a scp-like path starting with @ right after the colon is left untouched (nothing after the @ carries a colon)',
        },
        {
          raw: 'ssh://git@example.com',
          expected: 'ssh://example.com',
          label: 'a scheme URL carrying a user but no path slash still has the userinfo stripped',
        },
      ])('Then $label', ({ raw, expected }) => {
        // Arrange
        const sut = anonymizeRemoteUrl;

        // Act
        const result = sut(raw);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
