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

const EXTENSIONS_BLOCK = '[extensions]\n\tobjectformat = sha256\n';

// Only the format bump is format-conditional. git's own init also writes
// `logallrefupdates`, `ignorecase` and `precomposeunicode`, but NONE of them
// is a property of the object format — measured across all four init
// variants on git 2.55.0: sha1 and sha256 emit the same set,
// `logallrefupdates` is gated on NOT being bare, and the other two are
// filesystem probes (true on a case-insensitive, decomposing volume; absent
// elsewhere). Emitting them on the sha256 branch alone would write a config
// git never writes — `logallrefupdates = true` beside `bare = true`, and an
// `ignorecase = true` that is a claim about the filesystem rather than a
// default. Adding them correctly is a separate, format-independent concern.
const coreBlock = (bare: boolean, objectFormat?: 'sha1' | 'sha256'): string => {
  const version = objectFormat === 'sha256' ? 1 : 0;
  return `[core]\n\trepositoryformatversion = ${version}\n\tfilemode = true\n\tbare = ${bare ? 'true' : 'false'}\n`;
};

/**
 * `[extensions]` precedes `[core]` — measured against `git init
 * --object-format=sha256` byte-for-byte; a writer that swaps the order is
 * semantically identical but byte-different, so the order is load-bearing.
 */
const renderConfig = (bare: boolean, objectFormat?: 'sha1' | 'sha256'): string =>
  objectFormat === 'sha256'
    ? `${EXTENSIONS_BLOCK}${coreBlock(bare, objectFormat)}`
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
