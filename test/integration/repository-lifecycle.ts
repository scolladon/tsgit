/**
 * Repository lifecycle for integration suites.
 *
 * Kept apart from `interop-helpers.ts` on purpose: that module's concern is
 * spawning canonical `git` with a scrubbed environment, this one's is owning
 * the lifetime of the repositories a suite opens. Nothing here spawns git.
 *
 * **Why a suite cannot just open and walk away.** A `Repository` holds one
 * `FileHandle` per pack for the whole of its life — `pack-registry.ts` keeps
 * them open so a delta-chain walk costs one `open` for the pack rather than
 * one per hop — and `dispose()` is what releases them. A test that opens a
 * repository and never disposes it therefore strands a descriptor per pack it
 * touched.
 *
 * The strand is invisible until the garbage collector reaches the handle, and
 * that is what makes it worth centralising. Node raises
 * `ERR_INVALID_STATE` ("A FileHandle object was closed during garbage
 * collection") from whichever test happens to be running when the collector
 * fires — never the test that leaked it, and not necessarily even the same
 * file. Attributing such a report to the file it names sends you to a suite
 * that is entirely innocent.
 *
 * Two properties make the tracker below sufficient where a per-call
 * `try/finally` is not:
 *
 *   1. the array holds a live reference, so a tracked repository stays
 *      reachable and the collector cannot reach its handles mid-run at all;
 *   2. `afterAll` then closes them explicitly, before the worker moves on.
 *
 * Disposal is idempotent (`repository.ts` short-circuits on `DISPOSED`), so a
 * suite that also disposes a repository at its own call site stays correct and
 * keeps documenting that intent.
 */
import { afterAll } from 'vitest';

import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import { type OpenNodeRepositoryOptions, openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import type { Repository } from '../../src/repository.js';

/** Opens a repository whose disposal the suite no longer has to carry. */
export type TrackedOpener = (opts?: OpenNodeRepositoryOptions) => Promise<Repository>;

/**
 * Registers the suite's disposal hook and returns its opener. Call once at a
 * test file's top level and use the result in place of `openRepository`.
 */
export const trackedRepositories = (): TrackedOpener => {
  const opened: Repository[] = [];

  afterAll(async () => {
    // Every repository is disposed even when one of them faults, and the
    // first fault still surfaces: a teardown defect is a real finding, and
    // swallowing it here would hide it behind the suite it broke.
    const failures: unknown[] = [];
    for (const repo of opened.splice(0)) {
      try {
        await repo.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  });

  return async (opts: OpenNodeRepositoryOptions = {}): Promise<Repository> => {
    const repo = await openRepository(opts);
    opened.push(repo);
    return repo;
  };
};

/**
 * The same discipline for suites that build a bare `Context` through
 * `createNodeContext` instead of opening a repository.
 *
 * A context has no owner to dispose it — `openRepository`'s `dispose()` is
 * what normally reaches the pack registry — so a suite that reads a packed
 * object through a raw context strands exactly the handles described above,
 * with no lifecycle hook of its own to release them. `disposePackRegistry` is
 * the seam: it closes the session's handles and creates nothing when the
 * session never touched a pack.
 *
 * Wraps the factory rather than the context so a call site changes by name
 * only, and keeps the returned contexts reachable for the same reason the
 * repository tracker does.
 */
export const trackedContexts = <Args extends readonly unknown[]>(
  create: (...args: Args) => Context,
): ((...args: Args) => Context) => {
  const created: Context[] = [];

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const ctx of created.splice(0)) {
      try {
        await disposePackRegistry(ctx);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  });

  return (...args: Args): Context => {
    const ctx = create(...args);
    created.push(ctx);
    return ctx;
  };
};
