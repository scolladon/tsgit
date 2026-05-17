/**
 * Phase 12.3 — push command. Real receive-pack-driven body.
 *
 * Tests cover:
 *  - REMOTE_NOT_CONFIGURED guard.
 *  - Default 'origin' remote name + URL resolution.
 *  - Detached HEAD with no explicit refspec → INVALID_OPTION.
 *  - No-op push (local matches remote) — no POST issued.
 *  - Happy single-ref push: request body is well-formed, pushedRefs is ok.
 *  - Per-ref `ng` from server → status 'rejected'.
 *  - `unpack <err>` from server → throws PUSH_REJECTED.
 *  - Non-fast-forward without force → NON_FAST_FORWARD.
 *  - `force: true` skips the non-FF guard.
 *  - `forceWithLease: 'auto'` reads remote-tracking ref; mismatch → PUSH_REJECTED.
 *  - `forceWithLease: 'auto'` on a tag dst → INVALID_OPTION.
 *  - Delete refspec → empty pack body, POSTed as zero-oid newId.
 *  - Side-band-64k advertised → response demuxed correctly.
 *  - Remote-tracking cache updated on accepted ref.
 *  - Progress reporting (push:enumerate-objects bracket).
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { push } from '../../../../src/application/commands/push.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { Blob, Commit, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { recordingProgress, seedRepo, withProgress } from './fixtures.js';

const ENCODER = new TextEncoder();
const ZERO_OID = '0'.repeat(40);

interface RemoteRef {
  readonly name: string;
  readonly id: string;
}

interface FakeServer {
  readonly url: string;
  readonly advertisedRefs: ReadonlyArray<RemoteRef>;
  readonly advertisedCaps?: ReadonlyArray<string>;
  readonly reportStatus: {
    unpack: 'ok' | string;
    refs: ReadonlyArray<
      { name: string; status: 'ok' } | { name: string; status: 'ng'; reason: string }
    >;
  };
  /** Wrap report-status in side-band channel 1. */
  readonly sideband?: boolean;
}

const buildAdvertisementBytes = (
  refs: ReadonlyArray<RemoteRef>,
  caps: ReadonlyArray<string>,
): Uint8Array => {
  const header = encodePktStream([ENCODER.encode('# service=git-receive-pack\n')]);
  const refLines: Uint8Array[] = [];
  if (refs.length === 0) {
    // Empty receive-pack advertisement uses the "no refs" sentinel: a
    // single capability-only line with oid=ZERO and name=capabilities^{}.
    refLines.push(ENCODER.encode(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    refs.forEach((r, idx) => {
      if (idx === 0) {
        refLines.push(ENCODER.encode(`${r.id} ${r.name}\0${caps.join(' ')}\n`));
      } else {
        refLines.push(ENCODER.encode(`${r.id} ${r.name}\n`));
      }
    });
  }
  const refsBody = encodePktStream(refLines);
  const out = new Uint8Array(header.length + refsBody.length);
  out.set(header, 0);
  out.set(refsBody, header.length);
  return out;
};

const buildReportStatus = (spec: FakeServer['reportStatus'], sideband: boolean): Uint8Array => {
  const lines: Uint8Array[] = [];
  lines.push(ENCODER.encode(spec.unpack === 'ok' ? 'unpack ok\n' : `unpack ${spec.unpack}\n`));
  for (const r of spec.refs) {
    if (r.status === 'ok') lines.push(ENCODER.encode(`ok ${r.name}\n`));
    else lines.push(ENCODER.encode(`ng ${r.name} ${r.reason}\n`));
  }
  const reportPkts = encodePktStream(lines);
  if (!sideband) return reportPkts;
  // Wrap reportPkts as a single side-band channel-1 packet.
  const channel1 = new Uint8Array(reportPkts.length + 1);
  channel1[0] = 0x01;
  channel1.set(reportPkts, 1);
  return encodePktStream([channel1]);
};

const fakeServer = (
  spec: FakeServer,
): { transport: HttpTransport; requests: HttpRequest[]; requestBodies: Uint8Array[] } => {
  const requests: HttpRequest[] = [];
  const requestBodies: Uint8Array[] = [];
  // Default caps deliberately omit `side-band-64k`: tests that want sideband
  // demuxing set `sideband: true` AND advertise the capability explicitly.
  // Servers wrap report-status in sideband only when the client requested it,
  // which our selectPushCapabilities does iff the server advertised it.
  const advertisement = buildAdvertisementBytes(
    spec.advertisedRefs,
    spec.advertisedCaps ?? ['report-status', 'ofs-delta', 'atomic', 'delete-refs'],
  );
  const reportBytes = buildReportStatus(spec.reportStatus, spec.sideband === true);
  const transport: HttpTransport = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      const isDiscovery = req.url.includes('info/refs');
      if (!isDiscovery && req.body !== undefined) requestBodies.push(req.body);
      const body = isDiscovery ? advertisement : reportBytes;
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
  return { transport, requests, requestBodies };
};

const writeOriginConfig = async (ctx: ReturnType<typeof createMemoryContext>): Promise<void> => {
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/config`,
    '[remote "origin"]\n  url = https://example.com/r.git\n',
  );
};

interface BuiltCommit {
  readonly id: ObjectId;
  readonly tree: ObjectId;
}

const seedCommit = async (
  ctx: ReturnType<typeof createMemoryContext>,
  parents: ReadonlyArray<ObjectId>,
  content: string,
): Promise<BuiltCommit> => {
  const blob: Blob = {
    type: 'blob',
    content: ENCODER.encode(content),
    id: '' as ObjectId,
  };
  const blobId = await writeObject(ctx, blob);
  const treeId = await writeTree(ctx, [
    { name: 'README.md', mode: '100644' as FileMode, id: blobId },
  ]);
  const author = {
    name: 'A',
    email: 'a@a',
    timestamp: 0,
    timezoneOffset: '+0000',
  };
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents,
      author,
      committer: author,
      message: content,
      extraHeaders: [],
    },
  };
  const id = await writeObject(ctx, commit);
  return { id, tree: treeId };
};

describe('push — config + refspec guards', () => {
  it('Given no remote configured, When push runs, Then throws REMOTE_NOT_CONFIGURED', async () => {
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    let caught: unknown;
    try {
      await push(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
  });

  it('Given a detached HEAD and no refspec, When push runs, Then throws INVALID_OPTION (no-default-refspec)', async () => {
    // Arrange — kills the `head.kind !== "symbolic"` guard mutant.
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    await writeOriginConfig(ctx);
    const tip = await seedCommit(ctx, [], 'detached');
    // Detach HEAD to the commit oid (no symbolic ref).
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${tip.id}\n`);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: tip.id }],
      reportStatus: { unpack: 'ok', refs: [] },
    });

    // Act
    let caught: unknown;
    try {
      await push({ ...ctx, transport });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as {
      code: string;
      reason: string;
    };
    expect(data.code).toBe('INVALID_OPTION');
    expect(data.reason).toContain('no-default-refspec');
  });
});

