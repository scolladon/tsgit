/**
 * Reusable `git-http-backend` CGI server lifecycle.
 *
 * Boots an `http.Server` bound to 127.0.0.1 on an ephemeral port that
 * spawns `git-http-backend` per request (RFC 3875 CGI). Both the
 * integration suite and the prior bench import the helper so the
 * CGI plumbing lives in exactly one place.
 *
 * The handler is lifted verbatim from the original integration test,
 * keeping behaviour byte-identical.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';

export interface GitHttpBackend {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface StartGitHttpBackendOpts {
  readonly projectRoot: string;
  readonly host?: string;
}

const findGitExecPath = (): string | undefined => {
  try {
    return execFileSync('git', ['--exec-path']).toString().trim();
  } catch {
    return undefined;
  }
};

export const findGitHttpBackend = (): string | undefined => {
  const execPath = findGitExecPath();
  return execPath === undefined ? undefined : path.join(execPath, 'git-http-backend');
};

const findHeaderSeparator = (buf: Buffer): number => {
  // Accept both LF LF and CRLF CRLF separators per RFC 3875
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i;
    if (
      i < buf.length - 3 &&
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
};

const applyCgiHeaders = (res: http.ServerResponse, headerBuf: Buffer): number => {
  let statusCode = 200;
  for (const line of headerBuf.toString('utf8').split(/\r?\n/)) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === 'status') {
      const parsed = Number.parseInt(value.split(' ', 1)[0] ?? '200', 10);
      if (Number.isFinite(parsed)) statusCode = parsed;
      continue;
    }
    res.setHeader(key, value);
  }
  return statusCode;
};

const writeCgiResponse = (res: http.ServerResponse, raw: Buffer): void => {
  const sep = findHeaderSeparator(raw);
  if (sep < 0) {
    res.statusCode = 502;
    res.end('CGI response missing header separator');
    return;
  }
  const headerBuf = raw.subarray(0, sep);
  const body = raw.subarray(sep + (raw[sep] === 0x0d ? 4 : 2));
  res.statusCode = applyCgiHeaders(res, headerBuf);
  res.end(body);
};

const handleRequest = (
  backendPath: string,
  projectRoot: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  if (req.url === undefined || req.method === undefined) {
    res.statusCode = 400;
    res.end();
    return;
  }
  // PATH_INFO and QUERY_STRING are forwarded verbatim to git-http-backend.
  // The helper is scoped to localhost test/bench traffic — if reused in a
  // broader harness, the caller is responsible for normalising path traversal
  // (`..`) and other CGI-meta-character payloads before they reach the env.
  const [pathInfo, queryString = ''] = req.url.split('?', 2);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH_INFO: pathInfo ?? '/',
    QUERY_STRING: queryString,
    REQUEST_METHOD: req.method,
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: req.headers['content-length'] ?? '',
    REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
  };
  const child = spawn(backendPath, [], { env });
  // If git-http-backend exits before consuming the request body (rejected
  // request, bad PATH_INFO, etc.), Node emits EPIPE on child.stdin. Without
  // a listener the error escalates to uncaughtException and would crash the
  // test process.
  child.stdin.on('error', () => undefined);
  req.pipe(child.stdin);
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.on('close', () => {
    writeCgiResponse(res, Buffer.concat(chunks));
  });
  child.on('error', (err) => {
    res.statusCode = 502;
    res.end(`CGI spawn error: ${err.message}`);
  });
};

export const startGitHttpBackend = async (
  opts: StartGitHttpBackendOpts,
): Promise<GitHttpBackend> => {
  const backendPath = findGitHttpBackend();
  if (backendPath === undefined) {
    throw new Error('git-http-backend not found on $PATH');
  }
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer((req, res) => {
    handleRequest(backendPath, opts.projectRoot, req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, host, resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server.address() returned an unexpected value');
  }
  const port = addr.port;
  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return { port, close };
};
