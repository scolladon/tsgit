/**
 * git's `get_ref_map`: the remote refs a fetch asks for, the local ref each
 * one updates, and how each one is listed in `FETCH_HEAD`. Command-line
 * refspecs are all for merging and update their configured tracking refs on
 * the side; without them the remote's fetch refspecs map the advertisement and
 * `branch.<current>.merge` picks the refs for merging. Tags follow when any
 * refspec stores into a ref, a negative refspec drops the remote refs it
 * names, and a local ref mapped twice keeps its first source.
 */
import {
  fetchRefspecConflict,
  invalidOption,
  remoteRefNotFound,
} from '../../../domain/commands/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { AdvertisedRef } from '../../../domain/protocol/index.js';
import { refCandidates } from '../../../domain/refs/ref-candidates.js';
import { TAGS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import { expandPattern, matchesNegativeRefspec } from './negative-refspec.js';
import { type RefspecSides, splitSides } from './refspec-grammar.js';

/** How an entry is listed in `FETCH_HEAD`; `ignore` entries only update their ref. */
export type FetchHeadStatus = 'merge' | 'not-for-merge' | 'ignore';

export interface MappedRef {
  readonly source: AdvertisedRef;
  /** The local ref the source updates, not yet checked for a valid name; none when absent. */
  readonly target: string | undefined;
  readonly status: FetchHeadStatus;
}

/** Everything `get_ref_map` reads besides the advertisement. */
export interface RefMapRequest {
  readonly cliSpecs: ReadonlyArray<string>;
  /** One `--refmap` value per entry; `['']` maps the command-line refs nowhere. */
  readonly refmap: ReadonlyArray<string>;
  readonly configSpecs: ReadonlyArray<string>;
  /** `branch.<current>.merge`, empty when that branch has no upstream remote. */
  readonly merge: ReadonlyArray<string>;
  /** Whether `branch.<current>.remote` names the remote fetched from. */
  readonly mergesFromRemote: boolean;
}

/** What the repository already holds, as tag auto-following asks it. */
export interface LocalState {
  /** Every local ref name. */
  readonly refs: ReadonlySet<string>;
  /** The advertised tag objects and their peeled targets present locally. */
  readonly objects: ReadonlySet<ObjectId>;
}

const NOTHING_LOCAL: LocalState = { refs: new Set(), objects: new Set() };

interface PlannedMap {
  readonly head: ReadonlyArray<MappedRef>;
  readonly opportunistic: ReadonlyArray<MappedRef>;
}

type MissingRef = 'refuse' | 'allow';

const STAR = '*';
const PEELED_MARK = '^';
const HEAD = 'HEAD';
const REFS_PREFIX = 'refs/';
const LOCAL_SHORT_PREFIXES = ['heads/', 'tags/', 'remotes/'] as const;
const REFMAP_WITHOUT_REFSPEC = '--refmap option is only meaningful with command-line refspec(s)';

/** git's `find_ref_by_name_abbrev`: the ref the earliest rev-parse rule names. */
const findRefByNameAbbrev = (
  refs: ReadonlyArray<AdvertisedRef>,
  name: string,
): AdvertisedRef | undefined => {
  for (const candidate of refCandidates(name)) {
    const found = refs.find((ref) => ref.name === candidate);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** git's `refname_match`: whether the abbreviation `abbrev` can stand for `full`. */
const refnameMatch = (abbrev: string, full: string): boolean =>
  refCandidates(abbrev).some((candidate) => candidate === full);

/** git's `get_local_ref`: a short destination lands under `refs/heads/`. */
const localRef = (dst: string | undefined): string | undefined => {
  if (dst === undefined || dst === '') return undefined;
  if (dst.startsWith(REFS_PREFIX)) return dst;
  if (LOCAL_SHORT_PREFIXES.some((prefix) => dst.startsWith(prefix))) return `${REFS_PREFIX}${dst}`;
  return `refs/heads/${dst}`;
};

const expandedMap = (
  { src, dst }: RefspecSides,
  refs: ReadonlyArray<AdvertisedRef>,
): ReadonlyArray<MappedRef> => {
  if (dst === undefined) return [];
  return refs
    .filter((ref) => !ref.name.includes(PEELED_MARK))
    .flatMap((source) => {
      const target = expandPattern(src, source.name, dst);
      return target === undefined ? [] : [{ source, target, status: 'not-for-merge' as const }];
    });
};

/** git's `get_fetch_map` for one refspec; an exact source is matched as an abbreviation. */
const getFetchMap = (
  refs: ReadonlyArray<AdvertisedRef>,
  sides: RefspecSides,
  missing: MissingRef,
): ReadonlyArray<MappedRef> => {
  if (sides.negative) return [];
  if (sides.src.includes(STAR)) return expandedMap(sides, refs);
  const name = sides.src === '' ? HEAD : sides.src;
  const source = findRefByNameAbbrev(refs, name);
  if (source !== undefined) {
    return [{ source, target: localRef(sides.dst), status: 'not-for-merge' }];
  }
  if (missing === 'refuse') throw remoteRefNotFound(name);
  return [];
};

const withStatus = (
  entries: ReadonlyArray<MappedRef>,
  status: FetchHeadStatus,
): ReadonlyArray<MappedRef> => entries.map((entry) => ({ ...entry, status }));

const markForMerge = (entries: ReadonlyArray<MappedRef>, index: number) =>
  entries.map((entry, at) => (at === index ? { ...entry, status: 'merge' as const } : entry));

const storesIntoRef = ({ dst }: RefspecSides): boolean => dst !== undefined && dst !== '';

const commandLineMap = (
  request: RefMapRequest,
  cli: ReadonlyArray<RefspecSides>,
  refs: ReadonlyArray<AdvertisedRef>,
): PlannedMap => {
  const head = withStatus(
    cli.flatMap((sides) => getFetchMap(refs, sides, 'refuse')),
    'merge',
  );
  const mapSpecs = request.refmap.length > 0 ? request.refmap : request.configSpecs;
  const sources = head.map((entry) => entry.source);
  const opportunistic = mapSpecs
    .map(splitSides)
    .flatMap((sides) => getFetchMap(sources, sides, 'allow'));
  return { head, opportunistic: withStatus(opportunistic, 'ignore') };
};

const mergeOne = (
  list: ReadonlyArray<MappedRef>,
  src: string,
  refs: ReadonlyArray<AdvertisedRef>,
): ReadonlyArray<MappedRef> => {
  const index = list.findIndex((entry) => refnameMatch(src, entry.source.name));
  if (index !== -1) return markForMerge(list, index);
  const fetched = getFetchMap(refs, { negative: false, src, dst: undefined }, 'allow');
  return list.concat(withStatus(fetched, 'merge'));
};

/** git's `add_merge_config`: mark the mapped ref each merge source names, or fetch it alone. */
const addMergeConfig = (
  mapped: ReadonlyArray<MappedRef>,
  merge: ReadonlyArray<string>,
  refs: ReadonlyArray<AdvertisedRef>,
): ReadonlyArray<MappedRef> => {
  let list = mapped;
  for (const src of merge) list = mergeOne(list, src, refs);
  return list;
};

/**
 * With no merge configuration, an exact first refspec is for merging: a
 * configured exact source always maps its one ref, or the fetch refused it.
 */
const markFirstForMerge = (
  first: RefspecSides | undefined,
  mapped: ReadonlyArray<MappedRef>,
): ReadonlyArray<MappedRef> => {
  if (first === undefined || first.negative || first.src.includes(STAR)) return mapped;
  return markForMerge(mapped, 0);
};

const defaultMap = (request: RefMapRequest, refs: ReadonlyArray<AdvertisedRef>): PlannedMap => {
  const hasMerge = request.merge.length > 0;
  const mergesHere = hasMerge && request.mergesFromRemote;
  if (request.configSpecs.length === 0 && !mergesHere) {
    const head = getFetchMap(refs, { negative: false, src: HEAD, dst: undefined }, 'refuse');
    return { head: withStatus(head, 'merge'), opportunistic: [] };
  }
  const specs = request.configSpecs.map(splitSides);
  const mapped = specs.flatMap((sides) => getFetchMap(refs, sides, 'refuse'));
  const marked = hasMerge ? mapped : markFirstForMerge(specs[0], mapped);
  return {
    head: mergesHere ? addMergeConfig(marked, request.merge, refs) : marked,
    opportunistic: [],
  };
};

/** git's byte-wise `strcmp`; advertised names are unique, so never equal. */
const byName = (left: AdvertisedRef, right: AdvertisedRef): number =>
  left.name < right.name ? -1 : 1;

/**
 * git's `find_non_local_tags`: the advertised tags the repository lacks whose
 * object — or the commit it peels to — is present or about to be fetched, in
 * name order, each stored under its own name.
 */
export const findNonLocalTags = (
  refs: ReadonlyArray<AdvertisedRef>,
  fetching: ReadonlyArray<MappedRef>,
  local: LocalState,
): ReadonlyArray<MappedRef> => {
  const fetched = new Set(fetching.map((entry) => entry.source.id));
  const reachable = (id: ObjectId | undefined): boolean =>
    id !== undefined && (fetched.has(id) || local.objects.has(id));
  return refs
    .filter((ref) => ref.name.startsWith(TAGS_PREFIX) && !ref.name.includes(PEELED_MARK))
    .filter((ref) => !local.refs.has(ref.name) && (reachable(ref.id) || reachable(ref.peeled)))
    .sort(byName)
    .map((source) => ({ source, target: source.name, status: 'not-for-merge' as const }));
};

export type Warn = (message: string) => void;

const IGNORED: FetchHeadStatus = 'ignore';

/** git's `handle_duplicate`: a second source for a local ref already mapped. */
const handleDuplicate = (
  first: MappedRef,
  second: MappedRef,
  target: string,
  warn: Warn | undefined,
) => {
  if (first.source.name === second.source.name) return;
  const sources = [first.source.name, second.source.name] as const;
  if (second.status !== IGNORED) throw fetchRefspecConflict('cannot-fetch-both', target, sources);
  if (first.status === IGNORED) throw fetchRefspecConflict('tracks-both', target, sources);
  warn?.(`${target} usually tracks ${second.source.name}, not ${first.source.name}`);
};

/** git's `ref_remove_duplicates`: a local ref keeps its first source. */
const removeDuplicates = (mapped: ReadonlyArray<MappedRef>, warn: Warn | undefined) => {
  const firsts = new Map<string, MappedRef>();
  return mapped.filter((entry) => {
    if (entry.target === undefined) return true;
    const first = firsts.get(entry.target);
    if (first === undefined) firsts.set(entry.target, entry);
    else handleDuplicate(first, entry, entry.target, warn);
    return first === undefined;
  });
};

/** git's `autotags`: tags follow when a refspec in force stores into a ref. */
export const autoFollowsTags = (request: RefMapRequest): boolean => {
  const specs = request.cliSpecs.length > 0 ? request.cliSpecs : request.configSpecs;
  return specs.map(splitSides).some(storesIntoRef);
};

export const getRefMap = (
  request: RefMapRequest,
  refs: ReadonlyArray<AdvertisedRef>,
  local: LocalState = NOTHING_LOCAL,
  warn?: Warn,
): ReadonlyArray<MappedRef> => {
  const cli = request.cliSpecs.map(splitSides);
  if (cli.length === 0 && request.refmap.length > 0) {
    throw invalidOption('refmap', REFMAP_WITHOUT_REFSPEC);
  }
  const planned = cli.length > 0 ? commandLineMap(request, cli, refs) : defaultMap(request, refs);
  const tags = autoFollowsTags(request) ? findNonLocalTags(refs, planned.head, local) : [];
  const negatives = cli.length > 0 ? request.cliSpecs : request.configSpecs;
  const combined = [...planned.head, ...tags, ...planned.opportunistic];
  return removeDuplicates(
    combined.filter((entry) => !matchesNegativeRefspec(negatives, entry.source.name)),
    warn,
  );
};
