/**
 * git's `get_oid_basic` refname-ambiguity warning: a name found in more than
 * one gitrevisions namespace, or as both a ref and a unique abbreviated
 * object id, warns `refname '<name>' is ambiguous.`; a full object id that a
 * ref also names warns the same, followed by the object-name advice.
 * `core.warnAmbiguousRefs` (default on) turns the check off, and with it
 * `dwim_ref` stops at the first namespace that resolves.
 */
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

/** One candidate namespace's object id, or `undefined` when it is not this name. */
export type CandidateResolver = (candidate: RefName | 'HEAD') => Promise<ObjectId | undefined>;

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

/** A boolean setting git defaults on; a malformed value reads as on here, its refusal is git's repo-settings prologue. */
const enabled = (entry: LocatedConfigEntry | undefined): boolean => {
  if (entry === undefined) return true;
  const parsed = parseGitBoolean(entry.value);
  return !parsed.ok || parsed.value;
};

const readSettings = async (ctx: Context): Promise<AmbiguitySettings> => {
  const [warns, advises] = await findLastEntries(ctx, [
    ['core', 'warnAmbiguousRefs'],
    ['advice', 'objectNameWarning'],
  ]);
  return { warns: enabled(warns), advises: enabled(advises) };
};

const warnAmbiguous = (ctx: Context, name: string): void => {
  ctx.logger?.warn?.(`refname '${name}' is ambiguous.`, { refname: name });
};

/**
 * git's `dwim_ref` under `get_oid_basic`: the first namespace `name`
 * resolves in wins. With the check on, every namespace is read and the
 * ambiguity warned before the id is returned.
 */
export const resolveRefLadder = async (
  ctx: Context,
  name: string,
  resolve: CandidateResolver,
): Promise<ObjectId | undefined> => {
  const { warns } = await readSettings(ctx);
  const found: ObjectId[] = [];
  for (const candidate of refCandidates(name)) {
    const id = await resolve(candidate);
    if (id === undefined) continue;
    found.push(id);
    if (!warns) break;
  }
  if (warns && (await isAmbiguous(ctx, name, found.length))) warnAmbiguous(ctx, name);
  return found[0];
};

const isAmbiguous = async (ctx: Context, name: string, refsFound: number): Promise<boolean> =>
  refsFound > 1 || (refsFound === 1 && (await isUniqueAbbreviation(ctx, name)));

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
  for (const candidate of refCandidates(name)) {
    if ((await resolve(candidate)) === undefined) continue;
    warnAmbiguous(ctx, name);
    if (advises) ctx.logger?.warn?.(OBJECT_NAME_ADVICE);
    return;
  }
};
