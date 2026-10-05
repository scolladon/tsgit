/**
 * git's `fmt_merge_msg` naming over the merge-names buffer: each head merged is
 * described as FETCH_HEAD describes it — `branch 'x' of <source>`, `tag 'v'`,
 * `remote-tracking branch 'o/x'`, a quoted ref name, or a bare source when a
 * remote's HEAD is pulled. `merge` describes a local head with the source `.`.
 */
const SOURCE_SEPARATOR = ' of ';
const LOCAL_SOURCE = '.';

type NamedKind = 'branch' | 'remoteBranch' | 'tag' | 'generic';

interface ParsedHead {
  readonly source: string;
  readonly kind: NamedKind | 'head';
  /** The head's name as the title lists it (quoted, as described). */
  readonly name: string;
}

const KIND_PREFIXES: ReadonlyArray<readonly [prefix: string, kind: NamedKind]> = [
  ['branch ', 'branch'],
  ['tag ', 'tag'],
  ['remote-tracking branch ', 'remoteBranch'],
];

/** git's `handle_line` split of one description into its source and kind. */
const parseHead = (description: string): ParsedHead => {
  const at = description.indexOf(SOURCE_SEPARATOR);
  if (at < 0) return { source: description, kind: 'head', name: description };
  const line = description.slice(0, at);
  const source = description.slice(at + SOURCE_SEPARATOR.length);
  const matched = KIND_PREFIXES.find(([prefix]) => line.startsWith(prefix));
  if (matched === undefined) return { source, kind: 'generic', name: line };
  return { source, kind: matched[1], name: line.slice(matched[0].length) };
};

/** git's `print_joined`: `branch 'a'`, or `branches 'a', 'b' and 'c'`. */
const joined = (singular: string, plural: string, names: ReadonlyArray<string>): string[] => {
  if (names.length === 0) return [];
  if (names.length === 1) return [`${singular}${names[0]}`];
  return [`${plural}${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`];
};

const namesOf = (heads: ReadonlyArray<ParsedHead>, kind: NamedKind): ReadonlyArray<string> =>
  heads.filter((head) => head.kind === kind).map((head) => head.name);

/** One source's part of the title, in git's kind order. */
const sourceTitle = (source: string, heads: ReadonlyArray<ParsedHead>): string => {
  const pullsHead = heads.some((head) => head.kind === 'head');
  if (heads.every((head) => head.kind === 'head')) return source;
  const parts = [
    ...(pullsHead ? ['HEAD'] : []),
    ...joined('branch ', 'branches ', namesOf(heads, 'branch')),
    ...joined(
      'remote-tracking branch ',
      'remote-tracking branches ',
      namesOf(heads, 'remoteBranch'),
    ),
    ...joined('tag ', 'tags ', namesOf(heads, 'tag')),
    ...joined('commit ', 'commits ', namesOf(heads, 'generic')),
  ];
  const suffix = source === LOCAL_SOURCE ? '' : `${SOURCE_SEPARATOR}${source}`;
  return `${parts.join(', ')}${suffix}`;
};

/** Heads grouped by source, sources in first-seen order. */
const groupBySource = (
  descriptions: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<ParsedHead>> =>
  descriptions.map(parseHead).reduce((groups, head) => {
    const group = groups.get(head.source) ?? [];
    return new Map(groups).set(head.source, [...group, head]);
  }, new Map<string, ReadonlyArray<ParsedHead>>());

/**
 * git's `fmt_merge_msg_title`: `Merge <heads by source>`, then ` into
 * <destination>` unless `destination` is `undefined` (`merge.suppressDest`).
 */
export const mergeTitle = (
  descriptions: ReadonlyArray<string>,
  destination: string | undefined,
): string => {
  const sources = [...groupBySource(descriptions)].map(([source, heads]) =>
    sourceTitle(source, heads),
  );
  const into = destination === undefined ? '' : ` into ${destination}`;
  return `Merge ${sources.join('; ')}${into}`;
};
