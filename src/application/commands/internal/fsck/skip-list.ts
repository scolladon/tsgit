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
import { readFsckSkipListPath } from '../../../primitives/config-read.js';
import { isAbsolutePath } from '../../../primitives/internal/absolute-path.js';
import { joinPath } from '../../../primitives/internal/join-working-tree-path.js';

/** git's own comment marker inside an object-name list. */
const COMMENT_PREFIX = '#';

/** What the refusal carries when the adapter's rejection was not a TsgitError. */
const UNCLASSIFIED = 'UNKNOWN';

export const loadFsckSkipList = async (ctx: Context): Promise<ReadonlySet<string>> => {
  const configured = await readFsckSkipListPath(ctx);
  if (configured === undefined) return new Set();
  const path = resolveListPath(ctx.layout, configured);
  return parseObjectNames(await readListFile(ctx, path), path, ctx.hashConfig);
};

/** git resolves the configured pathname against the process working
 *  directory; tsgit's nearest equivalent is the working tree, with the git
 *  dir standing in for a bare repository — the same rule `core.hooksPath`
 *  already follows. */
const resolveListPath = (layout: RepositoryLayout, configured: string): string =>
  isAbsolutePath(configured) ? configured : joinPath(layout.workDir ?? layout.gitDir, configured);

const readListFile = async (ctx: Context, path: string): Promise<string> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    throw fsckSkipListUnreadable(path, errorDataCode(err) ?? UNCLASSIFIED);
  }
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
    const entry = raw.trim();
    if (entry === '' || entry.startsWith(COMMENT_PREFIX)) continue;
    const name = entry.toLowerCase();
    if (!isOid(name, hashConfig)) throw fsckSkipListInvalidName(entry, path, index + 1);
    skipped.add(name);
  }
  return skipped;
};
