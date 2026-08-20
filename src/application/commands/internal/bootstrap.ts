import type { FilePath, RefName } from '../../../domain/objects/object-id.js';
import { validateRefName } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';

interface BootstrapOptions {
  readonly initialBranch: string;
  readonly bare: boolean;
  readonly objectFormat?: 'sha1' | 'sha256';
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

const extensionsBlock = (): string => '[extensions]\n\tobjectformat = sha256\n';

// git's own `--object-format=sha256` init emits three extra `[core]` keys
// alongside the format bump — measured byte-for-byte against git 2.55.0.
// The sha1/default path stays exactly as it was before this option existed
// (no regression to the legacy three-line block).
const CORE_EXTRAS_SHA256 =
  '\n\tlogallrefupdates = true\n\tignorecase = true\n\tprecomposeunicode = true';

const coreBlock = (bare: boolean, objectFormat?: 'sha1' | 'sha256'): string => {
  const isSha256 = objectFormat === 'sha256';
  const version = isSha256 ? 1 : 0;
  const extras = isSha256 ? CORE_EXTRAS_SHA256 : '';
  return `[core]\n\trepositoryformatversion = ${version}\n\tfilemode = true\n\tbare = ${bare ? 'true' : 'false'}${extras}\n`;
};

/**
 * `[extensions]` precedes `[core]` — measured against `git init
 * --object-format=sha256` byte-for-byte; a writer that swaps the order is
 * semantically identical but byte-different, so the order is load-bearing.
 */
const renderConfig = (bare: boolean, objectFormat?: 'sha1' | 'sha256'): string =>
  objectFormat === 'sha256'
    ? `${extensionsBlock()}${coreBlock(bare, objectFormat)}`
    : coreBlock(bare, objectFormat);

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
    await ctx.fs.writeUtf8(`${gitDir}/config`, renderConfig(opts.bare, opts.objectFormat));
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
