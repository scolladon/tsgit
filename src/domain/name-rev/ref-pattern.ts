/**
 * `name-rev`'s `--refs` / `--exclude` ref filtering. git matches the **full**
 * refname with a `wildmatch` where `*`/`?` **cross `/`** (no `WM_PATHNAME`) — a
 * different dialect from the anchored, slash-bounded `compileGlob` used by
 * `describe`'s short-name `--match`, so it has its own tiny fnmatch.
 */
const TAGS_PREFIX = 'refs/tags/';

const escapeLiteral = (segment: string): string => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile a glob to an anchored RegExp where `*` → `.*` and `?` → `.` (both cross `/`). */
const globToRegExp = (pattern: string): RegExp => {
  const body = [...pattern]
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeLiteral(char)))
    .join('');
  return new RegExp(`^${body}$`);
};

/** Whether `ref` (a full refname) matches the shell `pattern`. */
export const matchRefGlob = (pattern: string, ref: string): boolean =>
  globToRegExp(pattern).test(ref);

export interface RefFilter {
  qualifies(ref: string): boolean;
}

export interface RefFilterOptions {
  readonly tags: boolean;
  readonly refs: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

/** A ref qualifies as a naming source: not HEAD, passes the tags gate + include/exclude globs. */
export const buildRefFilter = (opts: RefFilterOptions): RefFilter => {
  const included = (ref: string): boolean =>
    opts.refs.length === 0 || opts.refs.some((pattern) => matchRefGlob(pattern, ref));
  const excluded = (ref: string): boolean =>
    opts.exclude.some((pattern) => matchRefGlob(pattern, ref));
  return {
    qualifies(ref: string): boolean {
      if (ref === 'HEAD') return false;
      if (opts.tags && !ref.startsWith(TAGS_PREFIX)) return false;
      return included(ref) && !excluded(ref);
    },
  };
};
