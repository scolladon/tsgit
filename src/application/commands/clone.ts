import { remoteAdvertisesNoRefs, targetDirectoryNotEmpty } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { ZERO_OID } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Advertisement } from '../../domain/protocol/index.js';
import {
  formatObjectFilter,
  parseObjectFilter,
  remoteFilterUnsupported,
} from '../../domain/protocol/index.js';
import type { Context } from '../../ports/context.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
import { updateShallow } from '../primitives/shallow-file.js';
import { updateConfigEntries } from '../primitives/update-config.js';
import { bootstrapRepository } from './internal/bootstrap.js';
import { negotiateDiscovery, negotiatePackBytes } from './internal/fetch-negotiation.js';
import { type GitServiceSession, openGitSession } from './internal/git-service-session.js';
import { anonymizeRemoteUrl } from './internal/remote-url.js';
import {
  advertisesFilter,
  selectFetchCapabilities,
  uniqueRefOids,
} from './internal/upload-pack-client.js';

export interface CloneOptions {
  readonly url: string;
  readonly bare?: boolean;
  readonly initialBranch?: string;
  /**
   * Shallow clone depth. When set, sends `deepen N` and persists the
   * resulting shallow boundaries to `.git/shallow`.
   */
  readonly depth?: number;
  /**
   * Partial-clone object filter (`blob:none`, `blob:limit=<n>`, `tree:<n>`).
   * When set, the server omits the filtered objects, a promisor remote is
   * recorded in `.git/config`, and omitted objects are lazy-fetched on read.
   */
  readonly filter?: string;
}

export interface CloneResult {
  readonly path: FilePath;
  readonly head: RefName | undefined;
  readonly fetchedRefs: ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>;
}

/**
 * Clone a remote repository into `ctx.layout.workDir`.
 *
 * The SSRF URL guard is applied by the transport wrapper `openRepository`
 * installs (`wrapTransportValidator`, from `config.dnsResolver` /
 * `allowInsecure` / `allowPrivateNetworks`), not by `clone` itself — a blocked
 * URL is refused on the first transport request. Bootstraps a `.git` skeleton,
 * discovers refs via smart-HTTP v1, fetches the pack, writes it under
 * `.git/objects/pack/`, propagates remote refs into the local layout
 * (HEAD-tracked branch under `refs/heads/<branch>`, all branches under
 * `refs/remotes/origin/<branch>`, tags under `refs/tags/<tag>`), and
 * points `HEAD` at the remote's HEAD line.
 *
 * Working-tree materialization is.1 — out of scope here.
 *
 * Throws `TARGET_DIRECTORY_NOT_EMPTY` if `gitDir` already exists and
 * `REMOTE_ADVERTISES_NO_REFS` when discovery returns no refs.
 */
const CLONE_DISCOVER_OP = 'clone:discover';
const CLONE_WRITE_OBJECTS_OP = 'clone:write-objects';

export const clone = async (ctx: Context, opts: CloneOptions): Promise<CloneResult> => {
  if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
    throw targetDirectoryNotEmpty(ctx.layout.workDir as FilePath);
  }
  if (opts.url === '') throw remoteAdvertisesNoRefs();
  // Validate the filter spec up front — a bad `--filter` fails fast, before
  // any filesystem mutation or network round-trip. `formatObjectFilter`
  // canonicalises it for both the wire request and the persisted config.
  const filterSpec =
    opts.filter !== undefined ? formatObjectFilter(parseObjectFilter(opts.filter)) : undefined;
  ctx.progress.start(CLONE_DISCOVER_OP);
  try {
    const bootstrap = await bootstrapRepository(ctx, {
      initialBranch: opts.initialBranch ?? 'main',
      bare: opts.bare ?? false,
    });
    try {
      return await fetchAndPropagate(ctx, opts, bootstrap.gitDir, filterSpec);
    } catch (err) {
      // Bootstrap rolls itself back on its own error path; we mirror the
      // semantics for failures past that point so callers always get a clean
      // workspace on any clone failure.
      await ctx.fs.rmRecursive(ctx.layout.gitDir).catch(() => undefined);
      throw err;
    }
  } finally {
    ctx.progress.end(CLONE_DISCOVER_OP);
  }
};

