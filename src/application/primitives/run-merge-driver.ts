import { substituteDriverPlaceholders } from '../../domain/attributes/index.js';
import type { ContentMergeResult } from '../../domain/merge/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';

/** git's default conflict-marker length (`%L`). The per-file override is a follow-up. */
const DEFAULT_MARKER_SIZE = 7;

const EMPTY = new Uint8Array(0);

export interface MergeDriverInput {
  /** The configured driver command line, with `%O %A %B %L %P` placeholders. */
  readonly command: string;
  /** Ancestor (`%O`) content; `undefined` for an add/add merge — written as an empty file. */
  readonly base: Uint8Array | undefined;
  /** Ours (`%A`) content — seeded into the output file the driver overwrites. */
  readonly ours: Uint8Array;
  /** Theirs (`%B`) content. */
  readonly theirs: Uint8Array;
  /** The repo-relative pathname (`%P`). */
  readonly path: FilePath;
}

/**
 * Run an external merge driver: write the three versions to temp files under
 * `gitDir`, substitute the placeholders (the output file is the seeded `ours`
 * copy), run the command via the `CommandRunner`, then read the output back.
 * Exit `0` ⇒ clean; non-zero ⇒ the driver left an unresolved conflict. Temp
 * files are always removed.
 *
 * Temp names are fixed: tsgit drives content merges one path at a time
 * (`mergeTrees` awaits each), so there is no concurrent driver invocation to
 * collide with.
 */
export const runMergeDriver = async (
  ctx: Context,
  runner: CommandRunner,
  input: MergeDriverInput,
): Promise<ContentMergeResult> => {
  const { gitDir, workDir } = ctx.layout;
  const oPath = `${gitDir}/MERGE_DRIVER_O`;
  const aPath = `${gitDir}/MERGE_DRIVER_A`;
  const bPath = `${gitDir}/MERGE_DRIVER_B`;
  await Promise.all([
    ctx.fs.write(oPath, input.base ?? EMPTY),
    ctx.fs.write(aPath, input.ours),
    ctx.fs.write(bPath, input.theirs),
  ]);
  try {
    const command = substituteDriverPlaceholders(input.command, {
      O: oPath,
      A: aPath,
      B: bPath,
      L: String(DEFAULT_MARKER_SIZE),
      P: input.path,
    });
    const { exitCode } = await runner.run({
      command,
      cwd: workDir,
      env: { GIT_DIR: gitDir },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const merged = await ctx.fs.read(aPath);
    return exitCode === 0
      ? { status: 'clean', bytes: merged }
      : { status: 'conflict', conflictType: 'content', markedBytes: merged };
  } finally {
    await Promise.all([ctx.fs.rm(oPath), ctx.fs.rm(aPath), ctx.fs.rm(bPath)]);
  }
};
