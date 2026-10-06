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
 *  - Client-side rejections (non-fast-forward, needs force, fetch first,
 *    already exists) → reported per ref; the push carries on.
 *  - `force: true` skips the non-FF guard.
 *  - `forceWithLease: 'auto'` reads remote-tracking ref; mismatch → PUSH_REJECTED.
 *  - `forceWithLease: 'auto'` on a tag dst → INVALID_OPTION.
 *  - Delete refspec → empty pack body, POSTed as zero-oid newId.
 *  - Side-band-64k advertised → response demuxed correctly.
 *  - Remote-tracking cache updated on accepted ref.
 *  - Progress reporting (push:enumerate-objects bracket).
 */
import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { push } from '../../../../src/application/commands/push.js';
import * as buildPackMod from '../../../../src/application/primitives/build-pack.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import * as closureMod from '../../../../src/application/primitives/internal/closure-engine.js';
import { appendReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { computeLooseObjectPath, TsgitError } from '../../../../src/domain/index.js';
import type {
  Blob,
  Commit,
  FileMode,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
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
const ZERO_OID_SHA256 = '0'.repeat(64);

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
  /** Report bytes to send verbatim, in place of anything `reportStatus` would build. */
  readonly rawReport?: Uint8Array;
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
  const reportBytes =
    spec.rawReport ?? buildReportStatus(spec.reportStatus, spec.sideband === true);
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
    '[remote "origin"]\n' +
      '  url = https://example.com/r.git\n' +
      '  fetch = +refs/heads/*:refs/remotes/origin/*\n' +
      '[branch "main"]\n' +
      '  remote = origin\n' +
      '  merge = refs/heads/main\n',
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
  const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'README.md', blobId)]);
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

const writeBlob = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content: string,
): Promise<ObjectId> => {
  const blob: Blob = { type: 'blob', content: ENCODER.encode(content), id: '' as ObjectId };
  return writeObject(ctx, blob);
};

interface TreeFile {
  readonly name: string;
  readonly blobId: ObjectId;
}

/**
 * Like `seedCommit`, but the tree carries caller-supplied entries — lets a
 * test reuse the same blob id across generations to model an unchanged file.
 */
