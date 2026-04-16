import type { IndexError } from './git-index/error.js';
import type { DomainObjectError } from './objects/error.js';
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

export type TsgitErrorData =
  | DomainObjectError
  | StorageError
  | RefsError
  | IndexError
  | AdapterError;

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
    default: {
      const _exhaustive: never = data;
      return String(_exhaustive);
    }
  }
}
