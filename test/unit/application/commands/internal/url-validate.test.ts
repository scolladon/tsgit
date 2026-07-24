import { describe, expect, it } from 'vitest';
import {
  type UrlValidateOptions,
  validateUrl,
} from '../../../../../src/application/commands/internal/url-validate.js';
import { TsgitError } from '../../../../../src/domain/index.js';

const fixedResolver =
  (...addrs: ReadonlyArray<string>) =>
  async (): Promise<ReadonlyArray<string>> =>
    addrs;

const opts = (overrides: Partial<UrlValidateOptions> = {}): UrlValidateOptions => ({
  resolver: fixedResolver('8.8.8.8'),
  ...overrides,
});

const expectError = async (
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(expectedCode);
  return caught as TsgitError;
};

describe('internal/url-validate', () => {
  describe('scheme allowlist', () => {
    describe('Given https URL', () => {
      describe('When validateUrl', () => {
        it('Then returns ValidatedUrl', async () => {
          // Arrange
          const sut = await validateUrl('https://example.com/x', opts());

          // Assert
          expect(sut.url).toBe('https://example.com/x');
          expect(sut.pinnedAddress).toBe('8.8.8.8');
        });
      });
    });

    describe('Given a URL with an outright-unsupported scheme', () => {
      describe('When validateUrl', () => {
        it.each([
          { url: 'http://example.com/x', label: 'http, with allowInsecure=false (default)' },
          { url: 'ftp://example.com/x', label: 'ftp' },
          { url: 'file:///etc/passwd', label: 'file' },
          { url: 'data:text/plain,hi', label: 'data' },
          { url: 'javascript:alert(1)', label: 'javascript' },
        ])('Then $label throws UNSUPPORTED_SCHEME', async ({ url }) => {
          // Arrange + Assert
          await expectError(validateUrl(url, opts()), 'UNSUPPORTED_SCHEME');
        });
      });
    });

    describe('Given http URL with allowInsecure NOT set', () => {
      describe('When validateUrl', () => {
        it('Then throws UNSUPPORTED_SCHEME with scheme=http', async () => {
          // Arrange / Act — `allowInsecure` defaults to false, so `http:` must be
          // rejected. The scheme-gate `proto === 'http:' && allowInsecure` must
          // hold: a mutant forcing it true would let `http:` pass.
          const err = await expectError(
            validateUrl('http://example.com/x', opts()),
            'UNSUPPORTED_SCHEME',
          );

          // Assert — the rejected scheme is reported as the bare value `http`.
          const data = err.data as { readonly code: string; readonly scheme?: string };
          expect(data.scheme).toBe('http');
        });
      });
    });

    describe('Given http URL with allowInsecure=true', () => {
      describe('When validateUrl', () => {
        it('Then returns ValidatedUrl', async () => {
          // Arrange
          const sut = await validateUrl('http://example.com/x', opts({ allowInsecure: true }));

          // Assert
          expect(sut.url).toBe('http://example.com/x');
        });
      });
    });

    describe('Given ftp URL with allowInsecure=true', () => {
      describe('When validateUrl', () => {
        it('Then still throws UNSUPPORTED_SCHEME', async () => {
          // Arrange / Act / Assert — `allowInsecure` widens the allowlist to
          // `http:` ONLY. The scheme gate is `proto === 'http:' && allowInsecure`:
          // the `proto === 'http:'` operand must hold independently. A mutant
          // dropping that operand (`proto === 'http:'` -> true) collapses the gate
          // to `allowInsecure` alone, which would wrongly accept `ftp:` (any
          // non-http scheme) whenever `allowInsecure` is set.
          const err = await expectError(
            validateUrl('ftp://example.com/x', opts({ allowInsecure: true })),
            'UNSUPPORTED_SCHEME',
          );
          const data = err.data as { readonly code: string; readonly scheme?: string };
          expect(data.scheme).toBe('ftp');
        });
      });
    });
  });

  describe('URL parse', () => {
    describe('Given not-a-url', () => {
      describe('When validateUrl', () => {
        it('Then throws INVALID_URL', async () => {
          // Arrange + Assert
          await expectError(validateUrl('not-a-url', opts()), 'INVALID_URL');
        });
      });
    });

    describe('Given URL with fragment', () => {
      describe('When validateUrl', () => {
        it('Then throws INVALID_URL with reason mentioning fragment', async () => {
          // Arrange
          const err = await expectError(
            validateUrl('https://example.com/#frag', opts()),
            'INVALID_URL',
          );
          const data = err.data;

          // Assert
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('fragment');
          }
        });
      });
    });
  });

  describe('IPv4 block ranges', () => {
    const blocked: ReadonlyArray<{ readonly addr: string; readonly label: string }> = [
      { addr: '127.0.0.1', label: 'loopback' },
      { addr: '10.0.0.5', label: 'RFC1918 10/8' },
      { addr: '172.16.0.1', label: 'RFC1918 172.16/12 lower boundary' },
      { addr: '172.31.255.255', label: 'RFC1918 172.16/12 upper boundary' },
      { addr: '192.168.1.1', label: 'RFC1918 192.168/16' },
      { addr: '169.254.169.254', label: 'AWS metadata' },
      { addr: '100.64.0.1', label: 'CGNAT lower boundary' },
      { addr: '100.127.255.255', label: 'CGNAT upper boundary' },
      { addr: '0.0.0.0', label: 'unspecified' },
      { addr: '224.0.0.1', label: 'multicast lower boundary' },
      { addr: '239.255.255.255', label: 'multicast upper boundary' },
      { addr: '240.0.0.1', label: 'reserved boundary' },
    ];
    describe('Given DNS resolves to a blocked IPv4 address', () => {
      describe('When validateUrl', () => {
        for (const { addr, label } of blocked) {
          it(`Then ${addr} (${label}) throws BLOCKED_HOST`, async () => {
            // Arrange + Assert
            await expectError(
              validateUrl('https://example.com/x', opts({ resolver: fixedResolver(addr) })),
              'BLOCKED_HOST',
            );
          });
        }
      });
    });

    // Anti-boundary cases — addresses just OUTSIDE blocked ranges must succeed.
    // Kills boundary mutants like `b >= 64` vs `b > 64`.
    const allowed: ReadonlyArray<{ readonly addr: string; readonly label: string }> = [
      { addr: '100.63.255.255', label: 'just below CGNAT' },
      { addr: '100.128.0.0', label: 'just above CGNAT' },
      { addr: '172.15.255.255', label: 'just below 172.16/12' },
      { addr: '172.32.0.0', label: 'just above 172.16/12' },
      { addr: '169.253.0.0', label: 'just below link-local' },
      { addr: '169.255.0.0', label: 'just above link-local' },
      { addr: '223.255.255.255', label: 'just below multicast' },
    ];
    describe('Given DNS resolves to an anti-boundary IPv4 address', () => {
      describe('When validateUrl', () => {
        for (const { addr, label } of allowed) {
          it(`Then ${addr} (${label}) succeeds`, async () => {
            // Arrange
            const sut = await validateUrl(
              'https://example.com/x',
              opts({ resolver: fixedResolver(addr) }),
            );
            // Assert
            expect(sut.pinnedAddress).toBe(addr);
          });
        }
      });
    });
  });

  describe('IPv6 block ranges', () => {
    const blocked: ReadonlyArray<{ readonly addr: string; readonly label: string }> = [
      { addr: '::1', label: 'loopback' },
      { addr: 'fc00::1', label: 'ULA' },
      { addr: 'fe80::1', label: 'link-local' },
      { addr: 'ff00::1', label: 'multicast' },
      { addr: '::ffff:127.0.0.1', label: 'IPv4-mapped loopback' },
      { addr: '::ffff:169.254.169.254', label: 'IPv4-mapped metadata' },
    ];
    describe('Given DNS resolves to a blocked IPv6 address', () => {
      describe('When validateUrl', () => {
        for (const { addr, label } of blocked) {
          it(`Then ${addr} (${label}) throws BLOCKED_HOST`, async () => {
            // Arrange + Assert
            await expectError(
              validateUrl('https://example.com/x', opts({ resolver: fixedResolver(addr) })),
              'BLOCKED_HOST',
            );
          });
        }
      });
    });
  });

  describe('Allow override', () => {
    describe('Given allowPrivateNetworks=true and DNS resolves to 192.168.1.1', () => {
      describe('When validateUrl', () => {
        it('Then returns ValidatedUrl', async () => {
          // Arrange
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('192.168.1.1'), allowPrivateNetworks: true }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('192.168.1.1');
        });
      });
    });
  });

  describe('DNS pinning', () => {
    describe('Given DNS resolves to a public IP', () => {
      describe('When validateUrl', () => {
        it('Then ValidatedUrl.pinnedAddress equals that IP', async () => {
          // Arrange
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('203.0.113.5') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('203.0.113.5');
        });
      });
    });

    describe('Given DNS returns multiple addresses', () => {
      describe('When validateUrl', () => {
        it('Then pinnedAddress is the first non-blocked one', async () => {
          // Arrange — first is blocked, second is public; selected one must be public.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({
              resolver: fixedResolver('192.168.1.1', '8.8.8.8'),
              allowPrivateNetworks: false,
            }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('8.8.8.8');
        });
      });
    });

    describe('Given DNS returns only blocked addresses', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl(
              'https://example.com/x',
              opts({ resolver: fixedResolver('10.0.0.1', '127.0.0.1') }),
            ),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given DNS returns no addresses', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver() })),
            'BLOCKED_HOST',
          );
        });
      });
    });
  });

  describe('Public passthrough', () => {
    describe('Given DNS resolves to 8.8.8.8', () => {
      describe('When validateUrl', () => {
        it('Then returns ValidatedUrl with pinnedAddress=8.8.8.8', async () => {
          // Arrange
          const sut = await validateUrl(
            'https://example.com/',
            opts({ resolver: fixedResolver('8.8.8.8') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('8.8.8.8');
        });
      });
    });
  });

  describe('IPv6 hex IPv4-mapped (anti-bypass)', () => {
    describe('Given DNS resolves to ::ffff:7f00:1 (hex form of 127.0.0.1)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl(
              'https://example.com/x',
              opts({ resolver: fixedResolver('::ffff:7f00:1') }),
            ),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given DNS resolves to ::ffff:a00:1 (hex form of 10.0.0.1)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::ffff:a00:1') })),
            'BLOCKED_HOST',
          );
        });
      });
    });
  });

  // secretlint-disable @secretlint/secretlint-rule-basicauth
  describe('Embedded credentials (user:pass@host)', () => {
    describe('Given a URL with embedded credentials and a public host', () => {
      describe('When validateUrl', () => {
        it('Then resolves the host portion (not the userinfo)', async () => {
          // Arrange — the SSRF guard must run against the URL.hostname, not user/pass.
          const sut = await validateUrl(
            'https://user:secret@example.com/r.git',
            opts({ resolver: fixedResolver('203.0.113.5') }),
          );

          // Assert — pinned address comes from the host, not anywhere in userinfo.
          expect(sut.pinnedAddress).toBe('203.0.113.5');
        });
      });
    });

    describe('Given a URL with embedded credentials and a private host', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST (userinfo cannot bypass)', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl(
              'https://user:secret@internal.lan/r.git',
              opts({ resolver: fixedResolver('192.168.1.1') }),
            ),
            'BLOCKED_HOST',
          );
        });
      });
    });
  });

  describe('Error data assertions (kill StringLiteral mutants on factory args)', () => {
    describe('Given a CRLF-injection URL', () => {
      describe('When validateUrl', () => {
        it('Then INVALID_URL.data.reason mentions a control character', async () => {
          // Arrange + Assert
          const err = await expectError(
            validateUrl('https://example.com\r\n', opts()),
            'INVALID_URL',
          );
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('control');
          }
        });
      });
    });

    describe('Given an unsupported scheme', () => {
      describe('When validateUrl', () => {
        it('Then UNSUPPORTED_SCHEME.data.scheme is the actual scheme (no trailing colon)', async () => {
          // Arrange + Assert
          const err = await expectError(
            validateUrl('ftp://example.com/x', opts()),
            'UNSUPPORTED_SCHEME',
          );
          const data = err.data;
          if (data.code === 'UNSUPPORTED_SCHEME') {
            expect(data.scheme).toBe('ftp');
          }
        });
      });
    });

    describe('Given DNS returns 0 addresses', () => {
      describe('When validateUrl', () => {
        it('Then BLOCKED_HOST data carries a non-empty reason', async () => {
          // Arrange + Assert
          const err = await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver() })),
            'BLOCKED_HOST',
          );
          const data = err.data;
          if (data.code === 'BLOCKED_HOST') {
            expect(data.reason).not.toBe('');
          }
        });
      });
    });
  });

  describe('IPv6 boundaries (kill startsWith / endsWith / prefix mutants)', () => {
    describe('Given fe80::1', () => {
      describe('When validateUrl', () => {
        it('Then BLOCKED (startsWith fe80::)', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fe80::1') })),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given fe80:: alone', () => {
      describe('When validateUrl', () => {
        it('Then BLOCKED', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fe80::') })),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given fd00::1 (different ULA prefix)', () => {
      describe('When validateUrl', () => {
        it('Then BLOCKED (fc00::/7 covers fd00 too)', async () => {
          // Arrange + Assert
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fd00::1') })),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given 2001:db8::1 (documentation prefix, not blocked)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('2001:db8::1') }),
          );
          // Assert
          expect(sut.pinnedAddress).toBe('2001:db8::1');
        });
      });
    });
  });

  describe('Sanitization', () => {
    describe('Given URL with CRLF in raw input', () => {
      describe('When validateUrl', () => {
        it('Then throws INVALID_URL with sanitized reason (no raw CRLF in message)', async () => {
          // Arrange
          const err = await expectError(
            validateUrl('https://example.com\r\nHost: evil.com/path', opts()),
            'INVALID_URL',
          );
          const data = err.data;

          // Assert
          if (data.code === 'INVALID_URL') {
            expect(data.reason).not.toContain('\r');
            expect(data.reason).not.toContain('\n');
          }
        });
      });
    });
  });

  describe('Control-char rejection (kill ConditionalExpression operands at L41)', () => {
    describe('Given a URL containing a lone LF (0x0a)', () => {
      describe('When validateUrl', () => {
        it('Then throws INVALID_URL', async () => {
          // Arrange + Act + Assert — only the LF branch of `code === 0x0a || code === 0x0d`.
          const err = await expectError(
            validateUrl('https://example.com\nx', opts()),
            'INVALID_URL',
          );
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('control');
          }
        });
      });
    });

    describe('Given a URL containing a lone CR (0x0d)', () => {
      describe('When validateUrl', () => {
        it('Then throws INVALID_URL', async () => {
          // Arrange + Act + Assert — only the CR branch of `code === 0x0a || code === 0x0d`.
          const err = await expectError(
            validateUrl('https://example.com\rx', opts()),
            'INVALID_URL',
          );
          const data = err.data;
          if (data.code === 'INVALID_URL') {
            expect(data.reason.toLowerCase()).toContain('control');
          }
        });
      });
    });
  });

  describe('Parse-failure reason (kill StringLiteral at L51)', () => {
    describe('Given a non-URL string', () => {
      describe('When validateUrl', () => {
        it('Then INVALID_URL.data.reason is a non-empty message', async () => {
          // Arrange
          const err = await expectError(validateUrl('not-a-url', opts()), 'INVALID_URL');
          const data = err.data;

          // Assert — empty-string mutant would make this fail.
          if (data.code === 'INVALID_URL') {
            expect(data.reason).not.toBe('');
            expect(data.reason.toLowerCase()).toContain('valid');
          }
        });
      });
    });
  });

  describe('BLOCKED_HOST payload (kill ConditionalExpression L73 and StringLiterals L73/L74)', () => {
    describe('Given DNS returns only blocked addresses', () => {
      describe('When validateUrl', () => {
        it('Then BLOCKED_HOST.data.host is the first resolved address (not <unresolved>)', async () => {
          // Arrange — non-empty address list: the `addresses.length === 0` branch must be false.
          const err = await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('10.0.0.1') })),
            'BLOCKED_HOST',
          );
          const data = err.data;

          // Assert
          if (data.code === 'BLOCKED_HOST') {
            expect(data.host).toBe('10.0.0.1');
            expect(data.reason).not.toBe('');
            expect(data.reason.toLowerCase()).toContain('blocked range');
          }
        });
      });
    });

    describe('Given DNS returns zero addresses', () => {
      describe('When validateUrl', () => {
        it('Then BLOCKED_HOST.data.reason mentions no DNS records', async () => {
          // Arrange
          const err = await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver() })),
            'BLOCKED_HOST',
          );
          const data = err.data;

          // Assert
          if (data.code === 'BLOCKED_HOST') {
            expect(data.host).toBe('<unresolved>');
            expect(data.reason).not.toBe('');
            expect(data.reason.toLowerCase()).toContain('no dns records');
          }
        });
      });
    });
  });

  describe('IPv4 parse guards (kill L84 / L87 / L89)', () => {
    describe('Given DNS resolves to a 5-part dotted string with a private prefix', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (not 4 octets => not an IPv4)', async () => {
          // Arrange — `parts.length !== 4` must bail; otherwise `10.0.0.0.0` is read as 10/8.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('10.0.0.0.0') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('10.0.0.0.0');
        });
      });
    });

    describe('Given DNS resolves to a 4-part string with a non-digit octet on a private prefix', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (regex rejects => not an IPv4)', async () => {
          // Arrange — `/^\d{1,3}$/` must reject `0x` so `10.0.0.0x` is not read as 10/8.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('10.0.0.0x') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('10.0.0.0x');
        });
      });
    });

    describe('Given DNS resolves to a 4-part string with a 4-digit octet on a private prefix', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (regex {1,3} rejects => not an IPv4)', async () => {
          // Arrange — `/^\d{1,3}$/` must reject `0000`.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('10.0.0.0000') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('10.0.0.0000');
        });
      });
    });

    describe('Given DNS resolves to 10.0.0.255 (octet exactly 255)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST (upper octet bound inclusive)', async () => {
          // Arrange + Act + Assert — `n > 255` must be false at 255 so the 10/8 verdict still stands.
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('10.0.0.255') })),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given DNS resolves to 10.0.0.256 (octet just over 255)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (octet out of range => not an IPv4)', async () => {
          // Arrange — `n > 255` must be true at 256 so `10.0.0.256` is not read as 10/8.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('10.0.0.256') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('10.0.0.256');
        });
      });
    });
  });

  describe('IPv4 hex-mapped with unparseable octet (kill L97 ConditionalExpression / NoCoverage)', () => {
    describe('Given DNS resolves to ::ffff:999.0.0.1 (IPv4-mapped with an out-of-range octet)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (octets undefined => not blocked)', async () => {
          // Arrange — exercises `isBlockedIpv4` with an addr that `parseIpv4` rejects.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('::ffff:999.0.0.1') }),
          );

          // Assert — `octets === undefined` must return false (not block).
          expect(sut.pinnedAddress).toBe('::ffff:999.0.0.1');
        });
      });
    });
  });

  describe('IPv4 192.168/16 operands (kill LogicalOperator L105)', () => {
    describe('Given DNS resolves to 192.1.1.1 (a===192, b!==168)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — flips the `b === 168` operand; `&&` must keep this unblocked.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('192.1.1.1') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('192.1.1.1');
        });
      });
    });

    describe('Given DNS resolves to 8.168.1.1 (a!==192, b===168)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — flips the `a === 192` operand; `&&` must keep this unblocked.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('8.168.1.1') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('8.168.1.1');
        });
      });
    });
  });

  describe('IPv6 ::ffff:0: form (kill Regex L114 trailing anchor)', () => {
    describe('Given DNS resolves to ::ffff:0:10.0.0.1 (IPv4-mapped via 0: form)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Act + Assert — the optional `(?:0:)?` group plus the embedded private IPv4.
          await expectError(
            validateUrl(
              'https://example.com/x',
              opts({ resolver: fixedResolver('::ffff:0:10.0.0.1') }),
            ),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given DNS resolves to ::ffff:10.0.0.1.9 (private IPv4 with trailing junk)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (trailing $ anchor must reject the junk)', async () => {
          // Arrange — without the `$` anchor the mutant matches `10.0.0.1` and wrongly blocks it.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('::ffff:10.0.0.1.9') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('::ffff:10.0.0.1.9');
        });
      });
    });
  });

  describe('IPv4 block-range LHS operands (kill ConditionalExpression a-octet checks)', () => {
    describe('Given DNS resolves to 8.64.0.1 (a!==100 but b in CGNAT 64..127)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — forcing `a === 100` to `true` would block this; the `a` operand must hold.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('8.64.0.1') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('8.64.0.1');
        });
      });
    });

    describe('Given DNS resolves to 8.254.0.1 (a!==169 but b===254)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — forcing `a === 169` to `true` would block this; the `a` operand must hold.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('8.254.0.1') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('8.254.0.1');
        });
      });
    });

    describe('Given DNS resolves to 8.16.0.1 (a!==172 but b in 16..31)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — forcing `a === 172` to `true` would block this; the `a` operand must hold.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('8.16.0.1') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('8.16.0.1');
        });
      });
    });
  });

  describe('IPv6 hex-mapped multi-digit low group (kill Regex L120 second {1,4})', () => {
    describe('Given DNS resolves to ::ffff:7f00:aa (hex form of 127.0.0.170, 2-digit low group)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Act + Assert — the low group `aa` has 2 hex digits; shrinking `{1,4}` to `{1}`
          // would make the regex miss it, letting the loopback address bypass the guard.
          await expectError(
            validateUrl(
              'https://example.com/x',
              opts({ resolver: fixedResolver('::ffff:7f00:aa') }),
            ),
            'BLOCKED_HOST',
          );
        });
      });
    });
  });

  describe('IPv6 hex-mapped regex anchors (kill Regex L119)', () => {
    describe('Given DNS resolves to g::ffff:7f00:1 (junk prefix)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (leading ^ anchor must reject the prefix)', async () => {
          // Arrange — without `^` the mutant matches the embedded `::ffff:7f00:1` (127.0.0.1).
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('g::ffff:7f00:1') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('g::ffff:7f00:1');
        });
      });
    });

    describe('Given DNS resolves to ::ffff:7f00:1g (junk suffix)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds (trailing $ anchor must reject the suffix)', async () => {
          // Arrange — without `$` the mutant matches the leading `::ffff:7f00:1` (127.0.0.1).
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('::ffff:7f00:1g') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('::ffff:7f00:1g');
        });
      });
    });
  });

  describe('IPv6 :: literals (kill ConditionalExpression / StringLiteral L126)', () => {
    describe('Given DNS resolves to :: (all-zeros)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Act + Assert — the `lower === '::'` operand only.
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::') })),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given DNS resolves to ::1 (loopback)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Act + Assert — the `lower === '::1'` operand only.
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::1') })),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given DNS resolves to ::2 (not a blocked literal)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — neither `::1` nor `::` literal matches; the StringLiteral mutants would mis-block.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('::2') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('::2');
        });
      });
    });
  });

  describe('IPv6 fe80 prefix (kill LogicalOperator / MethodExpression L127)', () => {
    describe('Given DNS resolves to fe80:abcd::1 (fe80: prefix, not fe80::)', () => {
      describe('When validateUrl', () => {
        it('Then throws BLOCKED_HOST', async () => {
          // Arrange + Act + Assert — only the `startsWith('fe80:')` operand matches here.
          await expectError(
            validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fe80:abcd::1') })),
            'BLOCKED_HOST',
          );
        });
      });
    });

    describe('Given DNS resolves to abcd::fe80: (ends with fe80: but does not start with it)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — kills `startsWith` -> `endsWith` mutants; endsWith would mis-block this.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('abcd::fe80:') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('abcd::fe80:');
        });
      });
    });

    describe('Given DNS resolves to abcd:fe80:: (ends with fe80:: but does not start with it)', () => {
      describe('When validateUrl', () => {
        it('Then succeeds', async () => {
          // Arrange — kills the `startsWith('fe80::')` -> `endsWith('fe80::')` mutant.
          const sut = await validateUrl(
            'https://example.com/x',
            opts({ resolver: fixedResolver('abcd:fe80::') }),
          );

          // Assert
          expect(sut.pinnedAddress).toBe('abcd:fe80::');
        });
      });
    });
  });
});
