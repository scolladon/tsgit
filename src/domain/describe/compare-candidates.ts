/**
 * Order describe candidates (git's `compare_pt`): nearest first (smallest depth),
 * breaking ties by discovery order in the date-ordered walk (earliest wins).
 */
import type { Candidate } from './types.js';

export const compareCandidates = (a: Candidate, b: Candidate): number => {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.foundOrder - b.foundOrder;
};
