/**
 * Everything content-validation's audit needs from config, read the way git
 * reads it: ONE pass over `[fsck]` in file order, opening each
 * `fsck.skipList` at the entry that names it (neither kind of fault has
 * precedence over the other — the first one in the FILE kills the audit,
 * whether it is a severity word outside git's grammar or a list that cannot
 * be opened), plus `core.bigFileThreshold`, resolved with git's own default
 * when the repository leaves it unset.
 */

import type { FsckConfiguredSeverity, FsckSeverityTable } from '../../../../domain/fsck/index.js';
import type { Context } from '../../../../ports/context.js';
import { readConfig, readFsckConfigItems } from '../../../primitives/config-read.js';
import { readFsckSkipListNames } from './skip-list.js';

/**
 * git's own default `core.bigFileThreshold` (512 MiB) — the boundary
 * `read_loose_object` streams a blob past rather than buffering it.
 * `readConfig` is lenient by design, so an absent OR malformed value both
 * resolve here.
 */
export const DEFAULT_BIG_FILE_THRESHOLD_BYTES = 512 * 1024 * 1024;

/** Everything an audit takes from config. */
export interface FsckConfiguration {
  /** `fsck.<msg-id>` re-typings, keyed by the composed msg-id. */
  readonly severities: FsckSeverityTable;
  /** Every name the `fsck.skipList` entries hold, unioned. */
  readonly skipped: ReadonlySet<string>;
  /** `core.bigFileThreshold` in bytes, defaulted when unset or malformed. */
  readonly bigFileThreshold: number;
}

export const readFsckConfiguration = async (ctx: Context): Promise<FsckConfiguration> => {
  const severities = new Map<string, FsckConfiguredSeverity>();
  const skipped = new Set<string>();
  // The walk grades one entry per step, so the list this step opens is read
  // BEFORE the next entry is graded — which is what puts the two refusals in
  // file order rather than in a fixed order of our choosing.
  for (const item of await readFsckConfigItems(ctx)) {
    if (item.kind === 'severity') {
      severities.set(item.msgId, item.severity);
      continue;
    }
    for (const name of await readFsckSkipListNames(ctx, item.path)) skipped.add(name);
  }
  const { core } = await readConfig(ctx);
  const bigFileThreshold = core?.bigFileThreshold ?? DEFAULT_BIG_FILE_THRESHOLD_BYTES;
  return { severities, skipped, bigFileThreshold };
};
