import { invalidUrl, sanitize } from '../../../domain/commands/error.js';

/**
 * A remote URL classified into one of git's transport shapes. `kind: 'http'`
 * covers both `http:` and `https:` — the HTTP session parses the scheme
 * itself from the verbatim url string.
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

/**
 * Strip the userinfo (`[user[:password]]@`) from a remote URL for display in
 * reflog messages, reproducing git's `transport_anonymize_url`: drop
 * everything up to and including the first `@` when that `@` sits in the
 * authority, keep the scheme prefix, and leave the URL untouched when there
 * is no userinfo or the `@` sits in the path. Keeps embedded credentials out
 * of the on-disk reflog while preserving the real URL for the transport and
 * for `remote.<name>.url`.
 */
export const anonymizeRemoteUrl = (raw: string): string => {
  const atIndex = raw.indexOf('@');
  if (atIndex === -1) return raw;
  const separatorIndex = raw.indexOf(SCHEME_SEPARATOR);
  const prefixLength = separatorIndex === -1 ? 0 : separatorIndex + SCHEME_SEPARATOR.length;
  const firstSlash = raw.indexOf('/', prefixLength);
  if (firstSlash !== -1 && firstSlash < atIndex) return raw;
  return `${raw.slice(0, prefixLength)}${raw.slice(atIndex + 1)}`;
};

/** Inverse of `parseRemoteUrl`, used by the round-trip property. */
export const formatRemoteUrl = (parsed: RemoteUrl): string => {
  if (parsed.kind === 'http') return parsed.url;
  const authority = combineUserHost(parsed.user, bracketIpv6Host(parsed.host));
  if (parsed.port === undefined && !isIpv6Host(parsed.host)) return `${authority}:${parsed.path}`;
  const portSuffix = parsed.port === undefined ? '' : `:${parsed.port}`;
  return `${SSH_URL_PREFIX}${authority}${portSuffix}${sshPathname(parsed.path)}`;
};

/** The scp-like form cannot carry a colon-bearing host, so an IPv6 host always formats as an ssh URL. */
const isIpv6Host = (host: string): boolean => host.includes(':');

const bracketIpv6Host = (host: string): string => (isIpv6Host(host) ? `[${host}]` : host);

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
  const host = stripIpv6Brackets(url.hostname);
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

/** WHATWG `hostname` keeps IPv6 brackets (`[::1]`); ssh expects the bare address, as git passes it. */
const stripIpv6Brackets = (hostname: string): string =>
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

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

/** Single source of the destination token bytes seen by BOTH the dash-guard and the spawned ssh argv — the lockstep is security-load-bearing. */
export const combineUserHost = (user: string | undefined, host: string): string =>
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
