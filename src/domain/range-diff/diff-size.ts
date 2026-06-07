/**
 * git's `diffsize` (`range-diff.c`): the cost metric used to build the
 * assignment cost matrix — the number of lines a 3-context unified diff between
 * two texts emits (one per hunk header plus every context / `+` / `-` line). It
 * reuses the shared `computeHunks` grouper, so the count is exactly the unified
 * diff serializer's emission total (each hunk = its `@@` header + its body).
 */

import { computeHunks } from '../diff/index.js';

const CONTEXT_LINES = 3;
const encoder = new TextEncoder();

export const diffSize = (a: string, b: string): number =>
  computeHunks(encoder.encode(a), encoder.encode(b), CONTEXT_LINES).reduce(
    (total, hunk) => total + 1 + hunk.body.length, // one `@@` header + every body line
    0,
  );
