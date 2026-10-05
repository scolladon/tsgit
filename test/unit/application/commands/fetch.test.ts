/**
 * fetch command. Real pack-driven body.
 *
 * Tests cover:
 *  - REMOTE_NOT_CONFIGURED guard; an empty remote fetches nothing.
 *  - Happy fetch (no shallow): pack written, refs/remotes/<remote>/* updated.
 *  - haves derivation (the request body carries `have <oid>` lines).
 *  - prune semantics (refs/remotes/<remote>/<branch> deletion).
 *  - shallow fetch (.git/shallow is written, result carries the oid).
 *  - Local refs (refs/heads/*, refs/tags/*) never touched.
 *  - Progress (fetch:negotiate + fetch:write-objects).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FetchResult, fetch } from '../../../../src/application/commands/fetch.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import * as peelModule from '../../../../src/application/primitives/internal/peel-ref-to-commit.js';
import {
  commonGitDir,
  looseObjectPath,
} from '../../../../src/application/primitives/path-layout.js';
import { getPackRegistry } from '../../../../src/application/primitives/read-object.js';
import { getRefStore, type RefUpdate } from '../../../../src/application/primitives/ref-store.js';
import { readReflog as reflogEntries } from '../../../../src/application/primitives/reflog-store.js';
import { readShallow } from '../../../../src/application/primitives/shallow-file.js';
import { updateRef as seedRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { emptyTreeOid, type ObjectId, type RefName } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { buildSyntheticPack, writeSyntheticPack } from '../primitives/pack-fixture.js';
import { recordingProgress, seedRepo, withProgress } from './fixtures.js';

const ENCODER = new TextEncoder();

const FAKE_OID = (label: string): ObjectId =>
  label.padEnd(40, label[0] ?? '0').slice(0, 40) as ObjectId;

const PRUNE_EPOCH_SECONDS = 1_800_000_000;

interface RemoteRef {
  readonly name: string;
  readonly id: ObjectId;
}

interface FakeRemoteOpts {
  readonly url: string;
  readonly advertisedRefs: ReadonlyArray<RemoteRef>;
  readonly advertisedCaps?: ReadonlyArray<string>;
  readonly packBytes: Uint8Array;
  /** Shallow / unshallow oids the server should emit before the NAK + pack. */
  readonly shallow?: ReadonlyArray<string>;
  readonly unshallow?: ReadonlyArray<string>;
}

const buildAdvertisementBytes = (
  refs: ReadonlyArray<RemoteRef>,
  caps: ReadonlyArray<string>,
): Uint8Array => {
  // smart-HTTP v1 advertisement layout:
  //  <pkt># service=git-upload-pack\n>
  //  <flush>
  //  <pkt>oid name\0caps\n>
  //  <pkt>oid name\n>...
  //  <flush>
  // Two encodePktStream calls produce the two flushes.
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const refLines: Uint8Array[] = [];
  refs.forEach((r, idx) => {
    if (idx === 0) {
      refLines.push(ENCODER.encode(`${r.id} ${r.name}\0${caps.join(' ')}\n`));
    } else {
      refLines.push(ENCODER.encode(`${r.id} ${r.name}\n`));
    }
  });
  const refsBody = encodePktStream(refLines);
  const out = new Uint8Array(header.length + refsBody.length);
  out.set(header, 0);
  out.set(refsBody, header.length);
  return out;
};

const buildPackBody = (
  packBytes: Uint8Array,
  shallow: ReadonlyArray<string>,
  unshallow: ReadonlyArray<string>,
): Uint8Array => {
  const shallowFrames = shallow.map((oid) => ENCODER.encode(`shallow ${oid}\n`));
  const unshallowFrames = unshallow.map((oid) => ENCODER.encode(`unshallow ${oid}\n`));
  const shallowSection =
    shallowFrames.length + unshallowFrames.length > 0
      ? encodePktStream([...shallowFrames, ...unshallowFrames])
      : new Uint8Array(0);
  const channel1 = new Uint8Array(packBytes.length + 1);
  channel1[0] = 0x01;
  channel1.set(packBytes, 1);
  const rest = encodePktStream([ENCODER.encode('NAK\n'), channel1]);
  const out = new Uint8Array(shallowSection.length + rest.length);
  out.set(shallowSection, 0);
  out.set(rest, shallowSection.length);
  return out;
};

