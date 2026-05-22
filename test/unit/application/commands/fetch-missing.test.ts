/**
 * `fetchMissing` command + the `createPromisorRemote` port implementation.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  createPromisorRemote,
  fetchMissing,
} from '../../../../src/application/commands/fetch-missing.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type { Context } from '../../../../src/ports/context.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { buildSyntheticPack } from '../primitives/pack-fixture.js';
import { seedRepo } from './fixtures.js';

const ENCODER = new TextEncoder();
const CAPS = 'side-band-64k ofs-delta';
const FAKE_TIP = 'b'.repeat(40) as ObjectId;
const URL = 'https://example.com/r.git';

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** Two-flush smart-HTTP advertisement: `# service` pkt+flush, ref pkt+flush. */
const advertisementBytes = (): Uint8Array => {
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const refs = encodePktStream([ENCODER.encode(`${FAKE_TIP} refs/heads/main\0${CAPS}\n`)]);
  const out = new Uint8Array(header.length + refs.length);
  out.set(header, 0);
  out.set(refs, header.length);
  return out;
};

/** NAK pkt followed by the pack body framed on side-band channel 1. */
const packBodyBytes = (packBytes: Uint8Array): Uint8Array => {
  const channel1 = new Uint8Array(packBytes.length + 1);
  channel1[0] = 0x01;
  channel1.set(packBytes, 1);
  return encodePktStream([ENCODER.encode('NAK\n'), channel1]);
};

interface FakeRemote {
  readonly transport: HttpTransport;
  readonly requests: HttpRequest[];
}

const fakeRemote = (packBytes: Uint8Array): FakeRemote => {
  const requests: HttpRequest[] = [];
  const advertisement = advertisementBytes();
  const pack = packBodyBytes(packBytes);
  const transport: HttpTransport = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      const body = req.url.includes('info/refs') ? advertisement : pack;
      return { statusCode: 200, headers: {}, body: streamOf(body.slice()) };
    },
  };
  return { transport, requests };
};

/** A transport that fails the test if any request reaches it. */
const forbiddenTransport = (): HttpTransport => ({
  request: async (): Promise<HttpResponse> => {
    throw new Error('network must not be touched');
  },
});

const withConfig = (ctx: Context, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);

const PARTIAL_CONFIG = `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = ${URL}\n`;

const onePackedBlob = async (
  ctx: Context,
  content: string,
): Promise<{ packBytes: Uint8Array; blobId: ObjectId }> => {
  const built = await buildSyntheticPack(ctx, [
    { kind: 'base', type: 'blob', content: ENCODER.encode(content) },
  ]);
  return { packBytes: built.packBytes, blobId: built.ids[0] as ObjectId };
};

