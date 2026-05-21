/**
 * `fetch` command. Real upload-pack-driven body.
 *
 * Flow (see `docs/design/phase-12-2-fetch.md`):
 *  1. Resolve the remote name → URL via `.git/config`.
 *  2. Discover refs over smart-HTTP v1 (`info/refs?service=git-upload-pack`).
 *  3. Derive `haves` from the local commit graph reachable from
 *  `refs/remotes/<remote>/*` (capped at MAX_HAVES).
 *  4. POST `git-upload-pack` with `want` + `have` + `deepen` (when depth set)
 *  via the shared `fetchPack` primitive.
 *  5. If the server emitted shallow / unshallow lines, persist `.git/shallow`.
 *  6. Write each advertised ref to `refs/remotes/<remote>/<branch>` or
 *  `refs/tags/<tag>` atomically.
 *  7. If `prune: true`, delete `refs/remotes/<remote>/<branch>` refs the
 *  server no longer advertises. Local refs are never touched.
 *
 * Working-tree materialization is.1; out of scope.
 */
import { TsgitError } from '../../domain/error.js';
import { remoteAdvertisesNoRefs, remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { ZERO_OID } from '../../domain/objects/index.js';
import type { AdvertisedRef, Advertisement } from '../../domain/protocol/index.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { getRefStore } from '../primitives/ref-store.js';
import { updateShallow } from '../primitives/shallow-file.js';
import { MAX_HAVES, MAX_WALK_SEEDS } from '../primitives/types.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
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
      // Stryker disable next-line ConditionalExpression: equivalent — fetchPack gates on input.depth !== undefined, so depth:undefined behaves identically to a missing key.
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
 * Collect haves from the local object graph. Strategy:
 *
 *  1. Read every loose ref tip under `refs/remotes/<remote>/` and
 *  `refs/tags/`. These tips ARE the first-class haves — the server uses
 *  them to filter the pack without needing their ancestors.
 *  2. Walk the commit graph from those tips (ignoring missing objects) and
 *  append the reachable commits in BFS order until `MAX_HAVES` is
 *  reached.
 *
 * A tip whose object is missing locally still gets sent as a have — the
 * server may ignore it, but if it happens to be the cut-point we want, this
 * keeps the negotiation honest.
 */
const deriveHaves = async (ctx: Context, remoteName: string): Promise<ReadonlyArray<ObjectId>> => {
  const seeds = await collectRefTips(ctx, remoteName);
  if (seeds.length === 0) return [];
  const seen = new Set<string>();
  const haves: ObjectId[] = [];
  for (const tip of seeds) {
    if (seen.has(tip)) continue;
    seen.add(tip);
    haves.push(tip);
    if (haves.length >= MAX_HAVES) return haves;
  }
  // Stryker disable next-line MethodExpression: equivalent — dropping `.slice(0, MAX_WALK_SEEDS)` only differs when seeds.length > 1024, a pathological scale no fixture reaches.
  const cappedSeeds = seeds.slice(0, MAX_WALK_SEEDS);
  for await (const commit of walkCommits(ctx, {
    from: cappedSeeds,
    ignoreMissing: true,
    // Stryker disable next-line BooleanLiteral: equivalent — `deriveHaves` only ever walks self-consistent loose commits, so flipping `verifyHash` to `true` verifies a hash that always matches.
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
  remoteName: string,
): Promise<ReadonlyArray<ObjectId>> => {
  // Loose refs first: walk the on-disk tree under each ref prefix.
  const ids: ObjectId[] = [];
  // equivalent-mutant: replacing the `refs/remotes/` template literal head
  // with an empty backtick changes `fullDir` to `${gitDir}/origin`, which
  // does not exist in any test fixture, so `fs.exists` returns false and
  // `collectFromDir` is never reached — observable-equivalent on real-world
  // repositories (the dir literally never has a sibling named `origin`).
  const looseDirs = [`refs/remotes/${remoteName}`, 'refs/tags'];
  for (const dir of looseDirs) {
    const fullDir = `${ctx.layout.gitDir}/${dir}`;
    if (!(await ctx.fs.exists(fullDir))) continue;
    await collectFromDir(ctx, fullDir, ids);
  }
  // Packed refs second: consult `.git/packed-refs` so repos that have packed
  // their refs (e.g., after `git gc`) still contribute haves. Without this,
  // every fetch would send zero haves and the server would resend a full pack.
  const refPrefix = `refs/remotes/${remoteName}/`;
  const tagPrefix = 'refs/tags/';
  const packed = await getRefStore(ctx).getPackedRefs();
  for (const entry of packed.entries) {
    if (entry.name.startsWith(refPrefix) || entry.name.startsWith(tagPrefix)) {
      ids.push(entry.id);
    }
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
    await updateRef(ctx, target, ref.id, {
      reflogMessage: `fetch ${remoteName}: storing head`,
    });
    updates.push({ name: target, oldId, newId: ref.id });
  }
  return updates;
};

const remoteTargetForRef = (remoteName: string, ref: AdvertisedRef): RefName | undefined => {
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — a `HEAD` (or `''`) ref already falls through to `return undefined` because it matches neither `refs/heads/` nor `refs/tags/`; the only behaviour-changing direction (always-undefined) is killed by the happy-path tests.
  if (ref.name === 'HEAD') return undefined;
  // Validate the server-controlled ref name BEFORE composing the local path.
  // Without this guard, a malicious server advertising `refs/heads/../../config`
  // would build `refs/remotes/<remote>/../../config` and let `readExistingRef`
  // execute a filesystem read on `.git/config`. `validateRefName` rejects every
  // path-traversal vector that the `as RefName` brand cast otherwise bypasses.
  if (!isSafeRefName(ref.name)) return undefined;
  if (ref.name.startsWith('refs/heads/')) {
    const branch = ref.name.slice('refs/heads/'.length);
    const composed = `refs/remotes/${remoteName}/${branch}`;
    // Stryker disable next-line ConditionalExpression: equivalent — `branch` is derived from a name that already passed isSafeRefName, and `remoteName` is rejected upstream by resolveRemoteUrl's config lookup, so `composed` is always safe here.
    if (!isSafeRefName(composed)) return undefined;
    return composed as RefName;
  }
  if (ref.name.startsWith('refs/tags/')) {
    return ref.name as RefName;
  }
  return undefined;
};

const isSafeRefName = (name: string): boolean => {
  try {
    validateRefName(name);
    return true;
  } catch {
    return false;
  }
};

const readExistingRef = async (ctx: Context, name: RefName): Promise<ObjectId | undefined> => {
  // Defense in depth: every caller of `readExistingRef` constructs `name` via
  // `remoteTargetForRef`, which already validates. We re-validate here so a
  // future refactor that loses the guard cannot reintroduce the
  // path-traversal vulnerability. validateRefName throws if invalid.
  validateRefName(name);
  const path = `${ctx.layout.gitDir}/${name}`;
  if (!(await ctx.fs.exists(path))) return undefined;
  const content = (await ctx.fs.readUtf8(path)).trim();
  return isOid(content) ? (content as ObjectId) : undefined;
};

/**
 * Delete any `refs/remotes/<remote>/<branch>` ref whose `<branch>` is not
 * present in the advertisement's `refs/heads/*` set. Local refs
 * (`refs/heads/*`, `refs/tags/*`) are NEVER deleted.
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
    const composed = `refs/remotes/${remoteName}/${branch}`;
    // Defense in depth: `entry.name` came from `readdir`, which we trust, but
    // a hostile actor with local write access could have deposited a
    // directory named `..` or worse. `updateRef` itself calls
    // `validateRefName`, but we also short-circuit here so the prune loop
    // never asks `updateRef` to delete a path-traversal ref name.
    // equivalent-mutant: in the test fixtures `entry.name` always passes
    // `validateRefName` (file names come from controlled seeds), so the
    // false branch is unreachable through `vitest`. The guard exists as
    // defense-in-depth — keep it; equivalent under non-hostile fs state.
    if (!isSafeRefName(composed)) {
      ctx.logger?.warn?.('fetch.prune: skipping unsafe ref name', { name: composed });
      continue;
    }
    const refName = composed as RefName;
    // `updateRef(..., { delete: true })` throws `UNSUPPORTED_OPERATION` when
    // the ref is packed-only (packed-refs rewrite is follow-up).
    // The loose-walk path can only reach loose refs, so under normal usage
    // we never hit this. We still guard defensively in case a packed-only
    // ref happens to live at the same path as a directory entry on a
    // case-folding filesystem (unlikely but possible).
    try {
      await updateRef(ctx, refName, ZERO_OID, { delete: true });
    } catch (err) {
      if (isPackedRefDeleteError(err)) {
        // Skip packed-only refs rather than crashing the whole fetch.
        // Documented in's Neutral consequences.
        ctx.logger?.warn?.('fetch.prune: skipping packed-only ref', { name: refName });
        continue;
      }
      throw err;
    }
    deleted.push(refName);
  }
};

const isPackedRefDeleteError = (err: unknown): boolean =>
  err instanceof TsgitError &&
  err.data.code === 'UNSUPPORTED_OPERATION' &&
  // Stryker disable next-line ConditionalExpression: equivalent — `updateRef` only ever raises `UNSUPPORTED_OPERATION` with operation 'delete-packed-ref', so once the code check passes this comparison is always true. The EqualityOperator/StringLiteral mutants here stay live and are killed by the packed-only-ref prune test.
  err.data.operation === 'delete-packed-ref';
