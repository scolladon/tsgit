import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';

const GIT_SSH_COMMAND_ENV = 'GIT_SSH_COMMAND';
const GIT_SSH_ENV = 'GIT_SSH';
const DEFAULT_SSH_PROGRAM = 'ssh';

export interface ResolvedSshCommand {
  readonly program: string;
  readonly baseArgs: ReadonlyArray<string>;
}

/**
 * git's ssh-command resolution order: `GIT_SSH_COMMAND` (shell string) →
 * `core.sshCommand` (shell string) → `GIT_SSH` (lone program path) → the
 * default `ssh` on `PATH`. Shell-string sources are word-split into a
 * program plus leading args; `GIT_SSH` is used verbatim with no split.
 */
export const resolveSshCommand = async (ctx: Context): Promise<ResolvedSshCommand> => {
  const sshCommandEnv = ctx.env?.get(GIT_SSH_COMMAND_ENV);
  if (isSet(sshCommandEnv)) return splitIntoCommand(sshCommandEnv);

  const config = await readConfig(ctx);
  const sshCommandConfig = config.core?.sshCommand;
  if (isSet(sshCommandConfig)) return splitIntoCommand(sshCommandConfig);

  const sshProgramEnv = ctx.env?.get(GIT_SSH_ENV);
  if (isSet(sshProgramEnv)) return { program: sshProgramEnv, baseArgs: [] };

  return { program: DEFAULT_SSH_PROGRAM, baseArgs: [] };
};

const isSet = (value: string | undefined): value is string => value !== undefined && value !== '';

const splitIntoCommand = (raw: string): ResolvedSshCommand => {
  const [program, ...baseArgs] = splitShellWords(raw);
  return program === undefined ? { program: raw, baseArgs: [] } : { program, baseArgs };
};

/**
 * Minimal POSIX-ish word splitter for shell-string config/env values: honours
 * single quotes (fully literal), double quotes (backslash escapes `"` and
 * `\`), and a bare backslash escaping the next character. Sufficient for
 * ssh command strings; never shells out to split.
 */
const SHELL_WORD = /'([^']*)'|"((?:[^"\\]|\\.)*)"|((?:[^\s'"\\]|\\.)+)/g;

const splitShellWords = (input: string): ReadonlyArray<string> =>
  Array.from(input.matchAll(SHELL_WORD), extractWord);

const extractWord = (match: RegExpMatchArray): string => {
  const [, single, double, bare] = match;
  if (single !== undefined) return single;
  if (double !== undefined) return double.replace(/\\(["\\])/g, '$1');
  return (bare ?? '').replace(/\\(.)/g, '$1');
};