const fakeRemote = (
  opts: FakeRemoteOpts,
): { transport: HttpTransport; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const advertisement = buildAdvertisementBytes(
    opts.advertisedRefs,
    opts.advertisedCaps ?? ['side-band-64k', 'ofs-delta'],
  );
  const packResponse = buildPackBody(opts.packBytes, opts.shallow ?? [], opts.unshallow ?? []);
  const transport: HttpTransport = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      const body = req.url.includes('info/refs') ? advertisement : packResponse;
      return {
        statusCode: 200,
        headers: {},
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

const DECODER = new TextDecoder();

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
): Uint8Array => {
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const capabilities = buildV2AdvertisementBytes(opts);
  const out = new Uint8Array(header.length + capabilities.length);
  out.set(header, 0);
  out.set(capabilities, header.length);
  return out;
};

const buildLsRefsResponseBytes = (refs: ReadonlyArray<RemoteRef>): Uint8Array =>
  encodePktStream(refs.map((r) => ENCODER.encode(`${r.id} ${r.name}\n`)));

const buildV2PackResponseBytes = (packBytes: Uint8Array): Uint8Array => {
  const channel1 = new Uint8Array(packBytes.length + 1);
  channel1[0] = 0x01;
  channel1.set(packBytes, 1);
  return encodePktStream([ENCODER.encode('packfile\n'), channel1]);
};

interface FakeRemoteV2Opts {
  readonly advertisedRefs: ReadonlyArray<RemoteRef>;
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
const fakeRemoteV2 = (
  opts: FakeRemoteV2Opts,
): { transport: HttpTransport; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const filterOpts = opts.filter === undefined ? {} : { filter: opts.filter };
  const advertisement =
    opts.prologue === true
      ? buildV2AdvertisementWithPrologueBytes(filterOpts)
      : buildV2AdvertisementBytes(filterOpts);
  const lsRefsResponse = buildLsRefsResponseBytes(opts.advertisedRefs);
  const packResponse = buildV2PackResponseBytes(opts.packBytes);
  const transport: HttpTransport = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      const requestText = req.body === undefined ? '' : DECODER.decode(req.body);
      const body = req.url.includes('info/refs')
        ? advertisement
        : requestText.includes('command=ls-refs')
          ? lsRefsResponse
          : packResponse;
      return {
        statusCode: 200,
        headers: {},
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

const writeOriginConfig = async (ctx: ReturnType<typeof createMemoryContext>): Promise<void> => {
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/config`,
    '[remote "origin"]\n  url = https://example.com/r.git\n' +
      '  fetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
};

const buildOneBlobPack = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content: string,
): Promise<{ packBytes: Uint8Array; blobId: ObjectId }> => {
  const built = await buildSyntheticPack(ctx, [
    { kind: 'base', type: 'blob', content: ENCODER.encode(content) },
  ]);
  return { packBytes: built.packBytes, blobId: built.ids[0] as ObjectId };
};

describe('fetch', () => {
  describe('config + advertisement guards', () => {
    describe('Given no remote configured', () => {
      describe('When fetch', () => {
        it('Then throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await fetch(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string };
          expect(data.code).toBe('REMOTE_NOT_CONFIGURED');
          expect(data.code).not.toBe('CONFIG_MISSING_VALUE');
        });
      });
    });

    describe('Given a remote with a valueless url entry', () => {
      describe('When fetch', () => {
        it('Then throws CONFIG_MISSING_VALUE with key remote.origin.url at line 2', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "origin"]\n\turl\n');
          __resetConfigCacheForTests();

          // Act
          let caught: unknown;
          try {
            await fetch(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            key: string;
            line: number;
            source: string;
          };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('remote.origin.url');
          expect(data.line).toBe(2);
          expect(data.source).toMatch(/\/config$/);
        });
      });
    });

    describe('Given an advertisement with zero refs', () => {
      describe('When fetch', () => {
        it('Then it succeeds, updating nothing and writing an empty FETCH_HEAD', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes } = await buildOneBlobPack(ctx, 'noop\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [],
            packBytes,
          });
          const sut = fetch;

          // Act
          const result = await sut({ ...ctx, transport }, { remote: 'origin' });

          // Assert
          expect(result.updatedRefs).toEqual([]);
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/FETCH_HEAD`)).toBe('');
        });
      });
    });

    describe('Given a sha1 local repository and a v1 peer advertising object-format=sha256', () => {
      describe('When fetch negotiates', () => {
        it("Then throws UNSUPPORTED_OBJECT_FORMAT with format 'sha256' and local 'sha1'", async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'noop\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            advertisedCaps: ['side-band-64k', 'ofs-delta', 'object-format=sha256'],
            packBytes,
          });

          // Act
          let caught: unknown;
          try {
            await fetch({ ...ctx, transport }, { remote: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'UNSUPPORTED_OBJECT_FORMAT',
            format: 'sha256',
            local: 'sha1',
          });
        });
      });
    });

    describe('Given a sha256 local repository and a v1 peer advertising object-format=sha1', () => {
      describe('When fetch negotiates', () => {
        it("Then throws UNSUPPORTED_OBJECT_FORMAT with format 'sha1' and local 'sha256'", async () => {
          // Arrange — the mirrored direction: local and peer swapped.
          const ctx = createMemoryContext({ algorithm: 'sha256' });
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'noop\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            advertisedCaps: ['side-band-64k', 'ofs-delta', 'object-format=sha1'],
            packBytes,
          });

          // Act
          let caught: unknown;
          try {
            await fetch({ ...ctx, transport }, { remote: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'UNSUPPORTED_OBJECT_FORMAT',
            format: 'sha1',
            local: 'sha256',
          });
        });
      });
    });
  });

  describe('happy path', () => {
    describe('Given an origin advertising one branch', () => {
      describe('When fetch', () => {
        it('Then result holds the resolved remote + url', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'hello fetch\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          expect(result.remote).toBe('origin');
          expect(result.url).toBe('https://example.com/r.git');
        });
      });
    });

    describe('Given an advertised branch ref', () => {
      describe('When fetch', () => {
        it('Then refs/remotes/origin/<branch> is written with the new oid', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'advance\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          const updated = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
          expect(updated).toBeDefined();
          expect(updated?.newId).toBe(blobId);
          const onDisk = (
            await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`)
          ).trim();
          expect(onDisk).toBe(blobId);
        });
        it('Then the remote-tracking ref reflog records a "fetch <remote>: storing head" entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'logged fetch\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert — the reflog message must name the remote, not be empty.
          const { readReflog } = await import(
            '../../../../src/application/primitives/reflog-store.js'
          );
          const entries = await readReflog(ctx, 'refs/remotes/origin/main' as RefName);
          expect(entries.map((e) => e.message)).toEqual(['fetch origin: storing head']);
        });
      });
    });

    describe('Given a v2-capable origin advertising one branch', () => {
      describe('When fetch', () => {
        it('Then it negotiates via ls-refs + v2 fetch and updates the remote-tracking ref', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'v2 fetch\n');
          const { transport, requests } = fakeRemoteV2({
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          const updated = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
          expect(updated?.newId).toBe(blobId);
          const requestBodies = requests
            .filter((r) => r.method === 'POST')
            .map((r) => (r.body === undefined ? '' : DECODER.decode(r.body)));
          expect(requestBodies.some((b) => b.includes('command=ls-refs'))).toBe(true);
          expect(requestBodies.some((b) => b.includes('command=fetch'))).toBe(true);
        });
      });
    });

    describe('Given a v2-capable origin whose info/refs response still carries the smart-HTTP service prologue', () => {
      describe('When fetch', () => {
        it('Then it negotiates via ls-refs + v2 fetch and updates the remote-tracking ref', async () => {
          // Arrange — some smart-HTTP servers keep sending the legacy
          // `# service=...` line ahead of the v2 capability list; negotiateDiscovery
          // must peek past it rather than assume every v2 response is prologue-free.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'v2 fetch with prologue\n');
          const { transport } = fakeRemoteV2({
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
            prologue: true,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          const updated = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
          expect(updated?.newId).toBe(blobId);
        });
      });
    });

    describe('Given an advertised tag', () => {
      describe('When fetch', () => {
        it('Then refs/tags/<tag> is written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'tag\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [
              { name: 'refs/heads/main', id: blobId },
              { name: 'refs/tags/v1', id: blobId },
            ],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          const tagWritten = result.updatedRefs.find((r) => r.name === 'refs/tags/v1');
          expect(tagWritten).toBeDefined();
          const onDisk = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/tags/v1`)).trim();
          expect(onDisk).toBe(blobId);
        });
      });
    });

    describe('Given a pre-existing remote-tracking ref', () => {
      describe('When fetch advances it', () => {
        it('Then oldId in updatedRefs matches the prior on-disk oid', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const oldOid = FAKE_OID('a');
          await seedRepo(ctx, { refs: { 'refs/remotes/origin/main': oldOid } });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'fast-forward\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          const updated = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
          expect(updated?.oldId).toBe(oldOid);
          expect(updated?.newId).toBe(blobId);
        });
      });
    });
  });

  describe('default remote resolution', () => {
    describe('Given a repo config and an optional explicit remote', () => {
      describe('When fetch is called', () => {
        it.each([
          {
            label:
              'branch.main.remote configured to a non-default remote resolves the tracked remote',
            configBody:
              '[remote "upstream"]\n  url = https://example.com/upstream.git\n[branch "main"]\n  remote = upstream\n',
            remoteUrl: 'https://example.com/upstream.git',
            opts: undefined,
            expectedRemote: 'upstream',
          },
          {
            label: 'an explicit remote option overrides branch tracking',
            configBody:
              '[remote "upstream"]\n  url = https://example.com/upstream.git\n[remote "explicit"]\n  url = https://example.com/explicit.git\n[branch "main"]\n  remote = upstream\n',
            remoteUrl: 'https://example.com/explicit.git',
            opts: { remote: 'explicit' },
            expectedRemote: 'explicit',
          },
          {
            label: 'exactly one non-origin remote with no branch tracking resolves the sole remote',
            configBody: '[remote "solo"]\n  url = https://example.com/solo.git\n',
            remoteUrl: 'https://example.com/solo.git',
            opts: undefined,
            expectedRemote: 'solo',
          },
          {
            label: 'exactly two remotes with no branch tracking default to origin',
            configBody:
              '[remote "origin"]\n  url = https://example.com/origin.git\n[remote "other"]\n  url = https://example.com/other.git\n',
            remoteUrl: 'https://example.com/origin.git',
            opts: undefined,
            expectedRemote: 'origin',
          },
        ] as const)(
          'Then it resolves to $expectedRemote ($label)',
          async ({ configBody, remoteUrl, opts, expectedRemote }) => {
            // Arrange
            const ctx = createMemoryContext();
            await seedRepo(ctx, {});
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, configBody);
            __resetConfigCacheForTests();
            const { packBytes, blobId } = await buildOneBlobPack(ctx, 'hello fetch\n');
            const { transport } = fakeRemote({
              url: remoteUrl,
              advertisedRefs: [
                { name: 'HEAD', id: blobId },
                { name: 'refs/heads/main', id: blobId },
              ],
              packBytes,
            });

            // Act
            const result = await fetch({ ...ctx, transport }, opts);

            // Assert
            expect(result.remote).toBe(expectedRemote);
          },
        );
      });
    });

    describe('Given a detached HEAD with branch.main.remote configured and two remotes', () => {
      describe('When fetch is called with no explicit remote', () => {
        it('Then the branch tracking step is skipped and the default remote is used', async () => {
          // Arrange — HEAD detached onto a real commit; branch.main.remote
          // would resolve to "upstream" if the branch step ran, proving here
          // that a detached HEAD skips it in favor of the two-remote default.
          const ctx = createMemoryContext();
          const { commitIds } = await seedRepo(ctx, { commits: [{ tree: '0'.repeat(40) }] });
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${commitIds[0]}\n`);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[remote "origin"]\n  url = https://example.com/origin.git\n[remote "upstream"]\n  url = https://example.com/upstream.git\n[branch "main"]\n  remote = upstream\n',
          );
          __resetConfigCacheForTests();
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'hello fetch\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/origin.git',
            advertisedRefs: [
              { name: 'HEAD', id: blobId },
              { name: 'refs/heads/main', id: blobId },
            ],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          expect(result.remote).toBe('origin');
        });
      });
    });

    describe('Given a configured remote whose name git accepts but the old allowlist did not', () => {
      describe('When fetch is called with that remote', () => {
        it.each([['a/b'], ['a"b'], ['a]b']])(
          'Then the name reaches the transport rather than refusing INVALID_OPTION',
          async (name) => {
            // Arrange
            const ctx = createMemoryContext();
            await seedRepo(ctx, {});
            await ctx.fs.writeUtf8(
              `${ctx.layout.gitDir}/config`,
              `[remote "${name.replace('"', String.raw`\"`)}"]\n  url = https://example.com/r.git\n`,
            );
            __resetConfigCacheForTests();
            const { packBytes, blobId } = await buildOneBlobPack(ctx, 'hello fetch\n');
            const { transport } = fakeRemote({
              url: 'https://example.com/r.git',
              advertisedRefs: [
                { name: 'HEAD', id: blobId },
                { name: 'refs/heads/main', id: blobId },
              ],
              packBytes,
            });

            // Act
            const result = await fetch({ ...ctx, transport }, { remote: name });

            // Assert
            expect(result.remote).toBe(name);
          },
        );
      });
    });

    describe('Given a sole configured remote whose name is a path-traversal string', () => {
      describe('When fetch is called with no explicit remote', () => {
        it('Then it refuses with INVALID_OPTION and never reads a traversal directory', async () => {
          // Arrange — no explicit opts.remote and no branch tracking: the
          // sole-remote inference is what hands the traversal string to
          // resolveRemoteUrl, exactly as an attacker-controlled config would.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[remote "../../evil"]\n  url = https://example.com/evil.git\n',
          );
          __resetConfigCacheForTests();
          const readdirCalls: string[] = [];
          const fs: ReturnType<typeof createMemoryContext>['fs'] = {
            ...ctx.fs,
            readdir: async (path: string) => {
              readdirCalls.push(path);
              return ctx.fs.readdir(path);
            },
          };

          // Act
          let caught: unknown;
          try {
            await fetch({ ...ctx, fs });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            option: string;
            reason: string;
          };
          expect(data.code).toBe('INVALID_OPTION');
          expect(data.option).toBe('remote');
          expect(data.reason).toBe('invalid remote name: ../../evil');
          expect(readdirCalls).toHaveLength(0);
        });
      });
    });
  });

  describe('haves derivation', () => {
    describe('Given remote-tracking refs already on disk', () => {
      describe('When fetch', () => {
        it('Then the upload-pack request body carries `have` lines for those tips', async () => {
          // Arrange — seed an existing remote-tracking ref pointing at a fake
          // commit; fetch should mention it as a `have` line in the request body.
          const ctx = createMemoryContext();
          const oldOid = FAKE_OID('b');
          await seedRepo(ctx, {
            refs: { 'refs/remotes/origin/main': oldOid },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'haves\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act — ignore-missing semantics on walkCommits skip the missing parent
          // object. We're only asserting on the request body shape.
          await fetch({ ...ctx, transport });

          // Assert — second request is the POST to git-upload-pack.
          const postReq = requests.find((r) => r.method === 'POST');
          expect(postReq).toBeDefined();
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).toContain(`have ${oldOid}`);
        });
      });
    });

    describe('Given 257 remote-tracking ref tips', () => {
      describe('When fetch', () => {
        it('Then haves are capped at MAX_HAVES=256 in the request body', async () => {
          // Arrange — seed 257 distinct refs/remotes/origin/* tips. The first 256
          // tips are queued as haves; the 257th is dropped by the cap. Pins the
          // `if (haves.length >= MAX_HAVES) return haves;` early-return mutant.
          const ctx = createMemoryContext();
          const seeds: Record<string, string> = {};
          const seedOid = (i: number): string => i.toString(16).padStart(40, '0');
          for (let i = 0; i < 257; i += 1) {
            seeds[`refs/remotes/origin/b${i}`] = seedOid(i);
          }
          await seedRepo(ctx, { refs: seeds });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'cap\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert — body contains 256 `have ` lines, not 257.
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          const haveCount = (decoded.match(/have [0-9a-f]{40}/g) ?? []).length;
          expect(haveCount).toBe(256);
        });
      });
    });

    describe('Given exactly MAX_HAVES (256) refs', () => {
      describe('When fetch', () => {
        it('Then all 256 haves are sent (boundary)', async () => {
          // Arrange — counterpart to the cap test above. Pins the `>=` vs `>`
          // boundary mutant: exactly-at-cap must send all 256 (the cap fires
          // AFTER the push when length === 256, but `return haves` returns the
          // full 256). A `>` mutant would let a 257th line through but the
          // assertion here also asserts 256 is reached.
          const ctx = createMemoryContext();
          const seeds: Record<string, string> = {};
          const seedOid = (i: number): string => i.toString(16).padStart(40, '0');
          for (let i = 0; i < 256; i += 1) {
            seeds[`refs/remotes/origin/b${i}`] = seedOid(i);
          }
          await seedRepo(ctx, { refs: seeds });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'cap-boundary\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          const haveCount = (decoded.match(/have [0-9a-f]{40}/g) ?? []).length;
          expect(haveCount).toBe(256);
        });
      });
    });

    describe('Given a packed-only remote-tracking ref', () => {
      describe('When fetch', () => {
        it('Then haves include the packed-ref tip', async () => {
          // Arrange — packed-refs deserve haves too (TS reviewer HIGH-1).
          // Without consulting `.git/packed-refs`, repos that ran `git gc` would
          // send zero haves and trigger a full pack on every fetch.
          const ctx = createMemoryContext();
          const packedOid = 'd'.repeat(40);
          await seedRepo(ctx, {});
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${packedOid} refs/remotes/origin/main\n`,
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'packed haves\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).toContain(`have ${packedOid}`);
        });
      });
    });
  });

  describe('prune', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('Given prune=true and a stale remote-tracking ref', () => {
      describe('When fetch', () => {
        it('Then the stale ref is deleted and listed in prunedRefs', async () => {
          // Arrange — stale `feature-x` ref the server no longer advertises.
          const ctx = createMemoryContext();
          const stale = FAKE_OID('c');
          await seedRepo(ctx, {
            refs: {
              'refs/remotes/origin/main': FAKE_OID('a'),
              'refs/remotes/origin/feature-x': stale,
            },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'prune\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { prune: true });

          // Assert — feature-x pruned AND main preserved. The negative assertion
          // on `main` is what kills the prune `.filter().map()` chain mutant:
          // without the chain, `advertised.has('main')` returns false (the Set
          // holds AdvertisedRef objects, not strings) and `main` would also be
          // deleted.
          expect(result.prunedRefs).toContain('refs/remotes/origin/feature-x' as RefName);
          expect(result.prunedRefs).not.toContain('refs/remotes/origin/main' as RefName);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature-x`)).toBe(
            false,
          );
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(true);
        });
      });
    });

    describe('Given prune=true and two stale remote-tracking refs', () => {
      describe('When fetch', () => {
        it('Then both are deleted in one ref transaction', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {
            refs: {
              'refs/remotes/origin/main': FAKE_OID('a'),
              'refs/remotes/origin/feature-x': FAKE_OID('b'),
              'refs/remotes/origin/feature-y': FAKE_OID('c'),
            },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'one prune transaction\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });
          const fetchCtx = { ...ctx, transport };
          const store = getRefStore(fetchCtx);
          const deleteBatches: RefUpdate[][] = [];
          const originalApply = store.applyRefUpdates.bind(store);
          store.applyRefUpdates = async (updates) => {
            if (updates.some((update) => update.kind === 'delete'))
              deleteBatches.push([...updates]);
            return originalApply(updates);
          };

          // Act
          const result = await fetch(fetchCtx, { prune: true });

          // Assert
          expect(result.prunedRefs).toEqual([
            'refs/remotes/origin/feature-x',
            'refs/remotes/origin/feature-y',
          ]);
          expect(deleteBatches).toEqual([
            [
              { kind: 'delete', name: 'refs/remotes/origin/feature-x' },
              { kind: 'delete', name: 'refs/remotes/origin/feature-y' },
            ],
          ]);
        });
      });
    });

    describe('Given prune=false', () => {
      describe('When fetch', () => {
        it('Then stale remote-tracking refs are preserved', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {
            refs: {
              'refs/remotes/origin/main': FAKE_OID('a'),
              'refs/remotes/origin/feature-x': FAKE_OID('c'),
            },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'no prune\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          expect(result.prunedRefs).toEqual([]);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature-x`)).toBe(
            true,
          );
        });
      });
    });

    describe('Given prune=true with stale refs', () => {
      describe('When fetch', () => {
        it('Then local branches and local tags are NEVER deleted', async () => {
          // Arrange — local refs that are NOT under refs/remotes/origin/.
          const ctx = createMemoryContext();
          const localHead = FAKE_OID('d');
          await seedRepo(ctx, {
            refs: {
              'refs/heads/main': localHead,
              'refs/tags/v0': localHead,
              'refs/remotes/origin/feature-x': FAKE_OID('c'),
            },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'safe locals\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport }, { prune: true });

          // Assert — local refs untouched by prune.
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(true);
          expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim()).toBe(
            localHead,
          );
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/tags/v0`)).toBe(true);
        });
      });
    });

    describe('Given prune=true and a symbolic tracking ref (origin/HEAD)', () => {
      describe('When fetch', () => {
        it('Then the symref and its target are kept — the stale scan skips symrefs', async () => {
          // Arrange — `origin/HEAD` is a symref onto `origin/main`, which the
          // server still advertises. The scan must never treat a symref's own
          // name ("HEAD") as a branch slug to test against the advertisement.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {
            refs: { 'refs/remotes/origin/main': FAKE_OID('a') },
          });
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/HEAD`,
            'ref: refs/remotes/origin/main\n',
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'keep symref\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { prune: true });

          // Assert
          expect(result.prunedRefs).toEqual([]);
          expect(
            (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/HEAD`)).trim(),
          ).toBe('ref: refs/remotes/origin/main');
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(true);
        });
      });
    });

    describe('Given prune=true and HEAD symbolically naming a stale remote-tracking ref', () => {
      describe('When fetch', () => {
        it('Then the pruned ref\'s coupled HEAD entry carries git\'s "fetch: prune" message', async () => {
          // Arrange
          vi.spyOn(Date, 'now').mockReturnValue(PRUNE_EPOCH_SECONDS * 1000);
          const ctx = createMemoryContext();
          const staleId = FAKE_OID('b');
          await seedRepo(ctx, {
            refs: {
              'refs/remotes/origin/main': FAKE_OID('a'),
              'refs/remotes/origin/dev': staleId,
            },
            head: 'refs/remotes/origin/dev',
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'coupled prune\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport }, { prune: true });

          // Assert
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(
            `${staleId} ${'0'.repeat(40)} tsgit <tsgit@localhost> ${PRUNE_EPOCH_SECONDS} +0000\tfetch: prune\n`,
          );
        });
      });
    });

    describe('Given prune=true and origin/HEAD naming a branch the server no longer advertises', () => {
      describe('When fetch', () => {
        it('Then only the stale branch is pruned and origin/HEAD is left dangling on it', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {
            refs: {
              'refs/remotes/origin/main': FAKE_OID('a'),
              'refs/remotes/origin/dev': FAKE_OID('b'),
            },
          });
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/HEAD`,
            'ref: refs/remotes/origin/dev\n',
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'dangling symref\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { prune: true });

          // Assert
          expect(result.prunedRefs).toEqual(['refs/remotes/origin/dev']);
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/HEAD`)).toBe(
            'ref: refs/remotes/origin/dev\n',
          );
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/dev`)).toBe(false);
        });
      });
    });
  });

  describe('advertisement filtering (mutation kills for remoteTargetForRef)', () => {
    describe('Given a HEAD ref in the advertisement', () => {
      describe('When fetch', () => {
        it('Then HEAD does NOT appear in updatedRefs', async () => {
          // Arrange — kills the `if (ref.name === 'HEAD') return undefined` mutant.
          // Without that guard, HEAD would be propagated as a local ref.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'head\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [
              { name: 'HEAD', id: blobId },
              { name: 'refs/heads/main', id: blobId },
            ],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert
          expect(result.updatedRefs.map((r) => r.name)).not.toContain('HEAD');
          expect(result.updatedRefs.map((r) => r.name)).toContain('refs/remotes/origin/main');
        });
      });
    });

    describe('Given a refs/notes/* advertisement (neither head nor tag)', () => {
      describe('When fetch', () => {
        it('Then it is dropped', async () => {
          // Arrange — kills the `if (ref.name.startsWith('refs/tags/'))` mutant
          // that turns the tag-suffix check into always-true: refs/notes would
          // otherwise be mirrored as a local ref.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'notes\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [
              { name: 'refs/heads/main', id: blobId },
              { name: 'refs/notes/commits', id: blobId },
            ],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert — only the branch ref is written; refs/notes/commits is
          // skipped (neither a branch nor a tag).
          expect(result.updatedRefs.map((r) => r.name)).toEqual(['refs/remotes/origin/main']);
        });
      });
    });
  });

  describe('shallow file write triggers (mutation kills for the OR clause)', () => {
    describe('Given a server returning unshallow ONLY', () => {
      describe('When fetch', () => {
        it('Then .git/shallow is written', async () => {
          // Arrange — kills the `unshallow.length > 0 ? false :...` mutant.
          // The `unshallow > 0` half of the OR must independently trigger
          // updateShallow.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/shallow`,
            `${'a'.repeat(40)}\n${'b'.repeat(40)}\n`,
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'unshallow-only\n');
          const unshallowOid = 'a'.repeat(40);
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
            unshallow: [unshallowOid],
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { depth: 5 });

          // Assert — `unshallow` was processed; the shallow file no longer
          // contains the unshallowed oid.
          expect(result.unshallow).toEqual([unshallowOid]);
          const remaining = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`)).trim();
          expect(remaining).toBe('b'.repeat(40));
        });
      });
    });

    describe('Given pre-existing.git/shallow and a fetch with NO shallow/unshallow lines', () => {
      describe('When fetch', () => {
        it('Then .git/shallow is preserved (no spurious rewrite)', async () => {
          // Arrange — kills the `shallow.length > 0 || unshallow.length > 0` →
          // always-true mutant. With always-true, updateShallow would re-process
          // (re-read + re-write) the file even when the server said nothing.
          // We assert that the file's content is preserved verbatim — any
          // mutant that triggers a re-write would still produce the same content
          // here (Set semantics), so we ALSO assert.git/shallow.lock is NOT
          // created (a mutant rewrite would create + rename the lockfile).
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const initial = `${'a'.repeat(40)}\n${'b'.repeat(40)}\n`;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, initial);
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'no-shallow\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert — server said nothing about shallow → no write.
          expect(result.shallow).toEqual([]);
          expect(result.unshallow).toEqual([]);
          // File preserved.
          const after = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
          expect(after).toBe(initial);
        });
      });
    });
  });

  describe('haves derivation guards (mutation kills for collectRefTips)', () => {
    describe('Given no remote-tracking refs and no packed refs', () => {
      describe('When fetch', () => {
        it('Then walkCommits is NOT invoked and request body has no haves', async () => {
          // Arrange — kills the `if (seeds.length === 0) return []` early
          // return mutant. With the mutant, walkCommits would be called with
          // `from: []` and throw INVALID_WALK_INPUT, crashing the fetch.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'empty seeds\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act — wrap in try/catch so the assertion below can pin the no-throw
          // contract (any thrown error from a deriveHaves mutant would otherwise
          // bubble out of the test and be reported as a failure — but Stryker
          // marks a thrown fetch as a kill regardless, so we ALSO check the
          // request body shape to pin the haves-derivation logic itself).
          let caught: unknown;
          let result: Awaited<ReturnType<typeof fetch>> | undefined;
          try {
            result = await fetch({ ...ctx, transport });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeUndefined();
          expect(result?.remote).toBe('origin');
          const postReq = requests.find((r) => r.method === 'POST');
          expect(postReq).toBeDefined();
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).not.toContain('have ');
        });
      });
    });

    describe('Given a packed refs/tags/<tag> entry', () => {
      describe('When fetch', () => {
        it('Then its oid IS sent as a have (kills the startsWith → endsWith mutant)', async () => {
          // Arrange — kills the `entry.name.endsWith(tagPrefix)` mutant.
          // `refs/tags/v1` starts with `refs/tags/` but does NOT end with it.
          // Original code correctly picks up the tag oid; the mutant misses it.
          const ctx = createMemoryContext();
          const packedTagOid = 'e'.repeat(40);
          await seedRepo(ctx, {});
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${packedTagOid} refs/tags/v1\n`,
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'packed-tag\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).toContain(`have ${packedTagOid}`);
        });
      });
    });

    describe('Given duplicate ref tips pointing at the same oid', () => {
      describe('When fetch', () => {
        it('Then the oid appears once in the request body (kills the seen-set dedup)', async () => {
          // Arrange — kills the `if (seen.has(tip)) continue` dedup mutant
          // inside `deriveHaves`. Two ref files pointing at the same oid must
          // produce one have line, not two.
          const ctx = createMemoryContext();
          const sharedOid = '8'.repeat(40);
          await seedRepo(ctx, {
            refs: {
              'refs/remotes/origin/branch-a': sharedOid,
              'refs/remotes/origin/branch-b': sharedOid,
            },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'dedup\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert — exactly one `have <sharedOid>` line in the request.
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          const matches = decoded.match(new RegExp(`have ${sharedOid}`, 'g')) ?? [];
          expect(matches).toHaveLength(1);
        });
      });
    });

    describe('Given a packed ref outside refs/remotes/<remote>/* and refs/tags/*', () => {
      describe('When fetch', () => {
        it('Then its oid is sent as a have, as git seeds haves from every ref', async () => {
          // Arrange — kills the `entry.name.startsWith(refPrefix) || entry.name.startsWith(tagPrefix)`
          // → always-true mutant. With always-true, a packed `refs/internal/x`
          // would be treated as a remote-tracking tip and emitted as a have.
          const ctx = createMemoryContext();
          const internalOid = 'f'.repeat(40);
          await seedRepo(ctx, {});
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${internalOid} refs/internal/x\n`,
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'scope\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).toContain(`have ${internalOid}`);
        });
      });
    });

    describe('Given a nested refs/remotes/origin/feature/x ref', () => {
      describe('When fetch', () => {
        it('Then its oid is included as a have (recursive directory walk)', async () => {
          // Arrange — kills two mutants:
          //  (a) `if (entry.isDirectory)` → false: the nested directory
          //  wouldn't be recursed into.
          //  (b) the prefix-composition strip mutants — the nested ref needs
          //  both the directory recursion AND the path concatenation to
          //  surface.
          const ctx = createMemoryContext();
          const nestedOid = 'c'.repeat(40);
          await seedRepo(ctx, {
            refs: { 'refs/remotes/origin/feature/x': nestedOid },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'nested\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).toContain(`have ${nestedOid}`);
        });
      });
    });

    describe('Given a non-oid file under refs/remotes/origin/', () => {
      describe('When fetch', () => {
        it('Then it is NOT sent as a have', async () => {
          // Arrange — kills the `if (isOid(content)) out.push(content)` →
          // always-push mutant. With the mutant, any file content (including
          // garbage like `garbage\n`) would be sent as a have.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/refs/remotes/origin`);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/garbage-ref`,
            'not-an-oid-at-all\n',
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'non-oid\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).not.toContain('have not-an-oid');
        });
      });
    });
  });

  describe('prune mutation kills', () => {
    describe('Given prune=true and an advertisement with only tag refs (no heads)', () => {
      describe('When fetch', () => {
        it('Then prune does NOT throw on a missing refs/remotes/<remote>/ dir', async () => {
          // Arrange — kills the `if (!(await fs.exists(remoteDir))) return []`
          // early-return mutant. applyRemoteRefs only writes refs/tags/* (no
          // refs/remotes/origin/ dir is created), so when prune fires the
          // remoteDir really doesn't exist. With the mutant, readdir on a
          // missing dir throws and the fetch call rejects.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'tags only\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/tags/v1', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { prune: true });

          // Assert — succeeds; prunedRefs is empty.
          expect(result.prunedRefs).toEqual([]);
          // remoteDir should NOT have been created (no head refs advertised).
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin`)).toBe(false);
        });
      });
    });

    describe('Given prune=true and a nested refs/remotes/origin/feature/x that is NOT advertised', () => {
      describe('When fetch', () => {
        it('Then the nested ref is deleted with its prefix preserved', async () => {
          // Arrange — kills the `prefix === '' ? entry.name : ${prefix}/${entry.name}`
          // → always-true (always entry.name) mutant. With always-true, the
          // recursive walk would lose the `feature/` prefix and assemble a
          // wrong refName for deletion.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {
            refs: { 'refs/remotes/origin/feature/x': FAKE_OID('c') },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'nested prune\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { prune: true });

          // Assert
          expect(result.prunedRefs).toContain('refs/remotes/origin/feature/x' as RefName);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature/x`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given a tag whose slice(11) matches a local remote-tracking ref', () => {
      describe('When prune=true fetch runs', () => {
        it('Then the local ref IS pruned (kills the.filter drop mutant)', async () => {
          // Arrange — kills the L312 MethodExpression mutant that drops the
          // `.filter((r) => r.name.startsWith('refs/heads/'))` call but keeps
          // the `.map((r) => r.name.slice('refs/heads/'.length))`. Without the
          // filter, advertisedBranches contains BOTH heads/main → 'main' AND
          // tags/preserved → 'reserved' (sliced at index 11). A local ref named
          // 'reserved' would then be incorrectly considered advertised and
          // skipped from prune — observable only when such a name collision
          // exists in the local fixture.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {
            refs: { 'refs/remotes/origin/reserved': FAKE_OID('7') },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'tag-slice\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [
              { name: 'refs/heads/main', id: blobId },
              { name: 'refs/tags/preserved', id: blobId },
            ],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { prune: true });

          // Assert — the local `reserved` ref IS pruned (not advertised). With
          // the mutant, advertisedBranches would include 'reserved' and the
          // ref would be preserved.
          expect(result.prunedRefs).toContain('refs/remotes/origin/reserved' as RefName);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/reserved`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given prune=true and a tag advertisement', () => {
      describe('When fetch', () => {
        it('Then prune builds the branch set from heads only (kills the.filter mutant)', async () => {
          // Arrange — pins the `advertisement.refs.filter(...).map(...)` chain.
          // With the filter dropped, advertisedBranches would include AdvertisedRef
          // objects (not strings), advertised.has(branch) would never match, and
          // EVERY remote-tracking ref would get pruned — including the one the
          // server still advertises.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {
            refs: { 'refs/remotes/origin/main': FAKE_OID('a') },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'mapped\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [
              { name: 'refs/heads/main', id: blobId },
              { name: 'refs/tags/v1', id: blobId },
            ],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { prune: true });

          // Assert — main is preserved (it IS advertised); no spurious deletes.
          expect(result.prunedRefs).toEqual([]);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(true);
        });
      });
    });
  });

  describe('hostile server defenses', () => {
    describe('Given a server advertising refs/heads/../../config (path traversal)', () => {
      describe('When fetch', () => {
        it("Then the malicious ref is dropped with git's funny-ref error", async () => {
          // Arrange — the mapped `refs/remotes/origin/../../config` would point
          // at `.git/config`; git's name check drops it before any read.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'safe\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [
              { name: 'refs/heads/main', id: blobId },
              { name: 'refs/heads/../../config', id: blobId },
            ],
            packBytes,
          });

          const errors: string[] = [];
          const logger = { error: (message: string) => errors.push(message) };

          // Act
          const result = await fetch({ ...ctx, transport, logger });

          // Assert — only the safe ref made it through.
          expect(result.updatedRefs.map((r) => r.name)).toEqual(['refs/remotes/origin/main']);
          expect(errors).toEqual([
            "* Ignoring funny ref 'refs/remotes/origin/../../config' locally",
          ]);
        });
      });
    });
  });

  describe('shallow fetch', () => {
    describe('Given depth=1 and a server emitting shallow <oid>', () => {
      describe('When fetch', () => {
        it('Then .git/shallow is written with that oid and result.shallow contains it', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'shallow\n');
          const shallowOid = 'a'.repeat(40);
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
            shallow: [shallowOid],
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { depth: 1 });

          // Assert
          expect(result.shallow).toEqual([shallowOid]);
          const onDisk = await readShallow({ ...ctx, transport });
          expect(onDisk.has(shallowOid as ObjectId)).toBe(true);
        });
      });
    });

    describe('Given depth=1 and the server ignores deepen', () => {
      describe('When fetch', () => {
        it('Then .git/shallow is NOT created', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'no shallow\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { depth: 1 });

          // Assert
          expect(result.shallow).toEqual([]);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
        });
      });
    });

    describe('Given depth set and an unshallow response', () => {
      describe('When fetch', () => {
        it('Then result.unshallow holds the oid', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'unshallow\n');
          const unshallowOid = 'b'.repeat(40);
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
            unshallow: [unshallowOid],
          });

          // Act
          const result = await fetch({ ...ctx, transport }, { depth: 3 });

          // Assert
          expect(result.unshallow).toEqual([unshallowOid]);
        });
      });
    });
  });

  describe('local-refs safety', () => {
    describe('Given local refs/heads/* + refs/tags/*', () => {
      describe('When fetch runs', () => {
        it('Then both are left untouched', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const localOid = FAKE_OID('e');
          await seedRepo(ctx, {
            refs: {
              'refs/heads/main': localOid,
              'refs/tags/v0': localOid,
            },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'safety\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim()).toBe(
            localOid,
          );
          expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/tags/v0`)).trim()).toBe(
            localOid,
          );
        });
      });
    });

    describe('Given a local refs/heads/main oid', () => {
      describe('When fetch derives haves', () => {
        it('Then that oid is sent as a have, as git seeds haves from every ref', async () => {
          // Arrange — kills the `'refs/tags'` → `""` StringLiteral mutant in
          // `looseDirs`. With `""`, `collectFromDir` would walk the entire
          // gitDir tree and surface `refs/heads/main` content (which IS an oid)
          // as a have. The deriveHaves contract is "only remote-tracking refs
          // and tags become haves" — local heads must stay out.
          const ctx = createMemoryContext();
          const localHeadOid = '4'.repeat(40);
          await seedRepo(ctx, {
            refs: { 'refs/heads/main': localHeadOid },
          });
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'no local haves\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).toContain(`have ${localHeadOid}`);
        });
      });
    });
  });

  describe('progress reporting', () => {
    describe('Given a successful fetch', () => {
      describe('When run', () => {
        it('Then a fetch:negotiate start/end pair fires', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'progress\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });
          const { reporter, events } = recordingProgress();

          // Act
          await fetch(withProgress({ ...ctx, transport }, reporter));

          // Assert
          const negotiate = events.filter((e) => e.op === 'fetch:negotiate');
          expect(negotiate.some((e) => e.kind === 'start')).toBe(true);
          expect(negotiate.some((e) => e.kind === 'end')).toBe(true);
        });
        it('Then a fetch:write-objects start/end pair fires', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'write-objects\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });
          const { reporter, events } = recordingProgress();

          // Act
          await fetch(withProgress({ ...ctx, transport }, reporter));

          // Assert
          const writeObjects = events.filter((e) => e.op === 'fetch:write-objects');
          expect(writeObjects.some((e) => e.kind === 'start')).toBe(true);
          expect(writeObjects.some((e) => e.kind === 'end')).toBe(true);
        });
      });
    });

    describe('Given a failing fetch (no remote)', () => {
      describe('When run', () => {
        it('Then end still fires after start', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const { reporter, events } = recordingProgress();

          // Act
          try {
            await fetch(withProgress(ctx, reporter));
          } catch {
            // expected
          }

          // Assert
          const startCount = events.filter((e) => e.kind === 'start').length;
          const endCount = events.filter((e) => e.kind === 'end').length;
          expect(endCount).toBe(startCount);
        });
      });
    });
  });

  describe('auth plumbing', () => {
    describe('Given ctx.config.auth is set', () => {
      describe('When fetch', () => {
        it('Then every request carries the Authorization header', async () => {
          // Arrange — kills the L78 `{}` ObjectLiteral mutant: with `{}`,
          // withDefaults never wraps the transport with withAuth, so no request
          // would carry an Authorization header.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'auth\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport, config: { auth: { type: 'bearer', token: 'sekret' } } });

          // Assert — both the info/refs GET and the upload-pack POST are authed.
          expect(requests.length).toBeGreaterThan(0);
          for (const req of requests) {
            expect(req.headers?.authorization).toBe('Bearer sekret');
          }
        });
      });
    });

    describe('Given ctx.config has no auth', () => {
      describe('When fetch', () => {
        it('Then requests carry no Authorization header', async () => {
          // Arrange — counterpart pinning the `auth !== undefined` ternary's
          // false branch: without auth the transport stays unwrapped.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'no auth\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert
          for (const req of requests) {
            expect(req.headers?.authorization).toBeUndefined();
          }
        });
      });
    });
  });

  describe('shallow file write triggers (kills the OR-clause true mutants)', () => {
    describe('Given an unsorted pre-existing.git/shallow and a fetch with NO shallow lines', () => {
      describe('When fetch', () => {
        it('Then the file is left byte-for-byte unsorted', async () => {
          // Arrange — kills L107 `ConditionalExpression -> true` and both
          // `EqualityOperator -> >= 0` mutants. Forcing the guard true would call
          // updateShallow, which re-reads and re-SORTS the file. The fixture's
          // content is deliberately NOT sorted, so a spurious rewrite is
          // observable: `bbb...` would move after `aaa...`.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const unsorted = `${'b'.repeat(40)}\n${'a'.repeat(40)}\n`;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, unsorted);
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'unsorted shallow\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert — server said nothing about shallow → updateShallow is NOT
          // called → the unsorted file is preserved verbatim.
          expect(result.shallow).toEqual([]);
          expect(result.unshallow).toEqual([]);
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`)).toBe(unsorted);
        });
      });
    });
  });

  describe('haves derivation walks the commit graph', () => {
    describe('Given a remote-tracking ref at a commit with a parent', () => {
      describe('When fetch', () => {
        it('Then the parent oid is sent as a have (walkCommits loop body)', async () => {
          // Arrange — kills the L175-L179 walk-loop NoCoverage mutants. The seed
          // tip (child commit) is already in `seen`; walkCommits yields its
          // parent, which is NOT yet seen and so must be pushed into haves.
          const ctx = createMemoryContext();
          const tree = '1'.repeat(40);
          const { commitIds: parentSeed } = await seedRepo(ctx, {
            commits: [{ tree, message: 'parent' }],
          });
          const parentId = parentSeed[0] as string;
          const { commitIds: childIds } = await seedRepo(ctx, {
            commits: [{ tree, parents: [parentId], message: 'child' }],
          });
          const childId = childIds[0] as string;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${childId}\n`);
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'graph haves\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/feature', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert — the walked parent is a have (kills L176 `-> true` and the
          // L175 block-empty mutant: without the loop body the parent is never
          // pushed). The seed tip appears exactly once: L176 `-> false` (drop the
          // `seen` skip) would re-push the already-queued tip a second time.
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          expect(decoded).toContain(`have ${parentId}`);
          expect(decoded.match(new RegExp(`have ${childId}`, 'g')) ?? []).toHaveLength(1);
        });
      });
    });

    describe('Given a single tip whose ancestry exceeds MAX_HAVES', () => {
      describe('When fetch', () => {
        it('Then the walk loop caps haves at 256', async () => {
          // Arrange — kills the L179 `if (haves.length >= MAX_HAVES) break`
          // mutants inside the walk loop. A 300-deep commit chain reachable from
          // one seed tip forces the walk to push past the cap; the break must
          // stop it at exactly 256. `>= -> >` would let a 257th through,
          // `-> true` would break after the first walked commit, `-> false`
          // would emit all 300.
          const ctx = createMemoryContext();
          const tree = '2'.repeat(40);
          let parentChain: string[] = [];
          for (let i = 0; i < 300; i += 1) {
            const parents =
              parentChain.length > 0 ? [parentChain[parentChain.length - 1] as string] : [];
            const { commitIds } = await seedRepo(ctx, {
              commits: [{ tree, parents, message: `c${i}` }],
            });
            parentChain = [...parentChain, commitIds[0] as string];
          }
          const tipId = parentChain[parentChain.length - 1] as string;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/deep`, `${tipId}\n`);
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'deep chain\n');
          const { transport, requests } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          await fetch({ ...ctx, transport });

          // Assert — exactly 256 have lines, not 257 and not 300.
          const postReq = requests.find((r) => r.method === 'POST');
          const decoded = new TextDecoder().decode(postReq?.body);
          const haveCount = (decoded.match(/have [0-9a-f]{40}/g) ?? []).length;
          expect(haveCount).toBe(256);
        });
      });
    });
  });

  describe('advertised ref already at the local oid', () => {
    describe('Given a remote-tracking ref already at the advertised oid', () => {
      describe('When fetch', () => {
        it('Then updatedRefs surfaces it with oldId === newId and updateRef is never invoked', async () => {
          // Arrange — kills the `if (oldId === ref.id)` BlockStatement mutant.
          // With `{}`, the no-op branch loses its `continue`, so execution falls
          // through to `updateRef`, which atomic-writes a `<ref>.lock` file. The
          // happy no-op path performs NO write to that ref at all.
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'already-at\n');
          await seedRepo(ctx, { refs: { 'refs/remotes/origin/main': blobId } });
          await writeOriginConfig(ctx);
          const refLockWrites: string[] = [];
          const fsRecordingWrites: typeof ctx.fs = {
            ...ctx.fs,
            writeExclusive: async (path: string, data: Uint8Array) => {
              if (path.includes('refs/remotes/origin/main')) refLockWrites.push(path);
              return ctx.fs.writeExclusive(path, data);
            },
          };
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport, fs: fsRecordingWrites });

          // Assert — exactly one entry, oldId === newId, and no ref rewrite.
          const entries = result.updatedRefs.filter((r) => r.name === 'refs/remotes/origin/main');
          expect(entries).toHaveLength(1);
          expect(entries[0]?.oldId).toBe(blobId);
          expect(entries[0]?.newId).toBe(blobId);
          expect(refLockWrites).toEqual([]);
        });
      });
    });

    describe('Given a PACKED-ONLY remote-tracking ref already at the advertised oid', () => {
      describe('When fetch', () => {
        it('Then readExistingRef sees it as existing (oldId === newId), not rewritten as new', async () => {
          // Arrange — a remote-tracking ref that survived a `git gc` (packed,
          // no loose file) must be read by `readExistingRef` the same as a
          // loose one; without consulting packed storage it would look absent
          // and be rewritten as brand new (oldId undefined).
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'packed already-at\n');
          await seedRepo(ctx, {});
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${blobId} refs/remotes/origin/main\n`,
          );
          await writeOriginConfig(ctx);
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert — exactly one entry, oldId === newId (seen as existing).
          const entries = result.updatedRefs.filter((r) => r.name === 'refs/remotes/origin/main');
          expect(entries).toHaveLength(1);
          expect(entries[0]?.oldId).toBe(blobId);
          expect(entries[0]?.newId).toBe(blobId);
        });
      });
    });
  });

  describe('hostile tag ref defenses', () => {
    describe('Given a server advertising an unsafe tag name refs/tags/v..1', () => {
      describe('When fetch', () => {
        it('Then the malicious tag is dropped', async () => {
          // Arrange — kills the L261 `if (!isSafeRefName(ref.name))` mutant.
          // The tag-suffix branch returns `ref.name` directly without the L271
          // re-check, so only the L261 guard stands between an unsafe tag name
          // and updateRef. validateRefName rejects `..`.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'hostile tag\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [
              { name: 'refs/heads/main', id: blobId },
              { name: 'refs/tags/v..1', id: blobId },
            ],
            packBytes,
          });

          // Act
          const result = await fetch({ ...ctx, transport });

          // Assert — only the safe branch ref made it through.
          expect(result.updatedRefs.map((r) => r.name)).toEqual(['refs/remotes/origin/main']);
        });
      });
    });
  });

  describe('prune packed-only ref handling', () => {
    describe('Given a prune walk reaching a packed-only ref', () => {
      describe('When fetch', () => {
        it('Then the packed-only ref is pruned and its packed-refs line removed, no warn logged', async () => {
          // Arrange — `ghost` exists ONLY in packed-refs (no loose file);
          // `listRefs` surfaces it as a prune candidate, and `updateRef`'s
          // delete path now rewrites packed-refs to drop it instead of
          // refusing.
          const ctx = createMemoryContext();
          await seedRepo(ctx, { refs: { 'refs/remotes/origin/main': FAKE_OID('a') } });
          const packedOnly = 'c'.repeat(40);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${packedOnly} refs/remotes/origin/ghost\n`,
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'packed prune\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });
          const warnings: Array<{
            message: string;
            context: Readonly<Record<string, unknown>> | undefined;
          }> = [];
          const logger = {
            warn: (message: string, context?: Readonly<Record<string, unknown>>): void => {
              warnings.push({ message, context });
            },
          };

          // Act
          const result = await fetch({ ...ctx, transport, logger }, { prune: true });

          // Assert — packed-only ref pruned, listed, and no warn logged.
          expect(result.prunedRefs).toEqual(['refs/remotes/origin/ghost']);
          expect(warnings).toEqual([]);
          const packedContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/packed-refs`);
          expect(packedContent).not.toContain('refs/remotes/origin/ghost');
        });
      });
    });
  });

  describe('prune refuses a dangerous packed-refs entry', () => {
    describe('Given packed-refs carries a dangerous name under refs/remotes/<remote>/', () => {
      describe('When fetch prunes', () => {
        it('Then it refuses (throws INVALID_PACKED_REFS) rather than deleting or traversing', async () => {
          // Arrange — re-pins the adversarial property covered, pre-listRefs,
          // by a phantom-readdir-entry test at the prune walk itself: a
          // dangerous name reachable under refs/remotes/<remote>/ must never
          // reach a delete. Now that enumeration is backed by packed-refs
          // parsing, the seam moved to read time — `listRefs` (called from
          // `prune`) loads packed-refs via `parsePackedRefs`, which refuses
          // the whole read the way git does, so the dangerous entry never
          // becomes a prune candidate in the first place.
          const ctx = createMemoryContext();
          await seedRepo(ctx, { refs: { 'refs/remotes/origin/main': FAKE_OID('a') } });
          const dangerous = 'refs/remotes/origin/../../../../tmp/pwned';
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${'c'.repeat(40)} ${dangerous}\n`,
          );
          await writeOriginConfig(ctx);
          const { packBytes, blobId } = await buildOneBlobPack(ctx, 'dangerous packed prune\n');
          const { transport } = fakeRemote({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
            packBytes,
          });

          // Act
          let caught: unknown;
          try {
            await fetch({ ...ctx, transport }, { prune: true });
          } catch (err) {
            caught = err;
          }

          // Assert — refused at read time, not silently skipped or traversed.
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
          expect(((caught as TsgitError).data as { reason: string }).reason).toContain(dangerous);
        });
      });
    });
  });
});

