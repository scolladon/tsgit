import type { IndexEntry } from '../../domain/git-index/index.js';
import { nothingToCommit } from '../../domain/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import type { AuthorIdentity, ObjectId, TreeEntry } from '../../domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../domain/objects/index.js';
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { createCommit } from '../primitives/create-commit.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeTree } from '../primitives/write-tree.js';
import { resolveAuthor, resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { readConfig } from './internal/config-read.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from './internal/repo-state.js';

export interface CommitOptions {
  readonly message: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  readonly allowEmpty?: boolean;
  readonly allowEmptyMessage?: boolean;
}

export interface CommitResult {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly branch: RefName | undefined;
  readonly parents: ReadonlyArray<ObjectId>;
}

/**
 * Create a new commit from the current index. Resolves author/committer from
 * options or `.git/config` `[user]`, writes a tree from the index, builds the
 * commit object, and updates HEAD's target ref (or detached HEAD itself).
 *
 * Throws `NOTHING_TO_COMMIT` when the new tree matches the parent's tree and
 * `allowEmpty` is not set; `EMPTY_COMMIT_MESSAGE` when the message is blank
 * and `allowEmptyMessage` is not set.
 */
export const commit = async (ctx: Context, opts: CommitOptions): Promise<CommitResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'commit');
  await assertNoPendingOperation(ctx);
  const message = sanitizeMessage(opts.message, { allowEmpty: opts.allowEmptyMessage ?? false });
  const config = await readConfig(ctx);
  const configUser = toAuthor(config.user);
  const author = resolveAuthor(buildResolverInput(opts.author, configUser));
  const committer = resolveCommitter(buildCommitterInput(opts.committer, author, configUser));
  const index = await readIndex(ctx);
  const treeId = await buildTreeFromIndex(ctx, index.entries);
  const head = await readHeadRaw(ctx);
  const parentId = head.kind === 'symbolic' ? await tryResolve(ctx, head.target) : head.id;
  const parents = parentId !== undefined ? [parentId] : [];
  if (!opts.allowEmpty && parentId !== undefined) {
    const parentTree = await getParentTree(ctx, parentId);
    if (parentTree === treeId) throw nothingToCommit();
  }
  const commitData: CommitData = {
    tree: treeId,
    parents,
    author,
    committer,
    message,
    extraHeaders: [],
  };
  const id = await createCommit(ctx, commitData);
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  if (branch !== undefined) {
    await updateRef(ctx, branch, id, parentId !== undefined ? { expected: parentId } : {});
  } else {
    await ctx.fs.writeUtf8(`${ctx.config.gitDir}/HEAD`, `${id}\n`);
  }
  return { id, tree: treeId, branch, parents };
};

const toAuthor = (
  user: { readonly name: string; readonly email: string } | undefined,
): AuthorIdentity | undefined => {
  if (user === undefined) return undefined;
  return {
    name: user.name,
    email: user.email,
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  };
};

const buildResolverInput = (
  explicit: AuthorIdentity | undefined,
  configUser: AuthorIdentity | undefined,
): { readonly explicit?: AuthorIdentity; readonly configUser?: AuthorIdentity } => {
  const out: { explicit?: AuthorIdentity; configUser?: AuthorIdentity } = {};
  if (explicit !== undefined) out.explicit = explicit;
  if (configUser !== undefined) out.configUser = configUser;
  return out;
};

const buildCommitterInput = (
  explicit: AuthorIdentity | undefined,
  author: AuthorIdentity | undefined,
  configUser: AuthorIdentity | undefined,
): {
  readonly explicit?: AuthorIdentity;
  readonly author?: AuthorIdentity;
  readonly configUser?: AuthorIdentity;
} => {
  const out: {
    explicit?: AuthorIdentity;
    author?: AuthorIdentity;
    configUser?: AuthorIdentity;
  } = {};
  if (explicit !== undefined) out.explicit = explicit;
  if (author !== undefined) out.author = author;
  if (configUser !== undefined) out.configUser = configUser;
  return out;
};

const tryResolve = async (ctx: Context, name: RefName): Promise<ObjectId | undefined> => {
  try {
    return await resolveRef(ctx, name);
  } catch {
    return undefined;
  }
};

const getParentTree = async (ctx: Context, parentId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, parentId);
  if (obj.type !== 'commit') return ObjectIdFactory.from('0'.repeat(40));
  return obj.data.tree;
};

interface SubtreeNode {
  readonly files: Map<string, { readonly id: ObjectId; readonly mode: string }>;
  readonly subdirs: Map<string, SubtreeNode>;
}

const buildTreeFromIndex = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
): Promise<ObjectId> => {
  const root: SubtreeNode = { files: new Map(), subdirs: new Map() };
  for (const entry of entries) {
    insertEntry(root, entry.path.split('/'), entry);
  }
  return writeSubtree(ctx, root);
};

const insertEntry = (node: SubtreeNode, parts: ReadonlyArray<string>, entry: IndexEntry): void => {
  if (parts.length === 1) {
    node.files.set(parts[0] as string, { id: entry.id, mode: entry.mode });
    return;
  }
  const [head, ...rest] = parts;
  const key = head as string;
  let child = node.subdirs.get(key);
  if (child === undefined) {
    child = { files: new Map(), subdirs: new Map() };
    node.subdirs.set(key, child);
  }
  insertEntry(child, rest, entry);
};

const writeSubtree = async (ctx: Context, node: SubtreeNode): Promise<ObjectId> => {
  const treeEntries: TreeEntry[] = [];
  for (const [name, leaf] of node.files) {
    treeEntries.push({ mode: leaf.mode as TreeEntry['mode'], name, id: leaf.id });
  }
  // Subtrees at the same level are independent — write them in parallel.
  const subdirs = await Promise.all(
    Array.from(node.subdirs).map(async ([name, child]) => ({
      name,
      id: await writeSubtree(ctx, child),
    })),
  );
  for (const { name, id } of subdirs) {
    treeEntries.push({ mode: '40000', name, id });
  }
  // Sorting is done by the domain serializer with the correct git tree comparator
  // (directories sort as if their name ended with `/`); pre-sorting here would be
  // both redundant and use the wrong ordering.
  return writeTree(ctx, treeEntries);
};
