import fc from 'fast-check';

// Kept free of ':' and leading '/' so joined segments never reproduce the
// scp/ssh-url disambiguation edge cases (colon-before-slash, "://" inside a
// path) — those are the classifier's own job, pinned by the example tests in
// remote-url.test.ts, not by this round-trip grammar.
const HOST_ALPHABET = ['a', 'b', 'c', '0', '1', '.', '-'] as const;
const SEGMENT_ALPHABET = ['a', 'b', 'c', '0', '1', '.', '-', '_'] as const;
const USER_ALPHABET = ['a', 'b', 'c', 'd'] as const;

const arbHost = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...HOST_ALPHABET), { minLength: 1, maxLength: 10 })
    .map((chars) => chars.join(''))
    .filter((host) => !host.startsWith('-'));

const arbUser = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...USER_ALPHABET), { minLength: 1, maxLength: 6 })
    .map((chars) => chars.join(''));

const arbMaybeUser = (): fc.Arbitrary<string | undefined> =>
  fc.option(arbUser(), { nil: undefined });

const arbPathSegment = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...SEGMENT_ALPHABET), { minLength: 1, maxLength: 6 })
    .map((chars) => chars.join(''))
    .filter((segment) => !segment.startsWith('-'));

/** A `/`-joined path with no leading `/`, no leading `-`, and no doubled `/`. */
const arbPath = (): fc.Arbitrary<string> =>
  fc.array(arbPathSegment(), { minLength: 1, maxLength: 3 }).map((segments) => segments.join('/'));

type TildeMode = 'none' | 'home' | 'user';

const arbTildeMode = (): fc.Arbitrary<TildeMode> => fc.constantFrom('none', 'home', 'user');

const sshPathnameOf = (mode: TildeMode, path: string): string => {
  if (mode === 'home') return `/~/${path}`;
  if (mode === 'user') return `/~${path}`;
  return `/${path}`;
};

const authorityOf = (user: string | undefined, host: string): string =>
  user === undefined ? host : `${user}@${host}`;

const HEX_ALPHABET = ['0', '1', '9', 'a', 'f'] as const;

const arbHexGroup = (): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...HEX_ALPHABET), { minLength: 1, maxLength: 4 }).map((c) => c.join(''));

const arbHexGroups = (min: number, max: number): fc.Arbitrary<string> =>
  fc.array(arbHexGroup(), { minLength: min, maxLength: max }).map((g) => g.join(':'));

/**
 * Valid-subset IPv6 literals: `::`-compressed head/tail forms plus the full
 * 8-group form. WHATWG canonicalises these on parse (zero compression,
 * lowercase hex), which the canonicalising round-trip property absorbs.
 */
const arbIpv6Host = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbHexGroups(1, 3).map((tail) => `::${tail}`),
    fc
      .record({ head: arbHexGroups(1, 3), tail: arbHexGroups(1, 2) })
      .map(({ head, tail }) => `${head}::${tail}`),
    arbHexGroups(8, 8),
  );

/** IPv6 hosts must be bracketed inside a URL authority; bare hostnames pass through. */
const urlHostOf = (host: string): string => (host.includes(':') ? `[${host}]` : host);

const sshUrlArb = (): fc.Arbitrary<string> =>
  fc
    .record({
      user: arbMaybeUser(),
      host: fc.oneof(arbHost(), arbIpv6Host()),
      port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
      tildeMode: arbTildeMode(),
      path: arbPath(),
    })
    .map(({ user, host, port, tildeMode, path }) => {
      const portSuffix = port === undefined ? '' : `:${port}`;
      return `ssh://${authorityOf(user, urlHostOf(host))}${portSuffix}${sshPathnameOf(tildeMode, path)}`;
    });

const scpUrlArb = (): fc.Arbitrary<string> =>
  fc
    .record({ user: arbMaybeUser(), host: arbHost(), path: arbPath() })
    .map(({ user, host, path }) => `${authorityOf(user, host)}:${path}`);

const httpUrlArb = (): fc.Arbitrary<string> =>
  fc
    .record({ secure: fc.boolean(), host: arbHost(), path: arbPath() })
    .map(({ secure, host, path }) => `http${secure ? 's' : ''}://${host}/${path}`);

/** Raw remote-URL strings spanning the ssh://, scp-like, and http(s) grammars. */
export const remoteUrlArb = (): fc.Arbitrary<string> =>
  fc.oneof(sshUrlArb(), scpUrlArb(), httpUrlArb());

// Printable ASCII (space through tilde) — every byte in this range round-trips
// through a POSIX single-quoted shell token, including quotes and spaces.
const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX = 0x7e;
const PRINTABLE_ASCII = Array.from(
  { length: PRINTABLE_ASCII_MAX - PRINTABLE_ASCII_MIN + 1 },
  (_, i) => String.fromCharCode(PRINTABLE_ASCII_MIN + i),
);

/** Arbitrary path-like string, incl. embedded quotes and spaces, for the sqQuote round-trip property. */
export const pathArb = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...PRINTABLE_ASCII), { minLength: 0, maxLength: 24 })
    .map((chars) => chars.join(''));
