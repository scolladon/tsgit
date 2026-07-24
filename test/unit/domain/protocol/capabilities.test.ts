import { describe, expect, it } from 'vitest';

import {
  AGENT,
  CLIENT_CAPABILITIES_FETCH,
  CLIENT_CAPABILITIES_PUSH,
  formatCapabilities,
  negotiateCapabilities,
  PUSH_CERT,
  parseCapabilities,
} from '../../../../src/domain/protocol/capabilities.js';

describe('parseCapabilities', () => {
  describe('Given a capability tail', () => {
    describe('When parsed', () => {
      it.each([
        {
          tail: 'multi_ack_detailed side-band-64k ofs-delta',
          expected: ['multi_ack_detailed', 'side-band-64k', 'ofs-delta'],
          label: 'returns the tokens in order',
        },
        {
          tail: 'agent=git/2.43 thin-pack',
          expected: ['agent=git/2.43', 'thin-pack'],
          label: 'keeps key=value entries as full tokens',
        },
        {
          tail: '',
          expected: [],
          label: 'returns [] for an empty tail',
        },
        {
          tail: '  side-band-64k  ofs-delta  ',
          expected: ['side-band-64k', 'ofs-delta'],
          label: 'returns no empty entries for extra whitespace',
        },
        {
          tail: 'side-band-64k side-band-64k',
          expected: ['side-band-64k'],
          label: 'returns only one entry for a duplicated boolean cap',
        },
        {
          tail: 'agent=git/2.40 agent=git/2.43',
          expected: ['agent=git/2.43'],
          label: 'lets the last key=value variant win',
        },
        {
          tail: 'push-cert=1700000000-deadbeef push-cert=1700000000-deadbeef side-band-64k',
          expected: ['push-cert=1700000000-deadbeef', 'side-band-64k'],
          label: "preserves a duplicated push-cert=<nonce> token, de-duped under key 'push-cert'",
        },
      ])('Then it $label', ({ tail, expected }) => {
        // Arrange & Act
        const sut = parseCapabilities(tail);

        // Assert
        expect(sut).toEqual(expected);
      });
    });
  });
});

describe('formatCapabilities', () => {
  describe('Given a capability list', () => {
    describe('When formatted', () => {
      it.each([
        {
          caps: ['side-band-64k', 'ofs-delta'],
          expected: 'side-band-64k ofs-delta',
          label: 'space-joins the caps',
        },
        {
          caps: [] as ReadonlyArray<string>,
          expected: '',
          label: 'returns an empty string (not "undefined")',
        },
        {
          caps: ['side-band-64k'],
          expected: 'side-band-64k',
          label: 'has no trailing space for a single cap',
        },
      ])('Then it $label', ({ caps, expected }) => {
        // Arrange & Act
        const sut = formatCapabilities(caps);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

describe('negotiateCapabilities', () => {
  describe('Given server and client capability lists', () => {
    describe('When negotiated', () => {
      it.each([
        {
          server: ['side-band-64k', 'ofs-delta', 'extra-cap'],
          client: ['side-band-64k', 'thin-pack'],
          expected: ['side-band-64k'],
          label: 'returns intersection only',
        },
        {
          server: ['agent=git/2.43'],
          client: ['agent=tsgit/0.x'],
          expected: ['agent=git/2.43'],
          label: "keeps key=value forms with different values — server's value wins",
        },
        {
          server: [] as ReadonlyArray<string>,
          client: ['side-band-64k'],
          expected: [],
          label: 'returns [] when server is empty',
        },
        {
          server: ['side-band-64k'],
          client: [] as ReadonlyArray<string>,
          expected: [],
          label: 'returns [] when client is empty',
        },
        {
          // `keyOf` returns the whole token when there is no "=". A mutant that
          // always slices (`token.slice(0, eq)` with eq=-1) would drop the last
          // char of each, collapsing 'agentX' and 'agentY' to the same key.
          server: ['agentX'],
          client: ['agentY'],
          expected: [],
          label: 'does not match boolean tokens that differ only by their last character',
        },
        {
          // For a token starting with "=", `indexOf('=')` is 0 and the guard
          // `eq < 0` is false, so `keyOf` returns `token.slice(0, 0)` === ''. An
          // `eq <= 0` mutant would instead return the whole token, so the two
          // distinct tokens would no longer share a key.
          server: ['=foo'],
          client: ['=bar'],
          expected: ['=foo'],
          label: 'matches two tokens that each start with "=" (empty-string key)',
        },
        {
          server: ['push-cert=1700000000-deadbeef', 'side-band-64k'],
          client: [PUSH_CERT, 'side-band-64k'],
          expected: ['push-cert=1700000000-deadbeef', 'side-band-64k'],
          label: "includes the server's push-cert=<nonce> token for a bare client request",
        },
      ])('Then it $label', ({ server, client, expected }) => {
        // Arrange & Act
        const sut = negotiateCapabilities(server, client);

        // Assert
        expect(sut).toEqual(expected);
      });
    });
  });
});

describe('AGENT constant shape', () => {
  describe('Given AGENT', () => {
    describe('When inspected', () => {
      it('Then matches /^agent=tsgit\\/(?:\\d+\\.\\d+|0\\.x)$/', () => {
        // Arrange + Assert
        expect(AGENT).toMatch(/^agent=tsgit\/(?:\d+\.\d+|0\.x)$/);
      });
      it.each([
        {
          pattern: /agent=tsgit\/\d+\.\d+\.\d/,
          label: 'it does NOT contain a third numeric segment',
        },
        {
          pattern: /[+-]/,
          label: 'it does NOT contain a SHA, "+build", or "-rc" suffix',
        },
      ])('Then $label', ({ pattern }) => {
        // Arrange + Assert
        // Pinned via regex match above, but the explicit pin guards against future drift.
        expect(AGENT).not.toMatch(pattern);
      });
    });
  });
});

describe('CLIENT_CAPABILITIES_FETCH', () => {
  describe('Given CLIENT_CAPABILITIES_FETCH', () => {
    describe('When inspected', () => {
      it.each([
        'multi_ack_detailed',
        'side-band-64k',
        'ofs-delta',
        'thin-pack',
        'no-progress',
        'include-tag',
        'filter',
        AGENT,
      ])('Then it includes %j', (cap) => {
        // Arrange + Assert
        expect(CLIENT_CAPABILITIES_FETCH).toContain(cap);
      });
    });
  });
});

describe('CLIENT_CAPABILITIES_PUSH', () => {
  describe('Given CLIENT_CAPABILITIES_PUSH', () => {
    describe('When inspected', () => {
      it.each(['report-status', 'side-band-64k', 'ofs-delta', 'atomic', 'delete-refs', AGENT])(
        'Then it includes %j',
        (cap) => {
          // Arrange + Assert
          expect(CLIENT_CAPABILITIES_PUSH).toContain(cap);
        },
      );
      it('Then it does NOT include the push-cert token', () => {
        // Arrange + Assert — push-cert is conditional, added only when signing
        expect(CLIENT_CAPABILITIES_PUSH).not.toContain(PUSH_CERT);
      });
    });
  });
});

describe('PUSH_CERT constant', () => {
  describe('Given PUSH_CERT', () => {
    describe('When inspected', () => {
      it("Then it is the bare token 'push-cert'", () => {
        // Arrange + Assert
        expect(PUSH_CERT).toBe('push-cert');
      });
    });
  });
});
