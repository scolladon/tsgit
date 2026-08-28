import { pathNotInTree } from '../../../domain/commands/error.js';
import { encode } from '../../../domain/objects/encoding.js';
import { invalidTreeEntry, unexpectedObjectType } from '../../../domain/objects/error.js';
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
 * `readTree`'s ref/peel resolution) and scanned by a linear find over its
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
  let entry = rootTree.entries.find((candidate) => candidate.name === segments[0]);
  for (let i = 1; i < segments.length && entry !== undefined; i += 1) {
    entry = await descendOneLevel(ctx, entry.id, segments[i] as string);
  }
  return entry;
};

/** The leaf entry a chain descent reached, plus the per-level oid chain
 *  `[rootId, subtree…, leafId]` walked to reach it — `blame`'s TREESAME
 *  short-circuit compares this against a suspect's own chain, level by
 *  level, to skip a tree read the instant two generations' content is
 *  provably identical (git's content-addressing: an equal oid at a level
 *  means everything from there down is byte-identical). */
export interface TreeChainDescent {
  readonly entry: TreeEntry;
  readonly oidChain: ReadonlyArray<ObjectId>;
}

/** Either a TREESAME verdict (path unchanged from `rootId` down — no leaf
 *  entry needed, the caller already has the child's) or the resolved leaf,
 *  each carrying the oid chain a further ancestor can short-circuit against. */
export type TreeChainMatch =
  | { readonly kind: 'treesame'; readonly oidChain: ReadonlyArray<ObjectId> }
  | {
      readonly kind: 'changed';
      readonly entry: TreeEntry;
      readonly oidChain: ReadonlyArray<ObjectId>;
    };

/**
 * The per-level oid short-circuit: descend `segments` from `rootId`, but
 * bail the instant a visited level's oid equals the same position in
 * `childChain` — that level, and everything below it, is byte-identical to
 * the child's. The returned TREESAME chain is `rootId`'s OWN accurate levels
 * up to (and including) the level the match was found at, spliced with
 * `childChain`'s remaining (guaranteed identical) tail — not `childChain`
 * wholesale, whose earlier levels differ from this root by construction
 * (the descent only reached level k because levels before it did NOT
 * match). Carrying the accurate splice lets a further ancestor's own
 * short-circuit compare against real values at every level, instead of
 * paying for tree reads down to level k again before its own match can fire.
 */
export const descendMatchingTreeChain = async (
  ctx: Context,
  rootId: ObjectId,
  segments: ReadonlyArray<string>,
  childChain: ReadonlyArray<ObjectId>,
): Promise<TreeChainMatch | undefined> => {
  if (rootId === childChain[0]) return { kind: 'treesame', oidChain: childChain };
  let entry = await scanRootLevel(ctx, rootId, segments[0] as string);
  const chain: ObjectId[] = [rootId];
  for (let i = 0; entry !== undefined; i += 1) {
    chain.push(entry.id);
    if (entry.id === childChain[chain.length - 1]) {
      return { kind: 'treesame', oidChain: chain.concat(childChain.slice(chain.length)) };
    }
    if (i + 1 >= segments.length) break;
    entry = await descendOneLevel(ctx, entry.id, segments[i + 1] as string);
  }
  if (entry === undefined) return undefined;
  return { kind: 'changed', entry, oidChain: chain };
};

/**
 * Full chain descent from a tree oid through `segments`, byte-scanning every
 * level including the root (unlike `findTreeEntry`, whose root branch reads
 * an already-resolved `Tree`). A thin `descendMatchingTreeChain` call with no
 * child chain to match against — an empty `childChain` can never equal a
 * real oid at any level, so the short-circuit never fires and the descent
 * always runs to the leaf, `unexpectedObjectType` if the root isn't a tree,
 * the same refusal `readTree`'s own peel-chain would raise.
 */
export const findTreeEntryChain = async (
  ctx: Context,
  rootId: ObjectId,
  segments: ReadonlyArray<string>,
): Promise<TreeChainDescent | undefined> => {
  const result = await descendMatchingTreeChain(ctx, rootId, segments, []);
  return result?.kind === 'changed' ? result : undefined;
};

