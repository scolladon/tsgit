import { formatPlaceholderUnsupported } from '../../../domain/commands/error.js';
import { type MailmapIndex, mapUser } from '../../../domain/mailmap/index.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import { type CommitView, parseCommitView } from '../../../domain/pretty/commit-view.js';
import type { Decoration } from '../../../domain/pretty/decorations.js';
import type { DescribeArgs } from '../../../domain/pretty/describe-placeholder.js';
import { expandFormatSubst } from '../../../domain/pretty/format-subst.js';
import { signatureHeaderFor, splitSignedCommit } from '../../../domain/pretty/signed-commit.js';
import {
  type AbbrevKind,
  type FormatBudget,
  type FormatEnv,
  type FormatRequirements,
  formatCommit,
  formatRequirements,
  type SignatureCheck,
  scanPlaceholders,
  type Token,
} from '../../../domain/pretty/user-format.js';
import type { Context } from '../../../ports/context.js';
import { abbreviateObjectId } from '../../primitives/abbreviate-object-id.js';
import { readConfig } from '../../primitives/config-read.js';
import { readMailmap } from '../../primitives/internal/read-mailmap.js';
import { loadRefDecorations } from '../../primitives/internal/ref-decorations.js';
import { verifyCommitSignature } from '../../primitives/internal/verify-commit-signature.js';
import { readRawObject } from '../../primitives/read-object.js';
import { describeForFormat } from './archive-describe.js';

/** Expands an `export-subst` file's `$Format:…$` occurrences against the archived commit. */
export interface SubstExpander {
  readonly expandFile: (content: Uint8Array) => Promise<Uint8Array>;
}

interface Occurrence {
  readonly tokens: ReadonlyArray<Token>;
  readonly budget: FormatBudget;
  readonly requirements: FormatRequirements;
}

interface ArchivedCommit {
  readonly raw: Uint8Array;
  readonly view: CommitView;
}

interface Clock {
  readonly nowSeconds: number;
  readonly localOffsetMinutes: number;
}

/** Per-archive memoised reads: each runs at most once, and only when a placeholder asks. */
interface Resolvers {
  readonly commit: () => Promise<ArchivedCommit>;
  readonly abbreviation: (kind: AbbrevKind) => Promise<string>;
  readonly mailmap: () => Promise<MailmapIndex>;
  readonly decorations: () => Promise<ReadonlyArray<Decoration>>;
  readonly signature: () => Promise<SignatureCheck | undefined>;
}

const ONE_DESCRIBE_PER_ARCHIVE: FormatBudget = { describe: 1 };
const SPENT: FormatBudget = { describe: 0 };
const MILLISECONDS_PER_SECOND = 1000;

const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load();
    return pending;
  };
};

/** git reads the clock once per archive; the local offset is the one in force at that instant. */
const readClock = (): Clock => {
  const now = Date.now();
  return {
    nowSeconds: Math.floor(now / MILLISECONDS_PER_SECOND),
    localOffsetMinutes: -new Date(now).getTimezoneOffset(),
  };
};

const loadCommit = async (ctx: Context, commitId: ObjectId): Promise<ArchivedCommit> => {
  const { content } = await readRawObject(ctx, commitId);
  return { raw: content, view: parseCommitView(content) };
};

/** The commit and tree ids the archive already resolved; parents come from the commit itself. */
export interface ArchivedIds {
  readonly commit: ObjectId;
  readonly tree: ObjectId;
}

const ABBREV_KINDS: ReadonlyArray<AbbrevKind> = ['commit', 'tree', 'parents'];

const idsOf = (kind: AbbrevKind, ids: ArchivedIds, view: CommitView): ReadonlyArray<string> =>
  kind === 'parents' ? view.parents : [ids[kind]];

const abbreviateAll = async (ctx: Context, ids: ReadonlyArray<string>): Promise<string> => {
  const abbreviated: string[] = [];
  for (const id of ids) abbreviated.push(await abbreviateObjectId(ctx, id as ObjectId));
  return abbreviated.join(' ');
};

/** `check_commit_signature`: an unsigned commit is never handed to a verifier. */
const verifySignature = async (
  ctx: Context,
  raw: Uint8Array,
): Promise<SignatureCheck | undefined> => {
  const signed = splitSignedCommit(raw, signatureHeaderFor(ctx.hashConfig.algorithm));
  if (signed === undefined) return undefined;
  const { gpg } = await readConfig(ctx);
  const signature = new TextDecoder().decode(signed.signature);
  return verifyCommitSignature(ctx, {
    payload: signed.payload,
    signature,
    ...(gpg === undefined ? {} : { gpg }),
  });
};

const createResolvers = (ctx: Context, ids: ArchivedIds): Resolvers => {
  const commitId = ids.commit;
  const commit = once(() => loadCommit(ctx, commitId));
  const abbreviations = new Map<AbbrevKind, Promise<string>>();
  const abbreviateKind = async (kind: AbbrevKind): Promise<string> =>
    abbreviateAll(ctx, idsOf(kind, ids, (await commit()).view));
  return {
    commit,
    abbreviation: (kind) => {
      const pending = abbreviations.get(kind) ?? abbreviateKind(kind);
      abbreviations.set(kind, pending);
      return pending;
    },
    mailmap: once(() => readMailmap(ctx)),
    decorations: once(async () => (await loadRefDecorations(ctx)).get(commitId) ?? []),
    signature: once(async () => verifySignature(ctx, (await commit()).raw)),
  };
};