const fetchAndPropagate = async (
  ctx: Context,
  opts: CloneOptions,
  gitDir: FilePath,
  filterSpec: string | undefined,
): Promise<CloneResult> => {
  const session = openGitSession(ctx, opts.url, 'git-upload-pack');
  try {
    return await negotiateAndWritePack(ctx, opts, gitDir, filterSpec, session);
  } finally {
    await session.close();
  }
};

const negotiateAndWritePack = async (
  ctx: Context,
  opts: CloneOptions,
  gitDir: FilePath,
  filterSpec: string | undefined,
  session: GitServiceSession,
): Promise<CloneResult> => {
  const discovery = await negotiateDiscovery(session);
  const advertisement = discovery.advertisement;
  if (advertisement.refs.length === 0) throw remoteAdvertisesNoRefs();
  // A filtered clone needs the server to advertise the `filter` capability;
  // fail before the pack POST when it does not.
  if (filterSpec !== undefined && !advertisesFilter(advertisement.capabilities)) {
    throw remoteFilterUnsupported();
  }
  const capabilities = selectFetchCapabilities(advertisement.capabilities);
  const wants = uniqueRefOids(advertisement.refs);
  const packResult = await fetchPack(
    ctx,
    (c, req) => negotiatePackBytes(c, session, discovery.version, req),
    {
      wants,
      haves: [],
      capabilities,
      progressOp: CLONE_WRITE_OBJECTS_OP,
      // Stryker disable next-line ConditionalExpression: equivalent — always-true ternary spreads `{ depth: opts.depth }`; `fetchPack` gates on `input.depth !== undefined`, so `depth: undefined` and the empty spread produce identical request bodies.
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      // A filtered clone sends the `filter` line and marks the pack promisor.
      ...(filterSpec !== undefined ? { filter: filterSpec, promisor: true } : {}),
    },
  );
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — with `shallow.length === 0`, `updateShallow` receives two empty arrays and short-circuits to `deleteIfPresent` on a freshly bootstrapped `.git` (no shallow file exists), so `>= 0`/always-true are indistinguishable from `> 0`. The killable `< 0`/always-false half is covered by the depth:1 shallow-success test.
  if (packResult.shallow.length > 0) {
    // Clone never sees `unshallow` (the local repo is empty until now), but
    // updateShallow handles a populated `unshallow` correctly — pass the
    // packResult array verbatim instead of dropping it.
    await updateShallow(ctx, {
      shallow: packResult.shallow,
      unshallow: packResult.unshallow,
    });
  }
  const reflogUrl = anonymizeRemoteUrl(opts.url);
  const fetchedRefs = await writeFetchedRefs(ctx, advertisement, reflogUrl);
  const head = await applyRemoteHead(ctx, advertisement, reflogUrl);
  await writeCloneConfig(ctx, opts.url, headTrackedBranch(advertisement), filterSpec);
  return { path: gitDir, head, fetchedRefs };
};

/**
 * Persist the clone's config, mirroring stock git:
 *
 *  - `[remote "origin"]` url + default fetch refspec — written for EVERY clone
 *    (without it, `fetch`/`pull` after a normal clone would have no remote URL).
 *  - `[branch "<head>"]` remote/merge upstream — written for non-detached clones
 *    (a detached clone has no head branch to track).
 *  - partial-clone extras (`repositoryformatversion = 1`, promisor, filter,
 *    `extensions.partialClone`) layered on top when a filter was applied.
 */
const writeCloneConfig = async (
  ctx: Context,
  url: string,
  headBranch: string | undefined,
  filterSpec: string | undefined,
): Promise<void> => {
  await updateConfigEntries(ctx, [
    { section: 'remote', subsection: 'origin', key: 'url', value: url },
    {
      section: 'remote',
      subsection: 'origin',
      key: 'fetch',
      value: '+refs/heads/*:refs/remotes/origin/*',
    },
    ...(headBranch !== undefined
      ? [
          { section: 'branch', subsection: headBranch, key: 'remote', value: 'origin' },
          {
            section: 'branch',
            subsection: headBranch,
            key: 'merge',
            value: `refs/heads/${headBranch}`,
          },
        ]
      : []),
    ...(filterSpec !== undefined
      ? [
          { section: 'core', key: 'repositoryformatversion', value: '1' },
          { section: 'remote', subsection: 'origin', key: 'promisor', value: 'true' },
          { section: 'remote', subsection: 'origin', key: 'partialclonefilter', value: filterSpec },
          { section: 'extensions', key: 'partialClone', value: 'origin' },
        ]
      : []),
  ]);
};

