/**
 * git's `fmt_merge_msg` as `merge` and `pull` run it: the title over every
 * head merged, then each annotated tag's message. `merge` describes the head
 * it was given as `merge_name` does; `pull` hands over FETCH_HEAD's lines.
 */
import { configMissingValue } from '../../../domain/commands/error.js';
import { ancestorSpelling } from '../../../domain/merge/ancestor-spelling.js';
import { shortlogOrigin } from '../../../domain/merge/merge-shortlog.js';
import { formatTagMessages, type TagMessage } from '../../../domain/merge/merge-signatures.js';
import { mergeTitle } from '../../../domain/merge/merge-title.js';
import type { ObjectId, RefName, Tag } from '../../../domain/objects/index.js';
import { compilePathnameGlob } from '../../../domain/refs/ref-glob.js';
import type { Context } from '../../../ports/context.js';
import { findEntries, type LocatedConfigEntry, readConfig } from '../../primitives/config-read.js';
import { verifyCommitSignature } from '../../primitives/internal/verify-commit-signature.js';
import { readObject, readRawObject } from '../../primitives/read-object.js';
import { refResolvesForReading } from '../../primitives/resolve-ref.js';
import { settleMergeLog } from './merge-log.js';
import { dwimRefWarning } from './revision-name.js';

/** One head merged, described as a FETCH_HEAD line describes it. */
export interface MergeHead {
  readonly id: ObjectId;
  readonly description: string;
}

/** git's built-in `merge.suppressDest` list, used until the key is configured. */
const DEFAULT_SUPPRESSED = ['main', 'master'] as const;
const LOCAL_SOURCE = ' of .';
const EARLY_PART = ' (early part)';
const REF_KINDS: ReadonlyArray<readonly [prefix: string, kind: string]> = [
  ['refs/heads/', 'branch'],
  ['refs/tags/', 'tag'],
  ['refs/remotes/', 'remote-tracking branch'],
];

/** git's `merge.suppressDest` values: a valueless entry dies, an empty one clears the list. */
const suppressedPatterns = (entries: ReadonlyArray<LocatedConfigEntry>): ReadonlyArray<string> => {
  const values = entries.map((entry) => {
    if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
    return entry.value;
  });
  return values.slice(values.lastIndexOf('') + 1);
};

const readSuppressedPatterns = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const entries = await findEntries(ctx, 'merge', 'suppressDest');
  return entries.length === 0 ? DEFAULT_SUPPRESSED : suppressedPatterns(entries);
};

/** git reads `merge.suppressDest` with its other merge settings, before merging. */
export const assertMergeMessageConfig = async (ctx: Context): Promise<void> => {
  await readSuppressedPatterns(ctx);
  await settleMergeLog(ctx, undefined);
};

/** The branch the title merges into, or `undefined` when a pattern suppresses it. */
const destination = async (ctx: Context, branch: string): Promise<string | undefined> => {
  const patterns = await readSuppressedPatterns(ctx);
  const suppressed = patterns.some((pattern) => compilePathnameGlob(pattern)(branch));
  return suppressed ? undefined : branch;
};

/** What `fmt_merge_msg_sigs` notes when `check_signature` gives no report. */
const VERIFICATION_FAILED = 'gpg verification failed.\n';
const ENCODER = new TextEncoder();

/**
 * git's `check_signature` over a signed tag: a tag naming no tagger fails
 * before any verifier runs; otherwise the verifier's own report.
 */
const signatureReport = async (ctx: Context, tag: Tag, signature: string): Promise<string> => {
  if (tag.data.tagger === undefined) return VERIFICATION_FAILED;
  const raw = (await readRawObject(ctx, tag.id)).content;
  const payload = raw.subarray(0, raw.length - ENCODER.encode(signature).length);
  const { gpg } = await readConfig(ctx);
  const verdict = await verifyCommitSignature(ctx, {
    payload,
    signature,
    ...(gpg === undefined ? {} : { gpg }),
  });
  return verdict.output;
};

/** An annotated tag merged, its signature and verifier report beneath its message. */
const tagMessage = async (ctx: Context, head: MergeHead): Promise<TagMessage | undefined> => {
  const object = await readObject(ctx, head.id);
  if (object.type !== 'tag') return undefined;
  const origin = shortlogOrigin(head.description).name;
  const { message, gpgSignature } = object.data;
  if (gpgSignature === undefined) return { origin, body: message };
  const report = await signatureReport(ctx, object, gpgSignature);
  return { origin, body: message, signature: `${gpgSignature}${report}` };
};

/** git's `fmt_merge_msg_sigs` over every head merged. */
const tagMessages = async (ctx: Context, heads: ReadonlyArray<MergeHead>): Promise<string> => {
  const tags = await Promise.all(heads.map((head) => tagMessage(ctx, head)));
  return formatTagMessages(tags.filter((tag): tag is TagMessage => tag !== undefined));
};

/** git's `fmt_merge_msg_title`: the title over every head merged into `branch`. */
const titleLine = async (
  ctx: Context,
  heads: ReadonlyArray<MergeHead>,
  branch: string,
): Promise<string> => {
  const title = mergeTitle(
    heads.map((head) => head.description),
    await destination(ctx, branch),
  );
  return `${title}\n`;
};

/**
 * git's `fmt_merge_msg`: the message a merge of `heads` into `branch` records —
 * the caller's `message` in place of the title when given — then each tag's.
 */
export const formatMergeMessage = async (
  ctx: Context,
  heads: ReadonlyArray<MergeHead>,
  branch: string,
  message?: string,
): Promise<string> => {
  const lead = message ?? (await titleLine(ctx, heads, branch));
  return `${lead}${await tagMessages(ctx, heads)}`;
};

/** The kind `merge_name` labels a ref with, when it is one it labels. */
const refKind = (ref: string): string | undefined =>
  REF_KINDS.find(([prefix]) => ref.startsWith(prefix))?.[1];

/** git's `merge_name` of `<branch>^…` / `<branch>~<n>`: the branch it steps back along. */
const describeAncestorSpelling = async (
  ctx: Context,
  name: string,
  commit: ObjectId,
): Promise<MergeHead | undefined> => {
  const spelling = ancestorSpelling(name);
  if (spelling === undefined) return undefined;
  if (!(await refResolvesForReading(ctx, `refs/heads/${spelling.branch}` as RefName))) {
    return undefined;
  }
  const part = spelling.early ? EARLY_PART : '';
  return { id: commit, description: `branch '${spelling.branch}'${part}${LOCAL_SOURCE}` };
};

/**
 * git's `merge_name`: a name that is a branch, tag or remote-tracking ref is
 * described as one of `.`, with the ref's own (unpeeled) id; an ancestor
 * spelling of a branch as that branch; any other name for a tag object as a
 * tag; anything else as the commit it resolved to. `object` is what the name
 * resolved to before peeling — only a tag peels to a different commit.
 */
export const describeMergeHead = async (
  ctx: Context,
  name: string,
  commit: ObjectId,
  object: ObjectId = commit,
): Promise<MergeHead> => {
  const found = await dwimRefWarning(ctx, name);
  const kind = found === undefined ? undefined : refKind(found.ref);
  if (found !== undefined && kind !== undefined) {
    return { id: found.id, description: `${kind} '${name}'${LOCAL_SOURCE}` };
  }
  const ancestor = await describeAncestorSpelling(ctx, name, commit);
  if (ancestor !== undefined) return ancestor;
  if (object !== commit) return { id: object, description: `tag '${name}'` };
  return { id: commit, description: `commit '${name}'` };
};
