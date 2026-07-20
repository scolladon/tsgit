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
  describe('Given a space-delimited tail', () => {
    describe('When parsed', () => {
      it('Then returns the tokens in order', () => {
        // Arrange
        const tail = 'multi_ack_detailed side-band-64k ofs-delta';

        // Act
        const sut = parseCapabilities(tail);

        // Assert
        expect(sut).toEqual(['multi_ack_detailed', 'side-band-64k', 'ofs-delta']);
      });
    });
  });

  describe('Given a tail with key=value entries', () => {
    describe('When parsed', () => {
      it('Then keeps them as full tokens', () => {
        // Arrange
        const tail = 'agent=git/2.43 thin-pack';

        // Act
        const sut = parseCapabilities(tail);

        // Assert
        expect(sut).toEqual(['agent=git/2.43', 'thin-pack']);
      });
    });
  });

  describe('Given an empty tail', () => {
    describe('When parsed', () => {
      it('Then returns []', () => {
        // Arrange & Act
        const sut = parseCapabilities('');

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given a tail with extra whitespace', () => {
    describe('When parsed', () => {
      it('Then returns no empty entries', () => {
        // Arrange
        const tail = '  side-band-64k  ofs-delta  ';

        // Act
        const sut = parseCapabilities(tail);

        // Assert
        expect(sut).toEqual(['side-band-64k', 'ofs-delta']);
      });
    });
  });

  describe('Given a duplicated boolean cap', () => {
    describe('When parsed', () => {
      it('Then returns only one entry', () => {
        // Arrange
        const tail = 'side-band-64k side-band-64k';

        // Act
        const sut = parseCapabilities(tail);

        // Assert
        expect(sut).toEqual(['side-band-64k']);
      });
    });
  });

  describe('Given two key=value variants of the same key', () => {
    describe('When parsed', () => {
      it('Then last write wins', () => {
        // Arrange
        const tail = 'agent=git/2.40 agent=git/2.43';

        // Act
        const sut = parseCapabilities(tail);

        // Assert
        expect(sut).toEqual(['agent=git/2.43']);
      });
    });
  });

  describe('Given a tail containing a duplicated push-cert=<nonce> token', () => {
    describe('When parsed', () => {
      it("Then the token is preserved and de-dupes under key 'push-cert'", () => {
        // Arrange
        const tail = 'push-cert=1700000000-deadbeef push-cert=1700000000-deadbeef side-band-64k';

        // Act
        const sut = parseCapabilities(tail);

        // Assert
        expect(sut).toEqual(['push-cert=1700000000-deadbeef', 'side-band-64k']);
      });
    });
  });
});

describe('formatCapabilities', () => {
  describe('Given two caps', () => {
    describe('When formatted', () => {
      it('Then space-joined', () => {
        // Arrange
        const caps = ['side-band-64k', 'ofs-delta'];

        // Act
        const sut = formatCapabilities(caps);

        // Assert
        expect(sut).toBe('side-band-64k ofs-delta');
      });
    });
  });

  describe('Given an empty array', () => {
    describe('When formatted', () => {
      it('Then empty string (not "undefined")', () => {
        // Arrange & Act
        const sut = formatCapabilities([]);

        // Assert
        expect(sut).toBe('');
      });
    });
  });

  describe('Given a single cap', () => {
    describe('When formatted', () => {
      it('Then no trailing space', () => {
        // Arrange
        const caps = ['side-band-64k'];

        // Act
        const sut = formatCapabilities(caps);

        // Assert
        expect(sut).toBe('side-band-64k');
      });
    });
  });
});

describe('negotiateCapabilities', () => {
  describe('Given server has extra-cap and client requests overlap', () => {
    describe('When negotiated', () => {
      it('Then returns intersection only', () => {
        // Arrange
        const server = ['side-band-64k', 'ofs-delta', 'extra-cap'];
        const client = ['side-band-64k', 'thin-pack'];

        // Act
        const sut = negotiateCapabilities(server, client);

        // Assert
        expect(sut).toEqual(['side-band-64k']);
      });
    });
  });

  describe('Given key=value forms with different values', () => {
    describe('When negotiated', () => {
      it("Then server's value wins", () => {
        // Arrange
        const server = ['agent=git/2.43'];
        const client = ['agent=tsgit/0.x'];

        // Act
        const sut = negotiateCapabilities(server, client);

        // Assert
        expect(sut).toEqual(['agent=git/2.43']);
      });
    });
  });

  describe('Given server is empty', () => {
    describe('When negotiated', () => {
      it('Then []', () => {
        // Arrange & Act
        const sut = negotiateCapabilities([], ['side-band-64k']);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given client is empty', () => {
    describe('When negotiated', () => {
      it('Then []', () => {
        // Arrange & Act
        const sut = negotiateCapabilities(['side-band-64k'], []);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given boolean tokens (no "=") that differ only by their last character', () => {
    describe('When negotiated', () => {
      it('Then no match (whole token is the key)', () => {
        // Arrange — `keyOf` returns the whole token when there is no "=". A
        // mutant that always slices (`token.slice(0, eq)` with eq=-1) would drop
        // the last char of each, collapsing 'agentX' and 'agentY' to the same key.
        const server = ['agentX'];
        const client = ['agentY'];

        // Act
        const sut = negotiateCapabilities(server, client);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given two tokens that each start with "="', () => {
    describe('When negotiated', () => {
      it('Then their key is the empty string and they match', () => {
        // Arrange — for a token starting with "=", `indexOf('=')` is 0 and the
        // guard `eq < 0` is false, so `keyOf` returns `token.slice(0, 0)` === ''.
        // An `eq <= 0` mutant would instead return the whole token, so the two
        // distinct tokens would no longer share a key.
        const server = ['=foo'];
        const client = ['=bar'];

        // Act
        const sut = negotiateCapabilities(server, client);

        // Assert — both keys are '' so the server token is selected.
        expect(sut).toEqual(['=foo']);
      });
    });
  });

  describe('Given client wants a bare push-cert and the server advertises push-cert=<nonce>', () => {
    describe('When negotiated', () => {
      it("Then the negotiated set contains the server's push-cert=<nonce> token", () => {
        // Arrange
        const server = ['push-cert=1700000000-deadbeef', 'side-band-64k'];
        const client = [PUSH_CERT, 'side-band-64k'];

        // Act
        const sut = negotiateCapabilities(server, client);

        // Assert
        expect(sut).toEqual(['push-cert=1700000000-deadbeef', 'side-band-64k']);
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
      it('Then it does NOT contain a third numeric segment', () => {
        // Arrange + Assert
        // Pinned via regex match above, but the explicit pin guards against future drift.
        expect(AGENT).not.toMatch(/agent=tsgit\/\d+\.\d+\.\d/);
      });
      it('Then it does NOT contain a SHA, "+build", or "-rc" suffix', () => {
        // Arrange + Assert
        expect(AGENT).not.toMatch(/[+-]/);
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
      ])('Then it includes %j', (cap) => {
        // Arrange + Assert
        expect(CLIENT_CAPABILITIES_FETCH).toContain(cap);
      });
      it('Then it includes the AGENT token', () => {
        // Arrange + Assert
        expect(CLIENT_CAPABILITIES_FETCH).toContain(AGENT);
      });
    });
  });
});

describe('CLIENT_CAPABILITIES_PUSH', () => {
  describe('Given CLIENT_CAPABILITIES_PUSH', () => {
    describe('When inspected', () => {
      it.each(['report-status', 'side-band-64k', 'ofs-delta', 'atomic', 'delete-refs'])(
        'Then it includes %j',
        (cap) => {
          // Arrange + Assert
          expect(CLIENT_CAPABILITIES_PUSH).toContain(cap);
        },
      );
      it('Then it includes the AGENT token', () => {
        // Arrange + Assert
        expect(CLIENT_CAPABILITIES_PUSH).toContain(AGENT);
      });
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
