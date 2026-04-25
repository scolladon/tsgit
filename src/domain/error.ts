import type { DiffError } from './diff/error.js';
import type { IndexError } from './git-index/error.js';
import type { MergeError } from './merge/error.js';
import type { DomainObjectError } from './objects/error.js';
import type { ProtocolError } from './protocol/error.js';
import type { RefsError } from './refs/error.js';
import type { StorageError } from './storage/error.js';

export type AdapterError =
  | { readonly code: 'FILE_NOT_FOUND'; readonly path: string }
  | { readonly code: 'FILE_EXISTS'; readonly path: string }
  | { readonly code: 'NOT_A_DIRECTORY'; readonly path: string }
  | { readonly code: 'PERMISSION_DENIED'; readonly path: string }
  | {
      readonly code: 'UNSUPPORTED_OPERATION';
      readonly operation: string;
      readonly reason: string;
    }
  | { readonly code: 'HASH_FAILED'; readonly reason: string }
  | { readonly code: 'COMPRESS_FAILED'; readonly reason: string }
  | { readonly code: 'DECOMPRESS_FAILED'; readonly reason: string }
  | { readonly code: 'HTTP_ERROR'; readonly statusCode: number; readonly reason: string }
  | { readonly code: 'NETWORK_ERROR'; readonly reason: string };

/** Cross-cutting application-tier codes raised by Phase 7 primitives (not adapters). */
export type ApplicationError =
  | { readonly code: 'INVALID_WALK_INPUT'; readonly reason: string }
  | { readonly code: 'OPERATION_ABORTED' };

export type TsgitErrorData =
  | DomainObjectError
  | StorageError
  | RefsError
  | IndexError
  | AdapterError
  | DiffError
  | MergeError
  | ApplicationError
  | ProtocolError;

export class TsgitError extends Error {
  override readonly name = 'TsgitError';

  constructor(readonly data: TsgitErrorData) {
    super(`${data.code}: ${extractDetail(data)}`);
  }
}

/** @internal */
export function basename(path: string): string {
  const segments = path.split(/[/\\]/);
  // equivalent-mutant: starting `i` at `segments.length + 1` (instead of -1) just performs
  // extra `segments[i] === undefined` skips before landing on the same real index, so the
  // returned value is identical for every input.
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && segment !== '') {
      return segment;
    }
  }
  return path;
}

export const fileNotFound = (path: string): TsgitError =>
  new TsgitError({ code: 'FILE_NOT_FOUND', path });

export const fileExists = (path: string): TsgitError =>
  new TsgitError({ code: 'FILE_EXISTS', path });

export const notADirectory = (path: string): TsgitError =>
  new TsgitError({ code: 'NOT_A_DIRECTORY', path });

export const permissionDenied = (path: string): TsgitError =>
  new TsgitError({ code: 'PERMISSION_DENIED', path });

export const unsupportedOperation = (operation: string, reason: string): TsgitError =>
  new TsgitError({ code: 'UNSUPPORTED_OPERATION', operation, reason });

export const hashFailed = (reason: string): TsgitError =>
  new TsgitError({ code: 'HASH_FAILED', reason });

export const compressFailed = (reason: string): TsgitError =>
  new TsgitError({ code: 'COMPRESS_FAILED', reason });

export const decompressFailed = (reason: string): TsgitError =>
  new TsgitError({ code: 'DECOMPRESS_FAILED', reason });

export const httpError = (statusCode: number, reason: string): TsgitError =>
  new TsgitError({ code: 'HTTP_ERROR', statusCode, reason });

export const networkError = (reason: string): TsgitError =>
  new TsgitError({ code: 'NETWORK_ERROR', reason });

export const invalidWalkInput = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_WALK_INPUT', reason });

export const operationAborted = (): TsgitError => new TsgitError({ code: 'OPERATION_ABORTED' });

