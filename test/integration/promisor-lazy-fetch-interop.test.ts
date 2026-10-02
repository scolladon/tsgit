/**
 * Cross-tool interop for the promisor lazy fetch: a partial clone with two
 * promisor remotes, the first of which cannot serve. git tries the remotes in
 * its promisor order (`extensions.partialClone` last), reports the failing
 * one on stderr, and fetches the object from the next; tsgit must try the
 * same order, warn the same remote, and end with the same object set.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { fetchMissing } from '../../src/application/commands/fetch-missing.js';
import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import { ObjectId } from '../../src/domain/objects/index.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/ports/http-transport.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const SERVER_URL = 'https://example.com/server.git';
const DEAD_URL = 'https://example.com/dead.git';
const CGI_HEADER_SEPARATOR = '\r\n\r\n';
const NOT_FOUND = 404;

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

/** Serves `server.git` through `git http-backend`; every other repository is missing. */
const backendTransport = (projectRoot: string): HttpTransport => ({
  request: async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/server.git/')) {
      return {
        statusCode: NOT_FOUND,
        headers: {},
        body: new Response('').body as ReadableStream<Uint8Array>,
      };
    }
    const body = req.body ?? new Uint8Array(0);
    const result = spawnSync('git', ['http-backend'], {
      input: body,
      env: {
        ...runGitEnv(),
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_PROTOCOL: req.headers['git-protocol'] ?? req.headers['Git-Protocol'] ?? '',
        CONTENT_TYPE: req.headers['content-type'] ?? req.headers['Content-Type'] ?? '',
        CONTENT_LENGTH: String(body.byteLength),
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    return cgiResponse(result.stdout);
  },
});

const objectsOf = (dir: string): ReadonlyArray<string> =>
  runGit(['-C', dir, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])
    .trim()
    .split('\n')
    .sort();

describe.skipIf(!GIT_AVAILABLE)('promisor lazy fetch — cross-tool interop', () => {
  let root = '';
  let blobId = '';

  /** A blob-less partial clone whose promisor remotes, in git's order, are `dead` then `origin`. */
  const partialClone = (name: string, deadUrl: string, originUrl: string): string => {
    const dir = path.join(root, name);
    runGit([
      'clone',
      '-q',
      '--filter=blob:none',
      '--no-checkout',
      `file://${root}/server.git`,
      dir,
    ]);
    runGit(['-C', dir, 'remote', 'set-url', 'origin', originUrl]);
    runGit(['-C', dir, 'remote', 'add', 'dead', deadUrl]);
    runGit(['-C', dir, 'config', 'remote.dead.promisor', 'true']);
    // git 2.55's clone no longer names its remote here; naming it moves origin behind `dead`.
    runGit(['-C', dir, 'config', 'extensions.partialClone', 'origin']);
    return dir;
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-promisor-lazy-')));
    const work = path.join(root, 'work');
    runGit(['init', '-q', '-b', 'main', work]);
    await writeFile(path.join(work, 'f.txt'), 'lazy content\n');
    runGit(['-C', work, 'add', 'f.txt']);
    runGit(['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c']);
    blobId = runGit(['-C', work, 'rev-parse', 'HEAD:f.txt']).trim();
    runGit(['clone', '-q', '--bare', work, path.join(root, 'server.git')]);
    for (const key of ['uploadpack.allowFilter', 'uploadpack.allowAnySHA1InWant']) {
      runGit(['-C', path.join(root, 'server.git'), 'config', key, 'true']);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('Given a partial clone whose first promisor remote cannot serve', () => {
    describe('When both tools lazily fetch a missing blob', () => {
      it('Then both skip the dead remote, fetch from origin and end with the same objects', async () => {
        // Arrange
        const gitDir = partialClone(
          'git-clone',
          `file://${root}/dead.git`,
          `file://${root}/server.git`,
        );
        const oursDir = partialClone('ours-clone', DEAD_URL, SERVER_URL);
        const warned: unknown[] = [];
        const ctx = {
          ...createNodeContext({ workDir: oursDir }),
          transport: backendTransport(root),
          logger: {
            warn: (_message: string, context?: Record<string, unknown>) =>
              warned.push(context?.remote),
          },
        };
        const sut = fetchMissing;

        // Act
        const git = tryRunGitWithExit(['-C', gitDir, 'cat-file', '-p', blobId], {
          env: runGitEnv(),
        });
        const result = await sut(ctx, { oids: [ObjectId.from(blobId)] });
        await disposePackRegistry(ctx);

        // Assert
        expect(git.exitCode).toBe(0);
        expect(git.stdout).toBe('lazy content\n');
        expect(git.stderr).toContain('dead.git');
        expect(result.remote).toBe('origin');
        expect(warned).toEqual(['dead']);
        expect(objectsOf(oursDir)).toEqual(objectsOf(gitDir));
      });
    });
  });
});
