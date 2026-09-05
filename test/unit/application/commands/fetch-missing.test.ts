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
const advertisementBytes = (caps: string = CAPS): Uint8Array => {
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const refs = encodePktStream([ENCODER.encode(`${FAKE_TIP} refs/heads/main\0${caps}\n`)]);
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

const fakeRemote = (packBytes: Uint8Array, caps?: string): FakeRemote => {
  const requests: HttpRequest[] = [];
  const advertisement = advertisementBytes(caps);
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

/**
 * A stub ssh transport whose channel serves a broken advertisement, so the
 * session throws after the channel is open. `closeSpy` counts channel teardown calls.
 */
const brokenSshTransport = () => {
  const closeSpy = { calls: 0 };
  const open = async () => ({
    stdin: new WritableStream<Uint8Array>({ write: () => undefined }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENCODER.encode('not a pkt-line stream'));
        controller.close();
      },
    }),
    exit: Promise.resolve(0),
    close: async () => {
      closeSpy.calls += 1;
    },
  });
  return { ssh: { open }, closeSpy };
};

const withConfig = (ctx: Context, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);

const PARTIAL_CONFIG = `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = ${URL}\n`;

const SSH_URL = 'ssh://git@example.invalid/repo.git';
const SSH_PARTIAL_CONFIG = `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = ${SSH_URL}\n`;

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
  describe('Given a repo with no [extensions] partialClone', () => {
    describe('When fetchMissing', () => {
      it('Then throws NO_PROMISOR_REMOTE', async () => {
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
    });
  });

  describe('Given a non-partial repo', () => {
    describe('When the promisor port fetches', () => {
      it('Then it reports attempted=false', async () => {
        // Arrange
        const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
        await seedRepo(ctx, {});

        // Act
        const result = await createPromisorRemote(ctx).fetch([FAKE_TIP]);

        // Assert
        expect(result).toEqual({ attempted: false, requested: 1, fetched: 0 });
      });
    });
  });

  describe('Given a promisor remote with no url', () => {
    describe('When fetchMissing', () => {
      it('Then throws REMOTE_NOT_CONFIGURED', async () => {
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
    });
  });

  describe('Given a promisor remote with an empty url', () => {
    describe('When fetchMissing', () => {
      it('Then throws REMOTE_NOT_CONFIGURED', async () => {
        // Arrange
        const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
        await seedRepo(ctx, {});
        await withConfig(
          ctx,
          '[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl =\n',
        );

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
    });
  });

  describe('Given an empty oid list', () => {
    describe('When fetchMissing', () => {
      it('Then it is a no-op with no network call', async () => {
        // Arrange
        const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
        await seedRepo(ctx, {});
        await withConfig(ctx, PARTIAL_CONFIG);

        // Act
        const result = await fetchMissing(ctx, { oids: [] });

        // Assert
        expect(result).toEqual({ remote: 'origin', requested: 0, fetched: 0 });
      });
    });
  });

  describe('Given the promisor remote holds a promisor value git refuses', () => {
    describe('When fetchMissing', () => {
      it('Then throws CONFIG_BAD_BOOLEAN_VALUE naming remote.origin.promisor', async () => {
        // Arrange
        const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
        await seedRepo(ctx, {});
        await withConfig(ctx, `${PARTIAL_CONFIG}\tpromisor = maybe\n`);

        // Act
        let caught: unknown;
        try {
          await fetchMissing(ctx, { oids: [FAKE_TIP] });
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          value: string;
          source: string;
        };
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('remote.origin.promisor');
        expect(data.value).toBe('maybe');
        expect(data.source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given the promisor remote holds a promisor value git accepts', () => {
    describe('When fetchMissing is called with an empty oid list', () => {
      it('Then it is a no-op with no network call — the guard no-ops on a valid value', async () => {
        // Arrange
        const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
        await seedRepo(ctx, {});
        await withConfig(ctx, `${PARTIAL_CONFIG}\tpromisor = true\n`);

        // Act
        const result = await fetchMissing(ctx, { oids: [] });

        // Assert
        expect(result).toEqual({ remote: 'origin', requested: 0, fetched: 0 });
      });
    });
  });

  describe('Given no [extensions] partialClone is configured, even with a malformed promisor elsewhere', () => {
    describe('When fetchMissing', () => {
      it('Then throws NO_PROMISOR_REMOTE, not CONFIG_BAD_BOOLEAN_VALUE — the guard never runs', async () => {
        // Arrange — a malformed remote.origin.promisor sits in a repo that
        // never selects a promisor remote, so the guard must not fire.
        const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
        await seedRepo(ctx, {});
        await withConfig(ctx, `[remote "origin"]\n\turl = ${URL}\n\tpromisor = maybe\n`);

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
    });
  });

  describe('Given oids already present locally', () => {
    describe('When fetchMissing', () => {
      it('Then they are skipped with no network call', async () => {
        // Arrange
        const ctx: Context = { ...createMemoryContext(), transport: forbiddenTransport() };
        await seedRepo(ctx, {});
        await withConfig(ctx, PARTIAL_CONFIG);
        const present = 'c'.repeat(40) as ObjectId;
        await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, present), new Uint8Array([1]));

        // Act
        const result = await fetchMissing(ctx, { oids: [present] });

        // Assert
        expect(result).toEqual({ remote: 'origin', requested: 1, fetched: 0 });
      });
    });
  });

  describe('Given an oid already present in a local pack rather than loose', () => {
    describe('When fetchMissing', () => {
      it('Then the pack-registry lookup skips it with no network call', async () => {
        // Arrange — the first fetch installs the object in a local promisor
        // pack (packed, not loose); a second fetch must find it through the
        // pack index, so the loose probe alone is not enough to skip it.
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'packed local\n');
        const { transport } = fakeRemote(packBytes);
        const seeded: Context = { ...base, transport };
        await fetchMissing(seeded, { oids: [blobId] });

        // Act — the object now lives only in a local pack; touching the
        // network would throw.
        const result = await fetchMissing(
          { ...seeded, transport: forbiddenTransport() },
          { oids: [blobId] },
        );

        // Assert — the pack registry reports it present, so nothing is fetched.
        expect(result).toEqual({ remote: 'origin', requested: 1, fetched: 0 });
      });
    });
  });

  describe('Given a missing oid', () => {
    describe('When fetchMissing', () => {
      it('Then the object is fetched and a promisor pack is written', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'lazy content\n');
        const { transport, requests } = fakeRemote(packBytes);
        const ctx: Context = { ...base, transport };

        // Act
        const result = await fetchMissing(ctx, { oids: [blobId] });

        // Assert
        expect(result).toEqual({ remote: 'origin', requested: 1, fetched: 1 });
        expect(requests.some((r) => r.url.includes('info/refs'))).toBe(true);
        expect(requests.some((r) => r.url.includes('git-upload-pack'))).toBe(true);
        const packSha = await ctx.hash.hashHex(packBytes.subarray(0, -20));
        const promisorPath = `${ctx.layout.gitDir}/objects/pack/pack-${packSha}.promisor`;
        expect(await ctx.fs.exists(promisorPath)).toBe(true);
      });
    });
  });

  describe('Given a promisor remote advertising a different hash algorithm', () => {
    describe('When fetchMissing negotiates', () => {
      it('Then it refuses rather than accepting a cross-format pack', async () => {
        // Arrange — the lazy-fetch path reaches a peer exactly as `fetch` does,
        // so it owes the same refusal: a sha256 peer serving a sha1 repository
        // would otherwise write wrong-width oids with nothing objecting.
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'lazy content\n');
        const { transport } = fakeRemote(packBytes, `${CAPS} object-format=sha256`);
        const ctx: Context = { ...base, transport };
        const sut = fetchMissing;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { oids: [blobId] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('UNSUPPORTED_OBJECT_FORMAT');
        if (data.code !== 'UNSUPPORTED_OBJECT_FORMAT') expect.unreachable();
        expect(data.format).toBe('sha256');
        expect(data.local).toBe('sha1');
      });
    });
  });

  describe('Given a corrupt index already occupying the pack sibling name', () => {
    describe('When fetchMissing receives the pack', () => {
      it('Then it refuses naming the index, as git does', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'collision\n');
        const { transport } = fakeRemote(packBytes);
        const ctx: Context = { ...base, transport };
        const packSha = await ctx.hash.hashHex(packBytes.subarray(0, -20));
        const packDir = `${ctx.layout.gitDir}/objects/pack`;
        const idxPath = `${packDir}/pack-${packSha}.idx`;
        await ctx.fs.mkdir(packDir);
        await ctx.fs.writeExclusive(idxPath, new Uint8Array(0));
        const sut = fetchMissing;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { oids: [blobId] });
        } catch (err) {
          caught = err;
        }

        // Assert — the pack itself is absent, so the receive renames its quarantine
        // copy into place, then finds the zero-byte index differs from the one it
        // would write: a refusal, never a silent success over an unreadable pack.
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) expect.unreachable();
        expect(caught.data.code).toBe('PACK_ARTIFACT_MISMATCH');
        if (caught.data.code !== 'PACK_ARTIFACT_MISMATCH') expect.unreachable();
        expect(caught.data.path).toBe(idxPath);
      });
    });
  });

  describe('Given a duplicate oid in the list', () => {
    describe('When fetchMissing', () => {
      it('Then it is fetched once', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'deduped\n');
        const { transport, requests } = fakeRemote(packBytes);
        const ctx: Context = { ...base, transport };

        // Act — the same missing oid appears twice.
        const result = await fetchMissing(ctx, { oids: [blobId, blobId] });

        // Assert — collectMissing de-duplicates, so it is fetched once.
        expect(result).toEqual({ remote: 'origin', requested: 2, fetched: 1 });
        expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
      });
    });
  });

  describe('Given a partial repo and a missing object', () => {
    describe('When the promisor port fetches', () => {
      it('Then it reports attempted=true', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'port path\n');
        const { transport } = fakeRemote(packBytes);
        const ctx: Context = { ...base, transport };

        // Act
        const result = await createPromisorRemote(ctx).fetch([blobId]);

        // Assert
        expect(result).toEqual({ attempted: true, requested: 1, fetched: 1 });
      });
    });
  });

  describe('Given fetchPack fails', () => {
    describe('When fetchMissing', () => {
      it('Then the error propagates', async () => {
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

        // Assert — the failure propagates.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('HTTP_ERROR');
      });
    });
  });

  describe('Given the identical pack already occupies the sibling artefact name', () => {
    describe('When fetchMissing', () => {
      it('Then the receive adopts it and completes the siblings', async () => {
        // Arrange — the receive path adopts an identical occupant itself; a
        // pre-created pack at the same content-addressed name must not be
        // treated as a failure.
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'already present\n');
        const { transport } = fakeRemote(packBytes);
        const ctx: Context = { ...base, transport };
        const packSha = await ctx.hash.hashHex(packBytes.subarray(0, -20));
        const packDir = `${ctx.layout.gitDir}/objects/pack`;
        const packPath = `${packDir}/pack-${packSha}.pack`;
        await ctx.fs.mkdir(packDir);
        await ctx.fs.writeExclusive(packPath, packBytes);

        // Act
        const result = await fetchMissing(ctx, { oids: [blobId] });

        // Assert
        expect(result).toEqual({ remote: 'origin', requested: 1, fetched: 1 });
        expect(await ctx.fs.exists(`${packDir}/pack-${packSha}.idx`)).toBe(true);
        expect(await ctx.fs.exists(`${packDir}/pack-${packSha}.rev`)).toBe(true);
      });
    });
  });

  describe('Given a configured auth credential', () => {
    describe('When fetchMissing', () => {
      it('Then the fetch carries it', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedRepo(base, {});
        await withConfig(base, PARTIAL_CONFIG);
        const { packBytes, blobId } = await onePackedBlob(base, 'with auth\n');
        const { transport, requests } = fakeRemote(packBytes);
        const ctx: Context = {
          ...base,
          transport,
          config: { auth: { type: 'bearer', token: 'sekret' } },
        };

        // Act
        const result = await fetchMissing(ctx, { oids: [blobId] });

        // Assert — the configured credential reached the wire: the `{ auth }`
        // spread was passed to `withDefaults`, not an empty object.
        expect(result).toEqual({ remote: 'origin', requested: 1, fetched: 1 });
        const post = requests.find((r) => r.method === 'POST');
        expect(post?.headers?.authorization).toBe('Bearer sekret');
      });
    });
  });

  describe('Given an ssh promisor session that fails mid-fetch', () => {
    describe('When fetchMissing', () => {
      it('Then the ssh channel is released by the finally', async () => {
        // Arrange
        const { ssh, closeSpy } = brokenSshTransport();
        const ctx: Context = { ...createMemoryContext(), ssh };
        await seedRepo(ctx, {});
        await withConfig(ctx, SSH_PARTIAL_CONFIG);

        // Act
        let caught: unknown;
        try {
          await fetchMissing(ctx, { oids: [FAKE_TIP] });
        } catch (err) {
          caught = err;
        }

        // Assert — the mid-session failure propagates AND the finally closed
        // the channel exactly once.
        expect(caught).toBeInstanceOf(TsgitError);
        expect(closeSpy.calls).toBe(1);
      });
    });
  });
});
