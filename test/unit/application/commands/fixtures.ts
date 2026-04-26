/**
 * Shared fixture builders for tier-1 command tests (Step 5 onward). Test-only
 * helpers — never shipped.
 *
 * These wrap Phase 7's lower-level `buildSeededContext` (in primitives/fixtures)
 * with an ergonomic `RepoSeed` shape that maps closer to "what a real repo
 * looks like" than to the internal object/ref/index shapes.
 */

import { serializeObject } from '../../../../src/domain/objects/git-object.js';
import type {
  AuthorIdentity,
  CommitData,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';

const DEFAULT_AUTHOR: AuthorIdentity = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

export interface RepoSeedCommit {
  readonly tree: string;
  readonly parents?: ReadonlyArray<string>;
  readonly message?: string;
  readonly author?: AuthorIdentity;
}

export interface RepoSeed {
  readonly commits?: ReadonlyArray<RepoSeedCommit>;
  /** ref name → oid (as 40-char hex). The seeded commit oids are returned via `seedRepo`. */
  readonly refs?: Readonly<Record<string, string>>;
  /** Initial HEAD: ref name (`refs/heads/main`) or oid. Defaults to refs/heads/main. */
  readonly head?: string;
  /** Working-tree files. Each path is repo-relative; content is UTF-8 written. */
  readonly workingTree?: Readonly<Record<string, string>>;
}

export interface RepoSeedResult {
  /** Object ids of the seeded commits, in input order. */
  readonly commitIds: ReadonlyArray<ObjectId>;
}

/**
 * Seed `ctx` with the requested commits, refs, working-tree files, and HEAD.
 * Commit ids are computed by re-hashing — the input `tree`/`parents` strings
 * are taken verbatim, so callers needing real-graph traversal should pass
 * 40-hex strings consistently.
 */
export const seedRepo = async (ctx: Context, seed: RepoSeed): Promise<RepoSeedResult> => {
  const commitIds: ObjectId[] = [];
  for (const c of seed.commits ?? []) {
    const commitData: CommitData = {
      tree: ObjectIdFactory.from(c.tree),
      parents: (c.parents ?? []).map((p) => ObjectIdFactory.from(p)),
      author: c.author ?? DEFAULT_AUTHOR,
      committer: c.author ?? DEFAULT_AUTHOR,
      message: c.message ?? 'commit',
      extraHeaders: [],
    };
    const id = await writeLooseCommit(ctx, commitData);
    commitIds.push(id);
  }
  for (const [name, idHex] of Object.entries(seed.refs ?? {})) {
    await ctx.fs.writeUtf8(`${ctx.config.gitDir}/${name}`, `${idHex}\n`);
  }
  await ctx.fs.writeUtf8(
    `${ctx.config.gitDir}/HEAD`,
    seed.head !== undefined && /^[0-9a-f]{40}$/.test(seed.head)
      ? `${seed.head}\n`
      : `ref: ${seed.head ?? 'refs/heads/main'}\n`,
  );
  for (const [path, content] of Object.entries(seed.workingTree ?? {})) {
    await ctx.fs.writeUtf8(`${ctx.config.workDir}/${path}`, content);
  }
  return { commitIds };
};

const writeLooseCommit = async (ctx: Context, data: CommitData): Promise<ObjectId> => {
  // The id field on Commit is computed; serializeObject ignores it (works on data only).
  const placeholderId = ObjectIdFactory.from('0'.repeat(40));
  const obj = { type: 'commit' as const, id: placeholderId, data };
  const bytes = serializeObject(obj, ctx.hashConfig);
  const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
  const compressed = await ctx.compressor.deflate(bytes);
  await ctx.fs.write(`${ctx.config.gitDir}/objects/${computeLooseObjectPath(id)}`, compressed);
  return id;
};

export interface RemoteAdvertisement {
  readonly refs: ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>;
  readonly head?: RefName;
  readonly capabilities?: ReadonlyArray<string>;
}

/**
 * Build a synthetic upload-pack transport: the `info/refs` GET returns the
 * pkt-line-framed advertisement; the `git-upload-pack` POST returns a NAK
 * pkt followed by `\x01<packBody>` framed as sideband-1.
 */
export const memoryRemote = (
  advertisement: RemoteAdvertisement,
  packBody: Uint8Array,
): HttpTransport => {
  const ENCODER = new TextEncoder();
  const adsBytes = buildAdvertisement(advertisement, ENCODER);
  const packResponse = buildPackResponse(packBody, ENCODER);
  return {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      const body = req.url.includes('info/refs') ? adsBytes : packResponse;
      return {
        statusCode: 200,
        headers: {},
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
      };
    },
  };
};

const buildAdvertisement = (ad: RemoteAdvertisement, encoder: TextEncoder): Uint8Array => {
  const caps = (ad.capabilities ?? []).join(' ');
  const lines: Uint8Array[] = [];
  lines.push(encoder.encode('# service=git-upload-pack\n'));
  ad.refs.forEach((r, idx) => {
    if (idx === 0) {
      lines.push(encoder.encode(`${r.id} ${r.name}\0${caps}\n`));
    } else {
      lines.push(encoder.encode(`${r.id} ${r.name}\n`));
    }
  });
  return encodePktStream(lines);
};

const buildPackResponse = (packBody: Uint8Array, encoder: TextEncoder): Uint8Array => {
  const nak = encoder.encode('NAK\n');
  const sidebandPack = new Uint8Array(packBody.length + 1);
  sidebandPack[0] = 0x01;
  sidebandPack.set(packBody, 1);
  return encodePktStream([nak, sidebandPack]);
};

export interface RecordedTransport {
  readonly transport: HttpTransport;
  /** Snapshots of every request issued via this transport, in arrival order. */
  readonly requests: ReadonlyArray<HttpRequest>;
}

/**
 * Wrap a transport (or default to a 200-empty stub) and capture every request
 * for assertion. Use when a test cares about WHAT was sent, not just the response.
 */
export const recordedTransport = (inner?: HttpTransport): RecordedTransport => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      if (inner !== undefined) return inner.request(req);
      return {
        statusCode: 200,
        headers: {},
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
    },
  };
  return { transport, requests };
};
