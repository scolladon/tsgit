import { TsgitError } from '../error.js';

export type CommitGraphError =
  | { readonly code: 'INVALID_COMMIT_GRAPH_HEADER'; readonly reason: string }
  | { readonly code: 'INVALID_COMMIT_GRAPH_CHUNK'; readonly reason: string };

export const invalidCommitGraphHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_COMMIT_GRAPH_HEADER', reason });

export const invalidCommitGraphChunk = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_COMMIT_GRAPH_CHUNK', reason });
