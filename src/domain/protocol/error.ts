import { TsgitError } from '../error.js';

export type ProtocolError =
  | { readonly code: 'INVALID_PKT_LENGTH'; readonly value: string }
  | { readonly code: 'PKT_LENGTH_RESERVED'; readonly value: number }
  | { readonly code: 'PKT_TOO_LARGE'; readonly value: number }
  | { readonly code: 'PKT_TRUNCATED'; readonly remaining: number }
  | { readonly code: 'INVALID_BASE_URL'; readonly reason: string }
  | {
      readonly code: 'MISSING_SERVICE_HEADER';
      readonly expected: string;
      readonly actual: string;
    }
  | { readonly code: 'MISSING_CAPABILITIES' }
  | { readonly code: 'INVALID_REF_LINE'; readonly line: string }
  | { readonly code: 'DUPLICATE_REF'; readonly name: string }
  | { readonly code: 'INVALID_SIDEBAND_CHANNEL'; readonly channel: number }
  | { readonly code: 'SIDEBAND_FATAL'; readonly message: string }
  | { readonly code: 'UNKNOWN_ACK_STATUS'; readonly value: string }
  | { readonly code: 'INVALID_REPORT_STATUS'; readonly line: string }
  | { readonly code: 'EMPTY_WANTS' }
  | { readonly code: 'EMPTY_RECEIVE_UPDATES' }
  | { readonly code: 'REFSPEC_INVALID'; readonly raw: string; readonly reason: string }
  | { readonly code: 'TOO_MANY_ADVERTISED_REFS'; readonly count: number; readonly limit: number }
  | { readonly code: 'INVALID_FILTER_SPEC'; readonly spec: string; readonly reason: string }
  | { readonly code: 'REMOTE_FILTER_UNSUPPORTED' };

export const invalidPktLength = (value: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PKT_LENGTH', value });

export const pktLengthReserved = (value: number): TsgitError =>
  new TsgitError({ code: 'PKT_LENGTH_RESERVED', value });

export const pktTooLarge = (value: number): TsgitError =>
  new TsgitError({ code: 'PKT_TOO_LARGE', value });

export const pktTruncated = (remaining: number): TsgitError =>
  new TsgitError({ code: 'PKT_TRUNCATED', remaining });

export const invalidBaseUrl = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_BASE_URL', reason });

export const missingServiceHeader = (expected: string, actual: string): TsgitError =>
  new TsgitError({ code: 'MISSING_SERVICE_HEADER', expected, actual });

export const missingCapabilities = (): TsgitError =>
  new TsgitError({ code: 'MISSING_CAPABILITIES' });

export const invalidRefLine = (line: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REF_LINE', line });

export const duplicateRef = (name: string): TsgitError =>
  new TsgitError({ code: 'DUPLICATE_REF', name });

export const invalidSidebandChannel = (channel: number): TsgitError =>
  new TsgitError({ code: 'INVALID_SIDEBAND_CHANNEL', channel });

export const sidebandFatal = (message: string): TsgitError =>
  new TsgitError({ code: 'SIDEBAND_FATAL', message });

export const unknownAckStatus = (value: string): TsgitError =>
  new TsgitError({ code: 'UNKNOWN_ACK_STATUS', value });

export const invalidReportStatus = (line: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REPORT_STATUS', line });

export const emptyWants = (): TsgitError => new TsgitError({ code: 'EMPTY_WANTS' });

export const emptyReceiveUpdates = (): TsgitError =>
  new TsgitError({ code: 'EMPTY_RECEIVE_UPDATES' });

export const refspecInvalid = (raw: string, reason: string): TsgitError =>
  new TsgitError({ code: 'REFSPEC_INVALID', raw, reason });

export const tooManyAdvertisedRefs = (count: number, limit: number): TsgitError =>
  new TsgitError({ code: 'TOO_MANY_ADVERTISED_REFS', count, limit });

export const invalidFilterSpec = (spec: string, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_FILTER_SPEC', spec, reason });

export const remoteFilterUnsupported = (): TsgitError =>
  new TsgitError({ code: 'REMOTE_FILTER_UNSUPPORTED' });
