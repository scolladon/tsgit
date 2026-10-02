import { cleanFilterFailed } from '../../../domain/commands/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { CommandRunner } from '../../../ports/command-runner.js';
import type { Context } from '../../../ports/context.js';
import type { FilterChoice } from '../resolve-filter-driver.js';
import { type FilterDriverResult, runFilterDriver } from '../run-filter-driver.js';

/** The outcome of a driver that configures no clean command: nothing ran. */
const NOTHING_RAN = { ok: false, exitCode: undefined } as const;

const runCleanCommand = (
  ctx: Context,
  runner: CommandRunner,
  command: string | undefined,
  bytes: Uint8Array,
): Promise<FilterDriverResult | typeof NOTHING_RAN> =>
  command === undefined || command === ''
    ? Promise.resolve(NOTHING_RAN)
    : runFilterDriver(ctx, runner, command, bytes);

/**
 * git's `convert_to_git` clean step for a resolved driver. An empty or absent
 * clean command runs nothing; a required driver then dies exactly as when its
 * command fails (`<path>: clean filter '<d>' failed`), while an optional one
 * keeps the raw bytes either way.
 */
export const applyCleanFilter = async (
  ctx: Context,
  runner: CommandRunner,
  path: FilePath,
  bytes: Uint8Array,
  choice: FilterChoice,
): Promise<Uint8Array> => {
  if (choice.kind !== 'external') return bytes;
  const result = await runCleanCommand(ctx, runner, choice.clean, bytes);
  if (result.ok) return result.bytes;
  if (choice.required) throw cleanFilterFailed(path, choice.name, result.exitCode);
  return bytes;
};
