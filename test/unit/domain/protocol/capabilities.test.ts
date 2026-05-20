import { describe, expect, it } from 'vitest';

import {
  AGENT,
  CLIENT_CAPABILITIES_FETCH,
  CLIENT_CAPABILITIES_PUSH,
  formatCapabilities,
  negotiateCapabilities,
  parseCapabilities,
} from '../../../../src/domain/protocol/capabilities.js';

describe('parseCapabilities', () => {
  it('Given a space-delimited tail, When parsed, Then returns the tokens in order', () => {
    // Arrange
    const tail = 'multi_ack_detailed side-band-64k ofs-delta';

    // Act
    const sut = parseCapabilities(tail);

    // Assert
    expect(sut).toEqual(['multi_ack_detailed', 'side-band-64k', 'ofs-delta']);
  });

  it('Given a tail with key=value entries, When parsed, Then keeps them as full tokens', () => {
    // Arrange
    const tail = 'agent=git/2.43 thin-pack';

    // Act
    const sut = parseCapabilities(tail);

    // Assert
    expect(sut).toEqual(['agent=git/2.43', 'thin-pack']);
  });

  it('Given an empty tail, When parsed, Then returns []', () => {
    // Arrange & Act
    const sut = parseCapabilities('');

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a tail with extra whitespace, When parsed, Then returns no empty entries', () => {
    // Arrange
    const tail = '  side-band-64k  ofs-delta  ';

    // Act
    const sut = parseCapabilities(tail);

    // Assert
    expect(sut).toEqual(['side-band-64k', 'ofs-delta']);
  });

  it('Given a duplicated boolean cap, When parsed, Then returns only one entry', () => {
    // Arrange
    const tail = 'side-band-64k side-band-64k';

    // Act
    const sut = parseCapabilities(tail);

    // Assert
    expect(sut).toEqual(['side-band-64k']);
  });

  it('Given two key=value variants of the same key, When parsed, Then last write wins', () => {
    // Arrange
    const tail = 'agent=git/2.40 agent=git/2.43';

    // Act
    const sut = parseCapabilities(tail);

    // Assert
    expect(sut).toEqual(['agent=git/2.43']);
  });
});

describe('formatCapabilities', () => {
  it('Given two caps, When formatted, Then space-joined', () => {
    // Arrange
    const caps = ['side-band-64k', 'ofs-delta'];

    // Act
    const sut = formatCapabilities(caps);

    // Assert
    expect(sut).toBe('side-band-64k ofs-delta');
  });

  it('Given an empty array, When formatted, Then empty string (not "undefined")', () => {
    // Arrange & Act
    const sut = formatCapabilities([]);

    // Assert
    expect(sut).toBe('');
  });

  it('Given a single cap, When formatted, Then no trailing space', () => {
    // Arrange
    const caps = ['side-band-64k'];

    // Act
    const sut = formatCapabilities(caps);

    // Assert
    expect(sut).toBe('side-band-64k');
  });
});

describe('negotiateCapabilities', () => {
  it('Given server has extra-cap and client requests overlap, When negotiated, Then returns intersection only', () => {
    // Arrange
    const server = ['side-band-64k', 'ofs-delta', 'extra-cap'];
    const client = ['side-band-64k', 'thin-pack'];

    // Act
    const sut = negotiateCapabilities(server, client);

    // Assert
    expect(sut).toEqual(['side-band-64k']);
  });

  it("Given key=value forms with different values, When negotiated, Then server's value wins", () => {
    // Arrange
    const server = ['agent=git/2.43'];
    const client = ['agent=tsgit/0.x'];

    // Act
    const sut = negotiateCapabilities(server, client);

    // Assert
    expect(sut).toEqual(['agent=git/2.43']);
  });

  it('Given server is empty, When negotiated, Then []', () => {
    // Arrange & Act
    const sut = negotiateCapabilities([], ['side-band-64k']);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given client is empty, When negotiated, Then []', () => {
    // Arrange & Act
    const sut = negotiateCapabilities(['side-band-64k'], []);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given boolean tokens (no "=") that differ only by their last character, When negotiated, Then no match (whole token is the key)', () => {
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

  it('Given two tokens that each start with "=", When negotiated, Then their key is the empty string and they match', () => {
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

describe('AGENT constant shape', () => {
  it('Given AGENT, When inspected, Then matches /^agent=tsgit\\/(?:\\d+\\.\\d+|0\\.x)$/', () => {
    expect(AGENT).toMatch(/^agent=tsgit\/(?:\d+\.\d+|0\.x)$/);
  });

  it('Given AGENT, When inspected, Then it does NOT contain a third numeric segment', () => {
    // Pinned via regex match above, but the explicit pin guards against future drift.
    expect(AGENT).not.toMatch(/agent=tsgit\/\d+\.\d+\.\d/);
  });

  it('Given AGENT, When inspected, Then it does NOT contain a SHA, "+build", or "-rc" suffix', () => {
    expect(AGENT).not.toMatch(/[+-]/);
  });
});

describe('CLIENT_CAPABILITIES_FETCH', () => {
  it.each([
    'multi_ack_detailed',
    'side-band-64k',
    'ofs-delta',
    'thin-pack',
    'no-progress',
    'include-tag',
  ])('Given CLIENT_CAPABILITIES_FETCH, When inspected, Then it includes %j', (cap) => {
    expect(CLIENT_CAPABILITIES_FETCH).toContain(cap);
  });

  it('Given CLIENT_CAPABILITIES_FETCH, When inspected, Then it includes the AGENT token', () => {
    expect(CLIENT_CAPABILITIES_FETCH).toContain(AGENT);
  });
});

describe('CLIENT_CAPABILITIES_PUSH', () => {
  it.each([
    'report-status',
    'side-band-64k',
    'ofs-delta',
    'atomic',
    'delete-refs',
  ])('Given CLIENT_CAPABILITIES_PUSH, When inspected, Then it includes %j', (cap) => {
    expect(CLIENT_CAPABILITIES_PUSH).toContain(cap);
  });

  it('Given CLIENT_CAPABILITIES_PUSH, When inspected, Then it includes the AGENT token', () => {
    expect(CLIENT_CAPABILITIES_PUSH).toContain(AGENT);
  });
});