const writeFetchedRefs = async (
  ctx: Context,
  advertisement: Advertisement,
  reflogUrl: string,
): Promise<ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>> => {
  const headBranch = headTrackedBranch(advertisement);
  const written: Array<{ name: RefName; id: ObjectId }> = [];
  for (const ref of advertisement.refs) {
    if (ref.name === 'HEAD') continue;
    if (ref.name.startsWith('refs/heads/')) {
      const branch = ref.name.slice('refs/heads/'.length);
      const remoteRef = `refs/remotes/origin/${branch}` as RefName;
      await writeRef(ctx, remoteRef, ref.id, reflogUrl);
      written.push({ name: remoteRef, id: ref.id });
      // Stryker disable next-line ConditionalExpression: the left-operand mutant (`headBranch !== undefined` -> true) is equivalent — `branch` is `ref.name.slice(...)`, always a string, so `branch === headBranch` is `false` whenever `headBranch` is `undefined`, identical to the short-circuited original. The whole-condition mutants remain covered by the non-HEAD-branch tests.
      if (headBranch !== undefined && branch === headBranch) {
        const localRef = ref.name as RefName;
        await writeRef(ctx, localRef, ref.id, reflogUrl);
        written.push({ name: localRef, id: ref.id });
      }
      continue;
    }
    if (ref.name.startsWith('refs/tags/')) {
      const tagRef = ref.name as RefName;
      await writeRef(ctx, tagRef, ref.id, reflogUrl);
      written.push({ name: tagRef, id: ref.id });
      continue;
    }
    // Other namespaces (refs/notes/*, refs/pull/*, …) are skipped per the
    // ref-layout policy in design
    ctx.logger?.debug?.('clone: skipping unsupported ref namespace', { name: ref.name });
  }
  return written;
};

/**
 * Write a ref file and record its creation in the reflog. `recordRefUpdate`
 * self-gates: only default-loggable refs (heads, remotes) actually log; tags
 * are skipped under the default config.
 */
const writeRef = async (
  ctx: Context,
  name: RefName,
  id: ObjectId,
  reflogUrl: string,
): Promise<void> => {
  const refPath = `${ctx.layout.gitDir}/${name}`;
  await ctx.fs.writeUtf8(refPath, `${id}\n`);
  await recordRefUpdate(ctx, name, ZERO_OID, id, `clone: from ${reflogUrl}`);
};

const headTrackedBranch = (ad: Advertisement): string | undefined => {
  const symref = ad.capabilities.find((c) => c.startsWith('symref=HEAD:refs/heads/'));
  if (symref === undefined) return undefined;
  return symref.slice('symref=HEAD:refs/heads/'.length);
};

const applyRemoteHead = async (
  ctx: Context,
  advertisement: Advertisement,
  reflogUrl: string,
): Promise<RefName | undefined> => {
  const branch = headTrackedBranch(advertisement);
  // `advertisement.head` carries HEAD's oid in both the symref and the
  // detached case; it is the newId for the `.git/logs/HEAD` initial entry.
  const headOid = advertisement.head?.id;
  if (branch !== undefined) {
    const ref = `refs/heads/${branch}` as RefName;
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `ref: ${ref}\n`);
    await logClonedHead(ctx, headOid, reflogUrl);
    return ref;
  }
  // Detached HEAD — write the HEAD oid directly. The advertisement carries it
  // via head.id even when symref is missing (e.g., for a server that does not
  // expose the symref capability).
  if (advertisement.head !== undefined) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${advertisement.head.id}\n`);
    await logClonedHead(ctx, headOid, reflogUrl);
    return undefined;
  }
  return undefined;
};

/** Record the initial `.git/logs/HEAD` entry for a clone, when HEAD has an oid. */
const logClonedHead = async (
  ctx: Context,
  headOid: ObjectId | undefined,
  reflogUrl: string,
): Promise<void> => {
  if (headOid === undefined) return;
  await recordRefUpdate(ctx, 'HEAD' as RefName, ZERO_OID, headOid, `clone: from ${reflogUrl}`);
};
