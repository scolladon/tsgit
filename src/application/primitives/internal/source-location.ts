import type { Context } from '../../../ports/context.js';
import type { ObjectSourceAccess } from '../../../ports/object-source-access.js';
import { commonGitDir, objectsDirOf } from '../path-layout.js';

/** One object store: its `objects` directory and the filesystem access that reads it. */
export interface SourceLocation {
  readonly objectsDir: string;
  readonly fs: ObjectSourceAccess;
}

/** Where a loose read looks: the given alternate's store, else the repository's own `objects` through `ctx.fs`. */
export const looseLocationOf = (
  ctx: Context,
  location: SourceLocation | undefined,
): SourceLocation => location ?? { objectsDir: objectsDirOf(commonGitDir(ctx)), fs: ctx.fs };
