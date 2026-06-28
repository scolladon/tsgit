import { authorUnconfigured } from '../../domain/commands/error.js';
import type { NotesTrie, SubtreeReader, WritePlanEntry } from '../../domain/notes/types.js';
import { planWrite } from '../../domain/notes/write-plan.js';
import type { AuthorIdentity, ObjectId, TreeEntry } from '../../domain/objects/index.js';
import { FILE_MODE, sortTreeEntries } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { createCommit } from './create-commit.js';
import { writeTree } from './write-tree.js';

export interface WriteNotesTreeInput {
  /** The in-memory trie to serialize. */
  readonly trie: NotesTrie;
  /** Subtree reader for lazy unpacking during write-plan generation. */
  readonly read: SubtreeReader;
  /** The notes commit the new commit should descend from, or `undefined` for a root commit. */
  readonly prevCommitOid: ObjectId | undefined;
  /** The notes commit message (caller owns the verb, e.g. "Notes added by 'git notes add'"). */
  readonly message: string;
}

/**
 * Converts a notes trie into a git commit:
 *   1. Walks the trie to produce a flat write-plan.
 *   2. Converts the flat plan into a real git tree hierarchy (bottom-up).
 *   3. Creates a notes commit (author == committer == configured user identity).
 *
 * The caller is responsible for updating the notes ref and reflog after this returns.
 */
export async function writeNotesTree(ctx: Context, input: WriteNotesTreeInput): Promise<ObjectId> {
  const plan = await planWrite(input.trie, input.read);
  const rootTreeOid = await buildTree(ctx, plan.entries);
  const identity = await resolveIdentity(ctx);

  return createCommit(ctx, {
    tree: rootTreeOid,
    parents: input.prevCommitOid !== undefined ? [input.prevCommitOid] : [],
    author: identity,
    committer: identity,
    message: input.message,
  });
}

/**
 * Reads user identity from config and throws `AUTHOR_UNCONFIGURED` when
 * `user.name` or `user.email` is absent.
 */
async function resolveIdentity(ctx: Context): Promise<AuthorIdentity> {
  const config = await readConfig(ctx);
  const user = config.user;
  if (user?.name === undefined || user?.email === undefined) throw authorUnconfigured();
  return {
    name: user.name,
    email: user.email,
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  };
}

/**
 * Recursively converts a flat list of `WritePlanEntry` items into a git tree object.
 *
 * Entries whose `name` contains `/` are grouped by their first path segment and
 * written as subtrees (bottom-up). Direct entries (no `/`) are placed as-is.
 * All entries are sorted by git tree-entry order before the tree is written.
 */
async function buildTree(ctx: Context, entries: ReadonlyArray<WritePlanEntry>): Promise<ObjectId> {
  const direct: TreeEntry[] = [];
  const groups = new Map<string, WritePlanEntry[]>();

  for (const entry of entries) {
    const slashIdx = entry.name.indexOf('/');
    if (slashIdx === -1) {
      direct.push({ id: entry.oid as ObjectId, mode: entry.mode, name: entry.name });
    } else {
      const prefix = entry.name.slice(0, slashIdx);
      const rest = entry.name.slice(slashIdx + 1);
      const group = groups.get(prefix) ?? [];
      const child: WritePlanEntry =
        entry.oid !== undefined
          ? { name: rest, mode: entry.mode, oid: entry.oid }
          : { name: rest, mode: entry.mode };
      group.push(child);
      groups.set(prefix, group);
    }
  }

  const subtreeEntries: TreeEntry[] = [];
  for (const [prefix, groupEntries] of groups) {
    const subtreeOid = await buildTree(ctx, groupEntries);
    subtreeEntries.push({ id: subtreeOid, mode: FILE_MODE.DIRECTORY, name: prefix });
  }

  const sorted = sortTreeEntries([...direct, ...subtreeEntries]);
  return writeTree(ctx, sorted);
}