const seedTreeCommit = async (
  ctx: ReturnType<typeof createMemoryContext>,
  parents: ReadonlyArray<ObjectId>,
  files: ReadonlyArray<TreeFile>,
  message: string,
): Promise<BuiltCommit> => {
  const treeId = await writeTree(
    ctx,
    files.map((f) => treeEntry('100644' as FileMode, f.name, f.blobId)),
  );
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
      message,
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
  describe('Given a remote name git accepts but the old allowlist did not', () => {
    describe('When push runs', () => {
      it.each([['a/b'], ['a"b'], ['a]b']])(
        'Then the name reaches the config lookup and refuses REMOTE_NOT_CONFIGURED',
        async (name) => {
          // Arrange — git's own rule is `refs/remotes/<name>/test` being a
          // valid ref name, which accepts all three.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await push(ctx, { remote: name });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; remote: string };
          expect(data.code).toBe('REMOTE_NOT_CONFIGURED');
          expect(data.remote).toBe(name);
        },
      );
    });
  });

  describe('Given an invalid remote name %j', () => {
    describe('When push runs', () => {
      it.each([['../escape'], ['has space'], ['..'], ['x.lock'], ['']])(
        'Then throws INVALID_OPTION naming the remote',
        async (badName) => {
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
        },
      );
    });
  });

  describe('Given no remote configured', () => {
    describe('When push runs', () => {
      it('Then throws REMOTE_NOT_CONFIGURED and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});

        // Act
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

  describe('Given a remote config with a valueless url or pushurl entry', () => {
    describe('When push runs', () => {
      it.each([
        {
          configText: '[remote "origin"]\n\turl\n',
          expectedKey: 'remote.origin.url',
          label: 'a valueless url entry reports remote.origin.url at line 2',
        },
        {
          configText: '[remote "origin"]\n\turl\n\tpushurl = https://push.example.com/r.git\n',
          expectedKey: 'remote.origin.url',
          label:
            'a valueless url with a valued pushurl still reports remote.origin.url at line 2 (pushurl does not rescue it)',
        },
        {
          configText: '[remote "origin"]\n\tpushurl\n\turl = https://example.com/r.git\n',
          expectedKey: 'remote.origin.pushurl',
          label:
            'a valueless pushurl with a valued url reports remote.origin.pushurl at line 2 (url does not rescue it)',
        },
      ])('Then throws CONFIG_MISSING_VALUE — $label', async ({ configText, expectedKey }) => {
        // Arrange — git validates each config entry eagerly, before the
        // `pushurl ?? url` fallback can substitute the other.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, configText);
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
        expect(data.key).toBe(expectedKey);
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
          '[remote "origin"]\n  url = https://fetch.example.com/r.git\n  pushurl = https://push.example.com/r.git\n' +
            '[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n',
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
      it('Then throws PUSH_DETACHED_NO_REFSPEC', async () => {
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
        const data = (caught as TsgitError).data as { code: string };
        expect(data.code).toBe('PUSH_DETACHED_NO_REFSPEC');
      });
    });
  });

  describe('Given push.default is set to an unrecognized value', () => {
    describe('When push runs with no explicit refspecs', () => {
      it('Then throws INVALID_PUSH_DEFAULT with the raw value, source, and line before any session', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[push]\n  default = bogus\n');

        // Act
        let caught: unknown;
        try {
          await push(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          value: string;
          source: string;
          line: number;
        };
        expect(data.code).toBe('INVALID_PUSH_DEFAULT');
        expect(data.value).toBe('bogus');
        expect(data.line).toBe(2);
        expect(data.source).toBe(`${ctx.layout.gitDir}/config`);
      });
    });

    describe('When push runs with an explicit refspec', () => {
      it('Then still throws INVALID_PUSH_DEFAULT (git validates the config regardless)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[push]\n  default = bogus\n');

        // Act
        let caught: unknown;
        try {
          await push(ctx, { refspecs: ['refs/heads/main:refs/heads/main'] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string };
        expect(data.code).toBe('INVALID_PUSH_DEFAULT');
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
        const result = await push({ ...ctx, transport });

        // Assert
        expect(result.remote).toBe('origin');
        expect(result.url).toBe('https://example.com/r.git');
        expect(result.pushedRefs).toHaveLength(1);
        expect(result.pushedRefs[0]).toMatchObject({
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
        const result = await push({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs).toEqual([]);
        // Exactly one HTTP call — the discovery GET. No POST.
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe('GET');
      });
    });
  });

  describe('Given an origin remote with one new commit to send', () => {
    describe('When push builds its pack', () => {
      it('Then buildPack receives plain { id } objects — no nameHash, no recency', async () => {
        // Arrange — the regression guard: every OTHER walk-tier packing
        // caller now supplies a name hash; push stays on the bare shape a
        // caller with no closure of its own can produce.
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
        const buildPackSpy = vi.spyOn(buildPackMod, 'buildPack');

        // Act
        await push({ ...ctx, transport });

        // Assert
        expect(buildPackSpy).toHaveBeenCalledTimes(1);
        const captured = buildPackSpy.mock.calls[0]![1].objects;
        expect(captured.length).toBeGreaterThan(0);
        expect(captured[0]).toStrictEqual({ id: tip.id });
        buildPackSpy.mockRestore();
      });
    });
  });
});

describe('push — object format', () => {
  describe('Given a sha256 local repository and a v1 receiver advertising no object-format (sha1)', () => {
    describe('When push negotiates', () => {
      it("Then throws the push-direction code with local 'sha256' and remote 'sha1'", async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const parent = await seedCommit(ctx, [], 'gen-1');
        const tip = await seedCommit(ctx, [parent.id], 'gen-2');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport });
        } catch (err) {
          caught = err;
        }

        // Assert — .data, not the class: local is OUR algorithm, remote is
        // the peer's; refused before the pack is ever built (exactly one
        // HTTP call — the discovery GET, no POST).
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'PUSH_OBJECT_FORMAT_UNSUPPORTED',
          local: 'sha256',
          remote: 'sha1',
        });
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
        const result = await push({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs).toHaveLength(1);
        expect(result.pushedRefs[0]).toMatchObject({
          status: 'rejected',
          rejection: 'remote',
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
      it('Then it reports the ref rejected as non-fast-forward and sends nothing', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const branchA = await seedCommit(ctx, [], 'branch-a');
        const branchB = await seedCommit(ctx, [], 'branch-b'); // disjoint, NOT a descendant of branchA
        await seedRepo(ctx, { refs: { 'refs/heads/main': branchB.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: branchA.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/heads/main',
            oldId: branchA.id,
            newId: branchB.id,
            status: 'rejected',
            rejection: 'non-fast-forward',
          },
        ]);
        expect(requests).toHaveLength(1);
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
        const result = await push({ ...ctx, transport }, { force: true });

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
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
        const result = await push(
          { ...ctx, transport },
          { refspecs: ['+refs/heads/main:refs/heads/main'] },
        );

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
      });
    });
  });
});

/** A commit over `tree` with `parents`, written as given — no typing gate. */
const writeRawCommit = (
  ctx: ReturnType<typeof createMemoryContext>,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): Promise<ObjectId> => {
  const author = { name: 'A', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author, committer: author, message, extraHeaders: [] },
  };
  return writeObject(ctx, commit);
};

describe('push — fast-forward walk against the push object table', () => {
  describe.each([
    ['unforced', {}],
    ['forced', { force: true }],
  ] as const)(
    "Given the local tip's parent whose own parent is the tree the tip carries, %s",
    (_, opts) => {
      describe('When push measures the advertised unrelated commit against it', () => {
        it('Then the walk parses that parent against the table and refuses COMMIT_PARSE_FAILED on it', async () => {
          // Arrange
          const base = createMemoryContext();
          const errors: string[] = [];
          const ctx = { ...base, logger: { error: (line: string) => errors.push(line) } };
          const { tree } = await seedCommit(ctx, [], 'seed');
          const { tree: parentTree } = await seedCommit(ctx, [], 'other');
          const parent = await writeRawCommit(ctx, parentTree, [tree], 'parent');
          const tip = await writeRawCommit(ctx, tree, [parent], 'tip');
          const advertised = await writeRawCommit(ctx, tree, [], 'advertised');
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeOriginConfig(ctx);
          const { transport } = fakeServer({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: advertised }],
            reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
          });
          const sut = push;

          // Act
          let caught: unknown;
          try {
            await sut({ ...ctx, transport }, opts);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({ code: 'COMMIT_PARSE_FAILED', id: parent });
          expect(errors).toEqual([
            `object ${tree} is a tree, not a commit`,
            `bad parent ${tree} in commit ${parent}`,
          ]);
        });
      });
    },
  );
});

describe('push — client-side rejections per ref', () => {
  describe('Given an advertised tip absent locally and no force', () => {
    describe('When push runs', () => {
      it('Then it reports the ref rejected as fetch-first without a logged line', async () => {
        // Arrange
        const base = createMemoryContext();
        const errors: string[] = [];
        const ctx = { ...base, logger: { error: (line: string) => errors.push(line) } };
        const local = await seedCommit(ctx, [], 'local');
        const absent = 'c'.repeat(40) as ObjectId;
        await seedRepo(ctx, { refs: { 'refs/heads/main': local.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: absent }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/heads/main',
            oldId: absent,
            newId: local.id,
            status: 'rejected',
            rejection: 'fetch-first',
          },
        ]);
        expect(errors).toEqual([]);
      });
    });
  });

  describe('Given an advertised end that is a tree', () => {
    describe.each([
      ['unforced', {}, { status: 'rejected', rejection: 'needs-force' }],
      ['forced', { force: true }, { status: 'ok' }],
    ] as const)('When push runs %s', (_, opts, outcome) => {
      it('Then the needs-force verdict follows the force', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const local = await seedCommit(ctx, [], 'local');
        await seedRepo(ctx, { refs: { 'refs/heads/main': local.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: local.tree }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport }, opts);

        // Assert
        expect(result.pushedRefs).toEqual([
          { name: 'refs/heads/main', oldId: local.tree, newId: local.id, ...outcome },
        ]);
      });
    });
  });

  describe('Given a local end that is a tree over an advertised commit', () => {
    describe('When push runs', () => {
      it('Then it reports the ref rejected as needs-force', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const advertised = await seedCommit(ctx, [], 'advertised');
        await seedRepo(ctx, { refs: { 'refs/heads/main': advertised.tree } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: advertised.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs.map((ref) => ref.rejection)).toEqual(['needs-force']);
      });
    });
  });

  describe('Given a receiving end that reports no status for a sent ref', () => {
    describe('When push runs', () => {
      it('Then the ref is reported rejected by the remote without a reason', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'parent');
        const tip = await seedCommit(ctx, [parent.id], 'tip');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/heads/main',
            oldId: parent.id,
            newId: tip.id,
            status: 'rejected',
            rejection: 'remote',
          },
        ]);
      });
    });
  });

  describe('Given a tag destination the remote already carries at an object absent locally', () => {
    describe('When push runs', () => {
      it('Then it reports already-exists before looking the advertised end up', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const local = await seedCommit(ctx, [], 'local');
        const absent = 'c'.repeat(40) as ObjectId;
        await seedRepo(ctx, { refs: { 'refs/heads/main': local.id, 'refs/tags/v1': local.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/tags/v1', id: absent }],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport }, { refspecs: ['refs/tags/v1'] });

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/tags/v1',
            oldId: absent,
            newId: local.id,
            status: 'rejected',
            rejection: 'already-exists',
          },
        ]);
      });
    });
  });

  describe('Given a non-fast-forward ref beside a new ref', () => {
    describe('When push runs', () => {
      it('Then only the new ref is commanded while the rejected value still feeds the pack', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const advertised = await seedCommit(ctx, [], 'advertised');
        const rejected = await seedCommit(ctx, [], 'rejected');
        const created = await seedCommit(ctx, [], 'created');
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': rejected.id, 'refs/heads/new': created.id },
        });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: advertised.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/new', status: 'ok' }] },
        });
        const closureSpy = vi.spyOn(closureMod, 'computeClosure');
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport }, { refspecs: ['main', 'new'] });

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect({
          commandsMain: body.includes(' refs/heads/main'),
          commandsNew: body.includes(' refs/heads/new'),
          wants: closureSpy.mock.calls[0]?.[1].wants,
          outcomes: result.pushedRefs.map((ref) => [ref.name, ref.status, ref.rejection]),
        }).toEqual({
          commandsMain: false,
          commandsNew: true,
          wants: [rejected.id, created.id],
          outcomes: [
            ['refs/heads/main', 'rejected', 'non-fast-forward'],
            ['refs/heads/new', 'ok', undefined],
          ],
        });
        closureSpy.mockRestore();
      });
    });
  });

  describe('Given a non-fast-forward ref beside a needs-force ref and a pre-push hook', () => {
    describe('When push runs', () => {
      it('Then the hook runs and its stdin skips only the non-fast-forward ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const advertised = await seedCommit(ctx, [], 'advertised');
        const local = await seedCommit(ctx, [], 'local');
        await seedRepo(ctx, { refs: { 'refs/heads/main': local.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: advertised.id },
            { name: 'refs/misc/tree', id: advertised.tree },
          ],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const hooks = new MemoryHookRunner();
        const sut = push;

        // Act
        await sut({ ...ctx, transport, hooks }, { refspecs: ['main', 'main:refs/misc/tree'] });

        // Assert
        expect(hooks.calls[0]?.stdin).toBe(
          `refs/heads/main ${local.id} refs/misc/tree ${advertised.tree}\n`,
        );
      });
    });
  });
});

