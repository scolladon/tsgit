/** `core.checkStat`: `minimal` leaves ctime, uid, gid and inode out of the stat comparison. */
export type CheckStat = 'default' | 'minimal';

const CHECK_STATS: ReadonlyArray<CheckStat> = ['default', 'minimal'];

/** git matches the two spellings case-insensitively and ignores any other value. */
export const parseCheckStat = (value: string | null): CheckStat | undefined => {
  const lowered = value?.toLowerCase();
  return CHECK_STATS.find((candidate) => candidate === lowered);
};
