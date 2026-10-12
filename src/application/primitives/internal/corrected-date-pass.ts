/**
 * How one commit-graph write treats corrected commit dates: git's
 * `write_generation_data` — `commitGraph.generationVersion` 2, or, for a split
 * layer over a base, whether that base's top layer carries GDA2 — then
 * `validate_mixed_generation_chain` over the chain the write loaded, which
 * trusts stored dates only when every layer serves them.
 */
import type { CommitGraphLayer } from '../../../domain/commit/commit-graph.js';
import type { CorrectedDatePass } from '../../../domain/commit/commit-graph-writer.js';
import type { Context } from '../../../ports/context.js';
import type { LocalGraphLayer } from './local-commit-graph-layers.js';
import { configuredGenerationVersion, GENERATION_DATA_VERSION } from './read-commit-graph.js';

export async function correctedDatePass(
  ctx: Context,
  chain: readonly LocalGraphLayer[],
  base: readonly LocalGraphLayer[],
): Promise<CorrectedDatePass> {
  const version = await configuredGenerationVersion(ctx);
  const servesDates = (layer: CommitGraphLayer): boolean =>
    version >= GENERATION_DATA_VERSION && layer._generationDataRange !== undefined;
  const top = base.at(-1);
  const writesDates =
    top === undefined ? version === GENERATION_DATA_VERSION : servesDates(top.layer);
  if (!writesDates) return 'skipped';
  return chain.every(({ layer }) => servesDates(layer)) ? 'trusted' : 'untrusted';
}
