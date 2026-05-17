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
  unknownAckStatus,
} from '../../../../src/domain/protocol/error.js';

describe('domain protocol error', () => {
  describe('factory data', () => {
    it('Given invalidPktLength("xxxx"), When checking data, Then code is INVALID_PKT_LENGTH and value preserved', () => {
      // Arrange & Act
      const sut = invalidPktLength('xxxx');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_PKT_LENGTH', value: 'xxxx' });
    });

    it('Given pktLengthReserved(1), When checking data, Then code is PKT_LENGTH_RESERVED and value preserved', () => {
      // Arrange & Act
      const sut = pktLengthReserved(1);

      // Assert
      expect(sut.data).toEqual({ code: 'PKT_LENGTH_RESERVED', value: 1 });
    });

    it('Given pktTooLarge(65521), When checking data, Then code is PKT_TOO_LARGE and value preserved', () => {
      // Arrange & Act
      const sut = pktTooLarge(65521);

      // Assert
      expect(sut.data).toEqual({ code: 'PKT_TOO_LARGE', value: 65521 });
    });

    it('Given pktTruncated(2), When checking data, Then code is PKT_TRUNCATED and remaining preserved', () => {
      // Arrange & Act
      const sut = pktTruncated(2);

      // Assert
      expect(sut.data).toEqual({ code: 'PKT_TRUNCATED', remaining: 2 });
    });

    it('Given invalidBaseUrl("fragment"), When checking data, Then code is INVALID_BASE_URL and reason preserved', () => {
      // Arrange & Act
      const sut = invalidBaseUrl('fragment');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_BASE_URL', reason: 'fragment' });
    });

    it('Given missingServiceHeader("git-upload-pack", "git-receive-pack"), When checking data, Then code, expected, actual populated', () => {
      // Arrange & Act
      const sut = missingServiceHeader('git-upload-pack', 'git-receive-pack');

      // Assert
      expect(sut.data).toEqual({
        code: 'MISSING_SERVICE_HEADER',
        expected: 'git-upload-pack',
        actual: 'git-receive-pack',
      });
    });

    it('Given missingCapabilities(), When checking data, Then code is MISSING_CAPABILITIES', () => {
      // Arrange & Act
      const sut = missingCapabilities();

      // Assert
      expect(sut.data).toEqual({ code: 'MISSING_CAPABILITIES' });
    });

    it('Given invalidRefLine("bad"), When checking data, Then code is INVALID_REF_LINE and line preserved', () => {
      // Arrange & Act
      const sut = invalidRefLine('bad');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_REF_LINE', line: 'bad' });
    });

    it('Given duplicateRef("refs/heads/main"), When checking data, Then code is DUPLICATE_REF and name preserved', () => {
      // Arrange & Act
      const sut = duplicateRef('refs/heads/main');

      // Assert
      expect(sut.data).toEqual({ code: 'DUPLICATE_REF', name: 'refs/heads/main' });
    });

    it('Given invalidSidebandChannel(4), When checking data, Then code is INVALID_SIDEBAND_CHANNEL and channel preserved', () => {
      // Arrange & Act
      const sut = invalidSidebandChannel(4);

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_SIDEBAND_CHANNEL', channel: 4 });
    });

    it('Given sidebandFatal("repo not found"), When checking data, Then code is SIDEBAND_FATAL and message preserved', () => {
      // Arrange & Act
      const sut = sidebandFatal('repo not found');

      // Assert
      expect(sut.data).toEqual({ code: 'SIDEBAND_FATAL', message: 'repo not found' });
    });

    it('Given unknownAckStatus("bogus"), When checking data, Then code is UNKNOWN_ACK_STATUS and value preserved', () => {
      // Arrange & Act
      const sut = unknownAckStatus('bogus');

      // Assert
      expect(sut.data).toEqual({ code: 'UNKNOWN_ACK_STATUS', value: 'bogus' });
    });

    it('Given invalidReportStatus("weird"), When checking data, Then code is INVALID_REPORT_STATUS and line preserved', () => {
      // Arrange & Act
      const sut = invalidReportStatus('weird');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_REPORT_STATUS', line: 'weird' });
    });

    it('Given emptyWants(), When checking data, Then code is EMPTY_WANTS', () => {
      // Arrange & Act
      const sut = emptyWants();

      // Assert
      expect(sut.data).toEqual({ code: 'EMPTY_WANTS' });
    });

    it('Given emptyReceiveUpdates(), When checking data, Then code is EMPTY_RECEIVE_UPDATES', () => {
      // Arrange & Act
      const sut = emptyReceiveUpdates();

      // Assert
      expect(sut.data).toEqual({ code: 'EMPTY_RECEIVE_UPDATES' });
    });

    it('Given tooManyAdvertisedRefs(count, limit), When checking data, Then code, count, and limit are preserved', () => {
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
    ];

    it.each(
      cases,
    )('Given protocol error %j, When TsgitError(...).message is read, Then it equals the documented format', (data, expected) => {
      // Arrange & Act
      const sut = new TsgitError(data);

      // Assert
      expect(sut.message).toBe(expected);
    });

    it.each(
      cases,
    )('Given protocol error %j, When checking .data.code, Then it strictly equals the variant literal', (data) => {
      // Arrange & Act
      const sut = new TsgitError(data);

      // Assert
      expect(sut.data.code).toBe(data.code);
    });
  });
});