describe('push — force-with-lease', () => {
  describe('Given an up-to-date ref and a stale explicit lease', () => {
    describe('When push runs', () => {
      it('Then the ref is not judged and nothing is pushed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tip = await seedCommit(ctx, [], 'tip');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: tip.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport }, { forceWithLease: tip.tree });

        // Assert
        expect(result.pushedRefs).toEqual([]);
      });
    });
  });

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
        const result = await push({ ...ctx, transport }, { forceWithLease: 'auto' });

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
      });
    });
  });

  describe('Given `forceWithLease: "auto"` with a stale cached value', () => {
    describe('When push runs', () => {
      it('Then the ref is rejected as stale info and nothing is posted', async () => {
        // Arrange
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
        const result = await push({ ...ctx, transport }, { forceWithLease: 'auto' });

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/heads/main',
            oldId: c.id,
            newId: b.id,
            status: 'rejected',
            rejection: 'stale-info',
          },
        ]);
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
        const result = await push({ ...ctx, transport }, { forceWithLease: branchA.id });

        // Assert — request body MUST carry `<serverTip> <localTip> ref`.
        // Pins toRefUpdate.oldId === m.remoteOid (server tip), not m.localOid.
        expect(result.pushedRefs[0]?.status).toBe('ok');
        const body = requestBodies[0];
        expect(body).toBeDefined();
        const decoded = new TextDecoder().decode(body);
        expect(decoded).toContain(`${branchA.id} ${branchB.id} refs/heads/main`);
      });
    });
  });

  describe('Given an explicit ObjectId lease that does NOT match the server tip', () => {
    describe('When push runs', () => {
      it('Then the ref is rejected as stale info and nothing is posted', async () => {
        // Arrange
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
        const result = await push({ ...ctx, transport }, { forceWithLease: a.id });

        // Assert
        expect(result.pushedRefs.map((ref) => ref.rejection)).toEqual(['stale-info']);
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe.each([
    { label: 'a tag', dst: 'refs/tags/v1.0' },
    { label: 'a branch nothing tracks', dst: 'refs/heads/topic' },
  ] as const)('Given `forceWithLease: "auto"` on $label the remote holds', ({ dst }) => {
    describe('When push runs', () => {
      it('Then the lease expects it absent and rejects it as stale info', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tip = await seedCommit(ctx, [], 'tip');
        const held = await seedCommit(ctx, [], 'held');
        await seedRepo(ctx, { refs: { [dst]: tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: dst, id: held.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport },
          { refspecs: [`${dst}:${dst}`], forceWithLease: 'auto' },
        );

        // Assert
        expect(result.pushedRefs.map((ref) => ref.rejection)).toEqual(['stale-info']);
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe('Given `forceWithLease: "auto"` on a branch nothing tracks and the remote lacks', () => {
    describe('When push runs', () => {
      it('Then the lease holds and the new branch is sent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tip = await seedCommit(ctx, [], 'tip');
        await seedRepo(ctx, { refs: { 'refs/heads/topic': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/topic', status: 'ok' }] },
        });
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport },
          { refspecs: ['refs/heads/topic:refs/heads/topic'], forceWithLease: 'auto' },
        );

        // Assert
        expect(result.pushedRefs.map((ref) => [ref.name, ref.status])).toEqual([
          ['refs/heads/topic', 'ok'],
        ]);
      });
    });
  });
});

describe('push — per-ref stale lease, undeletable refs and atomic pushes', () => {
  const capsOf = (body: Uint8Array | undefined): ReadonlyArray<string> =>
    (new TextDecoder().decode(body).split('\0')[1] ?? '').split('\n')[0]?.split(' ') ?? [];

  describe('Given an explicit lease that holds for one ref and is stale for another', () => {
    describe('When push runs', () => {
      it('Then the stale ref is rejected as stale info and the other is sent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const expected = await seedCommit(ctx, [], 'expected');
        const moved = await seedCommit(ctx, [], 'moved');
        const local = await seedCommit(ctx, [], 'local');
        await seedRepo(ctx, { refs: { 'refs/heads/main': local.id, 'refs/heads/side': local.id } });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: expected.id },
            { name: 'refs/heads/side', id: moved.id },
          ],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport },
          { refspecs: ['main', 'side'], forceWithLease: expected.id },
        );

        // Assert
        const body = new TextDecoder().decode(requestBodies[0]);
        expect({
          commandsMain: body.includes(' refs/heads/main'),
          commandsSide: body.includes(' refs/heads/side'),
          outcomes: result.pushedRefs.map((ref) => [ref.name, ref.status, ref.rejection]),
        }).toEqual({
          commandsMain: true,
          commandsSide: false,
          outcomes: [
            ['refs/heads/main', 'ok', undefined],
            ['refs/heads/side', 'rejected', 'stale-info'],
          ],
        });
      });
    });
  });

  describe('Given a stale lease and force', () => {
    describe('When push runs', () => {
      it('Then force overrides the stale lease and the ref is sent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const expected = await seedCommit(ctx, [], 'expected');
        const moved = await seedCommit(ctx, [], 'moved');
        const local = await seedCommit(ctx, [], 'local');
        await seedRepo(ctx, { refs: { 'refs/heads/main': local.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: moved.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport },
          { forceWithLease: expected.id, force: true },
        );

        // Assert
        expect(result.pushedRefs.map((ref) => ref.status)).toEqual(['ok']);
      });
    });
  });

  describe('Given a stale lease on a delete refspec', () => {
    describe('When push runs', () => {
      it('Then the delete is rejected as stale info and nothing is posted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const expected = await seedCommit(ctx, [], 'expected');
        const moved = await seedCommit(ctx, [], 'moved');
        await seedRepo(ctx, { refs: { 'refs/heads/main': expected.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/feature', id: moved.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport },
          { refspecs: [':refs/heads/feature'], forceWithLease: expected.id },
        );

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/heads/feature',
            oldId: moved.id,
            newId: ZERO_OID,
            status: 'rejected',
            rejection: 'stale-info',
          },
        ]);
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe('Given a stale lease beside a held one and a pre-push hook', () => {
    describe('When push runs', () => {
      it('Then the hook stdin skips the stale ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const expected = await seedCommit(ctx, [], 'expected');
        const moved = await seedCommit(ctx, [], 'moved');
        const local = await seedCommit(ctx, [], 'local');
        await seedRepo(ctx, { refs: { 'refs/heads/main': local.id, 'refs/heads/side': local.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: expected.id },
            { name: 'refs/heads/side', id: moved.id },
          ],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const hooks = new MemoryHookRunner();
        const sut = push;

        // Act
        await sut(
          { ...ctx, transport, hooks },
          { refspecs: ['main', 'side'], forceWithLease: expected.id },
        );

        // Assert
        expect(hooks.calls[0]?.stdin).toBe(
          `refs/heads/main ${local.id} refs/heads/main ${expected.id}\n`,
        );
      });
    });
  });

  describe('Given a delete refspec and a server that does not advertise delete-refs', () => {
    describe('When push runs with a pre-push hook', () => {
      it('Then the hook still lists the delete and the ref is rejected as not deletable', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const feature = await seedCommit(ctx, [], 'feature');
        await seedRepo(ctx, { refs: { 'refs/heads/main': feature.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/feature', id: feature.id }],
          advertisedCaps: ['report-status', 'ofs-delta', 'atomic'],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const hooks = new MemoryHookRunner();
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport, hooks },
          { refspecs: [':refs/heads/feature'] },
        );

        // Assert
        expect({
          stdin: hooks.calls[0]?.stdin,
          rejections: result.pushedRefs.map((ref) => ref.rejection),
          methods: requests.map((r) => r.method),
        }).toEqual({
          stdin: `(delete) ${ZERO_OID} refs/heads/feature ${feature.id}\n`,
          rejections: ['remote-ref-not-deletable'],
          methods: ['GET'],
        });
      });
    });
  });

  describe('Given an atomic push of a non-fast-forward ref beside a new ref', () => {
    describe('When push runs', () => {
      it('Then every other ref fails the atomic push, nothing is posted and git’s error is logged', async () => {
        // Arrange
        const base = createMemoryContext();
        const errors: string[] = [];
        const ctx = { ...base, logger: { error: (line: string) => errors.push(line) } };
        const advertised = await seedCommit(base, [], 'advertised');
        const rejected = await seedCommit(base, [], 'rejected');
        const created = await seedCommit(base, [], 'created');
        await seedRepo(base, {
          refs: { 'refs/heads/main': rejected.id, 'refs/heads/new': created.id },
        });
        await writeOriginConfig(base);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: advertised.id }],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport },
          { refspecs: ['new', 'main'], atomic: true },
        );

        // Assert
        expect({
          outcomes: result.pushedRefs.map((ref) => [ref.name, ref.status, ref.rejection]),
          methods: requests.map((r) => r.method),
          errors,
        }).toEqual({
          outcomes: [
            ['refs/heads/main', 'rejected', 'non-fast-forward'],
            ['refs/heads/new', 'rejected', 'atomic-push-failed'],
          ],
          methods: ['GET'],
          errors: ['atomic push failed for ref refs/heads/main. status: 2'],
        });
      });
    });
  });

  describe.each([
    ['stale-info', 7],
    ['remote-ref-not-deletable', 4],
    ['fetch-first', 5],
    ['needs-force', 6],
    ['already-exists', 3],
  ] as const)('Given an atomic push whose only rejection is %s', (rejection, status) => {
    describe('When push runs', () => {
      it(`Then git's error carries status ${status}`, async () => {
        // Arrange
        const base = createMemoryContext();
        const errors: string[] = [];
        const ctx = { ...base, logger: { error: (line: string) => errors.push(line) } };
        const local = await seedCommit(base, [], 'local');
        const absent = '1'.repeat(40) as ObjectId;
        const server: Readonly<
          Record<typeof rejection, { ref: string; id: ObjectId; spec: string }>
        > = {
          'stale-info': { ref: 'refs/heads/main', id: local.tree, spec: 'main' },
          'remote-ref-not-deletable': {
            ref: 'refs/heads/gone',
            id: local.id,
            spec: ':refs/heads/gone',
          },
          'fetch-first': { ref: 'refs/heads/main', id: absent, spec: 'main' },
          'needs-force': { ref: 'refs/heads/main', id: local.tree, spec: 'main' },
          'already-exists': { ref: 'refs/tags/v1', id: local.tree, spec: 'main:refs/tags/v1' },
        };
        const { ref, id, spec } = server[rejection];
        await seedRepo(base, { refs: { 'refs/heads/main': local.id } });
        await writeOriginConfig(base);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: ref, id }],
          advertisedCaps: ['report-status', 'atomic'],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const lease = rejection === 'stale-info' ? { forceWithLease: local.id } : {};
        const sut = push;

        // Act
        await sut({ ...ctx, transport }, { refspecs: [spec], atomic: true, ...lease });

        // Assert
        expect(errors).toEqual([`atomic push failed for ref ${ref}. status: ${status}`]);
      });
    });
  });

  describe('Given an atomic push and a server that does not advertise atomic', () => {
    describe('When push runs with a pre-push hook', () => {
      it('Then the hook runs and the push throws ATOMIC_PUSH_UNSUPPORTED before posting', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: ['report-status', 'delete-refs'],
          reportStatus: { unpack: 'ok', refs: [] },
        });
        const hooks = new MemoryHookRunner();
        const sut = push;

        // Act
        let caught: unknown;
        try {
          await sut({ ...ctx, transport, hooks }, { atomic: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect({
          data: (caught as TsgitError).data,
          hooks: hooks.calls.length,
          methods: requests.map((r) => r.method),
        }).toEqual({
          data: { code: 'ATOMIC_PUSH_UNSUPPORTED', remote: 'origin' },
          hooks: 1,
          methods: ['GET'],
        });
      });
    });
  });

  describe.each([
    [{ atomic: true }, true],
    [{ atomic: false }, false],
    [{}, false],
  ])('Given a server advertising atomic and push options %j', (opts, sendsAtomic) => {
    describe('When push runs', () => {
      it(`Then the atomic capability is ${sendsAtomic ? '' : 'not '}requested`, async () => {
        // Arrange
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
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport }, opts);

        // Assert
        expect({
          status: result.pushedRefs.map((ref) => ref.status),
          atomic: capsOf(requestBodies[0]).includes('atomic'),
        }).toEqual({ status: ['ok'], atomic: sendsAtomic });
      });
    });
  });
});

