import { blockedHost, invalidUrl, unsupportedScheme } from '../../../domain/commands/error.js';

/**
 * URL that survived all SSRF guards. Carries both the original URL (for the
 * Host header) and the pinned IP that the transport must connect to (anti-rebinding).
 */
interface ValidatedUrl {
  readonly url: string;
  readonly pinnedAddress: string;
}

/** Pluggable DNS resolver. Returns the addresses for `host`, in order. */
export type DnsResolver = (host: string) => Promise<ReadonlyArray<string>>;

export interface UrlValidateOptions {
  readonly resolver: DnsResolver;
  /** Default false. When true, http:// is allowed in addition to https://. */
  readonly allowInsecure?: boolean;
  /** Default false. When true, RFC1918 / loopback / link-local addresses are not blocked. */
  readonly allowPrivateNetworks?: boolean;
}

/**
 * Validate `raw` as a fetchable URL: scheme allowlist, parse, host resolution,
 * IP-range blocklist (SSRF guard), DNS pinning. Throws `UNSUPPORTED_SCHEME`,
 * `INVALID_URL`, or `BLOCKED_HOST` per the design.
 */
export const validateUrl = async (raw: string, opts: UrlValidateOptions): Promise<ValidatedUrl> => {
  rejectControlChars(raw);
  const parsed = parseUrl(raw);
  enforceScheme(parsed, opts.allowInsecure ?? false);
  rejectFragment(parsed);
  const addresses = await opts.resolver(parsed.hostname);
  const pinned = pickPinnedAddress(addresses, opts.allowPrivateNetworks ?? false);
  return { url: raw, pinnedAddress: pinned };
};

const rejectControlChars = (raw: string): void => {
  // Stryker disable next-line EqualityOperator: equivalent — at i === raw.length, charCodeAt returns NaN and NaN === 0x0a/0x0d is false, so the extra iteration is a no-op.
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === 0x0a || code === 0x0d) {
      throw invalidUrl('contains forbidden control character');
    }
  }
};

const parseUrl = (raw: string): URL => {
  try {
    return new URL(raw);
  } catch {
    throw invalidUrl('not a valid URL');
  }
};

const enforceScheme = (url: URL, allowInsecure: boolean): void => {
  const proto = url.protocol;
  if (proto === 'https:') return;
  if (proto === 'http:' && allowInsecure) return;
  throw unsupportedScheme(proto.replace(':', ''));
};

const rejectFragment = (url: URL): void => {
  if (url.hash !== '') throw invalidUrl('URL fragment is not allowed');
};

const pickPinnedAddress = (
  addresses: ReadonlyArray<string>,
  allowPrivateNetworks: boolean,
): string => {
  for (const addr of addresses) {
    if (allowPrivateNetworks || !isBlockedAddress(addr)) return addr;
  }
  if (addresses.length === 0) throw blockedHost('<unresolved>', 'no DNS records returned');
  throw blockedHost(addresses[0] as string, 'all resolved addresses are in a blocked range');
};

const isBlockedAddress = (addr: string): boolean => {
  if (addr.includes(':')) return isBlockedIpv6(addr);
  return isBlockedIpv4(addr);
};

const parseIpv4 = (addr: string): ReadonlyArray<number> | undefined => {
  const parts = addr.split('.');
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    // `part` matched `\d{1,3}`, so `Number(part)` is 0..999 — never negative.
    const n = Number(part);
    if (n > 255) return undefined;
    out.push(n);
  }
  return out;
};

const isBlockedIpv4 = (addr: string): boolean => {
  const octets = parseIpv4(addr);
  if (octets === undefined) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved) — together every a >= 224.
  if (a >= 224) return true;
  return false;
};

const isBlockedIpv6 = (addr: string): boolean => {
  const lower = addr.toLowerCase();
  // Extract embedded IPv4 from `::ffff:1.2.3.4` (dot-decimal form).
  const dotted = lower.match(/::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1] !== undefined) return isBlockedIpv4(dotted[1]);
  // Same for hex form: `::ffff:7f00:1` is `::ffff:127.0.0.1`. Without this
  // branch an attacker-controlled DNS server could bypass the IPv4 blocklist
  // by returning the hex form of a private address.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const dottedFromHex = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    return isBlockedIpv4(dottedFromHex);
  }
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true;
  if (lower.startsWith('ff')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  return false;
};
