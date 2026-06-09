import { mergeHasConflicts } from '../../domain/commands/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { nothingToCommit } from '../../domain/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import type { AuthorIdentity, FilePath, ObjectId, TreeEntry } from '../../domain/objects/index.js';
import { ZERO_OID } from '../../domain/objects/index.js';
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { createCommit } from '../primitives/create-commit.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { runInformationalHook } from '../primitives/run-hook.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeTree } from '../primitives/write-tree.js';
import { clearCherryPickHead, readCherryPickHead } from './internal/cherry-pick-state.js';
import {
  applyCommitMessageHooks,
  type PrepareCommitMsgSource,
  runPreCommitHook,
} from './internal/commit-hooks.js';
import {
  resolveAuthor,
  resolveCommitter,
  sanitizeMessage,
  stripComments,
} from './internal/commit-message.js';
import {
  clearMergeMsg,
  clearMergeState,
  readMergeHead,
  readMergeMsg,
} from './internal/merge-state.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from './internal/repo-state.js';
import { clearRevertHead, readRevertHead } from './internal/revert-state.js';

export interface CommitOptions {
  readonly message: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  readonly allowEmpty?: boolean;
  readonly allowEmptyMessage?: boolean;
  /** Skip the `pre-commit` and `commit-msg` hooks (git's `--no-verify`). */
  readonly noVerify?: boolean;
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
  // Resolving a conflicted merge / cherry-pick / revert IS the legitimate way to
  // clear its marker — skip that marker's check. All other in-progress operations
  // still block. A cherry-pick / revert resolution stays single-parent (no
  // MERGE_HEAD).
  const markers = await readPendingMarkers(ctx);
  const { mergeHead, cherryPickHead, revertHead } = markers;
  const pendingExcept = pendingExceptOf(markers);
  await assertNoPendingOperation(ctx, pendingExcept !== undefined ? { except: pendingExcept } : {});
  const noVerify = opts.noVerify ?? false;
  // pre-commit runs before the index is read, so a hook that re-stages files
  // (e.g. a formatter) is reflected in the committed tree.
  await runPreCommitHook(ctx, noVerify);
  // A resolution commit for a pending merge / cherry-pick / revert reuses
  // MERGE_MSG as its draft — git's `merge` message source for prepare-commit-msg.
  const resolvingPending =
    mergeHead !== undefined || cherryPickHead !== undefined || revertHead !== undefined;
  const messageSource: PrepareCommitMsgSource = resolvingPending ? 'merge' : 'message';
  const resolved = await resolveCommitMessage(ctx, opts, resolvingPending);
  const config = await readConfig(ctx);
  const configUser = toAuthor(config.user);
  const author = resolveAuthor(buildResolverInput(opts.author, configUser));
  const committer = resolveCommitter(buildCommitterInput(opts.committer, author, configUser));
  const index = await readIndex(ctx);
  rejectUnmergedIndex(index.entries);
  const treeId = await buildTreeFromIndex(ctx, index.entries);
  const head = await readHeadRaw(ctx);
  const parentId = head.kind === 'symbolic' ? await tryResolve(ctx, head.target) : head.id;
  const parents = buildParents(parentId, mergeHead);
  if (!opts.allowEmpty && parentId !== undefined && mergeHead === undefined) {
    // Tree-equality guard intentionally skipped during a merge resolution
    // (mergeHead !== undefined). A merge commit with a tree identical to
    // HEAD's IS the canonical "user accepted all ours" outcome — it is a
    // genuine two-parent commit even when the tree didn't change. Refusing
    // it here would force users into noisy --allow-empty for a normal flow.
    const parentTree = await getParentTree(ctx, parentId);
    if (parentTree === treeId) throw nothingToCommit();
  }
  // The message hooks run once the commit is certain to happen; they may
  // rewrite the message, so the result feeds both the commit object and the reflog.
  const message = await applyCommitMessageHooks(ctx, resolved, {
    noVerify,
    allowEmptyMessage: opts.allowEmptyMessage ?? false,
    source: messageSource,
  });
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
  const reflogMessage = commitReflogMessage(message, parentId, mergeHead, cherryPickHead);
  await writeCommitRef(ctx, { branch, id, parentId, reflogMessage });
  await clearResolvedState(ctx, markers);
  // post-commit is informational — it runs after the commit lands and cannot
  // abort it (git ignores its exit code).
  await runInformationalHook(ctx, 'post-commit');
  return { id, tree: treeId, branch, parents };
};

