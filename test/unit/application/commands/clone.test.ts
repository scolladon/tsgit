import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { clone } from '../../../../src/application/commands/clone.js';
import { readConfig } from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type { Context } from '../../../../src/ports/context.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import {
  buildDiscoveryBody,
  buildUploadPackResponseBody,
} from '../../../fixtures/transport/builders.js';
import { buildSyntheticPack, type EntrySpec } from '../primitives/pack-fixture.js';
import { recordedTransport, recordingProgress, withProgress } from './fixtures.js';

const REMOTE_URL = 'https://remote.example/r.git';
const ENCODER = new TextEncoder();

interface CloneFixtureOptions {
  readonly refs: ReadonlyArray<{ readonly name: string; readonly id: string }>;
  readonly head: string; // ref name the HEAD symref points at (or oid for detached)
  readonly capabilities: ReadonlyArray<string>;
  readonly packBytes: Uint8Array;
  /** Shallow oids emitted before NAK + pack. */
  readonly shallow?: ReadonlyArray<string>;
}

const buildCloneRemote = (opts: CloneFixtureOptions): HttpTransport => {
  const discoveryBody = buildDiscoveryBody({
    service: 'git-upload-pack',
    capabilities: opts.capabilities,
    refs: opts.refs,
  });
  const packResponseBody = buildUploadPackResponseBody({
    packBytes: opts.packBytes,
    sideBand: true,
    shallow: opts.shallow ?? [],
  });
  return {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      const isDiscovery = req.url.includes('/info/refs');
      const body = isDiscovery ? discoveryBody : packResponseBody;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.slice());
            controller.close();
          },
        }),
      };
    },
  };
};

const withTransport = (ctx: Context, transport: HttpTransport): Context => ({
  ...ctx,
  transport,
});

const buildPackFromSingleBlob = async (
  ctx: Context,
  content: string,
): Promise<{ packBytes: Uint8Array; blobId: string }> => {
  const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: ENCODER.encode(content) }];
  const built = await buildSyntheticPack(ctx, entries);
  const id = built.ids[0];
  if (id === undefined) throw new Error('expected one entry');
  return { packBytes: built.packBytes, blobId: id };
};

const DECODER = new TextDecoder();

const concatUint8 = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const buildV2AdvertisementBytes = (): Uint8Array => {
  // Smart-HTTP still sends the `# service=...` prologue ahead of the v2
  // capability list — negotiateDiscovery consumes it before peeking. Built
  // directly (rather than via `buildDiscoveryBody`) so there is exactly one
  // flush between the prologue and the capability list, not two.
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const capabilities = encodePktStream([
    ENCODER.encode('version 2\n'),
    ENCODER.encode('agent=git/test\n'),
    ENCODER.encode('object-format=sha1\n'),
    ENCODER.encode('ls-refs\n'),
    ENCODER.encode('fetch\n'),
  ]);
  return concatUint8(header, capabilities);
};

const buildLsRefsResponseBytes = (
  refs: ReadonlyArray<{ name: string; id: string }>,
  head: string,
): Uint8Array => {
  const headId = refs.find((r) => r.name === head)?.id;
  if (headId === undefined) {
    throw new Error(`fixture invariant violated: ${head} is not among the generated refs`);
  }
  const headLine = ENCODER.encode(`${headId} HEAD symref-target:${head}\n`);
  return encodePktStream([headLine, ...refs.map((r) => ENCODER.encode(`${r.id} ${r.name}\n`))]);
};

const buildV2PackResponseBytes = (packBytes: Uint8Array): Uint8Array => {
  const channel1 = new Uint8Array(packBytes.length + 1);
  channel1[0] = 0x01;
  channel1.set(packBytes, 1);
  return encodePktStream([ENCODER.encode('packfile\n'), channel1]);
};

interface CloneFixtureV2Options {
  readonly refs: ReadonlyArray<{ readonly name: string; readonly id: string }>;
  readonly head: string;
  readonly packBytes: Uint8Array;
}

