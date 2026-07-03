/**
 * push command. Real receive-pack-driven body.
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
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { push } from '../../../../src/application/commands/push.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type {
  Blob,
  Commit,
  FileMode,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { stubCommandRunner } from '../primitives/helpers/stub-command-runner.js';
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

/**
 * Decode the big-endian uint32 object count from the `PACK` header embedded
 * in a receive-pack request body. The body is `<pkt-line updates><pack>`; the
 * pack starts at the `PACK` (0x50 0x41 0x43 0x4b) signature, and bytes 8..12
 * hold the entry count.
 */
const packObjectCount = (body: Uint8Array): number => {
  let packStart = -1;
  for (let i = 0; i + 4 <= body.length; i += 1) {
    if (body[i] === 0x50 && body[i + 1] === 0x41 && body[i + 2] === 0x43 && body[i + 3] === 0x4b) {
      packStart = i;
      break;
    }
  }
  if (packStart < 0) throw new Error('PACK signature not found in request body');
  const view = new DataView(body.buffer, body.byteOffset + packStart + 8, 4);
  return view.getUint32(0, false);
};

describe('push — config + refspec guards', () => {
  describe('Given an invalid remote name %j', () => {
    describe('When push runs', () => {
      it.each([
        ['../escape'],
        ['has space'],
        ['weird/slash'],
        [''],
      ])('Then throws INVALID_OPTION naming the remote', async (badName) => {
        // Arrange — pins the REMOTE_NAME_RE allowlist guarding the composed
        // `refs/remotes/<remote>/<branch>` path against traversal.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});

        // Act
        let caught: unknown;
        try {
          await push(ctx, { remote: badName });
        } catch (err) {
          caught = err;
        }

        // Assert — option is the literal 'remote' and the message echoes the
        // offending name (kills the StringLiteral mutants on the throw site).
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          option: string;
          reason: string;
        };
        expect(data.code).toBe('INVALID_OPTION');
        expect(data.option).toBe('remote');
        expect(data.reason).toBe(`invalid remote name: ${badName}`);
      });
    });
  });

  describe('Given no remote configured', () => {
    describe('When push runs', () => {
      it('Then throws REMOTE_NOT_CONFIGURED and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        let caught: unknown;
        try {
          await push(ctx);
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
    describe('When push runs', () => {
      it('Then throws CONFIG_MISSING_VALUE with key remote.origin.url at line 2', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "origin"]\n\turl\n');
        __resetConfigCacheForTests();

        // Act
        let caught: unknown;
        try {
          await push(ctx);
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

  describe('Given a remote with a valueless url but a valued pushurl', () => {
    describe('When push runs', () => {
      it('Then throws CONFIG_MISSING_VALUE with key remote.origin.url at line 2', async () => {
        // Arrange — git validates each config entry eagerly: a valueless `url`
        // dies even when `pushurl` would otherwise satisfy the push, and it
        // reports `url` as the earlier-by-line entry.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n\turl\n\tpushurl = https://push.example.com/r.git\n',
        );
        __resetConfigCacheForTests();

        // Act
        let caught: unknown;
        try {
          await push(ctx);
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

  describe('Given a remote with a valueless pushurl but a valued url', () => {
    describe('When push runs', () => {
      it('Then throws CONFIG_MISSING_VALUE with key remote.origin.pushurl at line 2', async () => {
        // Arrange — a valueless `pushurl` dies even when `url` is valued; the
        // `pushurl ?? url` fallback does not rescue it (pre-resolution guard).
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n\tpushurl\n\turl = https://example.com/r.git\n',
        );
        __resetConfigCacheForTests();

        // Act
        let caught: unknown;
        try {
          await push(ctx);
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
        expect(data.key).toBe('remote.origin.pushurl');
        expect(data.line).toBe(2);
        expect(data.source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given both pushurl and url valueless with pushurl earlier', () => {
    describe('When push runs', () => {
      it('Then throws CONFIG_MISSING_VALUE with the earlier-by-line key remote.origin.pushurl', async () => {
        // Arrange — pushurl@line2, url@line3; git reports the earlier line.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n\tpushurl\n\turl\n',
        );
        __resetConfigCacheForTests();

        // Act
        let caught: unknown;
        try {
          await push(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('remote.origin.pushurl');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given both pushurl and url valueless with url earlier', () => {
    describe('When push runs', () => {
      it('Then throws CONFIG_MISSING_VALUE with the earlier-by-line key remote.origin.url', async () => {
        // Arrange — url@line2, pushurl@line3; git reports the earlier line.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n\turl\n\tpushurl\n',
        );
        __resetConfigCacheForTests();

        // Act
        let caught: unknown;
        try {
          await push(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('remote.origin.url');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given a remote with pushurl set', () => {
    describe('When push runs', () => {
      it('Then it resolves the push URL from pushurl (overrides url)', async () => {
        // Arrange — pushurl points at a different host than url; the
        // transport should be hit on the pushurl host.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://fetch.example.com/r.git\n  pushurl = https://push.example.com/r.git\n',
        );
        const { transport, requests } = fakeServer({
          url: 'https://push.example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — every discovery + receive-pack hit landed on the push URL.
        expect(requests.length).toBeGreaterThan(0);
        for (const req of requests) {
          expect(req.url.startsWith('https://push.example.com/r.git')).toBe(true);
        }
      });
    });
  });

  describe('Given a remote with only url (no pushurl)', () => {
    describe('When push runs', () => {
      it('Then it falls back to url', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert
        expect(requests.length).toBeGreaterThan(0);
        for (const req of requests) {
          expect(req.url.startsWith('https://example.com/r.git')).toBe(true);
        }
      });
    });
  });

  describe('Given a detached HEAD and no refspec', () => {
    describe('When push runs', () => {
      it('Then throws INVALID_OPTION (no-default-refspec)', async () => {
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

        // Assert — option literal is 'refspecs' (kills the StringLiteral mutant).
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          option: string;
          reason: string;
        };
        expect(data.code).toBe('INVALID_OPTION');
        expect(data.option).toBe('refspecs');
        expect(data.reason).toBe('no-default-refspec (HEAD is detached)');
      });
    });
  });
});

describe('push — happy path', () => {
  describe('Given an origin remote', () => {
    describe('When push runs with no refspec on branch main', () => {
      it('Then result.remote and url are populated', async () => {
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
    });
  });

  describe('Given local matches remote', () => {
    describe('When push runs', () => {
      it('Then pushedRefs is empty and no POST is issued', async () => {
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
  });
});

describe('push — server responses', () => {
  describe('Given a non-200 from the git-receive-pack POST', () => {
    describe('When push runs', () => {
      it('Then throws HTTP_ERROR', async () => {
        // Arrange — kills the `response.statusCode !== 200` guard mutant in
        // postReceivePack. A 503 must surface as HTTP_ERROR, not as a malformed
        // report-status parse.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        // Custom transport: 200 for discovery, 503 for the POST.
        const discoveryBytes = buildAdvertisementBytes(
          [{ name: 'refs/heads/main', id: parent.id }],
          ['report-status', 'ofs-delta', 'atomic', 'delete-refs'],
        );
        const transport: HttpTransport = {
          request: async (req): Promise<HttpResponse> => {
            const isDiscovery = req.url.includes('info/refs');
            return {
              statusCode: isDiscovery ? 200 : 503,
              headers: {},
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(isDiscovery ? discoveryBytes.slice() : new Uint8Array(0));
                  controller.close();
                },
              }),
            };
          },
        };

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport });
        } catch (err) {
          caught = err;
        }

        // Assert — code, statusCode AND the exact reason string. The L319
        // StringLiteral mutant empties `git-receive-pack returned ${statusCode}`
        // to `''`, so we pin the reason and the rendered message verbatim.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          statusCode: number;
          reason: string;
        };
        expect(data.code).toBe('HTTP_ERROR');
        expect(data.statusCode).toBe(503);
        expect(data.reason).toBe('git-receive-pack returned 503');
        expect((caught as TsgitError).message).toBe(
          'HTTP_ERROR: HTTP 503: git-receive-pack returned 503',
        );
      });
    });
  });

  describe('Given the server returns `ng <ref> <reason>`', () => {
    describe('When push runs', () => {
      it('Then the ref is reported as rejected with reason', async () => {
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
    });
  });

  describe('Given the server returns `unpack <err>`', () => {
    describe('When push runs', () => {
      it('Then throws PUSH_REJECTED with the unpack reason', async () => {
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
  });
});

describe('push — force / non-fast-forward', () => {
  describe('Given a non-FF update with no force', () => {
    describe('When push runs', () => {
      it('Then throws NON_FAST_FORWARD', async () => {
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
    });
  });

  describe('Given a non-FF update with force=true', () => {
    describe('When push runs', () => {
      it('Then the update is sent (no NON_FAST_FORWARD)', async () => {
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
    });
  });

  describe('Given a `+refs/heads/main:refs/heads/main` refspec', () => {
    describe('When push runs on a non-FF update', () => {
      it('Then it succeeds without force option', async () => {
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
  });
});

describe('push — force-with-lease', () => {
  describe('Given `forceWithLease: "auto"` and the cached remote-tracking ref matches the server', () => {
    describe('When push runs', () => {
      it('Then the update succeeds without force', async () => {
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
    });
  });

  describe('Given `forceWithLease: "auto"` with a stale cached value', () => {
    describe('When push runs', () => {
      it('Then throws PUSH_REJECTED (lease-mismatch)', async () => {
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
        const data = (caught as TsgitError).data as {
          code: string;
          reason: string;
          reportStatus: { unpackOk: boolean; refUpdates: ReadonlyArray<unknown> };
        };
        expect(data.code).toBe('PUSH_REJECTED');
        expect(data.reason).toBe('lease-mismatch');
        // emptyReport() attaches a synthetic all-clear report-status: unpackOk
        // is `true`, refUpdates empty (kills the BooleanLiteral mutant).
        expect(data.reportStatus.unpackOk).toBe(true);
        expect(data.reportStatus.refUpdates).toEqual([]);
        // POST was NOT issued (lease check is pre-flight).
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe('Given an explicit ObjectId lease matching the server tip', () => {
    describe('When push runs', () => {
      it('Then the update succeeds without force', async () => {
        // Arrange — kills the `opts.forceWithLease !== "auto"` branch mutant.
        const ctx = createMemoryContext();
        const branchA = await seedCommit(ctx, [], 'a');
        const branchB = await seedCommit(ctx, [], 'b'); // disjoint of A → non-FF
        await seedRepo(ctx, { refs: { 'refs/heads/main': branchB.id } });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: branchA.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        const sut = await push({ ...ctx, transport }, { forceWithLease: branchA.id });

        // Assert — request body MUST carry `<serverTip> <localTip> ref`.
        // Pins toRefUpdate.oldId === m.remoteOid (server tip), not m.localOid.
        expect(sut.pushedRefs[0]?.status).toBe('ok');
        const body = requestBodies[0];
        expect(body).toBeDefined();
        const decoded = new TextDecoder().decode(body);
        expect(decoded).toContain(`${branchA.id} ${branchB.id} refs/heads/main`);
      });
    });
  });

  describe('Given an explicit ObjectId lease that does NOT match the server tip', () => {
    describe('When push runs', () => {
      it('Then throws PUSH_REJECTED (lease-mismatch)', async () => {
        // Arrange — kills the lease comparison mutant on the explicit-oid path.
        const ctx = createMemoryContext();
        const a = await seedCommit(ctx, [], 'a');
        const b = await seedCommit(ctx, [], 'b');
        const c = await seedCommit(ctx, [], 'c'); // server has c, lease claims a
        await seedRepo(ctx, { refs: { 'refs/heads/main': b.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: c.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport }, { forceWithLease: a.id });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason: string };
        expect(data.code).toBe('PUSH_REJECTED');
        expect(data.reason).toBe('lease-mismatch');
        // POST is NOT issued.
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe('Given `forceWithLease: "auto"` on a tag refspec', () => {
    describe('When push runs', () => {
      it('Then throws INVALID_OPTION (lease-on-non-branch)', async () => {
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

        // Assert — option literal is 'forceWithLease' (kills the StringLiteral mutant).
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          option: string;
          reason: string;
        };
        expect(data.code).toBe('INVALID_OPTION');
        expect(data.option).toBe('forceWithLease');
        expect(data.reason).toBe('lease-on-non-branch');
      });
    });
  });
});

describe('push — delete refspec', () => {
  describe('Given `:refs/heads/feature` and the ref is advertised', () => {
    describe('When push runs', () => {
      it('Then the request body carries the zero-oid newId', async () => {
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
    });
  });

  describe('Given a delete refspec for a ref the server does NOT advertise', () => {
    describe('When push runs', () => {
      it('Then throws INVALID_OPTION', async () => {
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

        // Assert — option literal is 'refspecs' and the message names the
        // unadvertised delete target (kills both StringLiteral mutants).
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          option: string;
          reason: string;
        };
        expect(data.code).toBe('INVALID_OPTION');
        expect(data.option).toBe('refspecs');
        expect(data.reason).toBe('delete target refs/heads/feature is not advertised');
      });
    });
  });

  describe('Given a successful delete', () => {
    describe('When push completes', () => {
      it('Then refs/remotes/origin/<branch> is NOT created in the cache', async () => {
        // Arrange — kills the `updateTrackingCache.isDelete` guard mutant.
        // Without the guard, a delete refspec would write the zero-oid newId
        // into the local tracking cache.
        const ctx = createMemoryContext();
        const feature = await seedCommit(ctx, [], 'feature');
        await seedRepo(ctx, { refs: { 'refs/heads/feature': feature.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/feature', id: feature.id }],
          reportStatus: {
            unpack: 'ok',
            refs: [{ name: 'refs/heads/feature', status: 'ok' }],
          },
        });

        // Act
        await push({ ...ctx, transport }, { refspecs: [':refs/heads/feature'] });

        // Assert — no cache file written for the deleted ref.
        const exists = await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/feature`);
        expect(exists).toBe(false);
      });
    });
  });
});

describe('push — side-band response', () => {
  describe('Given the server wraps report-status in side-band channel 1', () => {
    describe('When push runs', () => {
      it('Then the response is demuxed correctly', async () => {
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
  });

  describe('Given the server emits side-band channel-2 progress text', () => {
    describe('When push runs', () => {
      it('Then the reporter receives the sanitized text', async () => {
        // Arrange — kills the `parseSideBand(pkts, {})` ObjectLiteral mutant
        // and the `onProgress: () => undefined` ArrowFunction mutant. The
        // sanitize() call must run on server-supplied progress text before it
        // reaches the reporter (terminal-injection defense).
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        // Hand-craft a transport that returns a discovery body THEN a
        // side-band response with both channel-2 (progress) and channel-1
        // (report-status) packets.
        const discoveryBytes = buildAdvertisementBytes(
          [{ name: 'refs/heads/main', id: parent.id }],
          ['report-status', 'side-band-64k'],
        );
        const reportPkts = encodePktStream([
          ENCODER.encode('unpack ok\n'),
          ENCODER.encode('ok refs/heads/main\n'),
        ]);
        // channel-2 progress includes an ANSI escape; sanitize must strip it.
        const progress = ENCODER.encode('\x1b[2Jcounting objects: 3, done.\n');
        const channel2 = new Uint8Array(progress.length + 1);
        channel2[0] = 0x02;
        channel2.set(progress, 1);
        const channel1 = new Uint8Array(reportPkts.length + 1);
        channel1[0] = 0x01;
        channel1.set(reportPkts, 1);
        const responseBytes = encodePktStream([channel2, channel1]);
        const transport: HttpTransport = {
          request: async (req): Promise<HttpResponse> => ({
            statusCode: 200,
            headers: {},
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(req.url.includes('info/refs') ? discoveryBytes : responseBytes);
                controller.close();
              },
            }),
          }),
        };
        const { reporter, events } = recordingProgress();

        // Act
        const sut = await push(withProgress({ ...ctx, transport }, reporter));

        // Assert — push succeeds AND a sanitized progress update reached the
        // reporter under op === 'push:upload'.
        expect(sut.pushedRefs[0]?.status).toBe('ok');
        const progressUpdates = events.filter((e) => e.kind === 'update' && e.op === 'push:upload');
        expect(progressUpdates.length).toBeGreaterThan(0);
        const last = progressUpdates[progressUpdates.length - 1];
        // ANSI escape must be stripped; the human text survives.
        expect(last?.kind === 'update' && last.text).toContain('counting objects');
        expect(last?.kind === 'update' && (last.text ?? '')).not.toContain('\x1b');
      });
    });
  });
});

describe('push — remote-tracking cache', () => {
  describe('Given an accepted ref under refs/heads/', () => {
    describe('When push completes', () => {
      it('Then refs/remotes/origin/<branch> is written with the new oid', async () => {
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
      it('Then the tracking ref reflog records an "update by push" entry', async () => {
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

        // Act
        await push({ ...ctx, transport });

        // Assert — the tracking-cache write logs a non-empty "update by push" reason.
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );
        const entries = await readReflog(ctx, 'refs/remotes/origin/main' as RefName);
        expect(entries.map((e) => e.message)).toEqual(['update by push']);
      });
    });
  });

  describe('Given a rejected ref', () => {
    describe('When push completes', () => {
      it('Then refs/remotes/origin/<branch> is NOT updated', async () => {
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
  });
});

describe('push — progress reporting', () => {
  describe('Given a successful push', () => {
    describe('When run', () => {
      it("Then start/end pair fires with op === 'push:enumerate-objects'", async () => {
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
    });
  });

  describe('Given a push that fails before discovery (no remote)', () => {
    describe('When run', () => {
      it('Then end still fires after start', async () => {
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
  });

  describe('Given a successful push', () => {
    describe('When run', () => {
      it("Then start/end pair fires with op === 'push:upload'", async () => {
        // Arrange — pins the push:upload bracket in postReceivePack; without
        // its `finally { ctx.progress.end(...) }` the end event never fires.
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

        // Assert — exactly one start and one end for push:upload.
        const upload = events.filter((e) => e.op === 'push:upload');
        expect(upload.filter((e) => e.kind === 'start')).toHaveLength(1);
        expect(upload.filter((e) => e.kind === 'end')).toHaveLength(1);
      });
    });
  });
});

describe('push — auth, signal, headers', () => {
  describe('Given ctx.config.auth is set', () => {
    describe('When push runs', () => {
      it('Then every request carries the Authorization header', async () => {
        // Arrange — kills the `{ auth: ctx.config.auth }` ObjectLiteral mutant:
        // an empty `{}` would drop auth and no header would be injected.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({
          ...ctx,
          transport,
          config: { auth: { type: 'bearer', token: 'sekret-token' } },
        });

        // Assert — discovery GET and the POST both authenticated.
        expect(requests).toHaveLength(2);
        for (const req of requests) {
          expect(req.headers.authorization).toBe('Bearer sekret-token');
        }
      });
    });
  });

  describe('Given no config.auth', () => {
    describe('When push runs', () => {
      it('Then no Authorization header is sent', async () => {
        // Arrange — kills the `{}` ObjectLiteral mutant in the other direction:
        // a `{ auth: ... }` literal would need a defined auth, but the guard is
        // `ctx.config?.auth !== undefined` so the empty branch must be taken.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert
        for (const req of requests) {
          expect(req.headers.authorization).toBeUndefined();
        }
      });
    });
  });

  describe('Given ctx.signal is set', () => {
    describe('When push runs', () => {
      it('Then the receive-pack POST carries the signal', async () => {
        // Arrange — kills the `{ signal: ctx.signal }` spread mutant; an empty
        // `{}` would drop the signal from the POST request.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const signal = new AbortController().signal;

        // Act
        await push({ ...ctx, transport, signal });

        // Assert — the POST request object carries the exact signal instance.
        const post = requests.find((r) => r.method === 'POST');
        expect(post).toBeDefined();
        expect(post?.signal).toBe(signal);
      });
    });
  });

  describe('Given no ctx.signal', () => {
    describe('When push runs', () => {
      it('Then the receive-pack POST omits the signal key entirely', async () => {
        // Arrange — kills the L316 ConditionalExpression mutant: forcing the
        // `ctx.signal !== undefined` ternary to `true` spreads `{ signal: undefined }`
        // into the request, adding a `signal` KEY with value `undefined`. Asserting
        // value-undefined alone passes either way, so we assert the key is ABSENT.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — no `signal` own-property at all on the POST request object.
        const post = requests.find((r) => r.method === 'POST');
        expect(post).toBeDefined();
        expect(post).not.toHaveProperty('signal');
      });
    });
  });

  describe('Given a successful push', () => {
    describe('When run', () => {
      it('Then the receive-pack POST carries the git content-type and accept headers', async () => {
        // Arrange — kills the StringLiteral mutants on the POST header literals.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert
        const post = requests.find((r) => r.method === 'POST');
        expect(post).toBeDefined();
        expect(post?.headers['content-type']).toBe('application/x-git-receive-pack-request');
        expect(post?.headers.accept).toBe('application/x-git-receive-pack-result');
      });
    });
  });
});

describe('push — explicit empty refspecs', () => {
  describe('Given an explicit empty refspecs array', () => {
    describe('When push runs', () => {
      it('Then it falls back to the current branch', async () => {
        // Arrange — kills the EqualityOperator mutant (`length > 0` → `>= 0`):
        // with `>= 0` an empty array would be `.map`-ed to `[]`, yielding no
        // movers and an empty result instead of pushing the current branch.
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
        const sut = await push({ ...ctx, transport }, { refspecs: [] });

        // Assert — current branch was pushed, not an empty no-op.
        expect(sut.pushedRefs).toHaveLength(1);
        expect(sut.pushedRefs[0]).toMatchObject({ name: 'refs/heads/main', status: 'ok' });
      });
    });
  });
});

describe('push — pack contents', () => {
  describe('Given a non-empty want set', () => {
    describe('When push runs', () => {
      it('Then the request pack carries the tip object closure', async () => {
        // Arrange — kills the `wants.length === 0 → true` short-circuit and the
        // empty `for await` block: both would yield a zero-object pack. The tip
        // closure is exactly commit + tree + blob = 3 objects.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — the parent is advertised (a `have`), so only the tip's three
        // objects ship.
        const body = requestBodies[0];
        expect(body).toBeDefined();
        expect(packObjectCount(body as Uint8Array)).toBe(3);
      });
    });
  });

  describe('Given an advertised parent', () => {
    describe('When push runs', () => {
      it('Then the parent closure is excluded via haves filtering', async () => {
        // Arrange — kills the haves ArrowFunction / EqualityOperator mutants. If
        // `haves` were empty (`() => undefined` map, falsy filter, or inverted
        // `id === ZERO_OID`), the parent's commit+tree+blob would also ship,
        // doubling the pack to 6 objects.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'parent-gen');
        const tip = await seedCommit(ctx, [parent.id], 'tip-gen');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — exactly the tip's 3 objects, parent pruned by the haves boundary.
        const body = requestBodies[0];
        expect(body).toBeDefined();
        expect(packObjectCount(body as Uint8Array)).toBe(3);
      });
    });
  });
});

describe('push — non-fast-forward with a missing ancestor', () => {
  describe('Given a tip whose parent commit is absent on disk', () => {
    describe('When push runs a non-FF update', () => {
      it('Then it still surfaces NON_FAST_FORWARD', async () => {
        // Arrange — kills the `ignoreMissing: true → false` mutant in
        // isAncestor. The local tip references a parent oid that was never
        // written; with `ignoreMissing: false` the commit walk throws
        // OBJECT_NOT_FOUND instead of completing and reporting NON_FAST_FORWARD.
        const ctx = createMemoryContext();
        const missingParentId = '1'.repeat(40) as ObjectId;
        const serverTip = await seedCommit(ctx, [], 'server-tip'); // disjoint
        const tip = await seedCommit(ctx, [missingParentId], 'local-tip');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: serverTip.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport });
        } catch (err) {
          caught = err;
        }

        // Assert — the walk tolerates the missing parent and the non-FF guard
        // fires (not OBJECT_NOT_FOUND).
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NON_FAST_FORWARD');
      });
    });
  });
});

describe('push — buildReceivePackUrl', () => {
  describe('Given a remote URL with a trailing slash', () => {
    describe('When push runs', () => {
      it('Then the POST hits <path>/git-receive-pack with no double slash', async () => {
        // Arrange — kills the trailing-slash MethodExpression/UnaryOperator/
        // StringLiteral mutants in buildReceivePackUrl and the path template.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://example.com/r.git/\n',
        );
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git/',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — exactly one slash before git-receive-pack.
        const post = requests.find((r) => r.method === 'POST');
        expect(post).toBeDefined();
        expect(post?.url).toBe('https://example.com/r.git/git-receive-pack');
      });
    });
  });

  describe('Given a remote URL with no trailing slash and a query', () => {
    describe('When push runs', () => {
      it('Then the POST preserves the path and query', async () => {
        // Arrange — kills the non-trailing-slash branch of the pathname ternary
        // and the `${parsed.search}` template segment.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://example.com/r.git?token=abc\n',
        );
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git?token=abc',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — path kept verbatim, query carried onto the POST URL.
        const post = requests.find((r) => r.method === 'POST');
        expect(post).toBeDefined();
        expect(post?.url).toBe('https://example.com/r.git/git-receive-pack?token=abc');
      });
    });
  });
});

describe('push — tag refspec tracking cache', () => {
  describe('Given an accepted push of a tag refspec', () => {
    describe('When push completes', () => {
      it('Then no refs/remotes tracking entry is written', async () => {
        // Arrange — kills the `dst.startsWith(REFS_HEADS_PREFIX)` guard in
        // updateTrackingCache: with the guard removed a tag dst would be sliced
        // and written under refs/remotes/origin/.
        const ctx = createMemoryContext();
        const tagged = await seedCommit(ctx, [], 'tagged');
        await seedRepo(ctx, { refs: { 'refs/tags/v1': tagged.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/tags/v1', id: '0'.repeat(40) }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/tags/v1', status: 'ok' }] },
        });

        // Act
        const sut = await push({ ...ctx, transport }, { refspecs: ['refs/tags/v1:refs/tags/v1'] });

        // Assert — the tag was accepted, but no tracking cache entry exists.
        expect(sut.pushedRefs[0]?.status).toBe('ok');
        const remotesDirExists = await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes`);
        expect(remotesDirExists).toBe(false);
      });
    });
  });
});

describe('push — signed', () => {
  const CERT_NONCE = '1783074575-95af4e9c6ffb06f947a839725a37638bb13f649f';
  const SIGNED_CAPS = [
    'report-status',
    'ofs-delta',
    'atomic',
    'delete-refs',
    `push-cert=${CERT_NONCE}`,
  ];
  const armor = (): string =>
    '-----BEGIN PGP SIGNATURE-----\n\nZmFrZXNpZw==\n-----END PGP SIGNATURE-----\n';

  const writeSignedPushConfig = async (
    ctx: ReturnType<typeof createMemoryContext>,
    opts: { userExtra?: string; otherExtra?: string; url?: string } = {},
  ): Promise<void> => {
    const url = opts.url ?? 'https://example.com/r.git';
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[remote "origin"]\n  url = ${url}\n` +
        `[user]\n  name = A\n  email = a@a\n${opts.userExtra ?? ''}` +
        `${opts.otherExtra ?? ''}`,
    );
    __resetConfigCacheForTests();
  };

  const seedSignedPush = async (
    ctx: ReturnType<typeof createMemoryContext>,
    configOpts: { userExtra?: string; otherExtra?: string; url?: string } = {},
  ): Promise<{ parent: BuiltCommit; tip: BuiltCommit }> => {
    const parent = await seedCommit(ctx, [], 'gen-1');
    const tip = await seedCommit(ctx, [parent.id], 'gen-2');
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
    await writeSignedPushConfig(ctx, configOpts);
    return { parent, tip };
  };

  describe('Given signed "yes" and the server advertises push-cert=<nonce>', () => {
    describe('When push runs', () => {
      it('Then it sends a signed certificate and the ref is accepted', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = createMemoryContext({ command: runner });
        const { parent, tip } = await seedSignedPush(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        const sut = await push({ ...ctx, transport }, { signed: 'yes' });

        // Assert
        expect(sut.pushedRefs[0]).toMatchObject({
          name: 'refs/heads/main',
          status: 'ok',
          newId: tip.id,
        });
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).toContain('push-cert  report-status');
        expect(body).toContain('certificate version 0.1');
        expect(body).toMatch(/pusher A <a@a> \d+ [+-]\d{4}/);
        expect(body).toContain('pushee https://example.com/r.git');
        expect(body).toContain(`nonce ${CERT_NONCE}`);
        expect(body).toContain('push-cert-end');
        expect(body).toContain('BEGIN PGP SIGNATURE');
        expect(body).not.toContain('push-cert=');
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given signed "yes" and the server does NOT advertise push-cert', () => {
    describe('When push runs', () => {
      it('Then it throws SIGNED_PUSH_UNSUPPORTED and nothing beyond discovery is sent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { parent } = await seedSignedPush(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport }, { signed: 'yes' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({ code: 'SIGNED_PUSH_UNSUPPORTED', remote: 'origin' });
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe('Given signed "if-asked" and the server does NOT advertise push-cert', () => {
    describe('When push runs off-node (no CommandRunner)', () => {
      it('Then it falls back to a normal unsigned push and succeeds', async () => {
        // Arrange — no ctx.command: an attempted signature would throw off-node.
        const ctx = createMemoryContext();
        const { parent, tip } = await seedSignedPush(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        const sut = await push({ ...ctx, transport }, { signed: 'if-asked' });

        // Assert
        expect(sut.pushedRefs[0]).toMatchObject({ status: 'ok', newId: tip.id });
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).not.toContain('push-cert');
      });
    });
  });

  describe('Given signed "if-asked" and the server advertises push-cert=<nonce>', () => {
    describe('When push runs', () => {
      it('Then it sends a signed certificate', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = createMemoryContext({ command: runner });
        const { parent } = await seedSignedPush(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport }, { signed: 'if-asked' });

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).toContain('push-cert-end');
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given push.gpgSign=true in config and opts.signed is undefined', () => {
    describe('When the server advertises push-cert', () => {
      it('Then it signs — the config default applies', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = createMemoryContext({ command: runner });
        const { parent } = await seedSignedPush(ctx, { otherExtra: '[push]\n  gpgSign = true\n' });
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).toContain('push-cert-end');
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given push.gpgSign="if-asked" in config and opts.signed is undefined', () => {
    describe('When the server does NOT advertise push-cert', () => {
      it('Then it falls back to an unsigned push', async () => {
        // Arrange — off-node: an attempted signature would throw.
        const ctx = createMemoryContext();
        const { parent, tip } = await seedSignedPush(ctx, {
          otherExtra: '[push]\n  gpgSign = if-asked\n',
        });
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        const sut = await push({ ...ctx, transport });

        // Assert
        expect(sut.pushedRefs[0]).toMatchObject({ status: 'ok', newId: tip.id });
      });
    });
  });

  describe('Given push.gpgSign is unset and opts.signed is undefined', () => {
    describe('When the server advertises push-cert', () => {
      it('Then it does not sign — the default mode is "no"', async () => {
        // Arrange — off-node: an attempted signature would throw.
        const ctx = createMemoryContext();
        const { parent } = await seedSignedPush(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).not.toContain('push-cert');
      });
    });
  });

  describe('Given opts.signed is "no" and push.gpgSign=true in config', () => {
    describe('When the server advertises push-cert', () => {
      it('Then it does not sign — the explicit "no" overrides the config default', async () => {
        // Arrange — off-node: an attempted signature would throw.
        const ctx = createMemoryContext();
        const { parent } = await seedSignedPush(ctx, { otherExtra: '[push]\n  gpgSign = true\n' });
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport }, { signed: 'no' });

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).not.toContain('push-cert');
      });
    });
  });

  describe('Given user.signingKey is configured', () => {
    describe('When push signs', () => {
      it('Then the cert pusher line uses the signing key, not the identity string', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = createMemoryContext({ command: runner });
        const { parent } = await seedSignedPush(ctx, {
          userExtra: '  signingKey = 5763ECD93FFE5F79\n',
        });
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport }, { signed: 'yes' });

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).toMatch(/pusher 5763ECD93FFE5F79 \d+ [+-]\d{4}/);
        expect(body).not.toContain('pusher A <a@a>');
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given the remote URL carries user:pass@ credentials', () => {
    describe('When push signs', () => {
      it('Then the cert pushee strips the credentials', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = createMemoryContext({ command: runner });
        const credUrl = 'https://alice:s3cr3t@example.com/r.git';
        const { parent } = await seedSignedPush(ctx, { url: credUrl });
        const { transport, requestBodies } = fakeServer({
          url: credUrl,
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport }, { signed: 'yes' });

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).toContain('pushee https://example.com/r.git');
        expect(body).not.toContain('s3cr3t');
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given signed "yes" and the signer exits non-zero', () => {
    describe('When push runs', () => {
      it('Then it throws SIGNING_FAILED reason signer-failed and nothing beyond discovery is sent', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 1 });
        const ctx = createMemoryContext({ command: runner });
        const { parent } = await seedSignedPush(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport }, { signed: 'yes' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({
          code: 'SIGNING_FAILED',
          reason: 'signer-failed',
          format: 'openpgp',
        });
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe('Given signed "yes" but the context has no CommandRunner (off-node)', () => {
    describe('When the server advertises push-cert', () => {
      it('Then it throws SIGNING_FAILED reason off-node and nothing beyond discovery is sent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { parent } = await seedSignedPush(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport }, { signed: 'yes' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({ code: 'SIGNING_FAILED', reason: 'off-node' });
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe('Given signed "no" and the context has no CommandRunner (off-node)', () => {
    describe('When the server advertises push-cert', () => {
      it('Then it still pushes successfully, unsigned', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { parent, tip } = await seedSignedPush(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        const sut = await push({ ...ctx, transport }, { signed: 'no' });

        // Assert
        expect(sut.pushedRefs[0]).toMatchObject({ status: 'ok', newId: tip.id });
      });
    });
  });
});

describe('push — hooks', () => {
  describe('Given a pre-push hook that exits non-zero', () => {
    describe('When push runs', () => {
      it('Then it throws HOOK_FAILED before any upload', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'gen-1');
        const tip = await seedCommit(ctx, [parent.id], 'gen-2');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const hooks = new MemoryHookRunner({
          'pre-push': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'declined' },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport, hooks });
        } catch (err) {
          caught = err;
        }

        // Assert — aborted; only the discovery GET happened, no receive-pack POST.
        expect((caught as TsgitError).data).toEqual({
          code: 'HOOK_FAILED',
          hook: 'pre-push',
          exitCode: 1,
          stderr: 'declined',
        });
        expect(requests).toHaveLength(1);
      });
    });
  });

  describe('Given a delete refspec', () => {
    describe('When push runs', () => {
      it('Then the pre-push stdin reports the (delete) sentinel', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tip = await seedCommit(ctx, [], 'gen-1');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/feature', id: tip.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/feature', status: 'ok' }] },
        });
        const hooks = new MemoryHookRunner();

        // Act
        await push({ ...ctx, transport, hooks }, { refspecs: [':refs/heads/feature'] });

        // Assert — a delete reports `(delete)` and the zero-oid as the local side.
        expect(hooks.calls[0]?.stdin).toBe(`(delete) ${ZERO_OID} refs/heads/feature ${tip.id}\n`);
      });
    });
  });

  describe('Given a multi-ref push', () => {
    describe('When push runs', () => {
      it('Then the pre-push stdin has one line per ref with no blank separator', async () => {
        // Arrange — two branches, each one commit ahead of the advertised remote.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'gen-1');
        const tip = await seedCommit(ctx, [parent.id], 'gen-2');
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': tip.id, 'refs/heads/feature': tip.id },
        });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: parent.id },
            { name: 'refs/heads/feature', id: parent.id },
          ],
          reportStatus: {
            unpack: 'ok',
            refs: [
              { name: 'refs/heads/main', status: 'ok' },
              { name: 'refs/heads/feature', status: 'ok' },
            ],
          },
        });
        const hooks = new MemoryHookRunner();

        // Act
        await push(
          { ...ctx, transport, hooks },
          {
            refspecs: ['refs/heads/main:refs/heads/main', 'refs/heads/feature:refs/heads/feature'],
          },
        );

        // Assert — exactly two consecutive lines, no blank separator between them.
        expect(hooks.calls[0]?.stdin).toBe(
          `refs/heads/main ${tip.id} refs/heads/main ${parent.id}\n` +
            `refs/heads/feature ${tip.id} refs/heads/feature ${parent.id}\n`,
        );
      });
    });
  });

  describe('Given a pre-push hook', () => {
    describe('When push runs', () => {
      it('Then the hook receives the remote, url and one ref line on stdin', async () => {
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
        const hooks = new MemoryHookRunner();

        // Act
        await push({ ...ctx, transport, hooks });

        // Assert
        expect(hooks.calls).toHaveLength(1);
        expect(hooks.calls[0]?.args).toEqual(['origin', 'https://example.com/r.git']);
        expect(hooks.calls[0]?.stdin).toBe(
          `refs/heads/main ${tip.id} refs/heads/main ${parent.id}\n`,
        );
      });
    });
  });

  describe('Given a failing pre-push hook but noVerify true', () => {
    describe('When push runs', () => {
      it('Then it succeeds with the hook skipped', async () => {
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
        const hooks = new MemoryHookRunner({
          'pre-push': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'x' },
        });

        // Act
        const sut = await push({ ...ctx, transport, hooks }, { noVerify: true });

        // Assert
        expect(sut.pushedRefs).toHaveLength(1);
      });
    });
  });
});
