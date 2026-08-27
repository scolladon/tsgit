import { pathNotInTree } from '../../../domain/commands/error.js';
import { encode } from '../../../domain/objects/encoding.js';
import { invalidTreeEntry } from '../../../domain/objects/error.js';
import type { HashConfig } from '../../../domain/objects/hash-config.js';
import type { ObjectId, Tree, TreeEntry } from '../../../domain/objects/index.js';
import {
  advanceCursor,
  cursorMode,
  cursorName,
  cursorNameEquals,
  cursorOid,
  openTreeCursor,
  type TreeCursor,
} from '../../../domain/objects/tree-cursor.js';
import type { Context } from '../../../ports/context.js';
import { readRawObject } from '../read-object.js';
import { readTree } from '../read-tree.js';

/**
 * Descend a `<rev>:<path>` tree path from an already-resolved root `Tree` to the
 * entry it addresses, returning that `TreeEntry` verbatim (no blob-guard, no read
 * of the final entry). Each intermediate `/`-separated segment must be present
 * and a sub-tree; a missing segment or a non-tree intermediate refuses with
 * `PATH_NOT_IN_TREE`. The caller decides what the final entry must be (a blob,
 * for `readFileAt`; any object, for `rev-parse`'s `<tree-ish>:<path>`).
 *
 * `rev` is carried only to populate the refusal's display fields.
 */
export const descendTreePath = async (
  ctx: Context,
  rootTree: Tree,
  path: string,
  rev: string,
): Promise<TreeEntry> => {
  const entry = await findTreeEntry(ctx, rootTree, path);
  if (entry === undefined) throw pathNotInTree(rev, path);
  return entry;
};

/**
 * Descend a `/`-separated tree path from a root oid or an already-resolved
 * `Tree`, returning the addressed `TreeEntry` — or `undefined` if any segment
 * is absent or a non-final segment is not itself a tree. Carries no refusal;
 * callers that need one (`descendTreePath`) wrap the `undefined` case.
 *
 * The root level is already-parsed (either handed in, or fetched through
 * `readTree`'s ref/peel resolution) and scanned via `findEntry` on its
 * decoded entries. Every level past the root descends over raw bytes
 * (`descendOneLevel`) — no `Tree` and no `TreeEntry[]` gets built for a
 * directory just to keep the one entry the path actually needs.
 */
export const findTreeEntry = async (
  ctx: Context,
  root: ObjectId | Tree,
  path: string,
): Promise<TreeEntry | undefined> => {
  const segments = path.split('/');
  const rootTree = typeof root === 'string' ? await readTree(ctx, root) : root;
  let entry = findEntry(rootTree, segments[0] as string);
  for (let i = 1; i < segments.length && entry !== undefined; i += 1) {
    entry = await descendOneLevel(ctx, entry.id, segments[i] as string);
  }
  return entry;
};

const findEntry = (tree: Tree, name: string): TreeEntry | undefined =>
  tree.entries.find((candidate) => candidate.name === name);

/**
 * Read `parentId`'s raw object bytes and scan its content for `name` —
 * `undefined` when `parentId` isn't a tree (a blob/gitlink/symlink used as an
 * intermediate path segment), matching the parsed-tree descent this
 * replaces, which checked the same thing on the parsed object's `type`.
 */
const descendOneLevel = async (
  ctx: Context,
  parentId: ObjectId,
  name: string,
): Promise<TreeEntry | undefined> => {
  const raw = await readRawObject(ctx, parentId);
  if (raw.type !== 'tree') return undefined;
  return scanRawTreeFor(raw.content, ctx.hashConfig, name);
};

/**
 * Byte-level scan of one directory's raw entries for `name`. Walks every
 * entry unconditionally, never stopping at the first match: the duplicate
 * name refusal a full parse applies to the whole directory has to fire
 * identically here, including for a duplicate elsewhere in the directory
 * that has nothing to do with `name`. Mode is validated eagerly per entry
 * (`cursorMode`) for the same reason — a malformed sibling mode refuses
 * immediately rather than only when that sibling is later visited.
 */
const scanRawTreeFor = (
  content: Uint8Array,
  hash: HashConfig,
  name: string,
): TreeEntry | undefined => {
  const cursor = openTreeCursor(content, hash);
  const target = encode(name);
  const seenNames = new Set<string>();
  let matched: TreeEntry | undefined;
  while (!cursor.done) {
    matched = scanEntry(cursor, seenNames, target) ?? matched;
    advanceCursor(cursor);
  }
  return matched;
};

const scanEntry = (
  cursor: TreeCursor,
  seenNames: Set<string>,
  target: Uint8Array,
): TreeEntry | undefined => {
  const mode = cursorMode(cursor);
  const entryName = cursorName(cursor);
  if (isInvalidEntryName(entryName)) {
    throw invalidTreeEntry(cursor.offset, `invalid entry name: ${entryName}`);
  }
  if (seenNames.has(entryName)) {
    throw invalidTreeEntry(cursor.offset, `duplicate entry name: ${entryName}`);
  }
  seenNames.add(entryName);
  if (!cursorNameEquals(cursor, target)) return undefined;
  return { mode, name: entryName, id: cursorOid(cursor) };
};

/**
 * Byte-cursor counterpart to `parseTreeContent`'s `name === '' || name ===
 * '.' || name === '..' || name.includes('/')` (tree.ts) — the empty case is
 * already refused structurally by the cursor's own null-terminator scan
 * (`tree-cursor.ts`'s `scanName`) before a caller ever observes the entry,
 * so only the remaining three shape checks are repeated here, on the
 * cursor's already-decoded name. This check is deliberately NOT shared
 * inside `TreeCursor` itself: the raw merge-join diff (`raw-tree-diff.ts`)
 * streams a diff over on-disk order without it, matching git's own
 * `diff-tree`, which does not validate name shape during a diff walk.
 */
const isInvalidEntryName = (name: string): boolean =>
  name === '.' || name === '..' || name.includes('/');