describe('push — remote-ref order', () => {
  describe('Given refspecs naming new refs between advertised ones', () => {
    describe('When push runs with a pre-push hook', () => {
      it('Then the hook and the result list advertised refs in advertisement order, then new refs in refspec order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const old = await seedCommit(ctx, [], 'old');
        const tip = await seedCommit(ctx, [old.id], 'tip');
        const names = ['zeta', 'newer', 'alpha', 'anew'];
        await seedRepo(ctx, {
          refs: Object.fromEntries(names.map((name) => [`refs/heads/${name}`, tip.id])),
        });
        await writeOriginConfig(ctx);
        const ordered = [
          'refs/heads/alpha',
          'refs/heads/zeta',
          'refs/heads/newer',
          'refs/heads/anew',
        ];
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/alpha', id: old.id },
            { name: 'refs/heads/zeta', id: old.id },
          ],
          reportStatus: {
            unpack: 'ok',
            refs: ordered.map((name) => ({ name, status: 'ok' as const })),
          },
        });
        const hooks = new MemoryHookRunner();
        const sut = push;

        // Act
        const result = await sut({ ...ctx, transport, hooks }, { refspecs: names });

        // Assert
        expect({
          result: result.pushedRefs.map((ref) => ref.name),
          hook: hooks.calls[0]?.stdin.split('\n').map((line) => line.split(' ')[2]),
        }).toEqual({ result: ordered, hook: [...ordered, undefined] });
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
        const result = await push({ ...ctx, transport }, { refspecs: [':refs/heads/feature'] });

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
        const body = requestBodies[0];
        expect(body).toBeDefined();
        // The pkt-line update is `<oldId> 0000...0000 refs/heads/feature\0<caps>`
        const decoded = new TextDecoder().decode(body);
        expect(decoded).toContain(`${feature.id} ${ZERO_OID} refs/heads/feature`);
      });
    });
  });

  describe('Given `:refs/heads/feature` and the ref is advertised (SHA-256 repository)', () => {
    describe('When push runs', () => {
      it('Then the request body carries the 64-zero-oid newId', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const feature = await seedCommit(ctx, [], 'feature');
        await seedRepo(ctx, { refs: { 'refs/heads/feature': feature.id } });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/feature', id: feature.id }],
          advertisedCaps: [
            'report-status',
            'ofs-delta',
            'atomic',
            'delete-refs',
            'object-format=sha256',
          ],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/feature', status: 'ok' }] },
        });

        // Act
        const result = await push({ ...ctx, transport }, { refspecs: [':refs/heads/feature'] });

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
        const body = requestBodies[0];
        expect(body).toBeDefined();
        const decoded = new TextDecoder().decode(body);
        expect(decoded).toContain(`${feature.id} ${ZERO_OID_SHA256} refs/heads/feature`);
      });
    });
  });

  describe('Given a fully qualified delete refspec for a ref the server does NOT advertise', () => {
    describe('When push runs', () => {
      it('Then the delete is sent from the null id and reported as the remote reports it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await writeOriginConfig(ctx);
        const main = await seedCommit(ctx, [], 'main');
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: main.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/nope', status: 'ok' }] },
        });

        // Act
        const result = await push({ ...ctx, transport }, { refspecs: [':refs/heads/nope'] });

        // Assert
        expect(result.pushedRefs).toEqual([
          { name: 'refs/heads/nope', oldId: ZERO_OID, newId: ZERO_OID, status: 'ok' },
        ]);
        const decoded = new TextDecoder().decode(requestBodies[0]);
        expect(decoded).toContain(`${ZERO_OID} ${ZERO_OID} refs/heads/nope`);
      });
    });
  });

  describe.each([
    {
      label: 'a short delete matching no advertised ref',
      advertised: ['refs/heads/main'],
      dst: 'nope',
      reason: 'remote-ref-missing',
      message: "unable to delete 'nope': remote ref does not exist",
    },
    {
      label: 'a short delete matching both a branch and a tag',
      advertised: ['refs/heads/x', 'refs/tags/x'],
      dst: 'x',
      reason: 'ambiguous',
      message: 'dst refspec x matches more than one',
    },
    {
      label: 'a short delete matching two refs only weakly',
      advertised: ['refs/remotes/x', 'refs/remotes/x/HEAD'],
      dst: 'x',
      reason: 'ambiguous',
      message: 'dst refspec x matches more than one',
    },
  ])('Given $label', ({ advertised, dst, reason, message }) => {
    describe('When push runs beside a branch it would update', () => {
      it("Then nothing is sent and the push fails naming git's error", async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requests } = fakeServer({
          url: 'https://user:secret@example.com/r.git',
          advertisedRefs: advertised.map((name) => ({ name, id: parent.id })),
          reportStatus: CLEAN_REPORT,
        });
        const errors: string[] = [];
        const logger = { error: (text: string) => errors.push(text) };
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://user:secret@example.com/r.git\n',
        );
        __resetConfigCacheForTests();

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport, logger }, { refspecs: [`:${dst}`, 'main'] });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'PUSH_REFSPEC_UNMATCHED',
          url: 'https://example.com/r.git',
          unmatched: [{ dst, reason }],
        });
        expect(errors).toEqual([message]);
        expect(requests.filter((req) => req.method === 'POST')).toEqual([]);
      });
    });
  });

  describe.each([
    { label: 'a tag', advertised: 'refs/tags/t1', dst: 't1' },
    { label: 'a lone weakly matched ref', advertised: 'refs/remotes/t1', dst: 't1' },
    { label: 'a top-level ref', advertised: 'refs/t1', dst: 't1' },
  ])('Given a short delete naming $label the server advertises', ({ advertised, dst }) => {
    describe('When push runs', () => {
      it('Then the advertised ref is deleted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tagged = await seedCommit(ctx, [], 'tagged');
        await seedRepo(ctx, {});
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: advertised, id: tagged.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: advertised, status: 'ok' }] },
        });

        // Act
        const result = await push({ ...ctx, transport }, { refspecs: [`:${dst}`] });

        // Assert
        expect(result.pushedRefs.map((ref) => [ref.name, ref.status])).toEqual([
          [advertised, 'ok'],
        ]);
      });
    });
  });

  describe('Given a delete-only push', () => {
    describe('When push runs', () => {
      it('Then buildPack is not called and the request has no pack', async () => {
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
        const buildPackSpy = vi.spyOn(buildPackMod, 'buildPack');

        // Act
        await push({ ...ctx, transport }, { refspecs: [':refs/heads/feature'] });

        // Assert
        expect(buildPackSpy).not.toHaveBeenCalled();
        const decoded = new TextDecoder().decode(requestBodies[0]);
        expect(decoded).not.toContain('PACK');
        expect(decoded.endsWith('0000')).toBe(true);
        buildPackSpy.mockRestore();
      });
    });
  });

  describe('Given a delete plus exactly one non-delete command', () => {
    describe('When push runs', () => {
      it('Then buildPack is called once and the request carries a pack', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const feature = await seedCommit(ctx, [], 'feature');
        const tip = await seedCommit(ctx, [feature.id], 'tip');
        await seedRepo(ctx, {
          refs: { 'refs/heads/feature': feature.id, 'refs/heads/main': tip.id },
        });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/feature', id: feature.id }],
          reportStatus: {
            unpack: 'ok',
            refs: [
              { name: 'refs/heads/feature', status: 'ok' },
              { name: 'refs/heads/main', status: 'ok' },
            ],
          },
        });
        const buildPackSpy = vi.spyOn(buildPackMod, 'buildPack');

        // Act
        await push(
          { ...ctx, transport },
          { refspecs: [':refs/heads/feature', 'refs/heads/main:refs/heads/main'] },
        );

        // Assert
        expect(buildPackSpy).toHaveBeenCalledTimes(1);
        expect(new TextDecoder().decode(requestBodies[0])).toContain('PACK');
        buildPackSpy.mockRestore();
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

const CLEAN_REPORT = { unpack: 'ok' as const, refs: [] };

/** The remote's error packet, alone where the report-status lines belong. */
const errorPacketReport = (): Uint8Array =>
  encodePktStream([ENCODER.encode('ERR receive-pack refused midway')]);

/** The same packet carried inside side-band channel 1. */
const sidebandErrorPacketReport = (): Uint8Array => {
  const inner = errorPacketReport();
  const channel1 = new Uint8Array(inner.length + 1);
  channel1[0] = 0x01;
  channel1.set(inner, 1);
  return encodePktStream([channel1]);
};

describe('push — the error packet in report-status', () => {
  describe.each([
    {
      label: 'plain',
      caps: ['report-status'],
      report: errorPacketReport,
    },
    {
      label: 'side-band',
      caps: ['report-status', 'side-band-64k'],
      report: sidebandErrorPacketReport,
    },
  ])('Given a $label report-status stream carrying an ERR packet', ({ caps, report }) => {
    describe('When push runs', () => {
      it('Then it raises the remote error the packet carries', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: caps,
          reportStatus: CLEAN_REPORT,
          rawReport: report(),
        });
        const sut = push;

        // Act
        let caught: unknown;
        try {
          await sut({ ...ctx, transport });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'REMOTE_ERROR',
          message: 'receive-pack refused midway',
        });
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
        const result = await push({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
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
        const result = await push(withProgress({ ...ctx, transport }, reporter));

        // Assert — push succeeds AND a sanitized progress update reached the
        // reporter under op === 'push:upload'.
        expect(result.pushedRefs[0]?.status).toBe('ok');
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
        const result = await push({ ...ctx, transport }, { refspecs: [] });

        // Assert — current branch was pushed, not an empty no-op.
        expect(result.pushedRefs).toHaveLength(1);
        expect(result.pushedRefs[0]).toMatchObject({ name: 'refs/heads/main', status: 'ok' });
      });
    });
  });
});

describe('push — matching mode', () => {
  describe('Given push.default=matching, no refspec, and two local branches the remote also carries', () => {
    describe('When push runs', () => {
      it('Then it expands to every advertised local head and pushes each', async () => {
        // Arrange — matching mode enumerates the local `refs/heads/*` set and
        // intersects it with the advertisement. Only the head-prefixed refs are
        // eligible, so the localHeads seam must select them (not an empty set).
        const ctx = createMemoryContext();
        const mainParent = await seedCommit(ctx, [], 'main-parent');
        const mainTip = await seedCommit(ctx, [mainParent.id], 'main-tip');
        const featParent = await seedCommit(ctx, [], 'feature-parent');
        const featTip = await seedCommit(ctx, [featParent.id], 'feature-tip');
        await seedRepo(ctx, {
          refs: {
            'refs/heads/main': mainTip.id,
            'refs/heads/feature': featTip.id,
          },
        });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[remote "origin"]\n  url = https://example.com/r.git\n' +
            '[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n' +
            '[push]\n  default = matching\n',
        );
        __resetConfigCacheForTests();
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: mainParent.id },
            { name: 'refs/heads/feature', id: featParent.id },
          ],
          reportStatus: {
            unpack: 'ok',
            refs: [
              { name: 'refs/heads/main', status: 'ok' },
              { name: 'refs/heads/feature', status: 'ok' },
            ],
          },
        });
        const buildPackSpy = vi.spyOn(buildPackMod, 'buildPack');

        // Act
        const result = await push({ ...ctx, transport });

        // Assert — both advertised heads resolved and pushed (order-independent).
        expect(result.pushedRefs).toHaveLength(2);
        const names = result.pushedRefs.map((r) => r.name).sort();
        expect(names).toEqual(['refs/heads/feature', 'refs/heads/main']);
        for (const pushed of result.pushedRefs) expect(pushed.status).toBe('ok');

        // Assert — a single collectObjects call over the two disjoint tips
        // produced the union of both closures: both tips' own objects, and
        // neither parent (each is a real, advertised negative).
        expect(buildPackSpy).toHaveBeenCalledTimes(1);
        const capturedIds = buildPackSpy.mock.calls[0]![1].objects.map((o) => o.id);
        expect(capturedIds).toEqual(expect.arrayContaining([mainTip.id, featTip.id]));
        expect(capturedIds).not.toEqual(expect.arrayContaining([mainParent.id, featParent.id]));
        expect(capturedIds).toHaveLength(6);
        buildPackSpy.mockRestore();
      });
    });
  });
});

