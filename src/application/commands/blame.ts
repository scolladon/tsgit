/**
 * Tier-1 `blame` command — line-by-line authorship for a file at a committed
 * revision, faithful to `git blame`. Walks history backwards: for each suspect
 * commit it diffs the file against every parent, passing lines unchanged from a
 * parent down to that parent and keeping lines that differ from all parents at
 * the suspect. Lines surviving to a parentless (root) commit, or differing from
 * every parent, are blamed there.
 *
 * Returns structured data only (denormalized per line): the blamed commit, that
 * line's position in the queried file and in the commit's version, the path the
 * file had there (rename-aware), and the line content. Assembling `git blame`'s
 * `^abc1234 (Author …)` or `--porcelain` text is the caller's concern.
 */
import { enqueue, type QueueEntry } from '../../domain/blame/priority-queue.js';
import { splitAgainstParent } from '../../domain/blame/split-blame.js';
import type { BlameEntry } from '../../domain/blame/types.js';
import { pathNotInTree } from '../../domain/commands/error.js';
import { diffLines, splitLines } from '../../domain/diff/line-diff.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../domain/objects/index.js';
import { FilePath as FilePathFactory } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { flattenTree } from '../primitives/flatten-tree.js';
import { readBlob } from '../primitives/read-blob.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { readCommitData } from './internal/history-rewrite.js';
import { assertRepository } from './internal/repo-state.js';

export interface BlameOptions {
  /** Commit-ish to blame as-of (default: HEAD). */
  readonly rev?: string;
}

export interface BlameLine {
  /** 1-based line number in the queried file. */
  readonly finalLine: number;
  /** 1-based line number in the blamed commit's version of the file. */
  readonly sourceLine: number;
  /** Commit this line is blamed to. */
  readonly commit: ObjectId;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  /** Commit subject (first message line). */
  readonly summary: string;
  /** Blamed commit is a root (no parents). */
  readonly boundary: boolean;
  /** Path the file had in the blamed commit — rename-aware. */
  readonly sourcePath: FilePath;
  /** Parent the file content came from; absent on a root. */
  readonly previous?: { readonly commit: ObjectId; readonly path: FilePath };
  /** The line's bytes (newline-terminated except a final line without a trailing LF). */
  readonly content: Uint8Array;
}

export interface BlameResult {
  /** The queried path (final name). */
  readonly path: FilePath;
  readonly lines: ReadonlyArray<BlameLine>;
}

interface Origin {
  readonly commit: ObjectId;
  readonly path: FilePath;
  readonly date: number;
  readonly blob: Uint8Array;
  entries: BlameEntry[];
  inQueue: boolean;
}

interface Scoreboard {
  readonly ctx: Context;
  readonly pending: Map<string, Origin>;
  readonly queue: QueueEntry<string>[];
  readonly finalized: BlameLine[];
}

const DEFAULT_REV = 'HEAD';

export const blame = async (
  ctx: Context,
  path: string,
  opts: BlameOptions = {},
): Promise<BlameResult> => {
  await assertRepository(ctx);
  const filePath = FilePathFactory.from(path);
  const rev = opts.rev ?? DEFAULT_REV;
  const startCommit = await resolveCommitIsh(ctx, rev);
  const sut: Scoreboard = { ctx, pending: new Map(), queue: [], finalized: [] };
  await seed(sut, startCommit, filePath, rev);
  await walk(sut);
  const lines = [...sut.finalized].sort((a, b) => a.finalLine - b.finalLine);
  return { path: filePath, lines };
};

const seed = async (
  sb: Scoreboard,
  commit: ObjectId,
  path: FilePath,
  rev: string,
): Promise<void> => {
  const data = await readCommitData(sb.ctx, commit);
  const blob = await blobAtPath(sb.ctx, data.tree, path);
  if (blob === undefined) throw pathNotInTree(rev, path);
  const count = splitLines(blob).length;
  if (count === 0) return;
  addEntries(sb, commit, path, data.committer.timestamp, blob, [
    { finalStart: 0, count, sourceStart: 0 },
  ]);
};

