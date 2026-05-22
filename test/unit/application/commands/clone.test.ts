import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { clone } from '../../../../src/application/commands/clone.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
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

describe('clone', () => {
  it('Given depth: 1 and a server emitting a shallow block, When clone, Then writes.git/shallow with the boundary oid', async () => {
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

  it('Given an existing.git, When clone, Then throws TARGET_DIRECTORY_NOT_EMPTY pointing at workDir', async () => {
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
    const data = (caught as TsgitError).data as { readonly code: string; readonly path?: string };
    expect(data.code).toBe('TARGET_DIRECTORY_NOT_EMPTY');
    expect(data.path).toBe(ctx.layout.workDir);
  });

  it('Given empty url, When clone, Then throws REMOTE_ADVERTISES_NO_REFS before any I/O', async () => {
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

  it('Given a discovery with one branch + a pack, When clone, Then writes refs/heads/main, refs/remotes/origin/main, and HEAD', async () => {
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

  it('Given a discovery with one branch + a pack, When clone, Then the written refs and HEAD reflogs all carry a "clone: from <url>" message', async () => {
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
    const { readReflog } = await import('../../../../src/application/primitives/reflog-store.js');
    const expected = [`clone: from ${REMOTE_URL}`];
    expect((await readReflog(ctx, 'refs/heads/main' as RefName)).map((e) => e.message)).toEqual(
      expected,
    );
    expect(
      (await readReflog(ctx, 'refs/remotes/origin/main' as RefName)).map((e) => e.message),
    ).toEqual(expected);
    expect((await readReflog(ctx, 'HEAD' as RefName)).map((e) => e.message)).toEqual(expected);
  });

  it('Given a symref HEAD whose target branch is not advertised, When clone, Then no HEAD reflog is written', async () => {
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
    const { reflogExists } = await import('../../../../src/application/primitives/reflog-store.js');
    expect(await reflogExists(ctx, 'HEAD' as RefName)).toBe(false);
  });

  it('Given a discovery with multiple branches, When clone, Then writes refs/remotes/origin/<branch> for every advertised branch', async () => {
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

  it('Given a discovery with a non-HEAD branch, When clone, Then no local refs/heads/<branch> is written for it', async () => {
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

  it('Given a discovery with no refs, When clone, Then throws REMOTE_ADVERTISES_NO_REFS', async () => {
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

  it('Given a discovery without symref=HEAD, When clone, Then writes HEAD as a direct oid (detached) and returns head: undefined', async () => {
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

  it('Given the bootstrap completed and fetchPack throws, When clone, Then rolls back the.git skeleton', async () => {
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

  it('Given a resolver that resolves to a blocked address, When clone, Then validateUrl runs and throws BLOCKED_HOST', async () => {
    // Arrange — a resolver pointing the URL host at a loopback address. The
    // in-clone validateUrl path only runs when `opts.resolver` is supplied.
    const ctx = createMemoryContext();
    const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'ssrf\n');
    const transport = buildCloneRemote({
      capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
      refs: [{ name: 'refs/heads/main', id: blobId }],
      head: 'refs/heads/main',
      packBytes,
    });
    const networkCtx = withTransport(ctx, transport);
    const resolver = async (): Promise<ReadonlyArray<string>> => ['127.0.0.1'];

    // Act
    let caught: unknown;
    try {
      await clone(networkCtx, { url: REMOTE_URL, resolver });
    } catch (err) {
      caught = err;
    }

    // Assert — if the resolver branch body were skipped, clone would succeed.
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('BLOCKED_HOST');
  });

  it('Given a resolver and a public address, When clone, Then validateUrl passes and the clone completes', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const { packBytes, blobId } = await buildPackFromSingleBlob(ctx, 'resolver ok\n');
    const transport = buildCloneRemote({
      capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
      refs: [{ name: 'refs/heads/main', id: blobId }],
      head: 'refs/heads/main',
      packBytes,
    });
    const networkCtx = withTransport(ctx, transport);
    const resolver = async (): Promise<ReadonlyArray<string>> => ['93.184.216.34'];

    // Act
    const sut = await clone(networkCtx, { url: REMOTE_URL, resolver });

    // Assert
    expect(sut.head).toBe('refs/heads/main');
  });

  it('Given no bare option, When clone, Then the written config records bare = false', async () => {
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

  it('Given ctx.config.auth, When clone, Then every transport request carries the Authorization header', async () => {
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

  it('Given no ctx.config.auth, When clone, Then transport requests carry no Authorization header', async () => {
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

  it('Given a discovery with a tag ref, When clone, Then writes refs/tags/<tag> and not under refs/remotes', async () => {
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

  it('Given a discovery with a HEAD ref entry, When clone, Then the HEAD ref is skipped silently and not written', async () => {
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
    const debugCalls: Array<{ message: string; context?: Readonly<Record<string, unknown>> }> = [];
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

  it('Given a branch that is not the HEAD-tracked branch, When clone, Then no local refs/heads/<branch> is written for it', async () => {
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

  it('Given a ref in an unsupported namespace and a debug logger, When clone, Then the ref is logged and skipped', async () => {
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
    const debugCalls: Array<{ message: string; context?: Readonly<Record<string, unknown>> }> = [];
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

describe('clone — progress reporting', () => {
  it("Given a successful clone, When run, Then start fires before end with op === 'clone:discover'", async () => {
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

  it('Given a clone that throws (target not empty), When run, Then end still fires when start fired', async () => {
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
    expect(endCount).toBe(startCount);
  });
});

describe('clone — partial clone', () => {
  it('Given an invalid filter spec, When clone, Then throws INVALID_FILTER_SPEC before any network call', async () => {
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

  it('Given a server that does not advertise filter, When clone with a filter, Then throws REMOTE_FILTER_UNSUPPORTED', async () => {
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

  it('Given a filter-capable server, When clone with blob:none, Then the promisor config block and .promisor sentinel are written', async () => {
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

    // Assert
    const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
    expect(config).toContain('repositoryformatversion = 1');
    expect(config).toContain('[extensions]');
    expect(config).toContain('partialClone = origin');
    expect(config).toContain('[remote "origin"]');
    expect(config).toContain('promisor = true');
    expect(config).toContain('partialclonefilter = blob:none');
    const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
    expect(packDir.some((e) => e.name.endsWith('.promisor'))).toBe(true);
  });

  it('Given no filter, When clone, Then no [extensions] or [remote] section is written', async () => {
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
    const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
    expect(config).not.toContain('[extensions]');
    expect(config).not.toContain('[remote');
  });
});
