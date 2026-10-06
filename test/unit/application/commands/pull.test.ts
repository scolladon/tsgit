import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { mergeAbort } from '../../../../src/application/commands/abort-merge.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { mergeContinue } from '../../../../src/application/commands/continue-merge.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { pull } from '../../../../src/application/commands/pull.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { mergedPull } from '../../../fixtures/merged-pull.js';
import {
  buildDiscoveryBody,
  buildUploadPackResponseBody,
} from '../../../fixtures/transport/builders.js';
import { buildSyntheticPack } from '../primitives/pack-fixture.js';
import { asBareContext } from './fixtures.js';

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
      ? [
          { section: 'remote', subsection: remote, key: 'url', value: opts.url },
          {
            section: 'remote',
            subsection: remote,
            key: 'fetch',
            value: `+refs/heads/*:refs/remotes/${remote}/*`,
          },
        ]
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
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const result = mergedPull(await pull(withTransport(ctx, transport)));

        // Assert
        expect(result.merge.kind).toBe('fast-forward');
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(b);
        expect(await reflogMessages(ctx, 'refs/heads/main')).toContain('pull: Fast-forward');
        expect(
          result.fetch.updatedRefs.some(
            (u) => u.name === 'refs/remotes/origin/main' && u.newId === b,
          ),
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
        const result = mergedPull(await pull(withTransport(ctx, transport)));

        // Assert
        expect(result.merge.kind).toBe('up-to-date');
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
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const result = mergedPull(
          await pull(withTransport(ctx, transport), { rebase: false, author }),
        );

        // Assert
        expect(result.merge.kind).toBe('merge');
        if (result.merge.kind === 'merge') {
          expect(result.merge.parents).toHaveLength(2);
          const obj = await readObject(ctx, result.merge.id);
          expect(obj.type).toBe('commit');
          if (obj.type === 'commit') {
            expect(obj.data.message).toBe("Merge branch 'main' of https://remote.example/r\n");
          }
        }
        expect(await reflogMessages(ctx, 'refs/heads/main')).toContain(
          "pull: Merge made by the 'ort' strategy.",
        );
      });
    });
  });

  describe('Given diverged histories editing the same file', () => {
    describe('When pull', () => {
      it('Then leaves conflict state that mergeAbort can recover', async () => {
        // Arrange — both sides edit a.txt; remote main → B.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'base\n', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'a.txt', 'theirs\n', 'B');
        await checkout(ctx, { rev: 'main' });
        const x = await commitFile(ctx, 'a.txt', 'ours\n', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const result = mergedPull(
          await pull(withTransport(ctx, transport), { rebase: false, author }),
        );

        // Assert — conflict state persisted, then mergeAbort restores ORIG_HEAD.
        expect(result.merge.kind).toBe('conflict');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(true);
        await mergeAbort(ctx);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(x);
      });
    });
  });

  describe('Given a pull conflict resolved by the caller', () => {
    describe('When mergeContinue finalises it', () => {
      it('Then a two-parent merge commit is produced (20.4 state machine composes)', async () => {
        // Arrange — diverged same-path edits → pull conflict.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'base\n', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'a.txt', 'theirs\n', 'B');
        await checkout(ctx, { rev: 'main' });
        const x = await commitFile(ctx, 'a.txt', 'ours\n', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );
        const conflicted = mergedPull(
          await pull(withTransport(ctx, transport), { rebase: false, author }),
        );
        expect(conflicted.merge.kind).toBe('conflict');

        // Act — resolve the file, stage it, and continue.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'resolved\n');
        await add(ctx, ['a.txt']);
        const result = await mergeContinue(ctx, { message: 'resolve pull', author });

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
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await seedConfig(ctx, { remote: 'upstream', url: REMOTE_URL });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const result = mergedPull(
          await pull(withTransport(ctx, transport), {
            remote: 'upstream',
            ref: 'main',
          }),
        );

        // Assert
        expect(result.merge.kind).toBe('fast-forward');
        expect(await resolveRef(ctx, 'refs/remotes/upstream/main' as RefName)).toBe(b);
      });
    });
  });

  describe('Given a refspec writing the checked-out branch', () => {
    describe('When pull', () => {
      it('Then its fetch may update the branch, as git pull passes --update-head-ok', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await seedConfig(ctx, { url: REMOTE_URL });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );
        const sut = pull;

        // Act
        const result = await sut(withTransport(ctx, transport), {
          remote: 'origin',
          ref: 'main:main',
        });

        // Assert
        const branch = result.fetch.updatedRefs.find((u) => u.name === 'refs/heads/main');
        expect(branch).toMatchObject({ status: 'ok', newId: b });
      });
    });

    describe('When pull moves the branch under the working tree', () => {
      it('Then it warns and fast-forwards the index and working tree from the old head', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await seedConfig(ctx, { url: REMOTE_URL });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );
        const warnings: string[] = [];
        const logger = { warn: (message: string) => warnings.push(message) };
        const sut = pull;

        // Act
        const result = mergedPull(
          await sut(
            { ...withTransport(ctx, transport), logger },
            { remote: 'origin', ref: 'main:main' },
          ),
        );

        // Assert
        expect(warnings).toContain(
          `fetch updated the current branch head.\nfast-forwarding your working tree from\ncommit ${a}.`,
        );
        expect(result.merge.kind).toBe('up-to-date');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/b.txt`)).toBe('b');
        const index = await readIndex(ctx);
        expect(index.entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt']);
      });
    });

    describe('When pull fetches into the unborn checked-out branch', () => {
      it('Then no head-update warning is given, as nothing was checked out', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/fresh\n');
        await seedConfig(ctx, { url: REMOTE_URL });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );
        const warnings: string[] = [];
        const logger = { warn: (message: string) => warnings.push(message) };
        const sut = pull;

        // Act
        await sut(
          { ...withTransport(ctx, transport), logger },
          { remote: 'origin', ref: 'main:fresh' },
        );

        // Assert
        expect(warnings.filter((w) => w.startsWith('fetch updated'))).toEqual([]);
        expect(await resolveRef(ctx, 'refs/heads/fresh' as RefName)).toBe(b);
      });
    });
  });

  describe('Given branch.<cur>.merge set but no branch.<cur>.remote', () => {
    describe('When pull', () => {
      it('Then origin is fetched and the pull refuses, as git ignores a merge without a remote', async () => {
        // Arrange — only the merge ref is configured; origin URL is present.
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await updateConfigEntries(ctx, [
          { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
          {
            section: 'remote',
            subsection: 'origin',
            key: 'fetch',
            value: '+refs/heads/*:refs/remotes/origin/*',
          },
          { section: 'branch', subsection: 'main', key: 'merge', value: 'refs/heads/main' },
        ]);
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: unknown }).data).toEqual({
          code: 'NO_UPSTREAM_CONFIGURED',
          branch: 'refs/heads/main',
        });
        expect(await resolveRef(ctx, 'refs/remotes/origin/main' as RefName)).toBe(a);
      });
    });
  });

  describe('Given branch.<cur>.merge set, no branch.<cur>.remote, and exactly one non-origin remote configured', () => {
    describe('When pull', () => {
      it('Then solo is fetched and the pull refuses, as git ignores a merge without a remote', async () => {
        // Arrange — only the merge ref is configured; "solo" is the only remote.
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await updateConfigEntries(ctx, [
          { section: 'remote', subsection: 'solo', key: 'url', value: REMOTE_URL },
          {
            section: 'remote',
            subsection: 'solo',
            key: 'fetch',
            value: '+refs/heads/*:refs/remotes/solo/*',
          },
          { section: 'branch', subsection: 'main', key: 'merge', value: 'refs/heads/main' },
        ]);
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: unknown }).data).toEqual({
          code: 'NO_UPSTREAM_CONFIGURED',
          branch: 'refs/heads/main',
        });
        expect(await resolveRef(ctx, 'refs/remotes/solo/main' as RefName)).toBe(a);
      });
    });
  });

  describe('Given no upstream configuration and no explicit branch', () => {
    describe('When pull', () => {
      it('Then throws NO_UPSTREAM_CONFIGURED for the current branch', async () => {
        // Arrange — origin URL only; no branch.main.merge.
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await seedConfig(ctx, { url: REMOTE_URL });
        const { transport, requests } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert — git fetches first, then finds nothing to merge.
        expect((caught as { data?: { code?: string; branch?: string } })?.data?.code).toBe(
          'NO_UPSTREAM_CONFIGURED',
        );
        expect((caught as { data?: { branch?: string } })?.data?.branch).toBe('refs/heads/main');
        expect(requests.length).toBeGreaterThan(0);
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
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

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

  describe('Given a detached HEAD and a sectionless [branch] valueless remote', () => {
    describe('When pull', () => {
      it('Then skips the branch guard, throwing NO_UPSTREAM_CONFIGURED not CONFIG_MISSING_VALUE', async () => {
        // Arrange — detached HEAD (no current branch); a sectionless `[branch]`
        // holds a valueless `remote`. The guard is gated on a current branch, so a
        // detached HEAD must never read `[branch]` config for the valueless check.
        const ctx = createMemoryContext();
        await init(ctx);
        const a = await commitFile(ctx, 'a.txt', 'a', 'A');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${a}\n`);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          `[remote "origin"]\n\turl = ${REMOTE_URL}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch]\n\tremote\n`,
        );
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: a }],
          await emptyPack(ctx),
        );

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert
        const code = (caught as { data?: { code?: string } })?.data?.code;
        expect(code).toBe('NO_UPSTREAM_CONFIGURED');
        expect(code).not.toBe('CONFIG_MISSING_VALUE');
      });
    });
  });

  describe('Given a bare repository', () => {
    describe('When pull', () => {
      it('Then throws before issuing any fetch', async () => {
        // Arrange
        const ctx0 = createMemoryContext();
        await init(ctx0);
        await commitFile(ctx0, 'a.txt', 'a', 'A');
        await updateConfigEntries(ctx0, [
          { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
        ]);
        const ctx = asBareContext(ctx0);
        const { transport, requests } = buildPullRemote([], await emptyPack(ctx0));

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport), { ref: 'main' });
        } catch (err) {
          caught = err;
        }

        // Assert — the guard names the `pull` operation and fires before any fetch.
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('WORK_TREE_REQUIRED');
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
      it('Then the fetch refuses the missing remote ref', async () => {
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
          await pull(withTransport(ctx, transport), { ref: 'nope' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REMOTE_REF_NOT_FOUND');
      });
    });
  });

  describe("Given diverged histories and fastForward='only'", () => {
    describe('When pull', () => {
      it('Then propagates NON_FAST_FORWARD from merge', async () => {
        // Arrange — divergence forces a true merge, which ff-only rejects.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport), { fastForward: 'only', author });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NON_FAST_FORWARD');
      });
    });
  });

  describe('Given the remote branch shares no history with HEAD', () => {
    /** Local `main` holds `a.txt`; the remote's `main` is a root commit of its own. */
    const seedUnrelated = async (): Promise<{ ctx: Context; head: ObjectId; orphan: ObjectId }> => {
      const ctx = createMemoryContext();
      await init(ctx);
      const head = await commitFile(ctx, 'a.txt', 'a', 'A');
      const tree = await writeTree(ctx, []);
      const orphan = await writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: { tree, parents: [], author, committer: author, message: 'O\n', extraHeaders: [] },
      });
      await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
      const { transport } = buildPullRemote(
        [{ name: 'refs/heads/main', id: orphan }],
        await emptyPack(ctx),
      );
      return { ctx: withTransport(ctx, transport), head, orphan };
    };

    describe('When pull', () => {
      it('Then it refuses with UNRELATED_HISTORIES', async () => {
        // Arrange
        const { ctx } = await seedUnrelated();
        const sut = pull;

        // Act
        const result = await sut(ctx, { rebase: false, author }).catch((error: unknown) => error);

        // Assert
        expect((result as TsgitError).data).toEqual({ code: 'UNRELATED_HISTORIES' });
      });
    });

    describe('When pull allows unrelated histories', () => {
      it('Then it records a merge of both roots', async () => {
        // Arrange
        const { ctx, head, orphan } = await seedUnrelated();
        const sut = pull;

        // Act
        const result = mergedPull(
          await sut(ctx, { rebase: false, allowUnrelatedHistories: true, author }),
        );

        // Assert
        expect(result.merge).toMatchObject({ kind: 'merge', parents: [head, orphan] });
      });
    });

    describe('When pull only fast-forwards', () => {
      it('Then it refuses with NON_FAST_FORWARD before merging', async () => {
        // Arrange
        const { ctx, head, orphan } = await seedUnrelated();
        const sut = pull;

        // Act
        const result = await sut(ctx, { fastForward: 'only', author }).catch(
          (error: unknown) => error,
        );

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'NON_FAST_FORWARD',
          ref: 'refs/heads/main',
          local: head,
          remote: orphan,
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
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
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const result = mergedPull(
          await pull(withTransport(ctx, transport), {
            rebase: false,
            message: 'custom pull message',
            author,
          }),
        );

        // Assert
        expect(result.merge.kind).toBe('merge');
        if (result.merge.kind === 'merge') {
          const obj = await readObject(ctx, result.merge.id);
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
        const result = await pull(withTransport(ctx, transport), { prune: true });

        // Assert
        expect(result.fetch.prunedRefs).toContain('refs/remotes/origin/stale');
      });
    });
  });

  describe("Given fastForward='never' over a history that would fast-forward", () => {
    describe('When pull', () => {
      it('Then forwards fastForward to merge (forces a merge commit)', async () => {
        // Arrange — main at A, B is A's child; remote main → B would fast-forward.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const result = mergedPull(
          await pull(withTransport(ctx, transport), { fastForward: 'never', author }),
        );

        // Assert — a true merge commit, not a fast-forward.
        expect(result.merge.kind).toBe('merge');
      });
    });
  });

  const seedValuelessUpstream = async (ctx: Context, config: string): Promise<void> => {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  };

  const pullData = async (
    ctx: Context,
  ): Promise<{ code?: string; key?: string; line?: number; source?: string }> => {
    try {
      await pull(ctx);
    } catch (err) {
      return (err as { data?: { code?: string; key?: string; line?: number; source?: string } })
        .data as { code?: string; key?: string; line?: number; source?: string };
    }
    return {};
  };

  describe('Given branch.main.remote is present-but-valueless', () => {
    describe('When pull resolves the upstream', () => {
      it('Then throws CONFIG_MISSING_VALUE for branch.main.remote at its line', async () => {
        // Arrange — remote valueless at line 2; merge valued at line 3.
        const ctx = createMemoryContext();
        await init(ctx);
        await seedValuelessUpstream(ctx, '[branch "main"]\n\tremote\n\tmerge = refs/heads/main\n');

        // Act
        const result = await pullData(ctx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('branch.main.remote');
        expect(result.line).toBe(2);
        expect(result.source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given branch.main.merge is present-but-valueless', () => {
    describe('When pull resolves the upstream', () => {
      it('Then throws CONFIG_MISSING_VALUE for branch.main.merge at its line', async () => {
        // Arrange — remote valued at line 2; merge valueless at line 3.
        const ctx = createMemoryContext();
        await init(ctx);
        await seedValuelessUpstream(ctx, '[branch "main"]\n\tremote = origin\n\tmerge\n');

        // Act
        const result = await pullData(ctx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('branch.main.merge');
        expect(result.line).toBe(3);
      });
    });
  });

  describe('Given both branch.main.remote and merge valueless with remote earlier', () => {
    describe('When pull resolves the upstream', () => {
      it('Then reports the earlier-by-line key branch.main.remote', async () => {
        // Arrange — remote valueless at line 2, merge valueless at line 3.
        const ctx = createMemoryContext();
        await init(ctx);
        await seedValuelessUpstream(ctx, '[branch "main"]\n\tremote\n\tmerge\n');

        // Act
        const result = await pullData(ctx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('branch.main.remote');
        expect(result.line).toBe(2);
      });
    });
  });

  describe('Given both branch.main.remote and merge valueless with merge earlier', () => {
    describe('When pull resolves the upstream', () => {
      it('Then reports the earlier-by-line key branch.main.merge', async () => {
        // Arrange — merge valueless at line 2, remote valueless at line 3.
        const ctx = createMemoryContext();
        await init(ctx);
        await seedValuelessUpstream(ctx, '[branch "main"]\n\tmerge\n\tremote\n');

        // Act
        const result = await pullData(ctx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('branch.main.merge');
        expect(result.line).toBe(2);
      });
    });
  });

  describe('Given branch.main.remote and merge both valued', () => {
    describe('When pull resolves the upstream', () => {
      it('Then does not throw CONFIG_MISSING_VALUE (the guard no-ops)', async () => {
        // Arrange — both keys valued; no remote tip exists so a downstream error follows.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await seedValuelessUpstream(
          ctx,
          '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
        );
        const { transport } = buildPullRemote([], await emptyPack(ctx));

        // Act
        let caught: unknown;
        try {
          await pull(withTransport(ctx, transport));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).not.toBe(
          'CONFIG_MISSING_VALUE',
        );
      });
    });
  });

  describe('Given no branch.main section (absent upstream)', () => {
    describe('When pull resolves the upstream', () => {
      it('Then the fetch refuses the unconfigured remote, not CONFIG_MISSING_VALUE', async () => {
        // Arrange — config with no [branch "main"] section.
        const ctx = createMemoryContext();
        await init(ctx);
        await seedValuelessUpstream(ctx, '[core]\n\trepositoryformatversion = 0\n');

        // Act
        const result = await pullData(ctx);

        // Assert
        expect(result.code).toBe('REMOTE_NOT_CONFIGURED');
        expect(result.code).not.toBe('CONFIG_MISSING_VALUE');
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
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'c.txt', 'c', 'X');
        await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );

        // Act
        const result = mergedPull(
          await pull(withTransport(ctx, transport), { rebase: false, author, committer }),
        );

        // Assert
        expect(result.merge.kind).toBe('merge');
        if (result.merge.kind === 'merge') {
          const obj = await readObject(ctx, result.merge.id);
          if (obj.type === 'commit') {
            expect(obj.data.committer.name).toBe('Bob');
          }
        }
      });
    });
  });

  describe('pull merges what FETCH_HEAD marks for merging', () => {
    const divergedRepo = async () => {
      const ctx = createMemoryContext();
      await init(ctx);
      await commitFile(ctx, 'a.txt', 'a', 'A');
      await branchCreate(ctx, { name: 'side' });
      await checkout(ctx, { rev: 'side' });
      const b = await commitFile(ctx, 'b.txt', 'b', 'B');
      await checkout(ctx, { rev: 'main' });
      await commitFile(ctx, 'c.txt', 'c', 'X');
      return { ctx, b };
    };
    const remoteEntries = (fetch: string) => [
      { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
      { section: 'remote', subsection: 'origin', key: 'fetch', value: fetch },
    ];
    const upstream = (branch: string, remote: string, merge: string) => [
      { section: 'branch', subsection: branch, key: 'remote', value: remote },
      { section: 'branch', subsection: branch, key: 'merge', value: merge },
    ];
    const ORIGIN_FETCH = '+refs/heads/*:refs/remotes/origin/*';
    const refusal = async (ctx: Context, opts: Parameters<typeof pull>[1] = {}) => {
      try {
        await pull(ctx, opts);
      } catch (error) {
        return (error as { data?: unknown }).data;
      }
      return undefined;
    };

    describe('Given an upstream whose refspec stores it outside refs/remotes/<remote>/', () => {
      describe('When pull', () => {
        it('Then the fetched upstream tip is merged', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          await updateConfigEntries(ctx, [
            ...remoteEntries('+refs/heads/*:refs/remotes/mirror/*'),
            ...upstream('main', 'origin', 'refs/heads/side'),
          ]);
          const { transport } = buildPullRemote(
            [{ name: 'refs/heads/side', id: b }],
            await emptyPack(ctx),
          );
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), { rebase: false, author }),
          );

          // Assert
          expect(result.merge.kind).toBe('merge');
          if (result.merge.kind === 'merge') {
            expect(result.merge.parents[1]).toBe(b);
            const obj = await readObject(ctx, result.merge.id);
            expect(obj.type === 'commit' && obj.data.message).toBe(
              "Merge branch 'side' of https://remote.example/r\n",
            );
          }
        });
      });
    });

    describe('Given a branch other than main or master pulling its upstream', () => {
      describe('When pull', () => {
        it('Then the merge message names the branch merged into', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          await branchCreate(ctx, { name: 'feat' });
          await checkout(ctx, { rev: 'feat' });
          await updateConfigEntries(ctx, [
            ...remoteEntries(ORIGIN_FETCH),
            ...upstream('feat', 'origin', 'refs/heads/side'),
          ]);
          const { transport } = buildPullRemote(
            [{ name: 'refs/heads/side', id: b }],
            await emptyPack(ctx),
          );
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), { rebase: false, author }),
          );

          // Assert
          const id = result.merge.kind === 'merge' ? result.merge.id : b;
          const obj = await readObject(ctx, id);
          expect(obj.type === 'commit' && obj.data.message).toBe(
            "Merge branch 'side' of https://remote.example/r into feat\n",
          );
        });
      });
    });

    describe('Given merge.suppressDest matching the branch pulled into', () => {
      describe('When pull', () => {
        it('Then the merge message leaves the destination out', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          await branchCreate(ctx, { name: 'feat' });
          await checkout(ctx, { rev: 'feat' });
          await updateConfigEntries(ctx, [
            ...remoteEntries(ORIGIN_FETCH),
            ...upstream('feat', 'origin', 'refs/heads/side'),
            { section: 'merge', key: 'suppressDest', value: 'fe*' },
          ]);
          const { transport } = buildPullRemote(
            [{ name: 'refs/heads/side', id: b }],
            await emptyPack(ctx),
          );
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), { rebase: false, author }),
          );

          // Assert
          const id = result.merge.kind === 'merge' ? result.merge.id : b;
          const obj = await readObject(ctx, id);
          expect(obj.type === 'commit' && obj.data.message).toBe(
            "Merge branch 'side' of https://remote.example/r\n",
          );
        });
      });
    });

    describe('Given a remote with no fetch refspec', () => {
      describe('When pull from it', () => {
        it("Then the remote's HEAD is merged under the url alone", async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          await updateConfigEntries(ctx, [
            { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
          ]);
          const { transport } = buildPullRemote([{ name: 'HEAD', id: b }], await emptyPack(ctx));
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), { rebase: false, remote: 'origin', author }),
          );

          // Assert
          const id = result.merge.kind === 'merge' ? result.merge.id : b;
          const obj = await readObject(ctx, id);
          expect(obj.type === 'commit' && obj.data.message).toBe(
            'Merge https://remote.example/r\n',
          );
        });
      });
    });

    describe('Given a pull of an explicit ref outside heads, tags and remotes', () => {
      describe('When pull', () => {
        it('Then the merge message names it a commit', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const { transport } = buildPullRemote(
            [{ name: 'refs/notes/n', id: b }],
            await emptyPack(ctx),
          );
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), {
              rebase: false,
              ref: 'refs/notes/n',
              author,
            }),
          );

          // Assert
          const id = result.merge.kind === 'merge' ? result.merge.id : b;
          const obj = await readObject(ctx, id);
          expect(obj.type === 'commit' && obj.data.message).toBe(
            "Merge commit 'refs/notes/n' of https://remote.example/r\n",
          );
        });
      });
    });

    describe('Given a detached HEAD pulling an explicit ref', () => {
      describe('When pull', () => {
        it('Then HEAD stays detached at a merge titled into HEAD', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          const head = await resolveRef(ctx, 'refs/heads/main' as RefName);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${head}\n`);
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const { transport } = buildPullRemote(
            [{ name: 'refs/heads/side', id: b }],
            await emptyPack(ctx),
          );
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), { rebase: false, ref: 'side', author }),
          );

          // Assert
          expect(result.merge).toMatchObject({
            kind: 'merge',
            branch: undefined,
            parents: [head, b],
          });
          const id = result.merge.kind === 'merge' ? result.merge.id : b;
          const obj = await readObject(ctx, id);
          expect(obj.type === 'commit' && obj.data.message).toBe(
            "Merge branch 'side' of https://remote.example/r into HEAD\n",
          );
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe(`${id}\n`);
        });
      });
    });

    describe('Given a detached HEAD pulling a diverged ref fast-forward only', () => {
      describe('When pull', () => {
        it('Then it refuses with NON_FAST_FORWARD against HEAD before merging', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          const head = await resolveRef(ctx, 'refs/heads/main' as RefName);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${head}\n`);
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const { transport } = buildPullRemote(
            [{ name: 'refs/heads/side', id: b }],
            await emptyPack(ctx),
          );
          const sut = refusal;

          // Act
          const result = await sut(withTransport(ctx, transport), {
            ref: 'side',
            fastForward: 'only',
            author,
          });

          // Assert
          expect(result).toEqual({ code: 'NON_FAST_FORWARD', ref: 'HEAD', local: head, remote: b });
        });
      });
    });

    describe('Given an explicit ref fetching a ref HEAD already contains alongside a diverged one', () => {
      describe('When pull', () => {
        it('Then the message names only the ref that survives reduce_heads, as git does', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          const head = await readObject(ctx, await resolveRef(ctx, 'refs/heads/main' as RefName));
          const contained = head.type === 'commit' ? head.data.parents[0]! : b;
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const { transport } = buildPullRemote(
            [
              { name: 'refs/heads/side-a', id: contained },
              { name: 'refs/heads/side-b', id: b },
            ],
            await emptyPack(ctx),
          );
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), {
              rebase: false,
              ref: 'refs/heads/side-*:refs/remotes/s/*',
              author,
            }),
          );

          // Assert
          const id = result.merge.kind === 'merge' ? result.merge.id : b;
          const obj = await readObject(ctx, id);
          expect(obj.type === 'commit' && obj.data.message).toBe(
            "Merge branch 'side-b' of https://remote.example/r\n",
          );
        });
      });
    });

    describe('Given an explicit ref fetching two refs at one tip for merging', () => {
      describe('When pull', () => {
        it('Then the repeated tip is merged once, the message naming both refs as git does', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          const head = await resolveRef(ctx, 'refs/heads/main' as RefName);
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const { transport } = buildPullRemote(
            [
              { name: 'refs/heads/side-a', id: b },
              { name: 'refs/heads/side-b', id: b },
            ],
            await emptyPack(ctx),
          );
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), {
              rebase: false,
              ref: 'refs/heads/side-*:refs/remotes/s/*',
              author,
            }),
          );

          // Assert
          const merged = result.merge.kind === 'merge' ? result.merge : undefined;
          expect(merged?.parents).toEqual([head, b]);
          const obj = await readObject(ctx, merged?.id ?? b);
          expect(obj.type === 'commit' && obj.data.message).toBe(
            "Merge branches 'side-a' and 'side-b' of https://remote.example/r\n",
          );
        });
      });
    });

    /** `main`'s parent `A`, `main` itself, a child of `main`, and the diverged `side`. */
    const fastForwardRepo = async () => {
      const { ctx, b } = await divergedRepo();
      const head = await resolveRef(ctx, 'refs/heads/main' as RefName);
      const headCommit = await readObject(ctx, head);
      const parent = headCommit.type === 'commit' ? headCommit.data.parents[0]! : head;
      await branchCreate(ctx, { name: 'ahead' });
      await checkout(ctx, { rev: 'ahead' });
      const child = await commitFile(ctx, 'd.txt', 'd', 'D');
      await checkout(ctx, { rev: 'main' });
      return { ctx, tips: { parent, head, child, side: b } };
    };

    describe.each([
      { label: 'a head HEAD fast-forwards to', heads: ['child'], kind: 'fast-forward' },
      { label: 'a head HEAD already contains', heads: ['parent'], kind: 'up-to-date' },
    ] as const)('Given fastForward only and $label', ({ heads, kind }) => {
      describe('When pull', () => {
        it('Then the merge goes ahead', async () => {
          // Arrange
          const { ctx, tips } = await fastForwardRepo();
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const refs = heads.map((tip, at) => ({ name: `refs/heads/s${at}`, id: tips[tip] }));
          const { transport } = buildPullRemote(refs, await emptyPack(ctx));
          const sut = pull;

          // Act
          const result = mergedPull(
            await sut(withTransport(ctx, transport), {
              ref: 'refs/heads/s*:refs/remotes/s/*',
              fastForward: 'only',
              author,
            }),
          );

          // Assert
          expect(result.merge.kind).toBe(kind);
        });
      });
    });

    describe('Given fastForward only and two heads HEAD already contains', () => {
      describe('When pull', () => {
        it('Then it refuses to fast-forward to several branches before merging', async () => {
          // Arrange
          const { ctx, tips } = await fastForwardRepo();
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const { transport } = buildPullRemote(
            [
              { name: 'refs/heads/s0', id: tips.parent },
              { name: 'refs/heads/s1', id: tips.head },
            ],
            await emptyPack(ctx),
          );
          const sut = refusal;

          // Act
          const result = await sut(withTransport(ctx, transport), {
            ref: 'refs/heads/s*:refs/remotes/s/*',
            fastForward: 'only',
            author,
          });

          // Assert
          expect(result).toEqual({ code: 'FAST_FORWARD_MULTIPLE_BRANCHES' });
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
        });
      });
    });

    describe('Given an upstream merging two refs the remote does not have', () => {
      describe('When pull', () => {
        it('Then it refuses naming the first, the upstream', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          await updateConfigEntries(ctx, remoteEntries(ORIGIN_FETCH));
          const path = `${ctx.layout.gitDir}/config`;
          const twoMerges =
            '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/n1\n\tmerge = refs/heads/n2\n';
          await ctx.fs.writeUtf8(path, `${await ctx.fs.readUtf8(path)}${twoMerges}`);
          invalidateConfigCache(ctx);
          const { transport } = buildPullRemote(
            [{ name: 'refs/heads/side', id: b }],
            await emptyPack(ctx),
          );
          const sut = refusal;

          // Act
          const result = await sut(withTransport(ctx, transport));

          // Assert
          expect(result).toEqual({
            code: 'PULL_NO_MERGE_CANDIDATES',
            reason: 'merge-ref-not-fetched',
            remote: 'origin',
            ref: 'refs/heads/n1',
          });
        });
      });
    });

    describe.each([
      {
        label: 'an upstream naming a ref the remote does not have',
        config: upstream('main', 'origin', 'refs/heads/nope'),
        opts: {},
        expected: {
          code: 'PULL_NO_MERGE_CANDIDATES',
          reason: 'merge-ref-not-fetched',
          remote: 'origin',
          ref: 'refs/heads/nope',
        },
      },
      {
        label: 'an explicit remote other than the upstream one and no branch',
        config: upstream('main', 'other', 'refs/heads/side'),
        opts: { remote: 'origin' },
        expected: {
          code: 'PULL_NO_MERGE_CANDIDATES',
          reason: 'not-default-remote',
          remote: 'origin',
        },
      },
      {
        label: 'an explicit wildcard ref matching nothing',
        config: [],
        opts: { ref: 'refs/heads/zz*:refs/remotes/zz/*' },
        expected: {
          code: 'PULL_NO_MERGE_CANDIDATES',
          reason: 'refspec-unmatched',
          remote: 'origin',
        },
      },
    ])('Given $label', ({ config, opts, expected }) => {
      describe('When pull', () => {
        it('Then it refuses after fetching, as git does', async () => {
          // Arrange
          const { ctx, b } = await divergedRepo();
          await updateConfigEntries(ctx, [...remoteEntries(ORIGIN_FETCH), ...config]);
          const { transport } = buildPullRemote(
            [{ name: 'refs/heads/side', id: b }],
            await emptyPack(ctx),
          );
          const sut = refusal;

          // Act
          const result = await sut(withTransport(ctx, transport), opts);

          // Assert
          expect(result).toEqual(expected);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/FETCH_HEAD`)).toBe(true);
        });
      });
    });
  });

  describe('Given a non-forcing fetch refspec and a remote branch rewritten under its tracking ref', () => {
    describe('When pull', () => {
      it('Then it refuses with the rejected update before merging', async () => {
        // Arrange — the tracking ref sits on X, which the remote's B does not descend from.
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a', 'A');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        const b = await commitFile(ctx, 'b.txt', 'b', 'B');
        await checkout(ctx, { rev: 'main' });
        const x = await commitFile(ctx, 'c.txt', 'c', 'X');
        await updateRef(ctx, 'refs/remotes/origin/main' as RefName, x, { reflogMessage: 'seed' });
        await seedConfig(ctx, { upstream: true });
        await updateConfigEntries(ctx, [
          { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
          {
            section: 'remote',
            subsection: 'origin',
            key: 'fetch',
            value: 'refs/heads/*:refs/remotes/origin/*',
          },
        ]);
        const { transport } = buildPullRemote(
          [{ name: 'refs/heads/main', id: b }],
          await emptyPack(ctx),
        );
        const sut = pull;
        let caught: unknown;

        // Act
        try {
          await sut(withTransport(ctx, transport), { author });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: unknown }).data).toEqual({
          code: 'FETCH_REJECTED',
          remote: 'origin',
          rejected: [
            {
              name: 'refs/remotes/origin/main',
              oldId: x,
              newId: b,
              rejection: 'non-fast-forward',
            },
          ],
        });
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(x);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe('fast-forward configuration', () => {
    /** Remote main one commit ahead of main; `diverged` adds a commit of main's own. */
    const seedPull = async (diverged: boolean) => {
      const ctx = createMemoryContext();
      await init(ctx);
      await commitFile(ctx, 'a.txt', 'a', 'A');
      await branchCreate(ctx, { name: 'feature' });
      await checkout(ctx, { rev: 'feature' });
      const ahead = await commitFile(ctx, 'b.txt', 'b', 'B');
      await checkout(ctx, { rev: 'main' });
      if (diverged) await commitFile(ctx, 'c.txt', 'c', 'X');
      await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
      const remote = buildPullRemote(
        [{ name: 'refs/heads/main', id: ahead }],
        await emptyPack(ctx),
      );
      return { ctx: withTransport(ctx, remote.transport), requests: remote.requests };
    };

    const configure = (ctx: Context, entries: ReadonlyArray<readonly [string, string]>) =>
      updateConfigEntries(
        ctx,
        entries.map(([key, value]) => {
          const [section, name] = key.split('.') as [string, string];
          return { section, key: name, value };
        }),
      );

    describe.each([
      ['pull.ff=false over a fast-forwardable head', false, [['pull.ff', 'false']], 'merge'],
      [
        'pull.ff=true over merge.ff=false',
        false,
        [
          ['merge.ff', 'false'],
          ['pull.ff', 'true'],
        ],
        'fast-forward',
      ],
      [
        'pull.ff=false over merge.ff=only',
        false,
        [
          ['merge.ff', 'only'],
          ['pull.ff', 'false'],
        ],
        'merge',
      ],
      ['pull.ff=only over a diverged head', true, [['pull.ff', 'only']], 'merge'],
      [
        'pull.ff=only over merge.ff=only and a diverged head',
        true,
        [
          ['merge.ff', 'only'],
          ['pull.ff', 'only'],
        ],
        'merge',
      ],
      ['merge.ff=false and no pull.ff', false, [['merge.ff', 'false']], 'merge'],
    ] as const)('Given %s', (_label, diverged, entries, kind) => {
      describe('When pull runs merging without a fast-forward policy', () => {
        it(`Then the integration concludes as a ${kind}`, async () => {
          // Arrange
          const { ctx } = await seedPull(diverged);
          await configure(ctx, entries);
          const sut = pull;

          // Act
          const result = mergedPull(await sut(ctx, { rebase: false, author }));

          // Assert
          expect(result.merge.kind).toBe(kind);
        });
      });
    });

    describe('Given a valueless pull.ff over merge.ff=false', () => {
      describe('When pull runs without a fast-forward policy', () => {
        it('Then the valueless key reads as true and the pull fast-forwards', async () => {
          // Arrange
          const { ctx } = await seedPull(false);
          const configPath = `${ctx.layout.gitDir}/config`;
          await configure(ctx, [['merge.ff', 'false']]);
          await ctx.fs.writeUtf8(configPath, `${await ctx.fs.readUtf8(configPath)}[pull]\n\tff\n`);
          invalidateConfigCache(ctx);
          const sut = pull;

          // Act
          const result = mergedPull(await sut(ctx, { author }));

          // Assert
          expect(result.merge.kind).toBe('fast-forward');
        });
      });
    });

    describe('Given merge.ff=only over a diverged head', () => {
      describe('When pull runs without a fast-forward policy', () => {
        it('Then the merge refuses with NON_FAST_FORWARD', async () => {
          // Arrange
          const { ctx } = await seedPull(true);
          await configure(ctx, [['merge.ff', 'only']]);
          const sut = pull;

          // Act
          const result = await sut(ctx, { rebase: false, author }).catch((error: unknown) => error);

          // Assert
          expect((result as TsgitError).data).toMatchObject({ code: 'NON_FAST_FORWARD' });
        });
      });
    });

    describe.each(['bogus', 'ONLY'])('Given pull.ff=%s', (value) => {
      describe('When pull runs without a fast-forward policy', () => {
        it('Then it refuses with CONFIG_INVALID_ENUM_VALUE before fetching', async () => {
          // Arrange
          const { ctx, requests } = await seedPull(false);
          await configure(ctx, [['pull.ff', value]]);
          const sut = pull;

          // Act
          const result = await sut(ctx, { author }).catch((error: unknown) => error);

          // Assert
          expect((result as TsgitError).data).toEqual({
            code: 'CONFIG_INVALID_ENUM_VALUE',
            key: 'pull.ff',
            source: `${ctx.layout.gitDir}/config`,
            value,
            line: expect.any(Number),
          });
          expect(requests).toHaveLength(0);
        });
      });

      describe('When pull runs with fastForward allow', () => {
        it('Then pull.ff is never read and the pull fast-forwards', async () => {
          // Arrange
          const { ctx } = await seedPull(false);
          await configure(ctx, [['pull.ff', value]]);
          const sut = pull;

          // Act
          const result = mergedPull(await sut(ctx, { fastForward: 'allow', author }));

          // Assert
          expect(result.merge.kind).toBe('fast-forward');
        });
      });
    });
  });
});

const USER = '\n[user]\n\tname = Ada\n\temail = ada@example.com\n';

/** main at A→X (c.txt), the remote's main at A→B (b.txt); upstream configured. */
const divergedPull = async (
  theirs: { path: string; content: string } = { path: 'b.txt', content: 'b' },
) => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, USER);
  const a = await commitFile(ctx, 'a.txt', 'a\n', 'A');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  const b = await commitFile(ctx, theirs.path, theirs.content, 'B');
  await checkout(ctx, { rev: 'main' });
  const x = await commitFile(ctx, 'c.txt', 'c', 'X');
  await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
  const remote = buildPullRemote([{ name: 'refs/heads/main', id: b }], await emptyPack(ctx));
  return { ctx: withTransport(ctx, remote.transport), requests: remote.requests, a, b, x };
};

describe('pull rebasing onto the fetched head', () => {
  const pullData = async (ctx: Context, opts: Parameters<typeof pull>[1]) => {
    try {
      await pull(ctx, opts);
    } catch (error) {
      return (error as TsgitError).data;
    }
    return undefined;
  };

  describe.each([
    ['rebase true', true],
    ["rebase 'merges'", 'merges'],
  ] as const)('Given diverged histories, When pull with %s', (_, rebase) => {
    it('Then the local commit is replayed onto the fetched head with pull reflogs and ORIG_HEAD', async () => {
      // Arrange
      const { ctx, b, x } = await divergedPull();
      const sut = pull;

      // Act
      const result = await sut(ctx, { rebase });

      // Assert
      const tip = await resolveRef(ctx, 'refs/heads/main' as RefName);
      const obj = await readObject(ctx, tip);
      expect(obj.type === 'commit' && obj.data.parents).toEqual([b]);
      expect(obj.type === 'commit' && obj.data.message).toBe('X\n');
      expect(result.integration).toBe('rebase');
      expect(result.integration === 'rebase' && result.rebase.kind).toBe('rebased');
      expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`)).trim()).toBe(x);
      expect((await reflogMessages(ctx, 'HEAD')).slice(-3)).toEqual([
        `pull (start): checkout ${b}`,
        'pull (pick): X',
        'pull (finish): returning to refs/heads/main',
      ]);
      expect((await reflogMessages(ctx, 'refs/heads/main')).at(-1)).toBe(
        `pull (finish): refs/heads/main onto ${b}`,
      );
    });
  });

  describe("Given a local merge diverged from the fetched head, When pull with rebase 'merges'", () => {
    it('Then the merge is recreated on the fetched head instead of flattened', async () => {
      // Arrange
      const { ctx } = await divergedPull();
      await branchCreate(ctx, { name: 'side' });
      await checkout(ctx, { rev: 'side' });
      await commitFile(ctx, 's.txt', 's\n', 'S');
      await checkout(ctx, { rev: 'main' });
      await commitFile(ctx, 'y.txt', 'y\n', 'Y');
      await mergeRun(ctx, { rev: 'side', fastForward: 'never' });
      const sut = pull;

      // Act
      await sut(ctx, { rebase: 'merges' });

      // Assert
      const tip = await readObject(ctx, await resolveRef(ctx, 'refs/heads/main' as RefName));
      expect(tip.type === 'commit' && tip.data.parents).toHaveLength(2);
      expect((await reflogMessages(ctx, 'HEAD')).at(-2)).toBe("pull (merge): Merge branch 'side'");
    });
  });

  describe('Given a fast-forwardable head, When pull with rebase true', () => {
    it('Then it fast-forwards through the merge, as git does without invoking rebase', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await commitFile(ctx, 'a.txt', 'a', 'A');
      await branchCreate(ctx, { name: 'feature' });
      await checkout(ctx, { rev: 'feature' });
      const b = await commitFile(ctx, 'b.txt', 'b', 'B');
      await checkout(ctx, { rev: 'main' });
      await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
      const { transport } = buildPullRemote(
        [{ name: 'refs/heads/main', id: b }],
        await emptyPack(ctx),
      );
      const sut = pull;

      // Act
      const result = await sut(withTransport(ctx, transport), { rebase: true });

      // Assert
      expect(result.integration === 'merge' && result.merge.kind).toBe('fast-forward');
      expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(b);
      expect((await reflogMessages(ctx, 'refs/heads/main')).at(-1)).toBe('pull: Fast-forward');
    });
  });

  describe('Given unstaged changes, When pull with rebase true', () => {
    it('Then it refuses before fetching anything', async () => {
      // Arrange
      const { ctx, requests } = await divergedPull();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty\n');

      // Act
      const result = await pullData(ctx, { rebase: true });

      // Assert
      expect(result).toEqual({
        code: 'WORKING_TREE_DIRTY',
        localChanges: ['a.txt'],
        untracked: [],
      });
      expect(requests).toHaveLength(0);
    });
  });

  describe('Given rebase.autostash and a dirty tree', () => {
    describe('When pull rebasing', () => {
      it('Then it stashes and re-applies the local changes around the rebase', async () => {
        // Arrange
        const { ctx, b } = await divergedPull();
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[rebase]\n\tautostash = true\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty\n');
        const sut = pull;

        // Act
        const result = await sut(ctx, { rebase: true });

        // Assert
        expect(result.integration === 'rebase' && result.rebase.kind).toBe('rebased');
        const tip = await readObject(ctx, await resolveRef(ctx, 'refs/heads/main' as RefName));
        expect(tip.type === 'commit' && tip.data.parents).toEqual([b]);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('dirty\n');
      });
    });
  });

  describe.each([
    [
      'pull.autostash over rebase.autostash',
      '[pull]\n\tautostash = true\n[rebase]\n\tautostash = false\n',
      {},
    ],
    [
      'the autostash option over pull.autostash',
      '[pull]\n\tautostash = false\n',
      { autostash: true },
    ],
  ] as const)('Given %s and a dirty tree', (_, config, given) => {
    describe('When pull rebasing', () => {
      it('Then it stashes and re-applies the local change', async () => {
        // Arrange
        const { ctx } = await divergedPull();
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, config);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty\n');
        const sut = pull;

        // Act
        const result = await sut(ctx, { rebase: true, ...given });

        // Assert
        expect(result.integration === 'rebase' && result.rebase.kind).toBe('rebased');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('dirty\n');
      });
    });
  });

  describe('Given rebase.autostash and the autostash option off, When pull rebasing a dirty tree', () => {
    it('Then the option wins and it refuses the dirty tree', async () => {
      // Arrange
      const { ctx } = await divergedPull();
      await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[rebase]\n\tautostash = true\n');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty\n');

      // Act
      const result = await pullData(ctx, { rebase: true, autostash: false });

      // Assert
      expect(result).toEqual({
        code: 'WORKING_TREE_DIRTY',
        localChanges: ['a.txt'],
        untracked: [],
      });
    });
  });

  describe.each([['pull'], ['rebase']] as const)(
    'Given an invalid %s.autostash, When pull without a rebase',
    (section) => {
      it('Then it refuses the bad boolean, as git reads the key on every pull', async () => {
        // Arrange
        const { ctx } = await divergedPull();
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/config`,
          `[${section}]\n\tautostash = maybe\n`,
        );

        // Act
        const result = await pullData(ctx, { rebase: false, autostash: true });

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: `${section}.autostash`,
          value: 'maybe',
        });
      });
    },
  );

  describe('Given diverged histories, When pull with rebase true and fastForward only', () => {
    it('Then fast-forward-only wins and refuses the divergence', async () => {
      // Arrange
      const { ctx, b, x } = await divergedPull();

      // Act
      const result = await pullData(ctx, { rebase: true, fastForward: 'only' });

      // Assert
      expect(result).toEqual({
        code: 'NON_FAST_FORWARD',
        ref: 'refs/heads/main',
        local: x,
        remote: b,
      });
    });
  });

  describe('Given two fetched heads, When pull with rebase true', () => {
    it('Then it refuses to rebase onto multiple branches', async () => {
      // Arrange
      const { ctx, b } = await divergedPull();
      const remote = buildPullRemote(
        [
          { name: 'refs/heads/s0', id: b },
          { name: 'refs/heads/s1', id: b },
        ],
        await emptyPack(ctx),
      );

      // Act
      const result = await pullData(withTransport(ctx, remote.transport), {
        ref: 'refs/heads/s*:refs/remotes/s/*',
        rebase: true,
      });

      // Assert
      expect(result).toEqual({ code: 'PULL_REBASE_MULTIPLE_BRANCHES' });
    });
  });

  describe('Given the local commit conflicts with the fetched head, When pull with rebase true', () => {
    it('Then the rebase stops on the conflict with its state on disk', async () => {
      // Arrange
      const { ctx } = await divergedPull({ path: 'c.txt', content: 'theirs' });

      // Act
      const result = await pull(ctx, { rebase: true });

      // Assert
      expect(result.integration === 'rebase' && result.rebase.kind).toBe('conflict');
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REBASE_HEAD`)).toBe(true);
    });
  });

  describe('Given an upstream rewritten since the local branch forked from it, When pull with rebase true', () => {
    it('Then only the commits after the fork point are replayed', async () => {
      // Arrange — origin/main once at X (fetched), local Y on X; the remote rewrites main to B.
      const { ctx, a, b, x } = await divergedPull();
      await updateRef(ctx, 'refs/remotes/origin/main' as RefName, x, {
        reflogMessage: 'fetch: fast-forward',
      });
      const y = await commitFile(ctx, 'd.txt', 'd', 'Y');
      const sut = pull;

      // Act
      await sut(ctx, { rebase: true });

      // Assert
      const tip = await resolveRef(ctx, 'refs/heads/main' as RefName);
      const obj = await readObject(ctx, tip);
      expect(obj.type === 'commit' && obj.data.parents).toEqual([b]);
      expect(obj.type === 'commit' && obj.data.message).toBe('Y\n');
      expect([a, y]).not.toContain(tip);
    });
  });
});