/**
 * A v2-capable remote: `info/refs` answers the v2 capability list; the same
 * `git-upload-pack` POST endpoint serves both `ls-refs` and `fetch` command
 * requests, distinguished by the `command=` line in the request body.
 */
const buildCloneRemoteV2 = (
  opts: CloneFixtureV2Options,
): { transport: HttpTransport; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const advertisement = buildV2AdvertisementBytes();
  const lsRefsResponse = buildLsRefsResponseBytes(opts.refs, opts.head);
  const packResponse = buildV2PackResponseBytes(opts.packBytes);
  const transport: HttpTransport = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      const requestText = req.body === undefined ? '' : DECODER.decode(req.body);
      const body = req.url.includes('/info/refs')
        ? advertisement
        : requestText.includes('command=ls-refs')
          ? lsRefsResponse
          : packResponse;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.slice());
            controller.close();
          },
        }),
      };
    },
  };
  return { transport, requests };
};

describe('clone', () => {
  describe('Given depth: 1 and a server emitting a shallow block', () => {
    describe('When clone', () => {
      it('Then writes.git/shallow with the boundary oid', async () => {
        // Arrange reopens depth on clone. The shallow
        // section is wrapped into the upload-pack response before the NAK.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'shallow blob\n');
        const shallowOid = 'a'.repeat(40);
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
          shallow: [shallowOid],
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL, depth: 1 });

        // Assert
        expect(sut.head).toBe('refs/heads/main');
        const shallowFile = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
        expect(shallowFile).toBe(`${shallowOid}\n`);
      });
    });
  });

  describe('Given an existing.git', () => {
    describe('When clone', () => {
      it('Then throws TARGET_DIRECTORY_NOT_EMPTY pointing at workDir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        let caught: unknown;
        try {
          await clone(ctx, { url: REMOTE_URL });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          readonly code: string;
          readonly path?: string;
        };
        expect(data.code).toBe('TARGET_DIRECTORY_NOT_EMPTY');
        expect(data.path).toBe(ctx.layout.workDir);
      });
    });
  });

  describe('Given empty url', () => {
    describe('When clone', () => {
      it('Then throws REMOTE_ADVERTISES_NO_REFS before any I/O', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await clone(ctx, { url: '' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REMOTE_ADVERTISES_NO_REFS');
        // Side-channel: the.git dir must NOT have been created — the empty-url
        // guard fires before bootstrap. Asserting this pins the order of the two
        // guards at the top of clone() against any reordering mutant.
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a discovery with one branch + a pack', () => {
    describe('When clone', () => {
      it('Then writes refs/heads/main, refs/remotes/origin/main, and HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'cloned blob\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(sut.head).toBe('refs/heads/main');
        expect(sut.fetchedRefs.map((r) => r.name)).toContain('refs/heads/main');
        expect(sut.fetchedRefs.map((r) => r.name)).toContain('refs/remotes/origin/main');
        const headFile = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(headFile).toBe('ref: refs/heads/main\n');
        const mainRef = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
        expect(mainRef.trim()).toBe(blobId);
        const remoteRef = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`);
        expect(remoteRef.trim()).toBe(blobId);
      });
      it('Then the written refs and HEAD reflogs all carry a "clone: from <url>" message', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'reflogged clone\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        await clone(networkCtx, { url: REMOTE_URL });

        // Assert — every loggable ref written by clone records the clone source.
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );
        const expected = [`clone: from ${REMOTE_URL}`];
        expect((await readReflog(ctx, 'refs/heads/main' as RefName)).map((e) => e.message)).toEqual(
          expected,
        );
        expect(
          (await readReflog(ctx, 'refs/remotes/origin/main' as RefName)).map((e) => e.message),
        ).toEqual(expected);
        expect((await readReflog(ctx, 'HEAD' as RefName)).map((e) => e.message)).toEqual(expected);
      });
    });
  });

  describe('Given a v2-capable remote advertising one branch', () => {
    describe('When clone', () => {
      it('Then it negotiates via ls-refs + v2 fetch and checks out the tracked branch', async () => {
        // Arrange — the remote's ls-refs response carries HEAD's
        // symref-target; parseLsRefsResponse surfaces it as a
        // `symref=HEAD:...` capability, so v2 clone tracks the branch exactly
        // like the v1 happy path instead of leaving HEAD detached.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'v2 clone\n');
        const { transport, requests } = buildCloneRemoteV2({
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(sut.head).toBe('refs/heads/main');
        expect(sut.fetchedRefs.map((r) => r.name)).toContain('refs/heads/main');
        expect(sut.fetchedRefs.map((r) => r.name)).toContain('refs/remotes/origin/main');
        const headFile = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(headFile).toBe('ref: refs/heads/main\n');
        const mainRef = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
        expect(mainRef.trim()).toBe(blobId);
        const remoteRef = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`);
        expect(remoteRef.trim()).toBe(blobId);
        const requestBodies = requests
          .filter((r) => r.method === 'POST')
          .map((r) => (r.body === undefined ? '' : DECODER.decode(r.body)));
        expect(requestBodies.some((b) => b.includes('command=ls-refs'))).toBe(true);
        expect(requestBodies.some((b) => b.includes('command=fetch'))).toBe(true);
      });
    });
  });

  describe('Given a symref HEAD whose target branch is not advertised', () => {
    describe('When clone', () => {
      it('Then no HEAD reflog is written', async () => {
        // Arrange — the symref names `refs/heads/ghost`, but only `refs/heads/main`
        // is advertised, so the advertisement carries no HEAD oid. logClonedHead
        // must early-return rather than record a HEAD entry with a missing newId.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'ghost head\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/ghost'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        await clone(networkCtx, { url: REMOTE_URL });

        // Assert — HEAD has no reflog file: the unresolved head oid skips logging.
        const { reflogExists } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );
        expect(await reflogExists(ctx, 'HEAD' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a discovery with multiple branches', () => {
    describe('When clone', () => {
      it('Then writes refs/remotes/origin/<branch> for every advertised branch', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'multi branch\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'refs/heads/main', id: blobId },
            { name: 'refs/heads/dev', id: blobId },
            { name: 'refs/heads/feature', id: blobId },
          ],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        const names = sut.fetchedRefs.map((r) => r.name);
        expect(names).toContain('refs/remotes/origin/main');
        expect(names).toContain('refs/remotes/origin/dev');
        expect(names).toContain('refs/remotes/origin/feature');
        for (const branch of ['main', 'dev', 'feature']) {
          const ref = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/${branch}`);
          expect(ref.trim()).toBe(blobId);
        }
      });
    });
  });

  describe('Given a discovery with a non-HEAD branch', () => {
    describe('When clone', () => {
      it('Then no local refs/heads/<branch> is written for it', async () => {
        // Arrange — HEAD tracks `main`; `feature` is advertised but is not the
        // HEAD branch, so only its remote-tracking ref must be written locally.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'head-branch only\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'refs/heads/main', id: blobId },
            { name: 'refs/heads/feature', id: blobId },
          ],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — the local branch ref is created ONLY for the HEAD branch.
        // The `branch === headBranch` gate must hold: a mutant forcing it true
        // would write `refs/heads/feature` for the non-HEAD branch.
        const names = sut.fetchedRefs.map((r) => r.name);
        expect(names).toContain('refs/heads/main');
        expect(names).not.toContain('refs/heads/feature');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature`)).toBe(true);
      });
    });
  });

  describe('Given a discovery with no refs', () => {
    describe('When clone', () => {
      it('Then throws REMOTE_ADVERTISES_NO_REFS', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes } = await buildPackFromSingleBlob(ctx, 'unused\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k'],
          refs: [],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        let caught: unknown;
        try {
          await clone(networkCtx, { url: REMOTE_URL });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REMOTE_ADVERTISES_NO_REFS');
      });
    });
  });

  describe('Given a discovery without symref=HEAD', () => {
    describe('When clone', () => {
      it('Then writes HEAD as a direct oid (detached) and returns head: undefined', async () => {
        // Arrange — emulate a server that advertises HEAD directly (no symref capability).
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'detached head\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k'], // no symref=HEAD:... cap
          refs: [
            { name: 'HEAD', id: blobId },
            { name: 'refs/heads/main', id: blobId },
          ],
          head: 'HEAD',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(sut.head).toBeUndefined();
        const headFile = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        // Direct OID (no `ref:...` prefix).
        expect(headFile.trim()).toBe(blobId);
      });
    });
  });

  describe('Given the bootstrap completed and fetchPack throws', () => {
    describe('When clone', () => {
      it('Then rolls back the.git skeleton', async () => {
        // Arrange — server returns a corrupted trailer so fetch-pack throws.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'rollback me\n');
        const corrupted = packBytes.slice();
        corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes: corrupted,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        let caught: unknown;
        try {
          await clone(networkCtx, { url: REMOTE_URL });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const gitDirExists = await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`);
        expect(gitDirExists).toBe(false);
      });
    });
  });

  describe('Given no bare option', () => {
    describe('When clone', () => {
      it('Then the written config records bare = false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'bare default\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        await clone(networkCtx, { url: REMOTE_URL });

        // Assert — `bare: opts.bare ?? false` must default to false.
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config).toContain('bare = false');
      });
    });
  });

  describe('Given ctx.config.auth', () => {
    describe('When clone', () => {
      it('Then every transport request carries the Authorization header', async () => {
        // Arrange — wrap the cloning transport so requests are captured. withDefaults
        // composes withAuth around ctx.transport using ctx.config.auth.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'authed\n');
        const remote = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const { transport, requests } = recordedTransport(remote);
        const networkCtx: Context = {
          ...withTransport(ctx, transport),
          config: { auth: { type: 'bearer', token: 'secret-token' } },
        };

        // Act
        await clone(networkCtx, { url: REMOTE_URL });

        // Assert — every recorded request must carry the bearer header.
        expect(requests.length).toBeGreaterThan(0);
        for (const req of requests) {
          expect(req.headers.authorization).toBe('Bearer secret-token');
        }
      });
    });
  });

  describe('Given no ctx.config.auth', () => {
    describe('When clone', () => {
      it('Then transport requests carry no Authorization header', async () => {
        // Arrange — without config.auth, withDefaults must not compose withAuth.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'no auth\n');
        const remote = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const { transport, requests } = recordedTransport(remote);
        const networkCtx = withTransport(ctx, transport);

        // Act
        await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(requests.length).toBeGreaterThan(0);
        for (const req of requests) {
          expect(req.headers.authorization).toBeUndefined();
        }
      });
    });
  });

  describe('Given a discovery with a tag ref', () => {
    describe('When clone', () => {
      it('Then writes refs/tags/<tag> and not under refs/remotes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'tagged\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'refs/heads/main', id: blobId },
            { name: 'refs/tags/v1.0', id: blobId },
          ],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — tag goes verbatim under refs/tags, never remapped to refs/remotes.
        const names = sut.fetchedRefs.map((r) => r.name);
        expect(names).toContain('refs/tags/v1.0');
        expect(names).not.toContain('refs/remotes/origin/v1.0');
        const tagRef = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/tags/v1.0`);
        expect(tagRef.trim()).toBe(blobId);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/v1.0`)).toBe(false);
      });
    });
  });

  describe('Given a discovery with a HEAD ref entry', () => {
    describe('When clone', () => {
      it('Then the HEAD ref is skipped silently and not written', async () => {
        // Arrange — the advertisement explicitly carries a `HEAD` ref alongside a branch.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'head skip\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'HEAD', id: blobId },
            { name: 'refs/heads/main', id: blobId },
          ],
          head: 'refs/heads/main',
          packBytes,
        });
        const debugCalls: Array<{ message: string; context?: Readonly<Record<string, unknown>> }> =
          [];
        const networkCtx: Context = {
          ...withTransport(ctx, transport),
          logger: {
            debug: (message, context) => {
              debugCalls.push(context !== undefined ? { message, context } : { message });
            },
          },
        };

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — the literal `HEAD` ref must be skipped (not remapped/written).
        const names = sut.fetchedRefs.map((r) => r.name);
        expect(names).not.toContain('HEAD');
        expect(names).not.toContain('refs/remotes/origin/HEAD');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/HEAD`)).toBe(false);
        // The genuine branch is still written — proves the skip is HEAD-specific.
        expect(names).toContain('refs/remotes/origin/main');
        // The `=== 'HEAD'` guard must skip BEFORE the unsupported-namespace log:
        // a `=== ''` mutant would let HEAD fall through to the debug log.
        expect(debugCalls.map((c) => c.context?.name)).not.toContain('HEAD');
      });
    });
  });

  describe('Given a branch that is not the HEAD-tracked branch', () => {
    describe('When clone', () => {
      it('Then no local refs/heads/<branch> is written for it', async () => {
        // Arrange — HEAD tracks `main`; `dev` is advertised but not HEAD-tracked.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'non-head branch\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'refs/heads/main', id: blobId },
            { name: 'refs/heads/dev', id: blobId },
          ],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — only the HEAD-tracked branch gets a local refs/heads entry.
        const names = sut.fetchedRefs.map((r) => r.name);
        expect(names).toContain('refs/heads/main');
        expect(names).not.toContain('refs/heads/dev');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/dev`)).toBe(false);
        // Both branches still get their remote-tracking ref.
        expect(names).toContain('refs/remotes/origin/dev');
      });
    });
  });

  describe('Given a ref in an unsupported namespace and a debug logger', () => {
    describe('When clone', () => {
      it('Then the ref is logged and skipped', async () => {
        // Arrange — `refs/notes/*` is outside the heads/tags layout policy.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'notes ns\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'refs/heads/main', id: blobId },
            { name: 'refs/notes/commits', id: blobId },
          ],
          head: 'refs/heads/main',
          packBytes,
        });
        const debugCalls: Array<{ message: string; context?: Readonly<Record<string, unknown>> }> =
          [];
        const networkCtx: Context = {
          ...withTransport(ctx, transport),
          logger: {
            debug: (message, context) => {
              debugCalls.push(context !== undefined ? { message, context } : { message });
            },
          },
        };

        // Act
        const sut = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — the unsupported ref is not written, and the skip is logged.
        const names = sut.fetchedRefs.map((r) => r.name);
        expect(names).not.toContain('refs/notes/commits');
        expect(names).not.toContain('refs/remotes/origin/commits');
        expect(debugCalls).toContainEqual({
          message: 'clone: skipping unsupported ref namespace',
          context: { name: 'refs/notes/commits' },
        });
      });
    });
  });
});

describe('clone — progress reporting', () => {
  describe('Given a successful clone', () => {
    describe('When run', () => {
      it("Then start fires before end with op === 'clone:discover'", async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'progress\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const { reporter, events } = recordingProgress();
        const probeCtx = withProgress(withTransport(ctx, transport), reporter);

        // Act
        await clone(probeCtx, { url: REMOTE_URL });

        // Assert
        expect(events[0]).toEqual({ kind: 'start', op: 'clone:discover' });
        expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'clone:discover' });
      });
    });
  });

  describe('Given a clone that throws (target not empty)', () => {
    describe('When run', () => {
      it('Then end still fires when start fired', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.gitDir}`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const { reporter, events } = recordingProgress();

        try {
          await clone(withProgress(ctx, reporter), { url: REMOTE_URL });
        } catch {
          // expected
        }

        const startCount = events.filter((e) => e.kind === 'start').length;
        const endCount = events.filter((e) => e.kind === 'end').length;
        // Assert
        expect(endCount).toBe(startCount);
      });
    });
  });
});

describe('clone — partial clone', () => {
  describe('Given an invalid filter spec', () => {
    describe('When clone', () => {
      it('Then throws INVALID_FILTER_SPEC before any network call', async () => {
        // Arrange — a transport that fails the test if discovery is reached.
        const ctx = withTransport(createMemoryContext(), {
          request: async (): Promise<HttpResponse> => {
            throw new Error('network must not be touched');
          },
        });

        // Act
        let caught: unknown;
        try {
          await clone(ctx, { url: REMOTE_URL, filter: 'not-a-filter' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_FILTER_SPEC');
        if (data.code !== 'INVALID_FILTER_SPEC') throw new Error('unreachable');
        expect(data.spec).toBe('not-a-filter');
        expect(data.reason).toBe('unknown-kind');
      });
    });
  });

  describe('Given a server that does not advertise filter', () => {
    describe('When clone with a filter', () => {
      it('Then throws REMOTE_FILTER_UNSUPPORTED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'unfiltered\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });

        // Act
        let caught: unknown;
        try {
          await clone(withTransport(ctx, transport), { url: REMOTE_URL, filter: 'blob:none' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REMOTE_FILTER_UNSUPPORTED');
      });
    });
  });

  describe('Given a filter-capable server', () => {
    describe('When clone with blob:none', () => {
      it('Then the promisor config block and .promisor sentinel are written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'filtered\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'filter', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });

        // Act
        await clone(withTransport(ctx, transport), { url: REMOTE_URL, filter: 'blob:none' });

        // Assert — the promisor block round-trips through the config parser, so
        // every section / subsection / value reached `.git/config` intact.
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config).toContain('repositoryformatversion = 1');
        const parsed = await readConfig(ctx);
        const remote = parsed.remote?.get('origin');
        expect(remote?.url).toBe(REMOTE_URL);
        expect(remote?.fetch).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
        expect(remote?.promisor).toBe(true);
        expect(remote?.partialCloneFilter).toBe('blob:none');
        expect(parsed.extensions?.partialClone).toBe('origin');
        expect(parsed.branch?.get('main')).toEqual({
          remote: 'origin',
          merge: 'refs/heads/main',
        });
        const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
        expect(packDir.some((e) => e.name.endsWith('.promisor'))).toBe(true);
      });
    });
  });

  describe('Given a normal (non-partial) clone', () => {
    describe('When clone', () => {
      it('Then writes [remote "origin"] and [branch "main"] upstream, but no [extensions]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'plain clone\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });

        // Act
        await clone(withTransport(ctx, transport), { url: REMOTE_URL });

        // Assert
        const parsed = await readConfig(ctx);
        const remote = parsed.remote?.get('origin');
        expect(remote?.url).toBe(REMOTE_URL);
        expect(remote?.fetch).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
        expect(remote?.promisor).toBeUndefined();
        expect(parsed.branch?.get('main')).toEqual({
          remote: 'origin',
          merge: 'refs/heads/main',
        });
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config).not.toContain('[extensions]');
      });
    });
  });

  describe('Given a detached clone (no symref=HEAD)', () => {
    describe('When clone', () => {
      it('Then writes the remote block but no [branch] upstream', async () => {
        // Arrange — server advertises HEAD directly; clone cannot name a head branch.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'detached config\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k'],
          refs: [
            { name: 'HEAD', id: blobId },
            { name: 'refs/heads/main', id: blobId },
          ],
          head: 'HEAD',
          packBytes,
        });

        // Act
        await clone(withTransport(ctx, transport), { url: REMOTE_URL });

        // Assert
        const parsed = await readConfig(ctx);
        expect(parsed.remote?.get('origin')?.url).toBe(REMOTE_URL);
        expect(parsed.branch).toBeUndefined();
      });
    });
  });
});
