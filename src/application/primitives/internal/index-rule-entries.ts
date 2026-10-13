interface StagedEntry {
  readonly path: string;
  readonly flags: { readonly stage: 0 | 1 | 2 | 3 };
}

const MERGED_STAGE = 0;
const OURS_STAGE = 2;

/**
 * git's `read_blob_data_from_index` and its CRLF-in-index check read a path
 * from stage 0, else from stage 2 (ours) when the path is unmerged; the base
 * and theirs stages never take part.
 */
export const indexRuleEntries = <E extends StagedEntry>(entries: Iterable<E>): ReadonlyArray<E> => {
  const chosen = new Map<string, E>();
  for (const entry of entries) {
    const { stage } = entry.flags;
    const held = chosen.get(entry.path);
    if (stage === MERGED_STAGE || (stage === OURS_STAGE && held?.flags.stage !== MERGED_STAGE)) {
      chosen.set(entry.path, entry);
    }
  }
  return [...chosen.values()];
};