describe('push — pack contents', () => {
  describe('Given a non-empty want set with an advertised parent', () => {
    describe('When push runs', () => {
      it('Then the request pack carries the tip object closure, excluding the parent via haves filtering', async () => {
        // Arrange — kills the `wants.length === 0 → true` short-circuit and
        // the empty `for await` block (both would yield a zero-object pack),
        // AND the haves ArrowFunction / EqualityOperator mutants (an empty
        // `haves` set — from `() => undefined` map, a falsy filter, or an
        // inverted `id === ZERO_OID` — would let the advertised parent's
        // commit+tree+blob ship too, doubling the pack to 6 objects). The tip
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

        // Assert — the parent is advertised (a `have`), so only the tip's
        // three objects ship.
        const body = requestBodies[0];
        expect(body).toBeDefined();
        expect(packObjectCount(body as Uint8Array)).toBe(3);
      });
    });
  });

  describe('Given a have whose subtree is unchanged across two generations of wants', () => {
    describe('When push runs', () => {
      it('Then the shared blob is not resent', async () => {
        // Arrange — g0 (have) and tip share file B's blob through g1; only a
        // real per-tree closure subtraction (not the old commit-boundary
        // `until`, which never inspects trees) excludes it.
        const ctx = createMemoryContext();
        const blobB = await writeBlob(ctx, 'unchanged-b');
        const blobA0 = await writeBlob(ctx, 'a0');
        const g0 = await seedTreeCommit(
          ctx,
          [],
          [
            { name: 'A', blobId: blobA0 },
            { name: 'B', blobId: blobB },
          ],
          'g0',
        );
        const blobA1 = await writeBlob(ctx, 'a1');
        const g1 = await seedTreeCommit(
          ctx,
          [g0.id],
          [
            { name: 'A', blobId: blobA1 },
            { name: 'B', blobId: blobB },
          ],
          'g1',
        );
        const blobA2 = await writeBlob(ctx, 'a2');
        const tip = await seedTreeCommit(
          ctx,
          [g1.id],
          [
            { name: 'A', blobId: blobA2 },
            { name: 'B', blobId: blobB },
          ],
          'tip',
        );
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: g0.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const buildPackSpy = vi.spyOn(buildPackMod, 'buildPack');

        // Act
        await push({ ...ctx, transport });

        // Assert
        const capturedIds = buildPackSpy.mock.calls[0]![1].objects.map((o) => o.id);
        expect(capturedIds).not.toContain(blobB);
        buildPackSpy.mockRestore();
      });
    });
  });

  describe('Given an advertised ref oid the local repository does not hold, alongside a real one', () => {
    describe('When push runs', () => {
      it('Then the absent oid is dropped as a negative rather than refusing the push', async () => {
        // Arrange — kills a naive `not: haves` (no local presence filter):
        // that shape would hand the absent oid straight to the closure
        // engine's not-side walk, which reads it and throws OBJECT_NOT_FOUND.
        const ctx = createMemoryContext();
        const base = await seedCommit(ctx, [], 'base');
        const tip = await seedCommit(ctx, [base.id], 'tip');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const absentOid = 'f'.repeat(40);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: base.id },
            { name: 'refs/heads/other', id: absentOid },
          ],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });
        const closureSpy = vi.spyOn(closureMod, 'computeClosure');

        // Act
        const result = await push({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs[0]).toMatchObject({ name: 'refs/heads/main', status: 'ok' });
        expect(closureSpy.mock.calls[0]![1].not).toEqual([base.id]);
        closureSpy.mockRestore();
      });
    });
  });

  describe('Given only the zero-oid ref-creation sentinel is advertised', () => {
    describe('When push runs', () => {
      it('Then the sentinel is dropped as a negative and the full closure of wants ships', async () => {
        // Arrange — an empty advertisement encodes as the single
        // `capabilities^{}` / zero-oid ref line, so `haves` is `[ZERO_OID]`.
        // Trigger this in isolation from the "absent real oid" case above —
        // the filter is one predicate over two independently-reachable inputs.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — no real have present, so nothing is excluded from the
        // tip's full closure: parent + tip, each commit + tree + blob.
        const body = requestBodies[0];
        expect(body).toBeDefined();
        expect(packObjectCount(body as Uint8Array)).toBe(6);
      });
    });
  });

  describe('Given a want and a real advertised have', () => {
    describe('When push computes its closure', () => {
      it('Then computeClosure is asked for objects on the bitmap tier with the present negatives', async () => {
        // Arrange — a unit-level spy on the captured request is required: the
        // mutation config is unit-only and cannot see a tier choice that is
        // otherwise observable only through a real bitmap.
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
        const closureSpy = vi.spyOn(closureMod, 'computeClosure');

        // Act
        await push({ ...ctx, transport });

        // Assert
        expect(closureSpy).toHaveBeenCalledTimes(1);
        const request = closureSpy.mock.calls[0]![1];
        expect(request.tier).toBe('bitmap');
        expect(request.objects).toBe(true);
        expect(request.wants).toEqual([tip.id]);
        expect(request.not).toEqual([parent.id]);
        closureSpy.mockRestore();
      });
    });
  });
});

