/**
 * The commit-graph a split write builds on: git's `prepare_commit_graph`
 * against the repository's own object directory — the single
 * `info/commit-graph` file when it loads, otherwise the chain's layers base
 * first, stopping at the first layer that does not.
 */
import type { CommitGraphLayer } from '../../../domain/commit/commit-graph.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphPath,
  commonGitDir,
} from '../path-layout.js';
import { readUtf8IfPresent } from './fs-probes.js';
import { parseLayerOrUndefined } from './read-commit-graph.js';

export interface LocalGraphLayer {
  /** The file's trailing checksum — the name a chain gives the layer. */
  readonly hash: ObjectId;
  readonly path: string;
  readonly layer: CommitGraphLayer;
}

const isAbsent = (error: unknown): boolean => {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
};

async function readIfPresent(ctx: Context, path: string): Promise<Uint8Array | undefined> {
  try {
    return await ctx.fs.read(path);
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

async function loadLayerFile(ctx: Context, path: string): Promise<LocalGraphLayer | undefined> {
  const bytes = await readIfPresent(ctx, path);
  const layer = bytes === undefined ? undefined : parseLayerOrUndefined(bytes);
  if (layer === undefined) return undefined;
  const hash = ObjectId.fromRaw(layer._bytes.subarray(layer._bytes.length - layer._hashLength));
  return { hash, path, layer };
}

async function loadChainLayers(ctx: Context, gitDir: string): Promise<readonly LocalGraphLayer[]> {
  const chainText = await readUtf8IfPresent(ctx.fs, commitGraphChainPath(gitDir));
  const hashes = (chainText ?? '').split('\n').filter((line) => line.length > 0);
  const layers: LocalGraphLayer[] = [];
  for (const hash of hashes) {
    const loaded = await loadLayerFile(ctx, commitGraphLayerPath(gitDir, hash));
    if (loaded === undefined) break;
    layers.push(loaded);
  }
  return layers;
}

export async function loadLocalCommitGraphLayers(
  ctx: Context,
): Promise<readonly LocalGraphLayer[]> {
  const gitDir = commonGitDir(ctx);
  const single = await loadLayerFile(ctx, commitGraphPath(gitDir));
  if (single !== undefined) return [single];
  return loadChainLayers(ctx, gitDir);
}