describe('fetchMissing', () => {
  it('Given a repo with no [extensions] partialClone, When fetchMissing, Then throws NO_PROMISOR_REMOTE', async () => {
    // Arrange
    const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
    await seedRepo(ctx, {});

    // Act
    let caught: unknown;
    try {
      await fetchMissing(ctx, { oids: [FAKE_TIP] });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('NO_PROMISOR_REMOTE');
  });

  it('Given a non-partial repo, When the promisor port fetches, Then it reports attempted=false', async () => {
    // Arrange
    const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
    await seedRepo(ctx, {});

    // Act
    const sut = await createPromisorRemote(ctx).fetch([FAKE_TIP]);

    // Assert
    expect(sut).toEqual({ attempted: false, requested: 1, fetched: 0 });
  });

  it('Given a promisor remote with no url, When fetchMissing, Then throws REMOTE_NOT_CONFIGURED', async () => {
    // Arrange
    const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
    await seedRepo(ctx, {});
    await withConfig(ctx, '[extensions]\n\tpartialClone = origin\n');

    // Act
    let caught: unknown;
    try {
      await fetchMissing(ctx, { oids: [FAKE_TIP] });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data;
    expect(data.code).toBe('REMOTE_NOT_CONFIGURED');
    if (data.code !== 'REMOTE_NOT_CONFIGURED') throw new Error('unreachable');
    expect(data.remote).toBe('origin');
  });

  it('Given a promisor remote with an empty url, When fetchMissing, Then throws REMOTE_NOT_CONFIGURED', async () => {
    // Arrange
    const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
    await seedRepo(ctx, {});
    await withConfig(ctx, '[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl =\n');

    // Act
    let caught: unknown;
    try {
      await fetchMissing(ctx, { oids: [FAKE_TIP] });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data;
    expect(data.code).toBe('REMOTE_NOT_CONFIGURED');
    if (data.code !== 'REMOTE_NOT_CONFIGURED') throw new Error('unreachable');
    expect(data.remote).toBe('origin');
  });

  it('Given an empty oid list, When fetchMissing, Then it is a no-op with no network call', async () => {
    // Arrange
    const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
    await seedRepo(ctx, {});
    await withConfig(ctx, PARTIAL_CONFIG);

    // Act
    const sut = await fetchMissing(ctx, { oids: [] });

    // Assert
    expect(sut).toEqual({ remote: 'origin', requested: 0, fetched: 0 });
  });

  it('Given oids already present locally, When fetchMissing, Then they are skipped with no network call', async () => {
    // Arrange
    const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
    await seedRepo(ctx, {});
    await withConfig(ctx, PARTIAL_CONFIG);
    const present = 'c'.repeat(40) as ObjectId;
    await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, present), new Uint8Array([1]));

    // Act
    const sut = await fetchMissing(ctx, { oids: [present] });

    // Assert
    expect(sut).toEqual({ remote: 'origin', requested: 1, fetched: 0 });
  });

  it('Given a missing oid, When fetchMissing, Then the object is fetched and a promisor pack is written', async () => {
    // Arrange
    const base = createMemoryContext();
    await seedRepo(base, {});
    await withConfig(base, PARTIAL_CONFIG);
    const { packBytes, blobId } = await onePackedBlob(base, 'lazy content\n');
    const { transport, requests } = fakeRemote(packBytes);
    const ctx: Context = { ...base, transport };

    // Act
    const sut = await fetchMissing(ctx, { oids: [blobId] });

    // Assert
    expect(sut).toEqual({ remote: 'origin', requested: 1, fetched: 1 });
    expect(requests.some((r) => r.url.includes('info/refs'))).toBe(true);
    expect(requests.some((r) => r.url.includes('git-upload-pack'))).toBe(true);
    const packSha = await ctx.hash.hashHex(packBytes.subarray(0, -20));
    const promisorPath = `${ctx.layout.gitDir}/objects/pack/pack-${packSha}.promisor`;
    expect(await ctx.fs.exists(promisorPath)).toBe(true);
  });

  it('Given a concurrent identical pack already on disk, When fetchMissing, Then the FILE_EXISTS collision is tolerated', async () => {
    // Arrange
    const base = createMemoryContext();
    await seedRepo(base, {});
    await withConfig(base, PARTIAL_CONFIG);
    const { packBytes, blobId } = await onePackedBlob(base, 'collision\n');
    const { transport } = fakeRemote(packBytes);
    const ctx: Context = { ...base, transport };
    const packSha = await ctx.hash.hashHex(packBytes.subarray(0, -20));
    const packDir = `${ctx.layout.gitDir}/objects/pack`;
    await ctx.fs.mkdir(packDir);
    await ctx.fs.writeExclusive(`${packDir}/pack-${packSha}.pack`, packBytes);

    // Act
    const sut = await fetchMissing(ctx, { oids: [blobId] });

    // Assert — the pre-existing pack made writeExclusive throw FILE_EXISTS,
    // which fetchMissing swallows: the objects are already on disk.
    expect(sut).toEqual({ remote: 'origin', requested: 1, fetched: 1 });
  });

  it('Given a duplicate oid in the list, When fetchMissing, Then it is fetched once', async () => {
    // Arrange
    const base = createMemoryContext();
    await seedRepo(base, {});
    await withConfig(base, PARTIAL_CONFIG);
    const { packBytes, blobId } = await onePackedBlob(base, 'deduped\n');
    const { transport, requests } = fakeRemote(packBytes);
    const ctx: Context = { ...base, transport };

    // Act — the same missing oid appears twice.
    const sut = await fetchMissing(ctx, { oids: [blobId, blobId] });

    // Assert — collectMissing de-duplicates, so it is fetched once.
    expect(sut).toEqual({ remote: 'origin', requested: 2, fetched: 1 });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('Given a partial repo and a missing object, When the promisor port fetches, Then it reports attempted=true', async () => {
    // Arrange
    const base = createMemoryContext();
    await seedRepo(base, {});
    await withConfig(base, PARTIAL_CONFIG);
    const { packBytes, blobId } = await onePackedBlob(base, 'port path\n');
    const { transport } = fakeRemote(packBytes);
    const ctx: Context = { ...base, transport };

    // Act
    const sut = await createPromisorRemote(ctx).fetch([blobId]);

    // Assert
    expect(sut).toEqual({ attempted: true, requested: 1, fetched: 1 });
  });

  it('Given fetchPack fails with a non-FILE_EXISTS error, When fetchMissing, Then the error propagates', async () => {
    // Arrange — discovery succeeds, the upload-pack POST returns 500.
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    await withConfig(ctx, PARTIAL_CONFIG);
    const advertisement = advertisementBytes();
    const transport: HttpTransport = {
      request: async (req: HttpRequest): Promise<HttpResponse> => {
        if (req.url.includes('info/refs')) {
          return { statusCode: 200, headers: {}, body: streamOf(advertisement.slice()) };
        }
        return { statusCode: 500, headers: {}, body: streamOf(new Uint8Array(0)) };
      },
    };

    // Act
    let caught: unknown;
    try {
      await fetchMissing({ ...ctx, transport }, { oids: [FAKE_TIP] });
    } catch (err) {
      caught = err;
    }

    // Assert — a non-FILE_EXISTS failure is rethrown, not swallowed.
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('HTTP_ERROR');
  });

  it('Given a configured auth credential, When fetchMissing, Then the credentialled fetch succeeds', async () => {
    // Arrange
    const base = createMemoryContext();
    await seedRepo(base, {});
    await withConfig(base, PARTIAL_CONFIG);
    const { packBytes, blobId } = await onePackedBlob(base, 'with auth\n');
    const { transport } = fakeRemote(packBytes);
    const ctx: Context = {
      ...base,
      transport,
      config: { auth: { type: 'bearer', token: 'sekret' } },
    };

    // Act
    const sut = await fetchMissing(ctx, { oids: [blobId] });

    // Assert — the auth-bearing transport pipeline still resolves the object.
    expect(sut).toEqual({ remote: 'origin', requested: 1, fetched: 1 });
  });
});