describe('push — object types assigned while enumerating', () => {
  const AUTHOR = { name: 'A', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };

  const loggingContext = (): {
    readonly ctx: ReturnType<typeof createMemoryContext>;
    readonly logged: string[];
  } => {
    const logged: string[] = [];
    const base = createMemoryContext();
    return { ctx: { ...base, logger: { error: (line: string) => logged.push(line) } }, logged };
  };

  const writeBlob = (ctx: ReturnType<typeof createMemoryContext>): Promise<ObjectId> =>
    writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: ENCODER.encode('hi\n') });

  const writeCommitNaming = (
    ctx: ReturnType<typeof createMemoryContext>,
    tree: ObjectId,
    parents: ReadonlyArray<ObjectId>,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'commit',
      id: '' as ObjectId,
      data: { tree, parents, author: AUTHOR, committer: AUTHOR, message: 'm\n', extraHeaders: [] },
    });

  const pushRefused = async (
    ctx: ReturnType<typeof createMemoryContext>,
    tip: ObjectId,
  ): Promise<unknown> => {
    await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
    await writeOriginConfig(ctx);
    const { transport } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });
    try {
      await push({ ...ctx, transport });
    } catch (error) {
      return error;
    }
    return undefined;
  };

  describe('Given a branch whose commit names a blob as its tree', () => {
    describe('When push enumerates its objects', () => {
      it('Then it logs the blob is not a tree and refuses it as a bad tree object', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        const blob = await writeBlob(ctx);
        const tip = await writeCommitNaming(ctx, blob, []);
        const sut = pushRefused;

        // Act
        const caught = await sut(ctx, tip);

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'BAD_TREE_OBJECT', id: blob },
          logged: [`Object ${blob} not a tree`],
        });
      });
    });
  });

  describe('Given a branch whose commit names a blob as its parent', () => {
    describe('When push enumerates its objects', () => {
      it('Then it logs the blob is not a commit and fails to traverse that commit', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        const blob = await writeBlob(ctx);
        const empty = await writeTree(ctx, []);
        const tip = await writeCommitNaming(ctx, empty, [blob]);
        const sut = pushRefused;

        // Act
        const caught = await sut(ctx, tip);

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'REVISION_WALK_FAILED', commit: tip },
          logged: [`Object ${blob} not a commit`],
        });
      });
    });
  });

  describe('Given an alternate have, an updated ref and a created ref', () => {
    describe('When push computes its closure', () => {
      it("Then the tips follow send-pack's feed: haves, each ref's old then new, then created refs", async () => {
        // Arrange
        const ctx = createMemoryContext();
        const alternate = await seedCommit(ctx, [], 'alt');
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [
            { name: 'refs/heads/main', id: parent.id },
            { name: 'refs/heads/gone', id: 'f'.repeat(40) },
            { name: '.have', id: alternate.id },
          ],
          reportStatus: {
            unpack: 'ok',
            refs: [
              { name: 'refs/heads/main', status: 'ok' },
              { name: 'refs/heads/new', status: 'ok' },
            ],
          },
        });
        const closureSpy = vi.spyOn(closureMod, 'computeClosure');
        const sut = push;

        // Act
        await sut({ ...ctx, transport }, { refspecs: ['main', 'main:refs/heads/new'] });

        // Assert
        const request = closureSpy.mock.calls[0]?.[1];
        expect({ tips: request?.tips, typed: request?.objectTypes !== undefined }).toEqual({
          tips: [
            { id: alternate.id, excluded: true },
            { id: parent.id, excluded: true },
            { id: tip.id, excluded: false },
            { id: tip.id, excluded: false },
          ],
          typed: true,
        });
        closureSpy.mockRestore();
      });
    });
  });
});

