import { remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './internal/config-read.js';
import { assertRepository } from './internal/repo-state.js';

export interface PushOptions {
  readonly remote?: string;
  readonly refspecs?: ReadonlyArray<string>;
  readonly force?: boolean;
  readonly forceWithLease?: ObjectId | 'auto';
}

export interface PushResult {
  readonly remote: string;
  readonly url: string;
  readonly pushedRefs: ReadonlyArray<{
    readonly name: RefName;
    readonly newId: ObjectId;
    readonly status: 'ok' | 'rejected';
  }>;
}

/**
 * Push local refs to a remote. Resolves the remote URL via `.git/config`,
 * negotiates with `git-receive-pack`, builds + sends a pack, and reports
 * per-ref status.
 *
 * v1 surface returns the remote/url after lookup; pack send + receive-pack
 * negotiation lives in the integration layer.
 */
const PUSH_ENUMERATE_OBJECTS_OP = 'push:enumerate-objects';

export const push = async (ctx: Context, opts: PushOptions = {}): Promise<PushResult> => {
  await assertRepository(ctx);
  // Phase 10 §6.2 — push:enumerate-objects brackets remote URL resolution +
  // (eventually) the want-object walk that determines what to send. push:upload
  // (byte-granularity at 65536) comes online with the actual pack send in
  // Phase 11+.
  ctx.progress.start(PUSH_ENUMERATE_OBJECTS_OP);
  try {
    const remoteName = opts.remote ?? 'origin';
    const config = await readConfig(ctx);
    const remote = config.remote?.get(remoteName);
    if (remote?.url === undefined) throw remoteNotConfigured(remoteName);
    return { remote: remoteName, url: remote.url, pushedRefs: [] };
  } finally {
    ctx.progress.end(PUSH_ENUMERATE_OBJECTS_OP);
  }
};