describe('pull rebasing, edge states', () => {
  const seed = async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, USER);
    const a = await commitFile(ctx, 'a.txt', 'a\n', 'A');
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { rev: 'feature' });
    const b = await commitFile(ctx, 'b.txt', 'b', 'B');
    await checkout(ctx, { rev: 'main' });
    await commitFile(ctx, 'c.txt', 'c', 'X');
    await seedConfig(ctx, { url: REMOTE_URL, upstream: true });
    const remote = buildPullRemote([{ name: 'refs/heads/main', id: b }], await emptyPack(ctx));
    return { ctx: withTransport(ctx, remote.transport), a, b };
  };

  const parentsOfTip = async (ctx: Context) => {
    const obj = await readObject(ctx, await resolveRef(ctx, 'refs/heads/main' as RefName));
    return obj.type === 'commit' ? obj.data.parents : [];
  };

  describe('Given the remote-tracking ref already at the fork, When pull with rebase true', () => {
    it('Then the fork point is the merge base and the rebase starts from the fetched head', async () => {
      // Arrange
      const { ctx, a, b } = await seed();
      await updateRef(ctx, 'refs/remotes/origin/main' as RefName, a, { reflogMessage: 'fetch' });
      const sut = pull;

      // Act
      await sut(ctx, { rebase: true });

      // Assert
      expect(await parentsOfTip(ctx)).toEqual([b]);
    });
  });

  describe('Given a detached HEAD, When pull with rebase true and an explicit ref', () => {
    it('Then the detached HEAD is rebased onto the fetched head', async () => {
      // Arrange
      const { ctx, b } = await seed();
      const x = await resolveRef(ctx, 'refs/heads/main' as RefName);
      await checkout(ctx, { rev: x, detach: true });
      const sut = pull;

      // Act
      const result = await sut(ctx, { rebase: true, ref: 'refs/heads/main' });

      // Assert
      expect(result.integration === 'rebase' && result.rebase.kind).toBe('rebased');
      const head = await readObject(ctx, await resolveRef(ctx, 'HEAD' as RefName));
      expect(head.type === 'commit' && head.data.parents).toEqual([b]);
    });
  });
});