describe('push — happy path', () => {
  it('Given an origin remote, When push runs with no refspec on branch main, Then result.remote and url are populated', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const parent = await seedCommit(ctx, [], 'gen-1');
    const tip = await seedCommit(ctx, [parent.id], 'gen-2');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });

    // Act
    const sut = await push({ ...ctx, transport });

    // Assert
    expect(sut.remote).toBe('origin');
    expect(sut.url).toBe('https://example.com/r.git');
    expect(sut.pushedRefs).toHaveLength(1);
    expect(sut.pushedRefs[0]).toMatchObject({
      name: 'refs/heads/main',
      status: 'ok',
      newId: tip.id,
      oldId: parent.id,
    });
  });

  it('Given local matches remote, When push runs, Then pushedRefs is empty and no POST is issued', async () => {
    // Arrange — kills the `movers.length === 0` short-circuit mutant.
    const ctx = createMemoryContext();
    const tip = await seedCommit(ctx, [], 'identical');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport, requests } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: tip.id }],
      reportStatus: { unpack: 'ok', refs: [] },
    });

    // Act
    const sut = await push({ ...ctx, transport });

    // Assert
    expect(sut.pushedRefs).toEqual([]);
    // Exactly one HTTP call — the discovery GET. No POST.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
  });
});

describe('push — server responses', () => {
  it('Given the server returns `ng <ref> <reason>`, When push runs, Then the ref is reported as rejected with reason', async () => {
    // Arrange — kills the `accepted === true` short-circuit mutant.
    const ctx = createMemoryContext();
    const parent = await seedCommit(ctx, [], 'a');
    const tip = await seedCommit(ctx, [parent.id], 'b');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
      reportStatus: {
        unpack: 'ok',
        refs: [{ name: 'refs/heads/main', status: 'ng', reason: 'pre-receive hook declined' }],
      },
    });

    // Act
    const sut = await push({ ...ctx, transport });

    // Assert
    expect(sut.pushedRefs).toHaveLength(1);
    expect(sut.pushedRefs[0]).toMatchObject({
      status: 'rejected',
      reason: 'pre-receive hook declined',
    });
  });

  it('Given the server returns `unpack <err>`, When push runs, Then throws PUSH_REJECTED with the unpack reason', async () => {
    // Arrange — kills the `if (!parsed.unpackOk)` guard mutant.
    const ctx = createMemoryContext();
    const parent = await seedCommit(ctx, [], 'a');
    const tip = await seedCommit(ctx, [parent.id], 'b');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
      reportStatus: { unpack: 'index-pack failed', refs: [] },
    });

    // Act
    let caught: unknown;
    try {
      await push({ ...ctx, transport });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as { code: string; reason: string };
    expect(data.code).toBe('PUSH_REJECTED');
    expect(data.reason).toBe('index-pack failed');
  });
});

