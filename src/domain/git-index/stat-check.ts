/**
 * Which stat fields git's `ce_match_stat_basic` holds against an index entry: mtime and size
 * always, ctime only while `core.trustCtime` and `core.checkStat` allow it, uid, gid and
 * inode only while `core.checkStat` is not `minimal`.
 */
export interface StatCheck {
  readonly ctime: boolean;
  readonly ownerAndInode: boolean;
}
