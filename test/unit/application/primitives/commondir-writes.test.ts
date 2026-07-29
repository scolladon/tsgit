/**
 * The shared (⇒ common) half of the write-surface sweep: every
 * `ctx.layout.gitDir` site that must route through `commonGitDir(ctx)` for a
 * linked-worktree child Context. Each case asserts BOTH halves — presence
 * under the common dir and absence under the admin dir — so a revert mutant
 * is caught either way.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { branchList } from '../../../../src/application/commands/branch.js';
import { fetch } from '../../../../src/application/commands/fetch.js';
import { createPromisorRemote } from '../../../../src/application/commands/fetch-missing.js';
import { negotiatePackBytes } from '../../../../src/application/commands/internal/fetch-negotiation.js';
import { tagList } from '../../../../src/application/commands/tag.js';
import {
  fetchPack,
  type NegotiatePackBytes,
} from '../../../../src/application/primitives/fetch-pack.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import {
  NO_HOOKS_SUBDIR,
  resolveHooksDir,
  runHook,
} from '../../../../src/application/primitives/run-hook.js';
import { updateShallow } from '../../../../src/application/primitives/shallow-file.js';
import { pushStashRef } from '../../../../src/application/primitives/stash-ref.js';
import {
  updateConfigEntries,
  updateConfigOperations,
} from '../../../../src/application/primitives/update-config.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { Blob, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import {
  decodePktStream,
  encodePktStream,
  type GitExchange,
} from '../../../../src/domain/protocol/pkt-line.js';
import { readableStreamToAsyncIterable } from '../../../../src/operators/readable-stream.js';
import type { Context } from '../../../../src/ports/context.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { seedRepo } from '../commands/fixtures.js';
import { buildSeededContext } from './fixtures.js';
import { buildSyntheticPack } from './pack-fixture.js';

const ENCODER = new TextEncoder();

/** The linked worktree's own (admin) gitdir under the common dir's `worktrees/`. */
const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

/** Reframe a seeded main-repo Context as a linked-worktree child Context. */
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

/** Give the child's own (admin) gitdir the `HEAD` file `assertOperationalRepository` requires. */
const seedAdminHead = (ctx: Context): Promise<void> =>
  ctx.fs.writeUtf8(`${adminDir(ctx)}/HEAD`, 'ref: refs/heads/main\n');

const forbiddenTransport = (): HttpTransport => ({
  request: async (): Promise<HttpResponse> => {
    throw new Error('network must not be touched');
  },
});

