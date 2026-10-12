/** The positional half of a `<command> [<repository> [<refspec>...]]` invocation. */
export interface RepositoryInvocation {
  /** The repository the caller named, if any. */
  readonly named: string | undefined;
  /** The repository the command resolved and ran against. */
  readonly resolved: string;
  readonly refspecs: ReadonlyArray<string>;
}

/**
 * git's argv-derived `GIT_REFLOG_ACTION` (`fetch`'s `default_rla`, `pull`'s
 * `set_reflog_message`): the command, then the repository when one was named or
 * when refspecs need it in front, then the refspecs. Option flags are left out:
 * their argv position is not recoverable from structured options.
 */
export const argvReflogAction = (command: string, invocation: RepositoryInvocation): string => {
  const { named, resolved, refspecs } = invocation;
  if (named === undefined && refspecs.length === 0) return command;
  return [command, resolved, ...refspecs].join(' ');
};
