import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';

/** Discriminated result from running a clean/smudge filter driver. */
export type FilterDriverResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly exitCode: number };

/**
 * Run an external clean/smudge filter driver over stdin→stdout.
 *
 * Feeds `input` to the driver's stdin, captures stdout. No temp files.
 * The caller decides whether a non-zero exit is fatal (F3) or graceful (F4).
 */
export const runFilterDriver = async (
  ctx: Context,
  runner: CommandRunner,
  command: string,
  input: Uint8Array,
): Promise<FilterDriverResult> => {
  const { gitDir, workDir } = ctx.layout;
  const result = await runner.run({
    command,
    cwd: workDir,
    env: { GIT_DIR: gitDir },
    stdin: input,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  if (result.exitCode !== 0) {
    return { ok: false, exitCode: result.exitCode };
  }
  return { ok: true, bytes: result.stdout ?? new Uint8Array(0) };
};