describe('push — a tip with a missing ancestor', () => {
  describe('Given a tip whose parent commit is absent on disk', () => {
    describe('When push runs a non-FF update', () => {
      it('Then it refuses the parent it could not parse, as git exits before its non-fast-forward check', async () => {
        // Arrange — the local tip references a parent oid that was never written.
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

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'COMMIT_PARSE_FAILED',
          id: missingParentId,
        });
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
          '[remote "origin"]\n  url = https://example.com/r.git/\n' +
            '[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n',
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
          '[remote "origin"]\n  url = https://example.com/r.git?token=abc\n' +
            '[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n',
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
        const result = await push(
          { ...ctx, transport },
          { refspecs: ['refs/tags/v1:refs/tags/v1'] },
        );

        // Assert — the tag was accepted, but no tracking cache entry exists.
        expect(result.pushedRefs[0]?.status).toBe('ok');
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
        `[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n` +
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
        const result = await push({ ...ctx, transport }, { signed: 'yes' });

        // Assert
        expect(result.pushedRefs[0]).toMatchObject({
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
        const result = await push({ ...ctx, transport }, { signed: 'if-asked' });

        // Assert
        expect(result.pushedRefs[0]).toMatchObject({ status: 'ok', newId: tip.id });
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
        const result = await push({ ...ctx, transport });

        // Assert
        expect(result.pushedRefs[0]).toMatchObject({ status: 'ok', newId: tip.id });
      });
    });

    describe('When the server advertises push-cert', () => {
      it('Then it signs — the if-asked config default upgrades to signing', async () => {
        // Arrange — with a nonce advertised, the config `if-asked` mode must
        // resolve to a real signature; collapsing it to `no` would push unsigned.
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = createMemoryContext({ command: runner });
        const { parent } = await seedSignedPush(ctx, {
          otherExtra: '[push]\n  gpgSign = if-asked\n',
        });
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: SIGNED_CAPS,
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport });

        // Assert — a signed certificate was framed and the signer ran.
        const body = new TextDecoder().decode(requestBodies[0]);
        expect(body).toContain('push-cert-end');
        expect(runner.calls).toHaveLength(1);
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

  describe('Given push.gpgSign holds a value git refuses', () => {
    describe('When push is called with opts.signed left undefined', () => {
      it('Then throws CONFIG_BAD_BOOLEAN_LITERAL naming push.gpgsign and sends no pack', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { parent } = await seedSignedPush(ctx, { otherExtra: '[push]\n  gpgSign = maybe\n' });
        const { transport, requests } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport });
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
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_LITERAL');
        expect(data.key).toBe('push.gpgsign');
        expect(data.value).toBe('maybe');
        expect(data.source).toMatch(/\/config$/);
        // The guard fires on the config cold path, before the session opens —
        // no request lands at all, as with git.
        expect(requests.map((r) => r.method)).toEqual([]);
      });
    });

    describe.each([
      {
        extra: '[push]\n  gpgSign = maybe\n  default = bogus\n',
        expectedCode: 'CONFIG_BAD_BOOLEAN_LITERAL',
        label: 'gpgSign on the earlier line',
      },
      {
        extra: '[push]\n  default = bogus\n  gpgSign = maybe\n',
        expectedCode: 'INVALID_PUSH_DEFAULT',
        label: 'default on the earlier line',
      },
    ])(
      'When push.default and push.gpgSign are BOTH malformed ($label)',
      ({ extra, expectedCode }) => {
        it(`Then the first malformed line wins with ${expectedCode}`, async () => {
          // Arrange — git parses both keys in one config pass, first line wins.
          const ctx = createMemoryContext();
          const { parent } = await seedSignedPush(ctx, { otherExtra: extra });
          const { transport } = fakeServer({
            url: 'https://example.com/r.git',
            advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
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
          expect((caught as TsgitError).data.code).toBe(expectedCode);
        });
      },
    );

    describe('When the remote is already up to date (nothing to push)', () => {
      it('Then still throws CONFIG_BAD_BOOLEAN_LITERAL — git refuses even a no-op push', async () => {
        // Arrange — the advertised tip equals the local tip, so no ref moves.
        const ctx = createMemoryContext();
        const { tip } = await seedSignedPush(ctx, { otherExtra: '[push]\n  gpgSign = maybe\n' });
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
        const data = (caught as TsgitError).data as { code: string; key: string };
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_LITERAL');
        expect(data.key).toBe('push.gpgsign');
      });
    });

    describe('When push is called with opts.signed explicitly "no"', () => {
      it('Then it still throws — git reads the config regardless of an explicit override', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { parent } = await seedSignedPush(ctx, { otherExtra: '[push]\n  gpgSign = maybe\n' });
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        let caught: unknown;
        try {
          await push({ ...ctx, transport }, { signed: 'no' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_BOOLEAN_LITERAL');
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
        // secretlint-disable @secretlint/secretlint-rule-basicauth
        const credUrl = 'https://alice:s3cr3t@example.com/r.git';
        // secretlint-enable @secretlint/secretlint-rule-basicauth
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
        const result = await push({ ...ctx, transport }, { signed: 'no' });

        // Assert
        expect(result.pushedRefs[0]).toMatchObject({ status: 'ok', newId: tip.id });
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
        const result = await push({ ...ctx, transport, hooks }, { noVerify: true });

        // Assert
        expect(result.pushedRefs).toHaveLength(1);
      });
    });
  });
});

describe('push — an advertised have whose tree is missing locally', () => {
  describe('Given a locally held advertised tip whose root tree object is absent', () => {
    describe('When push runs', () => {
      it('Then the push still ships, over-reporting as git does instead of refusing', async () => {
        // Arrange — the partial-clone/pruned shape: the negative's commit is
        // held (so it survives the `hasObject` filter and reaches the not-side
        // marker), but its tree is not. Real git 2.55.0 packs this without a
        // murmur; refusing here would reject a push that used to succeed.
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(parent.tree)}`);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        const result = await push({ ...ctx, transport });

        // Assert — the tip's own commit, tree and blob; the unreadable tree
        // still prunes itself, so nothing the have already holds is resent.
        expect(result.pushedRefs[0]).toMatchObject({ name: 'refs/heads/main', status: 'ok' });
        const body = requestBodies[0];
        expect(body).toBeDefined();
        expect(packObjectCount(body as Uint8Array)).toBe(3);
      });
    });
  });
});

describe('push — remote-tracking refs mapped through the fetch refspecs', () => {
  const MIRROR_CONFIG =
    '[remote "origin"]\n  url = https://example.com/r.git\n' +
    '  fetch = +refs/heads/*:refs/remotes/mirror/*\n';
  const URL_ONLY_CONFIG = '[remote "origin"]\n  url = https://example.com/r.git\n';
  const writeConfig = async (
    ctx: ReturnType<typeof createMemoryContext>,
    body: string,
  ): Promise<void> => {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, body);
    __resetConfigCacheForTests();
  };
  const trackingRef = (ctx: ReturnType<typeof createMemoryContext>, name: string) =>
    ctx.fs.exists(`${ctx.layout.gitDir}/${name}`);

  describe('Given a fetch refspec mapping branches under refs/remotes/mirror/', () => {
    describe('When an accepted push updates main', () => {
      it('Then refs/remotes/mirror/main holds the pushed oid and refs/remotes/origin/main is absent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeConfig(ctx, MIRROR_CONFIG);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport }, { refspecs: ['main'] });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/mirror/main`);
        expect(result.trim()).toBe(tip.id);
        expect(await trackingRef(ctx, 'refs/remotes/origin/main')).toBe(false);
      });
    });

    describe('When an accepted push deletes a branch the mirror tracks', () => {
      it('Then the mapped tracking ref is deleted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const gone = await seedCommit(ctx, [], 'gone');
        await seedRepo(ctx, { refs: { 'refs/remotes/mirror/gone': gone.id } });
        await writeConfig(ctx, MIRROR_CONFIG);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/gone', id: gone.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/gone', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport }, { refspecs: [':refs/heads/gone'] });

        // Assert
        expect(await trackingRef(ctx, 'refs/remotes/mirror/gone')).toBe(false);
      });
    });

    describe('When the pushed branch is already up to date and its tracking ref is missing', () => {
      it('Then the tracking ref is written all the same', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tip = await seedCommit(ctx, [], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeConfig(ctx, MIRROR_CONFIG);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: tip.id }],
          reportStatus: CLEAN_REPORT,
        });

        // Act
        await push({ ...ctx, transport }, { refspecs: ['main'] });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/mirror/main`);
        expect(result.trim()).toBe(tip.id);
      });
    });

    describe('When an automatic lease reads a mapped tracking ref the remote still holds', () => {
      it('Then the lease holds even though refs/remotes/origin/main disagrees', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const a = await seedCommit(ctx, [], 'a');
        const b = await seedCommit(ctx, [], 'b');
        await seedRepo(ctx, {
          refs: {
            'refs/heads/main': b.id,
            'refs/remotes/mirror/main': a.id,
            'refs/remotes/origin/main': b.id,
          },
        });
        await writeConfig(ctx, MIRROR_CONFIG);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: a.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        const result = await push(
          { ...ctx, transport },
          { refspecs: ['main'], forceWithLease: 'auto' },
        );

        // Assert
        expect(result.pushedRefs.map((ref) => ref.status)).toEqual(['ok']);
      });
    });
  });

  describe('Given a remote with no fetch refspec', () => {
    describe('When an accepted push updates main', () => {
      it('Then no tracking ref is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeConfig(ctx, URL_ONLY_CONFIG);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
        });

        // Act
        await push({ ...ctx, transport }, { refspecs: ['main'] });

        // Assert
        expect(await trackingRef(ctx, 'refs/remotes')).toBe(false);
      });
    });
  });
});

describe('push — report-status-v2 ref rewrites', () => {
  const v2Report = (lines: ReadonlyArray<string>): Uint8Array =>
    encodePktStream(['unpack ok\n', ...lines].map((line) => new TextEncoder().encode(line)));

  describe('Given a receiver whose proc-receive hook stores one command under two refs', () => {
    describe('When the command is pushed', () => {
      it('Then each rewritten ref is reported and tracked under its own name and ids', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport, requestBodies } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          advertisedCaps: ['report-status', 'report-status-v2', 'delete-refs'],
          reportStatus: CLEAN_REPORT,
          rawReport: v2Report([
            'ok refs/for/main\n',
            'option refname refs/heads/topic\n',
            `option old-oid ${parent.id}\n`,
            `option new-oid ${tip.id}\n`,
            'ok refs/for/main\n',
            'option refname refs/heads/other\n',
            'option forced-update\n',
          ]),
        });

        // Act
        const result = await push({ ...ctx, transport }, { refspecs: ['main:refs/for/main'] });

        // Assert
        expect(result.pushedRefs).toEqual([
          { name: 'refs/heads/topic', oldId: parent.id, newId: tip.id, status: 'ok' },
          {
            name: 'refs/heads/other',
            oldId: ZERO_OID,
            newId: tip.id,
            status: 'ok',
            forcedUpdate: true,
          },
        ]);
        for (const tracked of ['topic', 'other']) {
          const value = await ctx.fs.readUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/${tracked}`,
          );
          expect(value.trim()).toBe(tip.id);
        }
        expect(new TextDecoder().decode(requestBodies[0])).toContain('\0report-status-v2');
      });
    });
  });

  describe('Given a receiver rewriting a command to a deletion', () => {
    describe('When the command is pushed', () => {
      it('Then the rewritten ref reports the null id and its tracking ref is deleted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tip = await seedCommit(ctx, [], 't');
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': tip.id, 'refs/remotes/origin/gone': tip.id },
        });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: tip.id }],
          reportStatus: CLEAN_REPORT,
          rawReport: v2Report([
            'ok refs/for/main\n',
            'option refname refs/heads/gone\n',
            `option new-oid ${ZERO_OID}\n`,
          ]),
        });

        // Act
        const result = await push({ ...ctx, transport }, { refspecs: ['main:refs/for/main'] });

        // Assert
        expect(result.pushedRefs.map((ref) => [ref.name, ref.newId])).toEqual([
          ['refs/heads/gone', ZERO_OID],
        ]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/gone`)).toBe(false);
      });
    });
  });

  describe('Given a receiver that rewrites a ref and then rejects it', () => {
    describe('When the command is pushed', () => {
      it('Then the ref is reported rejected under its own name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const parent = await seedCommit(ctx, [], 'p');
        const tip = await seedCommit(ctx, [parent.id], 't');
        await seedRepo(ctx, { refs: { 'refs/heads/main': tip.id } });
        await writeOriginConfig(ctx);
        const { transport } = fakeServer({
          url: 'https://example.com/r.git',
          advertisedRefs: [{ name: 'refs/heads/main', id: parent.id }],
          reportStatus: CLEAN_REPORT,
          rawReport: v2Report([
            'ok refs/heads/main\n',
            'option refname refs/heads/topic\n',
            'ng refs/heads/main hook declined\n',
          ]),
        });

        // Act
        const result = await push({ ...ctx, transport }, { refspecs: ['main'] });

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/heads/main',
            oldId: parent.id,
            newId: tip.id,
            status: 'rejected',
            rejection: 'remote',
            reason: 'hook declined',
          },
        ]);
      });
    });
  });
});

describe('push force-if-includes', () => {
  const ZERO = '0000000000000000000000000000000000000000' as ObjectId;
  const logAt = (oldId: ObjectId, newId: ObjectId, timestamp: number) => ({
    oldId,
    newId,
    identity: { name: 'A', email: 'a@a', timestamp, timezoneOffset: '+0000' },
    message: 'm',
  });
  /** Tracking ref and server at `remote`; local main at `local` with `mainLog` as its reflog. */
  const arrange = async (
    config: string,
    build: (ctx: ReturnType<typeof createMemoryContext>) => Promise<{
      readonly remote: ObjectId;
      readonly local: ObjectId;
      readonly mainLog: ReadonlyArray<ReturnType<typeof logAt>>;
    }>,
  ) => {
    const ctx = createMemoryContext();
    const { remote, local, mainLog } = await build(ctx);
    await seedRepo(ctx, {
      refs: { 'refs/heads/main': local, 'refs/remotes/origin/main': remote },
    });
    await writeOriginConfig(ctx);
    if (config !== '') {
      const path = `${ctx.layout.gitDir}/config`;
      await ctx.fs.writeUtf8(path, `${await ctx.fs.readUtf8(path)}${config}`);
    }
    __resetConfigCacheForTests();
    for (const entry of mainLog) await appendReflog(ctx, 'refs/heads/main' as RefName, entry);
    await appendReflog(ctx, 'refs/remotes/origin/main' as RefName, logAt(ZERO, remote, 150));
    const { transport, requests } = fakeServer({
      url: 'https://example.com/r.git',
      advertisedRefs: [{ name: 'refs/heads/main', id: remote }],
      reportStatus: { unpack: 'ok', refs: [{ name: 'refs/heads/main', status: 'ok' }] },
    });
    return { ctx: { ...ctx, transport }, requests, local, remote };
  };
  /** The remote tip was fetched but never integrated: main was rewritten from scratch. */
  const rewrittenWithoutRemote = async (ctx: ReturnType<typeof createMemoryContext>) => {
    const remote = (await seedCommit(ctx, [], 'theirs')).id;
    const local = (await seedCommit(ctx, [], 'mine')).id;
    return { remote, local, mainLog: [logAt(ZERO, local, 200)] };
  };

  describe('Given an auto lease, forceIfIncludes, and a remote tip the local reflog never held', () => {
    describe('When push runs', () => {
      it('Then the ref is rejected as remote-ref-updated and nothing is posted', async () => {
        // Arrange
        const { ctx, requests, local, remote } = await arrange('', rewrittenWithoutRemote);
        const sut = push;

        // Act
        const result = await sut(ctx, { forceWithLease: 'auto', forceIfIncludes: true });

        // Assert
        expect(result.pushedRefs).toEqual([
          {
            name: 'refs/heads/main',
            oldId: remote,
            newId: local,
            status: 'rejected',
            rejection: 'remote-ref-updated',
          },
        ]);
        expect(requests.map((r) => r.method)).toEqual(['GET']);
      });
    });
  });

  describe.each([
    ['push.useForceIfIncludes is true', '[push]\n  useForceIfIncludes = true\n', {}, 'rejected'],
    [
      'forceIfIncludes false overrides the config',
      '[push]\n  useForceIfIncludes\n',
      { forceIfIncludes: false },
      'ok',
    ],
    ['no forceIfIncludes and no config', '', {}, 'ok'],
    ['force overrides it', '', { forceIfIncludes: true, force: true }, 'ok'],
  ] as const)(
    'Given an auto lease over a never-integrated remote tip and %s',
    (_label, config, extra, status) => {
      describe('When push runs', () => {
        it(`Then the ref is ${status}`, async () => {
          // Arrange
          const { ctx } = await arrange(config, rewrittenWithoutRemote);
          const sut = push;

          // Act
          const result = await sut(ctx, { forceWithLease: 'auto', ...extra });

          // Assert
          expect(result.pushedRefs[0]?.status).toBe(status);
        });
      });
    },
  );

  describe('Given a ref rejected as remote-ref-updated and a pre-push hook', () => {
    describe('When push runs', () => {
      it('Then the hook is fed nothing for it, as git skips refs that will not be pushed', async () => {
        // Arrange
        const { ctx } = await arrange('', rewrittenWithoutRemote);
        const hooks = new MemoryHookRunner();
        const sut = push;

        // Act
        await sut({ ...ctx, hooks }, { forceWithLease: 'auto', forceIfIncludes: true });

        // Assert
        expect(hooks.calls[0]?.stdin).toBe('');
      });
    });
  });

  describe('Given an explicit lease and forceIfIncludes over a never-integrated remote tip', () => {
    describe('When push runs', () => {
      it('Then no reflog check applies and the lease forces the update', async () => {
        // Arrange
        const { ctx, remote } = await arrange('', rewrittenWithoutRemote);
        const sut = push;

        // Act
        const result = await sut(ctx, { forceWithLease: remote, forceIfIncludes: true });

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
      });
    });
  });

  describe.each([
    [
      'held the remote tip itself',
      async (ctx: ReturnType<typeof createMemoryContext>) => {
        const remote = (await seedCommit(ctx, [], 'theirs')).id;
        const local = (await seedCommit(ctx, [], 'mine')).id;
        return { remote, local, mainLog: [logAt(ZERO, remote, 100), logAt(remote, local, 200)] };
      },
      'ok',
    ],
    [
      'held a descendant of the remote tip',
      async (ctx: ReturnType<typeof createMemoryContext>) => {
        const remote = (await seedCommit(ctx, [], 'theirs')).id;
        const local = (await seedCommit(ctx, [remote], 'mine')).id;
        return { remote, local, mainLog: [logAt(ZERO, local, 200)] };
      },
      'ok',
    ],
    [
      'held a descendant only before the remote-tracking ref last moved',
      async (ctx: ReturnType<typeof createMemoryContext>) => {
        const remote = (await seedCommit(ctx, [], 'theirs')).id;
        const merged = (await seedCommit(ctx, [remote], 'merged')).id;
        const reset = (await seedCommit(ctx, [], 'reset')).id;
        const local = (await seedCommit(ctx, [], 'mine')).id;
        const mainLog = [
          logAt(ZERO, merged, 120),
          logAt(merged, reset, 130),
          logAt(reset, local, 200),
        ];
        return { remote, local, mainLog };
      },
      'rejected',
    ],
  ] as const)(
    'Given an auto lease and forceIfIncludes where the local reflog %s',
    (_label, build, status) => {
      describe('When push runs', () => {
        it(`Then the ref is ${status}`, async () => {
          // Arrange
          const { ctx } = await arrange('', build);
          const sut = push;

          // Act
          const result = await sut(ctx, { forceWithLease: 'auto', forceIfIncludes: true });

          // Assert
          expect(result.pushedRefs[0]?.status).toBe(status);
        });
      });
    },
  );
});
