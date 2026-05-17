import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { clone } from '../../../../src/application/commands/clone.js';
import { TsgitError } from '../../../../src/domain/index.js';
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
import { recordingProgress, withProgress } from './fixtures.js';

const REMOTE_URL = 'https://remote.example/r.git';
const ENCODER = new TextEncoder();

interface CloneFixtureOptions {
  readonly refs: ReadonlyArray<{ readonly name: string; readonly id: string }>;
  readonly head: string; // ref name the HEAD symref points at (or oid for detached)
  readonly capabilities: ReadonlyArray<string>;
  readonly packBytes: Uint8Array;
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
  it('Given depth: 1, When clone, Then throws UNSUPPORTED_OPERATION naming Phase 12.2', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    let caught: unknown;
    try {
      await clone(ctx, { url: REMOTE_URL, depth: 1 });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as {
      readonly code: string;
      readonly operation?: string;
      readonly reason?: string;
    };
    expect(data.code).toBe('UNSUPPORTED_OPERATION');
    expect(data.operation).toBe('clone-shallow');
    expect(data.reason).toContain('depth');
    expect(data.reason).toContain('12.2');
  });

  it('Given depth: 0, When clone, Then throws UNSUPPORTED_OPERATION with the full reason', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    let caught: unknown;
    try {
      await clone(ctx, { url: REMOTE_URL, depth: 0 });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as {
      readonly code: string;
      readonly operation?: string;
      readonly reason?: string;
    };
    expect(data.code).toBe('UNSUPPORTED_OPERATION');
    expect(data.operation).toBe('clone-shallow');
    expect(data.reason).toContain('depth');
    expect(data.reason).toContain('12.2');
  });

  it('Given an existing .git, When clone, Then throws TARGET_DIRECTORY_NOT_EMPTY pointing at workDir', async () => {
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
    // Side-channel: the .git dir must NOT have been created — the empty-url
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
    // Direct OID (no `ref: ...` prefix).
    expect(headFile.trim()).toBe(blobId);
  });

  it('Given the bootstrap completed and fetchPack throws, When clone, Then rolls back the .git skeleton', async () => {
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
