import { invalidUrl, sanitize } from '../../../domain/commands/error.js';

/**
 * A remote URL classified into one of git's transport shapes. `kind: 'http'`
 * covers both `http:` and `https:` — the HTTP session (Part 4) parses the
 * scheme itself from the verbatim url string.
 */
export type RemoteUrl =
  | { readonly kind: 'http'; readonly url: string }
  | {
      readonly kind: 'ssh';
      readonly user?: string;
      readonly host: string;
      readonly port?: number;
      readonly path: string;
    };

const HTTP_PREFIX = 'http://';
const HTTPS_PREFIX = 'https://';
const SSH_URL_PREFIX = 'ssh://';
const SCHEME_SEPARATOR = '://';
const DASH = '-';
const TILDE = '~';
const TILDE_PATHNAME_PREFIX = `/${TILDE}`;
const CONTROL_CHAR_PATTERN = /[\n\r\0]/;

type UrlForm = 'http' | 'sshUrl' | 'scp';

/**
 * Classify and parse a git remote URL: `http(s)://`, `ssh://`, or scp-like
 * (`[user@]host:path`). Rejects control characters and dash-prefixed
 * host/path tokens (the SSH argument-injection guard) before any value can
 * reach a spawned process.
 */
export const parseRemoteUrl = (raw: string): RemoteUrl => {
  rejectControlChars(raw);
  const form = classifyScheme(raw);
  if (form === 'http') return { kind: 'http', url: raw };
  return form === 'sshUrl' ? parseSshUrlForm(raw) : parseScpForm(raw);
};

/** Inverse of `parseRemoteUrl`, used by the round-trip property. */
export const formatRemoteUrl = (parsed: RemoteUrl): string => {
  if (parsed.kind === 'http') return parsed.url;
  const authority = combineUserHost(parsed.user, parsed.host);
  if (parsed.port === undefined) return `${authority}:${parsed.path}`;
  return `${SSH_URL_PREFIX}${authority}:${parsed.port}${sshPathname(parsed.path)}`;
};

const rejectControlChars = (raw: string): void => {
  if (CONTROL_CHAR_PATTERN.test(raw)) {
    throw invalidUrl('contains forbidden control character');
  }
};

const classifyScheme = (raw: string): UrlForm => {
  if (raw.startsWith(HTTP_PREFIX) || raw.startsWith(HTTPS_PREFIX)) return 'http';
  if (raw.startsWith(SSH_URL_PREFIX)) return 'sshUrl';
  if (isScpLike(raw)) return 'scp';
  throw invalidUrl('unrecognised remote URL');
};

const isScpLike = (raw: string): boolean => {
  const colonIndex = raw.indexOf(':');
  if (colonIndex === -1) return false;
  const slashIndex = raw.indexOf('/');
  const colonBeforeSlash = slashIndex === -1 || colonIndex < slashIndex;
  return colonBeforeSlash && !raw.includes(SCHEME_SEPARATOR);
};

const parseSshUrlForm = (raw: string): RemoteUrl => {
  const url = parseAsUrl(raw);
  const user = url.username === '' ? undefined : url.username;
  const host = url.hostname;
  const port = url.port === '' ? undefined : Number(url.port);
  const path = collapseTildePathname(url.pathname);
  applyDashGuard(combineUserHost(user, host), path);
  return buildSshRemoteUrl(user, host, port, path);
};

const parseAsUrl = (raw: string): URL => {
  try {
    return new URL(raw);
  } catch {
    throw invalidUrl('not a valid URL');
  }
};

const collapseTildePathname = (pathname: string): string =>
  pathname.startsWith(TILDE_PATHNAME_PREFIX) ? pathname.slice(1) : pathname;

const parseScpForm = (raw: string): RemoteUrl => {
  const { hostToken, path } = splitScpLike(raw);
  applyDashGuard(hostToken, path);
  const { user, host } = splitUserHost(hostToken);
  return buildSshRemoteUrl(user, host, undefined, path);
};

const splitScpLike = (raw: string): { readonly hostToken: string; readonly path: string } => {
  const colonIndex = raw.indexOf(':');
  return { hostToken: raw.slice(0, colonIndex), path: raw.slice(colonIndex + 1) };
};

const splitUserHost = (token: string): { readonly user?: string; readonly host: string } => {
  const at = token.indexOf('@');
  return at === -1 ? { host: token } : { user: token.slice(0, at), host: token.slice(at + 1) };
};

const combineUserHost = (user: string | undefined, host: string): string =>
  user === undefined ? host : `${user}@${host}`;

const sshPathname = (path: string): string => (path.startsWith(TILDE) ? `/${path}` : path);

const buildSshRemoteUrl = (
  user: string | undefined,
  host: string,
  port: number | undefined,
  path: string,
): RemoteUrl => ({
  kind: 'ssh',
  ...(user !== undefined ? { user } : {}),
  host,
  ...(port !== undefined ? { port } : {}),
  path,
});

const applyDashGuard = (hostToken: string, path: string): void => {
  assertNotDashPrefixed('hostname', hostToken);
  assertNotDashPrefixed('pathname', path);
};

const assertNotDashPrefixed = (label: 'hostname' | 'pathname', value: string): void => {
  if (!value.startsWith(DASH)) return;
  throw invalidUrl(`strange ${label} '${sanitize(value)}' blocked`);
};
