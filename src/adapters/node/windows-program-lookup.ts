import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** What a Windows program lookup reads from its host. */
export interface ProgramLookupHost {
  readonly env: NodeJS.ProcessEnv;
  readonly isFile: (path: string) => boolean;
}

/** The program to spawn for a name; `undefined` when it cannot be found. */
export type ProgramResolver = (program: string) => string | undefined;

/** The `stat` a file probe asks; `undefined` when nothing exists at the path. */
type StatProbe = (
  path: string,
  options: { readonly throwIfNoEntry: false },
) => { isFile(): boolean } | undefined;

/**
 * `errno` codes of a candidate the process cannot reach. Git for Windows'
 * existence check fails on them alike, so the search skips such a candidate.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ENAMETOOLONG']);

const isUnreachable = (error: unknown): boolean =>
  UNREACHABLE_CODES.has((error as NodeJS.ErrnoException).code ?? '');

/** Whether `path` names a regular file, a candidate the process cannot reach counting as none. */
export const isRegularFileVia =
  (stat: StatProbe) =>
  (path: string): boolean => {
    try {
      return stat(path, { throwIfNoEntry: false })?.isFile() === true;
    } catch (error) {
      if (isUnreachable(error)) return false;
      throw error;
    }
  };

/** Production host: the process environment and the real file system. */
export const realProgramLookupHost: ProgramLookupHost = {
  // `process.env` itself, never a copy: on Windows only it reads `Path` as `PATH`.
  env: process.env,
  isFile: isRegularFileVia(statSync),
};

const EXECUTABLE_SUFFIX = '.exe';
const PATH_LIST_SEPARATOR = ';';
const PATH_SEPARATORS = /[/\\]/;
/** Where Windows lives when `SystemRoot` is unset or not absolute. */
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

const absolute = (path: string | undefined): string | undefined =>
  path !== undefined && win32.isAbsolute(path) ? path : undefined;

/** `<name>.exe` first, then the name as given — unless it already names an `.exe`. */
const candidateNames = (program: string): ReadonlyArray<string> =>
  program.toLowerCase().endsWith(EXECUTABLE_SUFFIX)
    ? [program]
    : [`${program}${EXECUTABLE_SUFFIX}`, program];

/**
 * Resolves a bare program name against `PATH` alone, entry by entry, the way
 * Git for Windows' `path_lookup` does — never the working directory, which
 * Windows' own search would try first and a repository can plant a program in.
 * A name carrying a path separator is used as given. `undefined` when no `PATH`
 * entry holds the program.
 */
export const lookupWindowsProgram = (
  program: string,
  host: ProgramLookupHost,
): string | undefined => {
  if (PATH_SEPARATORS.test(program)) return program;
  const directories = (host.env.PATH ?? '')
    .split(PATH_LIST_SEPARATOR)
    .filter((directory) => directory.length > 0);
  return directories
    .flatMap((directory) => candidateNames(program).map((name) => win32.join(directory, name)))
    .find(host.isFile);
};

/** The absolute command interpreter: `ComSpec`, else `%SystemRoot%\System32\cmd.exe`. */
export const windowsCommandInterpreter = (env: NodeJS.ProcessEnv): string =>
  absolute(env.ComSpec) ??
  win32.join(absolute(env.SystemRoot) ?? DEFAULT_SYSTEM_ROOT, 'System32', 'cmd.exe');

const asGiven: ProgramResolver = (program) => program;

/**
 * How `platform` resolves a program name: on Windows against `PATH` alone (see
 * {@link lookupWindowsProgram}); elsewhere left to the spawn, whose `PATH`
 * search never consults the working directory.
 */
export const programResolverFor = (
  platform: NodeJS.Platform,
  host: ProgramLookupHost,
): ProgramResolver =>
  platform === 'win32' ? (program) => lookupWindowsProgram(program, host) : asGiven;

/** The error a program that no `PATH` entry holds fails its start with. */
export const programNotFound = (program: string): Error =>
  new Error(`cannot run ${program}: not found on PATH`);
