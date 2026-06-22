import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';

const EMPTY = new Uint8Array(0);

/**
 * Run a textconv driver over `content` bytes, returning the transformed bytes.
 *
 * Per T-EXEC: writes the content to a temp file under `gitDir`, passes the path
 * as `argv[1]` (`${command} ${tmpPath}`), reads the result from `result.stdout`.
 * No stdin is sent to the driver. The temp file is always removed in a `finally`
 * block. The `suffix` parameter distinguishes old/new sides to avoid collisions
 * within one `materialiseOne` call.
 *
 * If `result.stdout` is undefined (defensive — real textconv always writes
 * stdout), an empty `Uint8Array` is returned.
 */
export const applyTextconv = async (
  ctx: Context,
  runner: CommandRunner,
  command: string,
  content: Uint8Array,
  suffix: string,
): Promise<Uint8Array> => {
  const tmpPath = `${ctx.layout.gitDir}/TEXTCONV_INPUT_${suffix}`;
  await ctx.fs.write(tmpPath, content);
  try {
    const result = await runner.run({
      command: `${command} ${tmpPath}`,
      cwd: ctx.layout.workDir,
      env: { GIT_DIR: ctx.layout.gitDir },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    return result.stdout ?? EMPTY;
  } finally {
    await ctx.fs.rm(tmpPath);
  }
};
