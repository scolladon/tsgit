/**
 * `name-rev`'s `--refs` / `--exclude` ref filtering. Like git's `subpath_matches`,
 * a pattern is tried against the full refname and then against each suffix that
 * starts after a `/`, with wildmatch where `*`/`?` **cross `/`** (no
 * `WM_PATHNAME`). The matcher is shared with `gc.<pattern>.*` reflog-expiry keys
 * — see `../refs/ref-glob.ts`.
 */
import { compileRefGlob } from '../refs/ref-glob.js';

const TAGS_PREFIX = 'refs/tags/';
const SEPARATOR = '/';

export interface RefFilter {
  qualifies(ref: string): boolean;
  /** True when an include first matches past offset 0, so git prints the shortened name. */
  abbreviates(ref: string): boolean;
}

export interface RefFilterOptions {
  readonly tags: boolean;
  readonly refs: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

type RefMatcher = (ref: string) => boolean;

/** First offset (0, then just after each `/`) whose suffix the matcher accepts. */
const subpathOffset = (matches: RefMatcher, ref: string): number | undefined => {
  let offset = 0;
  for (;;) {
    if (matches(ref.slice(offset))) return offset;
    const slash = ref.indexOf(SEPARATOR, offset);
    if (slash === -1) return undefined;
    offset = slash + 1;
  }
};

/** A ref qualifies as a naming source: not HEAD, passes the tags gate + include/exclude globs. */
export const buildRefFilter = (opts: RefFilterOptions): RefFilter => {
  const includes = opts.refs.map(compileRefGlob);
  const excludes = opts.exclude.map(compileRefGlob);
  const matchesAt = (matches: RefMatcher, ref: string): boolean =>
    subpathOffset(matches, ref) !== undefined;
  return {
    qualifies(ref: string): boolean {
      if (ref === 'HEAD') return false;
      if (opts.tags && !ref.startsWith(TAGS_PREFIX)) return false;
      if (excludes.some((m) => matchesAt(m, ref))) return false;
      return includes.length === 0 || includes.some((m) => matchesAt(m, ref));
    },
    abbreviates(ref: string): boolean {
      return includes.some((m) => (subpathOffset(m, ref) ?? 0) > 0);
    },
  };
};
