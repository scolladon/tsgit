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
import { splitAgainstParent } from '../../domain/blame/split-blame.js';
import type { BlameEntry } from '../../domain/blame/types.js';
import { invalidOption, pathNotInTree, worktreeFileAbsent } from '../../domain/commands/error.js';
import { BinaryHeap } from '../../domain/commit/binary-heap.js';
import { precedes, type QueueEntry } from '../../domain/commit/priority-queue.js';
import { diffLines, splitLines } from '../../domain/diff/line-diff.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../domain/objects/index.js';
import { FilePath as FilePathFactory } from '../../domain/objects/object-id.js';
import { validateWorkingTreePath } from '../../domain/working-tree-path.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import { findTreeEntry } from '../primitives/internal/resolve-tree-path.js';
import { readBlob } from '../primitives/read-blob.js';
import { readIndex } from '../primitives/read-index.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { readCommitData } from './internal/history-rewrite.js';
import { assertOperationalRepository } from './internal/repo-state.js';

const LINK_ENCODER = new TextEncoder();

export interface BlameOptions {
  /** Commit-ish to blame as-of (default: HEAD). Mutually exclusive with `worktree`. */
  readonly rev?: string;
  /**
   * Blame the working-tree content instead of a committed revision (git's bare
   * `git blame <file>`): lines matching the committed history blame to their real
   * commits, uncommitted lines to the "Not Committed Yet" pseudo-commit
   * (`committed: false`). Mutually exclusive with `rev`; requires a working tree.
   */
  readonly worktree?: boolean;
  /**
   * Restrict the reported lines to a 1-based inclusive `[start, end]` window over
   * the final file (git's `-L`). `end` past the last line is clamped; a start
   * below 1, a start past the last line, or an inverted/non-integer range refuse.
   */
  readonly range?: { readonly start: number; readonly end: number };
}

/** Fields shared by every blamed line, committed or not. */
export interface BlameLineBase {
  /** 1-based line number in the queried file. */
  readonly finalLine: number;
  /** 1-based line number in the originating blob (the queried-file position for an uncommitted line). */
  readonly sourceLine: number;
  /** Path the file had in the originating version — rename-aware. */
  readonly sourcePath: FilePath;
  /** Where the committed base lives; absent for a staged-new file (not in HEAD). */
  readonly previous?: { readonly commit: ObjectId; readonly path: FilePath };
  /** The line's bytes (newline-terminated except a final line without a trailing LF). */
  readonly content: Uint8Array;
}

/** A line blamed to a real commit. */
export interface CommittedBlameLine extends BlameLineBase {
  readonly committed: true;
  /** Commit this line is blamed to. */
  readonly commit: ObjectId;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  /** Commit subject (first message line). */
  readonly summary: string;
  /** Blamed commit is a root (no parents). */
  readonly boundary: boolean;
}

/**
 * A line not yet committed — git's zero-oid "Not Committed Yet" pseudo-commit.
 * The library emits none of git's fabricated oid / identity / timestamp / summary
 * (those are the caller's to render); `committed: false` losslessly signals it.
 */
export interface UncommittedBlameLine extends BlameLineBase {
  readonly committed: false;
}

export type BlameLine = CommittedBlameLine | UncommittedBlameLine;

export interface BlameResult {
  /** The queried path (final name). */
  readonly path: FilePath;
  readonly lines: ReadonlyArray<BlameLine>;
}

/** A suspect (commit, path) with its blob and the lines still blamed on it. */
interface Suspect {
  readonly commit: ObjectId;
  readonly path: FilePath;
  readonly blob: Uint8Array;
  readonly blobId: ObjectId;
  readonly entries: ReadonlyArray<BlameEntry>;
}

interface Scoreboard {
  readonly ctx: Context;
  readonly queue: BinaryHeap<QueueEntry<Suspect>>;
  readonly finalized: BlameLine[];
}

const DEFAULT_REV = 'HEAD';

