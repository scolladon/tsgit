import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';

const EMPTY = new Uint8Array(0);

/**
 * Run a textconv driver over `content` bytes, returning the transformed bytes.
 *
 * Per T-EXEC: writes the content to a temp file under `gitDir`, passes the path
 * as `argv[1]` (`${command} ${tmpPath}`), reads the result from `result.stdout`.
 * No stdin is sent to the driver. The temp file is always removed in a `finally`
 * block.
 *
 * `token` is a unique-per-invocation string (e.g. `old_src_txt` or `new_dst_txt`)
 * derived from the change path and side. This prevents concurrent textconv
 * invocations across different files from clobbering each other's temp files.
 *
 * If `result.stdout` is undefined (defensive — real textconv always writes
 * stdout), an empty `Uint8Array` is returned.
 */
export const applyTextconv = async (
  ctx: Context,
  runner: CommandRunner,
  command: string,
  content: Uint8Array,
  token: string,
): Promise<Uint8Array> => {
  const tmpPath = `${ctx.layout.gitDir}/TEXTCONV_INPUT_${token}`;
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
