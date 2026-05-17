/**
 * Smart-HTTP refs discovery, parameterised by service.
 *
 * Phase 12.1/12.2 introduced `discoverRefs` for `git-upload-pack` only.
 * Phase 12.3 (push) needs the same wire protocol against `git-receive-pack`:
 * identical pkt-line advertisement format, identical parser, only the URL
 * `service=` query and the `accept` header differ.
 *
 * This module owns the parameterised call. The legacy
 * `upload-pack-client.ts` is a thin re-export that binds the service to
 * `'git-upload-pack'` so existing callers do not have to change.
 */
import { httpError } from '../../../domain/error.js';
import type { Advertisement, Service } from '../../../domain/protocol/index.js';
import {
  buildDiscoveryUrl,
  decodePktStream,
  parseAdvertisedRefs,
} from '../../../domain/protocol/index.js';
import { readableStreamToAsyncIterable } from '../../../operators/readable-stream.js';
import type { Context } from '../../../ports/context.js';
import type { HttpTransport } from '../../../ports/http-transport.js';

const ACCEPT_HEADER: Readonly<Record<Service, string>> = {
  'git-upload-pack': 'application/x-git-upload-pack-advertisement',
  'git-receive-pack': 'application/x-git-receive-pack-advertisement',
};

export const discoverRefsForService = async (
  ctx: Context,
  transport: HttpTransport,
  url: string,
  service: Service,
): Promise<Advertisement> => {
  const discoveryUrl = buildDiscoveryUrl(url, service);
  const response = await transport.request({
    url: discoveryUrl,
    method: 'GET',
    headers: { accept: ACCEPT_HEADER[service] },
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  // A non-200 from the discovery endpoint (401/403/404/5xx) must surface as
  // HTTP_ERROR — feeding the body to the pkt-line parser instead would mask
  // an authentication failure or a missing repository as an opaque
  // protocol-shaped error. Symmetric with `fetchPack`'s practice on the POST.
  if (response.statusCode !== 200) {
    throw httpError(response.statusCode, `${service} discovery returned ${response.statusCode}`);
  }
  const pktStream = decodePktStream(readableStreamToAsyncIterable(response.body));
  return parseAdvertisedRefs(pktStream, service);
};