describe('fetch — partial clone', () => {
  const seedPartialRepo = async (
    ctx: ReturnType<typeof createMemoryContext>,
    configBody: string,
  ): Promise<void> => {
    await seedRepo(ctx, { head: 'refs/heads/main' });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, configBody);
  };

  describe('Given a repo with a stored partial-clone filter', () => {
    describe('When fetch', () => {
      it('Then the request carries the filter and a promisor pack is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedPartialRepo(
          ctx,
          '[remote "origin"]\n  url = https://example.com/r.git\n  partialclonefilter = blob:none\n',
        );
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'partial fetch\n');
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'HEAD', id: blobId },
            { name: 'refs/heads/main', id: blobId },
          ],
          advertisedCaps: ['side-band-64k', 'ofs-delta', 'filter'],
          packBytes,
        });

        // Act
        await fetch({ ...ctx, transport });

        // Assert — the upload-pack POST carries the filter line.
        const post = requests.find((r) => r.method === 'POST');
        expect(new TextDecoder().decode(post?.body)).toContain('filter blob:none\n');
        const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
        expect(packDir.some((e) => e.name.endsWith('.promisor'))).toBe(true);
      });
    });
  });

  describe('Given a non-partial repo', () => {
    describe('When fetch', () => {
      it('Then no filter line is sent and no promisor pack is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedPartialRepo(ctx, '[remote "origin"]\n  url = https://example.com/r.git\n');
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'plain fetch\n');
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'HEAD', id: blobId },
            { name: 'refs/heads/main', id: blobId },
          ],
          packBytes,
        });

        // Act
        await fetch({ ...ctx, transport });

        // Assert
        const post = requests.find((r) => r.method === 'POST');
        expect(new TextDecoder().decode(post?.body)).not.toContain('filter ');
        const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
        expect(packDir.some((e) => e.name.endsWith('.promisor'))).toBe(false);
      });
    });
  });

  describe('Given a corrupt stored filter', () => {
    describe('When fetch', () => {
      it('Then throws INVALID_FILTER_SPEC', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedPartialRepo(
          ctx,
          '[remote "origin"]\n  url = https://example.com/r.git\n  partialclonefilter = bogus\n',
        );

        // Act
        let caught: unknown;
        try {
          await fetch(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_FILTER_SPEC');
        if (data.code !== 'INVALID_FILTER_SPEC') throw new Error('unreachable');
        expect(data.spec).toBe('bogus');
        expect(data.reason).toBe('unknown-kind');
      });
    });
  });

  describe('Given a partial repo and a server that dropped filter support', () => {
    describe('When fetch', () => {
      it('Then throws REMOTE_FILTER_UNSUPPORTED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedPartialRepo(
          ctx,
          '[remote "origin"]\n  url = https://example.com/r.git\n  partialclonefilter = blob:none\n',
        );
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'dropped\n');
        const { transport } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          advertisedCaps: ['side-band-64k', 'ofs-delta'],
          packBytes,
        });

        // Act
        let caught: unknown;
        try {
          await fetch({ ...ctx, transport });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REMOTE_FILTER_UNSUPPORTED');
      });
    });
  });

  describe('Given a partial repo and a v2-capable server whose fetch command advertises filter', () => {
    describe('When fetch', () => {
      it('Then the v2 fetch request carries the filter and a promisor pack is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedPartialRepo(
          ctx,
          '[remote "origin"]\n  url = https://example.com/r.git\n  partialclonefilter = blob:none\n',
        );
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'v2 partial fetch\n');
        const { transport, requests } = fakeRemoteV2({
          advertisedRefs: [
            { name: 'HEAD', id: blobId },
            { name: 'refs/heads/main', id: blobId },
          ],
          packBytes,
          filter: true,
        });

        // Act
        await fetch({ ...ctx, transport });

        // Assert — the v2 fetch command request carries the filter arg.
        const fetchRequest = requests.find(
          (r) => r.body !== undefined && DECODER.decode(r.body).includes('command=fetch'),
        );
        expect(fetchRequest).toBeDefined();
        expect(DECODER.decode(fetchRequest?.body)).toContain('filter blob:none');
        const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
        expect(packDir.some((e) => e.name.endsWith('.promisor'))).toBe(true);
      });
    });
  });

  describe('Given a partial repo and a v2-capable server whose fetch command does not advertise filter', () => {
    describe('When fetch', () => {
      it('Then throws REMOTE_FILTER_UNSUPPORTED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedPartialRepo(
          ctx,
          '[remote "origin"]\n  url = https://example.com/r.git\n  partialclonefilter = blob:none\n',
        );
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'v2 dropped\n');
        const { transport } = fakeRemoteV2({
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          packBytes,
        });

        // Act
        let caught: unknown;
        try {
          await fetch({ ...ctx, transport });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REMOTE_FILTER_UNSUPPORTED');
      });
    });
  });

  describe('Given a remote with an empty url', () => {
    describe('When fetch', () => {
      it('Then throws REMOTE_NOT_CONFIGURED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedPartialRepo(ctx, '[remote "origin"]\n  url =\n');

        // Act
        let caught: unknown;
        try {
          await fetch(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — an empty url is as unusable as a missing one.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
      });
    });
  });
});

