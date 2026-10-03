/**
 * The changed-path Bloom settings a commit-graph write uses — git's
 * `write_commit_graph` setup: an existing graph's `BDAT` header (the top
 * layer's) carries its filters into the rewrite, numHashes and bitsPerEntry
 * included, its hash version too unless `commitGraph.changedPathsVersion`
 * names one; `enable` (git's `--changed-paths`) starts them from git's
 * defaults. Version 0 — also `commitGraph.readChangedPaths=false` — never
 * reads the stored header, so nothing is preserved.
 */
import {
  type BloomFilterSettings,
  DEFAULT_BLOOM_FILTER_SETTINGS,
} from '../../../domain/commit/bloom-filter.js';
import type { CommitGraphBloomSettings } from '../../../domain/commit/commit-graph.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../config-read.js';
import { assertValidBooleanConfig } from './boolean-config-guard.js';
import { configuredChangedPathsVersion } from './commit-graph-compatible.js';

/** `preserve` keeps whatever the existing graph carries; `enable` turns filters on regardless. */
export type ChangedPathsRequest = 'preserve' | 'enable';

const UNSPECIFIED_VERSION = -1;
const NOT_READ_VERSION = 0;

export async function resolveChangedPathsSettings(
  ctx: Context,
  stored: CommitGraphBloomSettings | undefined,
  request: ChangedPathsRequest,
): Promise<BloomFilterSettings | undefined> {
  const configured = await configuredChangedPathsVersion(ctx);
  if (configured === NOT_READ_VERSION) return undefined;
  if (stored === undefined && request === 'preserve') return undefined;
  const version = configured === UNSPECIFIED_VERSION && stored ? stored.hashVersion : configured;
  return {
    ...DEFAULT_BLOOM_FILTER_SETTINGS,
    hashVersion: version === 2 ? 2 : 1,
    numHashes: stored?.numHashes ?? DEFAULT_BLOOM_FILTER_SETTINGS.numHashes,
    bitsPerEntry: stored?.bitsPerEntry ?? DEFAULT_BLOOM_FILTER_SETTINGS.bitsPerEntry,
  };
}

/** `git commit-graph write`'s `commitGraph.changedPaths`: true enables, false is no override.
 *  Every entry is parsed, as git's config callback does. */
export async function changedPathsRequest(ctx: Context): Promise<ChangedPathsRequest> {
  await assertValidBooleanConfig(ctx, 'commitGraph', undefined, ['changedPaths']);
  const entry = await findLastEntry(ctx, 'commitGraph', 'changedPaths');
  if (entry === undefined) return 'preserve';
  if (entry.value === null) return 'enable';
  const parsed = parseGitBoolean(entry.value);
  return parsed.ok && parsed.value ? 'enable' : 'preserve';
}