export const blame = async (
  ctx: Context,
  path: string,
  opts: BlameOptions = {},
): Promise<BlameResult> => {
  await assertOperationalRepository(ctx);
  const filePath = FilePathFactory.from(path);
  const board: Scoreboard = {
    ctx,
    queue: new BinaryHeap<QueueEntry<Suspect>>(precedes),
    finalized: [],
  };
  if (opts.worktree === true) {
    if (opts.rev !== undefined) {
      throw invalidOption('worktree', 'cannot combine with a revision');
    }
    await seedWorkingTree(board, filePath);
  } else {
    const rev = opts.rev ?? DEFAULT_REV;
    await seed(board, await resolveCommitIsh(ctx, rev), filePath, rev);
  }
  await walk(board);
  const lines = [...board.finalized].sort((a, b) => a.finalLine - b.finalLine);
  return { path: filePath, lines: applyRange(lines, opts.range) };
};

/**
 * Seed the working-tree pseudo-commit (git's bare `git blame <file>`). Resolves
 * HEAD first (an unborn HEAD refuses here, as git does), reads the working file,
 * then diffs it against HEAD's blob: lines common with HEAD enter the committed
 * walk; lines that differ (or the whole file when the path is staged-new) finalize
 * as uncommitted. A path absent from both HEAD and the index is untracked → refuse.
 */
const seedWorkingTree = async (sb: Scoreboard, path: FilePath): Promise<void> => {
  // Worktree mode reads the file from disk, so the path is constrained to the
  // repository (rejects `..`, absolute paths, and `.git`) before any FS access —
  // committed-rev mode is unaffected (it resolves paths through the object tree).
  validateWorkingTreePath(path);
  const head = await resolveCommitIsh(sb.ctx, DEFAULT_REV);
  const data = await readCommitData(sb.ctx, head);
  const workingBlob = await readWorkingFile(sb.ctx, path);
  const count = splitLines(workingBlob).length;
  // equivalent-mutant: count===0 only for an empty working file; without the guard a
  // zero-count entry flows through splitAgainstParent/finalize and yields no lines — the
  // same empty result (mirrors the committed-rev seed guard below).
  if (count === 0) return;
  const whole: ReadonlyArray<BlameEntry> = [{ finalStart: 0, count, sourceStart: 0 }];
  const headEntry = await blobEntryAtPath(sb.ctx, data.tree, path);
  if (headEntry !== undefined) {
    const { passed, kept } = splitAgainstParent(whole, diffLines(headEntry.content, workingBlob));
    schedule(sb, head, path, data.committer.timestamp, headEntry.content, headEntry.id, passed);
    finalizeUncommitted(sb, path, workingBlob, kept, { commit: head, path });
    return;
  }
  const index = await readIndex(sb.ctx);
  if (index.entries.some((entry) => entry.path === path)) {
    finalizeUncommitted(sb, path, workingBlob, whole, undefined);
    return;
  }
  throw pathNotInTree(DEFAULT_REV, path);
};

/** Read the working-tree file's bytes (symlink → its target); absent → refuse like git's `Cannot lstat`. */
const readWorkingFile = async (ctx: Context, path: FilePath): Promise<Uint8Array> => {
  const absPath = joinPath(ctx.layout.workDir, path);
  const stat = await ctx.fs.lstat(absPath).catch(() => undefined);
  if (stat === undefined) throw worktreeFileAbsent(path);
  return stat.isSymbolicLink
    ? LINK_ENCODER.encode(await ctx.fs.readlink(absPath))
    : ctx.fs.read(absPath);
};

/** Finalize lines to the zero-oid "Not Committed Yet" pseudo-commit (`committed: false`). */
const finalizeUncommitted = (
  sb: Scoreboard,
  path: FilePath,
  blob: Uint8Array,
  entries: ReadonlyArray<BlameEntry>,
  previous: BlameLine['previous'],
): void => {
  const lines = splitLines(blob);
  for (const entry of entries) {
    for (const offset of offsets(entry.count)) {
      sb.finalized.push({ committed: false, ...baseLine(entry, offset, lines, path, previous) });
    }
  }
};

/** Filter to a 1-based inclusive line window, clamping `end` and refusing bad bounds. */
const applyRange = (
  lines: ReadonlyArray<BlameLine>,
  range: BlameOptions['range'],
): ReadonlyArray<BlameLine> => {
  if (range === undefined) return lines;
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw invalidOption('-L', 'line numbers must be integers');
  }
  if (start < 1) throw invalidOption('-L', `invalid line number: ${start}`);
  if (start > lines.length) throw invalidOption('-L', `file has only ${lines.length} lines`);
  if (end < start) throw invalidOption('-L', `range end ${end} precedes start ${start}`);
  const last = Math.min(end, lines.length);
  return lines.filter((line) => line.finalLine >= start && line.finalLine <= last);
};

