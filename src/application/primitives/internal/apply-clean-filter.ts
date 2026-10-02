import { cleanFilterFailed } from '../../../domain/commands/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { CommandRunner } from '../../../ports/command-runner.js';
import type { Context } from '../../../ports/context.js';
import type { FilterChoice } from '../resolve-filter-driver.js';
import { type FilterDriverResult, runFilterDriver } from '../run-filter-driver.js';
import { runFilterProcess } from './run-filter-process.js';

/** The outcome of a driver that configures no clean command: nothing ran. */
const NOTHING_RAN = { ok: false, exitCode: undefined } as const;

type CleanOutcome = FilterDriverResult | { readonly ok: false; readonly exitCode: undefined };

const isNamed = (command: string | undefined): command is string =>
  command !== undefined && command !== '';

/** `apply_filter`'s pick: a named `process` wins over a named `clean`. */
const runCleanCommand = (
  ctx: Context,
  runner: CommandRunner,
  { path, bytes, choice }: CleanRequest,
): Promise<CleanOutcome> => {
  if (isNamed(choice.process)) return runFilterProcess(ctx, runner, choice.process, path, bytes);
  if (isNamed(choice.clean)) return runFilterDriver(ctx, runner, choice.clean, bytes);
  return Promise.resolve(NOTHING_RAN);
};

interface CleanRequest {
  readonly path: FilePath;
  readonly bytes: Uint8Array;
  readonly choice: Extract<FilterChoice, { readonly kind: 'external' }>;
}

/**
 * git's `convert_to_git` clean step for a resolved driver. An empty or absent
 * process and clean command run nothing; a required driver then dies exactly as when its
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
  const result = await runCleanCommand(ctx, runner, { path, bytes, choice });
  if (result.ok) return result.bytes;
  if (choice.required) throw cleanFilterFailed(path, choice.name, result.exitCode);
  return bytes;
};
