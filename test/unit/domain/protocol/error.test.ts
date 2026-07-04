import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import {
  duplicateRef,
  emptyReceiveUpdates,
  emptyWants,
  invalidBaseUrl,
  invalidPktLength,
  invalidRefLine,
  invalidReportStatus,
  invalidSidebandChannel,
  missingCapabilities,
  missingServiceHeader,
  type ProtocolError,
  pktLengthReserved,
  pktTooLarge,
  pktTruncated,
  sidebandFatal,
  tooManyAdvertisedRefs,
  unexpectedV2Section,
  unknownAckStatus,
  v2CommandUnsupported,
} from '../../../../src/domain/protocol/error.js';

describe('domain protocol error', () => {
  describe('factory data', () => {
    describe('Given invalidPktLength("xxxx")', () => {
      describe('When checking data', () => {
        it('Then code is INVALID_PKT_LENGTH and value preserved', () => {
          // Arrange & Act
          const sut = invalidPktLength('xxxx');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_PKT_LENGTH', value: 'xxxx' });
        });
      });
    });

    describe('Given pktLengthReserved(1)', () => {
      describe('When checking data', () => {
        it('Then code is PKT_LENGTH_RESERVED and value preserved', () => {
          // Arrange & Act
          const sut = pktLengthReserved(1);

          // Assert
          expect(sut.data).toEqual({ code: 'PKT_LENGTH_RESERVED', value: 1 });
        });
      });
    });

    describe('Given pktTooLarge(65521)', () => {
      describe('When checking data', () => {
        it('Then code is PKT_TOO_LARGE and value preserved', () => {
          // Arrange & Act
          const sut = pktTooLarge(65521);

          // Assert
          expect(sut.data).toEqual({ code: 'PKT_TOO_LARGE', value: 65521 });
        });
      });
    });

    describe('Given pktTruncated(2)', () => {
      describe('When checking data', () => {
        it('Then code is PKT_TRUNCATED and remaining preserved', () => {
          // Arrange & Act
          const sut = pktTruncated(2);

          // Assert
          expect(sut.data).toEqual({ code: 'PKT_TRUNCATED', remaining: 2 });
        });
      });
    });

    describe('Given invalidBaseUrl("fragment")', () => {
      describe('When checking data', () => {
        it('Then code is INVALID_BASE_URL and reason preserved', () => {
          // Arrange & Act
          const sut = invalidBaseUrl('fragment');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_BASE_URL', reason: 'fragment' });
        });
      });
    });

    describe('Given missingServiceHeader("git-upload-pack", "git-receive-pack")', () => {
      describe('When checking data', () => {
        it('Then code, expected, actual populated', () => {
          // Arrange & Act
          const sut = missingServiceHeader('git-upload-pack', 'git-receive-pack');

          // Assert
          expect(sut.data).toEqual({
            code: 'MISSING_SERVICE_HEADER',
            expected: 'git-upload-pack',
            actual: 'git-receive-pack',
          });
        });
      });
    });

    describe('Given missingCapabilities()', () => {
      describe('When checking data', () => {
        it('Then code is MISSING_CAPABILITIES', () => {
          // Arrange & Act
          const sut = missingCapabilities();

          // Assert
          expect(sut.data).toEqual({ code: 'MISSING_CAPABILITIES' });
        });
      });
    });

    describe('Given invalidRefLine("bad")', () => {
      describe('When checking data', () => {
        it('Then code is INVALID_REF_LINE and line preserved', () => {
          // Arrange & Act
          const sut = invalidRefLine('bad');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_REF_LINE', line: 'bad' });
        });
      });
    });

    describe('Given duplicateRef("refs/heads/main")', () => {
      describe('When checking data', () => {
        it('Then code is DUPLICATE_REF and name preserved', () => {
          // Arrange & Act
          const sut = duplicateRef('refs/heads/main');

          // Assert
          expect(sut.data).toEqual({ code: 'DUPLICATE_REF', name: 'refs/heads/main' });
        });
      });
    });

    describe('Given invalidSidebandChannel(4)', () => {
      describe('When checking data', () => {
        it('Then code is INVALID_SIDEBAND_CHANNEL and channel preserved', () => {
          // Arrange & Act
          const sut = invalidSidebandChannel(4);

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_SIDEBAND_CHANNEL', channel: 4 });
        });
      });
    });

    describe('Given sidebandFatal("repo not found")', () => {
      describe('When checking data', () => {
        it('Then code is SIDEBAND_FATAL and message preserved', () => {
          // Arrange & Act
          const sut = sidebandFatal('repo not found');

          // Assert
          expect(sut.data).toEqual({ code: 'SIDEBAND_FATAL', message: 'repo not found' });
        });
      });
    });

    describe('Given unknownAckStatus("bogus")', () => {
      describe('When checking data', () => {
        it('Then code is UNKNOWN_ACK_STATUS and value preserved', () => {
          // Arrange & Act
          const sut = unknownAckStatus('bogus');

          // Assert
          expect(sut.data).toEqual({ code: 'UNKNOWN_ACK_STATUS', value: 'bogus' });
        });
      });
    });

    describe('Given invalidReportStatus("weird")', () => {
      describe('When checking data', () => {
        it('Then code is INVALID_REPORT_STATUS and line preserved', () => {
          // Arrange & Act
          const sut = invalidReportStatus('weird');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_REPORT_STATUS', line: 'weird' });
        });
      });
    });

    describe('Given emptyWants()', () => {
      describe('When checking data', () => {
        it('Then code is EMPTY_WANTS', () => {
          // Arrange & Act
          const sut = emptyWants();

          // Assert
          expect(sut.data).toEqual({ code: 'EMPTY_WANTS' });
        });
      });
    });

    describe('Given emptyReceiveUpdates()', () => {
      describe('When checking data', () => {
        it('Then code is EMPTY_RECEIVE_UPDATES', () => {
          // Arrange & Act
          const sut = emptyReceiveUpdates();

          // Assert
          expect(sut.data).toEqual({ code: 'EMPTY_RECEIVE_UPDATES' });
        });
      });
    });

    describe('Given tooManyAdvertisedRefs(count, limit)', () => {
      describe('When checking data', () => {
        it('Then code, count, and limit are preserved', () => {
          // Arrange & Act
          const sut = tooManyAdvertisedRefs(500_001, 500_000);

          // Assert
          expect(sut.data).toEqual({
            code: 'TOO_MANY_ADVERTISED_REFS',
            count: 500_001,
            limit: 500_000,
          });
        });
      });
    });

    describe("Given unexpectedV2Section('wanted-refs')", () => {
      describe('When checking data', () => {
        it('Then code is UNEXPECTED_V2_SECTION and section preserved', () => {
          // Arrange & Act
          const sut = unexpectedV2Section('wanted-refs');

          // Assert
          expect(sut.data).toEqual({ code: 'UNEXPECTED_V2_SECTION', section: 'wanted-refs' });
          expect(sut.message).toContain('wanted-refs');
        });
      });
    });

    describe("Given v2CommandUnsupported('fetch')", () => {
      describe('When checking data', () => {
        it('Then code is V2_COMMAND_UNSUPPORTED and command preserved', () => {
          // Arrange & Act
          const sut = v2CommandUnsupported('fetch');

          // Assert
          expect(sut.data).toEqual({ code: 'V2_COMMAND_UNSUPPORTED', command: 'fetch' });
          expect(sut.message).toContain('fetch');
        });
      });
    });
  });

  describe('extractDetail message formatting (exact match)', () => {
    type Case = readonly [ProtocolError, string];

    const cases: ReadonlyArray<Case> = [
      [
        { code: 'INVALID_PKT_LENGTH', value: 'xxxx' },
        'INVALID_PKT_LENGTH: invalid pkt-line length: xxxx',
      ],
      [
        { code: 'PKT_LENGTH_RESERVED', value: 3 },
        'PKT_LENGTH_RESERVED: reserved pkt-line length: 3',
      ],
      [
        { code: 'PKT_TOO_LARGE', value: 65521 },
        'PKT_TOO_LARGE: pkt-line too large: 65521 bytes (max 65520)',
      ],
      [
        { code: 'PKT_TRUNCATED', remaining: 6 },
        'PKT_TRUNCATED: pkt-line truncated: 6 bytes remaining',
      ],
      [
        { code: 'INVALID_BASE_URL', reason: 'invalid URL' },
        'INVALID_BASE_URL: invalid base URL: invalid URL',
      ],
      [
        {
          code: 'MISSING_SERVICE_HEADER',
          expected: 'git-upload-pack',
          actual: 'git-receive-pack',
        },
        'MISSING_SERVICE_HEADER: missing service header: expected=git-upload-pack actual=git-receive-pack',
      ],
      [
        { code: 'MISSING_CAPABILITIES' },
        'MISSING_CAPABILITIES: missing capabilities in advertisement',
      ],
      [
        { code: 'INVALID_REF_LINE', line: 'bad ref' },
        'INVALID_REF_LINE: invalid ref line: bad ref',
      ],
      [
        { code: 'DUPLICATE_REF', name: 'refs/heads/main' },
        'DUPLICATE_REF: duplicate ref: refs/heads/main',
      ],
      [
        { code: 'INVALID_SIDEBAND_CHANNEL', channel: 4 },
        'INVALID_SIDEBAND_CHANNEL: invalid sideband channel: 4',
      ],
      [
        { code: 'SIDEBAND_FATAL', message: 'repository not found' },
        'SIDEBAND_FATAL: sideband fatal: repository not found',
      ],
      [
        { code: 'UNKNOWN_ACK_STATUS', value: 'bogus' },
        'UNKNOWN_ACK_STATUS: unknown ack status: bogus',
      ],
      [
        { code: 'INVALID_REPORT_STATUS', line: 'weird line' },
        'INVALID_REPORT_STATUS: invalid report-status line: weird line',
      ],
      [{ code: 'EMPTY_WANTS' }, 'EMPTY_WANTS: upload-pack request has no wants'],
      [
        { code: 'EMPTY_RECEIVE_UPDATES' },
        'EMPTY_RECEIVE_UPDATES: receive-pack request has no updates',
      ],
      [
        { code: 'TOO_MANY_ADVERTISED_REFS', count: 500_001, limit: 500_000 },
        'TOO_MANY_ADVERTISED_REFS: advertised refs (500001) exceed limit 500000',
      ],
      [
        { code: 'UNEXPECTED_V2_SECTION', section: 'wanted-refs' },
        'UNEXPECTED_V2_SECTION: unexpected v2 section: wanted-refs',
      ],
      [
        { code: 'V2_COMMAND_UNSUPPORTED', command: 'fetch' },
        'V2_COMMAND_UNSUPPORTED: unsupported v2 command or capability: fetch',
      ],
    ];

    describe('Given protocol error %j', () => {
      describe('When TsgitError(...).message is read', () => {
        it.each(cases)('Then it equals the documented format', (data, expected) => {
          // Arrange & Act
          const sut = new TsgitError(data);

          // Assert
          expect(sut.message).toBe(expected);
        });
      });
      describe('When checking .data.code', () => {
        it.each(cases)('Then it strictly equals the variant literal', (data) => {
          // Arrange & Act
          const sut = new TsgitError(data);

          // Assert
          expect(sut.data.code).toBe(data.code);
        });
      });
    });
  });
});