describe('fetch — everything local', () => {
  describe('Given every wanted oid is already present locally and no filter is set', () => {
    describe('When fetch', () => {
      it('Then no upload-pack POST is issued and the remote-tracking ref still advances', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { head: 'refs/heads/main' });
        await writeOriginConfig(ctx);
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'already local\n');
        await writeSyntheticPack(ctx, 'seed', [
          { kind: 'base', type: 'blob', content: ENCODER.encode('already local\n') },
        ]);
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          packBytes,
        });

        // Act
        const result = await fetch({ ...ctx, transport });

        // Assert
        expect(requests.some((r) => r.method === 'POST')).toBe(false);
        const update = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
        expect(update?.newId).toBe(blobId);
      });
    });
  });

  describe('Given the pack registry already scanned before the wanted oid was packed', () => {
    describe('When fetch runs', () => {
      it('Then the everything-local probe rechecks and still skips the upload-pack POST', async () => {
        // Arrange — force an early registry scan against an EMPTY pack
        // directory, THEN write the pack the fetch will want. A quick
        // probe would still answer "absent" from that stale scan; the
        // everything-local check must recheck (git's own
        // `HAS_OBJECT_RECHECK_PACKED`), never phone home for an object a
        // concurrent writer already packed.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { head: 'refs/heads/main' });
        await writeOriginConfig(ctx);
        const registry = await getPackRegistry(ctx);
        await registry.all();
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'scanned-then-packed\n');
        await writeSyntheticPack(ctx, 'seed', [
          { kind: 'base', type: 'blob', content: ENCODER.encode('scanned-then-packed\n') },
        ]);
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          packBytes,
        });

        // Act
        const result = await fetch({ ...ctx, transport });

        // Assert
        expect(requests.some((r) => r.method === 'POST')).toBe(false);
        const update = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
        expect(update?.newId).toBe(blobId);
      });
    });
  });

  describe('Given a partial repo (stored filter) whose wanted oid is already present locally', () => {
    describe('When fetch', () => {
      it('Then it still negotiates instead of short-circuiting', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { head: 'refs/heads/main' });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://example.com/r.git\n  partialclonefilter = blob:none\n',
        );
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'partial local\n');
        await writeSyntheticPack(ctx, 'seed', [
          { kind: 'base', type: 'blob', content: ENCODER.encode('partial local\n') },
        ]);
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'HEAD', id: blobId },
            { name: 'refs/heads/main', id: blobId },
          ],
          advertisedCaps: ['side-band-64k', 'ofs-delta', 'filter'],
          packBytes,
        });

        // Act
        await fetch({ ...ctx, transport });

        // Assert — the exchange still happened despite the object already being local.
        expect(requests.some((r) => r.method === 'POST')).toBe(true);
      });
    });
  });

  describe('Given a depth argument and every wanted oid already present locally', () => {
    describe('When fetch', () => {
      it('Then it still negotiates instead of short-circuiting', async () => {
        // Arrange — a shallow/deepen request must reach the server regardless
        // of local object presence: the point of `depth` is to extend history
        // the server holds, not to fetch an object the client already has.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { head: 'refs/heads/main' });
        await writeOriginConfig(ctx);
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'deepen local\n');
        await writeSyntheticPack(ctx, 'seed', [
          { kind: 'base', type: 'blob', content: ENCODER.encode('deepen local\n') },
        ]);
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          packBytes,
        });

        // Act
        await fetch({ ...ctx, transport }, { depth: 1 });

        // Assert — the exchange still happened despite the object already being local.
        const post = requests.find((r) => r.method === 'POST');
        expect(post).toBeDefined();
        expect(new TextDecoder().decode(post?.body)).toContain('deepen 1');
      });
    });
  });

  describe('Given every wanted oid is already local and a remote-tracking ref directory exists', () => {
    describe('When fetch', () => {
      it('Then the have-derivation walk never reads that directory', async () => {
        // Arrange — the fast path must return before `deriveHaves` runs, so a
        // `readdir` call on the (pre-seeded, genuinely existing) remote-tracking
        // ref directory would prove the have-walk still ran.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {
          head: 'refs/heads/main',
          refs: { 'refs/remotes/origin/main': FAKE_OID('a') },
        });
        await writeOriginConfig(ctx);
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'p1 local\n');
        await writeSyntheticPack(ctx, 'seed', [
          { kind: 'base', type: 'blob', content: ENCODER.encode('p1 local\n') },
        ]);
        const { transport } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          packBytes,
        });
        const poisonPath = `${ctx.layout.gitDir}/refs/remotes/origin`;
        const poisonedFs = {
          ...ctx.fs,
          readdir: (dir: string): ReturnType<typeof ctx.fs.readdir> => {
            if (dir === poisonPath) {
              throw new Error('poison: the everything-local fast path must skip the have-walk');
            }
            return ctx.fs.readdir(dir);
          },
        };

        // Act
        const result = await fetch({ ...ctx, fs: poisonedFs, transport });

        // Assert
        const update = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
        expect(update?.newId).toBe(blobId);
      });
    });
  });

  describe('Given the first wanted oid is missing locally and a second is also missing', () => {
    describe('When fetch', () => {
      it('Then the presence probe stops at the first missing oid', async () => {
        // Arrange — neither oid is written locally (no synthetic pack on
        // disk), so both probes fall through `hasObject` to `ctx.fs.exists`.
        // The second oid's probe is poisoned: it must never run once the
        // first probe has already settled the "not everything local" verdict.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { head: 'refs/heads/main' });
        await writeOriginConfig(ctx);
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: ENCODER.encode('p2 missing 1\n') },
          { kind: 'base', type: 'blob', content: ENCODER.encode('p2 missing 2\n') },
        ]);
        const [wantId1, wantId2] = built.ids as [ObjectId, ObjectId];
        const poisonPath = looseObjectPath(commonGitDir(ctx), wantId2);
        const poisonedFs = {
          ...ctx.fs,
          exists: (path: string): Promise<boolean> => {
            if (path === poisonPath) {
              throw new Error(
                'poison: the second want must not be probed once the first is missing',
              );
            }
            return ctx.fs.exists(path);
          },
        };
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: wantId1 },
            { name: 'refs/heads/feature', id: wantId2 },
          ],
          packBytes: built.packBytes,
        });

        // Act
        await fetch({ ...ctx, fs: poisonedFs, transport });

        // Assert — reaching this point at all proves the second want's poisoned probe never ran.
        expect(requests.some((r) => r.method === 'POST')).toBe(true);
      });
    });
  });

  describe('Given two wanted oids that are both already present locally', () => {
    describe('When fetch', () => {
      it('Then no upload-pack POST is issued', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { head: 'refs/heads/main' });
        await writeOriginConfig(ctx);
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: ENCODER.encode('p2 present 1\n') },
          { kind: 'base', type: 'blob', content: ENCODER.encode('p2 present 2\n') },
        ]);
        await writeSyntheticPack(ctx, 'seed', [
          { kind: 'base', type: 'blob', content: ENCODER.encode('p2 present 1\n') },
          { kind: 'base', type: 'blob', content: ENCODER.encode('p2 present 2\n') },
        ]);
        const [wantId1, wantId2] = built.ids as [ObjectId, ObjectId];
        const { transport, requests } = fakeRemote({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: wantId1 },
            { name: 'refs/heads/feature', id: wantId2 },
          ],
          packBytes: built.packBytes,
        });

        // Act
        await fetch({ ...ctx, transport });

        // Assert
        expect(requests.some((r) => r.method === 'POST')).toBe(false);
      });
    });
  });
});

