/**
 * `core.disambiguate`'s hint types, as `set_disambiguate_hint_config` names
 * them: the kind of object an ambiguous abbreviated name prefers when the
 * caller asks for no kind of its own.
 */
export type DisambiguationHint = 'none' | 'commit' | 'committish' | 'tree' | 'treeish' | 'blob';

const HINTS: ReadonlyArray<DisambiguationHint> = [
  'none',
  'commit',
  'committish',
  'tree',
  'treeish',
  'blob',
];

/** The hint `value` names, compared case-insensitively as git's `strcasecmp` does; `undefined` when it names none. */
export const parseDisambiguationHint = (value: string): DisambiguationHint | undefined => {
  const lowered = value.toLowerCase();
  return HINTS.find((hint) => hint === lowered);
};