/** Scans every occurrence up front: the describe budget flows through them in file order. */
const scanOccurrences = (
  content: Uint8Array,
  budget: FormatBudget,
): { readonly occurrences: ReadonlyArray<Occurrence>; readonly budget: FormatBudget } => {
  const occurrences: Occurrence[] = [];
  let remaining = budget;
  expandFormatSubst(content, (accumulated, fmt) => {
    const tokens = scanPlaceholders(fmt, remaining);
    const requirements = formatRequirements(tokens);
    occurrences.push({ tokens, budget: remaining, requirements });
    if (requirements.describe) remaining = SPENT;
    return { bytes: accumulated, parsedHeader: false, encoding: undefined };
  });
  return { occurrences, budget: remaining };
};

const anyRequires = (
  occurrences: ReadonlyArray<Occurrence>,
  need: 'mailmap' | 'decorations' | 'signature',
): boolean => occurrences.some(({ requirements }) => requirements[need]);

const describeArgsOf = (occurrences: ReadonlyArray<Occurrence>): DescribeArgs | undefined =>
  occurrences.find(({ requirements }) => requirements.describe?.args)?.requirements.describe?.args;

/** Only the kinds a placeholder asks for are abbreviated; the others are never read. */
const resolveAbbreviations = async (
  resolvers: Resolvers,
  occurrences: ReadonlyArray<Occurrence>,
): Promise<Readonly<Record<AbbrevKind, string>>> => {
  const kinds = new Set(occurrences.flatMap(({ requirements }) => [...requirements.abbrev]));
  const resolved = { commit: '', tree: '', parents: '' };
  for (const kind of ABBREV_KINDS.filter((candidate) => kinds.has(candidate))) {
    resolved[kind] = await resolvers.abbreviation(kind);
  }
  return resolved;
};

/** The env members only some placeholders read, each resolved only when one asks. */
const resolveOptional = async (
  ctx: Context,
  commitId: ObjectId,
  resolvers: Resolvers,
  occurrences: ReadonlyArray<Occurrence>,
): Promise<Partial<FormatEnv>> => {
  const describeArgs = describeArgsOf(occurrences);
  const signature = anyRequires(occurrences, 'signature') ? await resolvers.signature() : undefined;
  const index = anyRequires(occurrences, 'mailmap') ? await resolvers.mailmap() : undefined;
  return {
    ...(index === undefined ? {} : { mapUser: (ident) => mapUser(index, ident) }),
    ...(anyRequires(occurrences, 'decorations')
      ? { decorations: await resolvers.decorations() }
      : {}),
    ...(signature === undefined ? {} : { signature }),
    ...(describeArgs === undefined
      ? {}
      : { describe: await describeForFormat(ctx, commitId, describeArgs) }),
  };
};

const resolveEnv = async (
  ctx: Context,
  commitId: ObjectId,
  resolvers: Resolvers,
  occurrences: ReadonlyArray<Occurrence>,
  clock: Clock,
): Promise<FormatEnv> => {
  const abbreviations = await resolveAbbreviations(resolvers, occurrences);
  const { trailer } = await readConfig(ctx);
  return {
    ...clock,
    commitId,
    abbrev: (kind) => abbreviations[kind],
    ...(trailer === undefined ? {} : { trailer }),
    ...(await resolveOptional(ctx, commitId, resolvers, occurrences)),
  };
};

const expandOccurrences = (
  content: Uint8Array,
  occurrences: ReadonlyArray<Occurrence>,
  view: CommitView,
  env: FormatEnv,
): Uint8Array => {
  let index = 0;
  return expandFormatSubst(content, (accumulated) => {
    const { tokens, budget } = occurrences[index++] as Occurrence;
    const result = formatCommit(tokens, view, env, budget, accumulated);
    if ('refused' in result) throw formatPlaceholderUnsupported(result.refused);
    return { bytes: result.bytes, parsedHeader: result.parsedHeader, encoding: view.encoding };
  });
};

/**
 * git's per-archive `format_subst` state: one clock reading, one describe run, and the
 * commit read only once a file actually holds a `$Format:` occurrence.
 */
export const createSubstExpander = (ctx: Context, ids: ArchivedIds): SubstExpander => {
  const commitId = ids.commit;
  const clock = readClock();
  const resolvers = createResolvers(ctx, ids);
  let budget = ONE_DESCRIBE_PER_ARCHIVE;
  return {
    expandFile: async (content) => {
      const scanned = scanOccurrences(content, budget);
      budget = scanned.budget;
      if (scanned.occurrences.length === 0) return content;
      const { view } = await resolvers.commit();
      const env = await resolveEnv(ctx, commitId, resolvers, scanned.occurrences, clock);
      return expandOccurrences(content, scanned.occurrences, view, env);
    },
  };
};
