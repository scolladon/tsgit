/**
 * git's `commit_graph_compatible`: a commit-graph would encode parents other
 * than the ones a reader sees through grafts or replace refs, so no graph is
 * written while either applies. A shallow repository is refused by the writer
 * itself. `git commit-graph write` — which `maintenance`'s commit-graph task
 * runs as a child — disables replace refs first, so only an in-process write
 * such as `gc`'s consults them.
 */
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import { isOid } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../config-read.js';
import { enumerateRefs } from '../enumerate-refs.js';
import { commonGitDir } from '../path-layout.js';
import { readUtf8IfPresent } from './fs-probes.js';

const REPLACE_PREFIX = 'refs/replace/';
const COMMENT = '#';

/** git's `read_graft_line`: `<commit>[ <parent>]*`, anything else being bad data or a comment. */
const isGraftLine = (line: string, hexLength: number): boolean => {
  const trimmed = line.trimEnd();
  if (trimmed === '' || trimmed.startsWith(COMMENT)) return false;
  return new RegExp(`^[0-9a-fA-F]{${hexLength}}( [0-9a-fA-F]{${hexLength}})*$`).test(trimmed);
};

/** Whether `info/grafts` registers at least one graft. */
export const hasGrafts = async (ctx: Context): Promise<boolean> => {
  const raw = await readUtf8IfPresent(ctx.fs, `${commonGitDir(ctx)}/info/grafts`);
  if (raw === undefined) return false;
  return raw.split('\n').some((line) => isGraftLine(line, ctx.hashConfig.hexLength));
};

/** Whether git's replace map holds an entry: `core.useReplaceRefs` on and a `refs/replace/<oid>`. */
export const hasReplaceRefs = async (ctx: Context): Promise<boolean> => {
  const setting = (await findLastEntry(ctx, 'core', 'useReplaceRefs'))?.value;
  const parsed = setting === undefined ? undefined : parseGitBoolean(setting);
  if (parsed?.ok === true && !parsed.value) return false;
  const refs = await enumerateRefs(ctx);
  return refs.some(
    (ref) =>
      ref.startsWith(REPLACE_PREFIX) && isOid(ref.slice(REPLACE_PREFIX.length), ctx.hashConfig),
  );
};
