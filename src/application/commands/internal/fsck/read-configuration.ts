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
import { readFsckConfigItems } from '../../../primitives/config-read.js';
import { readBigFileThreshold } from '../../../primitives/internal/big-file-threshold.js';
import { readFsckSkipListNames } from './skip-list.js';

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
  const bigFileThreshold = await readBigFileThreshold(ctx);
  return { severities, skipped, bigFileThreshold };
};
