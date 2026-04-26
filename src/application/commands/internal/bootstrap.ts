import type { FilePath, RefName } from '../../../domain/objects/object-id.js';
import { validateRefName } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';

interface BootstrapOptions {
  readonly initialBranch: string;
  readonly bare: boolean;
  readonly hash?: 'sha1';
}

interface BootstrapResult {
  readonly gitDir: FilePath;
  readonly initialBranch: RefName;
  readonly bare: boolean;
}

const INFO_EXCLUDE = `# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
# For a project mostly in C, the following would be a good set of
# exclude patterns (uncomment them if you want to use them):
# *.[oa]
# *~
`;

const DESCRIPTION = "Unnamed repository; edit this file 'description' to name the repository.\n";

const renderConfig = (bare: boolean): string =>
  `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${bare ? 'true' : 'false'}\n`;

/**
 * Create a fresh `.git` layout at `ctx.layout.gitDir`. Used by `init` and `clone`.
 *
 * On any I/O failure mid-bootstrap, the partially-created tree is removed via
 * `rmRecursive` so callers get either a complete repository or none.
 *
 * `initialBranch` is validated via `validateRefName` BEFORE any filesystem
 * mutation; an invalid value throws `INVALID_REF` cleanly without polluting
 * the working directory.
 */
export const bootstrapRepository = async (
  ctx: Context,
  opts: BootstrapOptions,
): Promise<BootstrapResult> => {
  const branch = validateRefName(opts.initialBranch);
  const gitDir = ctx.layout.gitDir;
  try {
    await ctx.fs.mkdir(gitDir);
    await ctx.fs.writeUtf8(`${gitDir}/HEAD`, `ref: refs/heads/${branch}\n`);
    await ctx.fs.writeUtf8(`${gitDir}/config`, renderConfig(opts.bare));
    await ctx.fs.mkdir(`${gitDir}/refs/heads`);
    await ctx.fs.mkdir(`${gitDir}/refs/tags`);
    await ctx.fs.mkdir(`${gitDir}/objects/info`);
    await ctx.fs.mkdir(`${gitDir}/objects/pack`);
    await ctx.fs.writeUtf8(`${gitDir}/info/exclude`, INFO_EXCLUDE);
    await ctx.fs.writeUtf8(`${gitDir}/description`, DESCRIPTION);
  } catch (err) {
    // Best-effort cleanup; swallow rmRecursive failures so the original error surfaces.
    await ctx.fs.rmRecursive(gitDir).catch(() => undefined);
    throw err;
  }
  return {
    gitDir: gitDir as FilePath,
    initialBranch: branch,
    bare: opts.bare,
  };
};
