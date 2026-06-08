import { relativeUrlUnresolvable } from './error.js';

/**
 * Resolve a relative submodule URL (`./sub`, `../sub`, `../../x`) against a base
 * remote URL — a verbatim port of git's `remote.c:relative_url` +
 * `chop_last_dir` + `connect.c:url_is_local_not_ssh` (git 2.54.0), POSIX
 * semantics (the Windows DOS-drive branch of `url_is_local_not_ssh` /
 * `is_absolute_path` is inert on the platform our faithfulness harness runs and
 * is therefore omitted).
 *
 * A URL that is not "local, not ssh" (`https://…`, `git@host:…`) or is an
 * absolute path (`/abs`) is returned verbatim. Otherwise `../` pops one
 * component off the base and `./` keeps it; for scp bases the colon is restored
 * once the path is exhausted (`chop_last_dir`'s colon return).
 */
const DOT_SLASH = './';
const DOT_DOT_SLASH = '../';

const isAbsolutePath = (value: string): boolean => value.startsWith('/');

const urlIsLocalNotSsh = (url: string): boolean => {
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return colon < 0 || (slash >= 0 && slash < colon);
};

interface Chopped {
  readonly base: string;
  readonly colonSep: boolean;
}

/** Pop one trailing component off `base`; returns whether a colon was consumed. */
const chopLastDir = (base: string, isRelative: boolean): Chopped => {
  const slash = base.lastIndexOf('/');
  if (slash >= 0) return { base: base.slice(0, slash), colonSep: false };
  const colon = base.lastIndexOf(':');
  if (colon >= 0) return { base: base.slice(0, colon), colonSep: true };
  if (isRelative || base === '.') throw relativeUrlUnresolvable(base);
  return { base: '.', colonSep: false };
};

const normaliseRelativeBase = (base: string): string =>
  base.startsWith(DOT_SLASH) || base.startsWith(DOT_DOT_SLASH) ? base : `${DOT_SLASH}${base}`;

export const relativeUrl = (remoteUrl: string, url: string): string => {
  if (!urlIsLocalNotSsh(url) || isAbsolutePath(url)) return url;
  let base = remoteUrl.endsWith('/') ? remoteUrl.slice(0, -1) : remoteUrl;
  const isRelative = urlIsLocalNotSsh(base) && !isAbsolutePath(base);
  if (isRelative) base = normaliseRelativeBase(base);
  let rest = url;
  let colonSep = false;
  while (rest.length > 0) {
    if (rest.startsWith(DOT_DOT_SLASH)) {
      rest = rest.slice(DOT_DOT_SLASH.length);
      const chopped = chopLastDir(base, isRelative);
      base = chopped.base;
      colonSep = colonSep || chopped.colonSep;
    } else if (rest.startsWith(DOT_SLASH)) {
      rest = rest.slice(DOT_SLASH.length);
    } else {
      break;
    }
  }
  const joined = `${base}${colonSep ? ':' : '/'}${rest}`;
  const trimmed = rest.endsWith('/') ? joined.slice(0, -1) : joined;
  return trimmed.startsWith(DOT_SLASH) ? trimmed.slice(DOT_SLASH.length) : trimmed;
};

/**
 * Resolve a `.gitmodules` submodule URL against the superproject's base URL.
 * git only treats a URL as relative when it starts with `./` or `../` (the
 * `starts_with_dot_slash` / `starts_with_dot_dot_slash` gate around
 * `relative_url`); every other form — bare `sub`, `https://…`, `git@h:…`,
 * `/abs` — is used verbatim.
 */
export const resolveSubmoduleUrl = (base: string, url: string): string =>
  url.startsWith(DOT_SLASH) || url.startsWith(DOT_DOT_SLASH) ? relativeUrl(base, url) : url;