const walk = async (sb: Scoreboard): Promise<void> => {
  while (sb.queue.length > 0) {
    const { value: key } = sb.queue.shift() as QueueEntry<string>;
    const origin = sb.pending.get(key) as Origin;
    origin.inQueue = false;
    const entries = origin.entries;
    origin.entries = [];
    await processOrigin(sb, origin, entries);
  }
};

const processOrigin = async (
  sb: Scoreboard,
  origin: Origin,
  entries: ReadonlyArray<BlameEntry>,
): Promise<void> => {
  const data = await readCommitData(sb.ctx, origin.commit);
  const childLines = splitLines(origin.blob);
  let remaining = entries;
  let previous: BlameLine['previous'];
  for (const parent of data.parents) {
    const resolved = await resolveInParent(sb.ctx, parent, origin.path);
    if (resolved === undefined) continue;
    previous ??= { commit: parent, path: resolved.sourcePath };
    const { passed, kept } = splitAgainstParent(remaining, diffLines(resolved.blob, origin.blob));
    addEntries(sb, parent, resolved.sourcePath, resolved.date, resolved.blob, passed);
    remaining = kept;
    if (remaining.length === 0) break;
  }
  finalize(sb, origin, data, childLines, remaining, previous);
};

const finalize = (
  sb: Scoreboard,
  origin: Origin,
  data: CommitData,
  childLines: ReadonlyArray<Uint8Array>,
  entries: ReadonlyArray<BlameEntry>,
  previous: BlameLine['previous'],
): void => {
  const boundary = data.parents.length === 0;
  const summary = subjectLine(data.message);
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i += 1) {
      sb.finalized.push({
        finalLine: entry.finalStart + i + 1,
        sourceLine: entry.sourceStart + i + 1,
        commit: origin.commit,
        author: data.author,
        committer: data.committer,
        summary,
        boundary,
        sourcePath: origin.path,
        ...(previous !== undefined ? { previous } : {}),
        content: childLines[entry.sourceStart + i] as Uint8Array,
      });
    }
  }
};

interface ResolvedParent {
  readonly blob: Uint8Array;
  readonly sourcePath: FilePath;
  readonly date: number;
}

const resolveInParent = async (
  ctx: Context,
  parent: ObjectId,
  path: FilePath,
): Promise<ResolvedParent | undefined> => {
  const data = await readCommitData(ctx, parent);
  const blob = await blobAtPath(ctx, data.tree, path);
  if (blob === undefined) return undefined;
  return { blob, sourcePath: path, date: data.committer.timestamp };
};

const addEntries = (
  sb: Scoreboard,
  commit: ObjectId,
  path: FilePath,
  date: number,
  blob: Uint8Array,
  entries: ReadonlyArray<BlameEntry>,
): void => {
  if (entries.length === 0) return;
  const key = `${commit}:${path}`;
  const origin = sb.pending.get(key) ?? createOrigin(sb, key, commit, path, date, blob);
  origin.entries.push(...entries);
  if (!origin.inQueue) {
    origin.inQueue = true;
    enqueue(sb.queue, { oid: commit, date, value: key });
  }
};

const createOrigin = (
  sb: Scoreboard,
  key: string,
  commit: ObjectId,
  path: FilePath,
  date: number,
  blob: Uint8Array,
): Origin => {
  const origin: Origin = { commit, path, date, blob, entries: [], inQueue: false };
  sb.pending.set(key, origin);
  return origin;
};

const blobAtPath = async (
  ctx: Context,
  tree: ObjectId,
  path: FilePath,
): Promise<Uint8Array | undefined> => {
  const flat = await flattenTree(ctx, tree);
  const entry = flat.entries.get(path);
  if (entry === undefined) return undefined;
  return (await readBlob(ctx, entry.id)).content;
};