describe('push — force / non-fast-forward', () => {
  it('Given a non-FF update with no force, When push runs, Then throws NON_FAST_FORWARD', async () => {
    // Arrange — kills the ancestor-check skip mutant.
    const ctx = createMemoryContext();
    const branchA = await seedCommit(ctx, [], 'branch-a');
    const branchB = await seedCommit(ctx, [], 'branch-b'); // disjoint, NOT a descendant of branchA
    await seedRepo(ctx, { refs: { 'refs/heads/main': branchB.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: branchA.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });

    // Act
    let caught: unknown;
    try {
      await push({ ...ctx, transport });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('NON_FAST_FORWARD');
  });

  it('Given a non-FF update with force=true, When push runs, Then the update is sent (no NON_FAST_FORWARD)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const branchA = await seedCommit(ctx, [], 'branch-a');
    const branchB = await seedCommit(ctx, [], 'branch-b');
    await seedRepo(ctx, { refs: { 'refs/heads/main': branchB.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: branchA.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });

    // Act
    const sut = await push({ ...ctx, transport }, { force: true });

    // Assert
    expect(sut.pushedRefs[0]?.status).toBe('ok');
  });

  it('Given a `+refs/heads/main:refs/heads/main` refspec, When push runs on a non-FF update, Then it succeeds without force option', async () => {
    // Arrange — the `+` prefix is force at the refspec level. Kills the
    // `parsed.force === "force"` guard mutant.
    const ctx = createMemoryContext();
    const branchA = await seedCommit(ctx, [], 'a');
    const branchB = await seedCommit(ctx, [], 'b');
    await seedRepo(ctx, { refs: { 'refs/heads/main': branchB.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: branchA.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });

    // Act
    const sut = await push(
      { ...ctx, transport },
      { refspecs: ['+refs/heads/main:refs/heads/main'] },
    );

    // Assert
    expect(sut.pushedRefs[0]?.status).toBe('ok');
  });
});

describe('push — force-with-lease', () => {
  it('Given `forceWithLease: "auto"` and the cached remote-tracking ref matches the server, When push runs, Then the update succeeds without force', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const branchA = await seedCommit(ctx, [], 'a');
    const branchB = await seedCommit(ctx, [], 'b');
    await seedRepo(ctx, {
      refs: {
        'refs/heads/main': branchB.id,
        'refs/remotes/origin/main': branchA.id,
      },
    });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: branchA.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });

    // Act
    const sut = await push({ ...ctx, transport }, { forceWithLease: 'auto' });

    // Assert
    expect(sut.pushedRefs[0]?.status).toBe('ok');
  });

  it('Given `forceWithLease: "auto"` with a stale cached value, When push runs, Then throws PUSH_REJECTED (lease-mismatch)', async () => {
    // Arrange — kills the `lease !== remoteOid` guard mutant.
    const ctx = createMemoryContext();
    const a = await seedCommit(ctx, [], 'a');
    const b = await seedCommit(ctx, [], 'b');
    const c = await seedCommit(ctx, [], 'c'); // server has c, cache has a → mismatch
    await seedRepo(ctx, {
      refs: {
        'refs/heads/main': b.id,
        'refs/remotes/origin/main': a.id,
      },
    });
    await writeOriginConfig(ctx);
    const { transport, requests } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: c.id }],
      reportStatus: { unpack: 'ok', refs: [] },
    });

    // Act
    let caught: unknown;
    try {
      await push({ ...ctx, transport }, { forceWithLease: 'auto' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as { code: string; reason: string };
    expect(data.code).toBe('PUSH_REJECTED');
    expect(data.reason).toBe('lease-mismatch');
    // POST was NOT issued (lease check is pre-flight).
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('Given `forceWithLease: "auto"` on a tag refspec, When push runs, Then throws INVALID_OPTION (lease-on-non-branch)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const tip = await seedCommit(ctx, [], 'tagged');
    await seedRepo(ctx, { refs: { 'refs/tags/v1.0': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/tags/v1.0', id: '0'.repeat(40) }],
      reportStatus: { unpack: 'ok', refs: [] },
    });

    // Act
    let caught: unknown;
    try {
      await push(
        { ...ctx, transport },
        { refspecs: ['refs/tags/v1.0:refs/tags/v1.0'], forceWithLease: 'auto' },
      );
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
    expect(data.reason).toContain('lease-on-non-branch');
  });
});

describe('push — delete refspec', () => {
  it('Given `:refs/heads/feature` and the ref is advertised, When push runs, Then the request body carries the zero-oid newId', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const feature = await seedCommit(ctx, [], 'feature');
    await seedRepo(ctx, { refs: { 'refs/heads/feature': feature.id } });
    await writeOriginConfig(ctx);
    const { transport, requestBodies } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/feature', id: feature.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/feature', status: 'ok' }] },
    });

    // Act
    const sut = await push({ ...ctx, transport }, { refspecs: [':refs/heads/feature'] });

    // Assert
    expect(sut.pushedRefs[0]?.status).toBe('ok');
    const body = requestBodies[0];
    expect(body).toBeDefined();
    // The pkt-line update is `<oldId> 0000...0000 refs/heads/feature\0<caps>`
    const decoded = new TextDecoder().decode(body);
    expect(decoded).toContain(`${feature.id} ${ZERO_OID} refs/heads/feature`);
  });

  it('Given a delete refspec for a ref the server does NOT advertise, When push runs, Then throws INVALID_OPTION', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const feature = await seedCommit(ctx, [], 'feature');
    await seedRepo(ctx, { refs: { 'refs/heads/feature': feature.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: feature.id }],
      reportStatus: { unpack: 'ok', refs: [] },
    });

    // Act
    let caught: unknown;
    try {
      await push({ ...ctx, transport }, { refspecs: [':refs/heads/feature'] });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
  });
});