describe('fetch — tracking refs mapped through the fetch refspecs', () => {
  const URL = 'https://example.com/r.git';
  const writeConfig = async (
    ctx: ReturnType<typeof createMemoryContext>,
    fetchLines: ReadonlyArray<string>,
  ): Promise<void> => {
    const lines = fetchLines.map((spec) => `  fetch = ${spec}\n`).join('');
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[remote "origin"]\n  url = ${URL}\n${lines}`,
    );
    __resetConfigCacheForTests();
  };
  const advertising = async (ctx: ReturnType<typeof createMemoryContext>, names: string[]) => {
    const { packBytes, blobId } = await buildOneBlobPack(ctx, 'mapped\n');
    const { transport } = fakeRemote({
      url: URL,
      advertisedRefs: names.map((name) => ({ name, id: blobId })),
      packBytes,
    });
    return { transport, blobId };
  };

  describe('Given a pattern refspec mapping only b* branches under refs/remotes/x/', () => {
    describe('When fetch runs against main and b2', () => {
      it('Then only refs/remotes/x/b2 is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await writeConfig(ctx, ['+refs/heads/b*:refs/remotes/x/b*']);
        const { transport } = await advertising(ctx, ['refs/heads/b2', 'refs/heads/main']);

        // Act
        const result = await fetch({ ...ctx, transport });

        // Assert
        expect(result.updatedRefs.map((ref) => ref.name)).toEqual(['refs/remotes/x/b2']);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(false);
      });
    });
  });

  describe('Given a negative refspec beside the pattern', () => {
    describe('When fetch runs against main and secret', () => {
      it('Then the excluded branch gets no tracking ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await writeConfig(ctx, ['+refs/heads/*:refs/remotes/origin/*', '^refs/heads/secret']);
        const { transport } = await advertising(ctx, ['refs/heads/main', 'refs/heads/secret']);

        // Act
        const result = await fetch({ ...ctx, transport });

        // Assert
        expect(result.updatedRefs.map((ref) => ref.name)).toEqual(['refs/remotes/origin/main']);
      });
    });
  });

  describe('Given a remote with no fetch refspec', () => {
    describe('When fetch runs', () => {
      it('Then no tracking ref is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await writeConfig(ctx, []);
        const { transport } = await advertising(ctx, ['HEAD', 'refs/heads/main']);

        // Act
        const result = await fetch({ ...ctx, transport });

        // Assert
        expect(result.updatedRefs).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes`)).toBe(false);
      });
    });
  });

  describe('Given prune and a mapped tracking ref the remote no longer advertises', () => {
    describe('When fetch runs', () => {
      it('Then only the mapped ref is pruned and an unmapped namespace is kept', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {
          refs: { 'refs/remotes/x/b2': FAKE_OID('a'), 'refs/remotes/origin/zz': FAKE_OID('b') },
        });
        await writeConfig(ctx, ['+refs/heads/b*:refs/remotes/x/b*']);
        const { transport } = await advertising(ctx, ['refs/heads/b3']);

        // Act
        const result = await fetch({ ...ctx, transport }, { prune: true });

        // Assert
        expect(result.prunedRefs).toEqual(['refs/remotes/x/b2']);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/zz`)).toBe(true);
      });
    });
  });
});

describe('fetch — FETCH_HEAD and command-line refspecs', () => {
  const URL = 'https://example.com/r.git/';
  const TREE = 'e'.repeat(40);
  const arrange = async (config: string, names: ReadonlyArray<string>) => {
    const ctx = createMemoryContext();
    const { commitIds } = await seedRepo(ctx, { commits: [{ tree: TREE }] });
    const tip = commitIds[0] as ObjectId;
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[remote "origin"]\n  url = ${URL}\n${config}`,
    );
    __resetConfigCacheForTests();
    const { transport } = fakeRemote({
      url: URL,
      advertisedRefs: names.map((name) => ({ name, id: tip })),
      packBytes: new Uint8Array(0),
    });
    return { ctx: { ...ctx, transport }, tip };
  };
  const fetchHead = (ctx: ReturnType<typeof createMemoryContext>) =>
    ctx.fs.readUtf8(`${ctx.layout.gitDir}/FETCH_HEAD`);
  const ORIGIN_FETCH = '  fetch = +refs/heads/*:refs/remotes/origin/*\n';
  const MERGE_B2 = '[branch "main"]\n  remote = origin\n  merge = refs/heads/b2\n';

  describe('Given a branch whose upstream is the fetched remote', () => {
    describe('When fetch runs', () => {
      it('Then FETCH_HEAD lists the upstream for merging first and the rest not for merging', async () => {
        // Arrange
        const { ctx, tip } = await arrange(`${ORIGIN_FETCH}${MERGE_B2}`, [
          'refs/heads/b2',
          'refs/heads/main',
        ]);
        const sut = fetch;

        // Act
        await sut(ctx);

        // Assert
        expect(await fetchHead(ctx)).toBe(
          `${tip}\t\tbranch 'b2' of https://example.com/r\n` +
            `${tip}\tnot-for-merge\tbranch 'main' of https://example.com/r\n`,
        );
      });
    });
  });

  describe('Given command-line refspecs', () => {
    describe('When fetch runs', () => {
      it('Then their refs are for merging and the configured refspecs update tracking refs', async () => {
        // Arrange
        const { ctx, tip } = await arrange(ORIGIN_FETCH, ['refs/heads/b2', 'refs/heads/main']);
        const sut = fetch;

        // Act
        const result = await sut(ctx, { refspecs: ['main'] });

        // Assert
        expect(await fetchHead(ctx)).toBe(`${tip}\t\tbranch 'main' of https://example.com/r\n`);
        expect(result.updatedRefs.map((ref) => ref.name)).toEqual(['refs/remotes/origin/main']);
      });
    });
  });

  describe('Given command-line refspecs and an empty refmap', () => {
    describe('When fetch runs', () => {
      it('Then no tracking ref is updated', async () => {
        // Arrange
        const { ctx } = await arrange(ORIGIN_FETCH, ['refs/heads/main']);
        const sut = fetch;

        // Act
        const result = await sut(ctx, { refspecs: ['main'], refmap: [''] });

        // Assert
        expect(result.updatedRefs).toEqual([]);
      });
    });
  });

  describe('Given a command-line refspec git cannot parse', () => {
    describe('When fetch runs', () => {
      it('Then it refuses the refspec before touching FETCH_HEAD', async () => {
        // Arrange
        const { ctx } = await arrange(ORIGIN_FETCH, ['refs/heads/main']);
        const sut = fetch;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, { refspecs: ['refs/heads/*'] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'REFSPEC_INVALID',
          raw: 'refs/heads/*',
          reason: 'not a valid refspec',
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/FETCH_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given an invalid refmap', () => {
    describe('When fetch runs', () => {
      it('Then it refuses the refmap', async () => {
        // Arrange
        const { ctx } = await arrange(ORIGIN_FETCH, ['refs/heads/main']);
        const sut = fetch;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, { refspecs: ['main'], refmap: ['a b'] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'REFSPEC_INVALID',
          raw: 'a b',
          reason: 'not a valid refspec',
        });
      });
    });
  });

  describe('Given a stale FETCH_HEAD and a refspec naming a missing remote ref', () => {
    describe('When fetch runs', () => {
      it('Then FETCH_HEAD is left truncated', async () => {
        // Arrange
        const { ctx } = await arrange(ORIGIN_FETCH, ['refs/heads/main']);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/FETCH_HEAD`, 'stale\n');
        const sut = fetch;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, { refspecs: ['nope'] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'REMOTE_REF_NOT_FOUND', ref: 'nope' });
        expect(await fetchHead(ctx)).toBe('');
      });
    });
  });

  describe('Given a ref for merging that names no commit', () => {
    describe('When fetch runs', () => {
      it('Then FETCH_HEAD lists it not for merging', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          `[remote "origin"]\n  url = ${URL}\n`,
        );
        __resetConfigCacheForTests();
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'not a commit\n');
        const { transport } = fakeRemote({
          url: URL,
          advertisedRefs: [{ name: 'HEAD', id: blobId }],
          packBytes,
        });
        const sut = fetch;

        // Act
        await sut({ ...ctx, transport });

        // Assert
        expect(await fetchHead(ctx)).toBe(`${blobId}\tnot-for-merge\thttps://example.com/r\n`);
      });
    });
  });
});

describe('fetch — wants, include-tag and tag backfill', () => {
  const URL = 'https://example.com/r.git';
  const UNMAPPED = FAKE_OID('d');
  const twoBlobPack = async (ctx: ReturnType<typeof createMemoryContext>) => {
    const built = await buildSyntheticPack(ctx, [
      { kind: 'base', type: 'blob', content: ENCODER.encode('first\n') },
      { kind: 'base', type: 'blob', content: ENCODER.encode('second\n') },
    ]);
    return {
      packBytes: built.packBytes,
      first: built.ids[0] as ObjectId,
      second: built.ids[1] as ObjectId,
    };
  };
  const configure = async (ctx: ReturnType<typeof createMemoryContext>, fetchSpec: string) => {
    await seedRepo(ctx, {});
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[remote "origin"]\n  url = ${URL}\n  fetch = ${fetchSpec}\n`,
    );
    __resetConfigCacheForTests();
  };
  const postBody = (requests: ReadonlyArray<HttpRequest>): string =>
    DECODER.decode(requests.find((request) => request.method === 'POST')?.body);

  describe('Given refspecs mapping only some advertised branches', () => {
    describe('When fetch negotiates', () => {
      it('Then only the mapped refs are wanted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await configure(ctx, '+refs/heads/b*:refs/remotes/x/b*');
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'mapped\n');
        const { transport, requests } = fakeRemote({
          url: URL,
          advertisedRefs: [
            { name: 'refs/heads/b2', id: blobId },
            { name: 'refs/heads/main', id: UNMAPPED },
          ],
          packBytes,
        });
        const sut = fetch;

        // Act
        await sut({ ...ctx, transport });

        // Assert
        expect(postBody(requests)).toContain(`want ${blobId}`);
        expect(postBody(requests)).not.toContain(`want ${UNMAPPED}`);
      });
    });
  });

  describe.each([
    { label: 'refspecs storing into refs', refspecs: undefined, expected: true },
    { label: 'a command-line refspec storing nowhere', refspecs: ['main'], expected: false },
  ])('Given a v1 server offering include-tag and $label', ({ refspecs, expected }) => {
    describe('When fetch negotiates', () => {
      it(`Then include-tag is ${expected ? '' : 'not '}requested`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        await configure(ctx, '+refs/heads/*:refs/remotes/origin/*');
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'tip\n');
        const { transport, requests } = fakeRemote({
          url: URL,
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          advertisedCaps: ['side-band-64k', 'ofs-delta', 'include-tag'],
          packBytes,
        });
        const sut = fetch;

        // Act
        await sut({ ...ctx, transport }, refspecs === undefined ? {} : { refspecs });

        // Assert
        expect(postBody(requests).includes('include-tag')).toBe(expected);
      });
    });
  });

  describe('Given a v2 server and refspecs storing into refs', () => {
    describe('When fetch negotiates', () => {
      it('Then the fetch command carries include-tag', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await configure(ctx, '+refs/heads/*:refs/remotes/origin/*');
        const { packBytes, blobId } = await buildOneBlobPack(ctx, 'v2 tip\n');
        const { transport, requests } = fakeRemoteV2({
          advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
          packBytes,
        });
        const sut = fetch;

        // Act
        await sut({ ...ctx, transport });

        // Assert
        const fetchRequest = requests
          .map((request) => DECODER.decode(request.body))
          .find((body) => body.includes('command=fetch'));
        expect(fetchRequest).toContain('include-tag');
      });
    });
  });

  describe('Given a tag on an object that only arrives with the pack', () => {
    describe('When fetch completes', () => {
      it('Then the tag is backfilled and listed after the fetched refs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await configure(ctx, '+refs/heads/*:refs/remotes/origin/*');
        const { packBytes, first, second } = await twoBlobPack(ctx);
        const { transport } = fakeRemote({
          url: URL,
          advertisedRefs: [
            { name: 'refs/heads/main', id: first },
            { name: 'refs/tags/t', id: second },
          ],
          packBytes,
        });
        const sut = fetch;

        // Act
        const result = await sut({ ...ctx, transport });

        // Assert
        expect(result.updatedRefs.map((ref) => ref.name)).toEqual([
          'refs/remotes/origin/main',
          'refs/tags/t',
        ]);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/FETCH_HEAD`)).toBe(
          `${first}\tnot-for-merge\tbranch 'main' of https://example.com/r\n` +
            `${second}\tnot-for-merge\ttag 't' of https://example.com/r\n`,
        );
      });
    });
  });

  describe('Given a command-line refspec storing into the ref the tracking refspec maps another ref to', () => {
    describe('When fetch runs', () => {
      it('Then git warns through the logger that the ref usually tracks the other', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await configure(ctx, '+refs/heads/*:refs/remotes/origin/*');
        const { packBytes, first, second } = await twoBlobPack(ctx);
        const { transport } = fakeRemote({
          url: URL,
          advertisedRefs: [
            { name: 'refs/heads/a', id: first },
            { name: 'refs/heads/b', id: second },
          ],
          packBytes,
        });
        const warnings: string[] = [];
        const logger = { ...ctx.logger, warn: (message: string) => warnings.push(message) };
        const sut = fetch;

        // Act
        await sut(
          { ...ctx, transport, logger },
          {
            refspecs: ['refs/heads/a:refs/remotes/origin/b', 'b'],
          },
        );

        // Assert
        expect(warnings).toEqual([
          'refs/remotes/origin/b usually tracks refs/heads/b, not refs/heads/a',
        ]);
      });
    });
  });
});

