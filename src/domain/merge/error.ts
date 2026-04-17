import { TsgitError } from '../error.js';

export type MergeError =
  | { readonly code: 'INVALID_MERGE_TREE'; readonly reason: string }
  | { readonly code: 'INVALID_MERGE_INPUT'; readonly reason: string };

export const invalidMergeTree = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_MERGE_TREE', reason });

export const invalidMergeInput = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_MERGE_INPUT', reason });
