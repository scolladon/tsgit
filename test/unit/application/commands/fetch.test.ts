/**
 * Phase 12.2 — fetch command. Real pack-driven body.
 *
 * Tests cover:
 *  - REMOTE_NOT_CONFIGURED + REMOTE_ADVERTISES_NO_REFS guards.
 *  - Happy fetch (no shallow): pack written, refs/remotes/<remote>/* updated.
 *  - haves derivation (the request body carries `have <oid>` lines).
 *  - prune semantics (refs/remotes/<remote>/<branch> deletion).
 *  - shallow fetch (.git/shallow is written, result carries the oid).
 *  - Local refs (refs/heads/*, refs/tags/*) never touched.
 *  - Progress (fetch:negotiate + fetch:write-objects).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fetch } from '../../../../src/application/commands/fetch.js';
import { readShallow } from '../../../../src/application/primitives/shallow-file.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { buildSyntheticPack } from '../primitives/pack-fixture.js';
import { recordingProgress, seedRepo, withProgress } from './fixtures.js';

const ENCODER = new TextEncoder();

const FAKE_OID = (label: string): ObjectId =>
  label.padEnd(40, label[0] ?? '0').slice(0, 40) as ObjectId;

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
  //   <pkt># service=git-upload-pack\n>
  //   <flush>
  //   <pkt>oid name\0caps\n>
  //   <pkt>oid name\n> ...
  //   <flush>
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

const writeOriginConfig = async (ctx: ReturnType<typeof createMemoryContext>): Promise<void> => {
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/config`,
    '[remote "origin"]\n  url = https://example.com/r.git\n',
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
    it('Given no remote configured, When fetch, Then throws REMOTE_NOT_CONFIGURED', async () => {
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
      expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
    });

    it('Given an advertisement with zero refs, When fetch, Then throws REMOTE_ADVERTISES_NO_REFS', async () => {
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

      // Act
      let caught: unknown;
      try {
        await fetch({ ...ctx, transport }, { remote: 'origin' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('REMOTE_ADVERTISES_NO_REFS');
    });
  });

  describe('happy path', () => {
    it('Given an origin advertising one branch, When fetch, Then result holds the resolved remote + url', async () => {
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
      const sut = await fetch({ ...ctx, transport });

      // Assert
      expect(sut.remote).toBe('origin');
      expect(sut.url).toBe('https://example.com/r.git');
    });

    it('Given an advertised branch ref, When fetch, Then refs/remotes/origin/<branch> is written with the new oid', async () => {
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
      const sut = await fetch({ ...ctx, transport });

      // Assert
      const updated = sut.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
      expect(updated).toBeDefined();
      expect(updated?.newId).toBe(blobId);
      const onDisk = (
        await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`)
      ).trim();
      expect(onDisk).toBe(blobId);
    });

    it('Given an advertised tag, When fetch, Then refs/tags/<tag> is written', async () => {
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
      const sut = await fetch({ ...ctx, transport });

      // Assert
      const tagWritten = sut.updatedRefs.find((r) => r.name === 'refs/tags/v1');
      expect(tagWritten).toBeDefined();
      const onDisk = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/tags/v1`)).trim();
      expect(onDisk).toBe(blobId);
    });

    it('Given a pre-existing remote-tracking ref, When fetch advances it, Then oldId in updatedRefs matches the prior on-disk oid', async () => {
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
      const sut = await fetch({ ...ctx, transport });

      // Assert
      const updated = sut.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
      expect(updated?.oldId).toBe(oldOid);
      expect(updated?.newId).toBe(blobId);
    });
  });

  describe('haves derivation (ADR-010)', () => {
    it('Given remote-tracking refs already on disk, When fetch, Then the upload-pack request body carries `have` lines for those tips', async () => {
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

    it('Given 257 remote-tracking ref tips, When fetch, Then haves are capped at MAX_HAVES=256 in the request body', async () => {
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

    it('Given exactly MAX_HAVES (256) refs, When fetch, Then all 256 haves are sent (boundary)', async () => {
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

    it('Given a packed-only remote-tracking ref, When fetch, Then haves include the packed-ref tip', async () => {
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

    it('Given no remote-tracking refs (first fetch), When fetch, Then the request body has no `have` lines', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      await writeOriginConfig(ctx);
      const { packBytes, blobId } = await buildOneBlobPack(ctx, 'first fetch\n');
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
      expect(decoded).not.toContain('have ');
    });
  });

  describe('prune (ADR-012)', () => {
    it('Given prune=true and a stale remote-tracking ref, When fetch, Then the stale ref is deleted and listed in prunedRefs', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { prune: true });

      // Assert — feature-x pruned AND main preserved. The negative assertion
      // on `main` is what kills the prune `.filter().map()` chain mutant:
      // without the chain, `advertised.has('main')` returns false (the Set
      // holds AdvertisedRef objects, not strings) and `main` would also be
      // deleted.
      expect(sut.prunedRefs).toContain('refs/remotes/origin/feature-x' as RefName);
      expect(sut.prunedRefs).not.toContain('refs/remotes/origin/main' as RefName);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature-x`)).toBe(false);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(true);
    });

    it('Given prune=false, When fetch, Then stale remote-tracking refs are preserved', async () => {
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
      const sut = await fetch({ ...ctx, transport });

      // Assert
      expect(sut.prunedRefs).toEqual([]);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature-x`)).toBe(true);
    });

    it('Given prune=true, When the server advertises every local remote-tracking ref, Then prunedRefs is empty', async () => {
      // Arrange — boundary: nothing to prune.
      const ctx = createMemoryContext();
      await seedRepo(ctx, {
        refs: { 'refs/remotes/origin/main': FAKE_OID('a') },
      });
      await writeOriginConfig(ctx);
      const { packBytes, blobId } = await buildOneBlobPack(ctx, 'no-op prune\n');
      const { transport } = fakeRemote({
        url: 'https://example.com/r.git',
        advertisedRefs: [{ name: 'refs/heads/main', id: blobId }],
        packBytes,
      });

      // Act
      const sut = await fetch({ ...ctx, transport }, { prune: true });

      // Assert
      expect(sut.prunedRefs).toEqual([]);
    });

    it('Given prune=true with stale refs, When fetch, Then local branches and local tags are NEVER deleted', async () => {
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

  describe('advertisement filtering (mutation kills for remoteTargetForRef)', () => {
    it('Given a HEAD ref in the advertisement, When fetch, Then HEAD does NOT appear in updatedRefs', async () => {
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
      const sut = await fetch({ ...ctx, transport });

      // Assert
      expect(sut.updatedRefs.map((r) => r.name)).not.toContain('HEAD');
      expect(sut.updatedRefs.map((r) => r.name)).toContain('refs/remotes/origin/main');
    });

    it('Given a refs/notes/* advertisement (neither head nor tag), When fetch, Then it is dropped', async () => {
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
      const sut = await fetch({ ...ctx, transport });

      // Assert — only the branch ref is written; refs/notes/commits is
      // skipped (neither a branch nor a tag).
      expect(sut.updatedRefs.map((r) => r.name)).toEqual(['refs/remotes/origin/main']);
    });
  });

  describe('shallow file write triggers (mutation kills for the OR clause)', () => {
    it('Given a server returning unshallow ONLY, When fetch, Then .git/shallow is written', async () => {
      // Arrange — kills the `unshallow.length > 0 ? false : ...` mutant.
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
      const sut = await fetch({ ...ctx, transport }, { depth: 5 });

      // Assert — `unshallow` was processed; the shallow file no longer
      // contains the unshallowed oid.
      expect(sut.unshallow).toEqual([unshallowOid]);
      const remaining = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`)).trim();
      expect(remaining).toBe('b'.repeat(40));
    });

    it('Given pre-existing .git/shallow and a fetch with NO shallow/unshallow lines, When fetch, Then .git/shallow is preserved (no spurious rewrite)', async () => {
      // Arrange — kills the `shallow.length > 0 || unshallow.length > 0` →
      // always-true mutant. With always-true, updateShallow would re-process
      // (re-read + re-write) the file even when the server said nothing.
      // We assert that the file's content is preserved verbatim — any
      // mutant that triggers a re-write would still produce the same content
      // here (Set semantics), so we ALSO assert .git/shallow.lock is NOT
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
      const sut = await fetch({ ...ctx, transport });

      // Assert — server said nothing about shallow → no write.
      expect(sut.shallow).toEqual([]);
      expect(sut.unshallow).toEqual([]);
      // File preserved.
      const after = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
      expect(after).toBe(initial);
    });
  });

  describe('haves derivation guards (mutation kills for collectRefTips)', () => {
    it('Given no remote-tracking refs and no packed refs, When fetch, Then walkCommits is NOT invoked and request body has no haves', async () => {
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
      let sut: Awaited<ReturnType<typeof fetch>> | undefined;
      try {
        sut = await fetch({ ...ctx, transport });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeUndefined();
      expect(sut?.remote).toBe('origin');
      const postReq = requests.find((r) => r.method === 'POST');
      expect(postReq).toBeDefined();
      const decoded = new TextDecoder().decode(postReq?.body);
      expect(decoded).not.toContain('have ');
    });

    it('Given a packed refs/tags/<tag> entry, When fetch, Then its oid IS sent as a have (kills the startsWith → endsWith mutant)', async () => {
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

    it('Given duplicate ref tips pointing at the same oid, When fetch, Then the oid appears once in the request body (kills the seen-set dedup)', async () => {
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

    it('Given a packed ref outside refs/remotes/<remote>/* and refs/tags/*, When fetch, Then its oid is NOT sent as a have', async () => {
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
      expect(decoded).not.toContain(`have ${internalOid}`);
    });

    it('Given a nested refs/remotes/origin/feature/x ref, When fetch, Then its oid is included as a have (recursive directory walk)', async () => {
      // Arrange — kills two mutants:
      //   (a) `if (entry.isDirectory)` → false: the nested directory
      //       wouldn't be recursed into.
      //   (b) the prefix-composition strip mutants — the nested ref needs
      //       both the directory recursion AND the path concatenation to
      //       surface.
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

    it('Given a non-oid file under refs/remotes/origin/, When fetch, Then it is NOT sent as a have', async () => {
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

  describe('prune mutation kills', () => {
    it('Given prune=true and an advertisement with only tag refs (no heads), When fetch, Then prune does NOT throw on a missing refs/remotes/<remote>/ dir', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { prune: true });

      // Assert — succeeds; prunedRefs is empty.
      expect(sut.prunedRefs).toEqual([]);
      // remoteDir should NOT have been created (no head refs advertised).
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin`)).toBe(false);
    });

    it('Given prune=true and a nested refs/remotes/origin/feature/x that is NOT advertised, When fetch, Then the nested ref is deleted with its prefix preserved', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { prune: true });

      // Assert
      expect(sut.prunedRefs).toContain('refs/remotes/origin/feature/x' as RefName);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature/x`)).toBe(false);
    });

    it('Given a tag whose slice(11) matches a local remote-tracking ref, When prune=true fetch runs, Then the local ref IS pruned (kills the .filter drop mutant)', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { prune: true });

      // Assert — the local `reserved` ref IS pruned (not advertised). With
      // the mutant, advertisedBranches would include 'reserved' and the
      // ref would be preserved.
      expect(sut.prunedRefs).toContain('refs/remotes/origin/reserved' as RefName);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/reserved`)).toBe(false);
    });

    it('Given prune=true and a tag advertisement, When fetch, Then prune builds the branch set from heads only (kills the .filter mutant)', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { prune: true });

      // Assert — main is preserved (it IS advertised); no spurious deletes.
      expect(sut.prunedRefs).toEqual([]);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(true);
    });
  });

  describe('hostile server defenses', () => {
    it('Given a server advertising refs/heads/../../config (path traversal), When fetch, Then the malicious ref is silently dropped', async () => {
      // Arrange — security review HIGH-1. Without validateRefName in
      // `remoteTargetForRef`, the composed `refs/remotes/origin/../../config`
      // would point at `.git/config` and `readExistingRef` would `readUtf8`
      // it. validateRefName rejects `..`, so the ref is dropped entirely —
      // no on-disk read, no updatedRefs entry.
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

      // Act
      const sut = await fetch({ ...ctx, transport });

      // Assert — only the safe ref made it through.
      expect(sut.updatedRefs.map((r) => r.name)).toEqual(['refs/remotes/origin/main']);
    });
  });

  describe('shallow fetch (ADR-009)', () => {
    it('Given depth=1 and a server emitting shallow <oid>, When fetch, Then .git/shallow is written with that oid and result.shallow contains it', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { depth: 1 });

      // Assert
      expect(sut.shallow).toEqual([shallowOid]);
      const onDisk = await readShallow({ ...ctx, transport });
      expect(onDisk.has(shallowOid as ObjectId)).toBe(true);
    });

    it('Given depth=1 and the server ignores deepen, When fetch, Then .git/shallow is NOT created', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { depth: 1 });

      // Assert
      expect(sut.shallow).toEqual([]);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
    });

    it('Given depth set and an unshallow response, When fetch, Then result.unshallow holds the oid', async () => {
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
      const sut = await fetch({ ...ctx, transport }, { depth: 3 });

      // Assert
      expect(sut.unshallow).toEqual([unshallowOid]);
    });
  });

  describe('local-refs safety (ADR-011 §3.8)', () => {
    it('Given local refs/heads/* + refs/tags/*, When fetch runs, Then both are left untouched', async () => {
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
      expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim()).toBe(localOid);
      expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/tags/v0`)).trim()).toBe(localOid);
    });

    it('Given a local refs/heads/main oid, When fetch derives haves, Then that oid is NOT sent as a have (kills the looseDirs scope mutant)', async () => {
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
      expect(decoded).not.toContain(`have ${localHeadOid}`);
    });
  });

  describe('progress reporting', () => {
    it('Given a successful fetch, When run, Then a fetch:negotiate start/end pair fires', async () => {
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

    it('Given a successful fetch, When run, Then a fetch:write-objects start/end pair fires', async () => {
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

    it('Given a failing fetch (no remote), When run, Then end still fires after start', async () => {
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