function extractDetail(data: TsgitErrorData): string {
  switch (data.code) {
    case 'INVALID_OBJECT_ID':
    case 'INVALID_FILE_MODE':
      return data.value;
    case 'INVALID_OBJECT_HEADER':
    case 'INVALID_TREE_ENTRY':
    case 'INVALID_COMMIT':
    case 'INVALID_TAG':
    case 'INVALID_IDENTITY':
    case 'INVALID_PACK_HEADER':
    case 'INVALID_PACK_INDEX':
    case 'INVALID_PACK_ENTRY':
    case 'INVALID_DELTA':
    case 'INVALID_REF':
    case 'INVALID_PACKED_REFS':
    case 'INVALID_INDEX_HEADER':
    case 'INVALID_INDEX_ENTRY':
      return data.reason;
    case 'FILE_NOT_FOUND':
      return `file not found: ${basename(data.path)}`;
    case 'FILE_EXISTS':
      return `file already exists: ${basename(data.path)}`;
    case 'NOT_A_DIRECTORY':
      return `not a directory: ${basename(data.path)}`;
    case 'PERMISSION_DENIED':
      return `permission denied: ${basename(data.path)}`;
    case 'UNSUPPORTED_OPERATION':
      return `unsupported operation: ${data.operation}: ${data.reason}`;
    case 'HASH_FAILED':
      return `hash computation failed: ${data.reason}`;
    case 'COMPRESS_FAILED':
      return `compression failed: ${data.reason}`;
    case 'DECOMPRESS_FAILED':
      return `decompression failed: ${data.reason}`;
    case 'HTTP_ERROR':
      return `HTTP ${data.statusCode}: ${data.reason}`;
    case 'NETWORK_ERROR':
      return `network error: ${data.reason}`;
    case 'INVALID_TREE_FOR_DIFF':
      return `invalid tree for diff: ${data.reason}`;
    case 'INVALID_DIFF_INPUT':
      return `invalid diff input: ${data.reason}`;
    case 'INVALID_MERGE_TREE':
      return `invalid merge tree: ${data.reason}`;
    case 'INVALID_MERGE_INPUT':
      return `invalid merge input: ${data.reason}`;
    case 'OBJECT_NOT_FOUND':
      return `object not found: ${data.id}`;
    case 'OBJECT_HASH_MISMATCH':
      return `object hash mismatch: expected=${data.expected} actual=${data.actual}`;
    case 'UNEXPECTED_OBJECT_TYPE':
      return `unexpected object type: expected=${data.expected} actual=${data.actual} id=${data.id}`;
    case 'TREE_CYCLE_DETECTED':
      return `tree cycle detected: ${data.id}`;
    case 'TREE_DEPTH_EXCEEDED':
      return `tree depth exceeded: ${data.depth}`;
    case 'TREE_ENTRY_LIMIT_EXCEEDED':
      return `tree entry limit exceeded: count=${data.count} limit=${data.limit}`;
    case 'DELTA_CHAIN_TOO_DEEP':
      return `delta chain too deep: ${data.depth}`;
    case 'REF_NOT_FOUND':
      return `ref not found: ${data.name}`;
    case 'REF_CHAIN_TOO_DEEP':
      return `ref chain too deep: depth=${data.depth} chain=${data.chain.join('->')}`;
    case 'REF_CYCLE_DETECTED':
      return `ref cycle detected: ${data.chain.join('->')}`;
    case 'REF_LOCKED':
      return `ref locked: ${data.name}`;
    case 'REF_UPDATE_CONFLICT':
      return `ref update conflict: name=${data.name} expected=${data.expected} actual=${data.actual}`;
    case 'INVALID_WALK_INPUT':
      return `invalid walk input: ${data.reason}`;
    case 'OPERATION_ABORTED':
      return 'operation aborted';
    case 'INVALID_PKT_LENGTH':
      return `invalid pkt-line length: ${data.value}`;
    case 'PKT_LENGTH_RESERVED':
      return `reserved pkt-line length: ${data.value}`;
    case 'PKT_TOO_LARGE':
      return `pkt-line too large: ${data.value} bytes (max 65520)`;
    case 'PKT_TRUNCATED':
      return `pkt-line truncated: ${data.remaining} bytes remaining`;
    case 'INVALID_BASE_URL':
      return `invalid base URL: ${data.reason}`;
    case 'MISSING_SERVICE_HEADER':
      return `missing service header: expected=${data.expected} actual=${data.actual}`;
    case 'MISSING_CAPABILITIES':
      return 'missing capabilities in advertisement';
    case 'INVALID_REF_LINE':
      return `invalid ref line: ${data.line}`;
    case 'DUPLICATE_REF':
      return `duplicate ref: ${data.name}`;
    case 'INVALID_SIDEBAND_CHANNEL':
      return `invalid sideband channel: ${data.channel}`;
    case 'SIDEBAND_FATAL':
      return `sideband fatal: ${data.message}`;
    case 'UNKNOWN_ACK_STATUS':
      return `unknown ack status: ${data.value}`;
    case 'INVALID_REPORT_STATUS':
      return `invalid report-status line: ${data.line}`;
    case 'EMPTY_WANTS':
      return 'upload-pack request has no wants';
    case 'EMPTY_RECEIVE_UPDATES':
      return 'receive-pack request has no updates';
    default: {
      const _exhaustive: never = data;
      return String(_exhaustive);
    }
  }
}
