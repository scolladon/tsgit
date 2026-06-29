import { TsgitError } from '../../domain/error.js';
import { loadTrieRoot } from '../../domain/notes/load.js';
import type { NotesTrie, SubtreeReader } from '../../domain/notes/types.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, TreeEntry } from '../../domain/objects/index.js';
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import { resolveRef } from './resolve-ref.js';

export interface LoadedNotesTree {
  /** The trie built from the on-disk notes tree. Empty when the ref is absent. */
  readonly trie: NotesTrie;
  /** Reads a subtree's entries on demand (lazy subtree unpacking). */
  readonly read: SubtreeReader;
  /** The commit oid the notes ref resolved to, or `undefined` if the ref did not exist. */
  readonly notesCommitOid: ObjectId | undefined;
  /** The notes commit's root tree oid, or `undefined` if the ref did not exist. */
  readonly notesTreeOid: ObjectId | undefined;
}

/** Reads one subtree's entries, asserting it is actually a tree object. */
async function readSubtreeEntries(ctx: Context, oid: ObjectId): Promise<ReadonlyArray<TreeEntry>> {
  const obj = await readObject(ctx, oid);
  if (obj.type !== 'tree') throw unexpectedObjectType('tree', obj.type, oid);
  return obj.entries;
}

/**
 * Resolves a notes ref to its commit, reads the commit's tree, and builds a
 * `NotesTrie` via the domain's `loadTrieRoot`. Returns an empty trie when the
 * ref does not exist yet.
 *
 * The returned `read` function acts as the lazy subtree reader: passing it to
 * the domain's write-plan walker lets it unpack fanout subtrees on demand.
 */
export async function loadNotesTree(ctx: Context, ref: RefName): Promise<LoadedNotesTree> {
  // Memoize per-operation subtree reads so a `lookup` followed by `insert`/
  // `remove` does not re-decode the same fanout subtree (mirrors read-object's
  // in-flight dedup, but kept for the whole operation).
  const subtreeCache = new Map<ObjectId, Promise<ReadonlyArray<TreeEntry>>>();
  const read: SubtreeReader = (oid: ObjectId): Promise<ReadonlyArray<TreeEntry>> => {
    const cached = subtreeCache.get(oid);
    if (cached !== undefined) return cached;
    const pending = readSubtreeEntries(ctx, oid);
    subtreeCache.set(oid, pending);
    return pending;
  };

  const commitOid = await resolveRef(ctx, ref).catch((err: unknown) => {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') return undefined;
    throw err;
  });

  if (commitOid === undefined) {
    return { trie: loadTrieRoot([]), read, notesCommitOid: undefined, notesTreeOid: undefined };
  }

  const commitObj = await readObject(ctx, commitOid);
  if (commitObj.type !== 'commit') {
    throw unexpectedObjectType('commit', commitObj.type, commitOid);
  }

  const treeOid = commitObj.data.tree;
  const treeObj = await readObject(ctx, treeOid);
  if (treeObj.type !== 'tree') {
    throw unexpectedObjectType('tree', treeObj.type, treeOid);
  }

  const trie = loadTrieRoot(treeObj.entries);
  return { trie, read, notesCommitOid: commitOid, notesTreeOid: treeOid };
}
