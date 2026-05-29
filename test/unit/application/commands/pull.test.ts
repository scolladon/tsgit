import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { abortMerge } from '../../../../src/application/commands/abort-merge.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { continueMerge } from '../../../../src/application/commands/continue-merge.js';
import { init } from '../../../../src/application/commands/init.js';
import { pull } from '../../../../src/application/commands/pull.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
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
import { buildSyntheticPack } from '../primitives/pack-fixture.js';

const REMOTE_URL = 'https://remote.example/r.git';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const commitFile = async (
  ctx: Context,
  path: string,
  content: string,
  message: string,
): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  await add(ctx, [path]);
  const result = await commit(ctx, { message, author });
  return result.id;
};

const emptyPack = async (ctx: Context): Promise<Uint8Array> =>
  (await buildSyntheticPack(ctx, [])).packBytes;

const streamOf = (body: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body.slice());
      controller.close();
    },
  });

/** Fake upload-pack remote advertising `refs` and serving `packBytes`. */
const buildPullRemote = (
  refs: ReadonlyArray<{ readonly name: string; readonly id: string }>,
  packBytes: Uint8Array,
): { transport: HttpTransport; requests: HttpRequest[] } => {
  const discoveryBody = buildDiscoveryBody({
    service: 'git-upload-pack',
    capabilities: ['side-band-64k', 'ofs-delta'],
    refs,
  });
  const packResponseBody = buildUploadPackResponseBody({ packBytes, sideBand: true, shallow: [] });
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      const body = req.url.includes('/info/refs') ? discoveryBody : packResponseBody;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: streamOf(body),
      };
    },
  };
  return { transport, requests };
};

const withTransport = (ctx: Context, transport: HttpTransport): Context => ({ ...ctx, transport });

const seedConfig = async (
  ctx: Context,
  opts: { readonly remote?: string; readonly url?: string; readonly upstream?: boolean },
): Promise<void> => {
  const remote = opts.remote ?? 'origin';
  await updateConfigEntries(ctx, [
    ...(opts.url !== undefined
      ? [{ section: 'remote', subsection: remote, key: 'url', value: opts.url }]
      : []),
    ...(opts.upstream === true
      ? [
          { section: 'branch', subsection: 'main', key: 'remote', value: remote },
          { section: 'branch', subsection: 'main', key: 'merge', value: 'refs/heads/main' },
        ]
      : []),
  ]);
};

const reflogMessages = async (ctx: Context, ref: string): Promise<ReadonlyArray<string>> =>
  (await readReflog(ctx, ref as RefName)).map((e) => e.message);