/** Smart-HTTP v1 advertisement + NAK/side-band-1 pack response, capturing requests. */
const fakeFetchRemote = (
  advertisedRefs: ReadonlyArray<{ readonly name: string; readonly id: ObjectId }>,
  packBytes: Uint8Array,
): { readonly transport: HttpTransport; readonly requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const refLines = advertisedRefs.map((r, idx) =>
    idx === 0
      ? ENCODER.encode(`${r.id} ${r.name}\0side-band-64k ofs-delta\n`)
      : ENCODER.encode(`${r.id} ${r.name}\n`),
  );
  const refsBody = encodePktStream(refLines);
  const advertisement = new Uint8Array(header.length + refsBody.length);
  advertisement.set(header, 0);
  advertisement.set(refsBody, header.length);

  const channel1 = new Uint8Array(packBytes.length + 1);
  channel1[0] = 0x01;
  channel1.set(packBytes, 1);
  const packResponse = encodePktStream([ENCODER.encode('NAK\n'), channel1]);

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

describe('common-dir write sweep (writes ⇒ commonGitDir)', () => {
  describe('Given a worktree child Context', () => {
    describe('When writeObject writes a new blob', () => {
      it('Then the loose object lands under the common objects dir, not the admin dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);
        const blob: Blob = {
          type: 'blob',
          content: ENCODER.encode('commondir\n'),
          id: '' as ObjectId,
        };

        // Act
        const id = await writeObject(sut, blob);

        // Assert
        expect(await ctx.fs.exists(looseObjectPath(ctx.layout.gitDir, id))).toBe(true);
        expect(await ctx.fs.exists(looseObjectPath(adminDir(ctx), id))).toBe(false);
      });
    });

    describe('When updateConfigEntries writes an entry', () => {
      it('Then the config lands under the common dir, not the admin dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        await updateConfigEntries(sut, [{ section: 'core', key: 'foo', value: 'bar' }]);

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toContain('foo = bar');
        expect(await ctx.fs.exists(`${adminDir(ctx)}/config`)).toBe(false);
      });
    });

    describe('When updateConfigOperations applies a set op', () => {
      it('Then the config lands under the common dir, not the admin dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        await updateConfigOperations(sut, [
          { kind: 'set', section: 'core', key: 'foo', value: 'baz' },
        ]);

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toContain('foo = baz');
        expect(await ctx.fs.exists(`${adminDir(ctx)}/config`)).toBe(false);
      });
    });

    describe('When updateShallow adds a boundary', () => {
      it('Then .git/shallow lands under the common dir, not the admin dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);
        const oid = 'a'.repeat(40) as ObjectId;

        // Act
        await updateShallow(sut, { shallow: [oid], unshallow: [] });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(true);
        expect(await ctx.fs.exists(`${adminDir(ctx)}/shallow`)).toBe(false);
      });
    });

    describe('When pushStashRef pushes the first entry', () => {
      it('Then refs/stash lands under the common dir, not the admin dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);
        const w = 'b'.repeat(40) as ObjectId;

        // Act
        await pushStashRef(sut, w, 'WIP on main: commondir test');

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/stash`)).toBe(true);
        expect(await ctx.fs.exists(`${adminDir(ctx)}/refs/stash`)).toBe(false);
      });
    });

    describe('When resolveHooksDir has no hooksPath', () => {
      it('Then it falls back to the common hooks dir, not the admin one', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        const result = resolveHooksDir(undefined, sut.layout);

        // Assert
        expect(result).toBe(`${ctx.layout.gitDir}/hooks`);
      });
    });

    describe('When resolveHooksDir has an empty hooksPath', () => {
      it('Then the no-hooks sentinel resolves under the common dir, not the admin one', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        const result = resolveHooksDir('', sut.layout);

        // Assert
        expect(result).toBe(`${ctx.layout.gitDir}/${NO_HOOKS_SUBDIR}`);
      });
    });

    describe('When runHook dispatches to the runner', () => {
      it('Then the request gitDir stays the admin dir while hooksDir is the common one', async () => {
        // Arrange — hook LOOKUP is shared, hook GIT_DIR is per-worktree.
        const ctx = await buildSeededContext();
        await seedAdminHead(ctx);
        const runner = new MemoryHookRunner();
        const sut: Context = { ...asWorktreeChild(ctx), hooks: runner };

        // Act
        await runHook(sut, 'pre-commit');

        // Assert
        expect(runner.calls[0]?.gitDir).toBe(adminDir(ctx));
        expect(runner.calls[0]?.gitDir).not.toBe(ctx.layout.gitDir);
        expect(runner.calls[0]?.hooksDir).toBe(`${ctx.layout.gitDir}/hooks`);
      });
    });
  });

  describe('Given a worktree child Context with a shared branch and a decoy admin-dir branch', () => {
    describe('When branchList runs', () => {
      it('Then it lists the common branch and ignores the admin decoy', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const mainId = 'c'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${mainId}\n`);
        const sut = asWorktreeChild(ctx);
        const decoyId = 'd'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/heads/decoy`, `${decoyId}\n`);
        await seedAdminHead(ctx);

        // Act
        const result = await branchList(sut);

        // Assert
        expect(result.branches).toEqual([
          { name: 'refs/heads/main' as RefName, id: mainId, current: true },
        ]);
      });
    });
  });

  describe('Given a worktree child Context with a shared tag and a decoy admin-dir tag', () => {
    describe('When tagList runs', () => {
      it('Then it lists the common tag and ignores the admin decoy', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1Id = 'e'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${v1Id}\n`);
        const sut = asWorktreeChild(ctx);
        const decoyId = 'f'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/tags/decoy`, `${decoyId}\n`);
        await seedAdminHead(ctx);

        // Act
        const result = await tagList(sut);

        // Assert
        expect(result.tags).toEqual([{ name: 'refs/tags/v1' as RefName, id: v1Id }]);
      });
    });
  });

  describe('Given a worktree child Context whose promisor object already lives in the common objects dir', () => {
    describe('When fetchMissing runs (via the PromisorRemote port)', () => {
      it('Then the common-dir probe finds it locally with no network call', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oid = '1'.repeat(40) as ObjectId;
        await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, oid), new Uint8Array([1]));
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = https://example.com/r.git\n',
        );
        await seedAdminHead(ctx);
        const sut: Context = { ...asWorktreeChild(ctx), transport: forbiddenTransport() };

        // Act
        const result = await createPromisorRemote(sut).fetch([oid]);

        // Assert
        expect(result).toEqual({ attempted: true, requested: 1, fetched: 0 });
      });
    });
  });

  describe('Given a worktree child Context downloading a pack', () => {
    describe('When fetchPack writes the pack artifacts', () => {
      it('Then pack + idx land under the common objects/pack dir, not the admin dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: ENCODER.encode('commondir pack\n') },
        ]);
        const blobId = built.ids[0] as ObjectId;
        const channel1 = new Uint8Array(built.packBytes.length + 1);
        channel1[0] = 0x01;
        channel1.set(built.packBytes, 1);
        const body = encodePktStream([ENCODER.encode('NAK\n'), channel1]);
        const transport: HttpTransport = {
          request: async (): Promise<HttpResponse> => ({
            statusCode: 200,
            headers: {},
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(body.slice());
                controller.close();
              },
            }),
          }),
        };
        const toExchange =
          (t: HttpTransport): GitExchange =>
          async (requestBytes) => {
            const response = await t.request({
              url: 'https://remote.example/r.git/git-upload-pack',
              method: 'POST',
              headers: {
                'content-type': 'application/x-git-upload-pack-request',
                accept: 'application/x-git-upload-pack-result',
              },
              body: requestBytes,
            });
            return decodePktStream(readableStreamToAsyncIterable(response.body));
          };
        const negotiator: NegotiatePackBytes = (negCtx, input) =>
          negotiatePackBytes(negCtx, { exchange: toExchange(transport) }, 1, input);

        // Act
        const result = await fetchPack(sut, negotiator, {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k', 'ofs-delta'],
          progressOp: 'test:write-objects',
        });

        // Assert
        expect(result.packPath).toBe(
          `${ctx.layout.gitDir}/objects/pack/pack-${result.packSha}.pack`,
        );
        expect(await ctx.fs.exists(result.packPath)).toBe(true);
        expect(
          await ctx.fs.exists(`${adminDir(ctx)}/objects/pack/pack-${result.packSha}.pack`),
        ).toBe(false);
      });
    });
  });

  describe('Given a worktree child Context with a shared remote-tracking ref', () => {
    describe('When fetch derives haves', () => {
      it('Then loose dirs are read from the common dir, not the admin dir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { commitIds } = await seedRepo(ctx, { commits: [{ tree: 'a'.repeat(40) }] });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/refs/remotes/origin/main`,
          `${commitIds[0]}\n`,
        );
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://example.com/r.git\n',
        );
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: ENCODER.encode('commondir haves\n') },
        ]);
        const blobId = built.ids[0] as ObjectId;
        const { transport, requests } = fakeFetchRemote(
          [{ name: 'refs/heads/main', id: blobId }],
          built.packBytes,
        );
        const sut: Context = { ...asWorktreeChild(ctx), transport };
        await seedAdminHead(ctx);

        // Act
        await fetch(sut, {});

        // Assert
        const postReq = requests.find((r) => r.method === 'POST');
        const decoded = new TextDecoder().decode(postReq?.body);
        expect(decoded).toContain(`have ${commitIds[0]}`);
      });
    });
  });

  describe('Given a worktree child Context with a stale shared remote-tracking ref', () => {
    describe('When fetch runs with prune: true', () => {
      it('Then the stale ref is pruned from the common dir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const stale = 'f'.repeat(40) as ObjectId;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/feature-x`, `${stale}\n`);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://example.com/r.git\n',
        );
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: ENCODER.encode('commondir prune\n') },
        ]);
        const blobId = built.ids[0] as ObjectId;
        const { transport } = fakeFetchRemote(
          [{ name: 'refs/heads/main', id: blobId }],
          built.packBytes,
        );
        const sut: Context = { ...asWorktreeChild(ctx), transport };
        await seedAdminHead(ctx);

        // Act
        const result = await fetch(sut, { prune: true });

        // Assert
        expect(result.prunedRefs).toContain('refs/remotes/origin/feature-x' as RefName);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature-x`)).toBe(
          false,
        );
      });
    });
  });
});
