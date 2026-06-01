/**
 * Pure assembler for `.git/rebase-merge/git-rebase-todo.backup` — the recovery
 * copy of the original todo the merge backend writes alongside the live list. It
 * is the full todo (full oids) followed by a blank line, a `# Rebase
 * <upstream>..<orig-head> onto <onto> (<n> command[s])` header, and a fixed
 * `# Commands:` help block. The block is byte-faithful to git 2.54; it is not
 * consumed by `--continue` (git reads the live `git-rebase-todo`), so its only
 * role is that an inspector — or `git rebase --edit-todo` — sees git's bytes.
 */
import { type RebaseTodoEntry, serializeRebaseTodo } from './todo.js';

export interface RebaseBackupHeader {
  readonly shortUpstream: string;
  readonly shortOrigHead: string;
  readonly shortOnto: string;
}

/** The fixed help block git appends after the `# Rebase …` header line. */
const HELP_BODY =
  '#\n' +
  '# Commands:\n' +
  '# p, pick <commit> = use commit\n' +
  '# r, reword <commit> = use commit, but edit the commit message\n' +
  '# e, edit <commit> = use commit, but stop for amending\n' +
  '# s, squash <commit> = use commit, but meld into previous commit\n' +
  '# f, fixup [-C | -c] <commit> = like "squash" but keep only the previous\n' +
  "#                    commit's log message, unless -C is used, in which case\n" +
  "#                    keep only this commit's message; -c is same as -C but\n" +
  '#                    opens the editor\n' +
  '# x, exec <command> = run command (the rest of the line) using shell\n' +
  "# b, break = stop here (continue rebase later with 'git rebase --continue')\n" +
  '# d, drop <commit> = remove commit\n' +
  '# l, label <label> = label current HEAD with a name\n' +
  '# t, reset <label> = reset HEAD to a label\n' +
  '# m, merge [-C <commit> | -c <commit>] <label> [# <oneline>]\n' +
  "#         create a merge commit using the original merge commit's\n" +
  '#         message (or the oneline, if no original merge commit was\n' +
  '#         specified); use -c <commit> to reword the commit message\n' +
  '# u, update-ref <ref> = track a placeholder for the <ref> to be updated\n' +
  '#                       to this position in the new commits. The <ref> is\n' +
  '#                       updated at the end of the rebase\n' +
  '#\n' +
  '# These lines can be re-ordered; they are executed from top to bottom.\n' +
  '#\n' +
  '# If you remove a line here THAT COMMIT WILL BE LOST.\n' +
  '#\n' +
  '# However, if you remove everything, the rebase will be aborted.\n' +
  '#\n';

export const rebaseTodoBackup = (
  picks: ReadonlyArray<RebaseTodoEntry>,
  header: RebaseBackupHeader,
): string => {
  const count = picks.length;
  const plural = count === 1 ? 'command' : 'commands';
  const headerLine = `# Rebase ${header.shortUpstream}..${header.shortOrigHead} onto ${header.shortOnto} (${count} ${plural})\n`;
  return `${serializeRebaseTodo(picks)}\n${headerLine}${HELP_BODY}`;
};