describe('push — side-band response', () => {
  it('Given the server wraps report-status in side-band channel 1, When push runs, Then the response is demuxed correctly', async () => {
    // Arrange — kills the `hasSideBand(capabilities)` branch.
    const ctx = createMemoryContext();
    const parent = await seedCommit(ctx, [], 'p');
    const tip = await seedCommit(ctx, [parent.id], 't');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
      advertisedCaps: ['report-status', 'side-band-64k'],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
      sideband: true,
    });

    // Act
    const sut = await push({ ...ctx, transport });

    // Assert
    expect(sut.pushedRefs[0]?.status).toBe('ok');
  });
});

describe('push — remote-tracking cache', () => {
  it('Given an accepted ref under refs/heads/, When push completes, Then refs/remotes/origin/<branch> is written with the new oid', async () => {
    // Arrange — kills the `updateTrackingCache` short-circuit mutant.
    const ctx = createMemoryContext();
    const parent = await seedCommit(ctx, [], 'p');
    const tip = await seedCommit(ctx, [parent.id], 't');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });

    // Act
    await push({ ...ctx, transport });

    // Assert
    const cached = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`);
    expect(cached.trim()).toBe(tip.id);
  });

  it('Given a rejected ref, When push completes, Then refs/remotes/origin/<branch> is NOT updated', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const parent = await seedCommit(ctx, [], 'p');
    const tip = await seedCommit(ctx, [parent.id], 't');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
      reportStatus: {
        unpack: 'ok',
        refs: [{ name: 'refs/heads/main', status: 'ng', reason: 'denied' }],
      },
    });

    // Act
    await push({ ...ctx, transport });

    // Assert — cache file must not exist.
    const exists = await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`);
    expect(exists).toBe(false);
  });
});

describe('push — progress reporting', () => {
  it("Given a successful push, When run, Then start/end pair fires with op === 'push:enumerate-objects'", async () => {
    // Arrange
    const ctx = createMemoryContext();
    const parent = await seedCommit(ctx, [], 'p');
    const tip = await seedCommit(ctx, [parent.id], 't');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });
    const { reporter, events } = recordingProgress();

    // Act
    await push(withProgress({ ...ctx, transport }, reporter));

    // Assert — push:enumerate-objects brackets the whole flow.
    expect(events[0]).toEqual({ kind: 'start', op: 'push:enumerate-objects' });
    expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'push:enumerate-objects' });
  });

  it('Given a push that fails before discovery (no remote), When run, Then end still fires after start', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    const { reporter, events } = recordingProgress();

    // Act
    try {
      await push(withProgress(ctx, reporter));
    } catch {
      // expected
    }

    // Assert — start/end balanced.
    const startCount = events.filter((e) => e.kind === 'start').length;
    const endCount = events.filter((e) => e.kind === 'end').length;
    expect(endCount).toBe(startCount);
  });
});
