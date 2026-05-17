/**
 * Phase 12.2 — `fetch` command. Real upload-pack-driven body.
 *
 * Flow (see `docs/design/phase-12-2-fetch.md`):
 *   1. Resolve the remote name → URL via `.git/config`.
 *   2. Discover refs over smart-HTTP v1 (`info/refs?service=git-upload-pack`).
 *   3. Derive `haves` from the local commit graph reachable from
 *      `refs/remotes/<remote>/*` (capped at MAX_HAVES — ADR-010).
 *   4. POST `git-upload-pack` with `want` + `have` + `deepen` (when depth set)
 *      via the shared `fetchPack` primitive.
 *   5. If the server emitted shallow / unshallow lines, persist `.git/shallow`.
 *   6. Write each advertised ref to `refs/remotes/<remote>/<branch>` or
 *      `refs/tags/<tag>` atomically (ADR-011).
 *   7. If `prune: true`, delete `refs/remotes/<remote>/<branch>` refs the
 *      server no longer advertises (ADR-012). Local refs are never touched.
 *
 * Working-tree materialization is Phase 13.1; out of scope.
 */
import { remoteAdvertisesNoRefs, remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { AdvertisedRef, Advertisement } from '../../domain/protocol/index.js';
import type { Context } from '../../ports/context.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { updateShallow } from '../primitives/shallow-file.js';
import { MAX_HAVES, MAX_WALK_SEEDS } from '../primitives/types.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { readConfig } from './internal/config-read.js';
import { withDefaults } from './internal/network-pipeline.js';
import { assertRepository } from './internal/repo-state.js';
import {
  discoverRefs,
  selectFetchCapabilities,
  uniqueRefOids,
} from './internal/upload-pack-client.js';

export interface FetchOptions {
  readonly remote?: string;
  readonly refspecs?: ReadonlyArray<string>;
  readonly prune?: boolean;
  /** Shallow clone depth. Delegates to fetchPack's deepen path. */
  readonly depth?: number;
}

export interface FetchUpdate {
  readonly name: RefName;
  readonly oldId: ObjectId | undefined;
  readonly newId: ObjectId;
}

export interface FetchResult {
  readonly remote: string;
  readonly url: string;
  readonly updatedRefs: ReadonlyArray<FetchUpdate>;
  /** Refs deleted because the server no longer advertises them (prune semantics). */
  readonly prunedRefs: ReadonlyArray<RefName>;
  /** New shallow boundaries written to `.git/shallow` during this fetch. */
  readonly shallow: ReadonlyArray<ObjectId>;
  /** Commits that crossed the shallow → non-shallow boundary during this fetch. */
  readonly unshallow: ReadonlyArray<ObjectId>;
}

const FETCH_NEGOTIATE_OP = 'fetch:negotiate';
const FETCH_WRITE_OBJECTS_OP = 'fetch:write-objects';

export const fetch = async (ctx: Context, opts: FetchOptions = {}): Promise<FetchResult> => {
  await assertRepository(ctx);
  const remoteName = opts.remote ?? 'origin';
  const url = await resolveRemoteUrl(ctx, remoteName);

  ctx.progress.start(FETCH_NEGOTIATE_OP);
  try {
    const transport = withDefaults(
      ctx,
      ctx.config?.auth !== undefined ? { auth: ctx.config.auth } : {},
    );
    const advertisement = await discoverRefs(ctx, transport, url);
    if (advertisement.refs.length === 0) throw remoteAdvertisesNoRefs();

    const capabilities = selectFetchCapabilities(advertisement.capabilities);
    const wants = uniqueRefOids(advertisement.refs);
    const haves = await deriveHaves(ctx, remoteName);

    const packResult = await fetchPack(ctx, transport, {
      wants,
      haves,
      capabilities,
      url,
      progressOp: FETCH_WRITE_OBJECTS_OP,
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    });

    if (packResult.shallow.length > 0 || packResult.unshallow.length > 0) {
      await updateShallow(ctx, {
        shallow: packResult.shallow,
        unshallow: packResult.unshallow,
      });
    }

    const updatedRefs = await applyRemoteRefs(ctx, remoteName, advertisement);
    const prunedRefs = opts.prune === true ? await prune(ctx, remoteName, advertisement) : [];

    return {
      remote: remoteName,
      url,
      updatedRefs,
      prunedRefs,
      shallow: packResult.shallow,
      unshallow: packResult.unshallow,
    };
  } finally {
    ctx.progress.end(FETCH_NEGOTIATE_OP);
  }
};

const resolveRemoteUrl = async (ctx: Context, remoteName: string): Promise<string> => {
  const config = await readConfig(ctx);
  const remote = config.remote?.get(remoteName);
  if (remote?.url === undefined) throw remoteNotConfigured(remoteName);
  return remote.url;
};

/**
 * Collect haves from the local object graph (ADR-010). Strategy:
 *
 *   1. Read every loose ref tip under `refs/remotes/<remote>/` and
 *      `refs/tags/`. These tips ARE the first-class haves — the server uses
 *      them to filter the pack without needing their ancestors.
 *   2. Walk the commit graph from those tips (ignoring missing objects) and
 *      append the reachable commits in BFS order until `MAX_HAVES` is
 *      reached.
 *
 * A tip whose object is missing locally still gets sent as a have — the
 * server may ignore it, but if it happens to be the cut-point we want, this
 * keeps the negotiation honest.
 */
const deriveHaves = async (ctx: Context, remoteName: string): Promise<ReadonlyArray<ObjectId>> => {
  const seeds = await collectRefTips(ctx, [`refs/remotes/${remoteName}`, 'refs/tags']);
  if (seeds.length === 0) return [];
  const seen = new Set<string>();
  const haves: ObjectId[] = [];
  for (const tip of seeds) {
    if (seen.has(tip)) continue;
    seen.add(tip);
    haves.push(tip);
    if (haves.length >= MAX_HAVES) return haves;
  }
  const cappedSeeds = seeds.slice(0, MAX_WALK_SEEDS);
  for await (const commit of walkCommits(ctx, {
    from: cappedSeeds,
    ignoreMissing: true,
    verifyHash: false,
  })) {
    if (seen.has(commit.id)) continue;
    seen.add(commit.id);
    haves.push(commit.id);
    if (haves.length >= MAX_HAVES) break;
  }
  return haves;
};

const collectRefTips = async (
  ctx: Context,
  refDirs: ReadonlyArray<string>,
): Promise<ReadonlyArray<ObjectId>> => {
  const ids: ObjectId[] = [];
  for (const dir of refDirs) {
    const fullDir = `${ctx.layout.gitDir}/${dir}`;
    if (!(await ctx.fs.exists(fullDir))) continue;
    await collectFromDir(ctx, fullDir, ids);
  }
  return ids;
};

const collectFromDir = async (ctx: Context, dir: string, out: ObjectId[]): Promise<void> => {
  const entries = await ctx.fs.readdir(dir);
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectFromDir(ctx, path, out);
      continue;
    }
    const content = (await ctx.fs.readUtf8(path)).trim();
    if (isOid(content)) out.push(content as ObjectId);
  }
};

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const isOid = (s: string): boolean => OID_RE.test(s);

