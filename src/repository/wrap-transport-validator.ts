import { validateUrl } from '../application/commands/internal/url-validate.js';
import type { RepositoryConfig } from '../ports/context.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../ports/http-transport.js';

/**
 * Wrap a user-supplied HttpTransport so every request URL passes the
 * SSRF guard before reaching the adapter. Defense-in-depth: the transport
 * `withDefaults` middleware already validates URLs at command sites, but a
 * user-supplied transport bypassing that pipeline (e.g., a hand-rolled
 * subclass that takes a raw URL) would slip past without this wrapper.
 *
 * Bypassed when `openRepository` is called with `unsafeRawAdapters: true`.
 *
 * Validation rules consulted from `config`:
 * - `allowInsecure` (default false): http:// is rejected unless true.
 * - `allowPrivateNetworks` (default false): RFC1918 / loopback / link-local
 *  addresses are rejected unless true.
 * - `dnsResolver`: pluggable; defaults to a built-in fail-closed resolver.
 *
 * Note: when `config` is undefined, the wrapper applies the most restrictive
 * defaults (https-only, no private networks). The default resolver falls
 * back to the platform default which the transport itself uses; the wrapper
 * does not pin DNS — that responsibility stays with the transport.
 */
export const wrapTransportValidator = (
  transport: HttpTransport,
  config: RepositoryConfig | undefined,
): HttpTransport => {
  const allowInsecure = config?.allowInsecure ?? false;
  const allowPrivateNetworks = config?.allowPrivateNetworks ?? false;
  const resolver = config?.dnsResolver ?? defaultResolver;
  return {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      await validateUrl(req.url, { resolver, allowInsecure, allowPrivateNetworks });
      return transport.request(req);
    },
  };
};

/**
 * Fail-closed default resolver — returns an empty array so the SSRF guard
 * rejects the request as `BLOCKED_HOST`. Callers MUST supply a real resolver
 * via `config.dnsResolver` when network access is needed.
 */
const defaultResolver = async (): Promise<ReadonlyArray<string>> => [];