/** Read `rootId`'s raw object bytes and scan for `name` — `unexpectedObjectType`
 *  when `rootId` isn't a tree, the root-only counterpart to `descendOneLevel`'s
 *  intermediate-level `undefined`. */
const scanRootLevel = async (
  ctx: Context,
  rootId: ObjectId,
  name: string,
): Promise<TreeEntry | undefined> => {
  const raw = await readRawObject(ctx, rootId);
  if (raw.type !== 'tree') throw unexpectedObjectType('tree', raw.type, rootId);
  return scanRawTreeFor(raw.content, ctx.hashConfig, name);
};

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
 *
 * The duplicate-name and shape checks below run on raw bytes, not decoded
 * strings — `cursorName` (a `TextDecoder` call) is deliberately deferred
 * until an entry actually needs a string: it matched `name`, or it's on a
 * refusal's message. A directory of N entries searched for one name decodes
 * at most one of them on the common, refusal-free path.
 */
const scanRawTreeFor = (
  content: Uint8Array,
  hash: HashConfig,
  name: string,
): TreeEntry | undefined => {
  const cursor = openTreeCursor(content, hash);
  const target = encode(name);
  const seenNames: NameSpan[] = [];
  let matched: TreeEntry | undefined;
  while (!cursor.done) {
    matched = scanEntry(cursor, seenNames, target) ?? matched;
    advanceCursor(cursor);
  }
  return matched;
};

/** One entry's raw name bytes within a directory's shared content buffer. */
type NameSpan = readonly [start: number, end: number];

const scanEntry = (
  cursor: TreeCursor,
  seenNames: NameSpan[],
  target: Uint8Array,
): TreeEntry | undefined => {
  const mode = cursorMode(cursor);
  const { nameStart, nameEnd } = cursor;
  if (isInvalidEntryNameBytes(cursor.buf, nameStart, nameEnd)) {
    throw invalidTreeEntry(cursor.offset, `invalid entry name: ${cursorName(cursor)}`);
  }
  if (seenNames.some(([s, e]) => cursorNameEquals(cursor, cursor.buf.subarray(s, e)))) {
    throw invalidTreeEntry(cursor.offset, `duplicate entry name: ${cursorName(cursor)}`);
  }
  seenNames.push([nameStart, nameEnd]);
  if (!cursorNameEquals(cursor, target)) return undefined;
  return { mode, name: cursorName(cursor), id: cursorOid(cursor) };
};

/**
 * Byte-cursor counterpart to `parseTreeContent`'s `name === '' || name ===
 * '.' || name === '..' || name.includes('/')` (tree.ts) — the empty case is
 * already refused structurally by the cursor's own null-terminator scan
 * (`tree-cursor.ts`'s `scanName`) before a caller ever observes the entry,
 * so only the remaining three shape checks are repeated here, on raw bytes:
 * an exact `.` or `..`, or a `/` ANYWHERE in the name (a lone `/`, a leading
 * or trailing `/` alongside other bytes, `//`, …) — the slash scan runs
 * unconditionally, at every length, so a short name can never short-circuit
 * past it the way an early `return` keyed on length alone once did. This
 * check is deliberately NOT shared inside `TreeCursor` itself: the raw
 * merge-join diff (`raw-tree-diff.ts`) streams a diff over on-disk order
 * without it, matching git's own `diff-tree`, which does not validate name
 * shape during a diff walk.
 */
const DOT = 0x2e;
const SLASH = 0x2f;

const isInvalidEntryNameBytes = (buf: Uint8Array, start: number, end: number): boolean => {
  const length = end - start;
  if (length === 1 && buf[start] === DOT) return true;
  if (length === 2 && buf[start] === DOT && buf[start + 1] === DOT) return true;
  for (let i = start; i < end; i++) {
    if (buf[i] === SLASH) return true;
  }
  return false;
};
