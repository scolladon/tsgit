import type { ObjectId } from '../domain/objects/object-id.js';

/** Outcome of a promisor-remote lazy fetch (ADR-081). */
export interface PromisorFetchOutcome {
  /**
   * False when the repository has no promisor remote configured — the caller
   * (`readObject`) then falls through to its normal `OBJECT_NOT_FOUND`.
   */
  readonly attempted: boolean;
  /** Objects the caller asked for. */
  readonly requested: number;
  /** Objects that were missing locally and were fetched from the promisor. */
  readonly fetched: number;
}

/**
 * Capability for fetching objects that a partial clone omitted, from the
 * configured promisor remote. Wired onto `Context` by `openRepository` and
 * consumed by `readObject` on a miss — the dependency-inverting seam that lets
 * a primitive trigger a command-tier fetch without importing upward.
 */
export interface PromisorRemote {
  fetch(oids: ReadonlyArray<ObjectId>): Promise<PromisorFetchOutcome>;
}
