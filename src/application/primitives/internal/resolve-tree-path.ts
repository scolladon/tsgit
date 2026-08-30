import { pathNotInTree } from '../../../domain/commands/error.js';
import { bytesEqual, encode } from '../../../domain/objects/encoding.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { HashConfig } from '../../../domain/objects/hash-config.js';
import type { ObjectId, Tree, TreeEntry } from '../../../domain/objects/index.js';
import { treeEntry } from '../../../domain/objects/tree.js';
import {
  advanceCursor,
  cursorMode,
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
  let match = matchRootLevel(rootTree, segments);
  for (let i = 1; match !== undefined && !match.consumedAll; i += 1) {
    match = await matchRawLevel(ctx, match.entry.id, segments, i);
  }
  return match?.entry;
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
  let match = await matchRawRootLevel(ctx, rootId, segments);
  const chain: ObjectId[] = [rootId];
  for (let i = 0; match !== undefined; i += 1) {
    chain.push(match.entry.id);
    if (match.entry.id === childChain[chain.length - 1]) {
      return { kind: 'treesame', oidChain: chain.concat(childChain.slice(chain.length)) };
    }
    if (match.consumedAll || i + 1 >= segments.length) break;
    match = await matchRawLevel(ctx, match.entry.id, segments, i + 1);
  }
  if (match === undefined) return undefined;
  return { kind: 'changed', entry: match.entry, oidChain: chain };
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

/** The result of matching one path level against a directory's entries: the
 *  entry found (first-wins) and whether it consumed the WHOLE remaining
 *  path — a literal entry name containing `/`, e.g. `a/b` — rather than
 *  just this level's own segment. */
interface LevelMatch {
  readonly entry: TreeEntry;
  readonly consumedAll: boolean;
}

/**
 * Match level `i` of `segments` against one directory's entries via `scan`
 * (a byte-target lookup already scoped to that directory's content): first
 * try `segments[i]` alone — the hit path, unconditionally cheap, run for
 * every level of every descent. On a miss, and only when `i` is not the
 * last segment, retry `scan` against the WHOLE remaining path joined back
 * with `/` — git's own tree walk compares an entry name against a prefix of
 * the whole remaining path, so a literal entry name containing `/` can
 * match a multi-segment query directly, even though no segment-by-segment
 * subtree chain leads to it.
 */
const matchLevel = (
  scan: (target: Uint8Array) => TreeEntry | undefined,
  segments: ReadonlyArray<string>,
  i: number,
): LevelMatch | undefined => {
  const hit = scan(encode(segments[i] as string));
  if (hit !== undefined) return { entry: hit, consumedAll: i === segments.length - 1 };
  if (i >= segments.length - 1) return undefined;
  const fallback = scan(encode(segments.slice(i).join('/')));
  return fallback === undefined ? undefined : { entry: fallback, consumedAll: true };
};

/** `findTreeEntry`'s root level: the root `Tree` is already parsed, so the
 *  scan is a linear `find` over its decoded entries, compared byte-for-byte
 *  on `nameBytes` (never the derived, lossily-decoded `name`). */
const matchRootLevel = (rootTree: Tree, segments: ReadonlyArray<string>): LevelMatch | undefined =>
  matchLevel(
    (target) => rootTree.entries.find((candidate) => bytesEqual(candidate.nameBytes, target)),
    segments,
    0,
  );

/** Read `rootId`'s raw object bytes and match level 0 of `segments` —
 *  `unexpectedObjectType` when `rootId` isn't a tree, the root-only
 *  counterpart to `matchRawLevel`'s intermediate-level `undefined`. */
const matchRawRootLevel = async (
  ctx: Context,
  rootId: ObjectId,
  segments: ReadonlyArray<string>,
): Promise<LevelMatch | undefined> => {
  const raw = await readRawObject(ctx, rootId);
  if (raw.type !== 'tree') throw unexpectedObjectType('tree', raw.type, rootId);
  return matchLevel((target) => scanRawTreeFor(raw.content, ctx.hashConfig, target), segments, 0);
};

/**
 * Read `parentId`'s raw object bytes and match level `i` of `segments` —
 * `undefined` when `parentId` isn't a tree (a blob/gitlink/symlink used as an
 * intermediate path segment), matching the parsed-tree descent this
 * replaces, which checked the same thing on the parsed object's `type`.
 */
const matchRawLevel = async (
  ctx: Context,
  parentId: ObjectId,
  segments: ReadonlyArray<string>,
  i: number,
): Promise<LevelMatch | undefined> => {
  const raw = await readRawObject(ctx, parentId);
  if (raw.type !== 'tree') return undefined;
  return matchLevel((target) => scanRawTreeFor(raw.content, ctx.hashConfig, target), segments, i);
};

/**
 * Byte-level scan of one directory's raw entries for `target`. Walks every
 * entry unconditionally, never stopping at the first match: mode is
 * validated eagerly per entry (`cursorMode`), so a malformed sibling mode
 * refuses immediately rather than only when that sibling is later visited —
 * breaking out as soon as `target` is found would silently skip that check
 * for every entry after it. Returns the FIRST matching entry when a
 * directory holds more than one entry with the same name, matching git's
 * own first-wins resolution.
 *
 * The byte compare below runs on raw bytes, not decoded strings — decoding
 * (a `TextDecoder` call) is deliberately deferred until an entry actually
 * needs a string, inside `treeEntry`'s own factory, and only for an entry
 * that matched `target`. A directory of N entries searched for one target
 * decodes at most one of them.
 */
const scanRawTreeFor = (
  content: Uint8Array,
  hash: HashConfig,
  target: Uint8Array,
): TreeEntry | undefined => {
  const cursor = openTreeCursor(content, hash);
  let matched: TreeEntry | undefined;
  while (!cursor.done) {
    matched ??= scanEntry(cursor, target);
    advanceCursor(cursor);
  }
  return matched;
};

const scanEntry = (cursor: TreeCursor, target: Uint8Array): TreeEntry | undefined => {
  const mode = cursorMode(cursor);
  if (!cursorNameEquals(cursor, target)) return undefined;
  return treeEntry(mode, cursor.buf.subarray(cursor.nameStart, cursor.nameEnd), cursorOid(cursor));
};
