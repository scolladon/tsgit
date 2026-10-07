/**
 * git's `handle_signed_tag`: a merged signed tag rides into the merge commit as
 * a `mergetag` header holding the tag object verbatim.
 */
import type { ExtraHeader } from '../objects/index.js';

const MERGE_TAG_KEY = 'mergetag';
const NEWLINE = '\n';

/**
 * The `mergetag` header for `tag`'s raw object text — its final newline left to
 * the header's own line end, as `strbuf_add_lines` completes the last line.
 */
export const mergeTagHeader = (tag: string): ExtraHeader => ({
  key: MERGE_TAG_KEY,
  value: tag.endsWith(NEWLINE) ? tag.slice(0, -NEWLINE.length) : tag,
});