const seed = async (
  sb: Scoreboard,
  commit: ObjectId,
  path: FilePath,
  rev: string,
): Promise<void> => {
  const data = await readCommitData(sb.ctx, commit);
  const entry = await blobEntryAtPath(sb.ctx, data.tree, path);
  if (entry === undefined) throw pathNotInTree(rev, path);
  const count = splitLines(entry.content).length;
  // equivalent-mutant: count===0 only for an empty blob (no lines to blame); without
  // the guard a zero-count entry is scheduled and finalizes nothing — same empty result.
  if (count === 0) return;
  schedule(sb, commit, path, data.committer.timestamp, entry.content, entry.id, [
    { finalStart: 0, count, sourceStart: 0 },
  ]);
};

const walk = async (sb: Scoreboard): Promise<void> => {
  while (sb.queue.size() > 0) {
    const { value } = sb.queue.pop() as QueueEntry<Suspect>;
    await processSuspect(sb, value);
  }
};

const processSuspect = async (sb: Scoreboard, suspect: Suspect): Promise<void> => {
  const data = await readCommitData(sb.ctx, suspect.commit);
  const childLines = splitLines(suspect.blob);
  let remaining = suspect.entries;
  let previous: BlameLine['previous'];
  for (const parent of data.parents) {
    const resolved = await resolveInParent(sb.ctx, parent, data.tree, suspect.path, suspect.blobId);
    if (resolved === undefined) continue;
    previous ??= { commit: parent, path: resolved.sourcePath };
    remaining = applyParentResolution(sb, suspect, parent, resolved, remaining);
    // equivalent-mutant: removing this short-circuit still terminates correctly —
    // remaining ancestors would be descended, but splitAgainstParent([], anyDiff) and
    // schedule(…, []) are both no-ops on an empty entry list, so the scoreboard ends
    // up byte-identical either way. The break only saves the wasted descent, timing-only.
    if (remaining.length === 0) break;
  }
  finalize(sb, suspect, data, childLines, remaining, previous);
};

/** Apply one resolved parent to the still-open lines: pass-through on TREESAME, diff otherwise. */
const applyParentResolution = (
  sb: Scoreboard,
  suspect: Suspect,
  parent: ObjectId,
  resolved: ResolvedParent,
  remaining: ReadonlyArray<BlameEntry>,
): ReadonlyArray<BlameEntry> => {
  if (resolved.kind === 'treesame') {
    schedule(
      sb,
      parent,
      resolved.sourcePath,
      resolved.date,
      suspect.blob,
      suspect.blobId,
      remaining,
    );
    return [];
  }
  const { passed, kept } = splitAgainstParent(remaining, diffLines(resolved.blob, suspect.blob));
  schedule(sb, parent, resolved.sourcePath, resolved.date, resolved.blob, resolved.blobId, passed);
  return kept;
};

const finalize = (
  sb: Scoreboard,
  suspect: Suspect,
  data: CommitData,
  childLines: ReadonlyArray<Uint8Array>,
  entries: ReadonlyArray<BlameEntry>,
  previous: BlameLine['previous'],
): void => {
  const boundary = data.parents.length === 0;
  const summary = subjectLine(data.message);
  for (const entry of entries) {
    for (const offset of offsets(entry.count)) {
      sb.finalized.push({
        committed: true,
        commit: suspect.commit,
        author: data.author,
        committer: data.committer,
        summary,
        boundary,
        ...baseLine(entry, offset, childLines, suspect.path, previous),
      });
    }
  }
};

/** The fields every blamed line shares, for one entry's offset (committed or not). */
const baseLine = (
  entry: BlameEntry,
  offset: number,
  lines: ReadonlyArray<Uint8Array>,
  sourcePath: FilePath,
  previous: BlameLine['previous'],
): BlameLineBase => ({
  finalLine: entry.finalStart + offset + 1,
  sourceLine: entry.sourceStart + offset + 1,
  sourcePath,
  ...(previous !== undefined ? { previous } : {}),
  content: lines[entry.sourceStart + offset] as Uint8Array,
});

