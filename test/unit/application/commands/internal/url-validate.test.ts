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
    it('Given https URL, When validateUrl, Then returns ValidatedUrl', async () => {
      // Act
      const sut = await validateUrl('https://example.com/x', opts());

      // Assert
      expect(sut.url).toBe('https://example.com/x');
      expect(sut.pinnedAddress).toBe('8.8.8.8');
    });

    it('Given http URL with allowInsecure=false (default), When validateUrl, Then throws UNSUPPORTED_SCHEME', async () => {
      await expectError(validateUrl('http://example.com/x', opts()), 'UNSUPPORTED_SCHEME');
    });

    it('Given http URL with allowInsecure=true, When validateUrl, Then returns ValidatedUrl', async () => {
      // Act
      const sut = await validateUrl('http://example.com/x', opts({ allowInsecure: true }));

      // Assert
      expect(sut.url).toBe('http://example.com/x');
    });

    it('Given ftp URL, When validateUrl, Then throws UNSUPPORTED_SCHEME', async () => {
      await expectError(validateUrl('ftp://example.com/x', opts()), 'UNSUPPORTED_SCHEME');
    });

    it('Given file URL, When validateUrl, Then throws UNSUPPORTED_SCHEME', async () => {
      await expectError(validateUrl('file:///etc/passwd', opts()), 'UNSUPPORTED_SCHEME');
    });

    it('Given data URL, When validateUrl, Then throws UNSUPPORTED_SCHEME', async () => {
      await expectError(validateUrl('data:text/plain,hi', opts()), 'UNSUPPORTED_SCHEME');
    });

    it('Given javascript URL, When validateUrl, Then throws UNSUPPORTED_SCHEME', async () => {
      await expectError(validateUrl('javascript:alert(1)', opts()), 'UNSUPPORTED_SCHEME');
    });
  });

  describe('URL parse', () => {
    it('Given not-a-url, When validateUrl, Then throws INVALID_URL', async () => {
      await expectError(validateUrl('not-a-url', opts()), 'INVALID_URL');
    });

    it('Given URL with fragment, When validateUrl, Then throws INVALID_URL with reason mentioning fragment', async () => {
      // Act
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
    for (const { addr, label } of blocked) {
      it(`Given DNS resolves to ${addr} (${label}), When validateUrl, Then throws BLOCKED_HOST`, async () => {
        await expectError(
          validateUrl('https://example.com/x', opts({ resolver: fixedResolver(addr) })),
          'BLOCKED_HOST',
        );
      });
    }

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
    for (const { addr, label } of allowed) {
      it(`Given DNS resolves to ${addr} (${label}), When validateUrl, Then succeeds (anti-boundary)`, async () => {
        const sut = await validateUrl(
          'https://example.com/x',
          opts({ resolver: fixedResolver(addr) }),
        );
        expect(sut.pinnedAddress).toBe(addr);
      });
    }
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
    for (const { addr, label } of blocked) {
      it(`Given DNS resolves to ${addr} (${label}), When validateUrl, Then throws BLOCKED_HOST`, async () => {
        await expectError(
          validateUrl('https://example.com/x', opts({ resolver: fixedResolver(addr) })),
          'BLOCKED_HOST',
        );
      });
    }
  });

  describe('Allow override', () => {
    it('Given allowPrivateNetworks=true and DNS resolves to 192.168.1.1, When validateUrl, Then returns ValidatedUrl', async () => {
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('192.168.1.1'), allowPrivateNetworks: true }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('192.168.1.1');
    });
  });

  describe('DNS pinning', () => {
    it('Given DNS resolves to a public IP, When validateUrl, Then ValidatedUrl.pinnedAddress equals that IP', async () => {
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('203.0.113.5') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('203.0.113.5');
    });

    it('Given DNS returns multiple addresses, When validateUrl, Then pinnedAddress is the first non-blocked one', async () => {
      // Arrange — first is blocked, second is public; selected one must be public.
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('192.168.1.1', '8.8.8.8'), allowPrivateNetworks: false }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('8.8.8.8');
    });

    it('Given DNS returns only blocked addresses, When validateUrl, Then throws BLOCKED_HOST', async () => {
      await expectError(
        validateUrl(
          'https://example.com/x',
          opts({ resolver: fixedResolver('10.0.0.1', '127.0.0.1') }),
        ),
        'BLOCKED_HOST',
      );
    });

    it('Given DNS returns no addresses, When validateUrl, Then throws BLOCKED_HOST', async () => {
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver() })),
        'BLOCKED_HOST',
      );
    });
  });

  describe('Public passthrough', () => {
    it('Given DNS resolves to 8.8.8.8, When validateUrl, Then returns ValidatedUrl with pinnedAddress=8.8.8.8', async () => {
      // Act
      const sut = await validateUrl(
        'https://example.com/',
        opts({ resolver: fixedResolver('8.8.8.8') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('8.8.8.8');
    });
  });

  describe('IPv6 hex IPv4-mapped (anti-bypass)', () => {
    it('Given DNS resolves to ::ffff:7f00:1 (hex form of 127.0.0.1), When validateUrl, Then throws BLOCKED_HOST', async () => {
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::ffff:7f00:1') })),
        'BLOCKED_HOST',
      );
    });

    it('Given DNS resolves to ::ffff:a00:1 (hex form of 10.0.0.1), When validateUrl, Then throws BLOCKED_HOST', async () => {
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::ffff:a00:1') })),
        'BLOCKED_HOST',
      );
    });
  });

  // secretlint-disable @secretlint/secretlint-rule-basicauth
  describe('Embedded credentials (user:pass@host)', () => {
    it('Given a URL with embedded credentials and a public host, When validateUrl, Then resolves the host portion (not the userinfo)', async () => {
      // Arrange — the SSRF guard must run against the URL.hostname, not user/pass.
      const sut = await validateUrl(
        'https://user:secret@example.com/r.git',
        opts({ resolver: fixedResolver('203.0.113.5') }),
      );

      // Assert — pinned address comes from the host, not anywhere in userinfo.
      expect(sut.pinnedAddress).toBe('203.0.113.5');
    });

    it('Given a URL with embedded credentials and a private host, When validateUrl, Then throws BLOCKED_HOST (userinfo cannot bypass)', async () => {
      await expectError(
        validateUrl(
          'https://user:secret@internal.lan/r.git',
          opts({ resolver: fixedResolver('192.168.1.1') }),
        ),
        'BLOCKED_HOST',
      );
    });
  });

  describe('Error data assertions (kill StringLiteral mutants on factory args)', () => {
    it('Given a CRLF-injection URL, When validateUrl, Then INVALID_URL.data.reason mentions a control character', async () => {
      const err = await expectError(validateUrl('https://example.com\r\n', opts()), 'INVALID_URL');
      const data = err.data;
      if (data.code === 'INVALID_URL') {
        expect(data.reason.toLowerCase()).toContain('control');
      }
    });

    it('Given an unsupported scheme, When validateUrl, Then UNSUPPORTED_SCHEME.data.scheme is the actual scheme (no trailing colon)', async () => {
      const err = await expectError(
        validateUrl('ftp://example.com/x', opts()),
        'UNSUPPORTED_SCHEME',
      );
      const data = err.data;
      if (data.code === 'UNSUPPORTED_SCHEME') {
        expect(data.scheme).toBe('ftp');
      }
    });

    it('Given DNS returns 0 addresses, When validateUrl, Then BLOCKED_HOST data carries a non-empty reason', async () => {
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

  describe('IPv6 boundaries (kill startsWith / endsWith / prefix mutants)', () => {
    it('Given fe80::1, When validateUrl, Then BLOCKED (startsWith fe80::)', async () => {
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fe80::1') })),
        'BLOCKED_HOST',
      );
    });

    it('Given fe80:: alone, When validateUrl, Then BLOCKED', async () => {
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fe80::') })),
        'BLOCKED_HOST',
      );
    });

    it('Given fd00::1 (different ULA prefix), When validateUrl, Then BLOCKED (fc00::/7 covers fd00 too)', async () => {
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fd00::1') })),
        'BLOCKED_HOST',
      );
    });

    it('Given 2001:db8::1 (documentation prefix, not blocked), When validateUrl, Then succeeds', async () => {
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('2001:db8::1') }),
      );
      expect(sut.pinnedAddress).toBe('2001:db8::1');
    });
  });

  describe('Sanitization', () => {
    it('Given URL with CRLF in raw input, When validateUrl, Then throws INVALID_URL with sanitized reason (no raw CRLF in message)', async () => {
      // Act
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

  describe('Control-char rejection (kill ConditionalExpression operands at L41)', () => {
    it('Given a URL containing a lone LF (0x0a), When validateUrl, Then throws INVALID_URL', async () => {
      // Arrange — only the LF branch of `code === 0x0a || code === 0x0d`.
      // Act + Assert
      const err = await expectError(validateUrl('https://example.com\nx', opts()), 'INVALID_URL');
      const data = err.data;
      if (data.code === 'INVALID_URL') {
        expect(data.reason.toLowerCase()).toContain('control');
      }
    });

    it('Given a URL containing a lone CR (0x0d), When validateUrl, Then throws INVALID_URL', async () => {
      // Arrange — only the CR branch of `code === 0x0a || code === 0x0d`.
      // Act + Assert
      const err = await expectError(validateUrl('https://example.com\rx', opts()), 'INVALID_URL');
      const data = err.data;
      if (data.code === 'INVALID_URL') {
        expect(data.reason.toLowerCase()).toContain('control');
      }
    });
  });

  describe('Parse-failure reason (kill StringLiteral at L51)', () => {
    it('Given a non-URL string, When validateUrl, Then INVALID_URL.data.reason is a non-empty message', async () => {
      // Act
      const err = await expectError(validateUrl('not-a-url', opts()), 'INVALID_URL');
      const data = err.data;

      // Assert — empty-string mutant would make this fail.
      if (data.code === 'INVALID_URL') {
        expect(data.reason).not.toBe('');
        expect(data.reason.toLowerCase()).toContain('valid');
      }
    });
  });

  describe('BLOCKED_HOST payload (kill ConditionalExpression L73 and StringLiterals L73/L74)', () => {
    it('Given DNS returns only blocked addresses, When validateUrl, Then BLOCKED_HOST.data.host is the first resolved address (not <unresolved>)', async () => {
      // Arrange — non-empty address list: the `addresses.length === 0` branch must be false.
      // Act
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

    it('Given DNS returns zero addresses, When validateUrl, Then BLOCKED_HOST.data.reason mentions no DNS records', async () => {
      // Act
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

  describe('IPv4 parse guards (kill L84 / L87 / L89)', () => {
    it('Given DNS resolves to a 5-part dotted string with a private prefix, When validateUrl, Then succeeds (not 4 octets => not an IPv4)', async () => {
      // Arrange — `parts.length !== 4` must bail; otherwise `10.0.0.0.0` is read as 10/8.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('10.0.0.0.0') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('10.0.0.0.0');
    });

    it('Given DNS resolves to a 4-part string with a non-digit octet on a private prefix, When validateUrl, Then succeeds (regex rejects => not an IPv4)', async () => {
      // Arrange — `/^\d{1,3}$/` must reject `0x` so `10.0.0.0x` is not read as 10/8.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('10.0.0.0x') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('10.0.0.0x');
    });

    it('Given DNS resolves to a 4-part string with a 4-digit octet on a private prefix, When validateUrl, Then succeeds (regex {1,3} rejects => not an IPv4)', async () => {
      // Arrange — `/^\d{1,3}$/` must reject `0000`.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('10.0.0.0000') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('10.0.0.0000');
    });

    it('Given DNS resolves to 10.0.0.255 (octet exactly 255), When validateUrl, Then throws BLOCKED_HOST (upper octet bound inclusive)', async () => {
      // Arrange — `n > 255` must be false at 255 so the 10/8 verdict still stands.
      // Act + Assert
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('10.0.0.255') })),
        'BLOCKED_HOST',
      );
    });

    it('Given DNS resolves to 10.0.0.256 (octet just over 255), When validateUrl, Then succeeds (octet out of range => not an IPv4)', async () => {
      // Arrange — `n > 255` must be true at 256 so `10.0.0.256` is not read as 10/8.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('10.0.0.256') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('10.0.0.256');
    });
  });

  describe('IPv4 hex-mapped with unparseable octet (kill L97 ConditionalExpression / NoCoverage)', () => {
    it('Given DNS resolves to ::ffff:999.0.0.1 (IPv4-mapped with an out-of-range octet), When validateUrl, Then succeeds (octets undefined => not blocked)', async () => {
      // Arrange — exercises `isBlockedIpv4` with an addr that `parseIpv4` rejects.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('::ffff:999.0.0.1') }),
      );

      // Assert — `octets === undefined` must return false (not block).
      expect(sut.pinnedAddress).toBe('::ffff:999.0.0.1');
    });
  });

  describe('IPv4 192.168/16 operands (kill LogicalOperator L105)', () => {
    it('Given DNS resolves to 192.1.1.1 (a===192, b!==168), When validateUrl, Then succeeds', async () => {
      // Arrange — flips the `b === 168` operand; `&&` must keep this unblocked.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('192.1.1.1') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('192.1.1.1');
    });

    it('Given DNS resolves to 8.168.1.1 (a!==192, b===168), When validateUrl, Then succeeds', async () => {
      // Arrange — flips the `a === 192` operand; `&&` must keep this unblocked.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('8.168.1.1') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('8.168.1.1');
    });
  });

  describe('IPv6 ::ffff:0: form (kill Regex L114 trailing anchor)', () => {
    it('Given DNS resolves to ::ffff:0:10.0.0.1 (IPv4-mapped via 0: form), When validateUrl, Then throws BLOCKED_HOST', async () => {
      // Arrange — the optional `(?:0:)?` group plus the embedded private IPv4.
      // Act + Assert
      await expectError(
        validateUrl(
          'https://example.com/x',
          opts({ resolver: fixedResolver('::ffff:0:10.0.0.1') }),
        ),
        'BLOCKED_HOST',
      );
    });

    it('Given DNS resolves to ::ffff:10.0.0.1.9 (private IPv4 with trailing junk), When validateUrl, Then succeeds (trailing $ anchor must reject the junk)', async () => {
      // Arrange — without the `$` anchor the mutant matches `10.0.0.1` and wrongly blocks it.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('::ffff:10.0.0.1.9') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('::ffff:10.0.0.1.9');
    });
  });

  describe('IPv4 block-range LHS operands (kill ConditionalExpression a-octet checks)', () => {
    it('Given DNS resolves to 8.64.0.1 (a!==100 but b in CGNAT 64..127), When validateUrl, Then succeeds', async () => {
      // Arrange — forcing `a === 100` to `true` would block this; the `a` operand must hold.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('8.64.0.1') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('8.64.0.1');
    });

    it('Given DNS resolves to 8.254.0.1 (a!==169 but b===254), When validateUrl, Then succeeds', async () => {
      // Arrange — forcing `a === 169` to `true` would block this; the `a` operand must hold.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('8.254.0.1') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('8.254.0.1');
    });

    it('Given DNS resolves to 8.16.0.1 (a!==172 but b in 16..31), When validateUrl, Then succeeds', async () => {
      // Arrange — forcing `a === 172` to `true` would block this; the `a` operand must hold.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('8.16.0.1') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('8.16.0.1');
    });
  });

  describe('IPv6 hex-mapped multi-digit low group (kill Regex L120 second {1,4})', () => {
    it('Given DNS resolves to ::ffff:7f00:aa (hex form of 127.0.0.170, 2-digit low group), When validateUrl, Then throws BLOCKED_HOST', async () => {
      // Arrange — the low group `aa` has 2 hex digits; shrinking `{1,4}` to `{1}`
      // would make the regex miss it, letting the loopback address bypass the guard.
      // Act + Assert
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::ffff:7f00:aa') })),
        'BLOCKED_HOST',
      );
    });
  });

  describe('IPv6 hex-mapped regex anchors (kill Regex L119)', () => {
    it('Given DNS resolves to g::ffff:7f00:1 (junk prefix), When validateUrl, Then succeeds (leading ^ anchor must reject the prefix)', async () => {
      // Arrange — without `^` the mutant matches the embedded `::ffff:7f00:1` (127.0.0.1).
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('g::ffff:7f00:1') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('g::ffff:7f00:1');
    });

    it('Given DNS resolves to ::ffff:7f00:1g (junk suffix), When validateUrl, Then succeeds (trailing $ anchor must reject the suffix)', async () => {
      // Arrange — without `$` the mutant matches the leading `::ffff:7f00:1` (127.0.0.1).
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('::ffff:7f00:1g') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('::ffff:7f00:1g');
    });
  });

  describe('IPv6 :: literals (kill ConditionalExpression / StringLiteral L126)', () => {
    it('Given DNS resolves to :: (all-zeros), When validateUrl, Then throws BLOCKED_HOST', async () => {
      // Arrange — the `lower === '::'` operand only.
      // Act + Assert
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::') })),
        'BLOCKED_HOST',
      );
    });

    it('Given DNS resolves to ::1 (loopback), When validateUrl, Then throws BLOCKED_HOST', async () => {
      // Arrange — the `lower === '::1'` operand only.
      // Act + Assert
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('::1') })),
        'BLOCKED_HOST',
      );
    });

    it('Given DNS resolves to ::2 (not a blocked literal), When validateUrl, Then succeeds', async () => {
      // Arrange — neither `::1` nor `::` literal matches; the StringLiteral mutants would mis-block.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('::2') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('::2');
    });
  });

  describe('IPv6 fe80 prefix (kill LogicalOperator / MethodExpression L127)', () => {
    it('Given DNS resolves to fe80:abcd::1 (fe80: prefix, not fe80::), When validateUrl, Then throws BLOCKED_HOST', async () => {
      // Arrange — only the `startsWith('fe80:')` operand matches here.
      // Act + Assert
      await expectError(
        validateUrl('https://example.com/x', opts({ resolver: fixedResolver('fe80:abcd::1') })),
        'BLOCKED_HOST',
      );
    });

    it('Given DNS resolves to abcd::fe80: (ends with fe80: but does not start with it), When validateUrl, Then succeeds', async () => {
      // Arrange — kills `startsWith` -> `endsWith` mutants; endsWith would mis-block this.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('abcd::fe80:') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('abcd::fe80:');
    });

    it('Given DNS resolves to abcd:fe80:: (ends with fe80:: but does not start with it), When validateUrl, Then succeeds', async () => {
      // Arrange — kills the `startsWith('fe80::')` -> `endsWith('fe80::')` mutant.
      // Act
      const sut = await validateUrl(
        'https://example.com/x',
        opts({ resolver: fixedResolver('abcd:fe80::') }),
      );

      // Assert
      expect(sut.pinnedAddress).toBe('abcd:fe80::');
    });
  });
});
