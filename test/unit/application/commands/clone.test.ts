import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { clone } from '../../../../src/application/commands/clone.js';
import { readConfig } from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type { Context } from '../../../../src/ports/context.js';
import type { HashService } from '../../../../src/ports/hash-service.js';
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

/**
 * Real `git-http-backend` v2 responses start directly with `version 2\n` —
 * unlike v1, there is no `# service=...` prologue on the wire. See
 * `buildV2AdvertisementWithPrologueBytes` below for the non-default fixture
 * that still carries one, used to pin the client's peek-past-prologue path.
 */
const buildV2AdvertisementBytes = (opts: { readonly filter?: boolean } = {}): Uint8Array => {
  const fetchLine = opts.filter === true ? 'fetch=shallow wait-for-done filter\n' : 'fetch\n';
  return encodePktStream([
    ENCODER.encode('version 2\n'),
    ENCODER.encode('agent=git/test\n'),
    ENCODER.encode('object-format=sha1\n'),
    ENCODER.encode('ls-refs\n'),
    ENCODER.encode(fetchLine),
  ]);
};

/**
 * Some smart-HTTP servers still prepend the legacy `# service=...` prologue
 * ahead of a v2 capability list; negotiateDiscovery must peek past it rather
 * than assume every v2 response is prologue-free.
 */
const buildV2AdvertisementWithPrologueBytes = (
  opts: { readonly filter?: boolean } = {},
): Uint8Array =>
  concatUint8(
    encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]),
    buildV2AdvertisementBytes(opts),
  );

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
  /** When true, the v2 `fetch` command advertises the `filter` sub-feature. */
  readonly filter?: boolean;
  /** When true, the `info/refs` response still carries the `# service=...` prologue. */
  readonly prologue?: boolean;
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
  const filterOpts = opts.filter === undefined ? {} : { filter: opts.filter };
  const advertisement =
    opts.prologue === true
      ? buildV2AdvertisementWithPrologueBytes(filterOpts)
      : buildV2AdvertisementBytes(filterOpts);
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

/** `ctx.hash` with `withAlgorithm` stripped — a caller-supplied HashService need not be re-instantiable. */
const hashServiceWithoutWithAlgorithm = (hash: HashService): HashService => ({
  hash: hash.hash,
  hashHex: hash.hashHex,
  createHasher: hash.createHasher,
  algorithm: hash.algorithm,
  digestLength: hash.digestLength,
});

