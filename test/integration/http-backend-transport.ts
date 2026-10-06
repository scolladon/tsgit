/**
 * An `HttpTransport` served by a real `git http-backend` CGI over a local
 * project root — a git peer reached the way a smart-HTTP remote is, without a
 * listening server.
 */
import { spawnSync } from 'node:child_process';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/ports/http-transport.js';
import { runGitEnv } from './interop-helpers.js';

const CGI_HEADER_SEPARATOR = '\r\n\r\n';

const cgiResponse = (output: Buffer): HttpResponse => {
  const split = output.indexOf(CGI_HEADER_SEPARATOR);
  const headers: Record<string, string> = {};
  for (const line of output.subarray(0, split).toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = output.subarray(split + CGI_HEADER_SEPARATOR.length);
  return {
    statusCode: 200,
    headers,
    body: new Response(new Uint8Array(body)).body as ReadableStream<Uint8Array>,
  };
};

const backendRequest =
  (projectRoot: string, protocolEnv: (req: HttpRequest) => Record<string, string>) =>
  async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const body = req.body ?? new Uint8Array(0);
    const result = spawnSync('git', ['http-backend'], {
      input: body,
      env: {
        ...runGitEnv(),
        ...protocolEnv(req),
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        CONTENT_TYPE: req.headers['content-type'] ?? req.headers['Content-Type'] ?? '',
        CONTENT_LENGTH: String(body.byteLength),
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    return cgiResponse(result.stdout);
  };

/** A protocol v0 peer: the client's `Git-Protocol` header is not passed on. */
export const backendTransport = (projectRoot: string): HttpTransport => ({
  request: backendRequest(projectRoot, () => ({})),
});

/** A peer that honours the client's `Git-Protocol` header, as a web server fronting http-backend does. */
export const protocolV2BackendTransport = (projectRoot: string): HttpTransport => ({
  request: backendRequest(projectRoot, (req) => ({
    GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
  })),
});