describe('pull choosing how to reconcile', () => {
  const settle = (ctx: Context, entries: ReadonlyArray<readonly [string, string, string | null]>) =>
    ctx.fs.appendUtf8(
      `${ctx.layout.gitDir}/config`,
      entries
        .map(([section, key, value]) =>
          value === null ? `[${section}]\n\t${key}\n` : `[${section}]\n\t${key} = ${value}\n`,
        )
        .join(''),
    );

  const outcome = async (ctx: Context, opts: Parameters<typeof pull>[1]) => {
    try {
      const result = await pull(ctx, opts);
      return result.integration === 'merge' ? result.merge.kind : `rebase:${result.rebase.kind}`;
    } catch (error) {
      return (error as TsgitError).data.code;
    }
  };

  describe.each([
    ['nothing chosen', [], {}, 'PULL_DIVERGENT_BRANCHES'],
    ['pull.rebase=true', [['pull', 'rebase', 'true']], {}, 'rebase:rebased'],
    ['a valueless pull.rebase', [['pull', 'rebase', null]], {}, 'rebase:rebased'],
    ['pull.rebase=merges', [['pull', 'rebase', 'merges']], {}, 'rebase:rebased'],
    ['pull.rebase=m', [['pull', 'rebase', 'm']], {}, 'rebase:rebased'],
    ['pull.rebase=interactive', [['pull', 'rebase', 'interactive']], {}, 'rebase:rebased'],
    ['pull.rebase=false', [['pull', 'rebase', 'false']], {}, 'merge'],
    ['pull.rebase=bogus', [['pull', 'rebase', 'bogus']], {}, 'CONFIG_INVALID_ENUM_VALUE'],
    ['pull.rebase=preserve', [['pull', 'rebase', 'preserve']], {}, 'CONFIG_INVALID_ENUM_VALUE'],
    [
      'branch.main.rebase=true over pull.rebase=false',
      [
        ['pull', 'rebase', 'false'],
        ['branch "main"', 'rebase', 'true'],
      ],
      {},
      'rebase:rebased',
    ],
    ['branch.main.rebase=false', [['branch "main"', 'rebase', 'false']], {}, 'merge'],
    ['pull.ff=true', [['pull', 'ff', 'true']], {}, 'merge'],
    ['pull.ff=false', [['pull', 'ff', 'false']], {}, 'merge'],
    ['pull.ff=only', [['pull', 'ff', 'only']], {}, 'NON_FAST_FORWARD'],
    ['pull.ff=only with rebase true', [['pull', 'ff', 'only']], { rebase: true }, 'rebase:rebased'],
    ['pull.ff=only with rebase false', [['pull', 'ff', 'only']], { rebase: false }, 'merge'],
    [
      'pull.ff=only over pull.rebase=true',
      [
        ['pull', 'ff', 'only'],
        ['pull', 'rebase', 'true'],
      ],
      {},
      'NON_FAST_FORWARD',
    ],
    ['fastForward allow', [], { fastForward: 'allow' }, 'merge'],
    ['rebase false', [], { rebase: false }, 'merge'],
    [
      'rebase false over pull.rebase=true',
      [['pull', 'rebase', 'true']],
      { rebase: false },
      'merge',
    ],
    ['merge.ff=false alone', [['merge', 'ff', 'false']], {}, 'PULL_DIVERGENT_BRANCHES'],
  ] as const)('Given diverged histories and %s, When pull', (_, entries, opts, expected) => {
    it(`Then it integrates as git does: ${expected}`, async () => {
      // Arrange
      const { ctx } = await divergedPull();
      await settle(ctx, entries);
      const sut = outcome;

      // Act
      const result = await sut(ctx, opts);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given diverged histories and nothing chosen, When pull', () => {
    it('Then it refuses after the fetch and leaves the branch alone', async () => {
      // Arrange
      const { ctx, requests, x } = await divergedPull();

      // Act
      const result = await outcome(ctx, {});

      // Assert
      expect(result).toBe('PULL_DIVERGENT_BRANCHES');
      expect(requests.length).toBeGreaterThan(0);
      expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(x);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
    });
  });

  describe('Given an invalid branch.main.rebase, When pull', () => {
    it('Then it refuses before fetching, naming the branch key', async () => {
      // Arrange
      const { ctx, requests } = await divergedPull();
      await settle(ctx, [['branch "main"', 'rebase', 'bogus']]);

      // Act
      let data: unknown;
      try {
        await pull(ctx, {});
      } catch (error) {
        data = (error as TsgitError).data;
      }

      // Assert
      expect(data).toEqual({
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: 'branch.main.rebase',
        source: `${ctx.layout.gitDir}/config`,
        value: 'bogus',
        line: expect.any(Number),
      });
      expect(requests).toHaveLength(0);
    });
  });

  describe('Given a detached HEAD on diverged histories and branch.main.rebase=true, When pull of a ref', () => {
    it('Then the branch key is not read and it refuses the divergence', async () => {
      // Arrange
      const { ctx } = await divergedPull();
      await settle(ctx, [['branch "main"', 'rebase', 'true']]);
      await checkout(ctx, {
        rev: await resolveRef(ctx, 'refs/heads/main' as RefName),
        detach: true,
      });

      // Act
      const result = await outcome(ctx, { ref: 'refs/heads/main' });

      // Assert
      expect(result).toBe('PULL_DIVERGENT_BRANCHES');
    });
  });

  describe('Given HEAD already containing the fetched head and nothing chosen, When pull', () => {
    it('Then it is up to date, not refused', async () => {
      // Arrange
      const { ctx, a } = await divergedPull();
      const remote = buildPullRemote([{ name: 'refs/heads/main', id: a }], await emptyPack(ctx));

      // Act
      const result = await outcome(withTransport(ctx, remote.transport), {});

      // Assert
      expect(result).toBe('up-to-date');
    });
  });
});