interface CommitRefUpdate {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly parentId: ObjectId | undefined;
  readonly reflogMessage: string;
}

/**
 * Point the commit's target at the new commit: a branch ref via `updateRef`
 * (CAS on its prior tip), or detached HEAD via a raw write + reflog record.
 */
const writeCommitRef = async (ctx: Context, update: CommitRefUpdate): Promise<void> => {
  const { branch, id, parentId, reflogMessage } = update;
  if (branch !== undefined) {
    // Stryker disable next-line ObjectLiteral: equivalent — parentId is read from `branch` itself and the library is single-threaded, so the CAS `expected` always equals the ref's current value; dropping it cannot change the outcome.
    await updateRef(
      ctx,
      branch,
      id,
      parentId !== undefined ? { expected: parentId, reflogMessage } : { reflogMessage },
    );
    return;
  }
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
  await recordRefUpdate(ctx, 'HEAD' as RefName, parentId ?? ZERO_OID, id, reflogMessage);
};

interface PendingMarkers {
  readonly mergeHead: ObjectId | undefined;
  readonly cherryPickHead: ObjectId | undefined;
  readonly revertHead: ObjectId | undefined;
}

const readPendingMarkers = async (ctx: Context): Promise<PendingMarkers> => ({
  mergeHead: await readMergeHead(ctx),
  cherryPickHead: await readCherryPickHead(ctx),
  revertHead: await readRevertHead(ctx),
});

const pendingExceptOf = (m: PendingMarkers): 'merge' | 'cherry-pick' | 'revert' | undefined => {
  if (m.mergeHead !== undefined) return 'merge';
  if (m.cherryPickHead !== undefined) return 'cherry-pick';
  if (m.revertHead !== undefined) return 'revert';
  return undefined;
};

/** Clear the resolved operation's on-disk state after its commit lands. */
const clearResolvedState = async (ctx: Context, m: PendingMarkers): Promise<void> => {
  if (m.mergeHead !== undefined) {
    await clearMergeState(ctx);
    return;
  }
  if (m.cherryPickHead !== undefined) {
    await clearCherryPickHead(ctx);
    await clearMergeMsg(ctx);
    return;
  }
  if (m.revertHead !== undefined) {
    await clearRevertHead(ctx);
    await clearMergeMsg(ctx);
  }
};

const resolveCommitMessage = async (
  ctx: Context,
  opts: CommitOptions,
  usePendingDraft: boolean,
): Promise<string> => {
  if (opts.message.length > 0 || !usePendingDraft) {
    return sanitizeMessage(opts.message, { allowEmpty: opts.allowEmptyMessage ?? false });
  }
  // Resolving a merge / cherry-pick with an empty user message — fall back to
  // MERGE_MSG, stripping comment lines as git's editor cleanup does.
  const draft = await readMergeMsg(ctx);
  return sanitizeMessage(stripComments(draft ?? ''), {
    allowEmpty: opts.allowEmptyMessage ?? false,
  });
};

/**
 * Build the catalogued reflog message for a commit: `commit (initial):` for the
 * first commit on a branch, `commit (merge):` / `commit (cherry-pick):` when
 * resolving a conflicted merge / cherry-pick, `commit:` otherwise. `<subject>`
 * is the message's first line.
 */
const commitReflogMessage = (
  message: string,
  parentId: ObjectId | undefined,
  mergeHead: ObjectId | undefined,
  cherryPickHead: ObjectId | undefined,
): string => {
  const subject = subjectLine(message);
  if (parentId === undefined) return `commit (initial): ${subject}`;
  if (mergeHead !== undefined) return `commit (merge): ${subject}`;
  if (cherryPickHead !== undefined) return `commit (cherry-pick): ${subject}`;
  return `commit: ${subject}`;
};

const buildParents = (
  parentId: ObjectId | undefined,
  mergeHead: ObjectId | undefined,
): ReadonlyArray<ObjectId> => {
  const parents: ObjectId[] = [];
  if (parentId !== undefined) parents.push(parentId);
  if (mergeHead !== undefined) parents.push(mergeHead);
  return parents;
};

const rejectUnmergedIndex = (entries: ReadonlyArray<IndexEntry>): void => {
  const unmergedPaths = new Set<FilePath>();
  for (const entry of entries) {
    if (entry.flags.stage !== 0) {
      unmergedPaths.add(entry.path);
    }
  }
  if (unmergedPaths.size > 0) {
    throw mergeHasConflicts(unmergedPaths.size, [...unmergedPaths]);
  }
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
  if (obj.type !== 'commit') return ZERO_OID;
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
