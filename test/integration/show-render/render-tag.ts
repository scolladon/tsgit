/**
 * Render the `tag` block `git show <annotated-tag>` prints: a `tag <name>`
 * header (the stored tag name), the optional `Tagger:` / `Date:` lines, a blank
 * line, then the verbatim tag message. The tagged object is rendered
 * separately (the `shown_one` separator joins them).
 */
import type { TagData } from '../../../src/domain/objects/index.js';
import { type DateFormatter, renderIdentityHeader } from './identity-header.js';

export function renderTagBlock(tag: TagData, formatDate?: DateFormatter): string {
  const header = [`tag ${tag.tagName}`];
  if (tag.tagger !== undefined) {
    header.push(...renderIdentityHeader('Tagger', tag.tagger, formatDate));
  }
  return `${header.join('\n')}\n\n${tag.message}`;
}