const applyRemoteRefs = async (
  ctx: Context,
  remoteName: string,
  advertisement: Advertisement,
): Promise<ReadonlyArray<FetchUpdate>> => {
  const updates: FetchUpdate[] = [];
  for (const ref of advertisement.refs) {
    const target = remoteTargetForRef(remoteName, ref);
    if (target === undefined) continue;
    const oldId = await readExistingRef(ctx, target);
    if (oldId === ref.id) {
      // No-op: ref already at the advertised oid. We still surface it in the
      // updatedRefs list so callers can distinguish "considered" from
      // "advanced" by comparing oldId === newId.
      updates.push({ name: target, oldId, newId: ref.id });
      continue;
    }
    await updateRef(ctx, target, ref.id);
    updates.push({ name: target, oldId, newId: ref.id });
  }
  return updates;
};

const remoteTargetForRef = (remoteName: string, ref: AdvertisedRef): RefName | undefined => {
  if (ref.name === 'HEAD') return undefined;
  if (ref.name.startsWith('refs/heads/')) {
    const branch = ref.name.slice('refs/heads/'.length);
    return `refs/remotes/${remoteName}/${branch}` as RefName;
  }
  if (ref.name.startsWith('refs/tags/')) {
    return ref.name as RefName;
  }
  return undefined;
};

const readExistingRef = async (ctx: Context, name: RefName): Promise<ObjectId | undefined> => {
  const path = `${ctx.layout.gitDir}/${name}`;
  if (!(await ctx.fs.exists(path))) return undefined;
  const content = (await ctx.fs.readUtf8(path)).trim();
  return isOid(content) ? (content as ObjectId) : undefined;
};

/**
 * Delete any `refs/remotes/<remote>/<branch>` ref whose `<branch>` is not
 * present in the advertisement's `refs/heads/*` set. Local refs
 * (`refs/heads/*`, `refs/tags/*`) are NEVER deleted. See ADR-012.
 */
const prune = async (
  ctx: Context,
  remoteName: string,
  advertisement: Advertisement,
): Promise<ReadonlyArray<RefName>> => {
  const advertisedBranches = new Set(
    advertisement.refs
      .filter((r) => r.name.startsWith('refs/heads/'))
      .map((r) => r.name.slice('refs/heads/'.length)),
  );
  const remoteDir = `${ctx.layout.gitDir}/refs/remotes/${remoteName}`;
  if (!(await ctx.fs.exists(remoteDir))) return [];
  const deleted: RefName[] = [];
  await deleteUnadvertised(ctx, remoteDir, '', advertisedBranches, remoteName, deleted);
  return deleted;
};

const deleteUnadvertised = async (
  ctx: Context,
  dir: string,
  prefix: string,
  advertised: ReadonlySet<string>,
  remoteName: string,
  deleted: RefName[],
): Promise<void> => {
  const entries = await ctx.fs.readdir(dir);
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const branch = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      await deleteUnadvertised(ctx, path, branch, advertised, remoteName, deleted);
      continue;
    }
    if (advertised.has(branch)) continue;
    const refName = `refs/remotes/${remoteName}/${branch}` as RefName;
    await updateRef(ctx, refName, '0'.repeat(40) as ObjectId, { delete: true });
    deleted.push(refName);
  }
};
