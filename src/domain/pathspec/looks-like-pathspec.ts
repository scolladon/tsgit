/**
 * git's `looks_like_pathspec`: an argument carrying an unescaped glob
 * character, or long-form `:(…)` magic, reads as a pathspec even though no
 * file by that name exists.
 */
const GLOB_SPECIAL: ReadonlySet<string> = new Set(['*', '?', '[']);
const ESCAPE = '\\';
const LONG_MAGIC = ':(';

const hasUnescapedGlob = (arg: string): boolean => {
  let escaped = false;
  for (const char of arg) {
    if (escaped) escaped = false;
    else if (char === ESCAPE) escaped = true;
    else if (GLOB_SPECIAL.has(char)) return true;
  }
  return false;
};

export const looksLikePathspec = (arg: string): boolean =>
  hasUnescapedGlob(arg) || arg.startsWith(LONG_MAGIC);