/** `[0, 1, …, count-1]` — a range with no mutable index to invert into a hang. */
const offsets = (count: number): ReadonlyArray<number> =>
  Array.from({ length: count }, (_, index) => index);

type ResolvedParent =
  | { readonly kind: 'treesame'; readonly sourcePath: FilePath; readonly date: number }
  | {
      readonly kind: 'changed';
      readonly blob: Uint8Array;
      readonly blobId: ObjectId;
      readonly sourcePath: FilePath;
      readonly date: number;
    };

/**
 * Resolve the suspect's path in one parent. The tree-entry oid is compared to the
 * suspect's blob oid BEFORE any blob is read: an equal oid means the parent's blob
 * is byte-identical (git's content-addressing), so the diff would be a no-op — that
 * TREESAME case skips `readBlob` and the diff entirely (`kind: 'treesame'`). A
 * changed or renamed path reads the parent blob and returns it (`kind: 'changed'`).
 */
const resolveInParent = async (
  ctx: Context,
  parent: ObjectId,
  childTree: ObjectId,
  path: FilePath,
  suspectBlobId: ObjectId,
): Promise<ResolvedParent | undefined> => {
  const data = await readCommitData(ctx, parent);
  const date = data.committer.timestamp;
  const entry = await blobTreeEntry(ctx, data.tree, path);
  if (entry !== undefined) {
    if (entry.id === suspectBlobId) return { kind: 'treesame', sourcePath: path, date };
    const blob = (await readBlob(ctx, entry.id)).content;
    return { kind: 'changed', blob, blobId: entry.id, sourcePath: path, date };
  }
  const renamed = await renamedSource(ctx, data.tree, childTree, path);
  if (renamed === undefined) return undefined;
  const blob = (await readBlob(ctx, renamed.blobId)).content;
  return { kind: 'changed', blob, blobId: renamed.blobId, sourcePath: renamed.sourcePath, date };
};

/**
 * When `path` is absent from the parent, locate the file it was renamed from.
 * Reuses the shared exact-content rename detector — a pure `git mv` is followed,
 * a rename-with-edit in the same commit is not (treated as a fresh introduction).
 */
const renamedSource = async (
  ctx: Context,
  parentTree: ObjectId,
  childTree: ObjectId,
  path: FilePath,
): Promise<{ readonly sourcePath: FilePath; readonly blobId: ObjectId } | undefined> => {
  const diff = await diffTrees(ctx, parentTree, childTree, {
    recursive: true,
    detectRenames: true,
  });
  for (const change of diff.changes) {
    if (change.type === 'rename' && change.newPath === path) {
      return { sourcePath: change.oldPath, blobId: change.oldId };
    }
  }
  return undefined;
};

/** Queue a suspect for the lines now blamed on it (newest commit date pops first). */
const schedule = (
  sb: Scoreboard,
  commit: ObjectId,
  path: FilePath,
  date: number,
  blob: Uint8Array,
  blobId: ObjectId,
  entries: ReadonlyArray<BlameEntry>,
): void => {
  // equivalent-mutant: an empty entry list would enqueue a suspect that finalizes
  // nothing; the guard only avoids needlessly walking ancestors, so output is identical.
  if (entries.length === 0) return;
  sb.queue.push({ oid: commit, date, value: { commit, path, blob, blobId, entries } });
};

/** Descend to `path`'s tree entry, rejecting a non-blob leaf (directory/gitlink) as absent. */
const blobTreeEntry = async (
  ctx: Context,
  tree: ObjectId,
  path: FilePath,
): ReturnType<typeof findTreeEntry> => {
  const entry = await findTreeEntry(ctx, tree, path);
  if (entry === undefined) return undefined;
  if (entry.mode === FILE_MODE.DIRECTORY || entry.mode === FILE_MODE.GITLINK) return undefined;
  return entry;
};

/** Descend to `path`'s blob, returning its bytes AND oid together (seed sites need both). */
const blobEntryAtPath = async (
  ctx: Context,
  tree: ObjectId,
  path: FilePath,
): Promise<{ readonly id: ObjectId; readonly content: Uint8Array } | undefined> => {
  const entry = await blobTreeEntry(ctx, tree, path);
  if (entry === undefined) return undefined;
  return { id: entry.id, content: (await readBlob(ctx, entry.id)).content };
};
