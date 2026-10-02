import { textconvFailed } from '../../domain/commands/error.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';
import { getSpawnCwd } from './path-layout.js';

const EMPTY = new Uint8Array(0);
const TEMP_SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TEMP_SUFFIX_LENGTH = 6;

/** git's mks_tempfile_ts `XXXXXX_` stem: overlapping diffs over one path
 *  each stage their own file, so one's cleanup never deletes the other's. */
const randomTempStem = (): string => {
  let stem = '';
  for (let i = 0; i < TEMP_SUFFIX_LENGTH; i += 1) {
    stem += TEMP_SUFFIX_ALPHABET[Math.floor(Math.random() * TEMP_SUFFIX_ALPHABET.length)];
  }
  return stem;
};

/**
 * Run a textconv driver over `content` bytes, returning the transformed bytes.
 *
 * Per T-EXEC: writes the content to a temp file under `gitDir`, passes the path
 * as `argv[1]` (`${command} ${tmpPath}`), reads the result from `result.stdout`.
 * No stdin is sent to the driver. The temp file is always removed in a `finally`
 * block.
 *
 * `token` (e.g. `old_src_txt` or `new_dst_txt`) is derived from the change path
 * and side and names the temp file after a random stem, as git names its
 * `XXXXXX_<basename>` textconv temp file.
 *
 * A non-zero exit, or an empty command that cannot run, throws
 * `TEXTCONV_FAILED` — git's run_textconv errors and the diff dies.
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
  // git's start_command on an empty argv fails before any temp file exists.
  if (command === '') throw textconvFailed(command);
  const tmpPath = `${ctx.layout.gitDir}/TEXTCONV_INPUT_${randomTempStem()}_${token}`;
  await ctx.fs.write(tmpPath, content);
  try {
    const result = await runner.run({
      command: `${command} ${tmpPath}`,
      cwd: getSpawnCwd(ctx.layout),
      env: { GIT_DIR: ctx.layout.gitDir },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (result.exitCode !== 0) throw textconvFailed(command, result.exitCode);
    return result.stdout ?? EMPTY;
  } finally {
    await ctx.fs.rm(tmpPath);
  }
};
