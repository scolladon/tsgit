/**
 * git's merge `--log[=<n>]`: how long a shortlog `merge.log` / `merge.summary`
 * (or the caller) asks for, whether `merge.branchdesc` adds descriptions, and
 * the shortlog of each head merged — the commits it brings in over `HEAD`.
 */
import {
  configBadNumericValue,
  configMissingValue,
  configNegativeLength,
} from '../../../domain/commands/error.js';
import { parseGitBoolean, parseGitBoolOrInt } from '../../../domain/config/config-ini.js';
import {
  DEFAULT_MERGE_LOG_LENGTH,
  formatShortlog,
  shortlogOrigin,
} from '../../../domain/merge/merge-shortlog.js';
import { foldSubject } from '../../../domain/objects/commit-message.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import {
  findEntries,
  findLastEntry,
  findLastSubsectionEntry,
  type LocatedConfigEntry,
} from '../../primitives/config-read.js';
import { assertValidBooleanConfig } from '../../primitives/internal/boolean-config-guard.js';
import { peelChain } from '../../primitives/internal/peel-chain.js';
import { readObject } from '../../primitives/read-object.js';
import { walkCommitsByDate } from '../../primitives/walk-commits-by-date.js';

/** A head merged, as its FETCH_HEAD line describes it. */
interface ShortlogHead {
  readonly id: ObjectId;
  readonly description: string;
}

/** The shortlog a merge message carries: `length` 0 carries none. */
export interface MergeLog {
  readonly length: number;
  readonly branchDescriptions: boolean;
}

const MERGE_SECTION = 'merge';
const LOG_KEYS = ['log', 'summary'] as const;
const BRANCH_DESC_KEY = 'branchdesc';
const NO_LOG = 0;
/** git's `isspace`, which `strbuf_ltrim` strips off a subject. */
const LEADING_SPACE = /^[ \t\n\r]+/;

/** One `merge.log` / `merge.summary` entry under `git_config_bool_or_int`; a negative length dies. */
const entryLength = (entry: LocatedConfigEntry): number => {
  const parsed = parseGitBoolOrInt(entry.value);
  const raw = entry.value ?? '';
  if (!parsed.ok) throw configBadNumericValue(entry.key, entry.source, raw, parsed.reason);
  if (parsed.isBool) return parsed.value === NO_LOG ? NO_LOG : DEFAULT_MERGE_LOG_LENGTH;
  if (parsed.value < 0) throw configNegativeLength(entry.key, raw, entry.source, entry.line);
  return parsed.value;
};

/** git's `fmt_merge_msg_config` over both keys: every entry parsed in file order, the last wins. */
const configuredLength = async (ctx: Context): Promise<number> => {
  const found = await Promise.all(LOG_KEYS.map((key) => findEntries(ctx, MERGE_SECTION, key)));
  const entries = found.flat().sort((a, b) => a.line - b.line);
  let length = NO_LOG;
  for (const entry of entries) length = entryLength(entry);
  return length;
};

/** git's `merge.branchdesc`, a boolean outside whose grammar refuses. */
const configuredBranchDescriptions = async (ctx: Context): Promise<boolean> => {
  await assertValidBooleanConfig(ctx, MERGE_SECTION, undefined, [BRANCH_DESC_KEY]);
  const entry = await findLastEntry(ctx, MERGE_SECTION, BRANCH_DESC_KEY);
  if (entry === undefined) return false;
  const parsed = parseGitBoolean(entry.value);
  return parsed.ok && parsed.value;
};

/** `--log` reads as git's default length, `--no-log` as none, a negative count as unset. */
const callerLength = (log: boolean | number | undefined): number | undefined => {
  if (typeof log === 'boolean') return log ? DEFAULT_MERGE_LOG_LENGTH : NO_LOG;
  return log === undefined || log < 0 ? undefined : log;
};

/** git reads its merge-message config before merging: the caller's `log` wins over it. */
export const settleMergeLog = async (
  ctx: Context,
  log: boolean | number | undefined,
): Promise<MergeLog> => {
  const configured = await configuredLength(ctx);
  const branchDescriptions = await configuredBranchDescriptions(ctx);
  return { length: callerLength(log) ?? configured, branchDescriptions };
};

/** git's `%s`, left-trimmed; an empty one is spelt as the commit's id. */
const subjectOf = (commit: Commit): string =>
  foldSubject(commit.data.message).replace(LEADING_SPACE, '') || commit.id;

/** Non-merge commits `tip` brings in over `head`: all counted, the first `length + 1` subjects kept. */
const walkSubjects = async (
  ctx: Context,
  tip: ObjectId,
  head: ObjectId,
  length: number,
): Promise<{ readonly count: number; readonly subjects: ReadonlyArray<string> }> => {
  let count = 0;
  const subjects: string[] = [];
  for await (const commit of walkCommitsByDate(ctx, { from: [tip], until: [head] })) {
    if (commit.data.parents.length > 1) continue;
    count += 1;
    if (subjects.length <= length) subjects.push(subjectOf(commit));
  }
  return { count, subjects };
};

/** `branch.<name>.description`, which a valueless entry refuses. */
const branchDescription = async (ctx: Context, name: string): Promise<string | undefined> => {
  const entry = await findLastSubsectionEntry(ctx, 'branch', name, 'description');
  if (entry === undefined) return undefined;
  if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
  return entry.value;
};

/** The commit a head names once its tags are peeled — merge only takes heads naming commits. */
const peeledCommit = async (ctx: Context, id: ObjectId): Promise<ObjectId> => {
  const peeled = await peelChain(ctx, id, readObject, (object) =>
    object.type === 'tag' ? object.data.object : undefined,
  );
  return peeled.id;
};

/** git's `shortlog` of one head over `head`. */
const headShortlog = async (
  ctx: Context,
  merged: ShortlogHead,
  head: ObjectId,
  log: MergeLog,
): Promise<string> => {
  const tip = await peeledCommit(ctx, merged.id);
  const origin = shortlogOrigin(merged.description);
  const walk = await walkSubjects(ctx, tip, head, log.length);
  const described = origin.localBranch && log.branchDescriptions;
  const description = described ? await branchDescription(ctx, origin.name) : undefined;
  const block = description === undefined ? walk : { ...walk, description };
  return formatShortlog({ name: origin.name, ...block }, log.length);
};

/** Every head's shortlog block, in the order the heads were merged. */
export const mergeShortlog = async (
  ctx: Context,
  heads: ReadonlyArray<ShortlogHead>,
  head: ObjectId,
  log: MergeLog,
): Promise<string> => {
  const blocks: string[] = [];
  for (const merged of heads) blocks.push(await headShortlog(ctx, merged, head, log));
  return blocks.join('');
};