describe('clone', () => {
  describe('Given a sha1-default local repository cloning from a v1 peer advertising object-format=sha256', () => {
    describe('When clone', () => {
      it('Then it adopts sha256: the destination config declares it and every written oid is 64 hex', async () => {
        // Arrange — git's clone has no --object-format flag; it learns the
        // algorithm from the peer's own advertisement and adopts it.
        const ctx = createMemoryContext();
        const sourceCtx = createMemoryContext({ algorithm: 'sha256' });
        const { packBytes, blobId } = await buildPackFromSingleBlob(sourceCtx, 'cloned blob\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'object-format=sha256'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — destination config, block ordering, oid widths.
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config.indexOf('[extensions]')).toBe(0);
        expect(config.indexOf('[extensions]')).toBeLessThan(config.indexOf('[core]'));
        expect(config).toContain('objectformat = sha256');
        expect(result.fetchedRefs).toHaveLength(1);
        expect(result.fetchedRefs.every((ref) => ref.id.length === 64)).toBe(true);
        // The adopted format is REPORTED, not left to be inferred from an
        // oid's width. `submodule add`'s cross-format refusal reads this
        // field: inferring from `fetchedRefs` instead would pass silently
        // whenever a peer advertises only namespaces `writeFetchedRefs`
        // drops (`HEAD`, unsafe names, anything outside refs/heads and
        // refs/tags), leaving that list empty on a successful clone.
        expect(result.objectFormat).toBe('sha256');
      });
    });
  });

  describe('Given a hash service without withAlgorithm and a v1 peer advertising object-format=sha256', () => {
    describe('When clone', () => {
      it('Then it refuses UNSUPPORTED_OPERATION naming the hash service, not the peer', async () => {
        // Arrange — this is the one clone path that still refuses: a caller
        // supplied a HashService that cannot be re-instantiated for another
        // algorithm, so adoption is impossible. The peer's sha256 is a
        // perfectly supported format — the limitation is the caller's own
        // adapter, so reporting UNSUPPORTED_OBJECT_FORMAT here would send
        // them to fix the wrong end. `bundleVerify` refuses the identical
        // condition the same way.
        const baseCtx = createMemoryContext();
        const ctx: Context = { ...baseCtx, hash: hashServiceWithoutWithAlgorithm(baseCtx.hash) };
        const { packBytes, blobId } = await buildPackFromSingleBlob(baseCtx, 'cloned blob\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'object-format=sha256'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
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
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('UNSUPPORTED_OPERATION');
        if (data.code !== 'UNSUPPORTED_OPERATION') expect.unreachable();
        expect(data.operation).toBe('clone');
        expect(data.reason).toContain('sha256');
      });
    });
  });

  describe('Given a hash service without withAlgorithm and a peer advertising the local object-format', () => {
    describe('When clone', () => {
      it('Then it clones without ever asking the service to switch', async () => {
        // Arrange — the peer already agrees with us, so no adoption is needed
        // and the absent capability must never be reached. Folding the
        // agreement check into the adoption path would turn every ordinary
        // same-format clone into an UNSUPPORTED_OPERATION for such a caller.
        const baseCtx = createMemoryContext();
        const ctx: Context = { ...baseCtx, hash: hashServiceWithoutWithAlgorithm(baseCtx.hash) };
        const sourceCtx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(sourceCtx, 'cloned blob\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'object-format=sha1'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(result.objectFormat).toBe('sha1');
        expect(result.fetchedRefs).toHaveLength(1);
      });
    });
  });

  describe('Given a peer advertising object-format sha256 and an instrumented pre-derivation context', () => {
    describe('When clone runs against a sha1-configured context', () => {
      it('Then nothing reads hash or hashConfig through the original context once bootstrap has started writing', async () => {
        // Arrange — a hazard specific to this repository: `readConfig` and
        // the pack registry memoize per-Context identity, so a call that
        // slips through with the pre-adoption context instead of the
        // derived one reproduces an intermittent OBJECT_NOT_FOUND. Track
        // every `hash`/`hashConfig` read on the ORIGINAL context, gated by a
        // marker that flips the moment bootstrap performs its first
        // filesystem write — the one legitimate read (copying `ctx.hash`/
        // `ctx.hashConfig` while deriving the adopted context) always
        // happens before that marker flips.
        const ctx = createMemoryContext();
        const sourceCtx = createMemoryContext({ algorithm: 'sha256' });
        const { packBytes, blobId } = await buildPackFromSingleBlob(sourceCtx, 'tracked blob\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'object-format=sha256'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);
        let bootstrapStarted = false;
        const trackingFs = new Proxy(networkCtx.fs, {
          get(target, prop, receiver) {
            if (prop === 'mkdir') bootstrapStarted = true;
            return Reflect.get(target, prop, receiver);
          },
        });
        // Every downstream write needs `fs`/`layout` for its I/O path and
        // `hash`/`hashConfig` for object widths — a helper threaded the
        // wrong context touches at least one of the four, whether or not
        // that particular call happens to also produce an organic failure.
        const IDENTITY_SENSITIVE_PROPS = new Set(['fs', 'layout', 'hash', 'hashConfig']);
        let staleReadsAfterBootstrap = 0;
        const trackingCtx = new Proxy(
          { ...networkCtx, fs: trackingFs },
          {
            get(target, prop, receiver) {
              if (bootstrapStarted && IDENTITY_SENSITIVE_PROPS.has(String(prop))) {
                staleReadsAfterBootstrap += 1;
              }
              return Reflect.get(target, prop, receiver);
            },
          },
        );

        // Act
        await clone(trackingCtx, { url: REMOTE_URL });

        // Assert
        expect(staleReadsAfterBootstrap).toBe(0);
      });
    });
  });

  describe('Given a peer advertising a different object-format and an instrumented deltaCache', () => {
    describe('When clone adopts the peer algorithm and keeps the session', () => {
      it('Then no oid-keyed cache holds an entry at the moment the algorithm is adopted', async () => {
        // Arrange — the assertion that licenses `deriveContext`'s
        // `keepSessionAcrossHashChange` at this call site: the swap happens
        // during bootstrap, before any oid-keyed cache is populated, proven
        // here by tracking every `deltaCache.get`/`set` call up to the
        // first filesystem write bootstrap performs.
        const ctx = createMemoryContext();
        const sourceCtx = createMemoryContext({ algorithm: 'sha256' });
        const { packBytes, blobId } = await buildPackFromSingleBlob(sourceCtx, 'pre-adopt blob\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'object-format=sha256'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);
        let bootstrapStarted = false;
        const trackingFs = new Proxy(networkCtx.fs, {
          get(target, prop, receiver) {
            if (prop === 'mkdir') bootstrapStarted = true;
            return Reflect.get(target, prop, receiver);
          },
        });
        let touchedBeforeBootstrap = 0;
        const trackingDeltaCache = new Proxy(networkCtx.deltaCache, {
          get(target, prop, receiver) {
            if (!bootstrapStarted && (prop === 'get' || prop === 'set')) {
              touchedBeforeBootstrap += 1;
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const trackingCtx: Context = {
          ...networkCtx,
          fs: trackingFs,
          deltaCache: trackingDeltaCache,
        };

        // Act
        await clone(trackingCtx, { url: REMOTE_URL });

        // Assert
        expect(touchedBeforeBootstrap).toBe(0);
      });
    });
  });

  describe('Given a peer advertising a different object-format and an instrumented session', () => {
    describe('When clone adopts the peer algorithm', () => {
      it('Then the derived pack context reuses the ORIGINAL session identity — `session` is read exactly twice (the spread copy, then the keep-session ternary), never minted fresh', async () => {
        // Arrange — `deriveContext`'s `{ ...ctx, ...changes, session: freshSession ? createSession() : ctx.session }`
        // reads `ctx.session` once via the object-spread copy and, ONLY when
        // `keepSessionAcrossHashChange` licenses reuse, a second time via the
        // ternary's `ctx.session` branch. A mutant that drops or falsifies
        // that option forces `createSession()` instead, so the ternary never
        // re-reads `ctx.session` — exactly one read instead of two.
        const ctx = createMemoryContext();
        const sourceCtx = createMemoryContext({ algorithm: 'sha256' });
        const { packBytes, blobId } = await buildPackFromSingleBlob(
          sourceCtx,
          'session-identity blob\n',
        );
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'object-format=sha256'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);
        let sessionReads = 0;
        const trackingCtx: Context = new Proxy(networkCtx, {
          get(target, prop, receiver) {
            if (prop === 'session') sessionReads += 1;
            return Reflect.get(target, prop, receiver);
          },
        });

        // Act
        await clone(trackingCtx, { url: REMOTE_URL });

        // Assert
        expect(sessionReads).toBe(2);
      });
    });
  });

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
        const result = await clone(networkCtx, { url: REMOTE_URL, depth: 1 });

        // Assert
        expect(result.head).toBe('refs/heads/main');
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

  describe('Given an occupied destination whose config holds an invalid core.maxTreeDepth', () => {
    describe('When clone', () => {
      it('Then throws TARGET_DIRECTORY_NOT_EMPTY, never a config refusal', async () => {
        // Arrange — git reports "already exists" here and never reads the
        // destination's config, so occupancy must win over config validity.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

        // Act
        let caught: unknown;
        try {
          await clone(ctx, { url: REMOTE_URL });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { readonly code: string };
        expect(data.code).toBe('TARGET_DIRECTORY_NOT_EMPTY');
      });
    });
  });

  describe('Given an empty destination alongside a config file holding an invalid core.maxTreeDepth', () => {
    describe('When clone', () => {
      it('Then proceeds normally (clone never reads a destination-side config)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'hello\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — no CONFIG_BAD_NUMERIC_VALUE; the clone completes.
        expect(result.head).toBe('refs/heads/main');
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(result.head).toBe('refs/heads/main');
        expect(result.fetchedRefs.map((r) => r.name)).toContain('refs/heads/main');
        expect(result.fetchedRefs.map((r) => r.name)).toContain('refs/remotes/origin/main');
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(result.head).toBe('refs/heads/main');
        expect(result.fetchedRefs.map((r) => r.name)).toContain('refs/heads/main');
        expect(result.fetchedRefs.map((r) => r.name)).toContain('refs/remotes/origin/main');
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

  describe('Given a v2-capable remote whose info/refs response still carries the smart-HTTP service prologue', () => {
    describe('When clone', () => {
      it('Then it negotiates via ls-refs + v2 fetch and checks out the tracked branch', async () => {
        // Arrange — some smart-HTTP servers keep sending the legacy
        // `# service=...` line ahead of the v2 capability list; negotiateDiscovery
        // must peek past it rather than assume every v2 response is prologue-free.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(
          ctx,
          'v2 clone with prologue\n',
        );
        const { transport } = buildCloneRemoteV2({
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
          prologue: true,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(result.head).toBe('refs/heads/main');
        expect(result.fetchedRefs.map((r) => r.name)).toContain('refs/heads/main');
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        const names = result.fetchedRefs.map((r) => r.name);
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — the local branch ref is created ONLY for the HEAD branch.
        // The `branch === headBranch` gate must hold: a mutant forcing it true
        // would write `refs/heads/feature` for the non-HEAD branch.
        const names = result.fetchedRefs.map((r) => r.name);
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert
        expect(result.head).toBeUndefined();
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — tag goes verbatim under refs/tags, never remapped to refs/remotes.
        const names = result.fetchedRefs.map((r) => r.name);
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — the literal `HEAD` ref must be skipped (not remapped/written).
        const names = result.fetchedRefs.map((r) => r.name);
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — only the HEAD-tracked branch gets a local refs/heads entry.
        const names = result.fetchedRefs.map((r) => r.name);
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
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — the unsupported ref is not written, and the skip is logged.
        const names = result.fetchedRefs.map((r) => r.name);
        expect(names).not.toContain('refs/notes/commits');
        expect(names).not.toContain('refs/remotes/origin/commits');
        expect(debugCalls).toContainEqual({
          message: 'clone: skipping unsupported ref namespace',
          context: { name: 'refs/notes/commits' },
        });
      });
    });
  });

  describe('Given a discovery with a path-traversal ref name (refs/heads/../../../config)', () => {
    describe('When clone', () => {
      it('Then the malicious ref is not written and the legitimate ref still is', async () => {
        // Arrange — a hostile server advertises a ref name that, once
        // prefixed with refs/remotes/origin/, would escape .git and
        // overwrite gitDir/config.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'safe\n');
        const transport = buildCloneRemote({
          capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'refs/heads/main', id: blobId },
            { name: 'refs/heads/../../../config', id: blobId },
          ],
          head: 'refs/heads/main',
          packBytes,
        });
        const networkCtx = withTransport(ctx, transport);

        // Act
        const result = await clone(networkCtx, { url: REMOTE_URL });

        // Assert — the malicious ref is dropped, the legitimate ref is
        // written, and gitDir/config is untouched (not clobbered with a raw oid).
        const names = result.fetchedRefs.map((r) => r.name);
        expect(names).not.toContain('refs/remotes/origin/../../../config');
        expect(names).toContain('refs/remotes/origin/main');
        const configAfter = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(configAfter).toContain('[core]');
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

        // Act
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

  describe('Given a v2-capable server whose fetch command advertises filter', () => {
    describe('When clone with blob:none', () => {
      it('Then it does not throw and sends the filter arg over the v2 fetch request', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'v2 filtered\n');
        const { transport, requests } = buildCloneRemoteV2({
          refs: [{ name: 'refs/heads/main', id: blobId }],
          head: 'refs/heads/main',
          packBytes,
          filter: true,
        });

        // Act
        await clone(withTransport(ctx, transport), { url: REMOTE_URL, filter: 'blob:none' });

        // Assert — the v2 fetch command request carries the filter arg, and
        // the promisor config block is written just like the v1 path.
        const fetchRequest = requests.find(
          (r) => r.body !== undefined && DECODER.decode(r.body).includes('command=fetch'),
        );
        expect(fetchRequest).toBeDefined();
        expect(DECODER.decode(fetchRequest?.body)).toContain('filter blob:none');
        const parsed = await readConfig(ctx);
        expect(parsed.remote?.get('origin')?.promisor).toBe(true);
        expect(parsed.remote?.get('origin')?.partialCloneFilter).toBe('blob:none');
      });
    });
  });

  describe('Given a v2-capable server whose fetch command does not advertise filter', () => {
    describe('When clone with a filter', () => {
      it('Then throws REMOTE_FILTER_UNSUPPORTED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'v2 unfiltered\n');
        const { transport } = buildCloneRemoteV2({
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
