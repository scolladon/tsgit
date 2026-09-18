/**
 * git's `fsck.skipList` — an object-name list whose entries silence the
 * per-object CONTENT reports for the oids they name.
 *
 * It reaches exactly the findings git routes through `report()`, and nothing
 * else: a listed oid still shows up as missing, dangling, hash-mismatched,
 * corrupt, or as a ref-level fault (measured, git 2.55.0). Both refusals the
 * list can raise kill the whole audit rather than dropping an entry — git
 * dies while it is still reading configuration, before a single object is
 * decoded.
 */

import {
  fsckSkipListInvalidName,
  fsckSkipListUnreadable,
} from '../../../../domain/commands/error.js';
import { errorDataCode } from '../../../../domain/error-data-code.js';
import type { HashConfig } from '../../../../domain/objects/index.js';
import { isOid } from '../../../../domain/objects/index.js';
import type { Context, RepositoryLayout } from '../../../../ports/context.js';
import { isAbsolutePath } from '../../../primitives/internal/absolute-path.js';
import { expandHomePrefix } from '../../../primitives/internal/expand-home-path.js';
import { joinPath } from '../../../primitives/internal/join-working-tree-path.js';

/** git's own comment marker inside an object-name list. */
const COMMENT_PREFIX = '#';

/** What the refusal carries when the adapter's rejection was not a TsgitError. */
const UNCLASSIFIED = 'UNKNOWN';

/**
 * The names one configured `fsck.skipList` entry holds. git parses each list
 * into ONE oidset as its config read reaches that entry, so the caller unions
 * what every entry yields — and an unusable list refuses the audit right
 * there, before anything later in the file is graded.
 */
export const readFsckSkipListNames = async (
  ctx: Context,
  configured: string,
): Promise<ReadonlySet<string>> => {
  const path = resolveListPath(ctx.layout, configured);
  return parseObjectNames(await readListFile(ctx, path), path, ctx.hashConfig);
};

/**
 * git routes the configured pathname through `git_config_pathname`, which
 * expands a leading `~/` first and resolves the rest against the process
 * working directory; tsgit's nearest equivalent for that second half is the
 * working tree, with the git dir standing in for a bare repository — the same
 * rule `core.hooksPath` already follows. A `~/` path with no home to expand
 * against is left as written, so the read below refuses it by the name that
 * was configured rather than by a silently invented one.
 */
const resolveListPath = (layout: RepositoryLayout, configured: string): string => {
  const path = expandHomePrefix(configured, layout.homeDir) ?? configured;
  return isAbsolutePath(path) ? path : joinPath(layout.workDir ?? layout.gitDir, path);
};

const readListFile = async (ctx: Context, path: string): Promise<string> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    throw fsckSkipListUnreadable(path, errorDataCode(err) ?? UNCLASSIFIED);
  }
};

/** git's `oidset_parse_file_carefully` truncates a line at its FIRST `#` —
 *  anywhere on the line, not only at column zero — and trims what is left, so
 *  a name may carry a trailing comment and a comment may carry leading
 *  whitespace. */
const stripComment = (line: string): string => {
  const marker = line.indexOf(COMMENT_PREFIX);
  return (marker === -1 ? line : line.slice(0, marker)).trim();
};

/**
 * One full object name per line. Blank lines and `#` comments are dropped,
 * surrounding whitespace (a CRLF's own `\r` included) is trimmed away, and
 * the hex is case-folded. Anything else that survives — an abbreviation, a
 * word — refuses; git takes full names only.
 */
const parseObjectNames = (
  body: string,
  path: string,
  hashConfig: HashConfig,
): ReadonlySet<string> => {
  const skipped = new Set<string>();
  const lines = body.split('\n');
  for (const [index, raw] of lines.entries()) {
    const entry = stripComment(raw);
    if (entry === '') continue;
    const name = entry.toLowerCase();
    if (!isOid(name, hashConfig)) throw fsckSkipListInvalidName(entry, path, index + 1);
    skipped.add(name);
  }
  return skipped;
};
