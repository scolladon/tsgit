/**
 * git's `get_oid_basic` refname-ambiguity warning: a name found in more than
 * one gitrevisions namespace, or as both a ref and a unique abbreviated
 * object id, warns `refname '<name>' is ambiguous.`; a full object id that a
 * ref also names warns the same, followed by the object-name advice.
 * `core.warnAmbiguousRefs` (default on) turns the check off, and with it
 * `dwim_ref` stops at the first namespace that resolves. git reads that
 * setting lazily — only once a namespace resolves, or for a full object id —
 * and dies on a malformed value (`repo_cfg_bool`).
 */
import { configBadBooleanValue } from '../../../domain/commands/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { refCandidates } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';
import {
  findLastEntries,
  type LocatedConfigEntry,
  parseGitBoolean,
} from '../../primitives/config-read.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import type { RefCandidateOutcome } from '../../primitives/resolve-ref.js';

/** One candidate namespace as `expand_ref` reads it. */
export type CandidateResolver = (candidate: RefName | 'HEAD') => Promise<RefCandidateOutcome>;

const OBJECT_NAME_ADVICE = [
  'Git normally never creates a ref that ends with 40 hex characters',
  'because it will be ignored when you just specify 40-hex. These refs',
  'may be created by mistake. For example,',
  '',
  '  git switch -c $br $(git rev-parse ...)',
  '',
  'where "$br" is somehow empty and a 40-hex ref is created. Please',
  'examine these refs and maybe delete them. Turn this message off by',
  'running "git config set advice.objectNameWarning false"',
].join('\n');

interface AmbiguitySettings {
  readonly warns: boolean;
  readonly advises: boolean;
}

/** An advice setting git defaults on; a malformed value reads as on here. */
const enabled = (entry: LocatedConfigEntry | undefined): boolean => {
  if (entry === undefined) return true;
  const parsed = parseGitBoolean(entry.value);
  return !parsed.ok || parsed.value;
};

/** git's `repo_cfg_bool` read of `core.warnAmbiguousRefs`: default on, a malformed value refused. */
const warnsOnAmbiguity = (entry: LocatedConfigEntry | undefined): boolean => {
  if (entry?.value == null) return true;
  const parsed = parseGitBoolean(entry.value);
  if (parsed.ok) return parsed.value;
  throw configBadBooleanValue(entry.key, entry.source, entry.value);
};

const readSettings = async (ctx: Context): Promise<AmbiguitySettings> => {
  const [warns, advises] = await findLastEntries(ctx, [
    ['core', 'warnAmbiguousRefs'],
    ['advice', 'objectNameWarning'],
  ]);
  return { warns: warnsOnAmbiguity(warns), advises: enabled(advises) };
};

const warnAmbiguous = (ctx: Context, name: string): void => {
  ctx.logger?.warn?.(`refname '${name}' is ambiguous.`, { refname: name });
};

/** git's `expand_ref` warning for a candidate it skips: a dangling symref
 *  other than `HEAD`, or a broken ref below a directory. */
const warnSkipped = (ctx: Context, candidate: RefName | 'HEAD', kind: string): void => {
  if (kind === 'dangling-symref' && candidate !== 'HEAD')
    ctx.logger?.warn?.(`ignoring dangling symref ${candidate}`, { refname: candidate });
  else if (kind === 'broken' && candidate.includes('/'))
    ctx.logger?.warn?.(`ignoring broken ref ${candidate}`, { refname: candidate });
};

/** One candidate's object id, warning as `expand_ref` does when it skips it. */
const readCandidate = async (
  ctx: Context,
  candidate: RefName | 'HEAD',
  resolve: CandidateResolver,
): Promise<ObjectId | undefined> => {
  const outcome = await resolve(candidate);
  if (outcome.kind === 'found') return outcome.id;
  warnSkipped(ctx, candidate, outcome.kind);
  return undefined;
};

/** How many of `candidates` resolve, each read in order. */
const countResolving = async (
  ctx: Context,
  candidates: ReadonlyArray<RefName | 'HEAD'>,
  resolve: CandidateResolver,
): Promise<number> => {
  let count = 0;
  for (const candidate of candidates) {
    if ((await readCandidate(ctx, candidate, resolve)) !== undefined) count += 1;
  }
  return count;
};

/**
 * git's `dwim_ref` under `get_oid_basic`: the first namespace `name`
 * resolves in wins. Only then is the check's setting read; with the check
 * on, every later namespace is read too and the ambiguity warned before the
 * id is returned.
 */
export const resolveRefLadder = async (
  ctx: Context,
  name: string,
  resolve: CandidateResolver,
): Promise<ObjectId | undefined> => {
  const candidates = refCandidates(name);
  for (const [index, candidate] of candidates.entries()) {
    const id = await readCandidate(ctx, candidate, resolve);
    if (id === undefined) continue;
    const { warns } = await readSettings(ctx);
    if (!warns) return id;
    const othersFound = await countResolving(ctx, candidates.slice(index + 1), resolve);
    if (await isAmbiguous(ctx, name, othersFound)) warnAmbiguous(ctx, name);
    return id;
  }
  return undefined;
};

/** git's check once one namespace resolved: another namespace, or a unique abbreviation, also names it. */
const isAmbiguous = async (ctx: Context, name: string, othersFound: number): Promise<boolean> =>
  othersFound > 0 || (await isUniqueAbbreviation(ctx, name));

/** git's quiet `get_short_oid`: a prefix more than one object shares names none of them. */
const isUniqueAbbreviation = async (ctx: Context, name: string): Promise<boolean> => {
  try {
    return (await resolveOidPrefix(ctx, name)) !== undefined;
  } catch (error) {
    if (errorDataCode(error) === 'AMBIGUOUS_OID_PREFIX') return false;
    throw error;
  }
};

/** git's full-object-id branch: the object id wins, but a ref of that name warns, then advises. */
export const warnIfRefNamesObjectId = async (
  ctx: Context,
  name: string,
  resolve: CandidateResolver,
): Promise<void> => {
  const { warns, advises } = await readSettings(ctx);
  if (!warns) return;
  if ((await countResolving(ctx, refCandidates(name), resolve)) === 0) return;
  warnAmbiguous(ctx, name);
  if (advises) ctx.logger?.warn?.(OBJECT_NAME_ADVICE);
};
