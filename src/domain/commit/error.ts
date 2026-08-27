import { TsgitError } from '../error.js';
import type { ObjectId } from '../objects/index.js';

export type CommitGraphError =
  | { readonly code: 'INVALID_COMMIT_GRAPH_HEADER'; readonly reason: string }
  | { readonly code: 'INVALID_COMMIT_GRAPH_CHUNK'; readonly reason: string }
  | {
      readonly code: 'COMMIT_GRAPH_DATE_TOO_LARGE';
      readonly id: ObjectId;
      readonly committerDate: number;
      readonly limit: number;
    }
  | {
      readonly code: 'COMMIT_GRAPH_GENERATION_OVERFLOW';
      readonly id: ObjectId;
      readonly offset: number;
      readonly limit: number;
    };

export const invalidCommitGraphHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_COMMIT_GRAPH_HEADER', reason });

export const invalidCommitGraphChunk = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_COMMIT_GRAPH_CHUNK', reason });

/** A committer date at or past the 34-bit ceiling CDAT's genWord/dateWord split can encode. */
export const commitGraphDateTooLarge = (
  id: ObjectId,
  committerDate: number,
  limit: number,
): TsgitError => new TsgitError({ code: 'COMMIT_GRAPH_DATE_TOO_LARGE', id, committerDate, limit });

/**
 * A corrected-date offset past GDA2's plain (non-flagged) u32 range. Git
 * would emit the GENERATION_OVERFLOW_FLAG and a GDO2 chunk tsgit's reader
 * does not parse — refusing instead of writing a chunk tsgit itself would
 * read with reduced fidelity.
 */
export const commitGraphGenerationOverflow = (
  id: ObjectId,
  offset: number,
  limit: number,
): TsgitError => new TsgitError({ code: 'COMMIT_GRAPH_GENERATION_OVERFLOW', id, offset, limit });
