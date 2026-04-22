import { TsgitError } from '../error.js';
import type { ObjectId } from './object-id.js';

export { TsgitError } from '../error.js';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export type DomainObjectError =
  | { readonly code: 'INVALID_OBJECT_ID'; readonly value: string }
  | { readonly code: 'INVALID_OBJECT_HEADER'; readonly reason: string }
  | {
      readonly code: 'INVALID_TREE_ENTRY';
      readonly offset: number;
      readonly reason: string;
    }
  | { readonly code: 'INVALID_COMMIT'; readonly reason: string }
  | { readonly code: 'INVALID_TAG'; readonly reason: string }
  | { readonly code: 'INVALID_FILE_MODE'; readonly value: string }
  | {
      readonly code: 'INVALID_IDENTITY';
      readonly line: string;
      readonly reason: string;
    }
  | { readonly code: 'OBJECT_NOT_FOUND'; readonly id: ObjectId }
  | {
      readonly code: 'OBJECT_HASH_MISMATCH';
      readonly expected: ObjectId;
      readonly actual: ObjectId;
    }
  | {
      readonly code: 'UNEXPECTED_OBJECT_TYPE';
      readonly expected: ObjectType;
      readonly actual: ObjectType;
      readonly id: ObjectId;
    }
  | { readonly code: 'TREE_CYCLE_DETECTED'; readonly id: ObjectId }
  | { readonly code: 'TREE_DEPTH_EXCEEDED'; readonly depth: number }
  | {
      readonly code: 'TREE_ENTRY_LIMIT_EXCEEDED';
      readonly count: number;
      readonly limit: number;
    };

export const invalidObjectId = (value: string): TsgitError =>
  new TsgitError({ code: 'INVALID_OBJECT_ID', value });

export const invalidObjectHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_OBJECT_HEADER', reason });

export const invalidTreeEntry = (offset: number, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_TREE_ENTRY', offset, reason });

export const invalidCommit = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_COMMIT', reason });

export const invalidTag = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_TAG', reason });

export const invalidFileMode = (value: string): TsgitError =>
  new TsgitError({ code: 'INVALID_FILE_MODE', value });

export const invalidIdentity = (line: string, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_IDENTITY', line, reason });

export const objectNotFound = (id: ObjectId): TsgitError =>
  new TsgitError({ code: 'OBJECT_NOT_FOUND', id });

export const objectHashMismatch = (expected: ObjectId, actual: ObjectId): TsgitError =>
  new TsgitError({ code: 'OBJECT_HASH_MISMATCH', expected, actual });

export const unexpectedObjectType = (
  expected: ObjectType,
  actual: ObjectType,
  id: ObjectId,
): TsgitError => new TsgitError({ code: 'UNEXPECTED_OBJECT_TYPE', expected, actual, id });

export const treeCycleDetected = (id: ObjectId): TsgitError =>
  new TsgitError({ code: 'TREE_CYCLE_DETECTED', id });

export const treeDepthExceeded = (depth: number): TsgitError =>
  new TsgitError({ code: 'TREE_DEPTH_EXCEEDED', depth });

export const treeEntryLimitExceeded = (count: number, limit: number): TsgitError =>
  new TsgitError({ code: 'TREE_ENTRY_LIMIT_EXCEEDED', count, limit });
