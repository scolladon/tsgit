import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { assertBigFileThresholdValid } from './repo-settings-gate.js';

/**
 * git's own default `core.bigFileThreshold` (512 MiB) — the boundary
 * `read_loose_object` streams a blob past rather than buffering it.
 * `readConfig` is lenient by design, so an absent OR malformed value both
 * resolve here.
 */
export const DEFAULT_BIG_FILE_THRESHOLD_BYTES = 512 * 1024 * 1024;

export const readBigFileThreshold = async (ctx: Context): Promise<number> =>
  (await readConfig(ctx)).core?.bigFileThreshold ?? DEFAULT_BIG_FILE_THRESHOLD_BYTES;

/**
 * git's `repo_settings_get_big_file_threshold` at one of its data sites: the
 * last entry, refused when malformed. Reads git does not gate stay on
 * {@link readBigFileThreshold}.
 */
export const readStrictBigFileThreshold = async (ctx: Context): Promise<number> => {
  await assertBigFileThresholdValid(ctx);
  return readBigFileThreshold(ctx);
};