describe('fetch reflog actions', () => {
  const IDENT = { name: 'Ada', email: 'ada@example.com', timestamp: 1, timezoneOffset: '+0000' };

  const writeCommit = (
    ctx: ReturnType<typeof createMemoryContext>,
    parents: ReadonlyArray<ObjectId>,
    message: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree: emptyTreeOid(ctx.hashConfig),
        parents,
        author: IDENT,
        committer: IDENT,
        message,
        extraHeaders: [],
      },
    });

  const reflogOf = async (ctx: ReturnType<typeof createMemoryContext>, ref: string) =>
    (await reflogEntries(ctx, ref as RefName)).map((entry) => entry.message);

  /** origin maps `spec`; `local` is seeded, the remote advertises `remote`. */
  const fetchWith = async (
    spec: string,
    local: Readonly<Record<string, ObjectId>>,
    remote: ReadonlyArray<{ readonly name: string; readonly id: ObjectId }>,
    ctx: ReturnType<typeof createMemoryContext>,
  ): Promise<FetchResult> => {
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[core]\n  logAllRefUpdates = always\n[remote "origin"]\n  url = https://example.com/r.git\n  fetch = ${spec}\n`,
    );
    for (const [name, id] of Object.entries(local)) {
      await seedRef(ctx, name as RefName, id, { reflogMessage: 'seed' });
    }
    const { packBytes } = await buildOneBlobPack(ctx, 'unused\n');
    const { transport } = fakeRemote({
      url: 'https://example.com/r.git',
      advertisedRefs: remote,
      packBytes,
    });
    return fetch({ ...ctx, transport }, { remote: 'origin' });
  };

  describe.each([
    ['a new tag', '+refs/tags/*:refs/tags/*', 'refs/tags/v1', 'refs/tags/v1', 'storing tag'],
    [
      'a new ref outside heads and tags',
      '+refs/notes/*:refs/notes/*',
      'refs/notes/n',
      'refs/notes/n',
      'storing ref',
    ],
    [
      'a new branch',
      '+refs/heads/*:refs/remotes/origin/*',
      'refs/heads/b',
      'refs/remotes/origin/b',
      'storing head',
    ],
  ])('Given %s advertised', (_label, spec, remoteRef, localRef, action) => {
    describe('When fetch stores it', () => {
      it('Then the reflog names the kind of the remote ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const tip = await writeCommit(ctx, [], 'tip\n');
        const sut = fetchWith;

        // Act
        await sut(spec, {}, [{ name: remoteRef, id: tip }], ctx);

        // Assert
        expect(await reflogOf(ctx, localRef)).toEqual([`fetch origin: ${action}`]);
      });
    });
  });

  describe('Given a remote-tracking ref behind the advertised commit', () => {
    describe('When fetch advances it', () => {
      it('Then the reflog records a fast-forward', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const next = await writeCommit(ctx, [base], 'next\n');
        const sut = fetchWith;

        // Act
        await sut(
          '+refs/heads/*:refs/remotes/origin/*',
          { 'refs/remotes/origin/main': base },
          [{ name: 'refs/heads/main', id: next }],
          ctx,
        );

        // Assert
        expect(await reflogOf(ctx, 'refs/remotes/origin/main')).toEqual([
          'seed',
          'fetch origin: fast-forward',
        ]);
      });
    });
  });

  describe('Given a remote-tracking ref the advertised commit does not descend from', () => {
    describe('When a forcing refspec rewrites it', () => {
      it('Then the reflog records a forced update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const other = await writeCommit(ctx, [], 'other\n');
        const sut = fetchWith;

        // Act
        await sut(
          '+refs/heads/*:refs/remotes/origin/*',
          { 'refs/remotes/origin/main': base },
          [{ name: 'refs/heads/main', id: other }],
          ctx,
        );

        // Assert
        expect(await reflogOf(ctx, 'refs/remotes/origin/main')).toEqual([
          'seed',
          'fetch origin: forced-update',
        ]);
      });
    });
  });

  describe('Given an existing tag the remote moved', () => {
    describe('When a forcing refspec rewrites it', () => {
      it('Then the reflog records a tag update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const next = await writeCommit(ctx, [base], 'next\n');
        const sut = fetchWith;

        // Act
        await sut(
          '+refs/tags/*:refs/tags/*',
          { 'refs/tags/v1': base },
          [{ name: 'refs/tags/v1', id: next }],
          ctx,
        );

        // Assert
        expect(await reflogOf(ctx, 'refs/tags/v1')).toEqual(['seed', 'fetch origin: updating tag']);
      });
    });
  });

  describe('Given reading the stored commit fails for a reason other than absence', () => {
    describe('When fetch judges the update', () => {
      it('Then the failure propagates', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const tip = await writeCommit(ctx, [base], 'tip\n');
        const failure = new Error('object store unreadable');
        vi.spyOn(peelModule, 'peelRefToCommit').mockRejectedValue(failure);
        const sut = fetchWith;

        // Act
        const attempt = sut(
          '+refs/heads/*:refs/remotes/origin/*',
          { 'refs/remotes/origin/b': base },
          [{ name: 'refs/heads/b', id: tip }],
          ctx,
        );

        // Assert
        await expect(attempt).rejects.toBe(failure);
        vi.restoreAllMocks();
      });
    });
  });

  const tipOf = async (ctx: ReturnType<typeof createMemoryContext>, ref: string) => {
    const value = await getRefStore(ctx).resolveDirect(ref as RefName);
    return value.kind === 'direct' ? value.id : undefined;
  };

  describe('Given a refspec without the force flag and a tracking ref the advertised commit does not descend from', () => {
    describe('When fetch runs', () => {
      it('Then that update is rejected as non-fast-forward and the other refs still update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const other = await writeCommit(ctx, [], 'other\n');
        const next = await writeCommit(ctx, [base], 'next\n');
        const sut = fetchWith;

        // Act
        const result = await sut(
          'refs/heads/*:refs/remotes/origin/*',
          { 'refs/remotes/origin/main': base, 'refs/remotes/origin/side': base },
          [
            { name: 'refs/heads/main', id: other },
            { name: 'refs/heads/side', id: next },
          ],
          ctx,
        );

        // Assert
        expect(result.updatedRefs).toEqual([
          {
            name: 'refs/remotes/origin/main',
            source: 'refs/heads/main',
            oldId: base,
            newId: other,
            status: 'rejected',
            rejection: 'non-fast-forward',
          },
          {
            name: 'refs/remotes/origin/side',
            source: 'refs/heads/side',
            oldId: base,
            newId: next,
            status: 'ok',
          },
        ]);
        expect(await tipOf(ctx, 'refs/remotes/origin/main')).toBe(base);
        expect(await reflogOf(ctx, 'refs/remotes/origin/main')).toEqual(['seed']);
        expect(await tipOf(ctx, 'refs/remotes/origin/side')).toBe(next);
      });
    });
  });

  describe('Given a refspec without the force flag and an existing tag the remote moved', () => {
    describe('When fetch runs', () => {
      it('Then the update is rejected as clobbering the tag, which keeps its object', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const next = await writeCommit(ctx, [base], 'next\n');
        const sut = fetchWith;

        // Act
        const result = await sut(
          'refs/tags/*:refs/tags/*',
          { 'refs/tags/v1': base },
          [{ name: 'refs/tags/v1', id: next }],
          ctx,
        );

        // Assert
        expect(result.updatedRefs).toEqual([
          {
            name: 'refs/tags/v1',
            source: 'refs/tags/v1',
            oldId: base,
            newId: next,
            status: 'rejected',
            rejection: 'would-clobber-existing-tag',
          },
        ]);
        expect(await tipOf(ctx, 'refs/tags/v1')).toBe(base);
      });
    });
  });

  describe('Given a refspec without the force flag and a rejected update', () => {
    describe('When fetch writes FETCH_HEAD', () => {
      it('Then the rejected ref is still listed with the fetched object', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const other = await writeCommit(ctx, [], 'other\n');
        const sut = fetchWith;

        // Act
        await sut(
          'refs/heads/main:refs/remotes/origin/main',
          { 'refs/remotes/origin/main': base },
          [{ name: 'refs/heads/main', id: other }],
          ctx,
        );

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/FETCH_HEAD`)).toBe(
          `${other}\t\tbranch 'main' of https://example.com/r\n`,
        );
      });
    });
  });

  describe('Given a refspec without the force flag and a ref that does not name a commit', () => {
    describe('When fetch replaces it', () => {
      it('Then the update is stored, as git stores what it cannot compare', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const tree = emptyTreeOid(ctx.hashConfig);
        await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
        const sut = fetchWith;

        // Act
        const result = await sut(
          'refs/heads/*:refs/remotes/origin/*',
          { 'refs/remotes/origin/main': tree },
          [{ name: 'refs/heads/main', id: base }],
          ctx,
        );

        // Assert
        expect(result.updatedRefs).toEqual([
          {
            name: 'refs/remotes/origin/main',
            source: 'refs/heads/main',
            oldId: tree,
            newId: base,
            status: 'ok',
          },
        ]);
        expect(await reflogOf(ctx, 'refs/remotes/origin/main')).toEqual([
          'seed',
          'fetch origin: storing head',
        ]);
      });
    });
  });

  describe('Given a refspec without the force flag and a ref already at the advertised commit', () => {
    describe('When fetch runs', () => {
      it('Then the ref is listed as up to date', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const base = await writeCommit(ctx, [], 'base\n');
        const sut = fetchWith;

        // Act
        const result = await sut(
          'refs/heads/*:refs/remotes/origin/*',
          { 'refs/remotes/origin/main': base },
          [{ name: 'refs/heads/main', id: base }],
          ctx,
        );

        // Assert
        expect(result.updatedRefs).toEqual([
          {
            name: 'refs/remotes/origin/main',
            source: 'refs/heads/main',
            oldId: base,
            newId: base,
            status: 'ok',
          },
        ]);
      });
    });
  });
});
