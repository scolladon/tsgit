import { smudgeFilterFailed } from '../../../domain/commands/error.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import type { CommandRunner } from '../../../ports/command-runner.js';
import type { Context } from '../../../ports/context.js';
import type { FilterChoice } from '../resolve-filter-driver.js';
import { type FilterDriverResult, runFilterDriver } from '../run-filter-driver.js';
import { pickFilterCommand } from './pick-filter-command.js';
import { runFilterProcess } from './run-filter-process.js';

/** The blob one smudge checks out. */
export interface SmudgeTarget {
  readonly path: FilePath;
  readonly blob: ObjectId;
  readonly bytes: Uint8Array;
}

type ExternalChoice = Extract<FilterChoice, { readonly kind: 'external' }>;
type SmudgeOutcome = FilterDriverResult | { readonly ok: false; readonly exitCode: undefined };

const NOTHING_RAN = { ok: false, exitCode: undefined } as const;

/**
 * git's `classify_conv_attrs`: a driver naming any `process`, `smudge` or
 * `clean` — even an empty one — is converted in core, where a required one
 * can die; a driver naming none streams the blob untouched.
 */
export const smudgesInCore = (choice: FilterChoice): choice is ExternalChoice =>
  choice.kind === 'external' &&
  (choice.process !== undefined || choice.smudge !== undefined || choice.clean !== undefined);

/** `apply_filter`'s pick: a set `process` shadows the `smudge` command. */
const runSmudgeCommand = (
  ctx: Context,
  runner: CommandRunner | undefined,
  { path, blob, bytes }: SmudgeTarget,
  choice: ExternalChoice,
): Promise<SmudgeOutcome> => {
  const picked = pickFilterCommand(choice.process, choice.smudge);
  // A context that cannot run commands cannot start the driver either.
  if (picked === undefined || runner === undefined) return Promise.resolve(NOTHING_RAN);
  if (picked.kind === 'process') {
    return runFilterProcess(ctx, runner, picked.command, {
      capability: 'smudge',
      path,
      bytes,
      blob,
    });
  }
  return runFilterDriver(ctx, runner, picked.command, bytes);
};

/**
 * git's `convert_to_working_tree` smudge step for a resolved driver: a
 * required driver that smudges nothing dies `<path>: smudge filter <d>
 * failed`, an optional one keeps the blob as stored.
 */
export const applySmudgeFilter = async (
  ctx: Context,
  runner: CommandRunner | undefined,
  target: SmudgeTarget,
  choice: FilterChoice,
): Promise<Uint8Array> => {
  if (!smudgesInCore(choice)) return target.bytes;
  const result = await runSmudgeCommand(ctx, runner, target, choice);
  if (result.ok) return result.bytes;
  if (choice.required) throw smudgeFilterFailed(target.path, choice.name, result.exitCode);
  return target.bytes;
};
