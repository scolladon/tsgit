import { remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './internal/config-read.js';
import { assertRepository } from './internal/repo-state.js';

export interface FetchOptions {
  readonly remote?: string;
  readonly refspecs?: ReadonlyArray<string>;
  readonly prune?: boolean;
}

export interface FetchResult {
  readonly remote: string;
  readonly url: string;
  readonly updatedRefs: ReadonlyArray<{
    readonly name: RefName;
    readonly oldId: ObjectId | undefined;
    readonly newId: ObjectId;
  }>;
}

/**
 * Fetch from a configured remote. Resolves the remote URL via `.git/config`,
 * runs the upload-pack discovery, computes wants, downloads the pack, writes
 * objects, and updates remote-tracking refs.
 *
 * v1 surface returns the remote name + URL after looking them up; the actual
 * transport-driven object fetch is wired in the integration layer.
 */
const FETCH_NEGOTIATE_OP = 'fetch:negotiate';

export const fetch = async (ctx: Context, opts: FetchOptions = {}): Promise<FetchResult> => {
  await assertRepository(ctx);
  // Phase 10 §6.2 — fetch:negotiate brackets the upload-pack negotiation
  // (config lookup today; full ls-refs + want/have negotiation in Phase 11).
  // fetch:write-objects comes online when the pack-write loop lands.
  ctx.progress.start(FETCH_NEGOTIATE_OP);
  try {
    const remoteName = opts.remote ?? 'origin';
    const config = await readConfig(ctx);
    const remote = config.remote?.get(remoteName);
    if (remote?.url === undefined) throw remoteNotConfigured(remoteName);
    return { remote: remoteName, url: remote.url, updatedRefs: [] };
  } finally {
    ctx.progress.end(FETCH_NEGOTIATE_OP);
  }
};
