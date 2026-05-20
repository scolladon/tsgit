import { alreadyInitialized } from '../../domain/index.js';
import type { FilePath, RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { bootstrapRepository } from './internal/bootstrap.js';

export interface InitOptions {
  readonly initialBranch?: string;
  readonly bare?: boolean;
}

export interface InitResult {
  readonly path: FilePath;
  readonly initialBranch: RefName;
  readonly bare: boolean;
}

/**
 * Initialize a fresh repository at `ctx.layout.gitDir`. Throws
 * `ALREADY_INITIALIZED` when the target gitDir already exists; otherwise
 * delegates to `bootstrapRepository` for the standard layout.
 *
 * For non-bare repos, the gitDir is `<workDir>/.git`. For bare, gitDir IS the
 * working dir — callers must construct a Context with `bare: true` for that
 * shape.
 */
export const init = async (ctx: Context, opts: InitOptions = {}): Promise<InitResult> => {
  const initialBranch = opts.initialBranch ?? 'main';
  const bare = opts.bare ?? false;
  if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
    throw alreadyInitialized(ctx.layout.gitDir as FilePath);
  }
  const result = await bootstrapRepository(ctx, { initialBranch, bare });
  return { path: result.gitDir, initialBranch: result.initialBranch, bare: result.bare };
};