describe('pull', () => {
  describe('Given the remote advances the upstream branch', () => {
    describe('When pull with no arguments', () => {
      it('Then fast-forwards the current branch and reflogs "pull: Fast-forward"', async () => {
        // Arrange — main at A, B is A's child (present locally); remote advertises main → B.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { target: 'main' });
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport));

        // Assert
        expect(sut.merge.kind).toBe('fast-forward');
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(b);
        expect(await reflogMessages(ctx, 'refs/heads/main')).toContain('pull: Fast-forward');
        expect(
          sut.fetch.updatedRefs.some((u) => u.name === 'refs/remotes/origin/main' && u.newId === b),
        ).toBe(true);
      });
    });
  });

  describe('Given the remote is at the same commit as HEAD', () => {
    describe('When pull', () => {
      it('Then reports up-to-date', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport));

        // Assert
        expect(sut.merge.kind).toBe('up-to-date');
      });
    });
  });

  describe('Given diverged histories touching distinct files', () => {
    describe('When pull', () => {
      it('Then creates a merge commit with a git-faithful message and reflog', async () => {
        // Arrange — base A; feature adds b.txt (→ B); main adds c.txt (→ X); remote main → B.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { target: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport), { author });

        // Assert
        expect(sut.merge.kind).toBe('merge');
        if (sut.merge.kind === 'merge') {
          expect(sut.merge.parents).toHaveLength(2);
          const obj = await readObject(ctx, sut.merge.id);
          expect(obj.type).toBe('commit');
          if (obj.type === 'commit') {
            expect(obj.data.message).toBe(`Merge branch 'main' of ${REMOTE_URL}\n`);
          }
        }
        expect(await reflogMessages(ctx, 'refs/heads/main')).toContain(
          "pull: Merge made by the 'tsgit' strategy.",
        );
      });
    });
  });

  describe('Given diverged histories editing the same file', () => {
    describe('When pull', () => {
      it('Then leaves conflict state that abortMerge can recover', async () => {
        // Arrange — both sides edit a.txt; remote main → B.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'base\n', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'a.txt', 'theirs\n', 'B');
        await checkout(ctx, { target: 'main' });
        const x = await commitFile(ctx, 'a.txt', 'ours\n', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport), { author });

        // Assert — conflict state persisted, then abortMerge restores ORIG_HEAD.
        expect(sut.merge.kind).toBe('conflict');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(true);
        await abortMerge(ctx);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(x);
      });
    });
  });

  describe('Given a pull conflict resolved by the caller', () => {
    describe('When continueMerge finalises it', () => {
      it('Then a two-parent merge commit is produced (20.4 state machine composes)', async () => {
        // Arrange — diverged same-path edits → pull conflict.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'base\n', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'a.txt', 'theirs\n', 'B');
        await checkout(ctx, { target: 'main' });
        const x = await commitFile(ctx, 'a.txt', 'ours\n', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );
        const conflicted = await pull(withTransport(ctx, transport), { author });
        expect(conflicted.merge.kind).toBe('conflict');

        // Act — resolve the file, stage it, and continue.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'resolved\n');
        await add(ctx, ['a.txt']);
        const result = await continueMerge(ctx, { message: 'resolve pull', author });

        // Assert — the merge commit has both ours (X) and theirs (B) as parents.
        const obj = await readObject(ctx, result.id);
        expect(obj.type).toBe('commit');
        if (obj.type === 'commit') {
          expect(obj.data.parents).toEqual([x, b]);
        }
      });
    });
  });

  describe('Given explicit remote and branch arguments', () => {
    describe('When pull', () => {
      it('Then fetches that remote and merges refs/remotes/<remote>/<branch>', async () => {
        // Arrange — upstream remote named "upstream", no branch config.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { target: 'main' });
        await seedConfig(ctx, { remote: 'upstream', url: REMOTE_URL });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport), {
          remote: 'upstream',
          branch: 'main',
        });

        // Assert
        expect(sut.merge.kind).toBe('fast-forward');
        expect(await resolveRef(ctx, 'refs/remotes/upstream/main' as RefName)).toBe(b);
      });
    });
  });

  describe('Given branch.<cur>.merge set but no branch.<cur>.remote', () => {
    describe('When pull', () => {
      it('Then the remote defaults to origin', async () => {
        // Arrange — only the merge ref is configured; origin URL is present.
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await updateConfigEntries(ctx, [
          { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
          { section: 'branch', subsection: 'main', key: 'merge', value: 'refs/heads/main' },
        ]);
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport));

        // Assert
        expect(sut.fetch.remote).toBe('origin');
        expect(sut.merge.kind).toBe('up-to-date');
      });
    });
  });

  describe('Given no upstream configuration and no explicit branch', () => {
    describe('When pull', () => {
      it('Then throws NO_UPSTREAM_CONFIGURED for the current branch', async () => {
        // Arrange — origin URL only; no branch.main.merge.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await seedConfig(ctx, { url: REMOTE_URL });
        const { transport, requests } = buildPullRemote([], await emptyPack(ctx));

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert — failure before any network round-trip.
        expect((caught as { data?: { code?: string; branch?: string } })?.data?.code).toBe(
          'NO_UPSTREAM_CONFIGURED',
        );
        expect((caught as { data?: { branch?: string } })?.data?.branch).toBe('refs/heads/main');
        expect(requests).toHaveLength(0);
      });
    });
  });

  describe('Given a detached HEAD and no explicit branch', () => {
    describe('When pull', () => {
      it('Then throws NO_UPSTREAM_CONFIGURED naming HEAD', async () => {
        // Arrange — detach HEAD onto the commit oid.
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${a}\n`);
        await seedConfig(ctx, { url: REMOTE_URL });
        const { transport } = buildPullRemote([], await emptyPack(ctx));

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NO_UPSTREAM_CONFIGURED');
        expect((caught as { data?: { branch?: string } })?.data?.branch).toBe('HEAD');
      });
    });
  });

  describe('Given a bare repository', () => {
    describe('When pull', () => {
      it('Then throws before issuing any fetch', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await updateConfigEntries(ctx, [
          { section: 'core', key: 'bare', value: 'true' },
          { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
        ]);
        const { transport, requests } = buildPullRemote([], await emptyPack(ctx));

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport), { branch: 'main' });
        } catch (err) {
          caught = err;
        }

        // Assert — the guard names the `pull` operation and fires before any fetch.
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('BARE_REPOSITORY');
        expect((caught as { data?: { operation?: string } })?.data?.operation).toBe('pull');
        expect(requests).toHaveLength(0);
      });
    });
  });

  describe('Given an in-progress merge (MERGE_HEAD present)', () => {
    describe('When pull', () => {
      it('Then throws OPERATION_IN_PROGRESS before issuing any fetch', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${a}\n`);
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport, requests } = buildPullRemote([], await emptyPack(ctx));

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('OPERATION_IN_PROGRESS');
        expect(requests).toHaveLength(0);
      });
    });
  });

  describe('Given the remote does not advertise the requested branch', () => {
    describe('When pull', () => {
      it('Then throws REF_NOT_FOUND for the missing tracking ref', async () => {
        // Arrange — remote advertises main, but the caller asks for "nope".
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await seedConfig(ctx, { url: REMOTE_URL });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport), { branch: 'nope' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given diverged histories and fastForwardOnly', () => {
    describe('When pull', () => {
      it('Then propagates NON_FAST_FORWARD from merge', async () => {
        // Arrange — divergence forces a true merge, which ff-only rejects.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { target: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport), { fastForwardOnly: true, author });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NON_FAST_FORWARD');
      });
    });
  });

  describe('Given a custom merge message', () => {
    describe('When pull over a true merge', () => {
      it('Then the merge commit uses the supplied message', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { target: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport), {
          message: 'custom pull message',
          author,
        });

        // Assert
        expect(sut.merge.kind).toBe('merge');
        if (sut.merge.kind === 'merge') {
          const obj = await readObject(ctx, sut.merge.id);
          if (obj.type === 'commit') {
            expect(obj.data.message).toBe('custom pull message\n');
          }
        }
      });
    });
  });

  describe('Given a depth argument', () => {
    describe('When pull', () => {
      it('Then forwards a deepen request to the fetch step', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport, requests } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        await pull(withTransport(ctx, transport), { depth: 1 });

        // Assert — the upload-pack POST body carries `deepen 1`.
        const post = requests.find((r) => r.method === 'POST' && !r.url.includes('/info/refs'));
        const decoded = new TextDecoder().decode(post?.body);
        expect(decoded).toContain('deepen 1');
      });
    });
  });

  describe('Given prune', () => {
    describe('When pull', () => {
      it('Then forwards prune to the fetch step (stale remote-tracking ref removed)', async () => {
        // Arrange — a stale origin ref the advertisement no longer carries.
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await updateRef(ctx, 'refs/remotes/origin/stale' as RefName, a, { reflogMessage: 'seed' });
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport), { prune: true });

        // Assert
        expect(sut.fetch.prunedRefs).toContain('refs/remotes/origin/stale');
      });
    });
  });

  describe('Given noFastForward over a history that would fast-forward', () => {
    describe('When pull', () => {
      it('Then forwards noFastForward to merge (forces a merge commit)', async () => {
        // Arrange — main at A, B is A's child; remote main → B would fast-forward.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { target: 'main' });
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport), { noFastForward: true, author });

        // Assert — a true merge commit, not a fast-forward.
        expect(sut.merge.kind).toBe('merge');
      });
    });
  });

  describe('Given a distinct committer', () => {
    describe('When pull over a true merge', () => {
      it('Then forwards the committer to the merge commit', async () => {
        // Arrange — diverged distinct files → true merge.
        const committer: AuthorIdentity = {
          name: 'Bob',
          email: 'bob@example.com',
          timestamp: 1_700_000_500,
          timezoneOffset: '+0000',
        };
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { target: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const sut = await pull(withTransport(ctx, transport), { author, committer });

        // Assert
        expect(sut.merge.kind).toBe('merge');
        if (sut.merge.kind === 'merge') {
          const obj = await readObject(ctx, sut.merge.id);
          if (obj.type === 'commit') {
            expect(obj.data.committer.name).toBe('Bob');
          }
        }
      });
    });
  });
});
