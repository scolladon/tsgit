import { TsgitError } from '../error.js';

export type DiffError =
  | { readonly code: 'INVALID_TREE_FOR_DIFF'; readonly reason: string }
  | { readonly code: 'INVALID_DIFF_INPUT'; readonly reason: string };

export const invalidTreeForDiff = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_TREE_FOR_DIFF', reason });

export const invalidDiffInput = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_DIFF_INPUT', reason });
